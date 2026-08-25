# `backend/` — the database, in the repo

Generated from the live database on 2026-08-25. **Do not hand-edit.** Change
the function in Supabase, then re-export so these files stay truthful.

## Why this exists

Until today, 71 of the 88 RPCs the portals call had no source anywhere except
inside the deployed database — including `client_book_parcel`,
`admin_push_invoice_to_wallet`, `admin_mark_withdrawal_paid`,
`request_wallet_withdrawal` and `client_wallet_incoming`. Every one of them
moves money.

That is what made the whole system feel fragile. Not the code — the code is
sound. It was that no question could be answered by reading. *Is per-km
pricing still on? Does the money tab count new bookings? What does that
trigger do?* Each one was an archaeological dig, and twice a fix failed
because a trigger nobody could see was silently undoing it.

| File | Contents |
|---|---|
| `admin.sql` | 42 functions — invoices, payouts, wallet adjustments, processing |
| `client.sql` | 21 functions — booking, wallet, Shopify, notifications |
| `ai.sql` | 20 functions — assistant tools, quota, conversation memory |
| `core.sql` | 31 functions — identity, auth helpers, tracking, misc |
| `tickets.sql` | 13 functions — support tickets, SLA, CSAT |
| `guards.sql` | 12 functions — the BEFORE UPDATE triggers that protect money and contact fields |
| `pricing.sql` | 12 functions — quoting, areas, distance (retired 2026-08-24) |
| `triggers.sql` | 33 trigger definitions |
| `rls_policies.sql` | 105 policies + `ENABLE ROW LEVEL SECURITY` on all 58 tables |

## Secrets

Two webhook triggers embed a `service_role` JWT in their definition. Those are
redacted here as `<REDACTED-SEE-SUPABASE-DASHBOARD>`. **If you re-export, run
the same redaction before committing** — this repo is public and serves
novaxlogistics.com through GitHub Pages.

The raw `backend_dump.sql` is gitignored and must stay that way.

## Re-exporting

```
pg_dump --schema-only -d "postgresql://postgres.<ref>@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres" -f backend_dump.sql
```

Then split and redact. Verify with:

```
grep -ric 'Bearer ey\|eyJhbGciOi\|service_role' backend/*.sql
```

Every count must be zero before committing.

## Read these first

- `guards.sql` → `parcels_guard_columns` and `nv_freeze_parcel_money`. Both
  intercept writes to `parcels`. The first **assigns old values back without
  raising**, so an `update` reports success and changes nothing. See
  PROJECT_HISTORY §3.1b.
- `pricing.sql` → `novax_quote_fee`. Sets every delivery fee. The weight
  surcharge (Rs 85/kg over 1kg, capped at 5kg) lives here, as does the
  `coalesce(v_rate, 250)` fallback.
