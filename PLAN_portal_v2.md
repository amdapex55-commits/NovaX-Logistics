# Plan — dark default, parcel editing, tickets, honest money

Six items. Four are pure `client.html` and ship without touching the database.
One needs a new RPC. One is blocked on a function body that only exists in the
deployed database.

---

## 1. Dark mode is the default for everyone

### What is actually wrong

Two theme systems disagree, and the later one wins.

`client.html:45` — the head boot script:

```js
var savedTheme = localStorage.getItem("novaxTheme");
if (savedTheme === "light") { ...light... } else { ...dark... }
```

No saved value means dark. Correct.

`client.html:13411` — the `NovaXTheme` controller, which runs ~13,000 lines
later and calls `apply(stored())`:

```js
function stored(){ return localStorage.getItem(KEY) || "system"; }
function effective(mode){
  if(mode==="dark"||mode==="light") return mode;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
```

No saved value means `"system"`, and `effective("system")` asks the device.
On a merchant's light-mode laptop that resolves to **light**, and it
overwrites the `data-theme="dark"` the boot script just set.

So today a merchant who has never touched the toggle sees a dark flash, then
a light portal. The default does not work.

### Fix

In the `NovaXTheme` controller only:

- `stored()` defaults to `"dark"` instead of `"system"`.
- A stored `"system"` is migrated to `"dark"` on read. Someone who chose
  "follow my device" did not choose Light, and the rule is dark-until-Light.
- `effective()` no longer consults `prefers-color-scheme` — nothing reaches it.
- `cycle()` becomes two-state: `["dark","light"]`.
- Drop the `prefers-color-scheme` change listener; it has nothing left to do.
- `nvSyncThemeButton()` (line 3400) loses its three-state face/label map.

The head boot script stays exactly as it is — it is what prevents the white
flash before the stylesheet lands.

### Note

`admin.html` carries the dark CSS but has **no** theme boot script and no
toggle. This item is scoped to the merchant portal. Say the word if ops
should get it too.

---

## 2. Printing forces light, then restores

### What is actually wrong

`client.html:513`:

```css
@media print{ body{ margin:0 !important; background:var(--nvu-bg) !important; } }
```

In dark mode `--nvu-bg` is dark, and the label bodies use the same tokens. So
the AWB prints on a dark ground. Once dark is the default (item 1) this stops
being an edge case and becomes what every merchant hits on their first print.

There are **five** print entry points, not one:

| Line | Function | What it prints |
|---|---|---|
| 4696 | `printLabels()` | AWB labels — the button you named |
| 4854 | `nvPrintDoc()` | Wallet receipts / statements |
| 5326 | `printInvoice()` | Invoice |
| 5349 | `exportReportPdf()` | Full report |
| 4719 | `printAwb()` | delegates to `printLabels` |

All five have the same bug, so all five get the fix.

### Fix

Stamp `data-theme="light"` on `<html>` immediately before `window.print()`,
and restore the previous value in each function's **existing** cleanup path.

`printLabels()` already owns `window.onafterprint` and a 1500ms fallback.
`nvPrintDoc()` already owns an `afterprint` listener and an 8000ms fallback.
The restore hooks into those, rather than adding a second competing listener
that would fight them.

Plus, belt and braces, in the print block:

```css
@media print{ :root{ color-scheme:light; } }
```

**Risk, flagged:** the document repaints light for one frame before the print
dialog opens. Everything except the print stage is already
`visibility:hidden` in print, so this is a brief flash, not a visual break.

---

## 3. Edit a parcel, only while it is New booked

### What exists to build on

`isCancellableBooking()` at line 7309 is already the exact gate you described:

```js
if(String(p.status||"") !== "New booked") return false;
if(p.invoiceId) return false;             // already billed
if(p.rider || p.riderId) return false;    // a rider is already assigned
```

Editing gets the same three conditions.

### The problem nobody would hit until it was too late

`sql_novax_rls_hardening.sql` — the file still waiting to be applied —
installs `nv_freeze_parcel_money`, a BEFORE UPDATE trigger on `parcels`:

```sql
if new.cod_amount is distinct from old.cod_amount then
  raise exception 'COD amount cannot be changed after booking...';
end if;
```

**That trigger blocks COD editing.** Build the edit feature today, apply the
hardening next week, and editing silently breaks with a confusing error. The
two changes have to land together.

### Fix — server

New file `sql_novax_client_edit_parcel.sql`, one SECURITY DEFINER RPC:

`client_edit_new_booked_parcel(p_awb, p_consignee, p_phone, p_address, p_city, p_cod, p_weight, p_category, p_fragile, p_order_id, p_reference_no)`

It:

1. Re-checks the parcel belongs to the caller's client. The browser gate is
   not the security boundary — same reasoning as `delete_new_booked_parcel`.
2. Refuses unless `status = 'New booked'`, `invoice_id is null`, no rider.
3. **Never touches `fee`.** Not a parameter, not in the UPDATE.
4. Sets `set_config('novax.parcel_edit','1', true)` — transaction-local — so
   the freeze trigger allows this one path through for `cod_amount`.
5. Appends a `{field, from, to, at}` row to `meta.editHistory` so an edited
   COD is never a mystery to ops later.

And an amendment to `sql_novax_rls_hardening.sql`: `nv_freeze_parcel_money`
honours that GUC for `cod_amount` **only**. `fee` and `client_id` stay frozen
against everything except an admin, permanently. The hole that file was
written to close stays closed.

