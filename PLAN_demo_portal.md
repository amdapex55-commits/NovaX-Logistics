# Demo the portal — plan

**27 Aug 2026.** A "Demo the portal" button beside the signup CTA opens the real
merchant portal, fully navigable, seeded with sample parcels, a wallet, invoices
and an AI conversation. No email, no password, no account. Read-only.

---

## Why this is the right thing to build

The landing page already argues for it. From the section 02 comment in
`index.html`:

> 339 of 374 parcels ever booked came from the portal, 6 from admin, and not
> one from a store webhook — only 2 of 216 clients have even connected a store.
> The portal is what merchants actually use, so the portal is what the page
> should show.

Section 02 today is an **animated miniature** — a marketing visual. This
replaces the argument with the artefact: the actual portal, in their hands,
before they give anything up.

It also attacks the measured leak. 216 merchants have signed up; 46 have ever
booked; ~13 ship in a given week. The 26 Aug WhatsApp to 166 never-bookers
converted **zero**. Reach is not the problem — nobody will hand a courier their
COD on the strength of a description. This lets them look first.

And it is the one place NovaX is unambiguously ahead. The competing Shopify
apps sit at 2.4 (TCS), 3.2 (M&P), 4.1 (PostEx). The portal is the product.

---

## The one decision that matters: no backend

**The demo runs entirely client-side against a hardcoded fixture. It makes no
network call, holds no session, and touches no Supabase table.**

The alternative — a real demo account with read-only RLS — is rejected
deliberately:

- A demo account is a genuine authenticated session. Every write path that is
  missed writes a real row.
- It needs a new RLS policy set, and `PROJECT_HISTORY` §3.2 already records
  policy gaps as an open risk. Adding a public-facing role to that surface is
  the wrong trade.
- It is an endpoint strangers can hammer. Fixtures are not.

With no client, no session and no endpoint, **writing is structurally
impossible rather than merely blocked.** That is the property worth having on a
page linked from the public homepage.

Costs nothing to run. Works offline. Cannot be abused.

---

## Entry and boot

`client.html?demo=1`

1. An inline script in `client.html`, placed **before** the deferred bundle,
   sets `window.__NOVAX_DEMO = true`.
2. The auth-gate IIFE in `client-app.js` checks that flag first and resolves the
   gate without authenticating — the same `__resolveGate` hook the local admin
   harness already uses. It must return *before* `getSession()`, because the
   gate's no-session branch calls `redirectAway("index.html")`.
3. A demo shim installs `window.__nvSb` as a fake client whose `from()` returns
   fixture rows and whose `rpc()` answers from a lookup table.

### Write blocking, three layers

| Layer | Mechanism |
|---|---|
| Structural | No session, no real client, no endpoint — nothing to write to |
| Shim | `insert` / `update` / `delete` / write `rpc`s resolve to `{error:{message:"demo"}}` and fire the conversion toast |
| Visual | Submit controls disabled, persistent banner |

The shim layer exists so a blocked action produces a *sales moment* rather than
a silent failure — see Conversion below.

---

## The fixture — five parcels that tell the story

The demo must show the four things an aggregator structurally cannot do
(`PLAN_shopify_app.md`, Finding 3): a real COD wallet, grounded AI support,
honest status, an owned spine. So the parcels are chosen to demonstrate the
money loop end to end, not to look busy.

| # | AWB | Status | What it demonstrates |
|---|---|---|---|
| 1 | N9000001 | Delivered · invoiced · pushed to wallet | The full money loop: COD collected → charges netted → wallet credited |
| 2 | N9000002 | Out for delivery | Live status, rider assigned, today's activity |
| 3 | N9000003 | Parcel now in transit | The status spine |
| 4 | N9000004 | Refused — consignee unreachable | Honest exception handling, and the AI explaining the options |
| 5 | N9000005 | New booked | The pipeline, awaiting pickup |

Supporting fixture:

- **Wallet**: available balance, one settled invoice, one amount "in transit"
- **Ledger**: the credit from parcel 1, so the balance reconciles to the rupee
- **Invoice**: one, showing COD minus delivery charges — the netting that is the
  actual product
- **Ticket**: one resolved support thread with a reply, showing the loop closes

### Fixture data rules

- Every name, phone and address is invented. Pakistani names and real Karachi
  areas so it reads true, but **no real consignee data is copied** — this repo
  has already had to run `sql_novax_clear_fabricated_consignee_details.sql`
  once, and demo data must never be confusable with production data.
- Phone numbers use a clearly non-routable pattern.
- AWBs use an `N90000xx` block that the real sequence will not reach, so a demo
  AWB can never collide with or be mistaken for a live parcel.
