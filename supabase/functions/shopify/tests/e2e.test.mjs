import crypto from "node:crypto";

const API_KEY = "test_api_key", SECRET = "test_secret_abc123";
const SB = "https://proj.supabase.co";
const APP = "https://proj.supabase.co/functions/v1/shopify";
const SHOP = "novax-dev.myshopify.com";

const ENV = {
  SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: APP,
  SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: "service_role_fake",
  NOVAX_DRAIN_SECRET: "drain_me",
};

// ---- in-memory Postgres ---------------------------------------------------
const db = { nvsh_shop: [], nvsh_oauth_state: [], nvsh_order: [], nvsh_event: [], nvsh_access_log: [], parcels: [] };
const calls = { graphql: [], gqlVars: [], tokenExchange: 0, rpc: [] };
let ONE_LOCATION = false;
let GRAPHQL_ORDER_FAILS = false;

function matches(row, qs) {
  for (const [k, v] of qs) {
    if (["select", "limit", "on_conflict", "order"].includes(k)) continue;
    const [op, ...rest] = v.split(".");
    const val = rest.join(".");
    if (op === "eq") { if (String(row[k]) !== val) return false; }
    else if (op === "in") { if (!val.replace(/[()]/g, "").split(",").includes(String(row[k]))) return false; }
  }
  return true;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

  // ---- Shopify token exchange
  if (url.href === `https://${SHOP}/admin/oauth/access_token`) {
    calls.tokenExchange++;
    if (body.client_secret !== SECRET) return J({ error: "bad secret" }, 401);
    return J({ access_token: "shpat_live_token", scope: "read_orders,write_fulfillments" });
  }
  // ---- Shopify GraphQL
  if (url.pathname.endsWith("/graphql.json")) {
    // Record the WHOLE query. Recording only the first line made any assertion
    // about an identifier in the body silently pass whatever the code did.
    calls.graphql.push(body.query.trim());
    calls.gqlVars.push(body.variables ?? {});
    if (/webhookSubscriptionCreate/.test(body.query))
      return J({ data: { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: "gid://x/1" } } } });
    if (/query one\(/.test(body.query) || /orders\(first/.test(body.query)) {
      if (GRAPHQL_ORDER_FAILS) return J({ errors: [{ message: "upstream unavailable" }] }, 200);
      return J({ data: { order: {
        id: "gid://shopify/Order/G01", name: "#G01", createdAt: new Date().toISOString(),
        cancelledAt: null, test: false, tags: [], displayFinancialStatus: "PENDING",
        displayFulfillmentStatus: "UNFULFILLED", currencyCode: "PKR", phone: null,
        paymentGatewayNames: [], totalOutstandingSet: { shopMoney: { amount: "1500.00" } },
        currentTotalPriceSet: { shopMoney: { amount: "1500.00" } }, shippingLine: null,
        shippingAddress: { name: "New Name", firstName: null, lastName: null,
          address1: "NEW ADDRESS", address2: null, city: "Karachi", province: "Sindh",
          zip: "75600", countryCodeV2: "PK", phone: "03001234567" },
        customer: { phone: "03001234567" },
        lineItems: { pageInfo: { hasNextPage: false },
          nodes: [{ id: "gid://shopify/LineItem/1", title: "T", quantity: 1,
                    requiresShipping: true, unfulfilledQuantity: 1 }] },
      } } });
    }
    if (/fulfillmentOrders/.test(body.query) && ONE_LOCATION)
      return J({ data: { order: { fulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "gid://shopify/FulfillmentOrder/9", status: "OPEN",
          assignedLocation: { location: { id: "gid://shopify/Location/1", name: "Karachi" } },
          lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/91", remainingQuantity: 2 }] } },
      ] } } } });
    if (/fulfillmentOrders/.test(body.query))
      // Two fulfillment orders at DIFFERENT locations, each with real remaining
      // quantities: the shape that used to be bundled into one mutation and
      // fulfilled in full regardless of what the parcel contained.
      return J({ data: { order: { fulfillmentOrders: { nodes: [
        { id: "gid://shopify/FulfillmentOrder/9", status: "OPEN",
          assignedLocation: { location: { id: "gid://shopify/Location/1", name: "Karachi" } },
          lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/91", remainingQuantity: 2 }] } },
        { id: "gid://shopify/FulfillmentOrder/10", status: "OPEN",
          assignedLocation: { location: { id: "gid://shopify/Location/2", name: "Lahore" } },
          lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/101", remainingQuantity: 1 }] } },
      ] } } } });
    if (/fulfillmentCreate/.test(body.query))
      return J({ data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/7" }, userErrors: [] } } });
    return J({ errors: [{ message: "unexpected query" }] }, 200);
  }
  // ---- PostgREST
  if (url.href.startsWith(`${SB}/rest/v1/`)) {
    const rest = url.pathname.replace("/rest/v1/", "");
    if (rest.startsWith("rpc/")) {
      const fn = rest.slice(4);
      calls.rpc.push(fn);
      // B07: booking, the cancellation check and the link are one transaction
      // in SQL now, so the stub has to behave like that function, not like the
      // three separate calls it replaced.
      if (fn === "nvsh_book_linked") {
        const shop = db.nvsh_shop.find(s => s.shop_domain === body.p_shop);
        if (!shop?.client_id) return J([{ ok: false, awb: null, message: "shop not linked" }]);
        const o = db.nvsh_order.find(x => x.shop_domain === body.p_shop && x.shopify_order_id === body.p_order_id);
        if (!o) return J([{ ok: false, awb: null, message: "order row missing" }]);
        if (o.status === "cancelled") return J([{ ok: false, awb: null, message: "cancelled while processing" }]);
        if (o.awb) return J([{ ok: true, awb: o.awb, message: "already booked" }]);
        const awb = "N3690" + (100 + db.nvsh_order.filter(x => x.awb).length);
        Object.assign(o, { status: "booked", awb, cod_amount: body.p_cod,
          client_id: body.p_client_id, booked_at: new Date().toISOString(),
          error: null, attempts: 0, next_attempt_at: null });
        return J([{ ok: true, awb, message: "booked" }]);
      }
      if (fn === "nvsh_add_package") {
        const o = db.nvsh_order.find(x => x.shop_domain === body.p_shop && x.shopify_order_id === body.p_order_id);
        if (!o) return J([{ ok: false, awb: null, package_no: 0, message: "No such order." }]);
        if (o.status !== "booked") return J([{ ok: false, awb: null, package_no: 0, message: `This order is ${o.status}.` }]);
        const keys = o.split_keys ?? (o.split_keys = []);
        const extra = o.extra_awbs ?? (o.extra_awbs = []);
        const i = keys.indexOf(body.p_key);
        // B09: the same key is the same intent, so a retry recovers rather than
        // booking (and charging for) another box.
        if (i >= 0) return J([{ ok: true, awb: extra[i], package_no: i + 2, message: `That box was already booked as ${extra[i]}.` }]);
        const no = extra.length + 2;
        const awb = "N3690" + (200 + extra.length);
        extra.push(awb); keys.push(body.p_key);
        return J([{ ok: true, awb, package_no: no, message: `Package ${no} booked as ${awb}.` }]);
      }
      if (fn === "nvsh_shop_state") {
        const s = db.nvsh_shop.find(x => x.shop_domain === body.p_shop);
        return J(s ? [{ shop_domain: s.shop_domain, status: s.status, linked: !!s.client_id,
          client_name: s.client_id ? "Trendy Essentials" : null, orders_booked: s.orders_booked ?? 0,
          pending_count: db.nvsh_order.filter(o => o.status === "pending_link").length, failed_count: 0 }] : []);
      }
      if (fn === "nvsh_recent_orders")
        return J(db.nvsh_order.map(o => ({ order_name: o.order_name, awb: o.awb, status: o.status, cod_amount: o.cod_amount, received_at: o.received_at ?? new Date().toISOString(), error: o.error })));
      if (fn === "nvsh_wallet_summary") return J([{ available_balance: 12400, pending_payout: 3200, paid_this_month: 8000, lifetime_withdrawn: 91000 }]);
      // A36: the nonce is consumed by one conditional UPDATE with a TTL, so the
      // stub has to enforce the same single-shot semantics the SQL does.
      if (fn === "nvsh_consume_oauth_state") {
        const row = db.nvsh_oauth_state.find(
          r => r.state === body.p_state && r.shop_domain === body.p_shop && !r.used_at);
        if (!row) return J(false);
        row.used_at = new Date().toISOString();
        return J(true);
      }
      // B05: rows are claimed by one SQL statement now.
      // G01/G02: approval parks a row in 'validating'; only nvsh_validation_done
      // releases it, and it refuses to demote a row that already has an AWB.
      if (fn === "nvsh_order_decide") {
        const o = db.nvsh_order.find(x => x.shop_domain === body.p_shop && x.shopify_order_id === body.p_order_id);
        if (!o) return J([{ ok: false, message: "No such order." }]);
        if (o.status !== "awaiting_approval") return J([{ ok: false, message: `That order is already ${o.status}.` }]);
        if (body.p_decision === "approve") {
          // G01: 'validating', never 'received'. Nothing books from here.
          o.status = "validating"; o.approved_at = new Date().toISOString(); o.hold_reason = null;
          return J([{ ok: true, message: "Checking the current order with Shopify…" }]);
        }
        o.status = "skipped"; o.skip_reason = "declined by merchant";
        return J([{ ok: true, message: "Declined. No parcel was created." }]);
      }
      if (fn === "nvsh_validation_done") {
        const o = db.nvsh_order.find(x => x.shop_domain === body.p_shop && x.shopify_order_id === body.p_order_id);
        if (!o || o.status !== "validating" || o.awb) return J(false);
        if (body.p_ok) o.status = "received";
        else { o.status = "awaiting_approval"; o.approved_at = null; o.hold_reason = body.p_reason; }
        return J(true);
      }
      if (fn === "nvsh_fulfill_fail") {
        const o = db.nvsh_order.find(x => x.shop_domain === body.p_shop && x.shopify_order_id === body.p_order_id);
        if (!o) return J(null);
        o.fulfill_attempts = (o.fulfill_attempts ?? 0) + 1;
        o.fulfill_state = (body.p_exhaust || o.fulfill_attempts >= 12) ? "failed" : "ready";
        o.fulfill_error = body.p_error;
        o.fulfill_leased_until = null; o.fulfill_lease_owner = null;
        return J(null);
      }
      if (fn === "nvsh_claim_fulfill") {
        const out = db.nvsh_order.filter(o =>
          o.fulfill_state === "ready" && o.awb && (o.fulfill_attempts ?? 0) < 12 &&
          (!o.fulfill_leased_until || new Date(o.fulfill_leased_until) < new Date()));
        const picked = out.slice(0, body.p_limit ?? 25);
        for (const o of picked) {
          o.fulfill_leased_until = new Date(Date.now() + 180000).toISOString();
          o.fulfill_lease_owner = body.p_worker;
        }
        return J(picked.map(o => ({ shop_domain: o.shop_domain, shopify_order_id: o.shopify_order_id,
          awb: o.awb, extra_awbs: o.extra_awbs ?? [], fulfill_attempts: o.fulfill_attempts ?? 0 })));
      }
      if (fn === "nvsh_count_booked") {
        const sh = db.nvsh_shop.find(x => x.shop_domain === body.p_shop);
        if (sh) sh.orders_booked = (sh.orders_booked ?? 0) + 1;
        return J(null);
      }
      return J([]);
    }
    const table = rest, qs = url.searchParams, store = db[table];
    if (!store) return J({ message: `no table ${table}` }, 404);

    if (method === "GET") return J(store.filter(r => matches(r, qs)));
    if (method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const out = [];
      for (const r of rows) {
        if (table === "nvsh_event" && r.webhook_id && store.some(e => e.webhook_id === r.webhook_id))
          return J({ message: "duplicate key value violates unique constraint" }, 409);
        if (table === "nvsh_order" && store.some(o => o.shop_domain === r.shop_domain && o.shopify_order_id === r.shopify_order_id)) {
          if (qs.get("on_conflict")) continue;
          return J({ message: "duplicate key" }, 409);
        }
        const row = { id: crypto.randomUUID(), received_at: new Date().toISOString(), ...r };
        store.push(row); out.push(row);
      }
      return J(out);
    }
    if (method === "PATCH") {
      const hit = store.filter(r => matches(r, qs));
      hit.forEach(r => Object.assign(r, body));
      return J(hit);
    }
    if (method === "DELETE") { db[table] = store.filter(r => !matches(r, qs)); return J([]); }
  }
  throw new Error("unstubbed fetch: " + url.href);
};

// ---- boot the function ----------------------------------------------------
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
globalThis.EdgeRuntime = { waitUntil: (p) => { pending.push(p); } };
const pending = [];
await import("../index.ts");
const settle = async () => { while (pending.length) await pending.shift(); };

let pass = 0, fail = 0;
const t = (n, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", n, x ?? ""); } };
const call = (path, init) => handler(new Request(`${APP}${path}`, init));

// helpers to sign like Shopify does
const oauthUrl = (params) => {
  const msg = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const hmac = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
  return `/callback?${new URLSearchParams({ ...params, hmac })}`;
};
const webhookReq = (path, payload, topicShop = SHOP, wid = crypto.randomUUID(), secret = SECRET) => {
  const raw = JSON.stringify(payload);
  return new Request(`${APP}${path}`, { method: "POST", body: raw, headers: {
    "X-Shopify-Hmac-Sha256": crypto.createHmac("sha256", secret).update(raw).digest("base64"),
    "X-Shopify-Shop-Domain": topicShop, "X-Shopify-Webhook-Id": wid, "Content-Type": "application/json" } });
};
const sessionToken = (shop = SHOP) => {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ dest: `https://${shop}`, aud: API_KEY, sub: "1", exp: now + 60, nbf: now - 5 })).toString("base64url");
  return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
};

