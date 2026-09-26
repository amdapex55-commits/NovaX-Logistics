// ---------------------------------------------------------------------------
// novaxlogistics.com/shopify/*  ->  Supabase edge function `shopify`
//
// Why this exists: the shared *.supabase.co functions domain rewrites HTML
// responses. Measured 25 Sep 2026:
//
//   /shopify/health  (JSON) -> application/json                     preserved
//   /shopify/app     (HTML) -> text/plain  +  an injected
//                              `content-security-policy: default-src 'none';
//                               sandbox` header
//
// The function itself returns `text/html; charset=utf-8` and a per-shop
// `frame-ancestors` CSP at handleApp(). The gateway overwrites both, so the
// merchant sees raw source and App Bridge can never boot (default-src 'none'
// blocks the CDN script, and `sandbox` blocks script execution outright).
//
// This Worker sits on our own hostname, where nothing rewrites anything, and:
//   - passes method, headers and the RAW body straight through
//     (webhook HMAC is computed over raw bytes - never re-serialise)
//   - does NOT follow redirects (the OAuth 302 must reach the browser)
//   - on the embedded-app route only, restores the HTML content type and the
//     per-shop frame-ancestors CSP
//
// Everything else - /install, /callback, /webhooks/*, /api/state - is a byte
// -for-byte pass-through. index.ts route() strips both `/functions/v1` and
// `/shopify`, so paths map across with no rewriting.
// ---------------------------------------------------------------------------

const UPSTREAM = "https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/shopify";

/** Hop-by-hop and Cloudflare-added headers that must not be forwarded. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "content-length", // set by fetch from the actual body
]);

/** Headers the Supabase gateway injects that we replace on HTML routes. */
const DROP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options", // DENY here would beat frame-ancestors in older browsers
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

/** Shop domains Shopify can legitimately embed us from. */
function isShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

function frameAncestors(shop) {
  return isShopDomain(shop)
    ? `frame-ancestors https://${shop.toLowerCase()} https://admin.shopify.com;`
    : "frame-ancestors https://admin.shopify.com;";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // /shopify           -> upstream /
    // /shopify/app?x=1   -> upstream /app?x=1
    const path = url.pathname.replace(/^\/shopify/, "").replace(/\/+$/, "") || "/";
    const target = UPSTREAM + path + url.search;

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    }
    // The function is deployed --no-verify-jwt, but the gateway still wants to
    // see the route as an invocation rather than a bare asset fetch.
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");

    // GET/HEAD must not carry a body; everything else forwards the raw stream.
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual", // OAuth 302s belong to the browser, not to us
      });
    } catch (err) {
      return new Response(
        `Upstream unreachable: ${err && err.message ? err.message : String(err)}`,
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    const out = new Headers(upstream.headers);

    // The embedded app page is the one route the gateway breaks. Scope the
    // rewrite to it: labelling any other route's body as HTML would be a lie,
    // and /  is a 404 from the function, not the app.
    if (path === "/app") {
      for (const h of DROP_RESPONSE_HEADERS) out.delete(h);
      out.set("Content-Type", "text/html; charset=utf-8");
      out.set("Content-Security-Policy", frameAncestors(url.searchParams.get("shop") || ""));
      out.set("Cache-Control", "no-store");
      out.set("X-Content-Type-Options", "nosniff");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};
