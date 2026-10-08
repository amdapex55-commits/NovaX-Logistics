-- Nova Recover, phase 1 (8 Oct 2026).
-- A merchant picks parcels that were refused or returned and pushes them to
-- the NovaX Support Desk. A support agent phones the customer and sells the
-- order again. Rs 100 per recovered order, taken from the wallet.
--
-- Phase 1 (this file): the settings, the cases, everything the merchant does
-- (see, accept, list, push, take back) and a read-only Resell queue on the
-- desk. Nothing here books a parcel or charges a wallet: that is phase 2.
-- The phase 2 columns are already on the cases table so phase 2 adds
-- functions, not a migration.
--
-- Three switches in nv_recover_config, all closed to start:
--   merchant_tab  off | chosen | all   who sees the tab in the portal
--   desk          admin | agents       who sees Resell on the Support Desk
--   free_calls    true | false         the desk still calls refusals for free
--
-- No foreign keys to parcels or clients on purpose: a case keeps its own copy
-- of what it needs, so nothing here can block an existing admin action.
-- Safe to run twice.
-- Not safe to run by itself once the phase 2 file is installed: this file's
-- older copies of some functions would replace the newer ones.
do $guard$ begin
  if to_regclass('public.nv_recover_calls') is not null then
    raise exception 'The Nova Recover phase 2 file is already installed. Running this older file alone would put older functions back. Run all three in order, or none.';
  end if;
end $guard$;

