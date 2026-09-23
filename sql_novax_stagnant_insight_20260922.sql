-- NovaX: make the "not moved in 3 days" insight tell the truth.
--
-- Four separate complaints on KKM SWEETS & NIMCO's live account traced back to
-- one query. Reproduced against production on 2026-09-22, it returned exactly
-- seven rows: two Refused, four Return to shipper and one New booked. Not one
-- of them is a parcel stuck in the NovaX network -- six have a final outcome
-- and the seventh has never been collected. The merchant was shown an alarm
-- with nothing actionable in it.
--
-- Meanwhile N8530083 has sat at "Reattempt" since 14 Sept -- eight days -- and
-- did not appear, and N8530168 has been "New booked" since 16 Sept -- six days
-- -- and appeared only to be filtered back out by the portal.
--
-- Three causes:
--
--  1. STALENESS WAS MEASURED ON updated_at. That column moves whenever ANY
--     column on the row changes -- a fee correction, a re-weigh, a meta patch --
--     so a parcel frozen at one status for eight days looks fresh the moment
--     anything touches it. N8530083: status_since 14 Sept, updated_at 21 Sept.
--     The question is "has the STATUS moved", so it now asks status_since.
--
--  2. THE EXCLUSION LIST ONLY COVERED DELIVERIES AND RETURNS IN PROGRESS.
--     Refused, Consignee not available, Out of service area, Return to shipper
--     and the cancellations were all absent, so a concluded parcel aged forever
--     and eventually raised a "stuck" alert about a journey that had ended.
--
--  3. count(*) RAN OVER THE LIMITED SUBQUERY, so the headline could never
--     exceed 10 however many parcels were affected.
--
-- And one thing that was NOT a bug but read like one: a parcel we have never
-- collected is not stuck in our network -- the honest prompt there is "request
-- a pickup", not "we have lost it". The portal was suppressing those rows
-- client-side to avoid blaming the merchant for NovaX's own uncollected
-- bookings, which is why a six-day-old booking showed nowhere at all. It is a
-- real problem with a different answer, so it gets its own insight instead of
-- being deleted.

