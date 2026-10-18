-- NovaX: "Order courier flyers from NovaX" email (flyers_launch), 19 Oct 2026.
--
-- Queues the flyers_launch email for up to 80 merchants, in this order:
--   1. shipped in the last 30 days (most recent first)
--   2. shipped before, quiet now (most parcels first)
--   3. never shipped but set up (CNIC, bank or store)
-- Same rules as the stations email: the workspace owner's login only, active
-- accounts, not if they stopped these emails or turned email off, never within
-- 20 hours of another email to the same inbox, once per merchant ever
-- (milestone key). Running it twice queues nothing the second time.
--
-- BEFORE RUNNING: novax-email-drain must be deployed with the flyers_launch
-- template, or the queued rows fail with an unknown kind.
--
-- Run in one transaction:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>

alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check check (kind = any (array[
  'recover_refused', 'recover_won', 'recover_launch',
  'welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected',
  'first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7',
  'back_quiet', 'back_tried', 'setup_ready', 'stations_launch', 'flyers_launch']));

-- The stop link also holds back this email if it is still waiting in the queue.
create or replace function public.nv_email_reminders_stop(p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_client uuid;
begin
  update public.nv_email_reminders set stopped_at = coalesce(stopped_at, now())
  where token = p_token returning client_id into v_client;
  if v_client is null then return false; end if;
  -- A reminder still waiting in the queue is not sent either.
  update public.nv_email_queue set state = 'review', last_error = 'reminders_stopped'
  where state = 'pending' and coalesce(lease_until, '-infinity') < now()
    and event_key in ('first_parcel_d1:' || v_client, 'first_parcel_d3:' || v_client,
                      'first_parcel_d7:' || v_client, 'back_quiet:' || v_client,
                      'back_tried:' || v_client, 'setup_ready:' || v_client,
                      'stations_launch:' || v_client, 'flyers_launch:' || v_client);
  return true;
end $$;

do $$
declare
  v_now timestamptz := now();
  v_room integer;
  v_token uuid;
  v_n integer := 0;
  v_g1 integer := 0; v_g2 integer := 0; v_g3 integer := 0;
  r record;
begin
  -- Resend's free plan sends 100 a day; keep room for account emails, and
  -- never more than 80 from this file.
  select least(80, 95 - count(*)) into v_room from public.nv_email_queue
  where accepted_at > v_now - interval '24 hours' or state = 'pending';

  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
          nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        (select count(*) from public.parcels x where x.client_id = c.id) as parcels,
        (select max(x.booked_at) from public.parcels x where x.client_id = c.id) as last_booked,
        (exists (select 1 from public.client_kyc k where k.client_id = c.id)
          or exists (select 1 from public.nvsh_shop s where s.client_id = c.id and s.uninstalled_at is null)
          or coalesce(c.meta->'bank'->>'iban', '') <> '') as did_setup
      from public.clients c
      join public.profiles p on p.client_id = c.id and p.role::text = 'client'
      join auth.users u on u.id = p.id
      where lower(coalesce(c.status, 'active')) = 'active'
        and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
        and lower(u.email) = lower(public.nv_email_owner(c.id))
    ), pick as (
      select o.*, case
          when o.parcels > 0 and o.last_booked > v_now - interval '30 days' then 1
          when o.parcels > 0 then 2
          when o.did_setup then 3 end as grp
      from owners o
    )
    select k.* from pick k
    where k.grp is not null
      and not exists (select 1 from public.nv_email_reminders s
                      where s.client_id = k.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n
                      where n.client_id = k.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m
                      where m.event_key = 'flyers_launch:' || k.client_id)
      and not exists (select 1 from public.nv_email_queue q
                      where lower(btrim(q.recipient)) = lower(k.email)
                        and q.created_at > v_now - interval '20 hours')
    order by k.grp, k.last_booked desc nulls last, k.parcels desc, k.client_id
  loop
    exit when v_n >= v_room;
    insert into public.nv_email_reminders(client_id) values (r.client_id)
      on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue('flyers_launch:' || r.client_id, 'flyers_launch', r.email,
      jsonb_strip_nulls(jsonb_build_object('name', nullif(r.name, ''), 'business', r.business,
        'token', v_token)));
    v_n := v_n + 1;
    if r.grp = 1 then v_g1 := v_g1 + 1; elsif r.grp = 2 then v_g2 := v_g2 + 1; else v_g3 := v_g3 + 1; end if;
  end loop;
  raise notice 'queued % flyers emails: % shipped in 30 days, % quiet, % set up (room was %)',
    v_n, v_g1, v_g2, v_g3, v_room;
end $$;
