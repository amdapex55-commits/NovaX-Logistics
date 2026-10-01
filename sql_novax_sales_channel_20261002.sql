-- NovaX sales channel (2 Oct 2026).
-- Commission-only remote sales reps cold-call leads. Each rep has a login on
-- sales.html that shows only their own leads, their stores and their rewards;
-- admins see everything there through the same page. Reps never get admin.
--
-- Rules (Aisha's defaults, changeable in sales_settings):
--   * Rs 500 "account opened": the store is credited to the rep AND its CNIC is
--     verified by the NovaX team.
--   * Rs 500 "first pickup": the store's first parcel has been collected; it is
--     earned once that store has a delivered parcel, or 7 days after the
--     pickup if that parcel was not cancelled, refused or returned.
--   * A store is credited to a rep by (1) the rep's code on the signup, or
--     (2) its phone matching a lead assigned to that rep in the 30 days before
--     it signed up, or (3) a claim the rep files and an admin approves. If the
--     code and the lead point at different reps, an admin decides.
--   * A lead nobody has called within 7 days of being assigned goes back to
--     the pool.
-- Tables are reachable only through the functions below (RLS on, no grants).

alter type public.novax_role add value if not exists 'sales';

begin;

create table if not exists public.sales_settings (
  key text primary key,
  value text not null
);
insert into public.sales_settings(key, value) values
  ('reward_account_opened', '500'), ('reward_first_pickup', '500'),
  ('lead_untouched_days', '7'), ('lead_window_days', '30'), ('pickup_hold_days', '7')
on conflict (key) do nothing;

create table if not exists public.sales_reps (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,12}$'),
  full_name text not null check (char_length(full_name) between 2 and 80),
  email text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  auth_user_id uuid unique,
  status text not null default 'Invited' check (status in ('Invited', 'Active', 'Removed')),
  joined_on date,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

create table if not exists public.sales_prospects (
  id uuid primary key default gen_random_uuid(),
  lead_ref text unique,
  store_name text not null check (char_length(store_name) between 1 and 120),
  contact_name text,
  phone text not null unique check (phone ~ '^03[0-9]{9}$'),
  city text,
  category text,
  source text,
  store_link text,
  est_orders text,
  rep_id uuid references public.sales_reps(id),
  assigned_at timestamptz,
  status text not null default 'Not called' check (status in
    ('Not called', 'No answer', 'Busy', 'Wrong number', 'Not interested', 'Interested', 'Call back', 'Demo booked', 'Signed up')),
  call_count int not null default 0,
  last_called_at timestamptz,
  next_followup_on date,
  last_note text,
  client_id uuid references public.clients(id),
  signed_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_prospects_rep_idx on public.sales_prospects(rep_id);

create table if not exists public.sales_calls (
  id bigserial primary key,
  prospect_id uuid not null references public.sales_prospects(id) on delete cascade,
  rep_id uuid not null references public.sales_reps(id),
  outcome text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists sales_calls_rep_idx on public.sales_calls(rep_id, created_at);

create table if not exists public.sales_attributions (
  client_id uuid primary key references public.clients(id) on delete cascade,
  rep_id uuid not null references public.sales_reps(id),
  alt_rep_id uuid references public.sales_reps(id),
  method text not null check (method in ('ref_code', 'phone_match', 'claim', 'admin')),
  status text not null default 'Approved' check (status in ('Approved', 'Pending', 'Rejected')),
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);

create table if not exists public.sales_rewards (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references public.sales_reps(id),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('account_opened', 'first_pickup')),
  amount numeric not null check (amount >= 0),
  status text not null default 'Waiting' check (status in ('Waiting', 'Earned', 'Approved', 'Paid', 'Rejected')),
  earned_at timestamptz,
  approved_at timestamptz,
  paid_at timestamptz,
  paid_ref text,
  note text,
  created_at timestamptz not null default now(),
  unique (client_id, kind)
);

alter table public.sales_settings enable row level security;
alter table public.sales_reps enable row level security;
alter table public.sales_prospects enable row level security;
alter table public.sales_calls enable row level security;
alter table public.sales_attributions enable row level security;
alter table public.sales_rewards enable row level security;
revoke all on public.sales_settings, public.sales_reps, public.sales_prospects, public.sales_calls,
  public.sales_attributions, public.sales_rewards from anon, authenticated;
revoke all on sequence public.sales_calls_id_seq from anon, authenticated;

-- ── helpers ──────────────────────────────────────────────────────────────
create or replace function public.sales_norm_phone(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when d ~ '^0092' then '0' || substr(d, 5)
    when d ~ '^92' and char_length(d) = 12 then '0' || substr(d, 3)
    when d ~ '^3[0-9]{9}$' then '0' || d
    else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

create or replace function public.sales_setting_int(p_key text)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce((select value::int from public.sales_settings where key = p_key), 0);
$$;

-- The active rep behind this session, or null.
create or replace function public.sales_current_rep()
returns uuid language sql stable security definer set search_path = '' as $$
  select r.id from public.sales_reps r
  where r.auth_user_id = auth.uid() and r.status = 'Active';
$$;

create or replace function public.sales_require_rep()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.sales_current_rep();
begin
  if v is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  return v;
end $$;

create or replace function public.sales_require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only NovaX admins can do this.' using errcode = '42501'; end if;
end $$;

-- ── who am I ─────────────────────────────────────────────────────────────
create or replace function public.sales_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'rep', (select jsonb_build_object('id', r.id, 'code', r.code, 'full_name', r.full_name, 'status', r.status, 'joined_on', r.joined_on)
            from public.sales_reps r where r.auth_user_id = auth.uid()),
    'email', (select u.email from auth.users u where u.id = auth.uid()));
$$;

-- A rep invited by an admin links the login they just made (same email).
create or replace function public.sales_join(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := (select lower(u.email) from auth.users u where u.id = auth.uid());
  v_rep public.sales_reps;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into v_rep from public.sales_reps r where r.code = upper(btrim(coalesce(p_code, ''))) for update;
  if v_rep.id is null or v_rep.status = 'Removed' then
    raise exception 'That rep code is not active. Check it with NovaX.' using errcode = '22023';
  end if;
  if v_rep.email <> v_email then
    raise exception 'This code was issued to a different email address. Sign up with the email NovaX has for you.' using errcode = '42501';
  end if;
  if v_rep.auth_user_id is not null and v_rep.auth_user_id <> v_uid then
    raise exception 'This rep code is already linked to another login.' using errcode = '42501';
  end if;
  -- Never turn a merchant, rider or admin login into a sales login.
  if exists (select 1 from public.profiles p where p.id = v_uid and (p.client_id is not null or p.role in ('admin', 'rider'))) then
    raise exception 'This login already belongs to a NovaX account. Use a separate email for sales.' using errcode = '42501';
  end if;
  update public.sales_reps set auth_user_id = v_uid, status = 'Active', joined_on = coalesce(joined_on, (now() at time zone 'Asia/Karachi')::date)
   where id = v_rep.id;
  insert into public.profiles(id, email, full_name, role) values (v_uid, v_email, v_rep.full_name, 'sales')
  on conflict (id) do update set role = 'sales', full_name = excluded.full_name;
  return public.sales_me();
end $$;

-- ── rep: leads and calls ─────────────────────────────────────────────────
create or replace function public.sales_my_leads()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'store_name', p.store_name, 'contact_name', p.contact_name, 'phone', p.phone,
      'city', p.city, 'category', p.category, 'source', p.source, 'store_link', p.store_link,
      'est_orders', p.est_orders, 'status', p.status, 'call_count', p.call_count,
      'last_called_at', p.last_called_at, 'next_followup_on', p.next_followup_on,
      'last_note', p.last_note, 'assigned_at', p.assigned_at, 'signed_up_at', p.signed_up_at)
    order by (p.next_followup_on is null), p.next_followup_on, p.assigned_at), '[]'::jsonb)
  from public.sales_prospects p
  where p.rep_id = public.sales_require_rep();
