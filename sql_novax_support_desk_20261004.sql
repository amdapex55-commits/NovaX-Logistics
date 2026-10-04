-- Support Desk (4 Oct 2026). care.html.
-- One place for NovaX's customer support agents (working from home) to work
-- every Refused and "Consignee not available" parcel:
--   call the customer -> was the rider's reason true?
--     true / wrong number -> WhatsApp the merchant with what the customer said
--     false               -> a re-delivery ticket for ops ("Fake attempt /
--                            proof dispute: <AWB>" in Ops alerts)
--     no answer           -> stays in the queue to try again
-- Agents clock in and out; the page beats every minute while open, so each
-- shift records active and idle time, and every call records its outcome and
-- how long the agent spent on it. Admins see the analytics.
-- Agents are invited by email from the desk's Team tab and make their own
-- login (NovaX never sets passwords); their profile role becomes 'support'.
-- Run after: alter type public.novax_role add value if not exists 'support';

create table if not exists public.cs_agents (
  id           uuid primary key default gen_random_uuid(),
  full_name    text not null,
  email        text not null unique,
  phone        text,
  auth_user_id uuid unique,
  status       text not null default 'Invited' check (status in ('Invited', 'Active', 'Removed')),
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  joined_at    timestamptz,
  removed_at   timestamptz
);

create table if not exists public.cs_shifts (
  id             bigserial primary key,
  agent_id       uuid not null references public.cs_agents(id),
  clock_in       timestamptz not null default now(),
  clock_out      timestamptz,
  last_beat      timestamptz not null default now(),
  active_seconds int not null default 0,
  idle_seconds   int not null default 0,
  closed_by      text check (closed_by in ('agent', 'auto', 'admin')),
  ip             text,
  user_agent     text
);
create unique index if not exists cs_shifts_one_open on public.cs_shifts(agent_id) where clock_out is null;
create index if not exists cs_shifts_agent_in on public.cs_shifts(agent_id, clock_in);

create table if not exists public.cs_reviews (
  id                   bigserial primary key,
  parcel_id            uuid not null references public.parcels(id) on delete cascade,
  awb                  text not null,
  client_id            uuid,
  parcel_status        text not null,
  status_since         timestamptz,
  agent_id             uuid references public.cs_agents(id),
  agent_user           uuid,
  shift_id             bigint references public.cs_shifts(id),
  outcome              text not null check (outcome in ('valid', 'false', 'no_answer', 'wrong_number')),
  category             text,
  note                 text,
  preferred_date       date,
  preferred_slot       text,
  address_fix          text,
  handle_seconds       int,
  ops_issue_id         uuid,
  merchant_notified_at timestamptz,
  created_at           timestamptz not null default now()
);
create index if not exists cs_reviews_parcel on public.cs_reviews(parcel_id, created_at);
create index if not exists cs_reviews_agent on public.cs_reviews(agent_id, created_at);

alter table public.cs_agents enable row level security;
alter table public.cs_shifts enable row level security;
alter table public.cs_reviews enable row level security;
revoke all on public.cs_agents, public.cs_shifts, public.cs_reviews from public, anon, authenticated;
revoke all on sequence public.cs_shifts_id_seq, public.cs_reviews_id_seq from public, anon, authenticated;

-- A parcel's meta timestamps are free text; a bad one must not break the queue.
create or replace function public.cs_ts(p text)
returns timestamptz language plpgsql immutable set search_path = '' as $$
begin return p::timestamptz; exception when others then return null; end $$;

-- ── who is who ─────────────────────────────────────────────────────────────
create or replace function public.cs_current_agent()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.cs_agents a where a.auth_user_id = auth.uid() and a.status = 'Active';
$$;

-- Agent id for an agent, null for an admin; anyone else is refused.
create or replace function public.cs_require_access()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.cs_current_agent();
begin
  if v is not null then return v; end if;
  if public.is_admin() then return null; end if;
  raise exception 'This page is for the NovaX support team.' using errcode = '42501';
end $$;

create or replace function public.cs_require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only NovaX admins can do this.' using errcode = '42501'; end if;
end $$;

-- An agent must be clocked in to work; admins may work without a shift.
create or replace function public.cs_require_shift()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := public.cs_require_access(); v_shift public.cs_shifts;
begin
  if v_agent is null then return null; end if;
  select * into v_shift from public.cs_shifts where agent_id = v_agent and clock_out is null;
  if v_shift.id is null then raise exception 'Clock in to start working.' using errcode = '42501'; end if;
  if v_shift.last_beat < now() - interval '15 minutes' then
    update public.cs_shifts set clock_out = last_beat, closed_by = 'auto' where id = v_shift.id;
    raise exception 'Your shift closed after 15 minutes without activity. Clock in again.' using errcode = '42501';
  end if;
  return v_shift.id;
end $$;

-- ── joining ────────────────────────────────────────────────────────────────
-- The first sign-in of an invited email links it: the login must be new to
-- NovaX (never a merchant, rider, admin or sales login).
create or replace function public.cs_join()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := (select lower(u.email) from auth.users u where u.id = auth.uid());
  v_agent public.cs_agents;
begin
  if v_uid is null then return; end if;
  if exists (select 1 from public.cs_agents where auth_user_id = v_uid) then return; end if;
  select * into v_agent from public.cs_agents where email = v_email and status = 'Invited' and auth_user_id is null for update;
  if v_agent.id is null then return; end if;
  if exists (select 1 from public.profiles p where p.id = v_uid
             and (p.client_id is not null or p.rider_id is not null or p.role::text in ('admin', 'rider', 'sales'))) then
    raise exception 'This login already belongs to a NovaX account. Use a separate email for support work.' using errcode = '42501';
  end if;
  update public.cs_agents set auth_user_id = v_uid, status = 'Active', joined_at = now() where id = v_agent.id;
  insert into public.profiles(id, email, full_name, role) values (v_uid, v_email, v_agent.full_name, 'support')
  on conflict (id) do update set role = 'support', full_name = excluded.full_name;
end $$;

create or replace function public.cs_me()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent public.cs_agents; v_shift public.cs_shifts; v_admin boolean; v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  perform public.cs_join();
  v_admin := public.is_admin();
  select * into v_agent from public.cs_agents where auth_user_id = auth.uid();
  if v_agent.id is null and not v_admin then
    return jsonb_build_object('is_admin', false, 'agent', null);
  end if;
  if v_agent.id is not null then
    select * into v_shift from public.cs_shifts where agent_id = v_agent.id and clock_out is null;
    if v_shift.id is not null and v_shift.last_beat < now() - interval '15 minutes' then
      update public.cs_shifts set clock_out = last_beat, closed_by = 'auto' where id = v_shift.id;
      v_shift := null;
    end if;
  end if;
  return jsonb_build_object(
    'is_admin', v_admin,
    'email', (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'agent', case when v_agent.id is null then null else jsonb_build_object('id', v_agent.id, 'full_name', v_agent.full_name, 'status', v_agent.status) end,
    'shift', case when v_shift.id is null then null else jsonb_build_object('id', v_shift.id, 'clock_in', v_shift.clock_in,
      'active_seconds', v_shift.active_seconds, 'idle_seconds', v_shift.idle_seconds) end,
    'today', case when v_agent.id is null then null else jsonb_build_object(
      'calls', (select count(*) from public.cs_reviews r where r.agent_id = v_agent.id and (r.created_at at time zone 'Asia/Karachi')::date = v_day),
      'valid', (select count(*) from public.cs_reviews r where r.agent_id = v_agent.id and r.outcome in ('valid', 'wrong_number') and (r.created_at at time zone 'Asia/Karachi')::date = v_day),
      'to_ops', (select count(*) from public.cs_reviews r where r.agent_id = v_agent.id and r.outcome = 'false' and (r.created_at at time zone 'Asia/Karachi')::date = v_day),
      'no_answer', (select count(*) from public.cs_reviews r where r.agent_id = v_agent.id and r.outcome = 'no_answer' and (r.created_at at time zone 'Asia/Karachi')::date = v_day),
      'notified', (select count(*) from public.cs_reviews r where r.agent_id = v_agent.id and (r.merchant_notified_at at time zone 'Asia/Karachi')::date = v_day),
      'active_seconds', (select coalesce(sum(s.active_seconds), 0) from public.cs_shifts s where s.agent_id = v_agent.id and (s.clock_in at time zone 'Asia/Karachi')::date = v_day),
      'clocked_seconds', (select coalesce(sum(extract(epoch from coalesce(s.clock_out, now()) - s.clock_in)), 0)::int from public.cs_shifts s
                           where s.agent_id = v_agent.id and (s.clock_in at time zone 'Asia/Karachi')::date = v_day)) end);
end $$;

-- ── the clock ──────────────────────────────────────────────────────────────
create or replace function public.cs_clock_in(p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := public.cs_current_agent(); v_hdr json;
begin
  if v_agent is null then raise exception 'Only support agents clock in.' using errcode = '42501'; end if;
  update public.cs_shifts set clock_out = last_beat, closed_by = 'auto'
   where agent_id = v_agent and clock_out is null and last_beat < now() - interval '15 minutes';
  if exists (select 1 from public.cs_shifts where agent_id = v_agent and clock_out is null) then return public.cs_me(); end if;
  begin v_hdr := nullif(current_setting('request.headers', true), '')::json; exception when others then v_hdr := null; end;
  insert into public.cs_shifts(agent_id, ip, user_agent)
  values (v_agent, left(split_part(coalesce(v_hdr->>'cf-connecting-ip', v_hdr->>'x-forwarded-for', ''), ',', 1), 60), left(p_user_agent, 300));
  return public.cs_me();
end $$;

-- Called every minute while the desk is open. Time is credited from the
-- server clock and never more than 2 minutes per beat, so a page cannot
-- claim hours it was not open.
create or replace function public.cs_heartbeat(p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := public.cs_current_agent(); v_shift public.cs_shifts; v_gap int;
begin
  if v_agent is null then return jsonb_build_object('open', false); end if;
  select * into v_shift from public.cs_shifts where agent_id = v_agent and clock_out is null for update;
  if v_shift.id is null then return jsonb_build_object('open', false); end if;
  v_gap := extract(epoch from now() - v_shift.last_beat)::int;
  if v_gap > 900 then
    update public.cs_shifts set clock_out = last_beat, closed_by = 'auto' where id = v_shift.id;
    return jsonb_build_object('open', false, 'auto_closed', true);
  end if;
  v_gap := least(greatest(v_gap, 0), 120);
  update public.cs_shifts set last_beat = now(),
    active_seconds = active_seconds + case when p_active then v_gap else 0 end,
    idle_seconds = idle_seconds + case when p_active then 0 else v_gap end
   where id = v_shift.id;
  return jsonb_build_object('open', true);
end $$;

create or replace function public.cs_clock_out()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent uuid := public.cs_current_agent(); v_shift public.cs_shifts; v_gap int;
begin
  if v_agent is null then raise exception 'Only support agents clock out.' using errcode = '42501'; end if;
  select * into v_shift from public.cs_shifts where agent_id = v_agent and clock_out is null for update;
  if v_shift.id is not null then
    v_gap := least(greatest(extract(epoch from now() - v_shift.last_beat)::int, 0), 120);
    update public.cs_shifts set clock_out = case when v_shift.last_beat < now() - interval '15 minutes' then last_beat else now() end,
      closed_by = 'agent', last_beat = now(),
      active_seconds = active_seconds + case when v_shift.last_beat < now() - interval '15 minutes' then 0 else v_gap end
     where id = v_shift.id;
  end if;
  return public.cs_me();
end $$;

-- Cron: close shifts whose page went quiet 15 minutes ago, at the last beat.
create or replace function public.cs_close_stale_shifts()
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  update public.cs_shifts set clock_out = last_beat, closed_by = 'auto'
   where clock_out is null and last_beat < now() - interval '15 minutes';
  get diagnostics v = row_count;
  return v;
end $$;

-- ── the queue ──────────────────────────────────────────────────────────────
-- Every Refused / Consignee not available parcel, with what support has done
-- on it since it entered that status. bucket: call / notify / ops / done.
create or replace function public.cs_queue()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.cs_require_shift();   -- agents work the queue only on the clock
  return (
    select coalesce(jsonb_agg(x order by (x->>'bucket') = 'done', x->>'status_since'), '[]'::jsonb) from (
      select jsonb_build_object(
        'parcel_id', p.id, 'awb', p.awb, 'status', p.status, 'status_since', coalesce(p.status_since, p.updated_at),
        'reason', coalesce(nullif(p.exception, ''), p.meta->>'exception', ''),
        'consignee', p.consignee, 'phone', p.phone, 'address', p.address, 'city', p.city, 'cod', p.cod_amount,
        'booked_at', p.booked_at,
        'merchant', c.name, 'merchant_owner', c.owner, 'merchant_phone', c.phone,
        'rider', rd.name, 'rider_phone', rd.phone,
        'attempts', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = p.id
                      and l.to_status in ('Refused', 'Consignee not available')),
        'merchant_decided', (p.meta ? 'reattemptRequestedAt' and public.cs_ts(p.meta->>'reattemptRequestedAt') > coalesce(p.status_since, p.updated_at))
                            or (p.meta ? 'returnRequestedAt' and public.cs_ts(p.meta->>'returnRequestedAt') > coalesce(p.status_since, p.updated_at)),
        'tries', (select count(*) from public.cs_reviews r where r.parcel_id = p.id and r.created_at >= coalesce(p.status_since, p.updated_at)),
        'last', lr.j,
        'ops_resolved', (select o.resolved from public.operations_issues o where o.id = (lr.j->>'ops_issue_id')::uuid),
        'bucket', case
          when (p.meta ? 'reattemptRequestedAt' and public.cs_ts(p.meta->>'reattemptRequestedAt') > coalesce(p.status_since, p.updated_at))
            or (p.meta ? 'returnRequestedAt' and public.cs_ts(p.meta->>'returnRequestedAt') > coalesce(p.status_since, p.updated_at)) then 'done'
          when lr.j is null or lr.j->>'outcome' = 'no_answer' then 'call'
          when lr.j->>'outcome' in ('valid', 'wrong_number') and lr.j->>'merchant_notified_at' is null then 'notify'
          when lr.j->>'outcome' = 'false' and coalesce((select o.resolved from public.operations_issues o where o.id = (lr.j->>'ops_issue_id')::uuid), false) = false then 'ops'
          else 'done' end) as x
      from public.parcels p
      join public.clients c on c.id = p.client_id
      left join public.riders rd on rd.id = p.rider_id
      left join lateral (
        select jsonb_build_object('id', r.id, 'outcome', r.outcome, 'category', r.category, 'note', r.note, 'at', r.created_at,
          'by', coalesce(a.full_name, 'NovaX admin'), 'merchant_notified_at', r.merchant_notified_at, 'ops_issue_id', r.ops_issue_id,
          'preferred_date', r.preferred_date, 'preferred_slot', r.preferred_slot) as j
        from public.cs_reviews r left join public.cs_agents a on a.id = r.agent_id
        where r.parcel_id = p.id and r.created_at >= coalesce(p.status_since, p.updated_at)
        order by r.created_at desc limit 1) lr on true
      where p.status in ('Refused', 'Consignee not available')
    ) t);
end $$;

create or replace function public.cs_log_review(
  p_parcel uuid, p_outcome text, p_category text default null, p_note text default null,
  p_preferred_date date default null, p_preferred_slot text default null, p_address_fix text default null,
  p_opened_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_agent uuid := public.cs_require_access();
  v_shift bigint := public.cs_require_shift();
  v_p public.parcels; v_issue uuid; v_id bigint;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 600), '');
  v_problem text;
begin
  if p_outcome not in ('valid', 'false', 'no_answer', 'wrong_number') then
    raise exception 'Pick what the customer said.' using errcode = '22023';
  end if;
  select * into v_p from public.parcels where id = p_parcel;
  if v_p.id is null or v_p.status not in ('Refused', 'Consignee not available') then
    raise exception 'This parcel is no longer refused or waiting for the customer. Refresh the list.' using errcode = '22023';
  end if;
  if p_outcome = 'false' then
    if p_preferred_date is null then raise exception 'Pick the day the customer wants it.' using errcode = '22023'; end if;
    if p_preferred_date < v_today or p_preferred_date > v_today + 14 then
      raise exception 'Pick a day within the next two weeks.' using errcode = '22023';
    end if;
  end if;
  if p_outcome in ('valid', 'false') and v_note is null and nullif(btrim(coalesce(p_category, '')), '') is null then
    raise exception 'Write what the customer said.' using errcode = '22023';
  end if;
  if (select count(*) from public.cs_reviews r where r.agent_user = auth.uid() and r.created_at > now() - interval '1 minute') >= 15 then
    raise exception 'Too many saves in a minute. Wait a moment.' using errcode = '54000';
  end if;

  if p_outcome = 'false' then
    v_problem := 'Fake attempt / proof dispute: ' || v_p.awb;
    select id into v_issue from public.operations_issues where problem = v_problem and resolved = false limit 1;
    if v_issue is null then
      insert into public.operations_issues(branch, urgency, problem, awb, resolved, meta)
      values (coalesce(nullif(v_p.meta->>'branch', ''), coalesce(nullif(v_p.city, ''), 'Destination') || ' Hub'), 'super urgent', v_problem, v_p.awb, false,
              jsonb_build_object('exceptionType', 'Fake attempt / proof dispute', 'source', 'support-desk'))
      returning id into v_issue;
    end if;
    update public.operations_issues set updated_at = now(), meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
        'source', 'support-desk', 'riderReason', coalesce(nullif(v_p.exception, ''), v_p.meta->>'exception'),
        'customerSays', coalesce(v_note, p_category), 'redeliverOn', p_preferred_date, 'redeliverSlot', p_preferred_slot,
        'addressFix', nullif(btrim(coalesce(p_address_fix, '')), ''),
        'raisedBy', coalesce((select full_name from public.cs_agents where id = v_agent), 'NovaX admin'), 'raisedAt', now())
     where id = v_issue;
  end if;

  insert into public.cs_reviews(parcel_id, awb, client_id, parcel_status, status_since, agent_id, agent_user, shift_id, outcome,
    category, note, preferred_date, preferred_slot, address_fix, handle_seconds, ops_issue_id)
  values (v_p.id, v_p.awb, v_p.client_id, v_p.status, coalesce(v_p.status_since, v_p.updated_at), v_agent, auth.uid(), v_shift, p_outcome,
    nullif(left(btrim(coalesce(p_category, '')), 80), ''), v_note, p_preferred_date, nullif(left(btrim(coalesce(p_preferred_slot, '')), 40), ''),
    nullif(left(btrim(coalesce(p_address_fix, '')), 300), ''),
    case when p_opened_at is null then null else least(greatest(extract(epoch from now() - p_opened_at)::int, 0), 3600) end, v_issue)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'ops_issue_id', v_issue);
