-- 6 Nov 2026: "New NovaX rates" email (rates_launch) to every merchant still
-- on the standard card (225 / 250 / Rs 85, not same-city), so they can opt in.
-- Same rules as the stations and flyers emails: owner login only, active
-- accounts, not if they stopped these emails or turned email off, never within
-- 20 hours of another email to the same inbox, once per merchant ever.
-- Resend's free plan sends 100 a day, so nv_email_rates_batch() queues at most
-- 80 a day (busiest merchants first) from a daily cron, and unschedules itself
-- once nobody is left. A merchant who opts in before their turn is skipped.
-- BEFORE RUNNING: novax-email-drain must be deployed with rates_launch.
begin;
alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check check (kind = any (array[
  'recover_refused', 'recover_won', 'recover_launch',
  'welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected',
  'first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7',
  'back_quiet', 'back_tried', 'setup_ready', 'stations_launch', 'flyers_launch',
  'reattempt_digest', 'portal_open', 'rates_launch']));

do $$
declare d text;
begin
  d := pg_get_functiondef('public.nv_email_reminders_stop(uuid)'::regprocedure);
  if position($x$'flyers_launch:' || v_client);$x$ in d) = 0 then raise exception 'stop list not found'; end if;
  execute replace(d, $x$'flyers_launch:' || v_client);$x$, $x$'flyers_launch:' || v_client, 'rates_launch:' || v_client);$x$);
end $$;

create or replace function public.nv_promo_standard_card(p_card jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_card->>'sameCity','') <> 'true'
     and coalesce((p_card->'A'->>'overnight')::numeric, 0) = 225 and coalesce((p_card->'B'->>'overnight')::numeric, 0) = 250
     and coalesce((p_card->'A'->>'additionalKg')::numeric, 85) = 85 and coalesce((p_card->'B'->>'additionalKg')::numeric, 85) = 85
$$;

create or replace function public.nv_email_rates_batch()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now(); v_room integer; v_token uuid; v_n integer := 0; v_left integer := 0; r record;
begin
  select least(80, 95 - count(*)) into v_room from public.nv_email_queue
  where accepted_at > v_now - interval '24 hours' or state = 'pending';
  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        (select count(*) from public.parcels x where x.client_id = c.id) as parcels,
        (select max(x.booked_at) from public.parcels x where x.client_id = c.id) as last_booked
      from public.clients c
      join public.profiles p on p.client_id = c.id and p.role::text = 'client'
      join auth.users u on u.id = p.id
      where lower(coalesce(c.status, 'active')) = 'active'
        and public.nv_promo_standard_card(c.rate_card)
        and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
        and lower(u.email) = lower(public.nv_email_owner(c.id))
    )
    select o.*, case when o.parcels > 0 and o.last_booked > v_now - interval '30 days' then 1 when o.parcels > 0 then 2 else 3 end as grp
    from owners o
    where not exists (select 1 from public.nv_email_reminders s where s.client_id = o.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n where n.client_id = o.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m where m.event_key = 'rates_launch:' || o.client_id)
      and not exists (select 1 from public.nv_email_queue q where q.event_key = 'rates_launch:' || o.client_id)
    order by grp, o.last_booked desc nulls last, o.parcels desc, o.client_id
  loop
    if v_n >= v_room then v_left := v_left + 1; continue; end if;
    if exists (select 1 from public.nv_email_queue q where lower(btrim(q.recipient)) = lower(r.email) and q.created_at > v_now - interval '20 hours') then
      v_left := v_left + 1; continue;   -- emailed recently: next batch
    end if;
    insert into public.nv_email_reminders(client_id) values (r.client_id) on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue('rates_launch:' || r.client_id, 'rates_launch', r.email,
      jsonb_strip_nulls(jsonb_build_object('name', nullif(r.name, ''), 'business', r.business, 'token', v_token)));
    v_n := v_n + 1;
  end loop;
  if v_left = 0 then
    begin perform cron.unschedule('novax-rates-launch'); exception when others then null; end;
  end if;
  return jsonb_build_object('queued', v_n, 'left', v_left, 'room', v_room);
end $$;
revoke all on function public.nv_email_rates_batch() from public, anon, authenticated;

-- Admin: who has opted in, and how far the emails have got.
create or replace function public.admin_promo_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'opted', coalesce((select jsonb_agg(jsonb_build_object('clientId', o.client_id, 'name', c.name, 'city', coalesce(c.meta->>'pickupCity', c.city), 'at', o.opted_at) order by o.opted_at desc)
                         from public.nv_promo_optins o join public.clients c on c.id = o.client_id), '[]'::jsonb),
    'standard', (select count(*) from public.clients c where lower(coalesce(c.status,'active')) = 'active' and public.nv_promo_standard_card(c.rate_card)),
    'promo', (select count(*) from public.clients c where coalesce(c.rate_card->>'sameCity','') = 'true'),
    'emailed', (select count(*) from public.nv_email_queue q where q.kind = 'rates_launch' and q.state = 'accepted'),
    'queued', (select count(*) from public.nv_email_queue q where q.kind = 'rates_launch' and q.state = 'pending'));
end $$;
revoke all on function public.admin_promo_status() from public, anon;
grant execute on function public.admin_promo_status() to authenticated;

select cron.schedule('novax-rates-launch', '30 4 * * *', 'select public.nv_email_rates_batch();');
commit;
