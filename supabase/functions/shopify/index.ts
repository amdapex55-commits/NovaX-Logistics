// ---------------------------------------------------------------------------
// NovaX Shopify app - single edge function, internally routed.
//
// One function rather than eight: Shopify needs OAuth, six webhooks and an
// embedded page, and every one of them needs the same secret, the same shop
// lookup and the same HMAC code. Eight deployments that must be kept in step is
// eight chances to leave one behind on an old API version.
//
// DEPLOY WITH --no-verify-jwt. Shopify does not send a Supabase anon key, so
// with JWT verification on, every webhook and the OAuth redirect get a 401
// before they ever reach this code. Auth here is Shopify's own HMAC and
// session tokens, checked in verify.ts.
// ---------------------------------------------------------------------------

import { cleanShop, verifyOAuthHmac, verifySessionToken, verifyWebhookHmac } from "./verify.ts";
import { fetchOrder, mergeKnownWeights, ordersSince, pushTracking, registerWebhooks } from "./shopify-api.ts";
import { excludedByTag, holdReason, mapOrderToBooking, type ShopifyOrder } from "./orders.ts";
import {
  claimWebhook, completeWebhook, getShop, insert, logEvent, logProtectedAccess, rpc,
  selectMany, selectOne, update,
} from "./db.ts";
import { embeddedApp, frameAncestors } from "./ui.ts";

const API_KEY = Deno.env.get("SHOPIFY_API_KEY") ?? "";
const API_SECRET = Deno.env.get("SHOPIFY_API_SECRET") ?? "";
const APP_URL = (Deno.env.get("SHOPIFY_APP_URL") ?? "").replace(/\/+$/, "");
// Must stay identical to [access_scopes] in shopify.app.novax-public.toml. The
// toml is what Shopify grants; this is what /install asks for. When they drift,
// the merchant authorises one set and the app is granted another, and the
// mismatch only shows up as a permission error on the first fulfillment.
const SCOPES = Deno.env.get("SHOPIFY_SCOPES") ??
  "read_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders";
const PORTAL_URL = Deno.env.get("NOVAX_PORTAL_URL") ?? "https://novaxlogistics.com/client.html";
const TRACKING_BASE = Deno.env.get("NOVAX_TRACKING_URL") ?? "https://novaxlogistics.com/tracking.html";
const DRAIN_SECRET = Deno.env.get("NOVAX_DRAIN_SECRET") ?? "";

// ---------------------------------------------------------------- utils -----

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** Supabase serves this at /functions/v1/shopify/<route>. Strip both prefixes
 *  so the same code works locally, where neither is present. */
function route(pathname: string): string {
  return pathname
    .replace(/^\/functions\/v1/, "")
    .replace(/^\/shopify/, "")
    .replace(/\/+$/, "") || "/";
}

/** Run work after the response is sent. Shopify gives a webhook 5 seconds; a
 *  booking plus a fulfillment call can exceed that, and a timeout makes Shopify
 *  retry an order we are already mid-way through booking. */
function background(p: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(p.catch((e) => console.error("bg", e)));
  else p.catch((e) => console.error("bg", e));
}

function trackingUrl(awb: string): string {
  return `${TRACKING_BASE}?awb=${encodeURIComponent(awb)}`;
}

// ---------------------------------------------------------------- OAuth -----

async function handleInstall(url: URL): Promise<Response> {
  const shop = cleanShop(url.searchParams.get("shop"));
  if (!shop) return text("missing or invalid ?shop", 400);

  const state = crypto.randomUUID().replace(/-/g, "");
  await insert("nvsh_oauth_state", { state, shop_domain: shop });

  const auth = new URL(`https://${shop}/admin/oauth/authorize`);
  auth.searchParams.set("client_id", API_KEY);
  auth.searchParams.set("scope", SCOPES);
  auth.searchParams.set("redirect_uri", `${APP_URL}/callback`);
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
}

async function handleCallback(url: URL): Promise<Response> {
  const shop = cleanShop(url.searchParams.get("shop"));
  if (!shop) return text("invalid shop", 400);

  if (!await verifyOAuthHmac(url, API_SECRET)) {
    await logEvent(shop, "oauth", null, false, "hmac failed");
    return text("hmac verification failed", 401);
  }

  // The nonce proves this redirect answers an install WE started. Without it,
  // anyone can send a merchant a crafted callback and bind their store to a
  // different account.
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  // A35: check everything that can fail cheaply BEFORE burning the nonce, so a
  // missing code does not force the merchant to restart the whole install.
  if (!code) return text("missing code", 400);

  // A36: this was select, check, update -- three statements, so two callbacks
  // could both see the nonce unused, and its age was never checked at all. One
  // conditional UPDATE with a 15-minute TTL is the whole check.
  const consumed = await rpc<boolean>("nvsh_consume_oauth_state", { p_state: state, p_shop: shop });
  if (consumed !== true) {
    await logEvent(shop, "oauth", null, false, "bad, expired or reused state");
    return text("invalid state — start the install again from Shopify", 401);
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code }),
  });
  if (!tokenRes.ok) {
    await logEvent(shop, "oauth", null, false, `token exchange ${tokenRes.status}`);
    return text("token exchange failed", 502);
  }
  const tok = await tokenRes.json() as { access_token: string; scope: string };

  // Upsert: a reinstall must replace the old token, not fail on the unique key.
  const existing = await getShop(shop);
  if (existing) {
    await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(shop)}`, {
      access_token: tok.access_token,
      scopes: tok.scope,
      // A37: reinstalling reactivated an administratively blocked shop. A block
      // is a decision someone made; only an admin undoes it.
      status: existing.status === "blocked"
        ? "blocked"
        : (existing.client_id ? "active" : "pending_link"),
      uninstalled_at: null,
      updated_at: new Date().toISOString(),
    });
  } else {
    await insert("nvsh_shop", {
      shop_domain: shop,
      access_token: tok.access_token,
      scopes: tok.scope,
      status: "pending_link",
    });
  }

  const results = await registerWebhooks(shop, tok.access_token, APP_URL);
  // A23: a failed registration was logged and the merchant was redirected into
  // an app that looked installed while no order would ever arrive. Record it on
  // the shop so the embedded page can say so and the retry job can fix it.
  const bad = results.filter((r) => !r.ok);
  await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(shop)}`, {
    webhooks_ok: bad.length === 0,
    last_error: bad.length
      ? `Shopify did not accept ${bad.length} order webhook(s): ${bad.map((b) => b.topic).join(", ")}`
      : null,
    last_error_at: bad.length ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  const failed = results.filter((r) => !r.ok);
  await logEvent(shop, "oauth", null, failed.length === 0,
    failed.length ? `webhooks failed: ${failed.map((f) => `${f.topic}(${f.detail})`).join(", ")}` : "installed");

  return Response.redirect(`https://${shop}/admin/apps/${API_KEY}`, 302);
}

