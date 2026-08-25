-- =====================================================================
-- NovaX — what is actually pricing your parcels?
--
-- READ-ONLY. Five questions, five answers. Nothing is changed.
--
-- novax_parcel_autoprice() is a BEFORE INSERT trigger on parcels. It runs
-- on EVERY booking and decides the fee. The booking form does not decide
-- the fee -- this does. Retiring per-km in the UI did not touch it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Q1. Is distance pricing switched ON in the server config?
--
--     If `enabled` is true, per-km pricing is live regardless of what the
--     booking form shows. This is the single most important answer here.
-- ---------------------------------------------------------------------
select public.novax_pricing_config_get() as pricing_config;


-- ---------------------------------------------------------------------
-- Q2. What have you ACTUALLY been charging, these last 30 days?
--
--     If flat Rs 200 were really in force, this is one row: fee = 200.
--     Every extra row is a price the flat rule did not produce.
-- ---------------------------------------------------------------------
select p.fee,
       count(*) as parcels,
       count(distinct p.client_id) as merchants,
       min(p.booked_at)::date as first_seen,
       max(p.booked_at)::date as last_seen
from public.parcels p
where p.booked_at > now() - interval '30 days'
group by p.fee
order by count(*) desc;


-- ---------------------------------------------------------------------
-- Q3. Same question, but only since you "fixed the rate card".
--
--     Any fee other than 200 appearing here was priced AFTER the fix,
--     which means the fix did not reach the thing that sets prices.
-- ---------------------------------------------------------------------
select p.fee, count(*) as parcels, max(p.booked_at) as most_recent
from public.parcels p
where p.booked_at > now() - interval '36 hours'
group by p.fee
order by max(p.booked_at) desc;


-- ---------------------------------------------------------------------
-- Q4. What rate is stored against each merchant?
--
--     rate = what a new booking falls back to. If any of these still say
--     250 or 240 or 180, new signups are still being priced at the old
--     numbers no matter what the booking form says.
-- ---------------------------------------------------------------------
select c.name,
       c.rate,
       c.pricing_mode,
       c.rate_card,
       count(p.id) as parcels_booked
from public.clients c
left join public.parcels p on p.client_id = c.id
group by c.id, c.name, c.rate, c.pricing_mode, c.rate_card
order by c.rate nulls first, c.name;


-- ---------------------------------------------------------------------
-- Q5. The pricing code itself -- send this one to me.
--
--     This is the trigger that sets the fee, plus the quote engine it
--     leans on. I cannot safely change either without reading them; a
--     wrong guess here misprices every parcel booked afterwards.
-- ---------------------------------------------------------------------
select p.proname, pg_get_functiondef(p.oid) as body
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in ('novax_parcel_autoprice', 'novax_quote_fee', 'nv_enforce_pricing_mode')
order by p.proname;
