# NovaX Logistics — project history and handoff

**Read this first if you are an AI assistant picking up work on this repo.**

Last updated: 2026-08-22 · 426 commits · 2026-06-25 → 2026-08-22

This file exists so a fresh session does not have to re-derive the architecture,
re-discover the traps, or re-audit what has already been audited. It records
what was built, what was fixed, what is still broken, and — most importantly —
**the assumptions that have already caused production incidents.**

---

## 1. What this is

A Pakistani COD (cash-on-delivery) courier SaaS. Merchants book parcels, riders
collect cash on delivery, admin reconciles and pays merchants out.

Live at **novaxlogistics.com** (GitHub Pages, `main` branch, auto-deploys on push).

### Architecture

Zero build step. Five standalone HTML files, all JS and CSS inline.

| File | Lines | Who uses it |
|---|---|---|
| `admin.html` | ~18,000 | Ops staff — the console |
| `client.html` | ~14,700 | Merchants — booking, wallet, invoices |
| `index.html` | ~2,600 | Public marketing + sign-in |
| `rider.html` | ~1,300 | Riders in the field, on cheap Android phones |
| `tracking.html` | ~650 | Public parcel tracking, **no login** |

Backend is **Supabase** (Postgres + Auth + RLS + Edge Functions), region
`ap-southeast-2`. Three edge functions under `supabase/functions/`:
`novax-ai`, `novax-ai-support`, `novax-autopilot-brain`.

16 loose `sql_novax_*.sql` files in the repo root. These are **incremental
patches, not a schema**. See the warning in §3.

Other files: `reset.html` (internal "Reset to Zero" ops tool — *not* a password
reset), `new-password.html` (that one *is* password reset), `sw.js`,
`nv3d-hero.js`, `nv-codegen.js`, `index-v2.html` / `index-a-terminal.html`
(alternate landing pages).

---

## 2. Timeline

### Phase 1 — Build (25 Jun – 10 Aug, 331 commits)
The whole product. Portals, admin navigation, orders, manifests, ticket hub,
finance/wallet/invoices, merchant signup, Supabase live sync, Shopify and
WooCommerce integrations, public tracking, barcode scanning, print labels,
bulk booking. Commit messages in this phase are mostly `Update admin.html` —
they are not useful for archaeology. Use `git log -S"someString"` instead.

### Phase 2 — Hardening (11 Aug – 20 Aug, 62 commits)
Distance pricing for Karachi. Dark mode across both portals. Command palette.
Blank-overwrite guards on every browser-written table. Review/testimonial
system. Money tab consolidation. Ops daily report. Backend audit diagnostics.
Polling-cost reduction. NovaX AI (grounded LLM assistant + quota approvals).

### Phase 3 — Forensic audit and remediation (21 Aug – 22 Aug, 25 commits)
A full six-pass read-only audit, then remediation. Details in §4 and §5.

---

## 3. Traps — read before you change anything

These have each already cost real time or real money. They are not theoretical.

### 3.1 Most RPC bodies are NOT in this repo
The `sql_novax_*.sql` files are patches. `client_book_parcel`,
`client_book_parcel_geo`, `admin_mark_withdrawal_paid`, `request_wallet_withdrawal`,
`admin_update_parcel_details`, `novax_ticket_open`, `invite_staff_user` and most
other `admin_*` / `client_*` functions exist **only in the deployed database**.

**You cannot verify their behaviour by reading this repo.** Do not assume what
they do. If a change depends on one, ask for `pg_get_functiondef` output first.

### 3.1b Two triggers silently revert writes to `parcels` — no error raised

An `update public.parcels set fee = ...` from the Supabase SQL editor
**reports success and changes nothing.** It cost two failed attempts to find
this on 2026-08-24.

`parcels_guard_columns()` (BEFORE UPDATE, and **not in this repo**) does:

```sql
if public.is_admin() or public.can_process_orders() then return new; end if;
new.awb := old.awb;  new.client_id := old.client_id;  new.rider_id := old.rider_id;
new.consignee := old.consignee;  new.city := old.city;  new.address := old.address;
new.phone := old.phone;  new.cod_amount := old.cod_amount;  new.fee := old.fee;
new.booked_at := old.booked_at;
```

In the SQL editor `auth.uid()` is NULL, so `is_admin()` is false and the guard
restores every one of those columns. It **assigns rather than raises**, so
psql prints `UPDATE 19` and nothing has moved. `nv_freeze_parcel_money` covers
the same ground for `fee`/`cod_amount`/`client_id` but *does* raise, so it is
the one you notice first — fix only that and you get the silent failure.

To change any of those columns as an operator, suspend BOTH inside one
transaction and restore them in the same one:

