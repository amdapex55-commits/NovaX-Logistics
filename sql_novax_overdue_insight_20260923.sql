-- NovaX: the stagnant alert missed parcels that move without arriving.
--
-- Reported: N8530192 and N8530193 have been in transit over four days, and the
-- "not moved in 3 days" alert reports one parcel. Both are true, and that is
-- the bug. Measured on the live account 2026-09-23:
--
--   N8530192  booked 4d16h ago   last status change 15h ago
--   N8530193  booked 4d16h ago   last status change 15h ago
--
-- The alert asks "has the STATUS changed in 72 hours", which is the right
-- question for a parcel frozen at one depot -- it is how N8530083 (8 days at
-- Reattempt) is caught. But a parcel being rescanned between hubs every day
-- resets that clock forever while getting no closer to the consignee. By that
-- measure 1 parcel is late. By "how long since the merchant handed it over",
-- 15 are.
--
-- Both questions matter and they have different answers, so they get different
-- cards rather than one blurred threshold:
--
--   stuck_parcels  -- frozen at a stage           (status_since > 72h)
--   overdue_network -- in our hands too long       (booked_at   > 72h)
--
-- The second excludes anything already named by the first, so no parcel is
-- reported twice, and excludes New booked, which has its own pickup card.

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
  v_slow      jsonb;
  v_pickup    jsonb;
  r           record;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- ---- Insight 1: destination cities where failure rate has spiked. -----
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

  -- ---- Insight 2: frozen at one stage for over 72 hours. ---------------
  with stalled as (
    select p.awb, coalesce(p.status_since, p.updated_at, p.booked_at) as since
      from public.parcels p
     where p.client_id = v_client_id
       and p.status not in (
         'Delivered', 'Parcel returned to consignee', 'Return to shipper',
         'Ready for return', 'Return received at origin',
         'Refused', 'Consignee not available', 'Out of service area',
         'Cancelled', 'Cancelled by client'
       )
       and p.status <> 'New booked'
       and coalesce(p.status_since, p.updated_at, p.booked_at) < now() - interval '72 hours'
  ), named as ( select awb, since from stalled order by since asc limit 10 )
  select jsonb_build_object(
           'kind','stuck_parcels',
           'severity', case when (select count(*) from stalled) >= 5 then 'high' else 'medium' end,
           'title', (select count(*) from stalled) || ' parcel(s) have not moved in 3 days',
           'body','No status change for over 72 hours: '
                  || (select string_agg(awb, ', ' order by since asc) from named)
                  || case when (select count(*) from stalled) > 10
                          then ', and ' || ((select count(*) from stalled) - 10) || ' more' else '' end
                  || '.',
           'action','open_ticket')
    into v_stuck
   where (select count(*) from stalled) > 0;
  if v_stuck is not null then v_out := v_out || v_stuck; end if;

  -- ---- Insight 3: in our hands over 72 hours, still not delivered. -----
  -- The one that catches a parcel rescanned daily between hubs: its status
  -- clock keeps resetting, so Insight 2 can never see it.
  with overdue as (
    select p.awb, p.booked_at
      from public.parcels p
     where p.client_id = v_client_id
       and p.status not in (
         'Delivered', 'Parcel returned to consignee', 'Return to shipper',
         'Ready for return', 'Return received at origin',
         'Refused', 'Consignee not available', 'Out of service area',
         'Cancelled', 'Cancelled by client'
       )
       and p.status <> 'New booked'
       and p.booked_at < now() - interval '72 hours'
       -- anything Insight 2 already named is not repeated here
       and coalesce(p.status_since, p.updated_at, p.booked_at) >= now() - interval '72 hours'
  ), named3 as ( select awb, booked_at from overdue order by booked_at asc limit 10 )
  select jsonb_build_object(
           'kind','overdue_network',
           'severity', case when (select count(*) from overdue) >= 5 then 'high' else 'medium' end,
           'title', (select count(*) from overdue) || ' parcel(s) are past 3 days with us',
           'body','Booked over 72 hours ago, still moving and not delivered yet: '
                  || (select string_agg(awb, ', ' order by booked_at asc) from named3)
                  || case when (select count(*) from overdue) > 10
                          then ', and ' || ((select count(*) from overdue) - 10) || ' more' else '' end
                  || '. These are being scanned, so they do not show as stuck -- they are simply taking too long.',
           'action','open_ticket')
    into v_slow
   where (select count(*) from overdue) > 0;
  if v_slow is not null then v_out := v_out || v_slow; end if;

  -- ---- Insight 4: booked, but nobody has collected it. -----------------
  with uncollected as (
    select p.awb, coalesce(p.status_since, p.booked_at, p.updated_at) as since
      from public.parcels p
     where p.client_id = v_client_id
       and p.status = 'New booked'
       and coalesce(p.status_since, p.booked_at, p.updated_at) < now() - interval '72 hours'
  ), named2 as ( select awb, since from uncollected order by since asc limit 10 )
  select jsonb_build_object(
           'kind','awaiting_pickup',
           'severity', case when (select count(*) from uncollected) >= 5 then 'high' else 'medium' end,
           'title', (select count(*) from uncollected) || ' booking(s) still waiting for pickup',
           'body','Booked over 72 hours ago and not collected yet: '
                  || (select string_agg(awb, ', ' order by since asc) from named2)
                  || case when (select count(*) from uncollected) > 10
                          then ', and ' || ((select count(*) from uncollected) - 10) || ' more' else '' end
                  || '. Request a pickup so a rider is sent.',
           'action','request_pickup')
    into v_pickup
   where (select count(*) from uncollected) > 0;
  if v_pickup is not null then v_out := v_out || v_pickup; end if;

  return v_out;
exception
  when others then
    raise warning 'client_smart_insights failed: %', sqlerrm;
    return '[]'::jsonb;
end;
$function$;

revoke all on function public.client_smart_insights() from public, anon;
grant execute on function public.client_smart_insights() to authenticated, service_role;