end $$;

-- The agent pressed "WhatsApp the merchant".
create or replace function public.cs_mark_notified(p_review bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cs_require_access();
  perform public.cs_require_shift();
  update public.cs_reviews set merchant_notified_at = coalesce(merchant_notified_at, now())
   where id = p_review and outcome in ('valid', 'wrong_number', 'false');
end $$;

-- ── admin: team and analytics ──────────────────────────────────────────────
create or replace function public.cs_admin_agents()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.cs_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name, 'email', a.email, 'phone', a.phone,
      'status', a.status, 'joined_at', a.joined_at, 'created_at', a.created_at,
      'on_shift', exists (select 1 from public.cs_shifts s where s.agent_id = a.id and s.clock_out is null and s.last_beat > now() - interval '15 minutes'),
      'last_seen', (select max(s.last_beat) from public.cs_shifts s where s.agent_id = a.id))
    order by a.status = 'Removed', a.created_at), '[]'::jsonb) from public.cs_agents a);
end $$;

create or replace function public.cs_admin_invite(p_name text, p_email text, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_name text := btrim(coalesce(p_name, ''));
begin
  perform public.cs_require_admin();
  if length(v_name) < 2 then raise exception 'Enter the agent''s full name.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter the email they will sign in with.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users u join public.profiles p on p.id = u.id where lower(u.email) = v_email
             and (p.client_id is not null or p.rider_id is not null or p.role::text in ('admin', 'rider', 'sales'))) then
    raise exception 'That email already belongs to a NovaX merchant, rider, admin or sales login. Use a separate email.' using errcode = '22023';
  end if;
  insert into public.cs_agents(full_name, email, phone, invited_by) values (v_name, v_email, nullif(btrim(coalesce(p_phone, '')), ''), auth.uid())
  on conflict (email) do update set full_name = excluded.full_name, phone = coalesce(excluded.phone, public.cs_agents.phone),
    status = case when public.cs_agents.status = 'Removed' then (case when public.cs_agents.auth_user_id is null then 'Invited' else 'Active' end) else public.cs_agents.status end,
    removed_at = null;
  update public.profiles set role = 'support'
   where id = (select auth_user_id from public.cs_agents where email = v_email) and role::text = 'client' and client_id is null;
  return public.cs_admin_agents();
