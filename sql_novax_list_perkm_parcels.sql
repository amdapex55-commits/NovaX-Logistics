-- =====================================================================
-- NovaX — every parcel that was priced per kilometre, one row each
--
-- ENTIRELY READ-ONLY. Four listings, no writes of any kind.
--
-- "Not invoiced" is taken from parcels.invoice_id being null. A parcel with
-- no invoice cannot have been paid, so that is also the "not marked paid"
-- filter -- it is the strictest reading and it needs no join.
--
-- Every status is included: New booked, collected, in transit, out for
-- delivery, delivered-but-not-invoiced, refused, returns. Nothing is
-- filtered by status anywhere in this file.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE LIST — every un-invoiced parcel that is not at flat 200,
--    one row per parcel, newest first.
--
--    priced_by = how the fee was arrived at. 'PER KM' means the distance
--    engine set it. 'rate card' means it came from the merchant's stored
--    rate -- a Lahore parcel at 260 is this, not distance.
-- ---------------------------------------------------------------------
select p.awb,
       c.name                                    as merchant,
       p.city,
       p.status,
       p.fee                                     as charged_now,
       200                                       as should_be,
       (coalesce(p.fee, 0) - 200)                as overcharged_by,
       case
         when p.pricing_mode like 'distance%' or p.distance_km is not null then 'PER KM'
         else 'rate card'
       end                                       as priced_by,
       p.distance_km,
       p.meta ->> 'weight'                       as weight,
       p.cod_amount,
       to_char(p.booked_at at time zone 'Asia/Karachi', 'DD Mon HH24:MI') as booked,
       p.meta ->> 'repricedFrom'                 as already_repriced_from
from public.parcels p
left join public.clients c on c.id = p.client_id
where p.invoice_id is null
  and coalesce(p.fee, 0) <> 200
order by (p.pricing_mode like 'distance%') desc, p.booked_at desc;


-- ---------------------------------------------------------------------
-- 2. Same set, counted — so you know the size before acting
-- ---------------------------------------------------------------------
select case
         when p.pricing_mode like 'distance%' or p.distance_km is not null then 'PER KM'
         else 'rate card'
       end                          as priced_by,
       p.city,
       count(*)                     as parcels,
       min(p.fee)                   as lowest,
       max(p.fee)                   as highest,
       sum(coalesce(p.fee,0) - 200) as total_overcharged
from public.parcels p
where p.invoice_id is null
  and coalesce(p.fee, 0) <> 200
group by 1, 2
order by count(*) desc;


-- ---------------------------------------------------------------------
-- 3. Per-km parcels that are ALREADY INVOICED
--
--    These are NOT in listing 1 and are NOT repriced by anything I have
--    given you. Their fee sits inside a statement the merchant has already
--    read, and may already have been paid against. Changing one silently
--    puts the invoice and the parcel out of step.
--
--    Look at this list and decide per merchant: leave it, or credit them
--    the difference through Add to Wallet with the AWB in the reason.
-- ---------------------------------------------------------------------
select p.awb,
       c.name                     as merchant,
       p.city,
       p.status,
       p.fee                      as charged,
       (coalesce(p.fee,0) - 200)  as over_flat_200,
       p.distance_km,
       p.invoice_id,
       to_char(p.invoiced_at at time zone 'Asia/Karachi', 'DD Mon HH24:MI') as invoiced_at
from public.parcels p
left join public.clients c on c.id = p.client_id
where p.invoice_id is not null
  and (p.pricing_mode like 'distance%' or p.distance_km is not null)
order by p.invoiced_at desc nulls last;


-- ---------------------------------------------------------------------
-- 4. Leftovers: parcels still CARRYING per-km markings even though the
--    fee already reads 200.
--
--    The reprice only touched rows whose fee was not 200, so a distance
--    parcel that happened to work out to exactly 200 kept its
--    pricing_mode and its distance_km. Harmless to the merchant's bill,
--    but it is why a "35.05 km" badge can still appear beside a 200 fee
--    in the admin list.
-- ---------------------------------------------------------------------
select p.awb, c.name as merchant, p.city, p.status, p.fee,
       p.pricing_mode, p.distance_km
from public.parcels p
left join public.clients c on c.id = p.client_id
where p.invoice_id is null
  and coalesce(p.fee, 0) = 200
  and (p.pricing_mode like 'distance%' or p.distance_km is not null)
order by p.booked_at desc;
