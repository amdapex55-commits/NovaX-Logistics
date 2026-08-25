-- =====================================================================
-- NovaX -- "On its way to you" stops counting parcels nobody has collected
--
-- The Money tab's headline figure comes from client_wallet_incoming(), and
-- its in_transit list began with 'New booked'. So the moment a merchant
-- booked a parcel, its full COD value appeared under "On its way to you" --
-- before a rider had touched it, before any cash existed, and while the
-- merchant could still cancel it outright.
--
-- One status removed from one list. Nothing else in this function changes:
-- the body below is the deployed source verbatim, with that single edit and
-- its comment corrected to match.
--
-- The signature is IDENTICAL and takes no arguments, so CREATE OR REPLACE
-- genuinely replaces rather than overloading. Verify with the query at the
-- bottom regardless -- an overloaded client_book_parcel is what took
-- bookings down on 2026-08-22.
--
-- Merchants will see "On its way to you" DROP by the COD value of whatever
-- they currently have booked-but-not-collected. That is a correction, not a
-- loss: the money reappears the moment a rider actually collects.
-- =====================================================================

create or replace function public.client_wallet_incoming() RETURNS TABLE(in_transit_amount numeric, in_transit_count integer, delivered_uncleared numeric, delivered_uncleared_count integer, on_the_way_amount numeric, available_balance numeric, inflow_4w jsonb, outflow_4w jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Money still moving toward the merchant: COLLECTED through to
  -- out-for-delivery, plus the recoverable exception states that can still
  -- convert to a delivery. Return-flow statuses are excluded because that
  -- COD is never going to be collected.
  --
  -- 'New booked' was in this list and is deliberately no longer. A parcel
  -- nobody has picked up is not money on its way to anyone -- no rider
  -- holds it, no cash exists anywhere in the system for it, and the
  -- merchant can still cancel or edit it. Counting its face value under
  -- "On its way to you" told merchants they were owed money that had not
  -- been created yet, and it moved every time they booked rather than every
  -- time NovaX collected.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into in_transit_amount, in_transit_count
    from public.parcels p
   where p.client_id = v_client_id
     and coalesce(p.cod_amount, 0) > 0
     and p.status in (
       'Collected by rider', 'Arrived at warehouse',
       'Parcel now in transit', 'Parcel received at destination',
       'Parcel out for delivery', 'Reattempt', 'Reassigned',
       'Consignee not available'
     );

  -- Delivered and collected, but not yet turned into an invoice credit.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into delivered_uncleared, delivered_uncleared_count
    from public.parcels p
   where p.client_id = v_client_id
     and p.status = 'Delivered'
     and coalesce(p.cod_amount, 0) > 0
     and p.invoice_id is null;

  on_the_way_amount := coalesce(in_transit_amount, 0) + coalesce(delivered_uncleared, 0);

  select coalesce(c.wallet_balance, 0)
    into available_balance
    from public.clients c
   where c.id = v_client_id;

  -- Last 4 completed weeks of real wallet movement, straight from the
  -- ledger (money in) and paid withdrawals (money out).
  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into inflow_4w
    from (
      -- AUDIT FIX (low): pin bucketing to UTC. The browser builds its four
      -- Monday buckets in UTC; date_trunc() alone uses the DB session
      -- timezone, so if that is ever changed from the Supabase default,
      -- Sunday-evening PKT money would be drawn in the wrong week.
      select date_trunc('week', l.created_at at time zone 'UTC')::date as wk,
             coalesce(sum(l.amount), 0) as amt
        from public.wallet_ledger l
       where l.client_id = v_client_id
         and l.entry_type = 'invoice_credit'
         and l.created_at >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into outflow_4w
    from (
      select date_trunc('week', coalesce(w.paid_at, w.created_at) at time zone 'UTC')::date as wk,
             coalesce(sum(w.net), 0) as amt
        from public.withdrawals w
       where w.client_id = v_client_id
         and w.status = 'Paid'
         and coalesce(w.paid_at, w.created_at) >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Verify: exactly one signature, and 'New booked' is gone from the body.
-- ---------------------------------------------------------------------
-- A plain `prosrc like '%New booked%'` gives a FALSE POSITIVE here: the
-- explanatory comment inside the function names the status it removed. Test
-- the status LIST instead.
--
-- select p.oid::regprocedure as signature,
--        (p.prosrc like '%''New booked'', ''Collected by rider''%') as still_counts_new_booked
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname='public' and p.proname='client_wallet_incoming';
-- expect ONE row, still_counts_new_booked = false
--
-- Better still, check the behaviour. This must be 0 for every merchant:
--
-- select count(*) from public.parcels
--  where status = 'New booked' and coalesce(cod_amount,0) > 0
--    and client_id = public.my_client_id();
-- ...then confirm client_wallet_incoming().in_transit_count excludes them.
