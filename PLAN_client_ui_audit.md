# Client portal UI audit — 25 Aug 2026

Everything below was measured in a real browser at 375×812 (iPhone) and
1280×800, driving the actual `client.html` with production-shaped data: 32
parcels in the real status mix taken from the live `parcels` table
(Delivered 14, Return to shipper 4, Parcel out for delivery 4, Parcel now in
transit 3, New booked 4, Refused 2, Arrived at warehouse 1).

Nothing here is a guess. Where a suspicion did not survive checking, it is
written down as *not* a bug — see "Checked and cleared" at the end.

---

## Severity 1 — the merchant misses something that matters

### 1.1 The AI button covers every toast

`#toast` is `z-index: 120`. `.nvauto-btn` is `z-index: 99998`. They occupy
the same band at the bottom right of the screen.

Verified with `elementFromPoint` at the toast's own coordinates: the element
actually on top is `nvauto-btn-icon`.

This matters because the toast is how a merchant learns their booking
worked — "Parcel booked. AWB N3691042". On a phone, the right-hand end of
that message sits underneath a green circle.

**Fix:** raise `#toast` above the assistant (`z-index: 100000`), and shift its
bottom offset above `#nvBottomNav` and `#nvMobileBookBar`. One CSS rule.
The z-index ladder in this file needs writing down at the same time — see 3.1.

### 1.2 "Needs attention" has two different meanings on one screen

At the same moment, on the same dashboard:

| element | says | source |
|---|---|---|
| `#nvCsBrief` command strip | **6** need attention | `dailyCommandData().issues` |
| `#nvAiSub` sidebar subtitle | **6** parcels need attention | same |
| cockpit header | **2** need attention | `nvTodayBuckets().needs` |
| coach banner | 0 aging, **2** refused | `refused` count |

The disagreement is exactly one status. `dailyCommandData()` counts
**Return to shipper** as an issue; `NEEDS_ME` at `client.html:10966` does not:

```js
var NEEDS_ME=["Refused","Consignee not available","Out of service area","Ready for return"];
```

With the production mix that is 2 Refused + 4 Return to shipper = 6 versus 2.

**Fix:** one exported predicate, `nvNeedsMerchant(parcel)`, used by both.
Decide the question once — *does a parcel coming back to the merchant need
their attention?* I would say yes: they have to receive it and it is money
they did not earn. That makes the honest number 6 and `NEEDS_ME` the one to
change. This is a business call, not a technical one.

### 1.3 The assistant opens itself over the dashboard

2.5 seconds after load, `tryDailyBriefing(true)` calls
`window.novaxAutopilotSay()`, which runs `panel.classList.add("open")`.

Trigger: any merchant with at least one issue parcel, once per client per day
(`novaxDailyBriefingShown:<clientId>:<date>`).

On desktop the panel covers the right half of the dashboard. On a phone it
covers effectively all of it. The merchant did not ask for it, and it lands
*after* they have started reading — so it moves under their eyes.

**Fix:** do not open the panel. Put the briefing behind the existing badge on
the FAB, which already shows the count and already pulses. If the briefing is
worth interrupting for, interrupt with one line in the command strip the
merchant is already looking at — not a chat window over the numbers.

---

## Severity 2 — the portal is harder to use than it needs to be

### 2.1 721 pixels before the first booking field

On an 812px phone screen, the first input of the booking form sits at y=721.
The merchant scrolls almost a full screen to type anything.

