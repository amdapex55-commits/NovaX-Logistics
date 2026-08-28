/**
 * NovaX Merchant API — one base URL, one key, everything a shipper needs.
 *
 *   POST   /orders            book a parcel, get an AWB back
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

  const url = new URL(req.url);
  /* Supabase does not present the path the same way in every environment --
     it can arrive as /functions/v1/api/ping or just /api/ping. Strip either
     prefix rather than assume one; guessing wrong makes every route 404 while
     auth still works, which is exactly what happened on the first deploy. */
  const path = url.pathname
    .replace(/^\/functions\/v1\/api/, "")
    .replace(/^\/api(?=\/|$)/, "")
    .replace(/\/+$/, "") || "/";

  const auth = req.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) {
    return fail(401, "missing_api_key",
      "Send your key as: Authorization: Bearer nvx_live_...");
  }

  const who = await rpc("nv_api_resolve_key", { p_key: key });
  const acct = Array.isArray(who.data) ? who.data[0] : null;
  if (!acct) {
    return fail(401, "invalid_api_key",
      "That key is not recognised or has been revoked.");
  }
  const clientId: string = acct.client_id;

  try {
    // ---------------------------------------------------------------- ping --
    if (path === "/ping" || path === "/") {
      return json({ ok: true, account: acct.client_name, webhook: acct.webhook_url || null });
    }

    // -------------------------------------------------------------- orders --
    if (path === "/orders" && req.method === "POST") {
      const b = await req.json().catch(() => null) as any;
      if (!b) return fail(400, "invalid_json", "Body must be JSON.");

      const missing = ["consignee", "phone", "city", "address"]
        .filter((f) => !String(b[f] ?? "").trim());
      if (missing.length) {
        return fail(422, "missing_fields",
          `Required: ${missing.join(", ")}. cod_amount defaults to 0 for prepaid orders.`);
      }

      const cod = Number(b.cod_amount ?? 0);
      if (!isFinite(cod) || cod < 0) return fail(422, "invalid_cod_amount", "cod_amount must be 0 or more.");

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
      const b = await req.json().catch(() => null) as any;
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
  } catch (e) {
    return fail(500, "server_error", String((e as Error)?.message ?? e));
  }
});
