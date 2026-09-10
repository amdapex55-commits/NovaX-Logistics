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
import { pushTracking, registerWebhooks } from "./shopify-api.ts";
import { mapOrderToBooking, type ShopifyOrder } from "./orders.ts";
import {
  claimWebhook, getShop, insert, logEvent, logProtectedAccess, rpc, selectOne, update,
} from "./db.ts";
import { embeddedApp, frameAncestors } from "./ui.ts";

const API_KEY = Deno.env.get("SHOPIFY_API_KEY") ?? "";
const API_SECRET = Deno.env.get("SHOPIFY_API_SECRET") ?? "";
const APP_URL = (Deno.env.get("SHOPIFY_APP_URL") ?? "").replace(/\/+$/, "");
const SCOPES = Deno.env.get("SHOPIFY_SCOPES") ??
  "read_orders,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,write_fulfillments";
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
  const row = await selectOne<{ state: string; shop_domain: string; used_at: string | null }>(
    "nvsh_oauth_state",
    `state=eq.${encodeURIComponent(state)}&select=state,shop_domain,used_at`,
  );
  if (!row || row.used_at || row.shop_domain !== shop) {
    await logEvent(shop, "oauth", null, false, "bad or reused state");
    return text("invalid state", 401);
  }
  await update("nvsh_oauth_state", `state=eq.${encodeURIComponent(state)}`, { used_at: new Date().toISOString() });

  const code = url.searchParams.get("code");
  if (!code) return text("missing code", 400);

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
      status: existing.client_id ? "active" : "pending_link",
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

