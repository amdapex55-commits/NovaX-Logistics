/**
 * NovaX Merchant API — one base URL, one key, everything a shipper needs.
 *
 *   POST   /orders            book a parcel  (add "test":true to dry-run), get an AWB back
 *   GET    /orders            list your parcels
 *   GET    /orders/:awb       one parcel with its full status history
 *   POST   /orders/:awb/cancel cancel a parcel that has not been picked up
 *   GET    /invoices          your invoices
 *   GET    /wallet            COD balance and what is still in flight
 *   PUT    /webhook           where we POST every status change (signed, retried)
 *   GET    /ping              key check
 *
 * AUTH: Authorization: Bearer nvx_live_...   (one credential, nothing else)
 *
 * Deployed with --no-verify-jwt on purpose: the old web-order-intake runs with
 * JWT verification ON, so a merchant needed our anon key AS WELL as their own
 * token, and their first request 401'd for a reason no error message explained.
 * The bearer key below is the only credential, and it is checked here.
 */
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* Logged for every call so a broken integration shows up as an error rate
   rather than a phone call. Failures here are swallowed on purpose -- a
   logging problem must never cost a merchant a booking. */
async function logCall(keyId: string | null, clientId: string | null,
                       route: string, method: string, status: number,
                       error: string | null, t0: number) {
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/nv_api_log_request`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
      body: JSON.stringify({
        p_key_id: keyId, p_client_id: clientId, p_route: route, p_method: method,
        p_status: status, p_error: error, p_ms: Date.now() - t0,
      }),
    });
  } catch { /* never surfaces */ }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}
/** Every error looks the same, so a developer can branch on `error` alone. */
function fail(status: number, error: string, hint?: string) {
  return json({ ok: false, error, ...(hint ? { hint } : {}) }, status);
}

async function rpc(fn: string, args: Record<string, unknown>) {
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
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

async function table(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

/** Public shape of a parcel. Deliberately small and stable: internal columns
 *  are not exposed, so we can change them without breaking a merchant. */
function parcelOut(p: any) {
  return {
    awb: p.awb,
    status: p.status,
    consignee: p.consignee,
    phone: p.phone,
    city: p.city,
    address: p.address,
    cod_amount: Number(p.cod_amount || 0),
    delivery_fee: Number(p.fee || 0),
    exception: p.exception || null,
    booked_at: p.booked_at,
    delivered_at: p.delivered_at || null,
    last_update: p.updated_at,
    tracking_url: `https://novaxlogistics.com/tracking.html?awb=${encodeURIComponent(p.awb)}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const url = new URL(req.url);
  /* Supabase does not present the path the same way in every environment --
     it can arrive as /functions/v1/api/ping or just /api/ping. Strip either
     prefix rather than assume one; guessing wrong makes every route 404 while
     auth still works, which is exactly what happened on the first deploy. */
  const path = url.pathname
    .replace(/^\/functions\/v1\/api/, "")
    .replace(/^\/api(?=\/|$)/, "")
    .replace(/\/+$/, "") || "/";

  /* The body is a stream and can only be read once. The booking rate limit
     needs to know whether this is a dry run BEFORE authenticating, and the
     handlers need the same body afterwards, so it is parsed here and passed
     down rather than read twice -- a second read yields an empty body and
     would break every real booking. */
  let body: any = null;
  if (req.method === "POST" || req.method === "PUT") {
    body = await req.json().catch(() => null);
  }
  /* Strict, and loud about anything ambiguous. `test: 1` used to fall through
     to a REAL booking -- a developer who thought they were dry-running got a
     live parcel and a rider dispatched. Accepting truthy values instead would
     be worse (`test: "false"` is truthy), so anything that is not clearly
     yes or no is rejected with an explanation rather than guessed at. */
  const rawTest = body?.test;
  const isDryRun = rawTest === true || rawTest === "true";
  const testIsAmbiguous = rawTest !== undefined && rawTest !== null &&
    !(rawTest === true || rawTest === false || rawTest === "true" || rawTest === "false");

  const auth = req.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) {
    return fail(401, "missing_api_key",
      "Send your key as: Authorization: Bearer nvx_live_...");
  }

  /* Resolve, count and rate-check in one round trip. The limits are
     deliberately generous -- 1000 calls and 200 bookings an hour -- because
     the point is to stop a runaway loop on a merchant's side from dispatching
     riders to hundreds of parcels, not to ration anyone. Hayat Scents' busiest
     hour so far is well under a hundred calls. A dry-run booking does not
     count against the booking limit; it costs us nothing. */
  const isBooking = path === "/orders" && req.method === "POST" && !isDryRun;
  const who = await rpc("nv_api_resolve_key_v2", { p_key: key, p_is_booking: isBooking });
  const acct: any = who.ok ? (Array.isArray(who.data) ? who.data[0] : who.data) : null;

  if (!acct || acct.ok === false) {
    const e = acct?.error;
    if (e === "rate_limited" || e === "booking_rate_limited") {
      const retry = Number(acct.retry_after_seconds) || 60;
      await logCall(null, null, path, req.method, 429, e, started);
      return new Response(JSON.stringify({
        ok: false, error: e,
        hint: e === "booking_rate_limited"
          ? `Booking limit of ${acct.limit} parcels/hour reached. Retry in ${retry}s, or contact NovaX to raise it.`
          : `Rate limit of ${acct.limit} requests/hour reached. Retry in ${retry}s.`,
        retry_after_seconds: retry,
      }, null, 2), {
        status: 429,
        headers: { ...CORS, "content-type": "application/json", "retry-after": String(retry) },
      });
    }
    await logCall(null, null, path, req.method, 401, "invalid_api_key", started);
    return fail(401, "invalid_api_key",
      "That key is not recognised or has been revoked.");
  }
  const clientId: string = acct.client_id;
  const keyId: string = acct.key_id;
  /* Dry runs are logged under their own route so admin_api_health's booking
     count means real parcels. The first test run reported bookings=1 for a
     call that created nothing. */
  const logRoute = isDryRun && path === "/orders" ? "/orders:test" : path;

  /* One log line per call, taken from the response actually returned, so the
     health view reflects what the merchant saw rather than what we intended.
     Fire-and-forget: awaiting it would add a round trip to every booking. */
  const logResult = (res: Response, errCode?: string | null) => {
    try {
      /* Read the real error code out of the response rather than logging a
         generic "error" -- the whole point of the log is being able to see
         that a merchant is hitting missing_fields, not that something failed.
         res.clone() so the body the merchant receives is untouched. */
      if (errCode !== undefined) {
        logCall(keyId, clientId, logRoute, req.method, res.status, res.status >= 400 ? errCode : null, started);
      } else if (res.status >= 400) {
        res.clone().json()
          .then((j: any) => logCall(keyId, clientId, logRoute, req.method, res.status, j?.error ?? "error", started))
          .catch(() => logCall(keyId, clientId, logRoute, req.method, res.status, "error", started));
      } else {
        logCall(keyId, clientId, logRoute, req.method, res.status, null, started);
      }
    } catch { /* never surfaces */ }
    return res;
  };

  try {
    const out = await (async (): Promise<Response> => {
    // ---------------------------------------------------------------- ping --
    if (path === "/ping" || path === "/") {
      return json({ ok: true, account: acct.client_name, webhook: acct.webhook_url || null });
    }

    // -------------------------------------------------------------- orders --
    if (path === "/orders" && req.method === "POST") {
      const b = body as any;
      if (!b) return fail(400, "invalid_json", "Body must be JSON.");

      const missing = ["consignee", "phone", "city", "address"]
        .filter((f) => !String(b[f] ?? "").trim());
      if (missing.length) {
        return fail(422, "missing_fields",
          `Required: ${missing.join(", ")}. cod_amount defaults to 0 for prepaid orders.`);
      }

      if (testIsAmbiguous) {
        return fail(422, "invalid_test_flag",
          `"test" must be true or false. Received ${JSON.stringify(rawTest)}. ` +
          `Nothing was booked -- send "test": true to dry-run, or omit it to book for real.`);
      }

      /* NovaX delivers to four cities. Accepting an order for anywhere else
         meant a merchant's customer waited for a parcel that could never be
         collected, and the merchant found out days later. Better to refuse it
         at the door and say where we do go. */
      const SERVED = ["karachi", "lahore", "islamabad", "rawalpindi"];
      const destCity = String(b.city).trim();
      if (!SERVED.includes(destCity.toLowerCase())) {
        return fail(422, "city_not_served",
          `We do not deliver to "${destCity}" yet. NovaX currently serves Karachi, Lahore, Islamabad and Rawalpindi.`);
      }

      const cod = Number(b.cod_amount ?? 0);
      if (!isFinite(cod) || cod < 0) return fail(422, "invalid_cod_amount", "cod_amount must be 0 or more.");

      /* TEST MODE. "test": true runs every check above -- required fields, COD
         sanity, and the same fee quote a real booking uses -- then returns the
         shape a real booking returns, without writing a parcel.

         There was no sandbox, so a developer wiring this up had to create real
         parcels to see a real response and then remember to cancel each one.
         Hayat Scents booked 13 live parcels on their first day; some of the
         early ones were almost certainly meant as tests. A merchant should be
         able to hammer this endpoint all afternoon without a rider being sent
         anywhere.

         The AWB is deliberately unmistakable -- TEST-xxxxxxxx, never an
         N-number -- so a test response cannot be filed as a real consignment,
         and tracking_url is null because there is nothing to track. */
      if (b.test === true || b.test === "true") {
        const quoted = await rpc("novax_quote_fee", {
          p_client_id: clientId,
          p_dest_city: String(b.city).trim(),
          p_weight: String(b.weight ?? "0.5 kg"),
        });
        let fee: number | null = null;
        if (quoted.ok && quoted.data != null) {
          const q = Array.isArray(quoted.data) ? quoted.data[0] : quoted.data;
          const n = Number(q && typeof q === "object" ? (q.fee ?? q.total ?? q.amount) : q);
          if (Number.isFinite(n)) fee = n;
        }
        const now = new Date().toISOString();
        return json({
          ok: true,
          test: true,
          note: "Validation passed. No parcel was created and nothing will be collected.",
          order: {
            awb: "TEST-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
            status: "New booked",
            consignee: String(b.consignee).trim(),
            phone: String(b.phone).trim(),
            city: String(b.city).trim(),
            address: String(b.address).trim(),
            cod_amount: cod,
            delivery_fee: fee,
            exception: null,
            booked_at: now,
            delivered_at: null,
            last_update: now,
            tracking_url: null,
          },
        }, 200);
      }

      const booked = await rpc("nv_book_parcel_core", {
        p_client_id: clientId,
        p_consignee: String(b.consignee).trim(),
        p_phone: String(b.phone).trim(),
        p_pickup_city: String(b.pickup_city ?? "Karachi").trim(),
        p_city: String(b.city).trim(),
        p_address: String(b.address).trim(),
        p_cod: cod,
        p_weight: String(b.weight ?? "0.5 kg"),
        p_service: String(b.service ?? "COD Standard"),
        p_category: String(b.category ?? ""),
        p_fragile: String(b.fragile ?? "No"),
        p_payment_mode: cod > 0 ? "COD" : "Non COD",
        p_order_id: String(b.order_id ?? ""),
        p_reference_no: String(b.reference ?? ""),
        p_source: "merchant_api",
        p_actor_role: "api",
      });
      if (!booked.ok) {
        return fail(400, "booking_failed",
          typeof booked.data?.message === "string" ? booked.data.message : "Could not book this parcel.");
      }
      const p = Array.isArray(booked.data) ? booked.data[0] : booked.data;
      return json({ ok: true, order: parcelOut(p) }, 201);
    }

    if (path === "/orders" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      const status = url.searchParams.get("status");
      let q = `parcels?client_id=eq.${clientId}&order=booked_at.desc&limit=${limit}`;
      if (status) q += `&status=eq.${encodeURIComponent(status)}`;
      const r = await table(q);
      if (!r.ok) return fail(502, "upstream_error");
      return json({ ok: true, count: r.data.length, orders: r.data.map(parcelOut) });
    }

    const one = path.match(/^\/orders\/([^/]+)$/);
    if (one && req.method === "GET") {
      const awb = decodeURIComponent(one[1]).toUpperCase();
      const r = await table(`parcels?client_id=eq.${clientId}&awb=eq.${encodeURIComponent(awb)}&limit=1`);
      const p = r.ok && r.data?.[0];
      if (!p) return fail(404, "order_not_found", `No parcel ${awb} on this account.`);
      const steps = (p.meta && p.meta.steps) || [];
      return json({ ok: true, order: { ...parcelOut(p), history: steps } });
    }

    const cancel = path.match(/^\/orders\/([^/]+)\/cancel$/);
    if (cancel && req.method === "POST") {
      const awb = decodeURIComponent(cancel[1]).toUpperCase();
      const r = await table(`parcels?client_id=eq.${clientId}&awb=eq.${encodeURIComponent(awb)}&limit=1`);
      const p = r.ok && r.data?.[0];
      if (!p) return fail(404, "order_not_found");
      if (p.status === "Cancelled by client") {
        return fail(409, "already_cancelled", `${awb} is already cancelled.`);
      }
      if (p.invoice_id) {
        return fail(409, "already_invoiced",
          "This parcel is on an invoice and cannot be cancelled through the API.");
      }
      if (p.status !== "New booked") {
        return fail(409, "already_collected",
          `This parcel is "${p.status}". Only a parcel still at "New booked" can be cancelled through the API.`);
      }
      const upd = await fetch(
        `${SB_URL}/rest/v1/parcels?id=eq.${p.id}`,
        { method: "PATCH",
          headers: { "content-type": "application/json", apikey: SB_KEY,
                     authorization: `Bearer ${SB_KEY}`, prefer: "return=representation" },
          /* "Cancelled by client" is the only cancel the status-transition
           trigger accepts -- an invented label like "Cancelled by merchant"
           is refused outright, which is what the first end-to-end run hit. */
        body: JSON.stringify({ status: "Cancelled by client" }) });
      if (!upd.ok) return fail(400, "cancel_failed", await upd.text());
      return json({ ok: true, awb, status: "Cancelled by client" });
    }

    // ------------------------------------------------------------ invoices --
    if (path === "/invoices" && req.method === "GET") {
      const r = await table(`invoices?client_id=eq.${clientId}&order=created_at.desc&limit=100`);
      if (!r.ok) return fail(502, "upstream_error");
      return json({ ok: true, count: r.data.length, invoices: r.data.map((i: any) => ({
        invoice: i.code, status: i.status,
        parcels: i.parcel_refs || [],
        cod_collected: Number(i.cod_total || 0),
        delivery_charges: Number(i.fee_total || 0),
        paid_to_you: Number(i.net_payable || 0),
        you_owe_novax: Number(i.due_to_novax || 0),
        created_at: i.created_at,
      })) });
    }

    // -------------------------------------------------------------- wallet --
    if (path === "/wallet" && req.method === "GET") {
      const c = await table(`clients?id=eq.${clientId}&select=wallet_balance,name&limit=1`);
      const bal = Number(c.data?.[0]?.wallet_balance || 0);
      const d = await table(
        `parcels?client_id=eq.${clientId}&status=eq.Delivered&invoice_id=is.null&select=cod_amount`);
      const inflight = (d.data || []).reduce((s: number, p: any) => s + Number(p.cod_amount || 0), 0);
      return json({ ok: true, currency: "PKR", balance: bal,
                    delivered_not_yet_invoiced: inflight });
    }

    // ------------------------------------------------------------- webhook --
    if (path === "/webhook" && (req.method === "PUT" || req.method === "POST")) {
      const b = body as any;
      const target = String(b?.url ?? "").trim();
      if (target && !/^https:\/\//i.test(target)) {
        return fail(422, "invalid_webhook_url", "Must start with https://");
      }
      const res = await rpc("nv_api_set_webhook_v2", {
        p_key_id: acct.key_id, p_url: target, p_rotate: b?.rotate_secret === true,
      });
      const row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!res.ok || (target && !row?.url)) return fail(400, "webhook_not_saved");
      if (!target) return json({ ok: true, webhook: null, delivery: "disabled" });
      return json({
        ok: true,
        webhook: row.url,
        delivery: "active",
        signing_secret: row.secret,
        verify: {
          how: "HMAC-SHA256 over `${X-NovaX-Timestamp}.${raw request body}`, hex encoded.",
          header: "X-NovaX-Signature: sha256=<hex>",
          note: "Compare with a constant-time equality check, and reject anything whose X-NovaX-Timestamp is more than 5 minutes old.",
        },
        retries: "6 attempts over ~9 hours (1m, 5m, 30m, 2h, 6h) on any non-2xx or timeout. Reply 2xx quickly; do your own work after.",
        redelivery: "Retries repeat the same X-NovaX-Delivery id, so treat that id as an idempotency key.",
      });
    }

    return fail(404, "unknown_endpoint",
      "Valid: POST /orders · GET /orders · GET /orders/:awb · POST /orders/:awb/cancel · GET /invoices · GET /wallet · PUT /webhook · GET /ping");
    })();
    return logResult(out);
  } catch (e) {
    const r = fail(500, "server_error", String((e as Error)?.message ?? e));
    return logResult(r, "server_error");
  }
});