create table if not exists public.nv_recover_config (
  id             boolean primary key default true check (id),
  merchant_tab   text not null default 'off' check (merchant_tab in ('off', 'chosen', 'all')),
  chosen_clients uuid[] not null default '{}',
  desk           text not null default 'admin' check (desk in ('admin', 'agents')),
  free_calls     boolean not null default true,
  fee            numeric not null default 100 check (fee >= 0),
  wallet_floor   numeric not null default -1000,
  max_push       int not null default 30 check (max_push between 1 and 200),
  max_tries      int not null default 3 check (max_tries between 1 and 10),
  retry_days     int not null default 7 check (retry_days between 0 and 90),
  terms_version  text not null default '2026-10-08',
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
insert into public.nv_recover_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.nv_recover_accept (
  client_id   uuid primary key,
  version     text not null,
  accepted_by uuid,
  accepted_at timestamptz not null default now()
);

create sequence if not exists public.nv_recover_code_seq start 1001;

create table if not exists public.nv_recover_cases (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique default ('RC-' || nextval('public.nv_recover_code_seq')),
  parcel_id     uuid not null,
  awb           text not null,
  client_id     uuid not null,
  kind          text not null check (kind in ('refused', 'returned')),
  status        text not null default 'waiting'
                check (status in ('waiting', 'calling', 'callback', 'recovered', 'not_recovered', 'unreachable', 'withdrawn')),
  -- what the agent needs, as it was when the merchant pushed
  consignee     text,
  phone         text,
  city          text,
  address       text,
  cod           numeric not null default 0,
  rider_reason  text,
  came_back_at  timestamptz,
  -- what the merchant said
  max_discount  numeric not null default 0 check (max_discount >= 0),
  item_note     text,
  merchant_note text,
  push_key      text,
  pushed_by     uuid,
  pushed_at     timestamptz not null default now(),
  withdrawn_at  timestamptz,
  -- phase 2: the calls and the result
  tries         int not null default 0,
  callback_at   timestamptz,
  held_by       uuid,
  held_until    timestamptz,
  closed_at     timestamptz,
  closed_by     uuid,
  reason        text,
  rider_fault   boolean not null default false,
  agreed_date   date,
  agreed_cod    numeric,
  new_parcel_id uuid,
  new_awb       text,
  fee           numeric,
  fee_ledger_id uuid
);
-- A parcel is being worked on by one case at a time.
create unique index if not exists nv_recover_one_open on public.nv_recover_cases(parcel_id)
  where status in ('waiting', 'calling', 'callback');
create index if not exists nv_recover_client on public.nv_recover_cases(client_id, pushed_at desc);
create index if not exists nv_recover_status on public.nv_recover_cases(status, pushed_at);
create index if not exists nv_recover_key on public.nv_recover_cases(client_id, push_key) where push_key is not null;

alter table public.nv_recover_config enable row level security;
alter table public.nv_recover_accept enable row level security;
alter table public.nv_recover_cases  enable row level security;
revoke all on public.nv_recover_config, public.nv_recover_accept, public.nv_recover_cases from public, anon, authenticated;
revoke all on sequence public.nv_recover_code_seq from public, anon, authenticated;

-- ── helpers ────────────────────────────────────────────────────────────
create or replace function public.nv_recover_cfg() returns public.nv_recover_config
language sql stable security definer set search_path = '' as $$
  select c from public.nv_recover_config c where c.id
$$;

-- Does this merchant see the tab?
create or replace function public.nv_recover_visible(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_client is not null and exists (
    select 1 from public.nv_recover_config c
     where c.id and (c.merchant_tab = 'all' or (c.merchant_tab = 'chosen' and p_client = any(c.chosen_clients))))
$$;

-- The same seats that may book a parcel may push one: not Finance, not
-- Support, not a revoked login (mirrors nv_parcel_seat_may_book).
create or replace function public.nv_recover_seat_ok(p_client uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text;
begin
  if v_uid is null or p_client is null then return false; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  return not exists (
    select 1 from public.staff_users su
     where su.client_id = p_client
       and (su.auth_user_id = v_uid or lower(su.email) = coalesce(v_email, ''))
       and (lower(coalesce(su.status, 'Active')) = 'revoked'
            or lower(coalesce(su.role, '')) in ('finance', 'support')));
end $$;

-- Why a parcel cannot be pushed right now, or null when it can.
--   open   a case is already with NovaX
--   done   we already recovered it, or the customer said no
--   wait   we could not reach the customer; try again after retry_days
create or replace function public.nv_recover_block(p_parcel uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.nv_recover_cases k where k.parcel_id = p_parcel and k.status in ('waiting', 'calling', 'callback')) then 'open'
    when exists (select 1 from public.nv_recover_cases k where k.parcel_id = p_parcel and k.status in ('recovered', 'not_recovered')) then 'done'
    when exists (select 1 from public.nv_recover_cases k, public.nv_recover_config c
                  where c.id and k.parcel_id = p_parcel and k.status = 'unreachable'
                    and k.closed_at > now() - make_interval(days => c.retry_days)) then 'wait'
    else null end
$$;

create or replace function public.nv_recover_case_json(k public.nv_recover_cases) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'code', k.code, 'parcel_id', k.parcel_id, 'awb', k.awb, 'kind', k.kind, 'status', k.status,
    'consignee', k.consignee, 'city', k.city, 'cod', k.cod, 'rider_reason', k.rider_reason, 'came_back_at', k.came_back_at,
    'max_discount', k.max_discount, 'item_note', k.item_note, 'merchant_note', k.merchant_note,
    'pushed_at', k.pushed_at, 'tries', k.tries, 'callback_at', k.callback_at, 'closed_at', k.closed_at,
    'reason', k.reason, 'rider_fault', k.rider_fault, 'agreed_date', k.agreed_date, 'agreed_cod', k.agreed_cod,
    'new_awb', k.new_awb, 'fee', k.fee)
$$;

-- ── merchant ───────────────────────────────────────────────────────────
-- What the portal needs to decide whether to show the tab and the pop-up.
create or replace function public.client_recover_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); c public.nv_recover_config; v_bal numeric; v_acc public.nv_recover_accept;
begin
  if v_client is null or not public.nv_recover_visible(v_client) then
    return jsonb_build_object('visible', false);
  end if;
  c := public.nv_recover_cfg();
  select coalesce(cl.wallet_balance, 0) into v_bal from public.clients cl where cl.id = v_client;
  select * into v_acc from public.nv_recover_accept a where a.client_id = v_client;
  return jsonb_build_object(
    'visible', true,
    'accepted', v_acc.client_id is not null and v_acc.version = c.terms_version,
    'terms_version', c.terms_version,
    'fee', c.fee, 'wallet_floor', c.wallet_floor, 'max_push', c.max_push,
    'wallet_balance', v_bal,
    'wallet_low', v_bal < c.wallet_floor,
    'may_push', public.nv_recover_seat_ok(v_client),
    'counts', jsonb_build_object(
      'to_recover', (select count(*) from public.parcels p where p.client_id = v_client
                       and p.status in ('Refused', 'Return to shipper') and public.nv_recover_block(p.id) is null),
      'with_novax', (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status in ('waiting', 'calling', 'callback')),
      'recovered',  (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status = 'recovered')));
end $$;

-- "Start recovering" on the launch pop-up. Kept with the wording's version.
-- Agreeing to the price is for a login that may send parcels: a Finance or
-- Support seat cannot accept it for the whole account.
create or replace function public.client_recover_accept(p_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); c public.nv_recover_config;
begin
  if v_client is null then raise exception 'No client account linked to this session.' using errcode = '42501'; end if;
  if not public.nv_recover_visible(v_client) then raise exception 'Nova Recover is not open for this account yet.' using errcode = '42501'; end if;
  if not public.nv_recover_seat_ok(v_client) then
    raise exception 'Your team role cannot start Nova Recover. Ask the account owner or a warehouse login.' using errcode = '42501';
  end if;
  c := public.nv_recover_cfg();
  if coalesce(p_version, '') <> c.terms_version then
    raise exception 'Nova Recover was updated. Reload the page and read the new wording.';
  end if;
  insert into public.nv_recover_accept (client_id, version, accepted_by) values (v_client, c.terms_version, auth.uid())
  on conflict (client_id) do update set version = excluded.version, accepted_by = excluded.accepted_by, accepted_at = now();
  return jsonb_build_object('accepted', true, 'terms_version', c.terms_version);
end $$;

-- Every refused or returned parcel the merchant could push, and every case.
create or replace function public.client_recover_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id();
begin
  if v_client is null or not public.nv_recover_visible(v_client) then
    raise exception 'Nova Recover is not open for this account yet.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'parcels', (select coalesce(jsonb_agg(x order by (x->>'came_back_at') desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'parcel_id', p.id, 'awb', p.awb, 'consignee', p.consignee, 'city', p.city, 'cod', coalesce(p.cod_amount, 0),
          'status', p.status, 'kind', case when p.status = 'Refused' then 'refused' else 'returned' end,
          'came_back_at', coalesce(p.status_since, p.updated_at),
          'reason', coalesce(nullif(p.exception, ''), p.meta->>'exception', ''),
          'block', public.nv_recover_block(p.id)) as x
        from public.parcels p
        where p.client_id = v_client and p.status in ('Refused', 'Return to shipper')
          and coalesce(public.nv_recover_block(p.id), '') <> 'open'
        order by coalesce(p.status_since, p.updated_at) desc
        limit 1000) t),
    'cases', (select coalesce(jsonb_agg(public.nv_recover_case_json(k) order by k.pushed_at desc), '[]'::jsonb)
                from public.nv_recover_cases k where k.client_id = v_client and k.status <> 'withdrawn'));
