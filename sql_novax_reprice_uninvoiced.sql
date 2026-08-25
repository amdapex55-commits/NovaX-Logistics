-- =====================================================================
-- NovaX — find every un-invoiced Karachi parcel and reprice it to flat 200
--
-- PART 1 is read-only: the list.
-- PART 2 does the repricing. Read part 1's output before running it.
--
-- WHY A PLAIN `update parcels set fee = 200` WILL FAIL
--
--   trg_nv_freeze_parcel_money is live on your parcels table. It raises
--   'Delivery fee cannot be changed from the portal' on ANY fee change
--   unless is_admin() returns true. In the Supabase SQL editor auth.uid()
--   is NULL, so is_admin() is false and the trigger refuses you as readily
--   as it refuses a merchant. That guard is doing its job -- it is the one
--   stopping merchants zeroing their own delivery fees -- so part 2
--   suspends it for the length of one statement and puts it straight back.
--
-- WHAT COUNTS AS REPRICEABLE
--   * destination city is Karachi
--   * invoice_id is null -- not yet billed, so nothing downstream moves
--   Every status is included, exactly as asked: New booked, in transit,
--   out for delivery, delivered-but-not-invoiced, returns, all of it.
--
--   An INVOICED parcel is deliberately excluded. Its fee is already inside
--   a statement the merchant has read and possibly been paid against;
--   changing it silently would put the invoice and the parcel out of step.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1 — the list (read-only)
-- ---------------------------------------------------------------------
select p.awb,
       c.name                       as merchant,
       p.status,
       p.city,
       p.fee                        as fee_now,
       200                          as fee_after,
       (200 - coalesce(p.fee, 0))   as difference,
       p.pricing_mode,
       p.distance_km,
       p.meta ->> 'weight'          as weight,
       p.cod_amount,
       p.booked_at::date            as booked
from public.parcels p
left join public.clients c on c.id = p.client_id
where lower(coalesce(p.city, '')) = 'karachi'
  and p.invoice_id is null
  and coalesce(p.fee, 0) <> 200
order by p.booked_at desc;


-- ---- summary of the same thing, so you can see the shape at a glance ----
select count(*)                                   as parcels_to_reprice,
       count(*) filter (where p.pricing_mode like 'distance%') as priced_by_distance,
       min(p.fee)                                 as lowest_fee_now,
       max(p.fee)                                 as highest_fee_now,
       sum(200 - coalesce(p.fee, 0))              as total_change_to_charges
from public.parcels p
where lower(coalesce(p.city, '')) = 'karachi'
  and p.invoice_id is null
  and coalesce(p.fee, 0) <> 200;


-- ---- and the same question for OTHER cities, since flat 200 was meant ----
-- ---- to be everywhere. Reported, not changed. Decide separately.      ----
select coalesce(p.city, '(none)') as city,
       count(*) as uninvoiced_not_200,
       min(p.fee) as lowest, max(p.fee) as highest
from public.parcels p
where lower(coalesce(p.city, '')) <> 'karachi'
  and p.invoice_id is null
  and coalesce(p.fee, 0) <> 200
group by p.city
order by count(*) desc;


-- ---------------------------------------------------------------------
-- PART 2 — reprice. Everything below runs as one transaction.
--
-- distance_km, quoted_fee, pricing_mode and rate_version are cleared too.
-- Leaving them behind is how a parcel ends up charged 200 while the admin
-- list still shows a "35.05 km" badge next to it.
--
-- NOTHING IS DELETED. One UPDATE, on one table, on rows that have no
-- invoice. No parcel, client, invoice or ledger row is removed, and no
-- wallet balance is touched.
-- ---------------------------------------------------------------------
begin;

alter table public.parcels disable trigger trg_nv_freeze_parcel_money;

update public.parcels p
   set fee          = 200,
       quoted_fee   = 200,
       distance_km  = null,
       pricing_mode = 'flat',
       rate_version = 'flat-v1',
       meta         = coalesce(p.meta, '{}'::jsonb)
                      || jsonb_build_object(
                           'repricedAt',   to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
                           'repricedFrom', coalesce(p.fee, 0),
                           'repricedWhy',  'Flat Rs 200; distance pricing retired')
 where lower(coalesce(p.city, '')) = 'karachi'
   and p.invoice_id is null
   and coalesce(p.fee, 0) <> 200;

alter table public.parcels enable trigger trg_nv_freeze_parcel_money;

commit;


-- ---------------------------------------------------------------------
-- PART 3 — verify (read-only)
-- ---------------------------------------------------------------------
-- Expect 0 rows: nothing un-invoiced in Karachi is priced anything but 200.
select p.awb, p.fee, p.pricing_mode, p.distance_km
from public.parcels p
where lower(coalesce(p.city, '')) = 'karachi'
  and p.invoice_id is null
  and coalesce(p.fee, 0) <> 200;

-- The guard MUST be back on. If this says false, re-enable it immediately:
--   alter table public.parcels enable trigger trg_nv_freeze_parcel_money;
select tgname,
       (tgenabled <> 'D') as trigger_is_enabled
from pg_trigger
where tgrelid = 'public.parcels'::regclass
  and tgname = 'trg_nv_freeze_parcel_money';