// ------------------------------------------------------------ embedded ------

function handleApp(url: URL): Response {
  const shop = cleanShop(url.searchParams.get("shop"));
  if (!shop) return text("missing or invalid ?shop", 400);

  return new Response(embeddedApp(API_KEY, shop, PORTAL_URL), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": frameAncestors(shop),
      // The page is per-shop and reflects live data; a cached copy shown to
      // the wrong store would be a data leak, not just a stale render.
      "Cache-Control": "no-store",
    },
  });
}

/** Every merchant action is authorised the same way: an App Bridge session
 *  token, signed by Shopify with our client secret, naming the shop. The shop
 *  in that token is the ONLY shop the request may touch -- a shop parameter in
 *  a body would let any merchant act on any store. */
async function sessionShop(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = await verifySessionToken(token, API_KEY, API_SECRET);
  return session?.shop ?? null;
}

/** A32: this returned {} on a parse failure, and the settings handler read {}
 *  as "auto booking, no filters" -- so malformed JSON silently deleted every
 *  safeguard a merchant had set and answered "Saved." A parse failure is an
 *  error, not an instruction. */
async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  if (req.method !== "POST") return null;
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
}

/** A33: an authenticated GET to /api/settings reset the merchant's rules,
 *  because the router never checked the method and the body parser answered
 *  with defaults. Read methods must not write. */
function requirePost(req: Request): Response | null {
  return req.method === "POST"
    ? null
    : json({ error: "method not allowed" }, 405, { Allow: "POST" });
}

/** Connect this store to a NovaX merchant with a code the merchant generated
 *  while signed into that account. Ownership is proven by that session, never
 *  by matching an email address -- an email match would let anyone who knows a
 *  merchant's address attach their store to that merchant's wallet. */
async function handleLink(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);

  const body = await jsonBody(req);
  if (!body) return json({ ok: false, message: "Could not read that request." }, 400);
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) {
    return json({ ok: false, message: "Enter the 8-character code from your NovaX portal." });
  }

  const res = await rpc<Array<{ ok: boolean; client_name: string | null; released: number; message: string }>>(
    "nvsh_link_claim", { p_shop: shop, p_code: code },
  );
  const r = Array.isArray(res) ? res[0] : res;
  await logEvent(shop, "link", null, Boolean(r?.ok), r?.message ?? "no result");

  // A08: nvsh_link_claim() moves held orders to 'received' and nothing was
  // scheduled to pick them up, so "will be booked the moment you connect" was
  // untrue -- they sat there. Book them now.
  if (r?.ok && (r.released ?? 0) > 0) background(drainReceived(shop));

  return json(r ?? { ok: false, message: "Could not connect." }, 200, { "Cache-Control": "no-store" });
}

async function handleSettings(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);

  const b = await jsonBody(req);
  // A32: without this, a truncated or malformed save wiped the rules and said
  // "Saved." Nothing is written unless the whole body parsed.
  if (!b) {
    return json({ ok: false, message: "Your settings were not saved — the request could not be read. Nothing was changed." }, 400);
  }
  if (typeof b.booking_mode !== "string") {
    return json({ ok: false, message: "Your settings were not saved — booking mode was missing. Nothing was changed." }, 400);
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  const mode = String(b.booking_mode ?? "auto");
  if (mode !== "auto" && mode !== "manual") {
    return json({ ok: false, message: "Booking mode must be automatic or manual." });
  }

  await rpc("nvsh_settings_update", {
    p_shop: shop,
    p_booking_mode: mode,
    p_require_confirmed: Boolean(b.require_confirmed),
    p_payment_modes: arr(b.payment_modes),
    p_shipping_names: arr(b.shipping_names),
    p_location_ids: arr(b.location_ids),
    p_exclude_tags: arr(b.exclude_tags),
  });
  return json({ ok: true, message: "Saved." }, 200, { "Cache-Control": "no-store" });
}

async function handleDecide(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);
  const res = await rpc<Array<{ ok: boolean; message: string }>>("nvsh_order_decide", {
    p_shop: shop,
    p_order_id: String(b.order_id ?? ""),
    p_decision: String(b.decision ?? ""),
  });
  const r = Array.isArray(res) ? res[0] : res;
  // Approving moves the row to 'received', which is what the drain picks up.
  // Book it now rather than making the merchant wait for the next tick: they
  // are looking at the screen, and "approved" that does nothing for a minute
  // reads as a dead button.
  if (r?.ok && String(b.decision) === "approve") {
    const orderId = String(b.order_id ?? "");
    const row = await selectOne<{ payload: ShopifyOrder | null }>(
      "nvsh_order",
      `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}&select=payload`,
    );

    // A24: the stored payload is whatever arrived with the webhook. A merchant
    // who holds an order usually holds it BECAUSE something was wrong, fixes
    // the address or the total in Shopify, and then approves -- and the old
    // payload would have sent the parcel to the address they just corrected.
    let payload = row?.payload ?? null;
    try {
      const shopRow = await getShop(shop);
      if (shopRow?.access_token) {
        const fresh = await fetchOrder(shop, shopRow.access_token, orderId);
        if (fresh) {
          // B03: the GraphQL order carries no per-item weight without
          // read_inventory, a scope this app does not request. Carry the
          // weights we already have from the webhook payload.
          payload = mergeKnownWeights(fresh, row?.payload as unknown as Record<string, unknown>) as unknown as ShopifyOrder;
          await update("nvsh_order",
            `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}`,
            { payload: fresh, updated_at: new Date().toISOString() });
        }
      }
    } catch (e) {
      // F14: this booked the stored payload without telling anyone. A merchant
      // who held an order BECAUSE the address was wrong, fixed it in Shopify,
      // and approved during an outage would have shipped to the old address.
      console.error("refresh before approval failed", orderId, e);
      return json({
        ok: false,
        message: "Could not read the current order from Shopify, so nothing was booked — " +
          "the details we hold may be out of date. Try again in a moment.",
      }, 200, { "Cache-Control": "no-store" });
    }

    if (payload) background(processOrder(shop, orderId, payload));
  }
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}

async function handleCancel(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);
  const res = await rpc<Array<{ ok: boolean; outcome: string; message: string }>>(
    "nvsh_cancel_or_recall", { p_shop: shop, p_order_id: String(b.order_id ?? "") },
  );
  const r = Array.isArray(res) ? res[0] : res;
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}