$$;

create or replace function public.sales_log_call(p_prospect uuid, p_outcome text, p_note text default null, p_followup date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_require_rep();
  v_p public.sales_prospects;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if p_outcome not in ('No answer', 'Busy', 'Wrong number', 'Not interested', 'Interested', 'Call back', 'Demo booked') then
    raise exception 'Pick what happened on the call.' using errcode = '22023';
  end if;
  select * into v_p from public.sales_prospects where id = p_prospect for update;
  if v_p.id is null or v_p.rep_id is distinct from v_rep then
    raise exception 'This lead is not assigned to you any more.' using errcode = '42501';
  end if;
  if v_p.status = 'Signed up' then
    raise exception 'This store has already signed up.' using errcode = '22023';
  end if;
  if p_outcome in ('Call back', 'Demo booked') and p_followup is null then
    raise exception 'Pick the date to follow up.' using errcode = '22023';
  end if;
  if p_followup is not null and (p_followup < v_today or p_followup > v_today + 60) then
    raise exception 'Pick a follow-up date within the next 60 days.' using errcode = '22023';
  end if;
  if (select count(*) from public.sales_calls c where c.rep_id = v_rep and c.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many calls logged in a minute. Wait a moment.' using errcode = '54000';
  end if;
  insert into public.sales_calls(prospect_id, rep_id, outcome, note) values (v_p.id, v_rep, p_outcome, v_note);
  update public.sales_prospects set
    status = p_outcome, call_count = call_count + 1, last_called_at = now(),
    next_followup_on = case when p_outcome in ('Not interested', 'Wrong number') then null else p_followup end,
    last_note = coalesce(v_note, last_note), updated_at = now()
  where id = v_p.id;
  return (select to_jsonb(x) - 'rep_id' - 'client_id' from public.sales_prospects x where x.id = v_p.id);
end $$;

-- ── rep: stores and rewards ──────────────────────────────────────────────
create or replace function public.sales_store_milestones(p_client uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cnic_verified', exists (select 1 from public.client_kyc k where k.client_id = p_client and k.status = 'verified'),
    'picked_up', exists (select 1 from public.parcels p where p.client_id = p_client
                          and p.status not in ('New booked', 'Cancelled by client')),
    'delivered', exists (select 1 from public.parcels p where p.client_id = p_client and p.status = 'Delivered'));
$$;

create or replace function public.sales_my_stores()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'client_id', a.client_id, 'store_name', c.name, 'city', c.city,
      'signed_up_at', c.created_at, 'method', a.method, 'status', a.status,
      'milestones', public.sales_store_milestones(a.client_id),
      'rewards', (select coalesce(jsonb_object_agg(w.kind, w.status), '{}'::jsonb) from public.sales_rewards w where w.client_id = a.client_id and w.rep_id = a.rep_id))
    order by c.created_at desc), '[]'::jsonb)
  from public.sales_attributions a join public.clients c on c.id = a.client_id
  where a.rep_id = public.sales_require_rep() and a.status <> 'Rejected';
