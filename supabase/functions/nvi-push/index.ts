// Supabase Edge Function: nvi-push
// Nova Instant job alerts. Rings the phones of on-shift riders when a job is
// waiting, even with the phone locked and the rider app closed.
//
// Deploy as an Edge Function named exactly "nvi-push", with "Verify JWT"
// turned OFF (the database calls it without a login; see below why that is
// safe). One secret: VAPID_PRIVATE (the file ~/.novax/vapid-private.txt).
//
// Who calls it:
//   - the database trigger nvi_push_trigger(), with {"job": "<uuid>"}, when a
//     job becomes Booked with no rider (new, confirmed, or given back);
//   - the rider app, with {"test": "<that phone's push address>"}, for the
//     "Send me a test alert" button.
// Who may call (5 Oct 2026 review):
//   - a job alert must carry the x-nvi-key header, which only the database
//     knows (nvi_config.push_key, read here once per instance through
//     nvi_push_key()); anything else is refused before any database call;
//   - a test alert must carry the rider's own login (Authorization: Bearer),
//     and reaches only a phone registered to that rider.
// nvi_push_targets() still alerts once per job (again only after two minutes).
//
// The alert is an empty Web Push: no payload means no message encryption,
// only the VAPID signature below. The rider app's service worker (sw.js)
// shows "New Nova Instant job" and opens the rider app when tapped.

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PRIVATE = (Deno.env.get("VAPID_PRIVATE") ?? "").trim();
const VAPID_PUBLIC = "BNeQnig_SliKQeCXdWRh1Qo1VYCZT1ThMf9xjnZEyS73vUbH6Ycq4lurSef9fGCTW-aekdwgjVamODugtVy8gYQ";
const SUBJECT = "https://novaxlogistics.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

let signKey: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (!signKey) {
    const pub = unb64u(VAPID_PUBLIC);   // 0x04 || x || y
    signKey = crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: VAPID_PRIVATE, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  return signKey;
}
/* One signed token per push service, valid 12 hours. WebCrypto's ECDSA
   signature is already the raw r||s form that ES256 needs. */
async function vapidJwt(aud: string): Promise<string> {
  const enc = new TextEncoder();
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key(), enc.encode(head + "." + body));
  return head + "." + body + "." + b64u(sig);
}

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

let pushKey: Promise<string> | null = null;
function dbKey(): Promise<string> {
  if (!pushKey) pushKey = rpc("nvi_push_key", {}).then((k) => String(k || "")).catch((e) => { pushKey = null; throw e; });
  return pushKey;
}
/* The rider's login, checked by Supabase Auth. Returns the user id or null. */
async function riderId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && typeof u.id === "string" ? u.id : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, reason: "post_only" }, 405);
  if (!VAPID_PRIVATE) return json({ ok: false, reason: "no_key" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const job = typeof body.job === "string" && /^[0-9a-f-]{36}$/.test(body.job) ? body.job : null;
  const test = typeof body.test === "string" ? body.test.slice(0, 1000) : null;
  if (!job && !test) return json({ ok: false, reason: "nothing" }, 400);

  try {
    let user: string | null = null;
    if (job) {
      const k = req.headers.get("x-nvi-key") || "";
      if (!k || k !== await dbKey()) return json({ ok: false, reason: "key" }, 401);
    } else {
      user = await riderId(req);
      if (!user) return json({ ok: false, reason: "signin" }, 401);
    }
    const targets = (await rpc("nvi_push_targets", { p_job: job, p_test: test, p_user: user })) as { id: number; endpoint: string }[];
    const ok: number[] = [], gone: number[] = [], fail: number[] = [];
    const tokens = new Map<string, Promise<string>>();
    await Promise.all((targets || []).map(async (t) => {
      try {
        const aud = new URL(t.endpoint).origin;
        if (!tokens.has(aud)) tokens.set(aud, vapidJwt(aud));
        const r = await fetch(t.endpoint, {
          method: "POST",
          headers: { TTL: "600", Urgency: "high", Authorization: `vapid t=${await tokens.get(aud)}, k=${VAPID_PUBLIC}` },
          body: "",
        });
        await r.body?.cancel();
        if (r.status === 404 || r.status === 410) gone.push(t.id);   // the phone unsubscribed or reinstalled
        else if (r.ok) ok.push(t.id);
        else fail.push(t.id);
      } catch {
        fail.push(t.id);
      }
    }));
    if ((targets || []).length) await rpc("nvi_push_result", { p_ok: ok, p_gone: gone, p_fail: fail });
    return json({ ok: true, sent: ok.length, gone: gone.length, failed: fail.length });
  } catch (e) {
    return json({ ok: false, reason: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
