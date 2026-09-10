# NovaX Shopify app

Replaces the pasted-token integration. A merchant clicks **Install**, approves
the permission list, and is done — no API token to copy, no webhook URL to
paste. That is the whole reason this exists.

Built from scratch; it shares nothing with `shopify_connections` /
`shopify-order-intake`, which keep working until every merchant has moved.

## What it does

1. Merchant installs → OAuth → we store an access token and register webhooks.
2. Store lands in `pending_link`. An admin links it to a NovaX merchant.
   Orders arriving before that are **held, not dropped**.
3. `orders/create` → booked with NovaX → AWB pushed back to Shopify as the
   tracking number, customer notified.
4. Embedded page inside Shopify admin shows connection health, recent orders
   with a plain-English reason for anything not booked, and the COD wallet.

## Files

| file | what it holds |
|---|---|
| `index.ts` | router, OAuth, webhook handlers, order processing |
| `verify.ts` | **every trust decision** — OAuth HMAC, webhook HMAC, session tokens, shop-domain validation |
| `orders.ts` | Shopify order → NovaX booking. Pure functions. |
| `shopify-api.ts` | GraphQL Admin API client, webhook registration, fulfillment |
| `db.ts` | PostgREST access with the service role |
| `ui.ts` | the embedded admin page |
| `tests/` | 155 assertions across 3 suites |

## Tests

```
node scripts/test-shopify.mjs
```

No dependencies. `verify.test.mjs` cross-checks the crypto against
`node:crypto` as an independent implementation; `e2e.test.mjs` boots the real
router against a fake Shopify and a fake Postgres and drives a full install →
link → book → uninstall cycle.

## Deploy

Run the SQL first, in this order:

1. `sql_novax_shopify_app.sql` — tables and functions
2. `sql_novax_shopify_booking_core.sql` — shared booking core.
   **Replaces a live money function.** It aborts by itself if production has
   drifted from `backend/admin.sql`.

Then set the secrets:

```
supabase secrets set \
  SHOPIFY_API_KEY=... \
  SHOPIFY_API_SECRET=... \
  SHOPIFY_APP_URL=https://<project>.supabase.co/functions/v1/shopify \
  NOVAX_DRAIN_SECRET=$(openssl rand -hex 24)
```

Then deploy — **`--no-verify-jwt` is mandatory**:

```
supabase functions deploy shopify --no-verify-jwt
```

Without that flag Supabase demands an anon key on every request. Shopify does
not send one, so OAuth and all six webhooks get a 401 before reaching any of
this code.

`SHOPIFY_SCOPES` defaults to the four we need and should not be widened:
Shopify grants protected customer data only when it is the minimum required,
and unapproved fields come back **silently redacted** rather than erroring.

## Partner Dashboard settings

- **App URL**: `https://<project>.supabase.co/functions/v1/shopify/app`
- **Allowed redirection URL**: `https://<project>.supabase.co/functions/v1/shopify/callback`
- **Embedded**: yes
- Start on **custom distribution** — no review, and protected customer data
  levels 1–2 are granted automatically.

## Routes

| route | auth |
|---|---|
| `GET /install?shop=` | none (starts OAuth) |
| `GET /callback` | OAuth HMAC + single-use state nonce |
| `GET /app?shop=` | none (page holds no data; sets per-shop CSP) |
| `GET /api/state` | session token |
| `POST /webhooks/*` | webhook HMAC, 401 on failure |
| `POST /drain` | `X-NovaX-Drain` secret |
| `GET /health` | none |

## Known unverified detail

`fulfillmentCreate` is called with the argument named `fulfillment:`. Shopify's
reference page shows `input:` in its example while the schema names it
`fulfillment:`. **Confirm on the first dev-store fulfillment.** A wrong name
fails loudly with "unknown argument" — it cannot fail silently or mis-book.

## API version

`2026-07`, accessible until 16 July 2027. An app cannot be submitted while its
API version is within 90 days of removal. Bump it and re-run the tests each
quarter — letting this lapse is exactly what left the official TCS app at 2.4
stars with merchants reporting it stopped fulfilling orders.
