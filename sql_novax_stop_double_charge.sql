-- =====================================================================
-- NovaX — stop the prepaid double charge. Settle nothing.
--
-- This file does TWO things and deliberately nothing else:
--   1. reports who has been double-charged and by how much  (read-only)
--   2. stops it happening again                             (one statement)
--
-- It does NOT refund anybody. No money moves. Refunds are handled by hand
-- through Admin > Finance > Add to Wallet, per merchant, when they ask.
-- (sql_novax_invoice_single_source.sql is the version that also settles.
--  Do not run that one unless you have changed your mind about settling.)
--
-- NOTHING IS DELETED. The only write is a DROP TRIGGER, which removes
-- behaviour, not data. No table, column, parcel, invoice, ledger row or
-- client record is touched. There is no DELETE, TRUNCATE, ALTER or DROP
-- TABLE anywhere in this file.
--
-- THE BUG
--   A prepaid parcel collects no cash, so the merchant owes the delivery
--   fee. Two systems were both collecting it: the trigger posted it to the
--   wallet at delivery, AND the invoice netted the same fee inside
--   "charges". KKM's INV-26082350ad3: Rs 1,775 collected - Rs 720 charges =
--   Rs 1,055 payable, then 200 + 320 taken from the wallet again = Rs 535.
--
--   The invoice wins. Its statement is complete and is what the merchant
--   reads. So the trigger stops and the invoice keeps netting.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1 — your manual refund worklist  (read-only, changes nothing)
--
--   owed_to_merchant = what to credit them through Add to Wallet when they
--                      ask. Use this figure and paste the invoice ref into
--                      the reason box so the ledger explains itself later.
--
--   safe_to_refund   = the ledger and the parcels agree, both definitions
--                      of "prepaid" agree, and their books currently
--                      balance. If this is false, do NOT just credit the
--                      number -- look at that merchant properly first.
--
--   already_credited = positive admin adjustments already on their wallet.
--                      If this already covers owed_to_merchant, they have
--                      been paid; do not pay again.
-- ---------------------------------------------------------------------
with charged as (
  select l.client_id, sum(l.amount) as ledger_charged
  from public.wallet_ledger l
  where l.entry_type = 'delivery_charge_due' and l.affects_balance
  group by l.client_id
),
dupes as (
  select p.client_id, sum(p.fee) as invoiced_dupes, count(*) as prepaid_parcels
  from public.parcels p
  where p.invoice_id is not null
    and coalesce(p.cod_amount, 0) = 0
    and coalesce(p.fee, 0) > 0
  group by p.client_id
),
by_meta as (
  -- cod_amount = 0 is only a proxy for "prepaid"; meta.paymentMode is what
  -- the merchant actually chose at booking. If these disagree, the number
  -- is not trustworthy for that merchant.
  select p.client_id, sum(p.fee) as by_meta_dupes
  from public.parcels p
  where p.invoice_id is not null
    and coalesce(p.meta ->> 'paymentMode', 'COD') <> 'COD'
    and coalesce(p.fee, 0) > 0
  group by p.client_id
),
led as (
  select l.client_id, sum(l.amount) as ledger_sum
  from public.wallet_ledger l
  where l.affects_balance
  group by l.client_id
),
manual as (
  select l.client_id, sum(l.amount) as manual_credits
  from public.wallet_ledger l
  where l.entry_type = 'admin_adjustment' and l.affects_balance and l.amount > 0
  group by l.client_id
)
select c.name,
       c.wallet_balance,
       coalesce(d.invoiced_dupes, 0)  as owed_to_merchant,
       coalesce(d.prepaid_parcels, 0) as prepaid_parcels_on_invoices,
       coalesce(mn.manual_credits, 0) as already_credited,
       (   -ch.ledger_charged = d.invoiced_dupes
        and coalesce(m.by_meta_dupes, 0) = d.invoiced_dupes
        and c.wallet_balance is not distinct from coalesce(led.ledger_sum, 0)
       ) as safe_to_refund
from public.clients c
join      dupes   d   on d.client_id   = c.id
left join charged ch  on ch.client_id  = c.id
left join by_meta m   on m.client_id   = c.id
left join led         on led.client_id = c.id
left join manual  mn  on mn.client_id  = c.id
where coalesce(d.invoiced_dupes, 0) > 0
order by coalesce(d.invoiced_dupes, 0) desc;


-- ---------------------------------------------------------------------
-- PART 2 — stop it happening again
--
-- Removes the trigger only. The FUNCTION it calls is left in place, so
-- putting this back is a single statement if it turns out to be wrong:
--
--   create trigger trg_parcels_post_non_cod_delivery_charge
--     before insert or update on public.parcels
--     for each row execute function public.trg_post_non_cod_delivery_charge();
--
-- From here the invoice generator is the only thing that charges for a
-- delivery. A prepaid parcel that is delivered but not yet invoiced now
-- carries no wallet charge until its invoice is generated -- which is what
-- the merchant's "Being counted / delivered, not released yet" figure is
-- already for.
-- ---------------------------------------------------------------------
drop trigger if exists trg_parcels_post_non_cod_delivery_charge on public.parcels;


-- ---------------------------------------------------------------------
-- PART 3 — confirm it is gone (read-only)
-- ---------------------------------------------------------------------
select count(*) as trigger_still_present
from pg_trigger
where tgrelid = 'public.parcels'::regclass
  and tgname = 'trg_parcels_post_non_cod_delivery_charge';
-- expect 0
