# Onboarding cards — plan

**27 Aug 2026.** Ten swipeable cards that teach the portal, shown **only** to a
brand-new merchant right after their workspace is created, and to anyone in the
demo. Existing merchants must never see them.

---

## 1. The gate — the part that matters most

The stated constraint is that this must not touch live users. So the gate fails
closed: if we cannot *prove* someone is brand new, nothing renders.

```
show cards  ⇔   demo mode
            OR  ( workspace created < 15 minutes ago
                  AND not already completed on this device )
```

**`clients.created_at` is the hard guarantee.** A merchant who signed up three
weeks ago can never satisfy a 15-minute window — not by clearing storage, not
by reinstalling, not by signing in on a new phone. That is the property that
makes this safe, and it is why the window is the primary gate rather than a
flag.

`localStorage` (`nvOnboardCards:<clientId>`) is only the "don't show it twice"
nicety, layered on top. If it is missing, the time window still holds.

**Rejected:** gating on a `clients.meta.onboardingSeen` flag alone. Writing it
needs an RPC, merchants cannot write to `clients` directly (the guard triggers
block it), and a failed write would either loop the cards forever or need a
silent catch that hides the failure. The time window needs no write at all.

**In demo:** cards show on entry. They must sequence with the existing 25s
signup invitation — the invite timer starts only once the cards are dismissed,
so a visitor never gets two overlays stacked.

---

## 2. The ten cards

Ordered as the arc a new merchant actually walks, and weighted toward the first
parcel, because that is the measured leak: 216 signed up, 46 have ever booked.

| # | Card | What it teaches |
|---|---|---|
| 1 | **Your workspace is live** | What NovaX is, and that nothing needs approval |
| 2 | **Book your first parcel** | The booking form — the single most important screen |
| 3 | **Paste a WhatsApp order** | Autopilot fills the form from pasted text |
| 4 | **Print the AWB label** | What to stick on the box before pickup |
| 5 | **Follow every parcel** | The status spine, owned end to end |
| 6 | **What needs me** | Exceptions surfaced before they become complaints |
| 7 | **Your COD wallet** | Where the money sits, reconciled to the rupee |
| 8 | **How charges work** | COD minus delivery charges, netted on one invoice |
| 9 | **Get paid out** | Requesting a withdrawal |
| 10 | **Ask Autopilot anything** | The assistant, grounded in their own parcels |

Card 10 ends on a single action: **Book your first parcel**, which closes the
deck and lands them on the booking form. The deck should end in the thing we
want them to do, not in a "Done" button.

---

## 3. Pictures — a recommendation, not a decision

The request was "with dashboard pictures". Two ways to do that, and the choice
has a real cost:

| | Real screenshots | CSS/SVG miniatures |
|---|---|---|
| Weight | ~40–70 KB each → **0.4–0.7 MB for ten** | ~0 KB, ships in the bundle |
| Staleness | Goes wrong the next time the UI changes | Always current |
| Effort | Capture and re-capture on every redesign | Built once |
| Precedent | — | Section 02 of the landing page already does this |

The audience is mid-range Android on patchy 4G. Adding most of a megabyte in
front of a merchant who has not yet booked anything is the wrong trade, and
stale screenshots teaching a UI that has moved on is worse than none.

**Recommendation:** CSS/SVG miniatures of each screen — the same technique the
landing page already uses — with the option to swap two or three of the
highest-impact cards (booking, wallet) for real WebP screenshots later, lazily
loaded, once we know the deck converts. Say the word if you want literal
screenshots for all ten and I will build it that way instead.

---

## 4. Swipe mechanics

- **Drag** with pointer events: `translateX` + slight `rotate`, opacity falloff.
  Commit past ~90px or a fast flick; otherwise spring back.
- **Right = next, left = back.** Tinder's gesture, but both directions navigate
  rather than accept/reject — there is nothing here to reject, and a merchant
  who swipes back expects the previous card.
- **Also**: tap left/right thirds, arrow keys, and a dot indicator showing
  position in the deck.
- **Skip** is always visible, top-right. Skipping is final — the deck is marked
  complete so it never returns.
- **Motion**: transform/opacity only, so it stays on the compositor. Under
  `prefers-reduced-motion` the drag still works but the spring and rotation are
  dropped.
- **Never traps**: Escape closes, backdrop tap closes, and the close path is the
  same one Skip uses, so there is exactly one way to finish.

---

## 5. Where it lives

`client-app.js`, alongside the demo module, guarded by the gate. No new file and
no second bundle — the demo already proved that pattern, and this deck is
smaller than the demo fixture.

Adds an estimated 12–18 KB. The `?v=` cache-buster must be bumped or the
service worker serves the old bundle and nobody sees it.

---

## 6. Verification before it ships

The first two are the ones that matter; the rest is polish.

1. **An existing merchant never sees it.** Simulate a client with an old
   `created_at` and an empty `localStorage`, and confirm nothing renders. This
   is the stated constraint and gets tested explicitly, not assumed.
2. **A real merchant session is otherwise untouched** — the portal behaves
   exactly as today when the gate is false.
3. A fresh workspace shows the deck once; reload does not repeat it.
4. Demo shows it, and the 25s signup invitation only starts after the deck is
   gone.
5. 375×812: no horizontal page scroll, cards clear both safe areas, swipe works
   with touch emulation, and the deck does not sit under the bottom navigation.
6. Skip at card 1 and swipe through all 10 both mark it complete.

**Measure the probe, not just the app.** `state` is a closure variable — reading
it as `window.state` returns undefined and any `window.state && state.x` guard
silently yields empty. That cost real time on the demo build, chasing a bug that
did not exist.

---

## 7. Build order

| Phase | Work |
|---|---|
| 1 | The gate + a stub deck. Verify an existing merchant sees nothing. |
| 2 | Swipe engine, dots, skip, keyboard |
| 3 | The ten cards' copy and CSS miniatures |
| 4 | Demo sequencing with the 25s invite |
| 5 | Mobile pass at 375px, then cache-bust and ship |

Phase 1 carries the whole risk. Nothing else can touch a live merchant.