$$;

create or replace function public.sales_my_earnings()
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select public.sales_require_rep() as rep)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'waiting', coalesce(sum(amount) filter (where status = 'Waiting'), 0),
        'earned', coalesce(sum(amount) filter (where status = 'Earned'), 0),
        'approved', coalesce(sum(amount) filter (where status = 'Approved'), 0),
        'paid', coalesce(sum(amount) filter (where status = 'Paid'), 0))
      from public.sales_rewards w, me where w.rep_id = me.rep),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', w.id, 'store_name', c.name, 'kind', w.kind, 'amount', w.amount, 'status', w.status,
        'earned_at', w.earned_at, 'paid_at', w.paid_at, 'paid_ref', w.paid_ref, 'note', w.note)
      order by coalesce(w.earned_at, w.created_at) desc), '[]'::jsonb)
      from public.sales_rewards w join public.clients c on c.id = w.client_id, me where w.rep_id = me.rep));
$$;

-- A rep says "this store signed up through me" when no code or lead caught it.
create or replace function public.sales_claim_store(p_phone text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_require_rep();
  v_phone text := public.sales_norm_phone(p_phone);
  v_client public.clients;
  v_cur public.sales_attributions;
begin
  if v_phone !~ '^03[0-9]{9}$' then raise exception 'Enter the store''s mobile number, like 0300 1234567.' using errcode = '22023'; end if;
  if (select count(*) from public.sales_attributions a where a.rep_id = v_rep and a.method = 'claim' and a.status = 'Pending') >= 20 then
    raise exception 'You have 20 claims waiting for NovaX. Wait for those to be checked.' using errcode = '54000';
  end if;
  select * into v_client from public.clients c
   where public.sales_norm_phone(c.phone) = v_phone and c.created_at > now() - interval '60 days'
   order by c.created_at desc limit 1;
  if v_client.id is null then
    raise exception 'No store with that number has signed up in the last 60 days. Ask them to sign up with your code.' using errcode = '22023';
  end if;
  select * into v_cur from public.sales_attributions where client_id = v_client.id;
  if v_cur.client_id is not null then
    if v_cur.rep_id = v_rep then return jsonb_build_object('ok', true, 'message', 'This store is already yours.'); end if;
    raise exception 'This store is already credited to another rep. Talk to NovaX if you think that is wrong.' using errcode = '22023';
  end if;
  insert into public.sales_attributions(client_id, rep_id, method, status, note)
  values (v_client.id, v_rep, 'claim', 'Pending', nullif(left(btrim(coalesce(p_note, '')), 300), ''));
  return jsonb_build_object('ok', true, 'message', 'Claim sent. NovaX will check it and you will see it under My stores.', 'store_name', v_client.name);
end $$;

-- ── the engine: credit stores, mark signups, pay rewards, free stale leads ─
create or replace function public.sales_refresh()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_window int := public.sales_setting_int('lead_window_days');
  v_hold int := public.sales_setting_int('pickup_hold_days');
  v_untouched int := public.sales_setting_int('lead_untouched_days');
  v_new int := 0; v_freed int := 0; v_earned int := 0;
  r record;
  v_code_rep uuid; v_lead_rep uuid; v_lead uuid;
begin
  -- The cron job runs as the database owner; through the API only an admin may.
  if session_user::text = 'authenticator' and not public.is_admin() then
    raise exception 'Only NovaX admins can do this.' using errcode = '42501';
  end if;

  -- 1. Credit new stores (last 60 days) that nobody has been credited with yet.
  for r in
    select c.id, c.phone, c.created_at,
      (select upper(btrim(u.raw_user_meta_data->>'sales_ref'))
         from public.profiles p join auth.users u on u.id = p.id
        where p.client_id = c.id order by p.created_at limit 1) as ref
    from public.clients c
    where c.created_at > now() - interval '60 days'
      and not exists (select 1 from public.sales_attributions a where a.client_id = c.id)
      and c.name !~* '^\s*(test|testt|test account|test accoiunt|test client|test store|novax merchant)\s*$'
  loop
    v_code_rep := (select s.id from public.sales_reps s where s.code = r.ref and s.status <> 'Removed');
    select s.rep_id, s.id into v_lead_rep, v_lead from public.sales_prospects s
     where s.phone = public.sales_norm_phone(r.phone) and s.rep_id is not null
       and s.assigned_at <= r.created_at + interval '1 day'
       and s.assigned_at >= r.created_at - make_interval(days => v_window)
     limit 1;
    if v_code_rep is not null or v_lead_rep is not null then
      insert into public.sales_attributions(client_id, rep_id, alt_rep_id, method, status, note)
      values (r.id, coalesce(v_code_rep, v_lead_rep),
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then v_lead_rep end,
              case when v_code_rep is not null then 'ref_code' else 'phone_match' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then 'Pending' else 'Approved' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep
                   then 'Signed up with one rep''s code but was on another rep''s lead list.' end)
      on conflict (client_id) do nothing;
      v_new := v_new + 1;
    end if;
    -- The lead, whoever owns it, is now a store.
    update public.sales_prospects s set status = 'Signed up', client_id = r.id, signed_up_at = r.created_at,
           next_followup_on = null, updated_at = now()
     where s.phone = public.sales_norm_phone(r.phone) and s.client_id is null;
    v_lead_rep := null; v_lead := null; v_code_rep := null;
  end loop;

  -- 2. Rewards for credited stores.
  for r in
    select a.client_id, a.rep_id,
      exists (select 1 from public.client_kyc k where k.client_id = a.client_id and k.status = 'verified') as verified,
      (select min(l.changed_at) from public.nv_parcel_status_log l
        where l.client_id = a.client_id and l.from_status = 'New booked'
          and l.to_status not in ('Cancelled by client')) as picked_at,
      exists (select 1 from public.parcels p where p.client_id = a.client_id
               and p.status not in ('New booked', 'Cancelled by client')) as picked_any,
      exists (select 1 from public.parcels p where p.client_id = a.client_id and p.status = 'Delivered') as delivered
    from public.sales_attributions a
    where a.status = 'Approved'
  loop
    insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
    values (r.rep_id, r.client_id, 'account_opened', public.sales_setting_int('reward_account_opened'), 'Waiting')
    on conflict (client_id, kind) do nothing;
    if r.verified then
      update public.sales_rewards set status = 'Earned', earned_at = now()
       where client_id = r.client_id and kind = 'account_opened' and status = 'Waiting';
      if found then v_earned := v_earned + 1; end if;
    end if;
    if r.picked_any then
      insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
      values (r.rep_id, r.client_id, 'first_pickup', public.sales_setting_int('reward_first_pickup'), 'Waiting')
      on conflict (client_id, kind) do nothing;
      if r.delivered or (r.picked_at is not null and r.picked_at < now() - make_interval(days => v_hold)
           and exists (select 1 from public.parcels p where p.client_id = r.client_id
                        and p.status not in ('New booked', 'Cancelled by client', 'Refused', 'Return to shipper'))) then
        update public.sales_rewards set status = 'Earned', earned_at = now()
         where client_id = r.client_id and kind = 'first_pickup' and status = 'Waiting';
        if found then v_earned := v_earned + 1; end if;
      end if;
    end if;
  end loop;

  -- 3. Leads nobody called within the window go back to the pool.
  update public.sales_prospects set rep_id = null, assigned_at = null, updated_at = now()
   where rep_id is not null and call_count = 0 and status = 'Not called'
     and assigned_at < now() - make_interval(days => v_untouched);
  get diagnostics v_freed = row_count;

  return jsonb_build_object('credited', v_new, 'rewards_earned', v_earned, 'leads_freed', v_freed);
end $$;

-- ── admin ────────────────────────────────────────────────────────────────
create or replace function public.sales_admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform public.sales_require_admin();
  return jsonb_build_object(
    'reps', (select coalesce(jsonb_agg(x order by x->>'status', x->>'full_name'), '[]'::jsonb) from (
      select jsonb_build_object(
        'id', r.id, 'code', r.code, 'full_name', r.full_name, 'email', r.email, 'phone', r.phone,
        'status', r.status, 'joined_on', r.joined_on,
        'leads_open', (select count(*) from public.sales_prospects p where p.rep_id = r.id and p.status <> 'Signed up'),
        'followups_due', (select count(*) from public.sales_prospects p where p.rep_id = r.id and p.next_followup_on <= v_today),
        'calls_today', (select count(*) from public.sales_calls c where c.rep_id = r.id and (c.created_at at time zone 'Asia/Karachi')::date = v_today),
        'calls_7d', (select count(*) from public.sales_calls c where c.rep_id = r.id and c.created_at > now() - interval '7 days'),
        'calls_total', (select count(*) from public.sales_calls c where c.rep_id = r.id),
        'last_call_at', (select max(c.created_at) from public.sales_calls c where c.rep_id = r.id),
        'reached', (select count(*) from public.sales_prospects p where p.rep_id = r.id and p.status in ('Interested', 'Call back', 'Demo booked', 'Not interested', 'Signed up')),
        'interested', (select count(*) from public.sales_prospects p where p.rep_id = r.id and p.status in ('Interested', 'Call back', 'Demo booked')),
        'signups', (select count(*) from public.sales_attributions a where a.rep_id = r.id and a.status = 'Approved'),
        'first_pickups', (select count(*) from public.sales_rewards w where w.rep_id = r.id and w.kind = 'first_pickup' and w.status in ('Earned', 'Approved', 'Paid')),
        'owed', (select coalesce(sum(w.amount), 0) from public.sales_rewards w where w.rep_id = r.id and w.status in ('Earned', 'Approved')),
        'paid', (select coalesce(sum(w.amount), 0) from public.sales_rewards w where w.rep_id = r.id and w.status = 'Paid')) as x
      from public.sales_reps r) t),
    'pool', (select count(*) from public.sales_prospects p where p.rep_id is null and p.status not in ('Signed up', 'Not interested', 'Wrong number')),
    'leads_total', (select count(*) from public.sales_prospects),
    'pending_claims', (select count(*) from public.sales_attributions a where a.status = 'Pending'),
    'rewards_to_approve', (select count(*) from public.sales_rewards w where w.status = 'Earned'),
    'owed_total', (select coalesce(sum(w.amount), 0) from public.sales_rewards w where w.status in ('Earned', 'Approved')),
    'settings', (select jsonb_object_agg(s.key, s.value) from public.sales_settings s where s.key <> 'sheet_token_hash'),
    'sheet_connected', exists (select 1 from public.sales_settings s where s.key = 'sheet_token_hash'));
end $$;

create or replace function public.sales_admin_invite(p_name text, p_email text, p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); v_email text := lower(btrim(coalesce(p_email, ''))); v_id uuid;
begin
  perform public.sales_require_admin();
  if char_length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Enter the rep''s full name.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email for the rep.' using errcode = '22023'; end if;
  if v_code !~ '^[A-Z0-9]{3,12}$' then raise exception 'The rep code must be 3 to 12 letters or numbers, like AYESHA or SALES01.' using errcode = '22023'; end if;
  if exists (select 1 from public.sales_reps where code = v_code) then raise exception 'That code is already taken.' using errcode = '23505'; end if;
  if exists (select 1 from public.sales_reps where email = v_email) then raise exception 'That email already has a rep.' using errcode = '23505'; end if;
  insert into public.sales_reps(code, full_name, email, phone)
  values (v_code, btrim(p_name), v_email, nullif(public.sales_norm_phone(p_phone), ''))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

create or replace function public.sales_admin_set_rep_status(p_rep uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_rep public.sales_reps;
begin
  perform public.sales_require_admin();
  if p_status not in ('Active', 'Removed') then raise exception 'Unknown status.' using errcode = '22023'; end if;
  select * into v_rep from public.sales_reps where id = p_rep for update;
  if v_rep.id is null then raise exception 'Rep not found.' using errcode = '22023'; end if;
  if p_status = 'Removed' then
    update public.sales_reps set status = 'Removed', removed_at = now() where id = p_rep;
    -- Their uncalled and open leads go back to the pool; signed-up stores stay theirs.
    update public.sales_prospects set rep_id = null, assigned_at = null, updated_at = now()
     where rep_id = p_rep and status <> 'Signed up';
    if v_rep.auth_user_id is not null then
      update public.profiles set role = 'client' where id = v_rep.auth_user_id and role = 'sales';
    end if;
  else
    update public.sales_reps set status = case when auth_user_id is null then 'Invited' else 'Active' end, removed_at = null where id = p_rep;
    if v_rep.auth_user_id is not null then
      update public.profiles set role = 'sales' where id = v_rep.auth_user_id and role = 'client' and client_id is null;
    end if;
  end if;
end $$;

-- Rows from a sheet or a pasted CSV. Upserts by lead_ref (or phone), never
-- moves a lead between reps unless asked, and says why any row was skipped.
create or replace function public.sales_upsert_leads(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; v_phone text; v_ref text; v_name text; v_rep uuid; v_code text; v_id uuid; v_existing public.sales_prospects;
  v_ins int := 0; v_upd int := 0; v_skip jsonb := '[]'::jsonb; v_i int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Expected a list of rows.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Send at most 2,000 rows at a time.' using errcode = '22023'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_phone := public.sales_norm_phone(r->>'phone');
    v_ref := nullif(left(btrim(coalesce(r->>'lead_ref', '')), 60), '');
    v_name := nullif(left(btrim(coalesce(r->>'store_name', '')), 120), '');
    v_code := upper(btrim(coalesce(r->>'assign_to', '')));
    if v_name is null then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Store name is empty'); continue; end if;
    if v_phone !~ '^03[0-9]{9}$' then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Phone is not a Pakistani mobile number'); continue; end if;
    v_rep := null;
    if v_code <> '' then
      v_rep := (select id from public.sales_reps where code = v_code and status <> 'Removed');
      if v_rep is null then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'No active rep with code ' || v_code); continue; end if;
    end if;
    select * into v_existing from public.sales_prospects p
     where (v_ref is not null and p.lead_ref = v_ref) or p.phone = v_phone
     order by (p.lead_ref = v_ref) desc nulls last limit 1;
    if v_existing.id is null then
      insert into public.sales_prospects(lead_ref, store_name, contact_name, phone, city, category, source, store_link, est_orders, rep_id, assigned_at)
      values (v_ref, v_name, nullif(left(btrim(coalesce(r->>'contact_name', '')), 80), ''), v_phone,
              nullif(left(btrim(coalesce(r->>'city', '')), 40), ''), nullif(left(btrim(coalesce(r->>'category', '')), 60), ''),
              nullif(left(btrim(coalesce(r->>'source', '')), 40), ''), nullif(left(btrim(coalesce(r->>'store_link', '')), 300), ''),
              nullif(left(btrim(coalesce(r->>'est_orders', '')), 30), ''), v_rep, case when v_rep is not null then now() end);
      v_ins := v_ins + 1;
    else
      if v_existing.phone <> v_phone and exists (select 1 from public.sales_prospects where phone = v_phone) then
        v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Another lead already has this phone'); continue;
      end if;
      update public.sales_prospects set
        lead_ref = coalesce(v_ref, lead_ref), store_name = v_name, phone = v_phone,
        contact_name = coalesce(nullif(left(btrim(coalesce(r->>'contact_name', '')), 80), ''), contact_name),
        city = coalesce(nullif(left(btrim(coalesce(r->>'city', '')), 40), ''), city),
        category = coalesce(nullif(left(btrim(coalesce(r->>'category', '')), 60), ''), category),
        source = coalesce(nullif(left(btrim(coalesce(r->>'source', '')), 40), ''), source),
        store_link = coalesce(nullif(left(btrim(coalesce(r->>'store_link', '')), 300), ''), store_link),
        est_orders = coalesce(nullif(left(btrim(coalesce(r->>'est_orders', '')), 30), ''), est_orders),
        rep_id = case when v_rep is not null and status <> 'Signed up' then v_rep else rep_id end,
        assigned_at = case when v_rep is not null and status <> 'Signed up' and rep_id is distinct from v_rep then now() else assigned_at end,
        updated_at = now()
      where id = v_existing.id;
      v_upd := v_upd + 1;
    end if;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip);
end $$;

create or replace function public.sales_admin_import(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return public.sales_upsert_leads(p_rows);
end $$;

create or replace function public.sales_admin_leads(p_rep uuid default null, p_status text default null, p_search text default null, p_pool boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'lead_ref', p.lead_ref, 'store_name', p.store_name, 'contact_name', p.contact_name, 'phone', p.phone,
      'city', p.city, 'category', p.category, 'source', p.source, 'status', p.status, 'call_count', p.call_count,
      'last_called_at', p.last_called_at, 'next_followup_on', p.next_followup_on, 'last_note', p.last_note,
      'rep_code', r.code, 'assigned_at', p.assigned_at, 'signed_up_at', p.signed_up_at)
    order by p.updated_at desc), '[]'::jsonb)
  from (select * from public.sales_prospects p
        where (p_rep is null or p.rep_id = p_rep)
          and (not p_pool or p.rep_id is null)
          and (p_status is null or p.status = p_status)
          and (p_search is null or p.store_name ilike '%' || p_search || '%' or p.phone like '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
        order by p.updated_at desc limit 500) p
  left join public.sales_reps r on r.id = p.rep_id);
