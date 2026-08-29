-- ===========================================================================
-- Client portal v4 -- 30 Aug 2026
-- Delivery estimates computed from what actually happened, never promised.
-- ===========================================================================

-- Per-city delivery time from real delivered parcels. p50 and p80 over the
-- last 120 days, with a minimum sample so a city with three parcels cannot
-- produce a confident-looking number.
--
-- p80 is what the portal shows as the upper bound: four parcels in five
-- arrived by then. Showing the median alone would make us late half the time,
-- which is exactly how a tracking promise loses trust.
create or replace function public.client_delivery_estimate()
returns table(city text, sample int, p50_days numeric, p80_days numeric)
language sql stable security definer set search_path to 'public' as $$
  with d as (
    select p.city,
           extract(epoch from (p.delivered_at - p.booked_at))/86400.0 as days
      from public.parcels p
     where p.delivered_at is not null
       and p.booked_at is not null
       and p.delivered_at > p.booked_at
       and p.booked_at > now() - interval '120 days')
  select city,
         count(*)::int,
         round((percentile_disc(0.5) within group (order by days))::numeric, 1),
         round((percentile_disc(0.8) within group (order by days))::numeric, 1)
    from d group by city having count(*) >= 20
  union all
  select '*',
         count(*)::int,
         round((percentile_disc(0.5) within group (order by days))::numeric, 1),
         round((percentile_disc(0.8) within group (order by days))::numeric, 1)
    from d;
$$;

grant execute on function public.client_delivery_estimate() to anon, authenticated;