City is editable because pricing is flat Rs 200 everywhere now — there is no
price consequence to a city change any more.

### Fix — client

- `isEditableBooking(p)` mirroring `isCancellableBooking(p)`.
- "Edit" button beside the existing "Cancel booking" on the parcel card
  (line 4200), and in the drawer actions (line 3993).
- Modal, pre-filled from the parcel. Delivery charge shown **read-only** with
  a line saying it is fixed at booking.
- Save calls the RPC, then `loadAll()`. No optimistic local write — the
  server is the truth, and a failed edit must not leave a wrong number on
  screen.
- The button disappears the moment status moves, because the render reads
  live status.

---

## 4. Create a ticket from any parcel that has moved

### Good news: no SQL at all

`novax_ticket_open(p_subject, p_body, p_awb, p_priority)` already exists and
already takes an AWB (`client.html:7530`). The form is at line 2438.

### Fix

- `canRaiseTicket(p)` = `status !== "New booked"`. Exactly the inverse of the
  edit gate, as you asked.
- "Report an issue" button on the parcel card, in the drawer actions, and on
  the dashboard's Action Needed list — that covers "home screen or parcel tab".
- The handler switches to the Tickets tab, pre-fills `#nvTkAwb` with the AWB
  and `#nvTkSubject` with `Issue with <AWB> — <current status>`, then scrolls
  to and focuses the subject so she can just start typing.
- Hidden for roles that cannot see the Tickets tab — `nvCanUseTab()` already
  knows (Rider-side roles at line 8374 differ).

---

## 5. Money tab counting New booked as money on its way

### Why this one is not a code change I can just make

The panel is at `client.html:3303`:

```js
'<div class="nv-inc-lbl">On its way to you</div>'
```

Every number in it — `in_transit_amount`, `in_transit_count`,
`on_the_way_amount` — comes from `sb.rpc("client_wallet_incoming")`. That
function's body **exists only in the deployed database**. It is not in this
repo, and PROJECT_HISTORY §3.1 lists it as exactly the trap that has already
cost real time.

I cannot see whether New booked is inside `in_transit_amount`, and I will not
write a blind `CREATE OR REPLACE` — that is precisely what took bookings down
on 22 Aug when a changed argument list created a second overloaded function
instead of replacing the first.

There is also a rule written into that very code block forbidding browser-side
arithmetic on server numerics, so subtracting a locally-computed New booked
total is not a legitimate workaround.

### Step 1 — read-only, safe to run on production

```sql
select pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'client_wallet_incoming'
  and p.prokind = 'f';
```

Paste the output back and I write the exact-signature replacement that drops
`status = 'New booked'` out of `in_transit_amount` / `in_transit_count`, and
therefore out of `on_the_way_amount`.

### Step 2 — what I can fix today with no database access

The Reports tab has the same confusion, computed **locally**, so it needs no
SQL. `client.html:4416`:

```js
const pendingCod = cm.parcels.filter(p=>!isDeliveredLedgerParcel(p))
                             .reduce((s,p)=>s+p.cod,0);
```

That sweeps New booked parcels into "Pending COD" and presents them as money.
Splitting it into "In transit" and a separate, plainly non-money "Booked, not
picked up yet" can ship immediately.

Once the RPC is fixed, the Money tab gets a matching neutral chip — a count,
never a rupee figure — so a booked parcel is visible without pretending to be
cash.

---

## 6. Delivery ratio must not count New booked

### What is actually wrong

`clientMetrics()` at `client.html:2898`:

```js
const delivered = parcels.filter(p=>p.status.includes("Delivered")).length;
return { parcels, delivered, total: parcels.length, ... };
```

and then, twice — dashboard line 3932 and reports line 4417:

```js
const rate = percent(cm.delivered, cm.total);
```

The denominator is every parcel including ones booked five minutes ago that
no rider has touched. Book ten parcels on a good morning and your delivery
rate craters. Worse, line 3938 and line 4441 both paint it amber below 40–45%,
so booking volume triggers a warning colour on your own dashboard.

### Fix

Add `ratedTotal` to `clientMetrics()` — parcels excluding `New booked` and
`Cancelled by client` (a booking you cancelled is not a delivery NovaX
failed). `rate` uses `ratedTotal`. `cm.total` is untouched, so the "My
Parcels" count still shows everything.

Captions change from `"delivered parcels"` to `"of N picked-up parcels"`, so
the denominator is on screen instead of being guessed at.

### One decision for you

Strictly, a delivery *success rate* is `delivered ÷ parcels that reached an
outcome` — it would also exclude parcels still in transit, since those have
not succeeded or failed yet. That number is more honest but moves around less
predictably day to day.

My default is the narrower change you asked for: **exclude New booked and
Cancelled, keep in-transit in the denominator.** Tell me if you want the
stricter version instead.

---

## Order of work

**Ships today, client-side only, no database, no risk to live bookings:**
1. Dark default (item 1)
2. Print forces light (item 2)
3. Ticket button (item 4)
4. Delivery ratio (item 6)
5. Reports-tab Pending COD split (item 5, step 2)

**Needs SQL, one new file plus the hardening amendment:**
6. Parcel editing (item 3)

**Blocked until you paste the function body:**
7. Money tab "On its way to you" (item 5, step 1)

Items 1–5 are one commit and one push. Nothing in them can affect booking.
