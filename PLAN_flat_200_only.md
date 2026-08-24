# Plan — remove per-kilometre pricing, flat Rs 200 everywhere

**Status: not started. Agreed 2026-08-24, to be executed next session.**

## What we are changing it to

- Every parcel, every city, every merchant: **Rs 200 flat**.
- **No pricing choice.** Merchants are not asked, admins do not assign.
- **No area selectors** on the booking form — neither pickup nor delivery.
- **New signups get Rs 200 flat automatically**, with no step that can leave
  them on anything else.
- Nothing anywhere refers to kilometres.

Today Zone A (Karachi) is Rs 200 and Zone B is Rs 180, so **Lahore goes up to
200** as part of this — that is a real price change for existing Lahore
merchants, not just a cleanup.

## Why the ordering below is what it is

Two things from PROJECT_HISTORY drive it:

**§3.3** — on 2026-08-22 a `BEFORE INSERT` trigger that guessed at a pricing
column refused ordinary bookings for a live merchant, and client bookings were
down until it was dropped by hand. So: **no new trigger enforces this.** We
change data and let the existing, working RPC price from it.

**§3.1** — most RPC bodies live only in the deployed database. So every step
reads the real function before assuming what it does, and **nothing is
dropped** — a dormant function costs nothing, and we lost bookings to a
function-signature problem as recently as this morning.

Order: **data → server default → UI**. After the data step nothing new can be
priced per-km even if every line of UI stays exactly as it is. That means at no
point are we relying on a front-end change to protect a merchant's invoice.

## Where per-km currently lives

**Database**
| Object | What it does | Fate |
|---|---|---|
| `clients.pricing_mode` | `'flat'` / `'distance'` | force `'flat'`, keep column |
| `clients.rate`, `clients.rate_card` | zone rates, A=200 B=180 | both zones → 200 |
| `client_book_parcel` | flat pricing; has `coalesce(v_rate, 250)` | fix the 250 |
| `client_book_parcel_geo` | applies the distance fee | goes dormant, keep |
| `client_pricing_choice_state` | decides if the chooser appears | return `eligible:false` |
| `client_set_pricing_choice` | merchant writes their choice | keep, unreachable |
| `admin_set_client_pricing_mode` | admin writes it | keep, unreachable |
| `novax_quote_booking` | live per-km quote | keep, unreachable |
| `novax_areas`, `novax_areas_list` | Karachi area map | keep, unused |
| `create_client_workspace` | makes a new merchant | must default 200 / flat |
| `parcels.distance_km`, `parcels.pricing_mode` | per-parcel record | keep for history |

**client.html** — `nvPricingMode()`, `nvGeoActive()`, the `nvpm` chooser modal,
the delivery-area picker, the pickup-area block, `nvAwbDistanceField()` on the
AWB label, the `destAreaId` argument in `__novaxBookParcel`, and the separate
area-resolution path in **bulk booking** (the CSV importer resolves an area per
row — easy to miss, and it is a second code path, not a reuse of the first).

**admin.html** — the per-client `Rate: Flat / Rate: Per-km` dropdown,
`nvSetClientPricingMode()`, `nvClientPricingMode()`, the distance-pricing and
coverage panel, the per-km rate-card hint, the km column in parcel rows, and
the guard that blocks admin booking for per-km merchants (which becomes dead
code worth removing, since it currently *prevents* ops booking for them).

## Phase 0 — read before writing (read-only, ~5 min)

Three unknowns that change the later steps. All are in the database, none are
in this repo.

```sql
-- 1. Who is actually on per-km, and what are they paying?
SELECT id, name, rate, pricing_mode,
       rate_card->'A'->>'overnight' AS zone_a,
       rate_card->'B'->>'overnight' AS zone_b
FROM clients ORDER BY pricing_mode, name;

-- 2. Does geo re-check pricing_mode server-side, or does it price by distance
--    whenever it receives area ids? This decides whether Phase 3 is needed.
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'client_book_parcel_geo';

-- 3. What rate does a brand new merchant get today?
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'create_client_workspace';
```

**Save the output of 2 and 3 into this repo** before editing either. They exist
nowhere else.

## Phase 1 — the data (SQL, reversible, stops per-km immediately)

