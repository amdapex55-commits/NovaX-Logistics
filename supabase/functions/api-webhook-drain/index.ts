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

/* Destination guard. A merchant chooses the webhook URL and this function
   POSTs to it from inside our infrastructure, so without a check it can be
   pointed at loopback, link-local metadata endpoints or private ranges.
   Hostname rules always apply; the DNS rule runs when the runtime can
   resolve, so a public-looking name that points at a private address is
   refused too. */
function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) ||
    s.startsWith("::ffff:") || s.startsWith("64:ff9b");
}
async function unsafeDestination(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid_url"; }
  if (u.protocol !== "https:") return "not_https";
  if (u.username || u.password) return "credentials_in_url";
  if (u.port && u.port !== "443") return "non_standard_port";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":") || /^[0-9.]+$/.test(host)) return "ip_address";
  if (!host.includes(".") || host === "localhost" ||
      /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return "private_host";
  if (typeof (Deno as any).resolveDns !== "function") return null;
  let failures = 0;
  const look = (t: "A" | "AAAA") =>
    (Deno as any).resolveDns(host, t).catch(() => { failures++; return [] as string[]; });
  const [v4, v6] = await Promise.all([look("A"), look("AAAA")]);
  if ((v4 as string[]).some(privateV4) || (v6 as string[]).some(privateV6)) return "private_address";
  if (failures === 2) return null;   // resolver unavailable here; hostname rules above still held
  if (!(v4 as string[]).length && !(v6 as string[]).length) return "unresolvable_host";
  return null;
}

Deno.serve(async (req) => {
  if (DRAIN_TOKEN && req.headers.get("x-novax-drain") !== DRAIN_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  }

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
