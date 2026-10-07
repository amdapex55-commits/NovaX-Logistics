-- NovaX: one-off emails to merchants who stopped, or set up and never shipped.
-- 8 Oct 2026, on Aisha's instruction ("do 16 15 and 13 right now").
--
--   back_quiet   sent 3 or more parcels, none in the last 30 days
--   back_tried   sent 1 or 2 parcels, none in the last 30 days
--   setup_ready  never booked, but sent a CNIC, added a bank account or
--                connected a store
--
-- Same rules as the first-parcel reminders: the workspace owner's login only,
-- active accounts, not if they stopped reminders or turned email off, and
-- never within 20 hours of another email to the same inbox. Each email is
-- sent once per merchant, ever (the milestone key). Running this file twice
-- queues nothing the second time.
--
-- Run in one transaction:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>
-- The sender (novax-email-drain) must already know the three kinds.

alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check check (kind = any (array[
  'welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected',
  'first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7',
  'back_quiet', 'back_tried', 'setup_ready']));

-- The stop link in these emails is the reminders' own. It now also holds back
-- one of these if it is still waiting in the queue.
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
                      'back_tried:' || v_client, 'setup_ready:' || v_client);
  return true;
end $$;

do $$
declare
  v_now timestamptz := now();
  v_room integer;
  v_token uuid;
  v_n integer := 0;
  v_quiet integer := 0; v_tried integer := 0; v_ready integer := 0;
  r record;
begin
  -- Resend's free plan sends 100 emails a day. Leave room for account emails.
  select 95 - count(*) into v_room from public.nv_email_queue
  where accepted_at > v_now - interval '24 hours' or state = 'pending';

  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
          nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        coalesce(c.wallet_balance, 0) as wallet,
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
          when o.parcels >= 3 and o.last_booked < v_now - interval '30 days' then 'back_quiet'
          when o.parcels between 1 and 2 and o.last_booked < v_now - interval '30 days' then 'back_tried'
          when o.parcels = 0 and o.did_setup then 'setup_ready' end as kind
      from owners o
    )
    select k.* from pick k
    where k.kind is not null
      and not exists (select 1 from public.nv_email_reminders s
                      where s.client_id = k.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n
                      where n.client_id = k.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m
                      where m.event_key = k.kind || ':' || k.client_id)
      and not exists (select 1 from public.nv_email_queue q
                      where lower(btrim(q.recipient)) = lower(k.email)
                        and q.created_at > v_now - interval '20 hours')
    order by (k.kind = 'back_quiet') desc, (k.kind = 'back_tried') desc, k.parcels desc, k.client_id
  loop
    exit when v_n >= v_room;
    insert into public.nv_email_reminders(client_id) values (r.client_id)
      on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue(r.kind || ':' || r.client_id, r.kind, r.email,
      jsonb_strip_nulls(jsonb_build_object('name', r.name, 'business', r.business, 'token', v_token,
        'parcels', nullif(r.parcels, 0), 'last', r.last_booked,
        'wallet', case when r.wallet >= 1 then r.wallet end)));
    v_n := v_n + 1;
    if r.kind = 'back_quiet' then v_quiet := v_quiet + 1;
    elsif r.kind = 'back_tried' then v_tried := v_tried + 1;
    else v_ready := v_ready + 1; end if;
  end loop;
  raise notice 'queued % emails: % went quiet, % tried once or twice, % set up and never shipped (room was %)',
    v_n, v_quiet, v_tried, v_ready, v_room;
end $$;