```sql
-- Everyone flat.
UPDATE clients SET pricing_mode = 'flat'
WHERE pricing_mode IS DISTINCT FROM 'flat';

-- Both zones Rs 200. Read the count first, the way sql_novax_zoneA_200.sql does.
UPDATE clients
SET rate = 200,
    rate_card = jsonb_set(
      jsonb_set(coalesce(rate_card, '{}'::jsonb),
                '{A,overnight}', '200'::jsonb, true),
                '{B,overnight}', '200'::jsonb, true);
```

Then `client_book_parcel`: change `coalesce(v_rate, 250)` to `200`. **250 is a
stale constant** — §3.5 records 250/240/180 reappearing repeatedly — and today
any client with a NULL rate is silently charged 250.

Requires `CREATE OR REPLACE` with the **whole body**, which we have from this
morning's overload fix. Keep the 14-argument signature exactly; changing the
argument list creates a second overload, which is what took bookings down.

After this step a Karachi parcel prices at 200 and a Lahore parcel at 200,
whatever the UI sends.

## Phase 2 — new signups (SQL)

`create_client_workspace` must set `rate = 200`, `pricing_mode = 'flat'` and a
rate card with A and B both 200. Phase 0 query 3 tells us what it does now.
This is the step that makes "every signup automatic 200" true at the source
rather than by a later correction.

## Phase 3 — server-side enforcement (only if Phase 0 says so)

If `client_book_parcel_geo` prices by distance purely because it received area
ids, then a stale browser tab could still book per-km after Phase 1. In that
case make geo read `clients.pricing_mode` and fall through to flat when it is
not `'distance'`. With every client flat, that makes geo permanently
equivalent to the flat path — no behaviour change, just no way back in.

**Do not** add a trigger. See §3.3.

## Phase 4 — client.html

Remove, in this order (each is safe once Phase 1 has landed):

1. **The chooser.** Cheapest kill is Phase 2 of the old plan — have
   `client_pricing_choice_state` return `eligible:false` — but since we are
   editing anyway, delete the `nvpm` modal and its boot call outright.
2. **The delivery-area picker** and the pickup-area block on the booking form.
3. **`destAreaId`** from `__novaxBookParcel`, so the geo RPC is never called.
4. **The bulk-booking area resolution** — separate code path, same removal.
5. **`nvAwbDistanceField()`** so no AWB label prints a Distance row.
6. **`nvPricingMode()` / `nvGeoActive()`** last — they are the gates everything
   else calls, so removing them first breaks the callers.

Run the §7 parse harness after each file edit, not just at the end.

## Phase 5 — admin.html

1. The `Rate: Flat / Rate: Per-km` dropdown from the client card.
2. `nvSetClientPricingMode` and `nvClientPricingMode`.
3. The distance-pricing / coverage panel.
4. The per-km branch in the rate-card hint.
5. The km badge on parcel rows.
6. **The guard that blocks admin booking for per-km merchants** — with no per-km
   merchants left it is dead, and today it stops ops booking for them at all.

## Phase 6 — verify

Not "it looks right" — book real parcels:

- [ ] Karachi parcel from the merchant portal → **Rs 200**
- [ ] Lahore parcel → **Rs 200**
- [ ] A third city → **Rs 200**
- [ ] Admin books for a merchant → **Rs 200**, no guard fires
- [ ] Bulk CSV import → every row Rs 200
- [ ] Brand new signup → `rate=200`, `pricing_mode='flat'`, books at 200
- [ ] No pop-up on merchant login
- [ ] No area selector on the booking form
- [ ] AWB label has no Distance row
- [ ] `grep -ic "per-km\|per kilometre\|distance_km" client.html admin.html` → only dormant/no hits

## Decisions already taken

- **Existing per-km parcels keep their fee.** N0530002 stays Rs 180. No
  retro-pricing.
- **Nothing is dropped** — columns, functions and `novax_areas` all stay.
- **Lahore goes 180 → 200.** Existing Lahore merchants are being raised; worth
  telling them before they notice on an invoice.

## Rollback

Phase 1 is one `UPDATE` away from reverting per client. Phases 4 and 5 are a
`git revert`. Because nothing is dropped, a full rollback needs no migration —
set `pricing_mode='distance'` on the affected clients and restore the UI commit.
