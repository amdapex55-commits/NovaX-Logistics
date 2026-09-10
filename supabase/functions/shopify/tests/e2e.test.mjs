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
const db = { nvsh_shop: [], nvsh_oauth_state: [], nvsh_order: [], nvsh_event: [], nvsh_access_log: [] };
const calls = { graphql: [], tokenExchange: 0, rpc: [] };

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
    calls.graphql.push(body.query.trim().split("\n")[0].trim());
    if (/webhookSubscriptionCreate/.test(body.query))
      return J({ data: { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: "gid://x/1" } } } });
    if (/fulfillmentOrders/.test(body.query))
      return J({ data: { order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/9", status: "OPEN" }] } } } });
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
      if (fn === "nvsh_book_parcel") {
        const shop = db.nvsh_shop.find(s => s.shop_domain === body.p_shop);
        if (!shop?.client_id) return J({ message: "not linked" }, 400);
        return J([{ awb: "N3690" + (100 + db.nvsh_order.filter(o => o.awb).length) }]);
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
  t("install requests only minimum scopes",
    /read_orders/.test(loc) && /write_fulfillments/.test(loc) && !/write_customers|read_all_orders/.test(loc));
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
  t("registered all 6 webhooks", calls.graphql.filter(q => /register/.test(q)).length === 6,
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
  t("tracking pushed to shopify", calls.graphql.some(q => /fulfill/.test(q)));
  t("protected-data access was logged", db.nvsh_access_log.length === 1, JSON.stringify(db.nvsh_access_log));
  t("access log names the fields read",
    (db.nvsh_access_log[0]?.fields ?? []).includes("shipping_address.address1"));
}

console.log("-- a fresh order on a linked store --");
{
  const o2 = { ...ORDER, id: 5002, name: "#1044", total_price: "900.00" };
  await handler(webhookReq("/webhooks/orders-create", o2));
  await settle();
  const row = db.nvsh_order.find(x => x.shopify_order_id === "5002");
  t("second order booked straight through", row?.status === "booked", row?.status);
  t("shop counter incremented", db.nvsh_shop[0].orders_booked >= 1, String(db.nvsh_shop[0].orders_booked));
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
