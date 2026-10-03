/* WooCommerce order intake (rebuilt 3 Oct 2026).
 *
 * The merchant adds WooCommerce webhooks (Order created + Order updated)
 * pointing at /functions/v1/woo-order-intake/<intake_token>, signed with the
 * secret NovaX showed them. An order is booked once, when it reaches
 * "processing" (COD orders start there; card orders arrive once paid).
 *
 * The old version (deployed as "woo-order-intake-", which the portal never
 * pointed at) inserted parcels directly at a flat fee. This one books
 * through nv_book_parcel_api_idem -- the Merchant API's path -- so weight,
 * zone pricing, phone/address/COD checks and duplicate protection are the
 * same as every other booking.
 *
 * Replies: WooCommerce disables a webhook after repeated non-2xx replies,
 * so an order NovaX cannot book (unserved city, bad phone) is answered 200
 * with ok:false and logged to the admin error monitor. Only transient
 * server faults answer 5xx, so WooCommerce retries those.
 */
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SERVED = ["karachi", "lahore", "islamabad", "rawalpindi"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
const rpc = (fn: string, args: Record<string, unknown>) =>
  rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* Logged where the office already looks (Admin -> System -> Errors). */
async function logRefusal(clientId: string, orderNo: string, reason: string) {
  await rest("portal_error_logs", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      source: "client", rpc_name: "woo-order-intake", page: "WooCommerce", client_id: clientId,
      message: `WooCommerce order #${orderNo} was not booked: ${reason}`.slice(0, 500), severity: "warning",
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return json({ error: "Missing intake token in URL" }, 400);

  const raw = await req.text();
  const sec = await rest(`store_secrets?intake_token=eq.${encodeURIComponent(token)}&platform=eq.woocommerce&select=client_id,webhook_secret&limit=1`);
  if (!sec.ok) return json({ error: "Temporarily unavailable" }, 503);
  const secret = Array.isArray(sec.data) ? sec.data[0] : null;
  if (!secret) return json({ error: "Unknown or inactive intake token" }, 401);

  // WooCommerce's activation ping is form-encoded ("webhook_id=12") and unsigned.
  if (!raw.trim().startsWith("{")) return json({ ok: true, note: "Webhook ping received" });

  const sig = req.headers.get("x-wc-webhook-signature") || "";
  if (!sig || !sameText(sig, await hmacBase64(secret.webhook_secret, raw))) {
    return json({ error: "Signature verification failed" }, 401);
  }

  let order: any;
  try { order = JSON.parse(raw); } catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!order || !order.id) return json({ ok: true, note: "Ignored: not an order" });

  const clientId: string = secret.client_id;
  const orderNo = String(order.number ?? order.id);
  const status = String(order.status || "").toLowerCase();
  if (status !== "processing") return json({ ok: true, note: `Ignored: order is "${status}", NovaX books at "processing"` });

  // Booked before? (also covers processing -> on-hold -> processing days later)
  const prior = await rest(`parcels?client_id=eq.${clientId}&meta->>source=eq.woocommerce&meta->>orderId=eq.${encodeURIComponent(orderNo)}&select=awb&limit=1`);
  if (!prior.ok) return json({ error: "Temporarily unavailable" }, 503);
  if (Array.isArray(prior.data) && prior.data[0]) return json({ ok: true, awb: prior.data[0].awb, note: "Already booked" });

  const billing = order.billing || {};
  const ship = order.shipping && (order.shipping.address_1 || order.shipping.city) ? order.shipping : billing;
  const consignee = [ship.first_name || billing.first_name, ship.last_name || billing.last_name].filter(Boolean).join(" ").trim();
  /* "+92 300 1234567" / "92-300..." -> "03001234567", as the portal stores it. */
  let phone = String(billing.phone || ship.phone || "").replace(/[^0-9]/g, "");
  if (phone.startsWith("92") && phone.length === 12) phone = "0" + phone.slice(2);
  else if (phone.length === 10 && phone.startsWith("3")) phone = "0" + phone;
  const city = String(ship.city || billing.city || "").trim();
  const address = [ship.address_1, ship.address_2].filter(Boolean).join(", ").trim();
  const isCod = String(order.payment_method || "").toLowerCase() === "cod";
  const cod = isCod ? Math.round(Number(order.total || 0)) : 0;
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const category = items.map((i: any) => `${i.quantity > 1 ? i.quantity + " x " : ""}${i.name || ""}`.trim())
    .filter(Boolean).join(", ").slice(0, 120);

  const city_ok = SERVED.find((c) => c === city.toLowerCase());
  if (!city_ok) {
    const reason = `NovaX does not deliver to "${city || "(no city)"}" yet (Karachi, Lahore, Islamabad, Rawalpindi).`;
    await logRefusal(clientId, orderNo, reason);
    return json({ ok: false, error: "city_not_served", hint: reason });
  }

  // Collected from the merchant's own pickup city, as in the portal.
  const cl = await rest(`clients?id=eq.${clientId}&select=meta&limit=1`);
  const pickupCity = (Array.isArray(cl.data) && cl.data[0]?.meta?.pickupCity) || "Karachi";

  const booked = await rpc("nv_book_parcel_api_idem", {
    p_client_id: clientId,
    p_idem_key: `woo:${order.id}`,
    p_consignee: consignee || "WooCommerce customer",
    p_phone: phone,
    p_pickup_city: pickupCity,
    p_city: city_ok.charAt(0).toUpperCase() + city_ok.slice(1),
    p_address: address,
    p_cod: cod,
    p_weight: "0.5 kg",
    p_service: "COD Standard",
    p_category: category,
    p_fragile: "No",
    p_payment_mode: cod > 0 ? "COD" : "Non COD",
    p_order_id: orderNo,
    p_reference_no: `woo:${order.id}`,
    p_source: "woocommerce",
    p_actor_role: "api",
  });
  if (!booked.ok) {
    const msg = typeof booked.data?.message === "string" ? booked.data.message : "Booking failed";
    if (booked.status >= 500) return json({ error: "Temporarily unavailable" }, 503);
    await logRefusal(clientId, orderNo, msg);
    return json({ ok: false, error: "booking_refused", hint: msg });
  }
  const p = Array.isArray(booked.data) ? booked.data[0] : booked.data;

  const note = String(order.customer_note || "").trim().slice(0, 180);
  if (note && p?.awb) {
    await rpc("nv_set_parcel_extras_core", { p_client_id: clientId, p_awb: p.awb, p_comments: note, p_allow_open: null }).catch(() => {});
  }
  return json({ ok: true, awb: p?.awb ?? null });
});
