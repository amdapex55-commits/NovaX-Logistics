import crypto from "node:crypto";
import { verifyOAuthHmac, verifyWebhookHmac, verifySessionToken, cleanShop, safeEqual }
  from "../verify.ts";

const SECRET = "shpss_test_secret_0123456789abcdef";
const APIKEY = "test_api_key_abcdef";
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", name); } };

// ---- OAuth HMAC, cross-checked against node:crypto (independent impl) ------
{
  const params = { code: "abc123", shop: "novax-dev.myshopify.com", state: "nonce1", timestamp: "1756200000" };
  const msg = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const good = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

  const u = new URL("https://x/callback?" + new URLSearchParams({ ...params, hmac: good }));
  t("oauth: valid hmac accepted", await verifyOAuthHmac(u, SECRET));

  const bad = new URL("https://x/callback?" + new URLSearchParams({ ...params, hmac: good.replace(/.$/, "0") }));
  t("oauth: tampered hmac rejected", !(await verifyOAuthHmac(bad, SECRET)));

  const swapped = new URL("https://x/callback?" + new URLSearchParams({ ...params, shop: "evil.myshopify.com", hmac: good }));
  t("oauth: tampered shop rejected", !(await verifyOAuthHmac(swapped, SECRET)));

  const none = new URL("https://x/callback?" + new URLSearchParams(params));
  t("oauth: missing hmac rejected", !(await verifyOAuthHmac(none, SECRET)));

  // order must not matter: Shopify does not promise a param order
  const rev = new URL("https://x/callback?" + new URLSearchParams({ timestamp: params.timestamp, state: params.state, shop: params.shop, code: params.code, hmac: good }));
  t("oauth: param order irrelevant", await verifyOAuthHmac(rev, SECRET));

  t("oauth: wrong secret rejected", !(await verifyOAuthHmac(u, SECRET + "x")));
}

// ---- Webhook HMAC over the RAW body ---------------------------------------
{
  const body = JSON.stringify({ id: 123, total_price: "1400.00", name: "#1043" });
  const raw = new TextEncoder().encode(body);
  const good = crypto.createHmac("sha256", SECRET).update(Buffer.from(raw)).digest("base64");

  t("webhook: valid hmac accepted", await verifyWebhookHmac(raw, good, SECRET));
  t("webhook: missing header rejected", !(await verifyWebhookHmac(raw, null, SECRET)));
  t("webhook: wrong secret rejected", !(await verifyWebhookHmac(raw, good, "other")));

  const tampered = new TextEncoder().encode(body.replace("1400", "1"));
  t("webhook: tampered body rejected", !(await verifyWebhookHmac(tampered, good, SECRET)));

  // re-serialised JSON must fail -- proves we are checking bytes, not meaning
  const reser = new TextEncoder().encode(JSON.stringify(JSON.parse(body), null, 2));
  t("webhook: re-serialised body rejected", !(await verifyWebhookHmac(reser, good, SECRET)));
}

// ---- Session token --------------------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mint = (payload, header = { alg: "HS256", typ: "JWT" }, secret = SECRET) => {
  const h = b64u(header), p = b64u(payload);
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
};
{
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: "https://novax-dev.myshopify.com/admin", dest: "https://novax-dev.myshopify.com",
                 aud: APIKEY, sub: "42", exp: now + 60, nbf: now - 10, iat: now - 10 };

  const ok = await verifySessionToken(mint(base), APIKEY, SECRET);
  t("session: valid token accepted", ok && ok.shop === "novax-dev.myshopify.com" && ok.userId === "42");

  t("session: alg none rejected",
    null === await verifySessionToken(
      `${b64u({ alg: "none", typ: "JWT" })}.${b64u(base)}.`, APIKEY, SECRET));

  t("session: wrong aud rejected",
    null === await verifySessionToken(mint({ ...base, aud: "someone_else" }), APIKEY, SECRET));

  t("session: expired rejected",
    null === await verifySessionToken(mint({ ...base, exp: now - 3600 }), APIKEY, SECRET));

  t("session: future nbf rejected",
    null === await verifySessionToken(mint({ ...base, nbf: now + 3600 }), APIKEY, SECRET));

  t("session: forged signature rejected",
    null === await verifySessionToken(mint(base, undefined, "wrong_secret"), APIKEY, SECRET));

  t("session: non-myshopify dest rejected",
    null === await verifySessionToken(mint({ ...base, dest: "https://evil.com" }), APIKEY, SECRET));

  t("session: garbage rejected", null === await verifySessionToken("not.a.jwt", APIKEY, SECRET));
  t("session: empty rejected", null === await verifySessionToken("", APIKEY, SECRET));
}

// ---- shop domain validation (SSRF surface) --------------------------------
{
  t("shop: normal accepted", cleanShop("novax-dev.myshopify.com") === "novax-dev.myshopify.com");
  t("shop: uppercase normalised", cleanShop("NovaX-Dev.MyShopify.com") === "novax-dev.myshopify.com");
  for (const bad of ["evil.com", "shop.myshopify.com.evil.com", "a.myshopify.com/../x",
                     "http://x.myshopify.com", "x.myshopify.com:443", "", null, undefined,
                     "-bad.myshopify.com", "a b.myshopify.com", "x".repeat(200) + ".myshopify.com"]) {
    t(`shop: rejected ${JSON.stringify(bad)}`, cleanShop(bad) === null);
  }
}

// ---- constant-time compare ------------------------------------------------
t("safeEqual: equal", safeEqual("abc", "abc"));
t("safeEqual: differing", !safeEqual("abc", "abd"));
t("safeEqual: length mismatch", !safeEqual("abc", "abcd"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