/** "Another delivery fee" was too vague to decide from. This is the number. */
async function handleQuote(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false }, 400);
  try {
    const fee = await rpc<number | null>("nvsh_quote", {
      p_shop: shop, p_city: String(b.city ?? ""), p_weight: String(b.weight ?? "0.5 kg"),
    });
    return json({ ok: true, fee }, 200, { "Cache-Control": "no-store" });
  } catch {
    return json({ ok: true, fee: null }, 200, { "Cache-Control": "no-store" });
  }
}

async function handlePickup(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);
  const res = await rpc<Array<{ ok: boolean; message: string; awb_count: number }>>(
    "nvsh_pickup_request", { p_shop: shop, p_note: String(b.note ?? "") },
  );
  const r = Array.isArray(res) ? res[0] : res;
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}

async function handleTicket(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);
  const res = await rpc<Array<{ ok: boolean; message: string }>>("nvsh_ticket_open", {
    p_shop: shop, p_order_id: String(b.order_id ?? ""), p_body: String(b.body ?? ""),
  });
  const r = Array.isArray(res) ? res[0] : res;
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}

async function handleApproveAll(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const res = await rpc<Array<{ ok: boolean; message: string; approved: number }>>(
    "nvsh_approve_all", { p_shop: shop },
  );
  const r = Array.isArray(res) ? res[0] : res;
  if (r?.ok) background(drainReceived(shop));
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}

/** Book another parcel for an order that ships in more than one box. The
 *  package number is what separates a deliberate second box from an accidental
 *  replay -- the unique index keys on it. */
async function handleSplit(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b_ = await jsonBody(req);
  if (!b_) return json({ ok: false, message: "Could not read that request." }, 400);
  const orderId = String(b_.order_id ?? "");
  const shopRow = await getShop(shop);

  const row = await selectOne<{
    payload: ShopifyOrder | null; awb: string | null; extra_awbs: string[] | null;
    status: string; recall_requested_at: string | null;
  }>(
    "nvsh_order",
    `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}` +
    `&select=payload,awb,extra_awbs,status,recall_requested_at`,
  );
  if (!row?.payload || !row.awb) {
    return json({ ok: false, message: "That order has no parcel yet." });
  }

  // A20: the only check was "is there a payload and an AWB", so a cancelled
  // order happily produced package 2, and a delivered one -- whose nvsh_order
  // row still reads 'booked' -- offered Extra box forever.
  if (row.status !== "booked") {
    return json({ ok: false, message: `This order is ${row.status}. Extra boxes can only be added to a booked order.` });
  }
  if (row.recall_requested_at) {
    return json({ ok: false, message: "A recall has been raised for this order, so no more boxes can be added." });
  }
  const firstParcel = await selectOne<{ status: string }>(
    "parcels", `awb=eq.${encodeURIComponent(row.awb)}&select=status`,
  );
  const openStates = ["New booked", "Collected by rider", "Arrived at warehouse", "Parcel now in transit"];
  if (firstParcel && !openStates.includes(firstParcel.status)) {
    return json({
      ok: false,
      message: `Parcel ${row.awb} is already ${firstParcel.status}. An extra box has to travel with the shipment, so it cannot be added now.`,
    });
  }

  // B09: the package number came from the array length, so a lost response and
  // a repeated click produced package 3 instead of recovering package 2 -- and
  // charged for it. The caller's key is the intent; the same key returns the
  // same box.
  const key = String(b_.key ?? "").trim() || `${orderId}:${row.extra_awbs?.length ?? 0}`;

  // B13: this called the mapper without the shop's prepaid setting, so a booked
  // prepaid order was rejected as though prepaid booking were off.
  const mapped = mapOrderToBooking(row.payload, {
    bookPrepaid: Boolean(shopRow?.rule_require_confirmed),
  });
  if (mapped.action === "skip") return json({ ok: false, message: mapped.reason });
  const bk = mapped.booking;

  const res = await rpc<Array<{ ok: boolean; awb: string | null; package_no: number; message: string; needs_confirm: boolean }>>(
    "nvsh_add_package", {
      p_shop: shop, p_order_id: orderId, p_key: key,
      // F20: the key lives in the page's memory, so a lost response plus a
      // reload mints a new one. The database treats an unknown key moments
      // after the last box as a probable retry and asks first.
      p_confirm_additional: Boolean(b_.confirm_additional),
      p_consignee: bk.consignee, p_phone: bk.phone, p_city: bk.city, p_address: bk.address,
      // A49: an extra box is a separate package whose weight we do not know.
      p_weight: "0.5 kg", p_service: bk.service, p_category: bk.category,
      p_fragile: bk.fragile, p_payment_mode: bk.paymentMode, p_order_name: bk.orderId,
    },
  );
  const r = Array.isArray(res) ? res[0] : res;
  return json(r ?? { ok: false, message: "No result." }, 200, { "Cache-Control": "no-store" });
}


/** Books every order sitting in 'received' for one shop. Shared by the drain
 *  and by bulk approve so there is one booking path, not two. */
async function drainReceived(shop: string): Promise<void> {
  const rows = await selectMany<{ shopify_order_id: string; payload: ShopifyOrder | null; approved_at: string | null }>(
    "nvsh_order",
    `shop_domain=eq.${encodeURIComponent(shop)}&status=eq.received&select=shopify_order_id,payload,approved_at&limit=100`,
  );
  const shopRow = await getShop(shop);
  for (const r of rows) {
    if (!r.payload) continue;
    // B16: only individual approval refetched, so "Approve all" shipped the
    // address the merchant had already corrected in Shopify. Anything a human
    // approved is refetched before it is booked.
    let payload = r.payload;
    if (r.approved_at && shopRow?.access_token) {
      try {
        const fresh = await fetchOrder(shop, shopRow.access_token, r.shopify_order_id);
        if (fresh) payload = mergeKnownWeights(fresh, r.payload as unknown as Record<string, unknown>) as unknown as ShopifyOrder;
      } catch (e) {
        // Same rule in bulk: leave it for the merchant rather than shipping
        // values we could not confirm.
        console.error("bulk refresh failed", r.shopify_order_id, e);
        await update("nvsh_order",
          `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(r.shopify_order_id)}`,
          { status: "awaiting_approval", approved_at: null,
            hold_reason: "Shopify could not be reached to confirm the current address and total. Approve again to retry.",
            updated_at: new Date().toISOString() });
        continue;
      }
    }
    await processOrder(shop, r.shopify_order_id, payload);
  }
}

// -------------------------------------------------------- reconcile --------
// A09: the drain re-reads rows we already hold, so it can never recover an
// order whose webhook never landed. This asks Shopify what it has and books
// anything missing. Runs on a schedule, and a merchant can trigger it.

