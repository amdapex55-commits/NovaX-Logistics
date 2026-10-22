-- 22 Oct 2026 UX batch (database side).
--   1. admin_rider_problems_today(): rider actions NovaX refused in the last
--      24 hours (portal_error_logs, source rider), with the rider's name and
--      phone, for the admin dashboard's "Calls to make" panel.
--   2. admin_gone_quiet(p_days): merchants who shipped 3+ parcels and have
--      not booked for p_days days, with their phone, for the same panel.
--   3. Evening reattempt email: one email per merchant per day listing every
--      parcel set to Reattempt that day (who, where, why, next try).
-- Rehearse in BEGIN/ROLLBACK; running it again changes nothing.

create or replace function public.admin_rider_problems_today()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', l.id, 'at', l.created_at, 'rpc', l.rpc_name, 'message', l.message,
      'rider', coalesce(r.name, nullif(split_part(l.page, ' · ', 2), ''), l.user_email, 'Rider'),
      'phone', r.phone) x
      from public.portal_error_logs l
      left join auth.users u on lower(u.email) = lower(l.user_email)
      left join public.profiles p on p.id = u.id
      left join public.riders r on r.id = p.rider_id
     where public.is_staff_admin() and l.source = 'rider' and not coalesce(l.resolved, false)
       and l.created_at > now() - interval '24 hours'
     limit 100) t;
$$;
revoke all on function public.admin_rider_problems_today() from public, anon;
grant execute on function public.admin_rider_problems_today() to authenticated;

create or replace function public.admin_gone_quiet(p_days integer default 14)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x->>'parcels')::int desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'client_id', c.id, 'name', c.name, 'owner', c.owner, 'phone', c.phone, 'city', c.city,
      'parcels', s.n, 'returned', s.ret, 'last_booked', s.last_at,
      'days', (current_date - (s.last_at at time zone 'Asia/Karachi')::date)) x
      from public.clients c
      join lateral (select count(*) n, max(p.booked_at) last_at,
                           count(*) filter (where p.status in ('Return to shipper','Refused')) ret
                      from public.parcels p where p.client_id = c.id
                       and p.status <> 'Cancelled by client') s on true
     where public.is_staff_admin()
       and s.n >= 3 and s.last_at < now() - make_interval(days => greatest(coalesce(p_days, 14), 1))
       and coalesce(c.meta->>'shopify_review_mode', 'false') <> 'true'
       and c.name !~* '^\s*(test|testt|test account|test client|test store|novax merchant)\s*$'
       and lower(coalesce(c.status, 'active')) not in ('blocked', 'closed', 'deleted')
     limit 200) t;
$$;
revoke all on function public.admin_gone_quiet(integer) from public, anon;
grant execute on function public.admin_gone_quiet(integer) to authenticated;

alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check check (kind = any (array[
  'recover_refused','recover_won','recover_launch','welcome','first_booking','payout_paid','cnic_verified','cnic_rejected',
  'first_parcel_d1','first_parcel_d3','first_parcel_d7','back_quiet','back_tried','setup_ready','stations_launch','flyers_launch',
  'reattempt_digest']));

create or replace function public.nv_email_reattempt_digest(p_day date default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Karachi')::date); r record; n int := 0;
begin
  for r in
    select p.client_id, c.name business,
           jsonb_agg(jsonb_build_object(
             'awb', p.awb,
             'customer', split_part(btrim(coalesce(p.consignee, '')), ' ', 1),
             'city', initcap(public.nv_parcel_dest(p)),
             'reason', left(coalesce(nullif(btrim(p.exception), ''), nullif(btrim(p.meta->>'lastAttemptReason'), ''), ''), 120),
             'next', p.meta->>'nextAttempt') order by p.awb) parcels,
           count(*) cnt
      from public.parcels p join public.clients c on c.id = p.client_id
     where p.status = 'Reattempt'
       and (coalesce(p.status_since, p.updated_at) at time zone 'Asia/Karachi')::date = v_day
     group by p.client_id, c.name
  loop
    perform public.nv_email_enqueue('reattempt_digest:' || r.client_id || ':' || v_day, 'reattempt_digest',
      public.nv_email_owner(r.client_id),
      jsonb_build_object('business', r.business, 'day', v_day, 'count', r.cnt, 'parcels', r.parcels));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.nv_email_reattempt_digest(date) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'novax-reattempt-digest') then
    perform cron.unschedule('novax-reattempt-digest');
  end if;
  -- 20:00 PKT, after riders' last runs
  perform cron.schedule('novax-reattempt-digest', '0 15 * * *', 'select public.nv_email_reattempt_digest();');
end $$;
