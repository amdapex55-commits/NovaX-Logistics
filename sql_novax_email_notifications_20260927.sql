begin;

-- Durable transactional email outbox. No network calls in business transactions.
create table if not exists public.nv_email_milestones (
  event_key text primary key,
  created_at timestamptz not null default now()
);
create table if not exists public.nv_email_queue (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique references public.nv_email_milestones(event_key),
  kind text not null check (kind in ('welcome', 'first_booking', 'payout_paid')),
  recipient text,
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'accepted', 'review')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  first_attempt_at timestamptz,
  request_body text,
  provider_id text,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists nv_email_queue_due on public.nv_email_queue(next_attempt_at)
  where state = 'pending';
alter table public.nv_email_milestones enable row level security;
alter table public.nv_email_queue enable row level security;
revoke all on public.nv_email_milestones, public.nv_email_queue from public, anon, authenticated, service_role;
grant select on public.nv_email_queue to service_role;

-- Use an actual owner login, never the parcel recipient or an arbitrary team seat.
create or replace function public.nv_email_owner(p_client uuid)
returns text language sql stable security definer set search_path = '' as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  join public.clients c on c.id = p.client_id
  where p.client_id = p_client and p.role::text = 'client'
    and lower(coalesce(p.status, 'active')) = 'active'
    and nullif(u.email, '') is not null
    and nullif(u.raw_user_meta_data->>'created_by_owner', '') is null
    and not exists (
      select 1 from public.staff_users s
      where s.client_id = p_client
        and (s.auth_user_id = p.id or lower(s.email) = lower(u.email))
        and (lower(coalesce(s.role, '')) not in ('owner', 'client')
             or lower(coalesce(s.status, 'active')) = 'revoked')
    )
  order by (lower(u.email) = lower(coalesce(c.meta->>'email', ''))) desc,
    p.created_at, p.id
  limit 1;
$$;

