# Client portal — smooth, interactive, mobile-first

Plan only. Nothing here has been executed.

Every item below was checked against the actual file before being written down.
Three of my original ten did not survive that check and were replaced; they are
listed at the end so the reasoning is visible.

---

## What is already good (so we do not "fix" it twice)

- **iOS zoom-on-focus is solved.** `input:not([type=checkbox])..., select, textarea
  {font-size:16px}` inside `@media (max-width:760px)`, plus `#nvAiInput{font-size:16px}`
  for the AI composer. ID specificity beats the later `.nvai-composer textarea`
  rule, so the composer is covered too. I nearly reported this as broken.
- **Network polling is already tuned.** The fallback poll runs every 3 minutes and
  only while realtime is down, plus a refresh on tab focus. It used to be 30s
  unconditionally.
- **Parcel volumes are small.** Busiest merchant has 96 parcels, median 3, nobody
  over 100. Virtualising the list is future-proofing, not a fix.
- **Touch targets** are largely 44px already, and `safe-area-inset` is handled in
  10 places.

---

## 1. 276 KB gzipped in one blocking file — ~5.7s before first paint on 3G

**Evidence.** `client.html` is 988 KB raw / 276 KB gzipped. 721 KB of inline CSS
and 759 KB of inline JS. The largest single `<script>` is **538 KB**, starting at
byte 195,337 — and `<body>` does not begin until byte 111,263. Nothing renders
until the whole file lands.

**Plan.**
1. Keep the critical shell inline: theme boot, layout CSS, header, nav, skeleton.
   Target under 30 KB gzipped.
2. Move the 538 KB script to `client-app.js`, loaded `defer`.
3. Move the two large `<style>` blocks (55 KB + 30 KB) to `client.css` with
   `media="print" onload="this.media='all'"` so they never block paint.
4. Keep `PROJECT_HISTORY`'s zero-build-step rule: these are plain files, no
   bundler, no npm.

**What could break.** Inline scripts run in document order and share one global
scope; `defer` changes ordering. Any function called from an inline `onclick`
before the deferred file loads will throw. There are **57 inline onclick
handlers** — all must resolve after load, so the shell must not call app
functions. Mitigate by keeping a no-op stub map in the shell that queues calls
until the app is ready.

**Verify.** Lighthouse mobile before/after; first-contentful-paint on a throttled
3G profile; every one of the 57 onclick handlers still resolves.

---

## 2. There is no offline capability at all, by deliberate choice

**Evidence.** `sw.js` is a *self-removing* worker — it deletes all caches and
calls `registration.unregister()`. It is not registered by any page. Separately,
`client.html:21` unregisters any surviving worker and clears `caches` whenever
`APP_VERSION` changes — and that constant reads `"2026-07-10.1"`, six weeks
stale, so the mechanism no longer fires.

`navigator.onLine` is checked **0 times**. There is no `offline` event listener.
A merchant who walks into a lift gets silent failures with no explanation.

**Plan.**
1. A real service worker: **network-first for `client.html`**, cache-first for
   static assets, with a versioned cache name derived from the deploy.
   Network-first is essential — the reason the old one was killed was stale HTML.
2. Register it only after `load`, and only on `https`.
3. Add an offline banner driven by `online`/`offline` events plus a failed-fetch
   counter, so the merchant is told rather than left guessing.
4. Delete the `APP_VERSION` block once the worker handles versioning properly.

**What could break.** This is the one that has bitten before. A cache-first HTML
strategy would serve merchants a stale portal after a deploy — exactly what
`sw.js`'s comment describes cleaning up. Network-first with a cache fallback
avoids it. Ship behind a query-string kill switch (`?nosw=1`) for a week.

**Verify.** Deploy, hard-refresh, confirm new HTML arrives; then go offline and
confirm the shell still loads and says so.

---

## 3. The Android back button exits the app instead of closing a modal