async function reconcileShop(shop: string, hours: number): Promise<{
  checked: number; discovered: number; booked: number; held: number;
  skipped: number; failed: number; complete: boolean;
}> {
  const empty = { checked: 0, discovered: 0, booked: 0, held: 0, skipped: 0, failed: 0, complete: true };
  const found: string[] = [];
  const shopRow = await getShop(shop);
  if (!shopRow?.access_token || shopRow.status !== "active" || !shopRow.client_id) return empty;

  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  // B08/B24: resume from where the last sweep stopped instead of re-reading the
  // same first 200 orders every run and never reaching the later ones.
  const cur = await selectOne<{ reconcile_cursor: string | null }>(
    "nvsh_shop", `shop_domain=eq.${encodeURIComponent(shop)}&select=reconcile_cursor`,
  );
  const page = await ordersSince(shop, shopRow.access_token, since, 10, cur?.reconcile_cursor ?? null);
  const orders = page.orders;
  let discovered = 0;

  for (const { id, order } of orders) {
    const existing = await selectOne<{ id: string }>(
      "nvsh_order",
      `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(id)}&select=id`,
    );
    if (existing) continue;   // already known: webhook or an earlier pass got it
    discovered++;
    found.push(id);

    await insert("nvsh_order", {
      shop_domain: shop,
      shopify_order_id: id,
      order_name: (order as { name?: string }).name ?? null,
      payload: order,
      status: "received",
    }, { onConflict: "shop_domain,shopify_order_id", ignoreDuplicates: true });

    await logEvent(shop, "reconcile", null, true, `${id}: recovered, no webhook was recorded`);
    await processOrder(shop, id, order as unknown as ShopifyOrder);
  }

  // B23: "recovered" counted rows INSERTED, and the message said they had been
  // booked. A USD order was imported, reported as booked, and was actually
  // skipped with no parcel. Report what each one became.
  // F12: this counted every recent order, so a scan that discovered one USD
  // order and created zero parcels reported "1 booked, 1 skipped" by counting a
  // pre-existing booking. Only what this scan found.
  const after = found.length
    ? await selectMany<{ status: string }>(
        "nvsh_order",
        `shop_domain=eq.${encodeURIComponent(shop)}&select=status` +
        `&shopify_order_id=in.(${found.map(encodeURIComponent).join(",")})`,
      ).catch(() => [] as Array<{ status: string }>)
    : [];
  const n = (st: string) => after.filter((r) => r.status === st).length;

  await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(shop)}`, {
    reconcile_cursor: page.cursor, reconciled_at: new Date().toISOString(),
  }).catch(() => []);

  return {
    checked: orders.length, discovered,
    booked: n("booked"), held: n("awaiting_approval"),
    skipped: n("skipped"), failed: n("failed"),
    complete: page.complete,
  };
}

async function handleReconcile(req: Request): Promise<Response> {
  // Two callers: the scheduled job with the drain secret (all shops), and a
  // merchant pressing the button, whose session token names exactly one shop.
  const hours = 48;
  if (DRAIN_SECRET && req.headers.get("X-NovaX-Drain") === DRAIN_SECRET) {
    // B24: this took the first 200 shops with no ordering, so shop 201 might
    // never be swept at all. Oldest-swept first, so every store comes round.
    const shops = await selectMany<{ shop_domain: string }>(
      "nvsh_shop",
      "status=eq.active&client_id=not.is.null&select=shop_domain" +
      "&order=reconciled_at.asc.nullsfirst&limit=50",
    );
    let checked = 0, discovered = 0, incomplete = 0;
    for (const s of shops) {
      try {
        const r = await reconcileShop(s.shop_domain, hours);
        checked += r.checked; discovered += r.discovered;
        if (!r.complete) incomplete++;
      } catch (e) {
        await logEvent(s.shop_domain, "reconcile", null, false, String((e as Error).message).slice(0, 300));
      }
    }
    return json({ shops: shops.length, checked, discovered, incomplete });
  }

  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  try {
    const r = await reconcileShop(shop, hours);
    const parts = [];
    if (r.booked) parts.push(`${r.booked} booked`);
    if (r.held) parts.push(`${r.held} waiting for approval`);
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.failed) parts.push(`${r.failed} failed`);
    return json({
      ok: true,
      message: r.discovered
        ? `Found ${r.discovered} order${r.discovered === 1 ? "" : "s"} Shopify had and we did not` +
          (parts.length ? ` — ${parts.join(", ")}. Check the list below.` : ".") +
          (r.complete ? "" : " There are more to check; run it again.")
        : `Checked the last ${hours} hours — nothing missing.` +
          (r.complete ? "" : " More pages remain; run it again."),
      ...r,
    }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ ok: false, message: "Could not reach Shopify: " + String((e as Error).message).slice(0, 200) });
  }
}

/** A65: a tracking sync that gave up after twelve attempts had no way back.
 *  This clears the failure and puts it at the front of the queue. */
async function handleResync(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);

  const where = `shop_domain=eq.${encodeURIComponent(shop)}` +
    `&shopify_order_id=eq.${encodeURIComponent(String(b.order_id ?? ""))}`;
  const rows = await update("nvsh_order", `${where}&fulfill_state=eq.failed`, {
    fulfill_state: "ready", fulfill_attempts: 0, fulfill_leased_until: null,
    fulfill_error: null, updated_at: new Date().toISOString(),
  });
  if (!rows.length) return json({ ok: false, message: "That order has no failed sync to retry." });
  return json({ ok: true, message: "Retrying. Shopify is usually updated within a minute." });
}

/** A65: a skipped order could not be reconsidered after the merchant fixed
 *  whatever caused the skip. This refetches from Shopify and runs it again. */
async function handleRecheck(req: Request): Promise<Response> {
  const bad = requirePost(req);
  if (bad) return bad;
  const shop = await sessionShop(req);
  if (!shop) return json({ error: "unauthorized" }, 401);
  const b = await jsonBody(req);
  if (!b) return json({ ok: false, message: "Could not read that request." }, 400);
  const orderId = String(b.order_id ?? "");

  const row = await selectOne<{ status: string; payload: ShopifyOrder | null }>(
    "nvsh_order",
    `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}&select=status,payload`,
  );
  if (!row) return json({ ok: false, message: "No such order." });
  if (row.status !== "skipped" && row.status !== "failed") {
    return json({ ok: false, message: `That order is ${row.status}; there is nothing to retry.` });
  }

  const shopRow = await getShop(shop);
  if (!shopRow?.access_token) return json({ ok: false, message: "This store is not connected." });

  try {
    const raw = await fetchOrder(shop, shopRow.access_token, orderId);
    if (!raw) return json({ ok: false, message: "Shopify no longer has that order." });
    // F05: this selected only status, refetched a payload whose grams are zero,
    // and overwrote the stored webhook payload -- so Try again booked a known
    // 1.1 kg order at the 0.8 kg default AND destroyed the only record of its
    // real weight.
    const fresh = mergeKnownWeights(raw, row.payload as unknown as Record<string, unknown>);
    await update("nvsh_order",
      `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}`,
      { payload: fresh, status: "received", skip_reason: null, error: null,
        attempts: 0, next_attempt_at: null, updated_at: new Date().toISOString() });
    background(processOrder(shop, orderId, fresh as unknown as ShopifyOrder));
    return json({ ok: true, message: "Refetched from Shopify and trying again." });
  } catch (e) {
    return json({ ok: false, message: "Could not reach Shopify: " + String((e as Error).message).slice(0, 160) });
  }
}

async function handleState(req: Request): Promise<Response> {
  const session = await sessionShop(req);
  if (!session) return json({ error: "unauthorized" }, 401);

  // A64: Promise.all meant a broken wallet read returned NOTHING -- a merchant
  // could not dispatch a parcel because an unrelated money query was down.
  // Each section reports its own health and the rest still works.
  const [shopRows, orders, wallet] = await Promise.allSettled([
    rpc<Array<Record<string, unknown>>>("nvsh_shop_state", { p_shop: session }),
    rpc<Array<Record<string, unknown>>>("nvsh_recent_orders", {
      p_shop: session,
      p_limit: Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 25), 1), 100),
      p_offset: Math.max(Number(new URL(req.url).searchParams.get("offset") ?? 0), 0),
      p_filter: new URL(req.url).searchParams.get("filter") ?? "all",
      p_search: new URL(req.url).searchParams.get("q") ?? null,
    }),
    rpc<Array<Record<string, unknown>>>("nvsh_wallet_summary", { p_shop: session }),
  ]);
  const val = <T>(r: PromiseSettledResult<T>): T | null => r.status === "fulfilled" ? r.value : null;

  if (shopRows.status === "rejected") {
    // Without the shop row there is no usable screen at all.
    return json({ error: "state unavailable" }, 503, { "Cache-Control": "no-store" });
  }

  return json({
    shop: val(shopRows)?.[0] ?? null,
    orders: val(orders) ?? [],
    orders_total: (val(orders)?.[0] as { total_count?: number } | undefined)?.total_count ?? 0,
    wallet: val(wallet)?.[0] ?? null,
    degraded: {
      orders: orders.status === "rejected",
      wallet: wallet.status === "rejected",
    },
    fetched_at: new Date().toISOString(),
  }, 200, { "Cache-Control": "no-store" });
}

// ------------------------------------------------------------- webhooks -----

interface Verified {
  shop: string;
  webhookId: string | null;
  topic: string;
  body: string;
}

/** Proves a webhook is genuinely Shopify's before a single byte is trusted. */
async function verifiedWebhook(req: Request, topic: string): Promise<Verified | Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256");

  if (!await verifyWebhookHmac(raw, hmacHeader, API_SECRET)) {
    // 401 is what Shopify's own compliance-webhook requirement asks for.
    return text("hmac verification failed", 401);
  }

  const shop = cleanShop(req.headers.get("X-Shopify-Shop-Domain"));
  if (!shop) return text("bad shop header", 400);

  return {
    shop,
    webhookId: req.headers.get("X-Shopify-Webhook-Id"),
    topic,
    body: new TextDecoder().decode(raw),
  };
}

/** A28: String(undefined) is "undefined", and every malformed delivery then
 *  collapsed onto one shared fake order id -- unrelated events overwriting each
 *  other's row, and a reference number of "undefined" on a real parcel. */
function shopifyOrderId(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^gid:\/\/shopify\/Order\//, "");
  return /^[0-9]{1,20}$/.test(s) ? s : null;
}

async function handleOrdersCreate(v: Verified): Promise<Response> {
  const order = JSON.parse(v.body) as ShopifyOrder;
  const orderId = shopifyOrderId(order.id);
  if (!orderId) {
    await logEvent(v.shop, v.topic, v.webhookId, false,
      `rejected: no usable order id in payload`);
    // 400, not 500: retrying an unparseable payload cannot help.
    return text("order id missing or malformed", 400);
  }

  // Record it before doing anything slow. The unique index on
  // (shop_domain, shopify_order_id) means a Shopify retry lands on the same row
  // rather than creating a second parcel.
  const existing = await selectOne<{ id: string; status: string }>(
    "nvsh_order",
    `shop_domain=eq.${encodeURIComponent(v.shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}&select=id,status`,
  );

  if (existing && existing.status !== "received") {
    await logEvent(v.shop, v.topic, v.webhookId, true, `duplicate delivery for ${orderId}, already ${existing.status}`);
    return text("ok");
  }

  if (!existing) {
    await insert("nvsh_order", {
      shop_domain: v.shop,
      shopify_order_id: orderId,
      order_name: order.name ?? null,
      cod_amount: null,
      payload: order,
      status: "received",
    }, { onConflict: "shop_domain,shopify_order_id", ignoreDuplicates: true });
  }

  background(processOrder(v.shop, orderId, order));
  return text("ok");
}

/** Book one order. Safe to call again for the same order: it re-reads the row
 *  and stops if someone else already booked it. */
async function processOrder(shop: string, orderId: string, order: ShopifyOrder): Promise<void> {
  const where = `shop_domain=eq.${encodeURIComponent(shop)}&shopify_order_id=eq.${encodeURIComponent(orderId)}`;
  const now = new Date().toISOString();

  try {
    const shopRow = await getShop(shop);
    if (!shopRow || shopRow.status === "uninstalled") {
      await update("nvsh_order", where, { status: "failed", error: "store not installed", updated_at: now });
      return;
    }

    // Orders that arrive before an admin links the store are held, not dropped.
    // nvsh_admin_link() releases them the moment the link is made.
    if (!shopRow.client_id || shopRow.status !== "active") {
      await update("nvsh_order", where, { status: "pending_link", updated_at: now });
      return;
    }

    // A12: bookPrepaid was never passed, so a fully paid order could never be
    // booked no matter what the merchant ticked. The checkbox now sets it.
    const mapped = mapOrderToBooking(order, {
      bookPrepaid: Boolean(shopRow.rule_require_confirmed),
    });
    if (mapped.action === "skip") {
      await update("nvsh_order", where, {
        status: "skipped", skip_reason: mapped.reason, error: mapped.reason,
        client_id: shopRow.client_id, updated_at: now,
      });
      return;
    }

    // The merchant's own rules, applied after "can this even be delivered".
    // An undeliverable order is skipped whatever the rules say; a deliverable
    // one the merchant wants to see first is held, not dropped.
    //
    // An order the merchant already approved is exempt. Without this, approving
    // a held order re-evaluates the same rules that held it and holds it again
    // -- an Approve button that puts the row straight back where it was.
    // A30: a hard exclusion is checked BEFORE the approved_at exemption, so
    // approving cannot override "never book this".
    const excluded = excludedByTag(order, shopRow);
    if (excluded) {
      await update("nvsh_order", where, {
        status: "skipped", skip_reason: excluded, error: excluded,
        client_id: shopRow.client_id, updated_at: now,
      });
      return;
    }

    const decided = await selectOne<{ approved_at: string | null }>(
      "nvsh_order", `${where}&select=approved_at`,
    );
    const hold = decided?.approved_at ? null : holdReason(order, shopRow);
    if (hold) {
      // A31: held rows showed a dash where the COD should be, so the merchant
      // pressed "Book it" without seeing the amount they were committing to.
      // The mapped booking is priced by now; persist what it says.
      await update("nvsh_order", where, {
        status: "awaiting_approval", hold_reason: hold,
        cod_amount: mapped.booking.cod,
        client_id: shopRow.client_id, updated_at: now,
      });
      return;
    }

    const b = mapped.booking;

    // Level 2 protected customer data. Logged at the one point it is read.
    await logProtectedAccess(shop, "book_courier_shipment",
      ["shipping_address.name", "shipping_address.address1", "shipping_address.city", "phone"],
      `shopify_order:${orderId}`);

    // B07: this was a status read, then the booking RPC, then the link write --
    // three transactions, and a cancellation landing in either gap produced a
    // real parcel for an order the merchant had cancelled. nvsh_book_linked()
    // takes the same lock cancellation takes, re-checks, adopts an existing
    // parcel rather than duplicating it, books, and writes the link, in one
    // transaction.
    const booked = await rpc<Array<{ ok: boolean; awb: string | null; message: string }>>(
      "nvsh_book_linked", {
        p_shop: shop, p_order_id: orderId,
        p_consignee: b.consignee, p_phone: b.phone, p_city: b.city, p_address: b.address,
        p_cod: b.cod, p_weight: b.weight, p_service: b.service, p_category: b.category,
        p_fragile: b.fragile, p_payment_mode: b.paymentMode,
        p_order_name: b.orderId, p_client_id: shopRow.client_id,
      },
    );
    const bres = Array.isArray(booked) ? booked[0] : booked;
    if (!bres?.ok) {
      await logEvent(shop, "orders_create", null, true, `${orderId}: ${bres?.message ?? "not booked"}`);
      return;
    }
    const awb = bres.awb!;
    if (bres.message !== "booked") {
      await logEvent(shop, "orders_create", null, true, `${orderId}: ${bres.message} (${awb})`);
      return;
    }

    // A07: this is a statistic. It used to sit inside the same try, so a 503
    // on the counter PATCH threw, the catch wrote status 'failed', and an
    // order with a real AWB ended up marked failed -- after which every drain
    // retry hit the parcel's unique index. A count must never roll the booking
    // state backwards.
    try {
      // A25: this was read-modify-write. Two bookings that read the same value
      // both wrote value+1, so two dispatches showed as one. The increment
      // happens inside the database now.
      await rpc("nvsh_count_booked", { p_shop: shop });
    } catch (e) {
      console.error("counter update failed (booking stands)", orderId, e);
    }

    // Shopify is NOT told the order shipped here. An AWB is a booking
    // reference -- it means a merchant asked for a pickup, not that a parcel
    // exists in NovaX's hands. fulfillmentCreate emails the buyer a tracking
    // number, so fulfilling at booking tells a buyer their parcel is on its way
    // before anything has moved, and a cancelled-before-pickup booking makes
    // that a lie we cannot take back.
    //
    // The nvsh_fulfill_on_handover trigger flips fulfill_state to 'ready' the
    // first time the parcel leaves 'New booked' into a NovaX-held status.
    // /fulfill drains that queue.
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 400);
    await update("nvsh_order", where, { status: "failed", error: msg, updated_at: new Date().toISOString() });
    await logEvent(shop, "orders_create", null, false, `${orderId}: ${msg}`);
  }
}

async function handleOrdersCancelled(v: Verified): Promise<Response> {
  const order = JSON.parse(v.body) as ShopifyOrder;
  // Before pickup the parcel has not moved and is cancelled outright. After
  // pickup a rider is carrying it, so nothing here touches the parcel: it
  // becomes a recall request on the operations queue. Silently voiding a
  // shipment that is already on a bike is how a courier loses a box.
  const res = await rpc<Array<{ ok: boolean; outcome: string; message: string }>>(
    "nvsh_cancel_or_recall", { p_shop: v.shop, p_order_id: String(order.id) },
  );
  const r = Array.isArray(res) ? res[0] : res;
  await logEvent(v.shop, "orders/cancelled", v.webhookId, true,
    `${order.id}: ${r?.outcome ?? "none"} — ${r?.message ?? ""}`);
  return text("ok");
}

async function handleUninstalled(v: Verified): Promise<Response> {
  await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(v.shop)}`, {
    status: "uninstalled",
    access_token: null, // the token is dead the moment they uninstall
    uninstalled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return text("ok");
}

// ------------------------------------------------------ compliance ----------
// Mandatory for every App Store app. Each must verify the HMAC, 401 on failure,
// 2xx on success, and complete within 30 days.

async function handleCustomersDataRequest(v: Verified): Promise<Response> {
  // A22: this used to write 500 characters of the payload into an event log and
  // return 200. Answering the HMAC is not answering the request -- Shopify
  // allows 30 days, and nothing recorded a deadline, an owner or a completion,
  // so no one could have told whether a request had been fulfilled. It goes on
  // a queue with a due date now, and an overdue one reaches operations.
  const payload = JSON.parse(v.body) as {
    customer?: { id?: number | string };
    orders_requested?: Array<number | string>;
  };
  await rpc("nvsh_privacy_log", {
    p_shop: v.shop,
    p_kind: "customers/data_request",
    p_customer: payload.customer?.id != null ? String(payload.customer.id) : null,
    p_orders: (payload.orders_requested ?? []).map(String),
    p_payload: payload,
  });
  await logEvent(v.shop, "customers/data_request", v.webhookId, true, "queued for export, due in 30 days");
  return text("ok");
}

async function handleCustomersRedact(v: Verified): Promise<Response> {
  const payload = JSON.parse(v.body) as { customer?: { id?: number }; orders_to_redact?: number[] };
  const ids = (payload.orders_to_redact ?? []).map(String);

  // Drop our copy of the Shopify payload, which is the only place we hold this
  // customer's raw Shopify data. The parcel itself is a commercial delivery
  // record and is retained under the retention policy, not deleted on request.
  for (const id of ids) {
    await update(
      "nvsh_order",
      `shop_domain=eq.${encodeURIComponent(v.shop)}&shopify_order_id=eq.${encodeURIComponent(id)}`,
      { payload: null, updated_at: new Date().toISOString() },
    );
  }
  await rpc("nvsh_privacy_log", {
    p_shop: v.shop, p_kind: "customers/redact",
    p_customer: payload.customer?.id != null ? String(payload.customer.id) : null,
    p_orders: ids, p_payload: payload,
  });
  await logEvent(v.shop, "customers/redact", v.webhookId, true, `redacted payloads for ${ids.length} order(s)`);
  return text("ok");
}

async function handleShopRedact(v: Verified): Promise<Response> {
  await update("nvsh_order", `shop_domain=eq.${encodeURIComponent(v.shop)}`,
    { payload: null, updated_at: new Date().toISOString() });
  await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(v.shop)}`,
    { access_token: null, status: "uninstalled", updated_at: new Date().toISOString() });
  await rpc("nvsh_privacy_log", {
    p_shop: v.shop, p_kind: "shop/redact", p_customer: null, p_orders: [], p_payload: {},
  });
  // B27: the privacy queue itself held data for this shop and shop/redact never
  // cleared it.
  await rpc("nvsh_privacy_purge_shop", { p_shop: v.shop });
  await logEvent(v.shop, "shop/redact", v.webhookId, true, "shop data cleared");
  return text("ok");
}

// ----------------------------------------------------------- fulfilment -----
// Runs a minute after handover, not at booking. Separated so that a Shopify
// outage delays a tracking email and nothing else: the parcel is already
// moving, and the row stays 'ready' until it succeeds or gives up.

interface FulfillRow {
  shop_domain: string;
  shopify_order_id: string;
  awb: string | null;
  extra_awbs: string[] | null;
  fulfill_attempts: number;
}

async function handleFulfill(req: Request): Promise<Response> {
  if (!DRAIN_SECRET || req.headers.get("X-NovaX-Drain") !== DRAIN_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  // B05: this was a SELECT that checked the lease followed by a PATCH that did
  // not, so two workers that both read a row both "won" it. One SQL statement
  // with FOR UPDATE SKIP LOCKED, and an owner token.
  const worker = crypto.randomUUID();
  // F15: 25 rows shared one three-minute lease and were processed serially, so
  // the last rows could be past their lease before their turn came. Smaller
  // batches, and the tick runs every minute anyway.
  const rows = await rpc<FulfillRow[]>("nvsh_claim_fulfill", { p_worker: worker, p_limit: 8 }) ?? [];

  let done = 0, failed = 0;
  for (const r of rows) {
    const where = `shop_domain=eq.${encodeURIComponent(r.shop_domain)}` +
      `&shopify_order_id=eq.${encodeURIComponent(r.shopify_order_id)}`;
    const now = new Date().toISOString();

    const shopRow = await getShop(r.shop_domain);
    if (!shopRow?.access_token) {
      // Uninstalled between handover and here. There is nothing to fulfil and
      // no token to do it with, so stop retrying rather than burn attempts.
      await update("nvsh_order", where, {
        fulfill_state: "failed", fulfill_error: "store uninstalled", updated_at: now,
      });
      failed++;
      continue;
    }

    // A16: pushTracking throws on 401/403, and the throw used to escape the
    // loop -- the endpoint answered 500, no row's attempts moved, and the rows
    // behind the bad one were never tried. One merchant with a revoked token
    // starved everybody else, forever, because the poison row was always first.
    let pushed: Awaited<ReturnType<typeof pushTracking>>;
    try {
      // A44 + B15: every box that has ACTUALLY been handed over, not every box
      // that exists. Sending a box still sitting at the merchant tells the buyer
      // it shipped.
      const candidates = [r.awb!, ...(r.extra_awbs ?? [])].filter(Boolean);
      // F02: this caught a failed custody read as an empty array and then fell
      // back to the primary AWB -- so a database error became "tell the buyer it
      // shipped". Custody has to be READ, not assumed. Fail closed and retry.
      let inCustody: Array<{ awb: string; status: string }>;
      try {
        inCustody = await selectMany<{ awb: string; status: string }>(
          "parcels",
          `awb=in.(${candidates.map(encodeURIComponent).join(",")})&select=awb,status`,
        );
      } catch (err) {
        await update("nvsh_order", where, {
          fulfill_attempts: (r.fulfill_attempts ?? 0) + 1,
          fulfill_error: "could not confirm the parcel is with a rider; not notifying the buyer yet",
          fulfill_leased_until: null, updated_at: now,
        });
        failed++;
        continue;
      }
      const moving = new Set(["Collected by rider", "Arrived at warehouse", "Parcel now in transit",
        "Parcel received at destination", "Parcel out for delivery", "Delivered"]);
      const allAwbs = inCustody.filter((p) => moving.has(p.status)).map((p) => p.awb);
      if (!allAwbs.length) {
        // Cancelled, recalled, or never collected. Nothing shipped.
        await update("nvsh_order", where, {
          fulfill_state: "none", fulfill_leased_until: null,
          fulfill_error: "no parcel on this order is with a rider", updated_at: now,
        });
        failed++;
        continue;
      }
      pushed = await pushTracking(
        r.shop_domain, shopRow.access_token, r.shopify_order_id,
        allAwbs, allAwbs.map(trackingUrl),
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        // The install is dead. Mark the shop, stop retrying its rows, and move
        // on to the next merchant rather than failing the whole batch.
        await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(r.shop_domain)}`, {
          last_error: "Shopify rejected our access token — the merchant must reinstall",
          last_error_at: now, updated_at: now,
        });
        await update("nvsh_order", where, {
          fulfill_state: "failed",
          fulfill_error: "Shopify access was revoked. Reinstall the NovaX app to resume tracking sync.",
          updated_at: now,
        });
        failed++;
        continue;
      }
      pushed = { ok: false, detail: String((err as Error).message).slice(0, 200) };
    }

    if (pushed.ok) {
      // F15: the completion PATCH did not name the lease holder, so a worker
      // whose lease had expired could overwrite a newer worker's result.
      await update("nvsh_order", `${where}&fulfill_lease_owner=eq.${encodeURIComponent(worker)}`, {
        fulfill_state: "done", fulfilled_at: now, fulfill_error: null,
        fulfill_leased_until: null, fulfill_lease_owner: null,
        shopify_fulfillment_ids: pushed.fulfillmentIds ?? null,
        updated_at: now,
      });
      done++;
    } else {
      const attempts = (r.fulfill_attempts ?? 0) + 1;
      await update("nvsh_order", `${where}&fulfill_lease_owner=eq.${encodeURIComponent(worker)}`, {
        // After twelve tries a human should look, and the merchant sees it as
        // a sync failure rather than a silent gap. Retry is offered in the app.
        fulfill_state: attempts >= 12 ? "failed" : "ready",
        fulfill_attempts: attempts,
        fulfill_error: pushed.detail ?? "unknown",
        fulfill_leased_until: null, fulfill_lease_owner: null,
        updated_at: now,
      });
      await logEvent(r.shop_domain, "fulfillment", null, false,
        `${r.shopify_order_id}: ${pushed.detail} (attempt ${attempts})`);
      failed++;
    }
  }

  return json({ scanned: rows.length, fulfilled: done, failed });
}