create or replace function public.nv_email_enqueue(p_key text, p_kind text, p_to text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  insert into public.nv_email_milestones(event_key) values(p_key)
    on conflict do nothing returning event_key into v_key;
  if v_key is null then return; end if;
  insert into public.nv_email_queue(event_key, kind, recipient, payload, state, last_error)
  values(p_key, p_kind, p_to, p_payload,
    case when nullif(btrim(p_to), '') is null then 'review' else 'pending' end,
    case when nullif(btrim(p_to), '') is null then 'owner_email_missing' else null end);
end;
$$;

create or replace function public.nv_email_on_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only public merchant signups: exclude invited seats, riders and admin users.
  if new.raw_user_meta_data->>'role' = 'client'
     and nullif(new.raw_user_meta_data->>'created_by_owner', '') is null
     and new.invited_at is null then
    perform public.nv_email_enqueue('welcome:' || new.id, 'welcome', new.email,
      jsonb_build_object('name', coalesce(new.raw_user_meta_data->>'full_name', ''),
        'business', coalesce(new.raw_user_meta_data->>'business_name', '')));
  end if;
  return new;
exception when others then
  raise warning 'NovaX email enqueue failed (welcome), SQLSTATE %', SQLSTATE;
  return new;
end;
$$;

create or replace function public.nv_email_on_first_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_business text;
begin
  select name into v_business from public.clients where id = new.client_id;
  -- The milestone's unique key serializes concurrent first bookings.
  perform public.nv_email_enqueue('first_booking:' || new.client_id, 'first_booking',
    public.nv_email_owner(new.client_id), jsonb_build_object('business', v_business,
      'awb', new.awb, 'booked_at', new.booked_at));
  return new;
exception when others then
  raise warning 'NovaX email enqueue failed (first_booking), SQLSTATE %', SQLSTATE;
  return new;
end;
$$;

create or replace function public.nv_email_on_payout_paid()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_business text;
begin
  if new.status = 'Paid' and old.status is distinct from 'Paid' then
    select name into v_business from public.clients where id = new.client_id;
    perform public.nv_email_enqueue('payout_paid:' || new.id, 'payout_paid',
      public.nv_email_owner(new.client_id), jsonb_build_object('business', v_business,
        'amount', new.amount, 'fee', new.fee, 'net', new.net,
        'paid_at', new.paid_at, 'reference', new.paid_txn_id));
  end if;
  return new;
exception when others then
  raise warning 'NovaX email enqueue failed (payout_paid), SQLSTATE %', SQLSTATE;
  return new;
end;
$$;

-- Installation must not email existing clients their next parcel as their first.
lock table public.parcels, public.withdrawals in share row exclusive mode;
insert into public.nv_email_milestones(event_key)
  select distinct 'first_booking:' || client_id from public.parcels
  where client_id is not null on conflict do nothing;
insert into public.nv_email_milestones(event_key)
  select 'payout_paid:' || id from public.withdrawals where status = 'Paid'
  on conflict do nothing;
drop trigger if exists nv_email_signup on auth.users;
create trigger nv_email_signup after insert on auth.users
  for each row execute function public.nv_email_on_signup();
drop trigger if exists nv_email_first_booking on public.parcels;
create trigger nv_email_first_booking after insert on public.parcels
  for each row execute function public.nv_email_on_first_booking();
drop trigger if exists nv_email_payout_paid on public.withdrawals;
create trigger nv_email_payout_paid after update of status on public.withdrawals
  for each row execute function public.nv_email_on_payout_paid();

create or replace function public.nv_email_claim(p_limit integer default 5)
returns setof public.nv_email_queue language plpgsql security definer set search_path = '' as $$
begin
  -- Resend retains idempotency keys for 24h. Stop early instead of risking duplicates.
  update public.nv_email_queue set state = 'review', last_error = 'retry_window_expired'
  where state = 'pending' and coalesce(lease_until, '-infinity') < now()
    and (attempts >= 8 or first_attempt_at <= now() - interval '23 hours');
  return query
  with due as (
    select id from public.nv_email_queue
    where state = 'pending' and next_attempt_at <= now()
      and coalesce(lease_until, '-infinity') < now()
    order by next_attempt_at, created_at, id
    for update skip locked limit greatest(1, least(coalesce(p_limit, 5), 5))
  )
  update public.nv_email_queue q
  set lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes',
      attempts = q.attempts + 1
  from due where q.id = due.id returning q.*;
end;
$$;

create or replace function public.nv_email_prepare(p_id uuid, p_lease uuid, p_body text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_body text;
begin
  -- Freeze the exact wire body before sending, including sender and template version.
  update public.nv_email_queue
  set request_body = coalesce(request_body, p_body), first_attempt_at = coalesce(first_attempt_at, now())
  where id = p_id and lease_token = p_lease and lease_until > now() and state = 'pending'
    and (first_attempt_at is null or first_attempt_at > now() - interval '23 hours')
    and nullif(p_body, '') is not null
  returning request_body into v_body;
  return v_body;
end;
$$;

create or replace function public.nv_email_result(p_id uuid, p_lease uuid, p_provider text,
  p_error text, p_terminal boolean default false, p_retry_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.nv_email_queue
  set state = case when nullif(p_provider, '') is not null then 'accepted'
              when p_terminal or attempts >= 8 then 'review' else 'pending' end,
    provider_id = nullif(p_provider, ''),
    accepted_at = case when nullif(p_provider, '') is not null then now() else null end,
    last_error = left(p_error, 100), lease_until = null, lease_token = null,
    next_attempt_at = now() + make_interval(secs => greatest(10, least(coalesce(p_retry_seconds, 60), 3600)))
  where id = p_id and lease_token = p_lease and state = 'pending';
  return found;
end;
$$;

revoke all on function public.nv_email_owner(uuid),
  public.nv_email_enqueue(text,text,text,jsonb), public.nv_email_on_signup(),
  public.nv_email_on_first_booking(), public.nv_email_on_payout_paid(),
  public.nv_email_claim(integer), public.nv_email_prepare(uuid,uuid,text),
  public.nv_email_result(uuid,uuid,text,text,boolean,integer) from public, anon, authenticated, service_role;
grant execute on function public.nv_email_claim(integer), public.nv_email_prepare(uuid,uuid,text),
  public.nv_email_result(uuid,uuid,text,text,boolean,integer) to service_role;

commit;
