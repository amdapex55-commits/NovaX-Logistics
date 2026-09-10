// ---------------------------------------------------------------------------
// Every trust decision this app makes lives in this file.
//
// Three separate things arrive claiming to be from Shopify and each is proven
// differently:
//   * OAuth redirects  -> hex HMAC over the sorted query string
//   * Webhooks         -> base64 HMAC over the RAW request body
//   * Embedded UI calls -> a JWT session token signed with the app secret
//
// Getting any of these wrong means anyone on the internet can book parcels on a
// merchant's account, so nothing below takes a shortcut.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(secret: string, message: Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Constant time. A plain === leaks how many leading characters matched, which
// over enough requests is enough to reconstruct a signature one byte at a time.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A shop domain is used to build outbound URLs, so an unvalidated one is an
// SSRF hole: "evil.com" would send the merchant's token to evil.com. Only ever
// accept the exact myshopify.com shape.
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function cleanShop(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const shop = String(raw).trim().toLowerCase();
  if (shop.length > 100) return null;
  return SHOP_RE.test(shop) ? shop : null;
}

// --------------------------------------------------------------- OAuth ------
// Shopify signs the redirect query string. Drop hmac and the legacy signature,
// sort what is left by key, join as k=v&k=v, and the digest must match.
export async function verifyOAuthHmac(
  url: URL,
  secret: string,
): Promise<boolean> {
  const given = url.searchParams.get("hmac");
  if (!given) return false;

  const parts: string[] = [];
  for (const [k, v] of url.searchParams) {
    if (k === "hmac" || k === "signature") continue;
    parts.push(`${k}=${v}`);
  }
  parts.sort();

  const digest = toHex(await hmac(secret, enc.encode(parts.join("&"))));
  return safeEqual(digest, given.toLowerCase());
}

// ------------------------------------------------------------- webhooks -----
// The signature covers the bytes Shopify sent. Re-serialising parsed JSON
// changes key order and whitespace and will not match, so the caller must pass
// the raw body and parse it only after this returns true.
export async function verifyWebhookHmac(
  rawBody: Uint8Array,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const digest = toBase64(await hmac(secret, rawBody));
  return safeEqual(digest, header);
}

// -------------------------------------------------------- session token -----
// App Bridge hands the browser a short-lived JWT. It proves which shop and
// which user is calling, without a cookie -- which matters because the app runs
// in an iframe where third-party cookies are unreliable or blocked outright.

export interface SessionToken {
  shop: string;
  userId: string | null;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifySessionToken(
  token: string,
  apiKey: string,
  secret: string,
): Promise<SessionToken | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [rawHeader, rawPayload, rawSig] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  } catch {
    return null;
  }

  // Pin the algorithm. Accepting whatever the token names is the classic JWT
  // hole -- "alg":"none" would let anyone mint a token for any shop.
  if (header.alg !== "HS256") return null;

  const expected = toBase64(
    await hmac(secret, enc.encode(`${rawHeader}.${rawPayload}`)),
  ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (!safeEqual(expected, rawSig)) return null;

  const now = Math.floor(Date.now() / 1000);
  const leeway = 10; // clock skew between Shopify and this worker

  if (typeof payload.exp !== "number" || payload.exp + leeway < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf - leeway > now) return null;

  // aud must be OUR api key: a valid token issued for a different app is still
  // a valid signature if the secret were ever shared, and this closes that.
  if (payload.aud !== apiKey) return null;

  // dest is the shop the token was minted for, as https://x.myshopify.com
  const dest = typeof payload.dest === "string" ? payload.dest : "";
  const shop = cleanShop(dest.replace(/^https?:\/\//, ""));
  if (!shop) return null;

  // sub is the Shopify staff user id, absent for offline/background contexts.
  const userId = typeof payload.sub === "string" ? payload.sub : null;

  return { shop, userId };
}