**Evidence.** `history.pushState` appears **0 times**. There are 12 places doing
`classList.add("show")` to open a modal or drawer, and Escape is handled in only
2. On Android, back from an open AWB modal or the parcel drawer leaves the portal
entirely — and with no offline cache (item 2) that is a full 276 KB reload.

**Plan.**
1. On open: `history.pushState({modal:id}, "")`.
2. On `popstate`: close the topmost overlay instead of navigating.
3. On close via button/backdrop: `history.back()` if the state is ours.
4. Bind Escape to the same close path for all 12, not 2.
5. Apply the same to tab switches so back returns to the previous tab.

**What could break.** Double-close if both the button handler and `popstate`
fire. Needs one small overlay stack rather than 12 independent handlers.

**Verify.** On a real Android device: open drawer → back → drawer closes, portal
stays. Repeat for each of the 12 overlays.

---

## 4. A half-finished booking is lost the moment the merchant switches apps

**Evidence.** No booking draft persistence (`bookingDraft`/`saveDraft`: 0 hits)
and no `beforeunload` guard.

This matters more here than it would elsewhere: merchants copy consignee
addresses **out of WhatsApp**. App-switching mid-booking is the normal flow, not
an edge case. On a phone with little RAM the tab is discarded and the form is
empty on return.

**Plan.**
1. On `input` in the booking form, debounce 400ms and write the field values to
   `localStorage` under `novaxBookingDraft`.
2. On load, if a draft exists and is under 24h old, restore it and show a quiet
   "restored your unfinished booking" note with a discard action.
3. Clear the draft on successful booking or explicit discard.
4. No `beforeunload` prompt — it is ignored on mobile and irritating on desktop.

**What could break.** Stale drafts resurfacing after a merchant deliberately
abandoned a booking. The 24h expiry and the visible discard action cover it.
Do **not** persist COD or phone beyond that window.

**Verify.** Fill half a booking, switch apps, force-kill Safari, reopen.

---

## 5. Six timers keep working in a backgrounded tab

**Evidence.** 17 `setInterval` calls. Six have **no visibility guard**: a 1s clock
repaint, `nvP3Tick` at 2.5s, a 3s tick, `checkMoments` at 4s, a 5s badge refresh,
and one more. Four others already check `document.hidden` correctly.

Good news from checking: none of the six make network calls, so this is CPU and
repaint cost, not data. The battery claim is real; a data claim would not be.

**Plan.**
1. One shared `nvInterval(fn, ms)` helper that registers with a central list and
   automatically suspends on `visibilitychange`.
2. Convert all 17 to it, so the four already-correct ones stop hand-rolling it.
3. Drop the clock from 1s to 30s — nobody reads seconds off a courier dashboard.

**What could break.** A timer that must keep running while hidden (a countdown
that has to be accurate on return). Resume should recompute from wall-clock time
rather than assuming ticks were not missed.

**Verify.** Background the tab, watch CPU in Activity Monitor, return and confirm
every clock and badge is correct rather than stale.

---

## 6. No pull-to-refresh

**Evidence.** No `overscroll` or touch-pull handling anywhere. `loadAll()` at
line 9482 is the natural refresh entry point and already exists.

**Plan.** Touch handler on the scroll container: if `scrollTop === 0` and the
drag exceeds ~70px, show a spinner and call `nvQuietRefresh()`. Respect
`prefers-reduced-motion`.

**What could break.** Fighting native overscroll on iOS. Use
`overscroll-behavior-y: contain` on the scroll container and only engage at
`scrollTop === 0`.

**Verify.** iOS Safari and Android Chrome; confirm it does not trigger while
scrolling a parcel list mid-page.

---

## 7. No haptics on any confirmation

**Evidence.** `navigator.vibrate`: **0 occurrences**, against 21 success toasts.

**Plan.** A tiny `nvHaptic(kind)`: 10ms on success, 30-20-30 on error, nothing if
unsupported or if `prefers-reduced-motion`. Fire on booking confirmed, parcel
delivered, withdrawal submitted, ticket sent.