What fills that space, in order: logo + tagline, a `Home / Seller Suite` tab
row, an `<h1>Client Portal</h1>`, a four-line marketing paragraph ("For
e-commerce sellers: book parcels, track real status, see invoices, and
download reports from one controlled dashboard."), the Client Menu card, and
a "Talk to NovaX AI" card.

The same measurement on the dashboard: **427px before the COD balance** — the
single number most merchants open the portal to see.

The marketing paragraph is the clearest offender. It is copy written for a
logged-out visitor, rendered to someone who has already logged in and is
looking at their own workspace.

**Fix, in order of payoff:**
1. Drop the marketing paragraph and the `Client Portal` h1 once
   `state.identityVerified` is true. Replace with the merchant's own name,
   which is already in `state.client.name`. (~180px on mobile)
2. Collapse the `Home / Seller Suite` row into the existing header on mobile —
   the bottom nav already handles navigation. (~90px)
3. Drop the "Talk to NovaX AI" card on mobile. The FAB is on every screen and
   the bottom nav has an entry. Three doors to one room. (~110px)

That is roughly 380px back — the difference between scrolling and not.

### 2.2 Four fixed layers stacked in the bottom 126px

Measured on the booking tab at 375×812:

| element | z-index | occupies |
|---|---|---|
| `.nvauto-btn` (AI) | 99998 | 686–742 |
| `#nvMobileBookBar` | 9997 | 687–754 |
| `#toast` | 120 | 707–748 |
| `#nvBottomNav` | 110 | 755–812 |

The AI button sits directly on top of the sticky "Create Booking" bar. On the
dashboard the offline banner (`#nvStaleBanner`, 158px — **19% of the screen**)
joins the pile.

**Fix:** one bottom stack with a fixed order and no overlap — nav at the
floor, then contextual bar, then toast, then FAB offset diagonally clear of
the bar. Give the AI FAB a `bottom` that accounts for whichever bars are
present rather than a constant.

### 2.3 Two "Create Booking" buttons visible at once

`#quickBookingBtn` (in the panel header) and `#nvStickyBookBtn` (in
`#nvMobileBookBar`) are both on screen, 113px apart, with identical labels.

**Fix:** hide `#quickBookingBtn` on mobile when the sticky bar is present.

### 2.4 The offline banner is 158px tall on a phone

It is doing a good job — it correctly detected the failure — but at 19% of
the viewport with a full-width Retry and Dismiss, it is louder than the
problem. (The Retry button *is* reachable; I checked.)

**Fix:** single line, one inline Retry, ~44px.

---

## Severity 3 — cleanup, no user-visible change

### 3.1 There is no z-index scale
Values in use: 110, 120, 9997, 9998, 99997, 99998, 999999. The two collisions
above are the symptom. Define six named tiers as CSS custom properties and
replace the literals.

### 3.2 Three render functions write into elements that do not exist

`renderClientModules()`, `renderAi()` and `renderLatestInvoice()` all run on
every render and target ids that are never in the markup: `#paymentSummary`,
`#paymentTimeline`, `#clientPaymentHistory`, `#supportEscalations`,
`#clientAi`, `#clientAiInput`, `#clientLatestInvoice`, `#redeliveryFeedback`,
`#clientAiSendBtn`, `#askAiBtn2`.

All ten lookups are guarded (`||{}`, `if(!el) return`, `?.`), so nothing
throws — this is dead weight, not breakage. It is leftover from superseded UI.

**Fix:** delete the dead branches. Do this *carefully and last*: confirm each
id is absent in every tab state before removing, because some may belong to
markup that renders only under a role or feature flag.

### 3.3 Two Shopify RPCs do not exist

`client_set_shopify_domain` and `client_shopify_bulk_state` are called but are
not in the database. The code handles it well — `nvRpcMissing()` latches and
`nvShopifyDisable()` shows "Shopify import is not switched on for this account
yet. Ask NovaX to enable it — nothing is wrong on your side."

So it degrades honestly. But the panel is still rendered to every merchant,
advertising a feature nobody can use.

**Fix:** either deploy the two functions or hide the panel until they exist.

### 3.4 Timers do not suspend when a tab *starts* hidden

`nvInterval`'s suspend logic listens for `visibilitychange`. A tab that is
already hidden at load never fires that event, so all 13 timers run. Observed
directly: `document.hidden === true` with 13 timers registered and ticking.

Low impact and self-correcting on the first focus, but it is my bug from the
last session.

**Fix:** check `document.hidden` once at registration.

---

## Checked and cleared — these are NOT bugs

Recorded so nobody re-investigates them.

- **Duplicate `id="nvPrintA4"`** — the second occurrence is inside a comment.
- **"0 need attention · 0 moving"** — my first seed used status strings that
  do not exist in this system ("Out for delivery" rather than "Parcel out for
  delivery"). With the real vocabulary the counts are correct.
- **The cockpit not refreshing after a data change** — it does, on the 2.5s
  `nvP3Tick`. My probe read the DOM faster than the tick.
- **"Verifying account…" and "Loading workspace…" stuck** — the audit harness
  has no Supabase session, so `state.identityVerified` never flips. Harness
  artifact.
- **The offline banner's Retry button being unreachable** — it is reachable;
  the AI nudge sits above it, not on it.
- **The hamburger "Menu" label being clipped** — `scrollWidth === clientWidth`.
  Not clipped.

---

## Suggested order

1. **1.1** toast z-index — one CSS rule, removes a real failure
2. **1.3** stop the assistant auto-opening — one condition
3. **2.1** reclaim the top of the screen — biggest felt improvement
4. **2.2 + 2.3** settle the bottom stack
5. **1.2** unify "needs attention" — needs your decision first
6. **2.4** shrink the offline banner
7. **3.1** z-index scale, then **3.4**, then **3.3**
8. **3.2** dead render cleanup, last and carefully

Items 1–4 are independent of each other and none of them touch data,
money, or the booking RPC.

---

## How to reproduce this audit

The harness is not committed — a 1 MB copy of `client.html` in the repo would
go stale and mislead. To recreate it:

1. Copy `client.html` to `__ui-audit.html`.
2. Insert `<script>window.__NV_AUDIT=true;</script>` immediately after `<body>`.
3. In the auth gate, immediately before
   `if(!__gsb||!__gsb.auth){ denyWithError(); return; }`, add a block that —
   when `window.__NV_AUDIT` is set — assigns
   `window.__novaxVerifiedProfile={role:"client",status:"active",clientId:"SAMPLE-OFFLINE"}`,
   hides `#nvAuthGate`, calls `__resolveGate("SAMPLE-OFFLINE")` and returns.
4. Serve the repo (`novax-logistics` in `~/.claude/launch.json`, port 8791).
5. Set `state.identityVerified = true`, assign `state.client` and
   `state.parcels`, then call `render()`.
6. **Delete `__ui-audit.html` when done.**