- Dates are computed relative to now, so the demo never looks stale.

---

## The AI conversation

Preloaded, **scripted, and offline**. It must not call `novax-ai` or
`novax-ai-support`:

- both require a JWT and would 401 for an anonymous visitor
- `novax-ai` is `claude-opus-5` — a public unauthenticated LLM endpoint on the
  homepage is an unbounded bill and an abuse target

So: a fixed transcript that shows grounded answers against the fixture parcels —
"where is N9000002", "when do I get my COD", "why was N9000004 refused". These
are exactly the questions the deterministic engine answers for free in
production, so the demo is honest about what the real thing does.

If the visitor types anything, one canned reply: the assistant explains it
answers against their real parcels, and invites them to create an account. That
is a conversion moment, not a dead end.

---

## Mobile — a first-class requirement, not a check at the end

The audience is mid-range Android on patchy 4G. The client portal already has
thumb-reachable bottom navigation (`d5a7f21`), which the demo inherits.

Specific requirements:

- **Banner placement.** The demo banner sits at the top with
  `env(safe-area-inset-top)`. It must not go at the bottom: that is where the
  portal's own navigation lives, and covering it would break the thing the demo
  exists to show.
- **Bottom nav clearance.** The existing nav uses `env(safe-area-inset-bottom)`;
  the banner must not add a second fixed layer competing with it.
- **The Autopilot FAB overlaps content at 375px** — audit finding 18, still
  open. Fix it here or the demo ships with a visible defect on the exact
  viewport most visitors will use.
- **Test at 375×812**, both orientations, and confirm no horizontal page scroll.
  Wide tables must scroll inside `.wide-scroll`, as they already do.
- **Payload.** `client-app.js` is 783 KB and cache-first. The demo adds a
  fixture, not a second bundle — target under 20 KB added.
- **No new fonts, no new images.** Reuse what the portal already loads.

---

## Conversion — the point of the exercise

A demo that does not convert is a toy.

1. **Persistent CTA** in the banner: *"Start shipping — create your free
   account"*, linking to `index.html#signup?src=demo`.
2. **Every blocked write becomes a prompt.** Tapping *Book Parcel* does not say
   "disabled" — it says "This is a demo. Create your account to book a real
   parcel," with the button right there. The moment of intent is the moment to
   ask.
3. **Exit demo** returns to the landing page.
4. **Attribution.** The signup link carries `src=demo`. Without it we cannot
   tell whether this worked, and the 26 Aug campaign already showed how easily
   an intervention produces nothing.

### How we will know

Baseline, from the database: **~1 first-time booker per day, best day ever 4.**

Success is a sustained lift in *first-time bookers*, not demo opens. Demo opens
are a vanity number; the funnel that matters is
demo → signup (`src=demo`) → first parcel.

---

## Search

`?demo=1` gets `noindex`. It must not compete with the real portal in search
results, and a crawler should never index sample parcels as if they were a
merchant's own.

---

## Build order

| Phase | Work | Risk |
|---|---|---|
| 1 | Demo boot: flag, gate bypass, shim, banner | Gate ordering — must return before `getSession()` |
| 2 | Fixture: 5 parcels, wallet, ledger, invoice, ticket | None — static data |
| 3 | Write-blocking + conversion prompts | Must catch every write path |
| 4 | Scripted AI transcript | None — offline |
| 5 | Mobile pass at 375px, FAB fix, safe areas | The finding-18 overlap |
| 6 | Entry button on `index.html` beside the signup CTA | None |
| 7 | Attribution + `noindex` | None |

Phases 1–3 are the whole risk. Everything after is content and polish.

---

## Verification before it ships

- Demo loads with **no session and no network call to Supabase** — proved from
  the network panel, not by reading the code.
- Every button that writes in the real portal produces the conversion prompt in
  demo, and **zero rows are created** — checked against live table counts before
  and after a full click-through.
- A real merchant session is completely unaffected: `client.html` without
  `?demo=1` authenticates exactly as today.
- 375×812: no horizontal scroll, bottom nav reachable, banner clear of both safe
  areas, FAB not covering content.
- Bundle growth under 20 KB, and the `?v=` cache-buster bumped — otherwise the
  installed service worker serves the old bundle and nobody sees it.

---

## What this does not do

It converts interest that already exists. It does not create it. If ten sellers
a day reach the landing page, this might turn more of them into merchants — it
will not by itself produce the 100 that were asked about. The honest claim is
narrower and still worth building: **the portal is the strongest asset, and
right now nobody can see it without signing up first.**