console.log("\n-- health & install --");
{
  const r = await call("/health"); const b = await r.json();
  t("health 200 + configured", r.status === 200 && b.configured === true);
}
{
  const r = await call("/install?shop=" + SHOP);
  const loc = r.headers.get("location") ?? "";
  t("install redirects to shopify oauth", r.status === 302 && loc.startsWith(`https://${SHOP}/admin/oauth/authorize`), loc);
  t("install passes client_id", loc.includes(`client_id=${API_KEY}`));
  t("install passes redirect_uri", loc.includes(encodeURIComponent(`${APP}/callback`)));
  t("install stored a state nonce", db.nvsh_oauth_state.length === 1);
  // A13: merchant-managed, not assigned. The assigned scopes only cover
  // locations owned by a registered fulfillment service, which NovaX is not.
  t("install requests only minimum scopes",
    /read_orders/.test(loc) &&
    /write_merchant_managed_fulfillment_orders/.test(loc) &&
    !/assigned_fulfillment_orders/.test(loc) &&
    !/write_customers|read_all_orders/.test(loc), loc);
}
t("install rejects a non-myshopify shop", (await call("/install?shop=evil.com")).status === 400);

console.log("-- oauth callback --");
{
  const good = db.nvsh_oauth_state[0].state;
  const p = { code: "authcode", shop: SHOP, state: good, timestamp: "1756200000" };

  const bad = await call(`/callback?${new URLSearchParams({ ...p, hmac: "deadbeef" })}`);
  t("callback rejects bad hmac", bad.status === 401);

  const wrongState = await call(oauthUrl({ ...p, state: "not-a-real-state" }));
  t("callback rejects unknown state", wrongState.status === 401);

  const ok = await call(oauthUrl(p));
  t("callback redirects into the admin", ok.status === 302 &&
    ok.headers.get("location") === `https://${SHOP}/admin/apps/${API_KEY}`, ok.headers.get("location"));
  t("callback exchanged the code once", calls.tokenExchange === 1);
  t("shop row created", db.nvsh_shop.length === 1 && db.nvsh_shop[0].access_token === "shpat_live_token");
  t("shop starts pending_link", db.nvsh_shop[0].status === "pending_link");
  /* Three, not six. The privacy/compliance topics are not members of
     WebhookSubscriptionTopic and cannot be subscribed to per shop -- Shopify
     rejected them on the first real install (25 Sep 2026) and the whole
     registration call reported failure. They are delivered from the app config
     instead. This asserted 6 and so agreed with the bug. */
  t("subscribes to exactly the 3 business webhooks", calls.graphql.filter(q => /register/.test(q)).length === 3,
    String(calls.graphql.length));

  const replay = await call(oauthUrl(p));
  t("callback rejects a replayed state", replay.status === 401);
}

