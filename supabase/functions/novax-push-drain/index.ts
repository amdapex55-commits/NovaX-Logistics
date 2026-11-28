// NovaX app notifications (28 Nov 2026). The database queues messages in
// nv_push_queue (see sql_novax_push_20261128.sql) and nv_push_tick() calls this
// function every minute with the same private token as the email drain. It
// sends each message to the merchant's phones through Firebase Cloud Messaging
// HTTP v1 and reports back, so phones Firebase calls gone are forgotten.
//
// Secrets (project-wide Edge secrets):
//   NOVAX_EMAIL_DRAIN_TOKEN  already set for novax-email-drain; reused here
//   FCM_SERVICE_ACCOUNT      the Firebase service-account JSON (Firebase →
//                            Project settings → Service accounts → Generate new private key)
// Deploy: supabase functions deploy novax-push-drain --use-api --no-verify-jwt

type Msg = { id: number; title: string; body: string; url: string; tag: string | null; event: string;
  tokens: { token: string; platform: string }[] };
type SA = { client_email: string; private_key: string; project_id: string };

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const DRAIN = Deno.env.get('NOVAX_EMAIL_DRAIN_TOKEN') ?? Deno.env.get('DRAIN_TOKEN') ?? '';
const SA_RAW = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function equalToken(a: string, b: string) {
  let d = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) d |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return d === 0;
}
async function rpc<T>(name: string, args: unknown): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify(args), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
  const t = await r.text();
  return (t ? JSON.parse(t) : null) as T;
}

const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (t: string) => b64url(new TextEncoder().encode(t));
let access: string | null = null, accessAt = 0;
async function fcmAccess(sa: SA): Promise<string> {
  if (access && Date.now() - accessAt < 50 * 60 * 1000) return access;
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlText(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64url(sig),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('fcm auth ' + r.status);
  access = j.access_token; accessAt = Date.now();
  return access!;
}

// Money and problems are "alerts"; the rest are quiet updates.
const CHANNEL: Record<string, string> = { refused: 'novax_alerts', wallet_paid: 'novax_alerts', returned: 'novax_alerts',
  delivered: 'novax_updates', picked_up: 'novax_updates' };

async function sendOne(sa: SA, m: Msg, token: string): Promise<'ok' | 'gone' | string> {
  const channel = CHANNEL[m.event] || 'novax_updates';
  const body = { message: {
    token,
    data: { url: m.url, tag: m.tag ?? '', event: m.event, title: m.title, body: m.body },
    android: { priority: 'HIGH', collapse_key: m.tag ?? undefined,
      notification: { title: m.title, body: m.body, tag: m.tag ?? undefined, channel_id: channel,
        icon: 'ic_stat_novax', color: '#0F8A5F', visibility: 'PRIVATE',
        notification_priority: channel === 'novax_alerts' ? 'PRIORITY_HIGH' : 'PRIORITY_DEFAULT' } },
    apns: { headers: { 'apns-priority': '10', ...(m.tag ? { 'apns-collapse-id': m.tag.slice(0, 64) } : {}) },
      payload: { aps: { alert: { title: m.title, body: m.body }, sound: 'default', ...(m.tag ? { 'thread-id': m.tag } : {}) } } },
  } };
  const at = await fcmAccess(sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + at },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (r.ok) return 'ok';
  const t = await r.text().catch(() => '');
  if (r.status === 404 || /UNREGISTERED|registration token is not a valid/i.test(t)) return 'gone';
  return 'fail:' + r.status;
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!URL_ || !SERVICE || DRAIN.length < 32) return json({ error: 'not_configured' }, 503);
  if (!equalToken(request.headers.get('x-novax-push-drain') ?? '', DRAIN)) return json({ error: 'forbidden' }, 403);
  if (!SA_RAW) return json({ error: 'firebase_not_configured' }, 503);
  let sa: SA;
  try { sa = JSON.parse(SA_RAW); if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error(); }
  catch { return json({ error: 'firebase_key_invalid' }, 503); }

  let msgs: Msg[];
  try { msgs = await rpc<Msg[]>('nv_push_claim', { p_limit: 200 }); if (!Array.isArray(msgs)) throw new Error(); }
  catch { return json({ error: 'queue_unavailable' }, 503); }

  const results: { id: number; ok: boolean; error?: string; gone: string[] }[] = [];
  let sent = 0, gone = 0, failed = 0;
  for (const m of msgs) {
    const out = await Promise.all((m.tokens || []).map(t => sendOne(sa, m, t.token).catch(e => 'fail:' + String(e?.message || e))));
    const goneTokens = (m.tokens || []).filter((_, i) => out[i] === 'gone').map(t => t.token);
    const anyOk = out.includes('ok');
    // No phone left (all gone) also closes the message: there is nobody to retry for.
    const closed = anyOk || out.length === 0 || goneTokens.length === out.length;
    results.push({ id: m.id, ok: closed, error: closed ? undefined : out.filter(x => x.startsWith('fail')).join(',').slice(0, 300), gone: goneTokens });
    sent += out.filter(x => x === 'ok').length; gone += goneTokens.length; failed += out.filter(x => x.startsWith('fail')).length;
  }
  try { if (results.length) await rpc('nv_push_done', { p_results: results }); }
  catch { return json({ error: 'report_failed', sent }, 500); }
  return json({ messages: msgs.length, sent, gone, failed });
});