end $$;

create or replace function public.cs_admin_set_agent(p_agent uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.cs_agents;
begin
  perform public.cs_require_admin();
  if p_status not in ('Active', 'Removed') then raise exception 'Unknown status.' using errcode = '22023'; end if;
  select * into v from public.cs_agents where id = p_agent for update;
  if v.id is null then raise exception 'Agent not found.' using errcode = '22023'; end if;
  if p_status = 'Removed' then
    update public.cs_agents set status = 'Removed', removed_at = now() where id = p_agent;
    update public.cs_shifts set clock_out = now(), closed_by = 'admin' where agent_id = p_agent and clock_out is null;
    if v.auth_user_id is not null then
      update public.profiles set role = 'client' where id = v.auth_user_id and role::text = 'support';
    end if;
  else
    update public.cs_agents set status = case when auth_user_id is null then 'Invited' else 'Active' end, removed_at = null where id = p_agent;
    if v.auth_user_id is not null then
      update public.profiles set role = 'support' where id = v.auth_user_id and role::text = 'client' and client_id is null;
    end if;
  end if;
  return public.cs_admin_agents();
end $$;

-- Analytics for PKT days p_from..p_to: per agent, per day, and the queue now.
create or replace function public.cs_admin_stats(p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_from timestamptz; v_to timestamptz;
begin
  perform public.cs_require_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'Pick a range of up to 92 days.' using errcode = '22023';
  end if;
  v_from := (p_from::timestamp) at time zone 'Asia/Karachi';
  v_to := ((p_to + 1)::timestamp) at time zone 'Asia/Karachi';
  return jsonb_build_object(
    'agents', (select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.calls desc), '[]'::jsonb) from (
      select a.id, a.full_name, a.status,
        (select count(*) from public.cs_shifts s where s.agent_id = a.id and s.clock_in >= v_from and s.clock_in < v_to) as shifts,
        (select coalesce(sum(extract(epoch from coalesce(s.clock_out, s.last_beat) - s.clock_in)), 0)::int from public.cs_shifts s
          where s.agent_id = a.id and s.clock_in >= v_from and s.clock_in < v_to) as clocked_seconds,
        (select coalesce(sum(s.active_seconds), 0) from public.cs_shifts s where s.agent_id = a.id and s.clock_in >= v_from and s.clock_in < v_to) as active_seconds,
        (select coalesce(sum(s.idle_seconds), 0) from public.cs_shifts s where s.agent_id = a.id and s.clock_in >= v_from and s.clock_in < v_to) as idle_seconds,
        (select count(*) from public.cs_shifts s where s.agent_id = a.id and s.clock_in >= v_from and s.clock_in < v_to and s.closed_by = 'auto') as auto_closed,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to) as calls,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to and r.outcome = 'valid') as valid,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to and r.outcome = 'false') as to_ops,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to and r.outcome = 'no_answer') as no_answer,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to and r.outcome = 'wrong_number') as wrong_number,
        (select count(*) from public.cs_reviews r where r.agent_id = a.id and r.merchant_notified_at >= v_from and r.merchant_notified_at < v_to) as notified,
        (select count(distinct r.parcel_id) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to) as parcels,
        (select round(avg(r.handle_seconds)) from public.cs_reviews r where r.agent_id = a.id and r.created_at >= v_from and r.created_at < v_to and r.handle_seconds > 0) as avg_handle_seconds,
        (select max(s.last_beat) from public.cs_shifts s where s.agent_id = a.id) as last_seen
      from public.cs_agents a) t),
    'daily', (select coalesce(jsonb_agg(row_to_json(d)::jsonb order by d.day), '[]'::jsonb) from (
      select g.day::date as day,
        (select count(*) from public.cs_reviews r where (r.created_at at time zone 'Asia/Karachi')::date = g.day) as calls,
        (select count(*) from public.cs_reviews r where (r.created_at at time zone 'Asia/Karachi')::date = g.day and r.outcome = 'false') as to_ops,
        (select count(*) from public.cs_reviews r where (r.created_at at time zone 'Asia/Karachi')::date = g.day and r.outcome in ('valid', 'wrong_number')) as valid,
        (select coalesce(sum(s.active_seconds), 0) from public.cs_shifts s where (s.clock_in at time zone 'Asia/Karachi')::date = g.day) as active_seconds,
        (select count(*) from public.nv_parcel_status_log l where (l.changed_at at time zone 'Asia/Karachi')::date = g.day
          and l.to_status in ('Refused', 'Consignee not available')) as entered_queue
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)) d),
    'response', (select jsonb_build_object(
        'first_calls', count(*),
        'median_minutes', round((percentile_cont(0.5) within group (order by extract(epoch from f.first_at - f.status_since)) / 60)::numeric),
        'within_2h', count(*) filter (where f.first_at - f.status_since <= interval '2 hours'))
      from (select r.parcel_id, r.status_since, min(r.created_at) as first_at from public.cs_reviews r
             where r.created_at >= v_from and r.created_at < v_to and r.status_since is not null
             group by r.parcel_id, r.status_since) f),
    'queue', (select jsonb_build_object('open', count(*),
        'refused', count(*) filter (where p.status = 'Refused'),
        'not_available', count(*) filter (where p.status = 'Consignee not available'),
        'never_called', count(*) filter (where not exists (select 1 from public.cs_reviews r where r.parcel_id = p.id
                                         and r.created_at >= coalesce(p.status_since, p.updated_at))),
        'oldest_uncalled', min(coalesce(p.status_since, p.updated_at)) filter (where not exists (select 1 from public.cs_reviews r
                                         where r.parcel_id = p.id and r.created_at >= coalesce(p.status_since, p.updated_at))))
      from public.parcels p where p.status in ('Refused', 'Consignee not available')));