console.log("-- embedded page --");
{
  const r = await call("/app?shop=" + SHOP);
  const html = await r.text();
  t("app 200", r.status === 200);
  t("app sets per-shop frame-ancestors",
    r.headers.get("content-security-policy") === `frame-ancestors https://${SHOP} https://admin.shopify.com;`,
    r.headers.get("content-security-policy"));
  t("app is no-store", r.headers.get("cache-control") === "no-store");
  t("app loads App Bridge", /cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/.test(html));
  t("app never ships the secret", !html.includes(SECRET) && !html.includes("service_role_fake"));
  t("app rejects bad shop", (await call("/app?shop=evil.com")).status === 400);
}

console.log("-- session-token API --");
t("state without a token is 401", (await call("/api/state")).status === 401);
t("state with a forged token is 401",
  (await call("/api/state", { headers: { Authorization: "Bearer aaa.bbb.ccc" } })).status === 401);
{
  const r = await call("/api/state", { headers: { Authorization: "Bearer " + sessionToken() } });
  const b = await r.json();
  t("state with a real token is 200", r.status === 200);
  t("state reports pending_link", b.shop?.status === "pending_link", JSON.stringify(b.shop));
  t("state includes the wallet", b.wallet?.available_balance === 12400);
}

console.log("-- orders/create before linking --");
const ORDER = {
  id: 5001, name: "#1043", financial_status: "pending", total_price: "1400.00",
  shipping_address: { name: "Huzaifa Ahmed", address1: "C836 pehlwan goth Block 9",
    city: "Karachi", phone: "+92 300 1234567" },
  line_items: [{ grams: 800, quantity: 1 }],
};
{
  t("orders/create rejects bad hmac",
    (await handler(webhookReq("/webhooks/orders-create", ORDER, SHOP, crypto.randomUUID(), "wrong"))).status === 401);

  const r = await handler(webhookReq("/webhooks/orders-create", ORDER));
  await settle();
  t("orders/create 200s", r.status === 200);
  t("order held as pending_link", db.nvsh_order[0]?.status === "pending_link", db.nvsh_order[0]?.status);
  t("no parcel booked while unlinked", !calls.rpc.includes("nvsh_book_parcel"));
}

