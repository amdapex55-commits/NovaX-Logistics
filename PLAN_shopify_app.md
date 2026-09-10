# NovaX Shopify app — competitive picture and build plan
**26 Aug 2026.** Supersedes the earlier requirements-only draft.

Part 1 is what the competition actually shipped, pulled from their live App
Store listings and reviews. Part 2 is what we should build. Part 3 is how.

---

# PART 1 — What Leopards, M&P, TCS and PostEx actually hold

| App | Who built it | Live since | Rating | Reviews | Price |
|---|---|---|---|---|---|
| **Official TCS Courier** | TCS / Outperform Labs | Mar 2020 | **2.4** ★ | 7 — *71% one-star* | Free |
| **M&P Courier** | M&P Express Logistics | Jul 2022 | **3.2** ★ | 6 — 3×5★, 3×1★ | Free |
| **PostEx** | PostEx | Nov 2021 | **4.1** ★ | 16 — 12×5★, 4×1★ | Free |
| **Leopards Courier – Pakistan** | Devsol (3rd party) | Sep 2021 | **0.0** ★ | **0** | Free / $3 mo / $25 yr |
| **Trax Logistics** | Devsol (3rd party) | Mar 2022 | **0.0** ★ | **0** | Free / $3 mo / $25 yr |
| **Universal Courier Pakistan** | Devsol (3rd party) | Jan 2022 | **5.0** ★ | **42** | Free / $5 once / $25 once |
| **Courierify** | GrowZar (Singapore) | Jan 2026 | **5.0** ★ | 4 | Free 300 / $9.99 / $19.99 / $40 |

## Finding 1 — every courier-owned app is mediocre or broken

TCS has been on the store since 2020 and sits at **2.4 stars with 71% one-star
reviews**. M&P is at 3.2. Leopards does not have an official app at all — the
"Leopards Courier – Pakistan" listing is Devsol's, a third party, and it has
**zero reviews in five years**.

The complaints are not exotic. They are the same three, over and over:

- *"worst app ever, to many bugs. neither it fullfills order nor the tracking
  works."* — TCS
- *"app is not syncing orders from store"* + *"customer support don't even
  reply"* — M&P
- *"sometimes get trapped just in between the work"* — M&P

One TCS reviewer reported Shopify warning them the app would **stop working on
20 Sept 2024** unless updated. That is the API-version deprecation rule biting a
courier that stopped maintaining its app. It is a maintenance failure, not a
build failure — and it is entirely avoidable.

**Read:** these companies treat the Shopify app as a checkbox, not a product.
The bar is genuinely low.

## Finding 2 — the merchants' favourite apps are aggregators, not couriers

The two apps with real traction are **Universal Courier Pakistan** (42 reviews,
5.0) and **Courierify** (5.0). Neither is owned by a courier. Both are pipes
that sit in front of 35–50 couriers at once, including every one of ours:
TCS, Leopards, M&P, PostEx, BlueEx, Trax, Call Courier, Daewoo.

Merchants prefer them for one obvious reason: they run more than one courier and
do not want an app per courier.

**This is the strategic problem.** A NovaX-only app competes with an app that
offers fifty couriers. And joining an aggregator is worse — it makes NovaX one
row in a dropdown next to TCS, chosen on price alone.

## Finding 3 — what the aggregators do *not* have

Read their feature lists closely. Universal Courier and Courierify both do:
booking, bulk booking, labels, loadsheets, tracking, branded tracking pages,
analytics. Courierify adds WhatsApp automation and settlement reconciliation.

Every one of those is **the act of dispatching a parcel**. None of them is:

- a **COD wallet with a real ledger** the merchant can reconcile to the rupee
- **AI support that answers "where is my parcel"** in the merchant's own words
- a **live status spine** owned end-to-end, because the aggregator is only ever
  reading whatever the courier's API chooses to return

An aggregator cannot build these, because it does not own the parcel. We do.

## Finding 4 — nobody charges for the app

TCS, M&P and PostEx are all **free to install**; they earn on shipping. Devsol
and Courierify charge because they sell software, not delivery.