create or replace function public.client_smart_insights()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_client_id uuid;
  v_out       jsonb := '[]'::jsonb;
  v_stuck     jsonb;
  v_pickup    jsonb;
  r           record;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- ---- Insight 1: destination cities where failure rate has spiked. -----
  -- Requires at least 8 parcels in the recent window and 12 in the
  -- baseline, so a merchant with 3 parcels never gets a scary "300%
  -- increase" alert off statistical noise.
  for r in
    select city,
           recent_fail, recent_total, base_fail, base_total,
           round((recent_fail::numeric / nullif(recent_total, 0)) * 100) as recent_pct,
           round((base_fail::numeric   / nullif(base_total, 0))   * 100) as base_pct
      from (
        select p.city,
               count(*) filter (
                 where p.booked_at >= now() - interval '7 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as recent_fail,
               count(*) filter (where p.booked_at >= now() - interval '7 days') as recent_total,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as base_fail,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
               ) as base_total
          from public.parcels p
         where p.client_id = v_client_id
           and p.booked_at >= now() - interval '35 days'
           and coalesce(p.city, '') <> ''
         group by p.city
      ) s
     where recent_total >= 8
       and base_total   >= 12
       and (recent_fail::numeric / nullif(recent_total, 0))
           > (base_fail::numeric / nullif(base_total, 0)) * 1.5
       and (recent_fail::numeric / nullif(recent_total, 0)) >= 0.15
     order by recent_fail desc
     limit 3
  loop
    v_out := v_out || jsonb_build_object(
      'kind',     'anomaly_city',
      'severity', case when r.recent_pct >= 30 then 'high' else 'medium' end,
      'title',    r.city || ': failed deliveries are up',
      'body',     'Failed or refused deliveries in ' || r.city || ' are running at '
                  || r.recent_pct || '% this week, against ' || r.base_pct
                  || '% over the previous four weeks (' || r.recent_fail
                  || ' of ' || r.recent_total || ' parcels).',
      'action',   'open_ticket'
    );
  end loop;

  -- ---- Insight 2: parcels WE are holding that have not moved in 72h. ----
  -- Aggregate over the whole set, then name only the first ten, so the
  -- headline count is the real count.
  with stalled as (
    select p.awb,
           coalesce(p.status_since, p.updated_at, p.booked_at) as since
      from public.parcels p
     where p.client_id = v_client_id
       and p.status not in (
         -- the journey is over, whatever the outcome
         'Delivered', 'Parcel returned to consignee', 'Return to shipper',
         'Ready for return', 'Return received at origin',
         'Refused', 'Consignee not available', 'Out of service area',
         'Cancelled', 'Cancelled by client'
       )
       -- never collected is a pickup problem, not a stuck parcel: see below
       and p.status <> 'New booked'
       and coalesce(p.status_since, p.updated_at, p.booked_at) < now() - interval '72 hours'
  ), named as (
    select awb, since from stalled order by since asc limit 10
  )
  select jsonb_build_object(
           'kind',     'stuck_parcels',
           'severity', case when (select count(*) from stalled) >= 5 then 'high' else 'medium' end,
           'title',    (select count(*) from stalled) || ' parcel(s) have not moved in 3 days',
           'body',     'No status change for over 72 hours: '
                       || (select string_agg(awb, ', ' order by since asc) from named)
                       || case when (select count(*) from stalled) > 10
                               then ', and ' || ((select count(*) from stalled) - 10) || ' more'
                               else '' end
                       || '.',
           'action',   'open_ticket'
         )
    into v_stuck
   where (select count(*) from stalled) > 0;

  if v_stuck is not null then
    v_out := v_out || v_stuck;
  end if;

  -- ---- Insight 3: booked, but nobody has collected it. -----------------
  -- Same 72-hour threshold, different problem and a different fix, so it is
  -- a different card. Previously these were folded into the alert above and
  -- then stripped out of it by the portal, which meant a booking could sit
  -- uncollected for a week and appear in no insight at all.
  with uncollected as (
    select p.awb,
           coalesce(p.status_since, p.booked_at, p.updated_at) as since
      from public.parcels p
     where p.client_id = v_client_id
       and p.status = 'New booked'
       and coalesce(p.status_since, p.booked_at, p.updated_at) < now() - interval '72 hours'
  ), named2 as (
    select awb, since from uncollected order by since asc limit 10
  )
  select jsonb_build_object(
           'kind',     'awaiting_pickup',
           'severity', case when (select count(*) from uncollected) >= 5 then 'high' else 'medium' end,
           'title',    (select count(*) from uncollected) || ' booking(s) still waiting for pickup',
           'body',     'Booked over 72 hours ago and not collected yet: '
                       || (select string_agg(awb, ', ' order by since asc) from named2)
                       || case when (select count(*) from uncollected) > 10
                               then ', and ' || ((select count(*) from uncollected) - 10) || ' more'
                               else '' end
                       || '. Request a pickup so a rider is sent.',
           'action',   'request_pickup'
         )
    into v_pickup
   where (select count(*) from uncollected) > 0;

  if v_pickup is not null then
    v_out := v_out || v_pickup;
  end if;

  return v_out;
exception
  -- An insight panel must never be able to take the dashboard down.
  -- AUDIT FIX (low): but silently swallowing everything meant future
  -- schema drift here would be undetectable -- the panel would just stop
  -- appearing forever. Log it, then still fail safe.
  when others then
    raise warning 'client_smart_insights failed: %', sqlerrm;
    return '[]'::jsonb;
end;
$function$;

revoke all on function public.client_smart_insights() from public, anon;
grant execute on function public.client_smart_insights() to authenticated, service_role;