end $$;

-- Hand out the next n leads from the pool (oldest first, optionally one city).
create or replace function public.sales_admin_assign(p_rep uuid, p_count int, p_city text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform public.sales_require_admin();
  if not exists (select 1 from public.sales_reps where id = p_rep and status <> 'Removed') then raise exception 'Pick an active rep.' using errcode = '22023'; end if;
  if p_count is null or p_count < 1 or p_count > 500 then raise exception 'Hand out between 1 and 500 leads.' using errcode = '22023'; end if;
  update public.sales_prospects set rep_id = p_rep, assigned_at = now(), updated_at = now()
   where id in (select id from public.sales_prospects
                 where rep_id is null and status not in ('Signed up', 'Not interested', 'Wrong number')
                   and (p_city is null or city ilike p_city)
                 order by created_at limit p_count for update skip locked);
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.sales_admin_reassign(p_prospect uuid, p_rep uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  if p_rep is not null and not exists (select 1 from public.sales_reps where id = p_rep and status <> 'Removed') then
    raise exception 'Pick an active rep.' using errcode = '22023'; end if;
  update public.sales_prospects set rep_id = p_rep, assigned_at = case when p_rep is null then null else now() end, updated_at = now()
   where id = p_prospect and status <> 'Signed up';
  if not found then raise exception 'That lead has signed up or no longer exists.' using errcode = '22023'; end if;
end $$;

create or replace function public.sales_admin_attributions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'client_id', a.client_id, 'store_name', c.name, 'city', c.city, 'phone', c.phone, 'signed_up_at', c.created_at,
      'rep_id', a.rep_id, 'rep_code', r.code, 'alt_rep_id', a.alt_rep_id, 'alt_rep_code', r2.code,
      'method', a.method, 'status', a.status, 'note', a.note, 'created_at', a.created_at)
    order by (a.status = 'Pending') desc, a.created_at desc), '[]'::jsonb)
  from (select * from public.sales_attributions order by (status = 'Pending') desc, created_at desc limit 300) a
  join public.clients c on c.id = a.client_id
  join public.sales_reps r on r.id = a.rep_id
  left join public.sales_reps r2 on r2.id = a.alt_rep_id);