We earn on shipping. **The app should be free**, and that decision deletes an
entire requirement: no Shopify Billing API, no pricing plans in the listing, no
upgrade/downgrade flows, no revenue share. It is a large scope cut bought for
nothing.

## Finding 5 — the app's rating will absorb NovaX's service quality

PostEx's one-stars are not about software. One is *"Its been 4 months they are
not refunding our two lost parcels claim."* Merchants rate the **company**
through the app listing.

So a public listing is a permanent, Google-indexed review page for NovaX
Logistics. That is an argument for launching only once claims and COD
settlement are genuinely reliable — and an argument for the pilot going to
merchants who are already happy.

---

# PART 2 — What we should build

## Position: not another booking pipe

Do not enter as "NovaX, one more courier." We lose that on courier count.

Enter as **the app that closes the loop after the parcel leaves** — the thing
the fifty-courier apps structurally cannot do:

1. **Orders in, AWB back, automatically.** Table stakes. Must be flawless,
   because "not syncing orders" is the #1 complaint about every rival.
2. **COD wallet inside Shopify.** The merchant sees, in their own admin: COD
   collected, COD in transit, COD settled, next payout. Reconciled to the
   ledger we already run. Nobody else has this.
3. **AI support in the admin.** Claude answers "where is order #1043", "why was
   this refused", "what do I do about this return" against real parcel data.
   Nobody else has this either.
4. **Honest status.** Our own spine, not a scraped courier feed.

That is a positioning no aggregator can copy without becoming a courier.

## Scope of v1

**In:**
- OAuth install (this is the whole point — see below)
- `orders/create` → NovaX booking → AWB pushed back as Shopify tracking
- Status sync NovaX → Shopify fulfillment events
- Embedded admin page: connection health, recent bookings, COD wallet summary
- The three compliance webhooks

**Out of v1** (deliberately):
- Billing — the app is free
- Carrier-calculated rates at checkout — **blocked**, see Part 3
- Bulk/loadsheet printing — the NovaX portal already does it; link to it
- AI support panel — v1.1, once the loop is proven

## The single thing that fixes "sketchy"

Today a merchant must create a custom app in *their own* admin, copy an **Admin
API access token**, paste it into the NovaX portal
(`client_set_shopify_admin_token`), and paste a raw
`…supabase.co/functions/v1/shopify-order-intake/<token>` URL into their webhook
settings.

Asking a merchant to hand over a long-lived credential is the complaint. It is a
reasonable thing for them to refuse.

OAuth replaces all four steps with **Install → review permissions → Approve.**
No token is ever shown, copied, or pasted. Everything else in this plan is
secondary to that one change.

---

# PART 3 — How, on our stack

## Hard blockers, decided up front

**BLOCKER 1 — do not build a carrier service.** Live rates at checkout require
the merchant to be on **Advanced Shopify or higher**. Pakistani COD merchants
are on Basic. Closed to essentially our entire base. Build order-sync +
fulfillment, which works on every plan.

**BLOCKER 2 — the embedded UI cannot be served from GitHub Pages.** Shopify
requires every HTML route to return
`Content-Security-Policy: frame-ancestors https://<shop>.myshopify.com https://admin.shopify.com;`
and that value **varies per shop**. GitHub Pages cannot set response headers at
all. The embedded page must be served by a **Supabase edge function** that reads
the `shop` parameter and sets the header per request. Free, and we already run
four edge functions.

**BLOCKER 3 — GraphQL only.** Every new public app since 1 Apr 2025 must be
built exclusively on the GraphQL Admin API. Any REST calls in existing intake
code must be ported before submission.

## What we already have — this is more than half of it

`shopify_connections` already exists with `store_url`, `shopify_secret`,
`shopify_intake` token, `shopify_admin_token`, `shopify_disabled`,
`shopify_import_at`, `shopify_import_awb`, plus nine RPCs
(`admin_list_shopify_connections`, `client_shopify_status`,
`admin_generate_shopify_link`, `admin_reset_shopify_secret`, …) and a **live,
deployed `shopify-order-intake` edge function** — confirmed deployed, returns
401 to unauthenticated calls where a non-existent function returns 404.