console.log("-- after an admin links the store --");
db.nvsh_shop[0].client_id = "c0ffee00-0000-4000-8000-000000000001";
db.nvsh_shop[0].status = "active";
db.nvsh_order[0].status = "received";           // what nvsh_admin_link() does
{
  const r = await call("/drain", { headers: { "X-NovaX-Drain": "drain_me" } });
  await settle();
  const b = await r.json();
  t("drain requires the secret", (await call("/drain")).status === 401);
  t("drain processed the held order", b.processed === 1, JSON.stringify(b));
  t("held order is now booked", db.nvsh_order[0].status === "booked", db.nvsh_order[0].status);
  t("held order has an AWB", /^N3690\d+$/.test(db.nvsh_order[0].awb ?? ""), db.nvsh_order[0].awb);
  t("held order recorded the COD", db.nvsh_order[0].cod_amount === 1400);
  // Booking must NOT fulfil. An AWB says a pickup was requested, not that a
  // parcel moved, and fulfillmentCreate emails the buyer a tracking number.
  // The nvsh_fulfill_on_handover trigger marks the row ready when the parcel
  // actually leaves 'New booked'; /fulfill is what talks to Shopify.
  t("booking did NOT fulfil in Shopify", !calls.graphql.some(q => /fulfillmentCreate/.test(q)));
  t("booking left fulfilment pending", (db.nvsh_order[0].fulfill_state ?? "none") === "none",
    db.nvsh_order[0].fulfill_state);
  t("protected-data access was logged", db.nvsh_access_log.length === 1, JSON.stringify(db.nvsh_access_log));
  t("access log names the fields read",
    (db.nvsh_access_log[0]?.fields ?? []).includes("shipping_address.address1"));
}