```sql
begin;
alter table public.parcels disable trigger trg_nv_freeze_parcel_money;
alter table public.parcels disable trigger parcels_guard_columns_trg;
-- ... the update ...
alter table public.parcels enable trigger trg_nv_freeze_parcel_money;
alter table public.parcels enable trigger parcels_guard_columns_trg;
commit;
```

Always verify afterwards that both are back (`tgenabled <> 'D'`). They are what
stop a merchant editing their own fee, COD, address and consignee.

### 3.2 RLS policies for the most sensitive tables are NOT in this repo
`create policy` statements exist here for only six tables (`nv_ai_*`,
`parcel_contact_history`, `reviews`). There is **nothing** for `parcels`,
`clients`, `wallet_ledger`, `withdrawals`, `payment_logs`, `staff_users`,
`profiles`, or `invoices`. Their real policies live only in the Supabase
dashboard. This is an open risk, not a solved problem.

### 3.3 A trigger that guessed at a column took down live bookings
**2026-08-22.** A `BEFORE INSERT` trigger on `parcels` assumed
`parcels.pricing_mode` recorded "was this parcel priced by distance". It does
not — that column pre-dates the migration that added the trigger, and belongs
to an older feature. The trigger refused ordinary, correctly-priced flat
bookings for a real merchant. Client bookings were on hold until it was
dropped by hand in Supabase.

Removed in `6f2e811`. **Do not reinstate a DB-side pricing guard without first
reading the real booking RPC bodies.** The comment block in
`sql_novax_pricing_choice.sql` §5 explains this in full.

### 3.4 The top-level TDZ trap (hit twice)
`cleanStartState()` in both `admin.html` and `client.html` runs at **top level**
on first load. Constants it uses must be declared *above* it, not merely
somewhere in the file. `NV_ZONE_A_BASE` was declared hundreds of lines below
and silently seeded `undefined` as a merchant's rate.

Fixed in `6d08e06` (admin) and again in client.html. If you move a constant,
check whether anything at top level uses it before its new position.

### 3.5 Rate constants drift
The base Zone A rate is **200** (`NV_ZONE_A_BASE`). Historic values 250, 240
and 180 keep reappearing in fallbacks, preview tools, AI canned text, and the
public homepage calculator. Reconciled in `95f53e2`, `9910507`, `94378fb`,
`7092cf1` — and it *still* came back. Grep for `250`/`240`/`180` near anything
rate-shaped before assuming it is clean.

### 3.6 The city dropdown used to default to Lahore
`required` on a `<select>` does nothing when a real option is preselected. A
merchant who never touched the city field booked a Lahore parcel regardless of
the address. This mislabelled real Karachi parcels (`N3690090`). Fixed in
`935b4f3` by adding an empty placeholder option; a mismatch warning was added
at booking time in `c471cae`. **Do not remove those placeholder options.**

### 3.7 `Gulistan-e-Johar` (Karachi) vs `Johar Town` (Lahore)
One word apart, different cities. Any address→city matching must resolve by
earliest position then longest marker, never by list order. Also: real
addresses are misspelt — the actual incident address read `gulstan-e-johar`,
no `i`. See `NV_CITY_MARKERS` in `admin.html` and `NV_CITY_MARKERS_C` in
`client.html`.

---

## 4. The forensic audit (21–22 Aug)

Six independent read-only passes: security/RLS, financial/COD, rider portal,
client+admin workflows, AI/tracking/performance, UI/UX/dead-code.

**Scores at the time of audit** — Security 4, Reliability 3, Financial
integrity 5, Backend 6, Frontend 6, UX 5.5, UI 5.5, Performance 5.5,
**Mobile/rider 2.5**, Completeness 7. Overall **4.8/10**.

The headline finding: the two surfaces carrying the most real-world risk —
`rider.html` and the COD→payout chain — were the weakest, not the strongest.

---

## 5. What has been fixed (21–22 Aug)

All pushed and live unless noted.