end $$;

create or replace function public.cs_admin_shifts(p_agent uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.cs_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'clock_in', s.clock_in, 'clock_out', s.clock_out, 'last_beat', s.last_beat,
      'active_seconds', s.active_seconds, 'idle_seconds', s.idle_seconds, 'closed_by', s.closed_by, 'ip', s.ip,
      'calls', (select count(*) from public.cs_reviews r where r.shift_id = s.id)) order by s.clock_in desc), '[]'::jsonb)
    from public.cs_shifts s
    where s.agent_id = p_agent and s.clock_in >= (p_from::timestamp) at time zone 'Asia/Karachi'
      and s.clock_in < ((p_to + 1)::timestamp) at time zone 'Asia/Karachi');
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'cs_current_agent()', 'cs_require_access()', 'cs_require_admin()', 'cs_require_shift()', 'cs_join()', 'cs_me()',
    'cs_clock_in(text)', 'cs_heartbeat(boolean)', 'cs_clock_out()', 'cs_close_stale_shifts()', 'cs_queue()',
    'cs_log_review(uuid, text, text, text, date, text, text, timestamptz)', 'cs_mark_notified(bigint)',
    'cs_admin_agents()', 'cs_admin_invite(text, text, text)', 'cs_admin_set_agent(uuid, text)',
    'cs_admin_stats(date, date)', 'cs_admin_shifts(uuid, date, date)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
  end loop;
  foreach f in array array[
    'cs_me()', 'cs_clock_in(text)', 'cs_heartbeat(boolean)', 'cs_clock_out()', 'cs_queue()',
    'cs_log_review(uuid, text, text, text, date, text, text, timestamptz)', 'cs_mark_notified(bigint)',
    'cs_admin_agents()', 'cs_admin_invite(text, text, text)', 'cs_admin_set_agent(uuid, text)',
    'cs_admin_stats(date, date)', 'cs_admin_shifts(uuid, date, date)']
  loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.cs_close_stale_shifts() from authenticated';
end $$;

select cron.unschedule('novax-support-stale-shifts') where exists (select 1 from cron.job where jobname = 'novax-support-stale-shifts');
select cron.schedule('novax-support-stale-shifts', '*/10 * * * *', 'select public.cs_close_stale_shifts();');

notify pgrst, 'reload schema';