**What could break.** Nothing. iOS Safari ignores `vibrate` entirely, so this is
Android-only — worth stating so it is not mistaken for a bug on your iPhone.

---

## 8. Hamburger menu instead of a bottom tab bar

**Evidence.** 9 `client-tab` buttons behind a hamburger, 34 hamburger references.
Destinations are role-gated through `nvRoleTabs()` / `NOVAX_ROLE_TABS`.

**Plan.**
1. Below 760px, render a fixed bottom bar with the four most-used destinations
   the merchant's role actually permits — Dashboard, Book, Money, Support — and
   a "More" entry for the rest.
2. Reuse `nvRoleTabs()` so a Warehouse seat never sees Money.
3. `padding-bottom: calc(64px + env(safe-area-inset-bottom))` on the content.
4. Keep the hamburger for the long tail.

**What could break.** The existing sticky elements — there are 23 `position:fixed`
and 4 `position:sticky` rules; a bottom bar can cover the AI launcher or a sticky
CTA. Audit all 27 before shipping.

**Verify.** Every role sees only permitted tabs; nothing is obscured on a 375px
screen with the keyboard open.

---

## 9. 138 wholesale `innerHTML` rebuilds

**Evidence.** 138 `innerHTML =` assignments and 29 full `render()` calls. The
ticket list already carries hand-rolled draft/caret preservation because this
class of bug wiped merchants' typing every 3 seconds — that is a symptom, not a
solution.

**Plan.**
1. Start with the three that run on timers or realtime:
   `renderClientParcels`, `nvTkRender`, `renderDailyCommandCenter`.
2. Key each row by AWB / ticket id, diff against the rendered set, and patch only
   changed rows. `nvMarkChanged()` already computes a change set — extend it to
   drive patching rather than decoration.
3. Never touch a subtree containing `document.activeElement`.

**What could break.** Subtle divergence between the diffed DOM and a full render.
Mitigate by keeping a debug flag that forces full rebuild, so the two can be
compared.

**Verify.** Type into a filter box while a realtime update lands; scroll halfway
down the parcel list and wait for a refresh. Neither should move.

---

## 10. Every action waits for the server with no feedback

**Evidence.** Booking, cancel, reattempt, return, ticket — each fires an RPC and
leaves the screen unchanged until it resolves. On mobile data that is seconds of
"did that work?", and today's session showed what happens when the answer never
comes back cleanly.

**Plan.**
1. Disable the button and show inline progress on the control that was pressed —
   not a toast at the other end of the screen.
2. For the safe, reversible ones (ticket, reattempt, return) apply the state
   change immediately and reconcile on response.
3. On failure, restore the previous state visibly and say why.
4. **Never optimistic for money.** Withdrawals and wallet adjustments must wait
   for the server, for the same reason the parcel edit does.

**What could break.** Optimistic state diverging from the server. Every path must
end in `loadAll()`/`nvQuietRefresh()` so the server always wins.

---

## Order I would work in

**First, because they compound:** 1 and 2 together turn a 5.7s cold start into a
sub-second warm one. 2 depends on 1 being split, so do 1 first.

**Then the ones merchants feel hourly:** 4 (lost bookings), 3 (back button),
10 (action feedback).

**Then polish:** 8, 6, 7, 5.

**Last:** 9, the largest and riskiest, and worth doing only once the rest is
stable.

---

## Items I dropped after checking

- **"AI composer zooms on iOS."** Already fixed — `#nvAiInput{font-size:16px}`
  wins on specificity, and every other text control is covered by a rule with a
  comment explaining exactly this.
- **"Parcel list renders unbounded."** True, but the busiest merchant has 96
  parcels and the median is 3. Real but not urgent; folded into item 9.
- **"Polling drains battery and data."** The network poll is already 3 minutes
  and realtime-gated. What remains is repaint cost only — item 5, correctly
  scoped.