// --------------------------------------------------------------- drain ------
// Retries orders left in received/failed - a stuck order is a parcel that never
// went out, so it needs a way back that does not involve the merchant noticing.
async function handleDrain(req: Request): Promise<Response> {
  if (!DRAIN_SECRET || req.headers.get("X-NovaX-Drain") !== DRAIN_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  // A26: this took the first 25 rows by insertion order with no attempt count,
  // no backoff and no cap, so a permanently broken order was picked first every
  // single minute and newer orders behind it never ran. Rows now carry an
  // attempt count and a next-attempt time, and a row that has failed 8 times
  // stops being retried and becomes visible instead.
  const nowIso = new Date().toISOString();
  const rows = await selectMany<{
    shop_domain: string; shopify_order_id: string; payload: ShopifyOrder | null; attempts: number | null;
  }>(
    "nvsh_order",
    `status=in.(received,failed)&attempts=lt.8` +
    `&or=(next_attempt_at.is.null,next_attempt_at.lte.${encodeURIComponent(nowIso)})` +
    `&select=shop_domain,shopify_order_id,payload,attempts` +
    `&order=next_attempt_at.asc.nullsfirst,received_at.asc&limit=25`,
  );

  let done = 0;
  for (const r of rows) {
    if (!r.payload) continue;
    const attempts = (r.attempts ?? 0) + 1;
    // Exponential-ish backoff, capped at an hour, written BEFORE the attempt so
    // a crash mid-processing still pushes the next try out.
    const delayMs = Math.min(60, 2 ** attempts) * 60_000;
    await update("nvsh_order",
      `shop_domain=eq.${encodeURIComponent(r.shop_domain)}&shopify_order_id=eq.${encodeURIComponent(r.shopify_order_id)}`,
      { attempts, next_attempt_at: new Date(Date.now() + delayMs).toISOString() });

    await processOrder(r.shop_domain, r.shopify_order_id, r.payload);
    done++;
  }
  return json({ scanned: rows.length, processed: done });
}

// --------------------------------------------------------------- router -----

const WEBHOOKS: Record<string, (v: Verified) => Promise<Response>> = {
  "/webhooks/orders-create": handleOrdersCreate,
  "/webhooks/orders-cancelled": handleOrdersCancelled,
  "/webhooks/app-uninstalled": handleUninstalled,
  "/webhooks/customers-data-request": handleCustomersDataRequest,
  "/webhooks/customers-redact": handleCustomersRedact,
  "/webhooks/shop-redact": handleShopRedact,
};

/** Shopify's documented compliance configuration is a single `uri` covering all
 *  three `compliance_topics`, dispatched on the X-Shopify-Topic header rather
 *  than on the path. The three per-topic paths above stay: they are already
 *  registered on installed shops, and removing a webhook endpoint that Shopify
 *  still holds a URL for turns a compliance delivery into a 404. */
const COMPLIANCE_HANDLERS: Record<string, (v: Verified) => Promise<Response>> = {
  "customers/data_request": handleCustomersDataRequest,
  "customers/redact": handleCustomersRedact,
  "shop/redact": handleShopRedact,
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = route(url.pathname);

  try {
    if (path === "/health") {
      return json({ ok: true, configured: Boolean(API_KEY && API_SECRET && APP_URL) });
    }
    if (path === "/install" || path === "/") return await handleInstall(url);
    if (path === "/callback") return await handleCallback(url);
    if (path === "/app") return handleApp(url);
    if (path === "/api/state" || path === "/state") return await handleState(req);
    if (path === "/api/link") return await handleLink(req);
    if (path === "/api/settings") return await handleSettings(req);
    if (path === "/api/order/decide") return await handleDecide(req);
    if (path === "/api/order/cancel") return await handleCancel(req);
    if (path === "/api/order/split") return await handleSplit(req);
    if (path === "/api/order/resync") return await handleResync(req);
    if (path === "/api/order/recheck") return await handleRecheck(req);
    if (path === "/api/approve-all") return await handleApproveAll(req);
    if (path === "/api/quote") return await handleQuote(req);
    if (path === "/api/pickup") return await handlePickup(req);
    if (path === "/api/ticket") return await handleTicket(req);
    if (path === "/api/reconcile" || path === "/reconcile") return await handleReconcile(req);
    if (path === "/drain") return await handleDrain(req);
    if (path === "/fulfill") return await handleFulfill(req);

    if (path === "/webhooks/compliance") {
      if (req.method !== "POST") return text("method not allowed", 405);
      const topic = (req.headers.get("X-Shopify-Topic") ?? "").trim().toLowerCase();

      // Verify the signature BEFORE looking at the topic. Shopify requires 401
      // for a bad HMAC, and checking the topic first would answer an unsigned
      // request with a 400 that reveals which topics we accept.
      const v = await verifiedWebhook(req, topic);
      if (v instanceof Response) return v;

      const complianceHandler = COMPLIANCE_HANDLERS[topic];
      if (!complianceHandler) return text("unsupported compliance topic", 400);
      if (await claimWebhook(v.shop, v.topic, v.webhookId) === "done") {
        return text("ok (duplicate)");
      }
      const cres = await complianceHandler(v);
      if (cres.status < 300) await completeWebhook(v.webhookId);
      return cres;
    }

    const handler = WEBHOOKS[path];
    if (handler) {
      if (req.method !== "POST") return text("method not allowed", 405);
      const v = await verifiedWebhook(req, path.replace("/webhooks/", ""));
      if (v instanceof Response) return v;

      // A delivery that FINISHED is acknowledged without redoing it. One that
      // was received and never finished is run again -- the old code treated
      // both the same, so a handler that failed once was never retried.
      // A claim failure that is not a key conflict throws, and the catch below
      // answers 500 so Shopify retries rather than losing the event.
      if (await claimWebhook(v.shop, v.topic, v.webhookId) === "done") {
        return text("ok (duplicate)");
      }

      const res = await handler(v);
      if (res.status < 300) await completeWebhook(v.webhookId);
      return res;
    }

    return text("not found", 404);
  } catch (err) {
    console.error("unhandled", path, err);
    // 500 makes Shopify retry, which is right for a transient fault.
    return text("internal error", 500);
  }
});