end $$;

-- Push the selected parcels to the Support Desk. All of them or none.
create or replace function public.client_recover_push(
  p_parcels uuid[], p_max_discount numeric, p_in_stock boolean,
  p_items jsonb default '{}'::jsonb, p_note text default '', p_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id(); c public.nv_recover_config; v_bal numeric;
  v_ids uuid[]; v_key text := nullif(btrim(coalesce(p_key, '')), ''); v_off numeric := coalesce(p_max_discount, 0);
  v_bad text; v_n int; v_done uuid[];
begin
  if v_client is null then raise exception 'No client account linked to this session.' using errcode = '42501'; end if;
  if not public.nv_recover_visible(v_client) then raise exception 'Nova Recover is not open for this account yet.' using errcode = '42501'; end if;
  if not public.nv_recover_seat_ok(v_client) then
    raise exception 'Your team role cannot send parcels to Nova Recover. Ask the account owner or a warehouse login.' using errcode = '42501';
  end if;
  c := public.nv_recover_cfg();
  if not exists (select 1 from public.nv_recover_accept a where a.client_id = v_client and a.version = c.terms_version) then
    raise exception 'Open Nova Recover and tap Start recovering first.';
  end if;
  if v_key is not null and (length(v_key) < 16 or length(v_key) > 200 or v_key ~ '[[:cntrl:]]') then
    raise exception 'That request could not be read. Reload the page and try again.';
  end if;

  -- One push at a time per merchant: the wallet row is the lock.
  select coalesce(cl.wallet_balance, 0) into v_bal from public.clients cl where cl.id = v_client for update;
  if not found then raise exception 'Client account not found.'; end if;

  -- A lost reply can be sent again with the same key: same answer, no second push.
  if v_key is not null then
    select array_agg(k.id) into v_done from public.nv_recover_cases k where k.client_id = v_client and k.push_key = v_key;
    if v_done is not null then
      return jsonb_build_object('pushed', array_length(v_done, 1), 'cases', to_jsonb(v_done), 'repeat', true);
    end if;
  end if;

  select array_agg(distinct x) into v_ids from unnest(coalesce(p_parcels, '{}'::uuid[])) x where x is not null;
  -- "I still have the returned items" is only asked, and only true, for
  -- parcels that went back to the merchant. A refused parcel is with NovaX.
  if p_in_stock is not true and exists (select 1 from public.parcels p where p.id = any(v_ids) and p.client_id = v_client and p.status = 'Return to shipper') then
    raise exception 'Tick "I still have the returned items" first.';
  end if;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception 'Choose at least one parcel.'; end if;
  if v_n > c.max_push then raise exception 'Send at most % parcels at a time.', c.max_push; end if;
  if v_off < 0 or v_off <> round(v_off) or v_off > 50000 then
    raise exception 'The discount must be a whole number of rupees.';
  end if;
  if v_bal < c.wallet_floor then
    raise exception 'Your wallet is at Rs %. Nova Recover opens again once it is above Rs %.', round(v_bal), round(c.wallet_floor);
  end if;

  select string_agg(coalesce(p.awb, x::text), ', ') into v_bad
    from unnest(v_ids) x left join public.parcels p on p.id = x and p.client_id = v_client
   where p.id is null or p.status not in ('Refused', 'Return to shipper') or public.nv_recover_block(p.id) is not null;
  if v_bad is not null then
    raise exception 'These can no longer be sent: %. Refresh the list and try again.', v_bad;
  end if;

  with ins as (
    insert into public.nv_recover_cases (
      parcel_id, awb, client_id, kind, consignee, phone, city, address, cod, rider_reason, came_back_at,
      max_discount, item_note, merchant_note, push_key, pushed_by)
    select p.id, p.awb, v_client, case when p.status = 'Refused' then 'refused' else 'returned' end,
           p.consignee, p.phone, p.city, p.address, coalesce(p.cod_amount, 0),
           coalesce(nullif(p.exception, ''), p.meta->>'exception', ''), coalesce(p.status_since, p.updated_at),
           least(v_off, greatest(coalesce(p.cod_amount, 0), 0)),
           nullif(left(btrim(coalesce(p_items->>(p.id::text), '')), 140), ''),
           nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_key, auth.uid()
      from public.parcels p where p.id = any(v_ids) and p.client_id = v_client
    returning id)
  select array_agg(id) into v_done from ins;
  return jsonb_build_object('pushed', coalesce(array_length(v_done, 1), 0), 'cases', to_jsonb(v_done), 'repeat', false);
end $$;

-- Take a parcel back before anyone has called.
create or replace function public.client_recover_withdraw(p_case uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); k public.nv_recover_cases;
begin
  if v_client is null then raise exception 'No client account linked to this session.' using errcode = '42501'; end if;
  if not public.nv_recover_seat_ok(v_client) then
    raise exception 'Your team role cannot change Nova Recover. Ask the account owner or a warehouse login.' using errcode = '42501';
  end if;
  select * into k from public.nv_recover_cases x where x.id = p_case and x.client_id = v_client for update;
  if not found then raise exception 'That parcel is not with Nova Recover.'; end if;
  if k.status = 'withdrawn' then return jsonb_build_object('withdrawn', true, 'awb', k.awb); end if;
  if k.status <> 'waiting' or k.tries > 0 or (k.held_until is not null and k.held_until > now()) then
    raise exception 'We have already started calling this customer, so it cannot be taken back.';
  end if;
  update public.nv_recover_cases set status = 'withdrawn', withdrawn_at = now() where id = k.id;
  return jsonb_build_object('withdrawn', true, 'awb', k.awb);
end $$;

-- ── Support Desk ───────────────────────────────────────────────────────
-- Who may open Resell: an admin always; an agent only once the desk switch
-- says "agents", and then only on the clock like the rest of the desk.
create or replace function public.cs_recover_access() returns text
language plpgsql security definer set search_path = '' as $$
declare c public.nv_recover_config := public.nv_recover_cfg();
begin
  if public.is_admin() then return 'admin'; end if;
  if c.desk = 'agents' then perform public.cs_require_shift(); return 'agent'; end if;
  raise exception 'Resell is not open yet.' using errcode = '42501';
end $$;

-- Never raises: the desk asks this to decide whether to draw the Resell tab.
create or replace function public.cs_recover_peek() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.nv_recover_config := public.nv_recover_cfg(); v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then return jsonb_build_object('show', false); end if;
  if not v_admin and (c.desk <> 'agents' or not exists (
       select 1 from public.cs_agents a where a.auth_user_id = auth.uid() and a.status = 'Active')) then
    return jsonb_build_object('show', false);
  end if;
  return jsonb_build_object('show', true, 'mode', case when v_admin then 'admin' else 'agent' end,
    'locked_for_agents', c.desk <> 'agents',
    'waiting', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling', 'callback')));
end $$;

-- The Resell queue. Phase 1: read-only.
create or replace function public.cs_recover_queue() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_mode text := public.cs_recover_access(); c public.nv_recover_config := public.nv_recover_cfg();
begin
  return jsonb_build_object(
    'mode', v_mode,
    'config', jsonb_build_object('merchant_tab', c.merchant_tab, 'chosen', coalesce(array_length(c.chosen_clients, 1), 0),
                                 'desk', c.desk, 'free_calls', c.free_calls, 'fee', c.fee, 'max_tries', c.max_tries),
    'counts', jsonb_build_object(
      'open', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling', 'callback')),
      'recovered', (select count(*) from public.nv_recover_cases k where k.status = 'recovered'),
      'closed', (select count(*) from public.nv_recover_cases k where k.status in ('not_recovered', 'unreachable')),
      'merchants', (select count(distinct k.client_id) from public.nv_recover_cases k where k.status <> 'withdrawn')),
    'cases', (select coalesce(jsonb_agg(x order by (x->>'open')::boolean desc, (x->>'pushed_at') desc), '[]'::jsonb) from (
        select public.nv_recover_case_json(k) || jsonb_build_object(
                 'phone', k.phone, 'address', k.address,
                 'open', k.status in ('waiting', 'calling', 'callback'),
                 'merchant', cl.name, 'merchant_owner', cl.owner, 'merchant_phone', cl.phone,
                 'parcel_status', p.status) as x
          from public.nv_recover_cases k
          left join public.clients cl on cl.id = k.client_id
          left join public.parcels p on p.id = k.parcel_id
         where k.status <> 'withdrawn'
         order by k.pushed_at desc limit 500) t));
end $$;

-- The switches. Admin only. Pass only the keys to change.
create or replace function public.cs_recover_config_get() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.cs_require_admin();
  return (select to_jsonb(c) - 'id' from public.nv_recover_config c where c.id);
end $$;

create or replace function public.cs_recover_config_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_chosen uuid[];
begin
  perform public.cs_require_admin();
  if p ? 'chosen_clients' then
    select coalesce(array_agg(distinct (e)::uuid), '{}') into v_chosen from jsonb_array_elements_text(p->'chosen_clients') e;
  end if;
  update public.nv_recover_config c set
    merchant_tab   = coalesce(p->>'merchant_tab', c.merchant_tab),
    chosen_clients = case when p ? 'chosen_clients' then v_chosen else c.chosen_clients end,
    desk           = coalesce(p->>'desk', c.desk),
    free_calls     = coalesce((p->>'free_calls')::boolean, c.free_calls),
    fee            = coalesce((p->>'fee')::numeric, c.fee),
    wallet_floor   = coalesce((p->>'wallet_floor')::numeric, c.wallet_floor),
    max_push       = coalesce((p->>'max_push')::int, c.max_push),
    max_tries      = coalesce((p->>'max_tries')::int, c.max_tries),
    retry_days     = coalesce((p->>'retry_days')::int, c.retry_days),
    terms_version  = coalesce(nullif(p->>'terms_version', ''), c.terms_version),
    updated_at = now(), updated_by = auth.uid()
  where c.id;
  return public.cs_recover_config_get();
end $$;

-- New public functions are callable by everyone until told otherwise.
revoke all on function
  public.nv_recover_cfg(), public.nv_recover_visible(uuid), public.nv_recover_seat_ok(uuid), public.nv_recover_block(uuid),
  public.nv_recover_case_json(public.nv_recover_cases),
  public.client_recover_state(), public.client_recover_accept(text), public.client_recover_list(),
  public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text), public.client_recover_withdraw(uuid),
  public.cs_recover_access(), public.cs_recover_peek(), public.cs_recover_queue(),
  public.cs_recover_config_get(), public.cs_recover_config_set(jsonb)
from public, anon, authenticated;
grant execute on function
  public.client_recover_state(), public.client_recover_accept(text), public.client_recover_list(),
  public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text), public.client_recover_withdraw(uuid),
  public.cs_recover_peek(), public.cs_recover_queue(),
  public.cs_recover_config_get(), public.cs_recover_config_set(jsonb)
to authenticated;
