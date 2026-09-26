# NovaX Shopify app

Replaces the pasted-token integration. A merchant clicks **Install**, approves
the permission list, and is done — no API token to copy, no webhook URL to
paste. That is the whole reason this exists.

Built from scratch; it shares nothing with `shopify_connections` /
`shopify-order-intake`, which keep working until every merchant has moved.

> [!warning] A75 — the old deploy sequence in this file was wrong
> It pointed at `sql_novax_shopify_booking_core.sql`, which is marked
> **SUPERSEDED — DO NOT RUN**, and predates the proxy, the public app, and eight
> later migrations. A fresh deployment could not be reproduced from it.

## Deploying from scratch

Run the migrations in this order. Every one is idempotent.

| # | File | What it does |
|---|---|---|
| 1 | `sql_novax_shopify_app.sql` | tables, base RPCs |
| 2 | `sql_novax_shopify_fulfillment_timing.sql` | fulfil at handover, drain token, cron |
| 3 | `sql_novax_shopify_parcel_link.sql` | parcel ↔ order link, unique index |
| 4 | `sql_novax_shopify_merchant_control.sql` | connect codes, booking rules, cancel/recall |
| 5 | `sql_novax_shopify_state_reads.sql` | read RPCs for the embedded page |
| 6 | `sql_novax_shopify_everyday_actions.sql` | pickups, tickets, bulk approve, packages |
| 7 | `sql_novax_shopify_a01_revoke_public.sql` | **revokes PUBLIC EXECUTE — do not skip** |
| 8 | `sql_novax_shopify_audit_a02_a10.sql` | cancellation tombstone, reconcile + drain cron |
| 9 | `sql_novax_shopify_audit_a11_a30.sql` | compare-and-set cancel, privacy queue |
| 10 | `sql_novax_shopify_audit_a31_a77.sql` | atomic nonce, link race, pickup amend, GC |
| 11 | `sql_novax_shopify_audit_b01_b30.sql` | **the columns the runtime needs** — webhooks_ok, next_attempt_at, fulfill_leased_until, shopify_fulfillment_ids, split_keys, fulfill_lease_owner, reconcile_cursor, reconciled_at — plus atomic claim, linked booking and package keys |
| 12 | `sql_novax_shopify_ui_v2.sql` | order list with recipient/city/weight/fee, queue counts, fee quote |
| 13 | `sql_novax_shopify_audit_f01_f22.sql` | privacy-completion admin check, JSONB fee extraction, split-key alignment, held-order weight and recipient search |

Migrations 11-13 are **not optional**: the deployed function calls RPCs and
columns that only exist after them. A database built from 1-10 alone will fail
at booking and at fulfillment.

**Never run** `sql_novax_shopify_booking_core.sql`. It is superseded and its
money functions are already live in a different form.

### Secrets

```
SHOPIFY_API_KEY          from `shopify app env show -c novax-public`
SHOPIFY_API_SECRET       same
SHOPIFY_APP_URL          https://novaxlogistics.com/shopify
SHOPIFY_SCOPES           must equal [access_scopes] in shopify.app.novax-public.toml
NOVAX_DRAIN_SECRET       must equal  select public.nvsh_drain_token();
```

The last two are the ones that fail silently. A scope mismatch surfaces only as
a permission error on the first fulfillment; a drain-secret mismatch makes every
scheduled job 401 while cron reports success.

Check both without printing them:

```bash
# scopes agree
curl -sSD- -o /dev/null "https://novaxlogistics.com/shopify/install?shop=<shop>" | grep -i location
# drain secret agrees (expect 200, not 401)
psql "$NOVAX_DB" -At -c "select public.nvsh_drain_token();" \
  | xargs -I{} curl -sS -o /dev/null -w '%{http_code}\n' \
      -X POST https://novaxlogistics.com/shopify/fulfill -H "x-novax-drain: {}"
```

### Deploy

```bash
supabase functions deploy shopify --no-verify-jwt --project-ref rhzunbzbdzicajqtohwp
cd workers/shopify-proxy && npx wrangler deploy
shopify app deploy -c novax-public --allow-updates --no-build
```

The Cloudflare Worker is **not optional**. Without it the embedded page is served
as `text/plain` under `default-src 'none'` and App Bridge cannot boot.

### Scheduled jobs

`novax-shopify-book-drain` (1m) · `novax-shopify-fulfill` (1m) ·
`novax-shopify-reconcile` (15m) · `novax-shopify-privacy-due` (daily) ·
`novax-shopify-gc` (daily). Verify with
`select jobname, schedule from cron.job where jobname like 'novax-shopify%';`

### Rollback boundary

Migrations 1–10 only add columns, indexes and functions — none drops data. The
one-way steps are outside SQL: selecting Public distribution, and changing
scopes (which forces every merchant to re-authorise).
