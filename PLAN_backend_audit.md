# Backend audit — what I could establish, what I cannot, and the fix order

Written 2026-08-24. Plan only; nothing here has been executed.

---

## 1. The finding that matters more than any individual bug

**23 of your money functions have no source anywhere except inside the
deployed database.**

I counted every RPC the four portals call and every function the repo defines:

| | Count |
|---|---|
| Distinct RPCs called by client / admin / rider / tracking | **88** |
| Functions with source in this repo | 40 |
| **Called in production, source exists nowhere but the DB** | **71** |
| Of those, functions that move money or price a parcel | **23** |

The 23 include `client_book_parcel`, `admin_push_invoice_to_wallet`,
`admin_mark_withdrawal_paid`, `request_wallet_withdrawal`,
`client_wallet_summary`, `client_wallet_incoming`, `admin_reconcile_wallet_balances`
and `novax_quote_booking`.

There is no backup, no diff, no review, and no way to restore any of them if
one is dropped or replaced wrongly. Your live `parcels` table carries **14
triggers**; this repo accounts for five of them. This is not a backend that is
"fucked" so much as one that is **invisible**, and invisible is why the same
class of bug keeps reappearing.

Everything else below is downstream of this.

### What the repo itself looks like

I checked, rather than assumed. All 21 SQL files parse clean. Zero duplicate
function definitions. Zero overloaded signatures. Zero duplicate policies.
**The committed SQL is not the problem.** The problem is the 71 functions it
does not contain.

---

## 2. Confirmed defects, found today

| # | Defect | Status |
|---|---|---|
| D1 | Prepaid delivery charges collected twice — once by a wallet trigger at delivery, once inside the invoice. KKM was Rs 520 short on one invoice. | Fix written and tested (`sql_novax_invoice_single_source.sql`), **not applied** |
| D2 | `service_role` JWT stored in cleartext inside two webhook trigger definitions, and pasted into a chat transcript. It bypasses RLS entirely and does not expire until 2036. | **Not rotated** |
| D3 | "Paid to you — lifetime, into your bank" counts *closed invoices*, and `"Pushed to wallet"` is in the closed list. Pushing an invoice reports it as money that reached the merchant's bank. No withdrawal involved. | **Not fixed** |
| D4 | `client_wallet_incoming()` may count `New booked` parcels as money on its way. Body is not in the repo, so unverified. | **Unknown** |
| D5 | `parcels_guard_columns` — a BEFORE UPDATE trigger on `parcels` whose behaviour is unknown. May reject `client_edit_new_booked_parcel`. | **Unknown** |

## 3. Open from the previous audit, still unresolved

- `novax_state` has an `ALL to public USING(true)` policy while holding staff
  PII, reachable with the publishable key that ships in the HTML.
  Fix written (`sql_novax_rls_hardening.sql`), **never applied**.
- `ops_daily_report` ships a placeholder token in cleartext, committed twice,
  on an **anon-callable** function.
- Sequential AWBs are enumerable through a public tokenless RPC — the whole
  parcel table is scrapeable.
- `admin_mark_withdrawal_paid` has never been confirmed to row-lock
  server-side. The double-payout guard is client-side and single-tab.
- `addExpense` writes financial rows through a raw browser insert.
- The `staff` role can read merchant AI conversations.
- Four SQL files sit unapplied, including `sql_novax_flat_200.sql` — every new
  signup still books at Rs 250.

---

## 4. Step one: make the backend visible

`sql_novax_backend_inventory.sql` — read-only, safe on live traffic, moves
nothing. It does the detection **in SQL**, so you paste back a short findings
table instead of 100KB of function bodies. Ten sections, each printing only
what is wrong; a section returning zero rows passed.

1. **Overloaded functions** — the exact fault that took bookings down on
   22 Aug, when `client_book_parcel` had two signatures and PostgREST picked
   the wrong one.
2. **SECURITY DEFINER without a pinned `search_path`** — privilege escalation.
3. **Functions callable by `anon`** — reachable by anyone who views source.
4. **Tables exposed with RLS off or no policies.**
5. **Policies that are a bare `true`** — RLS is permissive, so one of these
   defeats every other policy on the table. This is what `novax_state` has.
6. **Duplicate/overlapping policies** — how a permissive rule survives the
   restrictive one meant to replace it.
7. **Trigger load per table** — two triggers writing the same derived value is
   precisely how D1 happened.
8. **Webhook triggers carrying secrets** — with the Bearer value redacted in
   the output, so it is safe to paste.
9. **SECURITY DEFINER views** — bypass the caller's RLS.
10. **Full function inventory** — names, signatures, volatility, who can call
    each one. No bodies.

I tested every section against a local PostgreSQL 16 that I deliberately broke
with all nine faults. All nine were detected, and the token redaction works.

**Output of section 10, cross-referenced against the 88 RPCs the portals call,
is what turns "my backend is fucked" into a finite list.**

---

## 5. Fix order

Ranked by what can lose money or leak data, not by effort.

### Phase 0 — today, no analysis needed
1. **Rotate the `service_role` key** (D2). Settings → API → Rotate, then
   recreate the two webhook triggers. Everything else can wait; this cannot.
2. **Run `sql_novax_invoice_single_source.sql`** (D1). Written, tested against
   six fixtures, idempotent, and safe to run blind — it refuses to touch any
   client it cannot prove is correctable.

### Phase 1 — get sight of it
3. Run `sql_novax_backend_inventory.sql`, send back all ten sections.
4. I load the results into local PostgreSQL and produce the real defect list:
   every overload, every anon-exposed money function, every table without RLS,
   every duplicate policy, every double-writing trigger pair.

### Phase 2 — close the known holes
5. `sql_novax_rls_hardening.sql` — `novax_state`, and the `fee` freeze.
6. Rotate the `ops_daily_report` token and remove `anon` from it.
7. Resolve D4 and D5 — both need one function body each, which section 10
   will identify by name.
8. `sql_novax_flat_200.sql` — new signups are still priced at Rs 250.

### Phase 3 — stop it happening again
9. **Export every function body into the repo**, one file per domain
   (`wallet.sql`, `booking.sql`, `pricing.sql`, `admin.sql`). This is the
   actual cure. Once the backend is in git it can be diffed, reviewed and
   restored, and a session like this one starts from evidence instead of
   archaeology.
10. Add a standing rule to `PROJECT_HISTORY.md`: **no function is edited in
    the Supabase editor without the new body being committed in the same
    hour.** Every incident in §3 of that file traces back to this.
11. Fix the sequential-AWB enumeration and the `addExpense` raw insert.

---

## 6. What I need from you

Two things, in this order:

1. **Rotate the service_role key.** I cannot do it and it is the highest-risk
   item on the page.
2. **Run `sql_novax_backend_inventory.sql`** and send all ten sections back.
   Section 8 redacts tokens itself, but read it before sending anyway.

Everything in Phase 1 and 2 is blocked on that second one. Phase 0 is not
blocked on anything.
