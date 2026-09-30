-- First-parcel reminders (30 Sep 2026).
-- Up to three emails, on day 1, 3 and 7 after signup, to a merchant who has not
-- booked a single parcel. They go through the existing queue and worker
-- (sql_novax_email_notifications_20260927.sql), and stop as soon as the merchant
-- books, uses "Stop these reminders", or the account is no longer active.
--
-- The hourly job is installed switched OFF. Turn it on with:
--   select cron.alter_job((select jobid from cron.job
--     where jobname = 'novax-first-parcel-reminders'), active := true);
-- and off again with active := false.
begin;

alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check
  check (kind in ('welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected',
                  'first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7'));

-- One row per workspace that has been sent a reminder: the private token behind
-- its "Stop these reminders" link, and when the merchant used it.
create table if not exists public.nv_email_reminders (
  client_id uuid primary key references public.clients(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  stopped_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.nv_email_reminders enable row level security;
revoke all on public.nv_email_reminders from public, anon, authenticated, service_role;

create or replace function public.nv_email_first_parcel_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Karachi';
  v_budget integer;
  v_queued integer := 0;
  v_token uuid;
  r record;
begin
  -- Monday to Saturday, 10 am to 8 pm Pakistan time: inside support hours, so a
  -- merchant who answers on WhatsApp reaches a person.
  if extract(isodow from v_local) = 7 or extract(hour from v_local) < 10
     or extract(hour from v_local) >= 20 then
    return 0;
  end if;
  -- Resend's free plan sends 100 emails a day. Reminders stop at 80, so account
  -- emails (welcome, first booking, payouts, CNIC) always have room.
  select 80 - count(*) into v_budget from public.nv_email_queue
  where accepted_at > p_now - interval '24 hours'
     or (state = 'pending' and next_attempt_at <= p_now + interval '1 hour');
  v_budget := least(v_budget, 20);
  if v_budget <= 0 then return 0; end if;

  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
          nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        p_now - greatest(c.created_at, u.created_at) as age
      from public.clients c
      join public.profiles p on p.client_id = c.id and p.role::text = 'client'
      join auth.users u on u.id = p.id
      where lower(coalesce(c.status, 'active')) = 'active'
        and greatest(c.created_at, u.created_at)
            between p_now - interval '10 days' and p_now - interval '1 day'
        and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
        and lower(u.email) = lower(public.nv_email_owner(c.id))
    ), due as (
      select o.*, case when o.age >= interval '7 days' then 7
                       when o.age >= interval '3 days' then 3 else 1 end as step
      from owners o
    )
    select d.* from due d
    where not exists (select 1 from public.parcels x where x.client_id = d.client_id)
      and not exists (select 1 from public.nv_email_reminders s
                      where s.client_id = d.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n
                      where n.client_id = d.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m
                      where m.event_key = 'first_parcel_d' || d.step || ':' || d.client_id)
      -- Never two emails to one inbox within 20 hours, or two reminders within 44.
      and not exists (select 1 from public.nv_email_queue q
                      where lower(btrim(q.recipient)) = lower(d.email)
                        and q.created_at > p_now - interval '20 hours')
      and not exists (select 1 from public.nv_email_queue q
                      where q.event_key in ('first_parcel_d1:' || d.client_id,
                        'first_parcel_d3:' || d.client_id, 'first_parcel_d7:' || d.client_id)
                        and q.created_at > p_now - interval '44 hours')
    -- When the budget binds, the reminder whose window closes soonest goes first.
    order by (case d.step when 1 then interval '3 days' when 3 then interval '7 days'
              else interval '10 days' end) - d.age, d.client_id
    limit v_budget
  loop
    insert into public.nv_email_reminders(client_id) values (r.client_id)
      on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue('first_parcel_d' || r.step || ':' || r.client_id,
      'first_parcel_d' || r.step, r.email,
      jsonb_build_object('name', r.name, 'business', r.business, 'token', v_token, 'step', r.step));
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end;
$$;

-- "Stop these reminders". The token is a random UUID only the merchant's inbox
-- has; the call can only switch reminders off and reveals nothing else.
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
                      'first_parcel_d7:' || v_client);
  return true;
end;
$$;

revoke all on function public.nv_email_first_parcel_reminders(timestamptz),
  public.nv_email_reminders_stop(uuid) from public, anon, authenticated, service_role;
grant execute on function public.nv_email_reminders_stop(uuid) to anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'novax-first-parcel-reminders') then
    perform cron.schedule('novax-first-parcel-reminders', '7 * * * *',
      'select public.nv_email_first_parcel_reminders();');
    perform cron.alter_job((select jobid from cron.job
      where jobname = 'novax-first-parcel-reminders'), active := false);
  end if;
end $$;

commit;