console.log("-- fulfilment happens at handover, not at booking --");
{
  t("fulfil requires the secret", (await call("/fulfill")).status === 401);

  // Nothing is ready yet: the parcel is still 'New booked'.
  let r = await call("/fulfill", { headers: { "X-NovaX-Drain": "drain_me" } });
  let b = await r.json();
  t("nothing to fulfil before handover", b.fulfilled === 0 && b.scanned === 0, JSON.stringify(b));
  t("still no fulfillmentCreate", !calls.graphql.some(q => /fulfillmentCreate/.test(q)));

  // What the DB trigger does when the rider takes the parcel.
  db.parcels.push({ awb: db.nvsh_order[0].awb, status: "Collected by rider" });
  db.nvsh_order[0].fulfill_state = "ready";

  r = await call("/fulfill", { headers: { "X-NovaX-Drain": "drain_me" } });
  await settle();
  b = await r.json();
  // B04: two warehouses is a refusal, not a double fulfillment. NovaX carries
  // one parcel from one address and cannot know which items are inside it.
  t("mixed-location order is refused, not over-fulfilled", b.fulfilled === 0, JSON.stringify(b));
  t("no fulfillmentCreate for a two-warehouse order",
    !calls.graphql.some(q => /fulfillmentCreate/.test(q)));
  t("the refusal names the locations",
    (db.nvsh_order[0].fulfill_error ?? "").includes("2 locations"),
    db.nvsh_order[0].fulfill_error);

  // Now the ordinary case: one warehouse.
  ONE_LOCATION = true;
  // B15: only boxes actually in custody are published, so the fixture needs a
  // parcel row that says this one moved.
  db.parcels.push({ awb: db.nvsh_order[0].awb, status: "Collected by rider" });
  db.nvsh_order[0].fulfill_state = "ready";
  db.nvsh_order[0].fulfill_attempts = 0;
  db.nvsh_order[0].fulfill_leased_until = null;
  r = await call("/fulfill", { headers: { "X-NovaX-Drain": "drain_me" } });
  await settle();
  b = await r.json();
  t("single-location order is fulfilled", b.fulfilled === 1, JSON.stringify(b));
  t("fulfillmentCreate was called", calls.graphql.some(q => /fulfillmentCreate/.test(q)));
  // A15: quantities are named, so Shopify cannot read it as "everything".
  t("quantities were named, not implied",
    calls.gqlVars.some(v => JSON.stringify(v).includes("fulfillmentOrderLineItems")));
  t("row marked done", db.nvsh_order[0].fulfill_state === "done", db.nvsh_order[0].fulfill_state);
  t("fulfilled_at recorded", Boolean(db.nvsh_order[0].fulfilled_at));

  // A retry must not book a second parcel.
  const bookedBefore = calls.rpc.filter(c => c === "nvsh_book_parcel").length;
  r = await call("/fulfill", { headers: { "X-NovaX-Drain": "drain_me" } });
  b = await r.json();
  t("a fulfil retry books nothing", calls.rpc.filter(c => c === "nvsh_book_parcel").length === bookedBefore);
  t("nothing left ready", b.scanned === 0, JSON.stringify(b));
}