end $$;

create or replace function public.sales_admin_decide(p_client uuid, p_status text, p_rep uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  if p_status not in ('Approved', 'Rejected') then raise exception 'Approve or reject.' using errcode = '22023'; end if;
  if p_rep is not null and not exists (select 1 from public.sales_reps where id = p_rep) then raise exception 'Unknown rep.' using errcode = '22023'; end if;
  update public.sales_attributions set status = p_status, rep_id = coalesce(p_rep, rep_id),
         decided_at = now(), decided_by = auth.uid()
   where client_id = p_client;
  if not found then raise exception 'Nothing to decide for that store.' using errcode = '22023'; end if;
  -- A rejected or moved credit takes back rewards nobody has been paid for yet.
  update public.sales_rewards set status = 'Rejected', note = 'Store credit changed by NovaX'
   where client_id = p_client and status in ('Waiting', 'Earned', 'Approved')
     and (p_status = 'Rejected' or rep_id <> (select rep_id from public.sales_attributions where client_id = p_client));
  if p_status = 'Approved' then perform public.sales_refresh(); end if;
end $$;

create or replace function public.sales_admin_credit(p_client uuid, p_rep uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  insert into public.sales_attributions(client_id, rep_id, method, status, decided_at, decided_by)
  values (p_client, p_rep, 'admin', 'Approved', now(), auth.uid())
  on conflict (client_id) do update set rep_id = excluded.rep_id, method = 'admin', status = 'Approved', decided_at = now(), decided_by = auth.uid();
  perform public.sales_refresh();
end $$;

create or replace function public.sales_admin_rewards(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'rep_code', r.code, 'rep_name', r.full_name, 'store_name', c.name, 'kind', w.kind, 'amount', w.amount,
      'status', w.status, 'earned_at', w.earned_at, 'approved_at', w.approved_at, 'paid_at', w.paid_at, 'paid_ref', w.paid_ref, 'note', w.note)
    order by coalesce(w.earned_at, w.created_at) desc), '[]'::jsonb)
  from public.sales_rewards w join public.sales_reps r on r.id = w.rep_id join public.clients c on c.id = w.client_id
  where p_status is null or w.status = p_status);