The data model barely changes. `shopify_admin_token` stops holding a
merchant-pasted token and starts holding an OAuth-issued one. `shopify_secret`
stops being per-merchant and becomes the one app-level secret. That is it.

## Build phases

**Phase 0 — accounts. ($19)**
Partner account (free), development store (free), App Store registration ($19).

**Phase 1 — OAuth, custom distribution, dev store only.**
New edge function `shopify-oauth`: install redirect, callback, HMAC state check,
token exchange, write to `shopify_connections`. No review needed at this stage,
and custom distribution grants protected-customer-data levels 1–2 automatically.

**Phase 2 — the core loop.**
Rework `shopify-order-intake` to verify the **app-level** HMAC instead of a
per-client URL token. `orders/create` → create booking → push AWB back with
`fulfillmentCreateV2`. Then NovaX status change → Shopify fulfillment event.

**Phase 3 — embedded UI.**
Edge function serving HTML with the per-shop CSP header, App Bridge, session
token verified server-side. Shows connection health, last 20 bookings, COD
wallet summary.

**Phase 4 — compliance webhooks.**
`customers/data_request`, `customers/redact`, `shop/redact`. Each verifies the
Shopify HMAC, returns **401** on failure and **2xx** on success, and completes
the action within 30 days.

**Phase 5 — pilot.** 2–3 real merchants on custom install links. Run it for a
few weeks. Fix what breaks.

**Phase 6 — the paperwork, in parallel with the pilot.**
For protected-customer-data Level 2 (we need name, address, phone) we currently
fail on:

| Requirement | Status |
|---|---|
| Encryption in transit / at rest / backups | Pass — Supabase |
| Test/prod separation | **Fail — one project does both** |
| Access log for protected data | **Fail** |
| Data retention policy | **Fail — nothing is ever deleted** |
| Incident response policy | **Fail — not written** |
| DLP strategy | **Fail** |
| Published privacy policy | **Fail — no privacy page exists on the site** |
| Staff access limited | Partial — RLS by role exists |

Four are documents, roughly a day of writing. Two — test/prod separation and the
access log — are real work. The privacy page is required twice over (listing
*and* data review) and is worth doing regardless of Shopify.

**Phase 7 — go public.**
Switch distribution to public, request Level 2 protected data naming exactly the
fields we use, prepare listing assets, submit.

## Scopes to request — and nothing more

`read_orders`, `read_assigned_fulfillment_orders`,
`write_assigned_fulfillment_orders`, `write_fulfillments`.

Shopify approves protected data only when it is "the minimum required," and
unapproved fields come back **silently redacted** rather than erroring. An
over-broad request quietly costs us data.

## Listing assets needed at Phase 7

Name ≤30 chars (no "Shopify" in it) · icon 1200×1200, no text · 3–6 screenshots
1600×900 · intro ≤100 chars · details ≤500 chars · privacy policy URL · demo dev
store with instructions · English screencast · working test credentials.

## Cost

$19, once. Partner account free, hosting free on Supabase edge functions, and
because the app is free to install there is no revenue share and no Billing API.

---

# Decisions I need from you

1. **Which 2–3 merchants get the pilot?** Pick ones already happy with NovaX —
   Phase 5 feedback shapes the listing, and Finding 5 says their goodwill
   eventually becomes our public rating.
2. **Keep the pasted-token path during the pilot?** Recommend yes, labelled
   "legacy" in the portal, removed once every active Shopify merchant has moved.
3. **App name**, ≤30 characters. "NovaX Logistics" is 15 and fine.
4. **Confirm free-to-install.** I have assumed yes throughout; it is what every
   courier-owned app does and it removes a large chunk of scope.

# What I'd do first

Phases 0–2 are the whole bet and none of them touch a blocker. If the
orders-in / AWB-back loop works cleanly against a dev store, everything after
it is packaging and paperwork.