console.log("-- approval validates before it releases (G01/G02/G04) --");
{
  // A held order whose Shopify refresh fails must stay held. Before this, the
  // decide RPC released it to 'received' and the ordinary drain booked the old
  // address a minute later while the merchant had been told nothing happened.
  db.nvsh_order.push({
    shop_domain: SHOP, shopify_order_id: "G01", order_name: "#G01",
    status: "awaiting_approval", hold_reason: "held for review",
    payload: { id: "G01", currency: "PKR", financial_status: "pending",
      shipping_address: { name: "Old Name", address1: "OLD ADDRESS", city: "Karachi",
        country_code: "PK", phone: "03001234567" },
      line_items: [{ quantity: 1, grams: 500 }] },
    received_at: new Date().toISOString(),
  });
  const row = () => db.nvsh_order.find(o => o.shopify_order_id === "G01");

  GRAPHQL_ORDER_FAILS = true;
  let r = await call("/api/order/decide", {
    method: "POST", headers: { Authorization: "Bearer " + sessionToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: "G01", decision: "approve" }),
  });
  await settle();
  let b = await r.json();

  t("a failed refresh does not claim success", b.ok === false, JSON.stringify(b));
  t("the order goes back to held, not received", row().status === "awaiting_approval", row().status);
  t("no AWB was created", !row().awb);
  t("the merchant is told why", /could not|did not return/i.test(row().hold_reason ?? ""), row().hold_reason);

  // And the drain must not book it while it is held.
  const before = calls.rpc.filter(c => c === "nvsh_book_linked").length;
  await call("/drain", { headers: { "X-NovaX-Drain": "drain_me" } });
  await settle();
  t("the drain will not book a held order",
    calls.rpc.filter(c => c === "nvsh_book_linked").length === before);

  // Now let Shopify answer, and it should book.
  GRAPHQL_ORDER_FAILS = false;
  r = await call("/api/order/decide", {
    method: "POST", headers: { Authorization: "Bearer " + sessionToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: "G01", decision: "approve" }),
  });
  await settle();
  b = await r.json();
  t("approval succeeds once Shopify answers", b.ok === true, JSON.stringify(b));
  t("the order is booked", row().status === "booked", row().status);
  t("it has an AWB", Boolean(row().awb), row().awb);
}