end $$;

-- Earned -> Approved -> Paid, or Rejected. Paid needs the bank reference.
create or replace function public.sales_admin_set_rewards(p_ids uuid[], p_status text, p_ref text default null, p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform public.sales_require_admin();
  if p_status = 'Approved' then
    update public.sales_rewards set status = 'Approved', approved_at = now() where id = any(p_ids) and status = 'Earned';
  elsif p_status = 'Paid' then
    if char_length(btrim(coalesce(p_ref, ''))) < 3 then raise exception 'Enter the bank or transfer reference.' using errcode = '22023'; end if;
    update public.sales_rewards set status = 'Paid', paid_at = now(), paid_ref = left(btrim(p_ref), 80)
     where id = any(p_ids) and status in ('Earned', 'Approved');
  elsif p_status = 'Rejected' then
    if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why, so the rep can see it.' using errcode = '22023'; end if;
    update public.sales_rewards set status = 'Rejected', note = left(btrim(p_note), 200) where id = any(p_ids) and status <> 'Paid';
  else
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  get diagnostics v = row_count;
  return v;
end $$;

-- ── Google Sheet sync ────────────────────────────────────────────────────
-- The admin makes a key once; the sheet's script sends it with every sync.
-- Only its SHA-256 is stored.
create or replace function public.sales_admin_sheet_key()
returns text language plpgsql security definer set search_path = '' as $$
declare v_key text := 'nvs_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform public.sales_require_admin();
  insert into public.sales_settings(key, value) values ('sheet_token_hash', encode(sha256(convert_to(v_key, 'UTF8')), 'hex'))
  on conflict (key) do update set value = excluded.value;
  return v_key;
end $$;

create or replace function public.sales_sheet_sync(p_key text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_hash text := (select value from public.sales_settings where key = 'sheet_token_hash'); v_res jsonb;
begin
  if v_hash is null or p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> v_hash then
    raise exception 'This sheet is not connected to NovaX. Paste the current key from the Sales page.' using errcode = '42501';
  end if;
  if not public.nv_track_rate_ok('salessheet', 60, interval '10 minutes') then
    raise exception 'Too many syncs. Wait a few minutes.' using errcode = '54000';
  end if;
  v_res := case when jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then public.sales_upsert_leads(p_rows) else '{}'::jsonb end;
  return v_res || jsonb_build_object('leads', (select coalesce(jsonb_agg(jsonb_build_object(
      'lead_ref', p.lead_ref, 'phone', p.phone, 'rep_code', r.code, 'status', p.status, 'call_count', p.call_count,
      'last_called_at', to_char(p.last_called_at at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
      'next_followup_on', p.next_followup_on, 'last_note', p.last_note,
      'signed_up_on', to_char(p.signed_up_at at time zone 'Asia/Karachi', 'YYYY-MM-DD'),
      'first_pickup', exists (select 1 from public.sales_rewards w where w.client_id = p.client_id and w.kind = 'first_pickup'),
      'rewards', (select coalesce(sum(w.amount), 0) from public.sales_rewards w where w.client_id = p.client_id and w.status in ('Earned', 'Approved', 'Paid')))), '[]'::jsonb)
    from public.sales_prospects p left join public.sales_reps r on r.id = p.rep_id));
end $$;

-- ── grants: functions only ───────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'sales_norm_phone(text)', 'sales_setting_int(text)', 'sales_current_rep()', 'sales_require_rep()', 'sales_require_admin()',
    'sales_me()', 'sales_join(text)', 'sales_my_leads()', 'sales_log_call(uuid,text,text,date)', 'sales_store_milestones(uuid)',
    'sales_my_stores()', 'sales_my_earnings()', 'sales_claim_store(text,text)', 'sales_refresh()', 'sales_admin_overview()',
    'sales_admin_invite(text,text,text,text)', 'sales_admin_set_rep_status(uuid,text)', 'sales_upsert_leads(jsonb)',
    'sales_admin_import(jsonb)', 'sales_admin_leads(uuid,text,text,boolean)', 'sales_admin_assign(uuid,int,text)',
    'sales_admin_reassign(uuid,uuid)', 'sales_admin_attributions()', 'sales_admin_decide(uuid,text,uuid)',
    'sales_admin_credit(uuid,uuid)', 'sales_admin_rewards(text)', 'sales_admin_set_rewards(uuid[],text,text,text)',
    'sales_admin_sheet_key()', 'sales_sheet_sync(text,jsonb)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'sales_me()', 'sales_join(text)', 'sales_my_leads()', 'sales_log_call(uuid,text,text,date)', 'sales_my_stores()',
    'sales_my_earnings()', 'sales_claim_store(text,text)', 'sales_refresh()', 'sales_admin_overview()',
    'sales_admin_invite(text,text,text,text)', 'sales_admin_set_rep_status(uuid,text)', 'sales_admin_import(jsonb)',
    'sales_admin_leads(uuid,text,text,boolean)', 'sales_admin_assign(uuid,int,text)', 'sales_admin_reassign(uuid,uuid)',
    'sales_admin_attributions()', 'sales_admin_decide(uuid,text,uuid)', 'sales_admin_credit(uuid,uuid)',
    'sales_admin_rewards(text)', 'sales_admin_set_rewards(uuid[],text,text,text)', 'sales_admin_sheet_key()']
  loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'grant execute on function public.sales_sheet_sync(text,jsonb) to anon, authenticated';
end $$;

commit;

-- Every 15 minutes: credit new stores, pay rewards, free stale leads.
select cron.schedule('novax-sales-refresh', '*/15 * * * *', 'select public.sales_refresh()')
where not exists (select 1 from cron.job where jobname = 'novax-sales-refresh');
