import { buildEmail } from './templates.ts';
import type { EmailKind, EmailPayload } from './templates.ts';

type Job = { id: string; kind: EmailKind; recipient: string; payload: EmailPayload;
  lease_token: string; attempts: number; request_body: string | null };
type Config = { url: string; serviceKey: string; resendKey: string; drainToken: string };
type Dependencies = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

function equalToken(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function createHandler(config: Config, dependencies: Dependencies = {}) {
  const send = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  async function rpc<T>(name: string, args: unknown): Promise<T> {
    const response = await send(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: config.serviceKey,
        authorization: `Bearer ${config.serviceKey}` }, body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error('database_unavailable');
    return response.json();
  }
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!config.url || !config.serviceKey || !config.resendKey || config.drainToken.length < 32) {
      return json({ error: 'email_not_configured' }, 503);
    }
    if (!equalToken(request.headers.get('x-novax-email-drain') ?? '', config.drainToken)) {
      return json({ error: 'forbidden' }, 403);
    }
    let jobs: Job[];
    try {
      jobs = await rpc<Job[]>('nv_email_claim', { p_limit: 5 });
      if (!Array.isArray(jobs) || jobs.length > 5) throw new Error('invalid_queue_response');
    }
    catch { return json({ error: 'queue_unavailable' }, 503); }
    let accepted = 0, failed = 0;
    for (const [index, job] of jobs.entries()) {
      if (index) await sleep(750);
      let provider: string | null = null, error: string | null = null, terminal = false;
      let retry = Math.min(3600, 60 * 2 ** Math.max(0, job.attempts - 1));
      let wire = '';
      try {
        wire = job.request_body ?? JSON.stringify(buildEmail(job.kind, job.recipient, job.payload));
      } catch {
        error = 'invalid_email_data'; terminal = true; wire = '';
      }
      if (!terminal) {
        try {
          const prepared = await rpc<string | null>('nv_email_prepare', {
            p_id: job.id, p_lease: job.lease_token, p_body: wire,
          });
          if (!prepared) throw new Error('lease_lost');
          const response = await send('https://api.resend.com/emails', {
            method: 'POST', headers: { 'content-type': 'application/json',
              authorization: `Bearer ${config.resendKey}`, 'Idempotency-Key': `novax-email/${job.id}` },
            body: prepared, signal: AbortSignal.timeout(10000), redirect: 'error',
          });
          if (response.ok) {
            const result = await response.json();
            if (typeof result.id !== 'string' || !result.id) throw new Error('invalid_provider_response');
            provider = result.id;
          } else {
            error = `resend_http_${response.status}`;
            terminal = response.status >= 400 && response.status < 500 &&
              ![408, 409, 429].includes(response.status);
            if (response.status === 409) {
              const result = await response.json().catch(() => ({}));
              terminal = result.name !== 'concurrent_idempotent_requests';
            }
            if (response.status === 429) {
              const seconds = Number(response.headers.get('retry-after'));
              if (Number.isFinite(seconds) && seconds > 0) retry = Math.max(retry, seconds);
            }
          }
        } catch {
          // A lost acknowledgement may already have sent: reuse body + idempotency key.
          error = 'send_or_prepare_uncertain';
        }
      }
      try {
        const saved = await rpc<boolean>('nv_email_result', { p_id: job.id, p_lease: job.lease_token,
          p_provider: provider, p_error: error, p_terminal: terminal, p_retry_seconds: retry });
        if (!saved) throw new Error('lease_lost');
        if (provider) accepted++; else failed++;
      } catch { failed++; }
      // Back off the whole batch if the provider is limiting throughput or misconfigured.
      if (['resend_http_401', 'resend_http_403', 'resend_http_429'].includes(error ?? '')) break;
    }
    return json({ ok: failed === 0, claimed: jobs.length, accepted, failed }, failed ? 502 : 200);
  };
}