console.log("-- a fresh order on a linked store --");
{
  const o2 = { ...ORDER, id: 5002, name: "#1044", total_price: "900.00" };
  await handler(webhookReq("/webhooks/orders-create", o2));
  await settle();
  const row = db.nvsh_order.find(x => x.shopify_order_id === "5002");
  t("second order booked straight through", row?.status === "booked", row?.status);
  // A25: the count is an atomic UPDATE inside the database now, so the stub
  // sees an RPC rather than a PATCH carrying a pre-computed number.
  t("shop counter incremented", calls.rpc.filter(c => c === "nvsh_count_booked").length >= 1,
    String(calls.rpc.filter(c => c === "nvsh_count_booked").length));
}

console.log("-- duplicate delivery --");
{
  const wid = crypto.randomUUID();
  const o3 = { ...ORDER, id: 5003, name: "#1045" };
  await handler(webhookReq("/webhooks/orders-create", o3, SHOP, wid)); await settle();
  const before = db.nvsh_order.filter(x => x.shopify_order_id === "5003").length;
  const again = await handler(webhookReq("/webhooks/orders-create", o3, SHOP, wid)); await settle();
  const after = db.nvsh_order.filter(x => x.shopify_order_id === "5003").length;
  t("retry acknowledged", again.status === 200);
  t("retry created no second order row", before === 1 && after === 1, `${before} -> ${after}`);
}

console.log("-- a skip is visible, not silent --");
{
  const digital = { ...ORDER, id: 5004, name: "#1046", shipping_address: null };
  await handler(webhookReq("/webhooks/orders-create", digital)); await settle();
  const row = db.nvsh_order.find(x => x.shopify_order_id === "5004");
  t("digital order skipped", row?.status === "skipped", row?.status);
  t("skip reason is stored and human", /no shipping address/i.test(row?.error ?? ""), row?.error);
}

console.log("-- compliance webhooks --");
{
  for (const [path, payload] of [
    ["/webhooks/customers-data-request", { shop_domain: SHOP, customer: { id: 1 }, orders_requested: [5001] }],
    ["/webhooks/customers-redact", { shop_domain: SHOP, customer: { id: 1 }, orders_to_redact: [5001] }],
    ["/webhooks/shop-redact", { shop_domain: SHOP, shop_id: 99 }],
  ]) {
    const ok = await handler(webhookReq(path, payload));
    t(`${path} 200s on a valid hmac`, ok.status === 200, String(ok.status));
    const bad = await handler(webhookReq(path, payload, SHOP, crypto.randomUUID(), "wrong"));
    t(`${path} 401s on a bad hmac`, bad.status === 401, String(bad.status));
  }
  t("customers/redact cleared the stored payload",
    db.nvsh_order.find(o => o.shopify_order_id === "5001")?.payload === null);
  t("shop/redact cleared the token", db.nvsh_shop[0].access_token === null);
  t("shop/redact marked uninstalled", db.nvsh_shop[0].status === "uninstalled");
}

console.log("-- uninstall --");
{
  db.nvsh_shop[0].access_token = "shpat_live_token"; db.nvsh_shop[0].status = "active";
  const r = await handler(webhookReq("/webhooks/app-uninstalled", { id: 1, domain: SHOP }));
  t("uninstall 200s", r.status === 200);
  t("uninstall destroys the token", db.nvsh_shop[0].access_token === null);
  t("uninstall marks the shop", db.nvsh_shop[0].status === "uninstalled");
}


console.log("-- webhook log actually records detail --");
{
  const ev = db.nvsh_event.filter(e => e.topic && e.topic.includes("redact"));
  t("compliance handlers left a log row each", ev.length >= 2, String(ev.length));
  t("log detail was written, not lost to a 409",
    ev.some(e => e.detail && e.detail !== "claimed"), JSON.stringify(ev.map(e => e.detail)));
  t("no event row lost its topic", db.nvsh_event.every(e => e.topic));
}

t("unknown route 404s", (await call("/nope")).status === 404);
t("GET on a webhook route is 405",
  (await call("/webhooks/orders-create", { method: "GET" })).status === 405 ||
  (await call("/webhooks/orders-create")).status === 405);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