### Rider portal
| Commit | Fix |
|---|---|
| `471fc7b` | Auth gate: a network failure is no longer treated as "unauthorized". It used to call `signOut()` — destroying the token that would let them back in — on any timeout. Now retries, then falls back to a 7-day cached verification, then shows a retry screen. **Never signs out on transport failure.** |
| `34dac4e` | Collected COD can no longer vanish. `_codPosted` was set `true` *before* the `cod_ledger` insert, with no retry, and `markLoaded()` re-derived it from parcel status on reload — so a failed write was unrecoverable and invisible. |
| `0d80b8e` | Offline boot keeps the cached route instead of wiping state to empty. |
| `15450ca` | Data reads scoped to the signed-in rider (were unscoped `select("*")` pulling every client's data). |

### Admin
| Commit | Fix |
|---|---|
| `e6a19ac` | "Delete User" actually revokes access. It previously only filtered a local JS array and toasted success — the account stayed live and reappeared on reload. Now `deleteUser` is an alias for `revokeUserAccess`. |
| `258e1a8` | Escaped the XSS sinks (Error Monitor, Exceptions table) and unified on an escaper that handles single quotes. |
| `2ce0428` | Five admin actions no longer report failure for work that already succeeded; added in-flight guards (`nvClaim`/`nvRelease`). |
| `408153c` | Parcel editor: validated city dropdown, address/city mismatch warning, Save disabled on settled parcels. |
| `c4a40a0` | `deleteInvoice` confirms; Cancel-pickup button wired; `deleteClient` now also checks `wallet_ledger`. |
| `f3d60a8` | Read-only merchant AI conversation viewer in the NOVAX AI tab. |

### Client
| Commit | Fix |
|---|---|
| `3a668a6` | Support reply box no longer erases what the merchant is typing every 3 seconds. |
| `1c2290a` | Refusal-history badge fixed — it called a non-existent RPC and had never worked. |
| `c471cae` | Booking-time city/address mismatch warning. |
| `fd4a225` | Reply box on every ticket, with draft preservation across the poll. |

### Cross-cutting
| Commit | Fix |
|---|---|
| `00a8dc1` | Tracking AI: fixed the cross-IIFE scoping bug (it had **never worked**) *and* rate limited the endpoint in the same change. Auto-fire-on-load removed. |
| `16d1460` | AI cost: `FN_URL`/`BRAIN_URL` both pointed at paid Opus. Now routed to the free deterministic engine and free cascade, with a 404 fallback to the old behaviour. |
| `b8f512a` | Password recovery — did not exist for any role. |
| `2719ea0` | `statusClass` parity, tracking currency `₨`→`Rs`, duplicate 15s poll removed, four unbounded queries capped. |
| `bc0d31e`, `dc1aedb` | Merchant-chosen pricing mode (flat vs per-km) with no silent fallback. |

---

## 6. Still open

### Needs a human with database access
- **Deploy the edge function.** The tracking-AI rate limit is committed but
  inert until `supabase functions deploy novax-ai` is run. Until then the
  public tracking AI works but is unmetered.
- **Run `sql_novax_pricing_choice.sql`** if not already applied. Without it
  `clients.pricing_mode` does not exist and the pricing chooser never appears
  (harmless — everything degrades to flat).
- **Export RLS policies** for the eight uncovered tables and commit them (§3.2).
- **Rotate the `ops_daily_report` token.** `sql_novax_ops_daily_report.sql`
  ships a placeholder secret in cleartext, committed twice, on an
  `anon`-callable function.
- **Verify `admin_mark_withdrawal_paid` row-locks server-side.** The
  double-payout guard is currently client-side and single-tab only.
- **Confirm the free AI functions are deployed** — otherwise `16d1460` silently
  falls back to paid Opus.

### Known open issues (not yet fixed)
- **Sequential AWBs** (`N` + 3-digit client code + 4-digit counter) are
  enumerable through a public tokenless RPC. Whole parcel table is scrapeable.
- **Shopify/Woo/Web order-intake** is live in production but its source is
  **not in this repo** — its pricing-mode compliance is unauditable.
- **Prompt injection**: consignee names and exception notes flow unsanitized
  into AI prompts and tool results.
- **`addExpense`** writes financial rows via a raw browser insert, not an RPC.
- **GPS proof-of-delivery is a hardcoded string** in rider.html — no
  Geolocation call exists.
- **`staff` role can read merchant AI conversations** (RLS grant).
- **No design system**: 221 distinct hex values against 71 CSS variables in
  client.html, 21 border-radius values.

---

## 7. Conventions

### Verify before you push
There is no test suite. The working pattern is a regression harness that
checks, for every portal: JS parses, HTML tag balance is unchanged vs the
baseline commit, critical functions still exist, and every `onclick` handler
resolves to a real function. Run it **after every change**, not just at the end.

```bash
# parse check, the minimum
python3 - <<'PY'
import re,subprocess
for f in ['admin.html','client.html','rider.html','tracking.html','index.html']:
    src=open(f,encoding='utf-8').read()
    bl=re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>',src,re.S|re.I)
    bad=0
    for b in bl:
        if b.strip().startswith('{'): continue   # JSON-LD, not JS
        open('/tmp/v.js','w',encoding='utf-8').write(b)
        if subprocess.run(['node','--check','/tmp/v.js'],capture_output=True).returncode: bad+=1
    print(f"{f:15} {len(bl):2} blocks, {bad} failures")
PY
```

Two false positives that harness will produce, so you do not chase them:
- `onclick="if(...)"` looks like a call to a function named `if`.
- A literal `<script>` inside a JS *comment* inflates the tag count. (Only
  `</script>` actually breaks parsing.)

### Editing these files
They are 15–18k lines. Use targeted Python string replacement with an
`assert src.count(old)==1` guard rather than line-number edits — line numbers
shift constantly and a silent multi-match is how you corrupt a 18k-line file.

### Commit messages
Explain *why* the old behaviour was wrong and what breaks if someone reverts
it. The Phase 1 `Update admin.html` messages are the counter-example — they
carry no information.

### Do not trust comments
Several comments in this codebase describe intended behaviour that the code
does not implement. The tracking AI's comments described a working assistant
that had never once returned an answer. Verify against the code path.

---

## 8. Useful context

- Base Zone A (Karachi) rate: **Rs 200** (`NV_ZONE_A_BASE`)
- **Distance/per-km pricing was removed entirely on 24 Aug 2026.** Everything
  is flat Rs 200. It was killed at four layers (config flag, trigger,
  `p_force_mode` bypass, client `pricing_mode`) — see
  `sql_novax_kill_distance_pricing.sql` — and 19 already-booked parcels were
  repriced. If you find per-km constants still described anywhere, they are
  stale text, not live behaviour.
- Lahore is flat Rs 200.
- Zone map: `karachi:"A"`, everything else `"B"`. Unknown city defaults to B.
- AI quota: 50 messages per merchant, admin-approvable top-up.
- Full audit report (22 sections, 34 findings) was published as an artifact —
  ask the user for the link if you need the detail behind §4.

---

## 9. Monitoring (added 25 Aug 2026)

Until this date **nothing watched the database**. Every problem was found by
hand, late: the `operations_issues` insert loop reached 412,786 rows, the SLA
cron burned ~25M writes a day against a column that does not exist, and 86,814
junk tickets accumulated. None of it announced itself.

There is now a watchdog. It contains no LLM — it is plain SQL on `pg_cron`.

### What runs

| job | schedule (UTC) | what it does |
|---|---|---|
| `novax_health_snapshot` | `0 21 * * *` (02:00 PKT) | `nv_health_take()` — one metrics snapshot a night, capped at 400 |
| `novax_backup_canary` | `7 * * * *` (hourly) | `nv_backup_beat()` — heartbeat + row-count fingerprint, capped at 840 |
| `novax_weekly_digests` | `0 3 * * 1` | pre-existing |
| `novax_sla_enforce` | disabled | **leave it disabled** — see §6 |

### How to read it

```sql
select * from public.nv_health_report();   -- returns NOTHING when healthy
select * from public.nv_backup_verify();   -- always returns six rows
```

`nv_health_report()` compares the two most recent snapshots and returns a row
only for a real problem. Six checks, each traced to a bug this project has
actually had: wallet balance vs its own ledger, delivered-but-uninvoiced,
runaway table growth, duplicated open ops issues, dead rows exceeding live,
and rollback ratio over the interval.

A scheduled task `novax-daily-health` reads both at 09:00 PKT and reports only
what needs acting on.

### Two things that are easy to get wrong

**A registered cron job is not a working cron job.** `novax_sla_enforce` was
registered and `active` for weeks while every single run rolled back. Anything
added to `cron.job` must be proved to execute *and commit* — schedule a
one-minute probe, confirm rows persisted in `cron.job_run_details`, then
unschedule the probe.

**The `operations_issues` loop needed two fixes, not one.** The dedupe fix in
`admin.html` was correct but could not engage: the dashboard's load of a
412,000-row table under an RLS policy calling the `PARALLEL UNSAFE`
`is_staff_admin()`, with no index on `created_at`, took 4,725 ms — at the
PostgREST statement timeout. The load intermittently returned nothing,
`D(i)` turned null into `[]`, and an empty array dedupes against nothing. The
bloat had become its own cause. After the cleanup the same query takes 9.4 ms.
A partial unique index `operations_issues_open_unique` now makes the duplicate
structurally impossible.

### CI

`.github/workflows/checks.yml` runs `scripts/check-build.mjs` (every inline
script block must parse; no credentials in tracked files) and
`scripts/check-sw-version.mjs` (a cache-first asset may not change without a
`CACHE` bump). Both are runnable by hand:

```bash
node scripts/check-build.mjs . && node scripts/check-sw-version.mjs HEAD~1
```

### Backups

`archive_mode=on` via `admin-mgr wal-push`, forced every 2 min, 40,000+
segments archived, zero failures. `nv_backup_verify()` watches it.

None of that proves a **restore** works — only a restore proves that. The
drill is at the bottom of `sql_novax_backup_verify.sql`. The canary exists so
a restore can be checked against a known point instead of by noticing missing
parcels. An untested backup is a belief, not a backup.