async function handleState(req: Request): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = await verifySessionToken(token, API_KEY, API_SECRET);
  if (!session) return json({ error: "unauthorized" }, 401);

  const [shopRows, orders, wallet] = await Promise.all([
    rpc<Array<Record<string, unknown>>>("nvsh_shop_state", { p_shop: session.shop }),
    rpc<Array<Record<string, unknown>>>("nvsh_recent_orders", { p_shop: session.shop, p_limit: 20 }),
    rpc<Array<Record<string, unknown>>>("nvsh_wallet_summary", { p_shop: session.shop }),
  ]);

  return json({
    shop: shopRows?.[0] ?? null,
    orders: orders ?? [],
    wallet: wallet?.[0] ?? null,
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

async function handleOrdersCreate(v: Verified): Promise<Response> {
  const order = JSON.parse(v.body) as ShopifyOrder;
  const orderId = String(order.id);

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

    const mapped = mapOrderToBooking(order);
    if (mapped.action === "skip") {
      await update("nvsh_order", where, {
        status: "skipped", skip_reason: mapped.reason, error: mapped.reason,
        client_id: shopRow.client_id, updated_at: now,
      });
      return;
    }

    const b = mapped.booking;

    // Level 2 protected customer data. Logged at the one point it is read.
    await logProtectedAccess(shop, "book_courier_shipment",
      ["shipping_address.name", "shipping_address.address1", "shipping_address.city", "phone"],
      `shopify_order:${orderId}`);

    const parcel = await rpc<{ awb: string } | Array<{ awb: string }>>("nvsh_book_parcel", {
      p_shop: shop,
      p_consignee: b.consignee,
      p_phone: b.phone,
      p_city: b.city,
      p_address: b.address,
      p_cod: b.cod,
      p_weight: b.weight,
      p_service: b.service,
      p_category: b.category,
      p_fragile: b.fragile,
      p_payment_mode: b.paymentMode,
      p_order_id: b.orderId,
      p_reference_no: b.referenceNo,
    });

    const awb = Array.isArray(parcel) ? parcel[0]?.awb : parcel?.awb;
    if (!awb) throw new Error("booking returned no AWB");

    await update("nvsh_order", where, {
      status: "booked", awb, cod_amount: b.cod, client_id: shopRow.client_id,
      booked_at: now, updated_at: now, error: null,
    });
    await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(shop)}`, {
      last_order_at: now, orders_booked: (shopRow.orders_booked ?? 0) + 1, updated_at: now,
    });

    // Push the AWB back as tracking. A failure here does NOT undo the booking:
    // the parcel is real and the rider is coming. It is recorded so the
    // merchant is told their customer has not been notified yet.
    if (shopRow.access_token) {
      const pushed = await pushTracking(shop, shopRow.access_token, orderId, awb, trackingUrl(awb));
      if (!pushed.ok) {
        await update("nvsh_order", where, {
          error: `booked as ${awb}, but Shopify was not marked fulfilled: ${pushed.detail}`,
          updated_at: new Date().toISOString(),
        });
        await logEvent(shop, "fulfillment", null, false, `${orderId}: ${pushed.detail}`);
      }
    }
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 400);
    await update("nvsh_order", where, { status: "failed", error: msg, updated_at: new Date().toISOString() });
    await logEvent(shop, "orders_create", null, false, `${orderId}: ${msg}`);
  }
}

async function handleOrdersCancelled(v: Verified): Promise<Response> {
  const order = JSON.parse(v.body) as ShopifyOrder;
  // Deliberately does not cancel the NovaX parcel. By the time Shopify says
  // cancelled the parcel may already be with a rider, and silently voiding a
  // real shipment is worse than a flag someone reads. Ops decides.
  await update(
    "nvsh_order",
    `shop_domain=eq.${encodeURIComponent(v.shop)}&shopify_order_id=eq.${encodeURIComponent(String(order.id))}`,
    { error: "cancelled in Shopify after booking — check whether the parcel should be recalled", updated_at: new Date().toISOString() },
  );
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
  // NovaX stores the consignee's name, address and phone on the parcel, because
  // a courier cannot deliver without them. Fulfilling this is a manual export
  // by ops within the 30 day window; recording it is what makes that possible.
  await logEvent(v.shop, "customers/data_request", v.webhookId, true, v.body.slice(0, 500));
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
  await logEvent(v.shop, "customers/redact", v.webhookId, true, `redacted payloads for ${ids.length} order(s)`);
  return text("ok");
}

async function handleShopRedact(v: Verified): Promise<Response> {
  await update("nvsh_order", `shop_domain=eq.${encodeURIComponent(v.shop)}`,
    { payload: null, updated_at: new Date().toISOString() });
  await update("nvsh_shop", `shop_domain=eq.${encodeURIComponent(v.shop)}`,
    { access_token: null, status: "uninstalled", updated_at: new Date().toISOString() });
  await logEvent(v.shop, "shop/redact", v.webhookId, true, "shop data cleared");
  return text("ok");
}

// --------------------------------------------------------------- drain ------
// Retries orders left in received/failed - a stuck order is a parcel that never
// went out, so it needs a way back that does not involve the merchant noticing.
async function handleDrain(req: Request): Promise<Response> {
  if (!DRAIN_SECRET || req.headers.get("X-NovaX-Drain") !== DRAIN_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  const rows = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/nvsh_order?status=in.(received,failed)&select=shop_domain,shopify_order_id,payload&limit=25`,
    { headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}` } },
  ).then((r) => r.json()) as Array<{ shop_domain: string; shopify_order_id: string; payload: ShopifyOrder | null }>;

  let done = 0;
  for (const r of rows) {
    if (!r.payload) continue;
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
    if (path === "/drain") return await handleDrain(req);

    const handler = WEBHOOKS[path];
    if (handler) {
      if (req.method !== "POST") return text("method not allowed", 405);
      const v = await verifiedWebhook(req, path.replace("/webhooks/", ""));
      if (v instanceof Response) return v;

      // A repeat delivery of something already handled is acknowledged, not
      // redone. Shopify retries aggressively and at-least-once is its promise,
      // not exactly-once.
      if (!await claimWebhook(v.shop, v.topic, v.webhookId)) return text("ok (duplicate)");

      return await handler(v);
    }

    return text("not found", 404);
  } catch (err) {
    console.error("unhandled", path, err);
    // 500 makes Shopify retry, which is right for a transient fault.
    return text("internal error", 500);
  }
});
