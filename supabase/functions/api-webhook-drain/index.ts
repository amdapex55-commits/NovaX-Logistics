// NovaX outbound webhook drain.
//
// Cron pokes this once a minute when the queue has due rows. It claims a
// batch, POSTs each to the merchant's URL with an HMAC signature, and reports
// every outcome back so a failure retries with backoff instead of vanishing.
//
// Signing: sha256 HMAC over "<timestamp>.<raw body>", sent as
//   X-NovaX-Signature: sha256=<hex>
//   X-NovaX-Timestamp: <unix seconds>
// The merchant recomputes it with their secret. Including the timestamp in
// the signed string is what stops a captured POST being replayed later.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DRAIN_TOKEN = Deno.env.get("DRAIN_TOKEN") ?? "";

const PER_RUN = 25;
const TIMEOUT_MS = 10000;

async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sign(secret: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}.${body}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Destination guard: the one shared checker (2 Oct 2026). This file used to
   carry its own copy, which drifted from the one the API uses when a merchant
   saves the URL; both now check the same way. */
import { unsafeDestination } from "../_shared/destination.ts";

/* Compared in constant time, so the token cannot be guessed a byte at a time. */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  const deny = (status: number, error: string) =>
    new Response(JSON.stringify({ ok: false, error }), { status, headers: { "content-type": "application/json" } });
  if (req.method !== "POST") return deny(405, "post_only");
  /* Fails closed (6 Oct 2026 audit): with no DRAIN_TOKEN set this used to let
     every caller through. A missing secret now stops the drain instead. */
  if (!DRAIN_TOKEN) return deny(503, "drain_token_not_set");
  if (!sameToken(req.headers.get("x-novax-drain") ?? "", DRAIN_TOKEN)) return deny(403, "forbidden");

  let claimed: Array<{
    id: string; url: string; secret: string; payload: unknown; attempts: number;
  }> = [];
  try {
    claimed = (await rpc("nv_api_webhook_claim", { p_limit: PER_RUN })) ?? [];
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  let sent = 0, failed = 0;

  await Promise.all(claimed.map(async (job) => {
    const body = JSON.stringify(job.payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    let ok = false, status = 0, error: string | null = null;

    try {
      const blocked = await unsafeDestination(job.url);
      if (blocked) throw new Error(`blocked_destination:${blocked}`);
      const sig = await sign(job.secret ?? "", ts, body);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(job.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "NovaX-Webhook/1",
            "x-novax-event": "parcel.status",
            "x-novax-delivery": job.id,
            "x-novax-timestamp": ts,
            "x-novax-signature": `sha256=${sig}`,
          },
          body,
          /* A redirect would let an approved public host bounce us to a
             private one after the check above. Not followed; a 3xx is a
             failed delivery. */
          redirect: "manual",
          signal: ctl.signal,
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
        if (!ok) error = (await res.text()).slice(0, 300);
        // Drain the body either way so the connection is released.
        else await res.body?.cancel();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = String(e).slice(0, 300);
    }

    ok ? sent++ : failed++;
    try {
      await rpc("nv_api_webhook_result", {
        p_id: job.id, p_ok: ok, p_status: status, p_error: error,
      });
    } catch { /* the reclaim guard will pick it up again */ }
  }));

  return new Response(
    JSON.stringify({ ok: true, claimed: claimed.length, sent, failed }),
    { headers: { "content-type": "application/json" } },
  );
});
