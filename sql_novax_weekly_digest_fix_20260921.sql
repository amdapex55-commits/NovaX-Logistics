-- Weekly digest counted a week's work by parcels.updated_at, which moves on ANY
-- write. A parcel delivered on 8 September and invoiced on 15 September had an
-- updated_at outside its own week, so the delivery vanished from the digest.
-- Measured on live data for the week of 8 Sep: updated_at counts 107
-- deliveries, delivered_at counts 124 -- seventeen deliveries erased from the
-- week they happened, which is why a merchant was shown "0 deliveries" for a
-- week that plainly had several.
--
-- delivered_at is the real event time and is populated on all 604 delivered
-- parcels. status_since is the fallback for non-delivery outcomes; updated_at
-- remains only as a last resort so no row can drop out entirely.
CREATE OR REPLACE FUNCTION public.build_weekly_digests()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_week_start date := (date_trunc('week', now()) - interval '1 week')::date;
  v_week_end   date := date_trunc('week', now())::date;
  v_count      integer := 0;
begin
  insert into public.client_digests (
    client_id, week_start, delivered_count, cod_collected, fees_paid,
    best_city, worst_city, headline
  )
  select
    c.id,
    v_week_start,
    coalesce(d.delivered_count, 0),
    coalesce(d.cod_collected, 0),
    coalesce(f.fees_paid, 0),
    d.best_city,
    d.worst_city,
    case
      when coalesce(d.delivered_count, 0) = 0
        then 'No deliveries completed last week.'
      else coalesce(d.delivered_count, 0) || ' parcels delivered, '
           || to_char(coalesce(d.cod_collected, 0), 'FM999,999,999') || ' PKR collected.'
    end
  from public.clients c
  left join lateral (
    select
      count(*) filter (where p.status = 'Delivered')::int as delivered_count,
      coalesce(sum(p.cod_amount) filter (where p.status = 'Delivered'), 0) as cod_collected,
      (select p2.city from public.parcels p2
        where p2.client_id = c.id
          and p2.status = 'Delivered'
          and coalesce(p2.delivered_at, p2.status_since, p2.updated_at) >= v_week_start
          and coalesce(p2.delivered_at, p2.status_since, p2.updated_at) <  v_week_end
        group by p2.city order by count(*) desc limit 1) as best_city,
      (select p3.city from public.parcels p3
        where p3.client_id = c.id
          and p3.status in ('Refused', 'Consignee not available')
          and coalesce(p3.status_since, p3.updated_at) >= v_week_start
          and coalesce(p3.status_since, p3.updated_at) <  v_week_end
        group by p3.city order by count(*) desc limit 1) as worst_city
    from public.parcels p
    where p.client_id = c.id
      and coalesce(p.delivered_at, p.status_since, p.updated_at) >= v_week_start
      and coalesce(p.delivered_at, p.status_since, p.updated_at) <  v_week_end
  ) d on true
  left join lateral (
    select coalesce(sum(w.fee), 0) as fees_paid
      from public.withdrawals w
     where w.client_id = c.id
       and w.created_at >= v_week_start
       and w.created_at <  v_week_end
  ) f on true
  -- AUDIT FIX (medium): without this, every dormant merchant got a
  -- "Your week in review" card telling them they did nothing, and the
  -- table grew by one row per client per week forever.
  where exists (
    select 1 from public.parcels p2
     where p2.client_id = c.id
       and p2.updated_at >= v_week_start
       and p2.updated_at <  v_week_end
  )
  on conflict (client_id, week_start) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
