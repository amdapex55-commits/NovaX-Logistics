-- Nova Recover, phase 2 (8 Oct 2026). Run after sql_novax_recover_20261008.sql.
-- The agent's side: open a case, log each call, and press Recovered.
--
-- On Recovered, in one transaction:
--   * a parcel still at the station (status Refused) goes out again as the
--     same parcel: corrected address, the agreed COD, a note and a ticket for
--     operations. No second parcel.
--   * a parcel back with the merchant (status Return to shipper) is booked
--     again as a new order at the merchant's normal rate.
--   * Rs 100 (nv_recover_config.fee) comes off the merchant's wallet. The
--     wallet may go negative; a withdrawal above the balance is already
--     refused, so the next money that lands covers it first. The fee stays
--     if the customer refuses again. No fee when the call finds the rider
--     never really attempted.
--
-- Two things outside Nova Recover's own tables are touched:
--   1. wallet_ledger gets the fee as an 'admin_adjustment' row with
--      reference_type 'recover_case', so every existing statement, total and
--      reconcile treats it like any other adjustment.
--   2. nv_freeze_parcel_money() gains one branch: the COD of a Refused parcel
--      may be LOWERED while cs_recover_complete() is running. It is patched
--      in place from its live definition and refuses to apply if that
--      function has changed shape.
-- Safe to run twice.
-- Not safe to run by itself once the phase 3 file is installed: this file's
-- older copies of some functions would replace the newer ones.
do $guard$ begin
  if to_regprocedure('public.cs_recover_merchants()') is not null then
    raise exception 'The Nova Recover phase 3 file is already installed. Running this older file alone would put older functions back. Run all three in order, or none.';
  end if;
end $guard$;

create table if not exists public.nv_recover_calls (
  id             bigserial primary key,
  case_id        uuid not null,
  parcel_id      uuid,
  client_id      uuid,
  agent_id       uuid,
  agent_user     uuid,
  shift_id       bigint,
  outcome        text not null check (outcome in ('no_answer', 'callback', 'not_interested', 'recovered')),
  reason         text,
  note           text,
  callback_at    timestamptz,
  handle_seconds int,
  created_at     timestamptz not null default now()
);
create index if not exists nv_recover_calls_case on public.nv_recover_calls(case_id, created_at);
create index if not exists nv_recover_calls_agent on public.nv_recover_calls(agent_user, created_at);
alter table public.nv_recover_calls enable row level security;
revoke all on public.nv_recover_calls from public, anon, authenticated;
revoke all on sequence public.nv_recover_calls_id_seq from public, anon, authenticated;

alter table public.nv_recover_accept add column if not exists seen_at timestamptz;
alter table public.nv_recover_cases
  add column if not exists mode text,
  add column if not exists agreed_note text,
  add column if not exists ops_issue_id uuid;

-- ── the one change to an existing guard ────────────────────────────────
do $patch$
declare v_def text; v_pat text := $re$if\s+coalesce\(current_setting\('novax\.parcel_edit',\s*true\),\s*''\)\s*<>\s*'1'\s+or\s+coalesce\(old\.status,\s*''\)\s*<>\s*'New booked'\s+then$re$;
begin
  v_def := pg_get_functiondef('public.nv_freeze_parcel_money()'::regprocedure);
  if position('novax.recover_edit' in v_def) > 0 then return; end if;   -- already patched
  if regexp_count(v_def, v_pat) <> 1 then
    raise exception 'nv_freeze_parcel_money() is not the shape Nova Recover expects. Nothing was changed.';
  end if;
  v_def := regexp_replace(v_def, v_pat,
    $new$/* Nova Recover: while cs_recover_complete() runs, the COD of a Refused
       parcel may be lowered (the discount the merchant allowed), never raised. */
    if coalesce(current_setting('novax.recover_edit', true), '') = '1'
       and coalesce(old.status, '') = 'Refused'
       and new.cod_amount >= 0 and new.cod_amount < old.cod_amount then
      null;
    elsif coalesce(current_setting('novax.parcel_edit', true), '') <> '1'
       or coalesce(old.status, '') <> 'New booked' then$new$);
  execute v_def;
end $patch$;

-- ── helpers ────────────────────────────────────────────────────────────
-- Cities NovaX delivers in: where a rider is stationed.
create or replace function public.nv_recover_cities() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct initcap(btrim(x)) order by initcap(btrim(x))), array['Karachi'])
    from public.riders r, unnest(coalesce(r.cities, '{}'::text[])) x where btrim(coalesce(x, '')) <> ''
$$;

create or replace function public.nv_recover_reasons() returns text[]
language sql immutable as $$
  select array['Changed their mind', 'Price too high', 'Bought it elsewhere', 'Says they never ordered',
               'Wrong or damaged item', 'Wrong number', 'Asked not to be called', 'Other']
$$;

create or replace function public.nv_recover_agent_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.full_name from public.cs_agents a where a.auth_user_id = p_user), 'NovaX admin')
$$;

-- What can be done with the parcel as it stands now.
create or replace function public.nv_recover_action(p_status text) returns text
language sql immutable as $$
  select case p_status when 'Refused' then 'resend' when 'Return to shipper' then 'rebook' else 'none' end
$$;

create or replace function public.nv_recover_case_json(k public.nv_recover_cases) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'code', k.code, 'parcel_id', k.parcel_id, 'awb', k.awb, 'kind', k.kind, 'status', k.status,
    'consignee', k.consignee, 'city', k.city, 'cod', k.cod, 'rider_reason', k.rider_reason, 'came_back_at', k.came_back_at,
    'max_discount', k.max_discount, 'item_note', k.item_note, 'merchant_note', k.merchant_note,
    'pushed_at', k.pushed_at, 'tries', k.tries, 'callback_at', k.callback_at, 'closed_at', k.closed_at,
    'reason', k.reason, 'rider_fault', k.rider_fault, 'agreed_date', k.agreed_date, 'agreed_cod', k.agreed_cod,
    'new_awb', k.new_awb, 'fee', k.fee, 'mode', k.mode)
$$;

-- ── merchant (replaces phase 1 where noted) ────────────────────────────
-- Adds "unseen": orders recovered since the merchant last looked.
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
    'unseen', (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status = 'recovered'
                 and k.closed_at > coalesce(v_acc.seen_at, v_acc.accepted_at, '-infinity'::timestamptz)),
    'counts', jsonb_build_object(
      'to_recover', (select count(*) from public.parcels p where p.client_id = v_client
                       and p.status in ('Refused', 'Return to shipper') and public.nv_recover_block(p.id) is null),
      'with_novax', (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status in ('waiting', 'calling', 'callback')),
      'recovered',  (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status = 'recovered')));
end $$;

-- The merchant opened the Recovered list.
create or replace function public.client_recover_seen() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id();
begin
  if v_client is null then raise exception 'No client account linked to this session.' using errcode = '42501'; end if;
  update public.nv_recover_accept set seen_at = now() where client_id = v_client;
  return jsonb_build_object('seen', true);
end $$;

-- Phase 1's take-back, now aware of a call in progress: a parcel can be taken
-- back until an agent has it open or has tried once.
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
  if k.tries > 0 or k.callback_at is not null
     or not (k.status = 'waiting' or (k.status = 'calling' and coalesce(k.held_until, now()) <= now()))
     or (k.held_until is not null and k.held_until > now()) then
    raise exception 'We have already started calling this customer, so it cannot be taken back.';
  end if;
  update public.nv_recover_cases set status = 'withdrawn', withdrawn_at = now(), held_by = null, held_until = null where id = k.id;
  return jsonb_build_object('withdrawn', true, 'awb', k.awb);
end $$;

-- Phase 1's push, with one addition: when the merchant gives no item line,
-- the parcel's own booking description (meta.category) is used.
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
  select coalesce(cl.wallet_balance, 0) into v_bal from public.clients cl where cl.id = v_client for update;
  if not found then raise exception 'Client account not found.'; end if;
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
           coalesce(nullif(left(btrim(coalesce(p_items->>(p.id::text), '')), 140), ''),
                    nullif(left(btrim(coalesce(p.meta->>'category', '')), 140), '')),
           nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_key, auth.uid()
      from public.parcels p where p.id = any(v_ids) and p.client_id = v_client
    returning id)
  select array_agg(id) into v_done from ins;
  return jsonb_build_object('pushed', coalesce(array_length(v_done, 1), 0), 'cases', to_jsonb(v_done), 'repeat', false);
end $$;

-- ── Support Desk ───────────────────────────────────────────────────────
-- The Resell queue, now a working list. Order: call-backs that are due,
-- then the ones waiting (never tried before already tried, newest refusal
-- first, biggest COD first), then call-backs for later; finished cases after.
create or replace function public.cs_recover_queue() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_mode text := public.cs_recover_access(); c public.nv_recover_config := public.nv_recover_cfg();
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  -- A case that was opened and never finished goes back in line.
  update public.nv_recover_cases k
     set status = case when k.callback_at is not null then 'callback' else 'waiting' end, held_by = null, held_until = null
   where k.status = 'calling' and (k.held_until is null or k.held_until < now());

  return jsonb_build_object(
    'mode', v_mode, 'me', auth.uid(), 'today', v_today,
    'config', jsonb_build_object('merchant_tab', c.merchant_tab, 'chosen', coalesce(array_length(c.chosen_clients, 1), 0),
                                 'desk', c.desk, 'free_calls', c.free_calls, 'fee', c.fee, 'max_tries', c.max_tries,
                                 'cities', to_jsonb(public.nv_recover_cities()), 'reasons', to_jsonb(public.nv_recover_reasons())),
    'counts', jsonb_build_object(
      'open', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling', 'callback')),
      'to_call', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling')
                     or (k.status = 'callback' and coalesce(k.callback_at, now()) <= now())),
      'callbacks_today', (select count(*) from public.nv_recover_cases k where k.status = 'callback'
                     and (k.callback_at at time zone 'Asia/Karachi')::date <= v_today),
      'recovered_today', (select count(*) from public.nv_recover_cases k where k.status = 'recovered'
                     and (k.closed_at at time zone 'Asia/Karachi')::date = v_today),
      'recovered', (select count(*) from public.nv_recover_cases k where k.status = 'recovered'),
      'closed', (select count(*) from public.nv_recover_cases k where k.status in ('not_recovered', 'unreachable')),
      'merchants', (select count(distinct k.client_id) from public.nv_recover_cases k where k.status <> 'withdrawn')),
    'cases', (select coalesce(jsonb_agg(t.x order by t.ord), '[]'::jsonb) from (
        select row_number() over (order by
                 (k.status in ('waiting', 'calling', 'callback')) desc,
                 case when k.status = 'callback' and k.callback_at <= now() then 0
                      when k.status in ('waiting', 'calling') then 1
                      when k.status = 'callback' then 2 else 3 end,
                 case when k.status = 'callback' then k.callback_at end asc nulls last,
                 case when k.status in ('waiting', 'calling') then k.tries end asc nulls last,
                 case when k.status in ('waiting', 'calling') then k.came_back_at end desc nulls last,
                 case when k.status in ('waiting', 'calling') then k.cod end desc nulls last,
                 coalesce(k.closed_at, k.pushed_at) desc) as ord,
               public.nv_recover_case_json(k) || jsonb_build_object(
                 'phone', k.phone, 'address', k.address,
                 'open', k.status in ('waiting', 'calling', 'callback'),
                 'due', k.status = 'callback' and k.callback_at <= now(),
                 'merchant', cl.name, 'merchant_owner', cl.owner, 'merchant_phone', cl.phone,
                 'parcel_status', p.status,
                 'parcel_cod', p.cod_amount,
                 'action', public.nv_recover_action(p.status),
                 'outs', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = k.parcel_id and l.to_status = 'Parcel out for delivery'),
                 'held_by', case when k.held_by is not null and k.held_by <> auth.uid() and k.held_until > now()
                                 then public.nv_recover_agent_name(k.held_by) end,
                 'closed_by', case when k.closed_by is not null then public.nv_recover_agent_name(k.closed_by) end,
                 'agreed_note', k.agreed_note,
                 'calls', (select coalesce(jsonb_agg(jsonb_build_object('at', q.created_at, 'outcome', q.outcome, 'reason', q.reason,
                                   'note', q.note, 'callback_at', q.callback_at, 'by', public.nv_recover_agent_name(q.agent_user)) order by q.created_at desc), '[]'::jsonb)
                             from public.nv_recover_calls q where q.case_id = k.id)) as x
          from public.nv_recover_cases k
          left join public.clients cl on cl.id = k.client_id
          left join public.parcels p on p.id = k.parcel_id
         where k.status <> 'withdrawn'
         order by 1 limit 500) t));
end $$;

-- An agent opens a case: nobody else can work it for ten minutes, and the
-- merchant sees "Calling".
create or replace function public.cs_recover_open(p_case uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_mode text := public.cs_recover_access(); k public.nv_recover_cases;
begin
  select * into k from public.nv_recover_cases x where x.id = p_case for update;
  if not found then raise exception 'That case no longer exists. Refresh the list.'; end if;
  if k.status not in ('waiting', 'calling', 'callback') then
    return jsonb_build_object('held', false, 'status', k.status);
  end if;
  if k.held_by is not null and k.held_by <> auth.uid() and k.held_until > now() then
    raise exception '% is on this call. Pick another parcel.', public.nv_recover_agent_name(k.held_by) using errcode = '55P03';
  end if;
  update public.nv_recover_cases set status = 'calling', held_by = auth.uid(), held_until = now() + interval '10 minutes' where id = k.id;
  return jsonb_build_object('held', true, 'status', 'calling', 'held_until', now() + interval '10 minutes');
end $$;

-- Closed without a result: back in line.
create or replace function public.cs_recover_release(p_case uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_mode text := public.cs_recover_access();
begin
  update public.nv_recover_cases k
     set status = case when k.callback_at is not null then 'callback' else 'waiting' end, held_by = null, held_until = null
   where k.id = p_case and k.status = 'calling' and k.held_by = auth.uid();
  return jsonb_build_object('released', found);
end $$;

-- A call that did not recover the order.
--   no_answer       counts a try; the last allowed try closes the case
--   callback        the customer asked to be called at a time
--   not_interested  closed, with the reason the merchant will see
create or replace function public.cs_recover_log(
  p_case uuid, p_outcome text, p_reason text default null, p_note text default null,
  p_callback_at timestamptz default null, p_opened_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := public.cs_recover_access(); c public.nv_recover_config := public.nv_recover_cfg();
  k public.nv_recover_cases; v_agent uuid := public.cs_current_agent(); v_shift bigint;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 600), '');
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 80), '');
  v_status text; v_tries int;
begin
  if v_mode = 'agent' then v_shift := public.cs_require_shift(); end if;
  if p_outcome not in ('no_answer', 'callback', 'not_interested') then
    raise exception 'Pick what happened on the call.' using errcode = '22023';
  end if;
  select * into k from public.nv_recover_cases x where x.id = p_case for update;
  if not found then raise exception 'That case no longer exists. Refresh the list.'; end if;
  if k.status not in ('waiting', 'calling', 'callback') then
    raise exception 'This case is already closed. Refresh the list.' using errcode = '22023';
  end if;
  if k.held_by is not null and k.held_by <> auth.uid() and k.held_until > now() then
    raise exception '% is on this call. Pick another parcel.', public.nv_recover_agent_name(k.held_by) using errcode = '55P03';
  end if;
  if p_outcome = 'callback' and (p_callback_at is null or p_callback_at < now() + interval '5 minutes' or p_callback_at > now() + interval '14 days') then
    raise exception 'Pick a time to call back, within the next two weeks.' using errcode = '22023';
  end if;
  if p_outcome = 'not_interested' and (v_reason is null or not (v_reason = any(public.nv_recover_reasons()))) then
    raise exception 'Pick the reason the customer gave.' using errcode = '22023';
  end if;
  if (select count(*) from public.nv_recover_calls q where q.agent_user = auth.uid() and q.created_at > now() - interval '1 minute') >= 15 then
    raise exception 'Too many saves in a minute. Wait a moment.' using errcode = '54000';
  end if;

  v_tries := k.tries + case when p_outcome = 'no_answer' then 1 else 0 end;
  v_status := case
    when p_outcome = 'not_interested' then 'not_recovered'
    when p_outcome = 'callback' then 'callback'
    when v_tries >= c.max_tries then 'unreachable'
    else 'waiting' end;

  insert into public.nv_recover_calls (case_id, parcel_id, client_id, agent_id, agent_user, shift_id, outcome, reason, note, callback_at, handle_seconds)
  values (k.id, k.parcel_id, k.client_id, v_agent, auth.uid(), v_shift, p_outcome, v_reason, v_note,
          case when p_outcome = 'callback' then p_callback_at end,
          case when p_opened_at is null then null else least(greatest(extract(epoch from now() - p_opened_at)::int, 0), 3600) end);

  update public.nv_recover_cases set
    status = v_status, tries = v_tries, held_by = null, held_until = null,
    callback_at = case when p_outcome = 'callback' then p_callback_at when v_status = 'waiting' then null else callback_at end,
    reason = case when v_status = 'not_recovered' then v_reason when v_status = 'unreachable' then 'No answer after ' || v_tries || ' tries' else reason end,
    closed_at = case when v_status in ('not_recovered', 'unreachable') then now() end,
    closed_by = case when v_status in ('not_recovered', 'unreachable') then auth.uid() end
  where id = k.id;
  return jsonb_build_object('status', v_status, 'tries', v_tries, 'max_tries', c.max_tries);
end $$;

-- Recovered. Everything in one transaction, safe to press twice.
create or replace function public.cs_recover_complete(
  p_case uuid, p_name text, p_phone text, p_address text, p_city text, p_cod numeric, p_date date,
  p_note text default null, p_rider_fault boolean default false, p_opened_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := public.cs_recover_access(); c public.nv_recover_config := public.nv_recover_cfg();
  v_uid uuid := auth.uid(); v_agent uuid := public.cs_current_agent(); v_shift bigint;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  k public.nv_recover_cases; p public.parcels; v_new public.parcels; cl public.clients;
  v_action text; v_name text; v_phone text; v_addr text; v_city text; v_cod numeric; v_low numeric;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_fault boolean := coalesce(p_rider_fault, false);
  v_fee numeric := 0; v_ledger uuid; v_issue uuid; v_problem text; v_outs int;
  v_claims text; v_sub text; v_info jsonb; v_awb text;
begin
  if v_mode = 'agent' then v_shift := public.cs_require_shift(); end if;
  select * into k from public.nv_recover_cases x where x.id = p_case for update;
  if not found then raise exception 'That case no longer exists. Refresh the list.'; end if;

  -- Pressed twice, or the reply was lost: the same answer, nothing done again.
  if k.status = 'recovered' then
    return jsonb_build_object('status', 'recovered', 'repeat', true, 'mode', k.mode, 'awb', coalesce(k.new_awb, k.awb),
      'new_awb', k.new_awb, 'fee', coalesce(k.fee, 0), 'agreed_date', k.agreed_date, 'agreed_cod', k.agreed_cod,
      'merchant', (select name from public.clients where id = k.client_id), 'merchant_phone', (select phone from public.clients where id = k.client_id));
  end if;
  if k.status not in ('waiting', 'calling', 'callback') then
    raise exception 'This case is already closed. Refresh the list.' using errcode = '22023';
  end if;
  if k.held_by is not null and k.held_by <> v_uid and k.held_until > now() then
    raise exception '% is on this call. Pick another parcel.', public.nv_recover_agent_name(k.held_by) using errcode = '55P03';
  end if;

  select * into p from public.parcels x where x.id = k.parcel_id for update;
  if not found then raise exception 'The original parcel no longer exists.'; end if;
  v_action := public.nv_recover_action(p.status);
  if v_action = 'none' then
    raise exception 'This parcel is "%" right now. It can be recovered once it is refused at the station or back with the merchant.', p.status using errcode = '22023';
  end if;
  if v_fault and v_action <> 'resend' then
    raise exception '"The rider never came" is only for a parcel still with NovaX.' using errcode = '22023';
  end if;

  v_name  := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_phone := nullif(left(btrim(coalesce(p_phone, '')), 30), '');
  v_addr  := nullif(left(btrim(coalesce(p_address, '')), 400), '');
  if v_name is null then raise exception 'Customer name is required.' using errcode = '22023'; end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'Enter the customer''s phone number.' using errcode = '22023';
  end if;
  if v_addr is null or length(v_addr) < 8 then raise exception 'Enter the full delivery address.' using errcode = '22023'; end if;

  -- The parcel at the station cannot move city. A new booking can, to a city we deliver in.
  v_city := case when v_action = 'resend' then p.city else coalesce(nullif(btrim(coalesce(p_city, '')), ''), p.city) end;
  if v_action = 'rebook' and lower(v_city) <> lower(coalesce(p.city, ''))
     and not exists (select 1 from unnest(public.nv_recover_cities()) x where lower(x) = lower(v_city)) then
    raise exception 'NovaX does not deliver to % yet.', v_city using errcode = '22023';
  end if;

  v_cod := coalesce(p_cod, p.cod_amount, 0);
  v_low := greatest(coalesce(p.cod_amount, 0) - coalesce(k.max_discount, 0), 0);
  if v_cod <> round(v_cod) or v_cod < 0 then raise exception 'COD must be a whole number of rupees.' using errcode = '22023'; end if;
  if v_cod > coalesce(p.cod_amount, 0) then
    raise exception 'COD cannot be more than the original Rs %.', round(p.cod_amount) using errcode = '22023';
  end if;
  if v_cod < v_low then
    raise exception 'The merchant allows at most Rs % off. The lowest COD is Rs %.', round(k.max_discount), round(v_low) using errcode = '22023';
  end if;
  if p_date is null or p_date < v_today or p_date > v_today + 14 then
    raise exception 'Pick a delivery day within the next two weeks.' using errcode = '22023';
  end if;
  if (select count(*) from public.nv_recover_calls q where q.agent_user = v_uid and q.created_at > now() - interval '1 minute') >= 15 then
    raise exception 'Too many saves in a minute. Wait a moment.' using errcode = '54000';
  end if;

  v_info := jsonb_strip_nulls(jsonb_build_object('case', k.code, 'by', 'NovaX', 'at', now(), 'date', p_date,
              'note', v_note, 'agent', public.nv_recover_agent_name(v_uid),
              'cod', v_cod, 'wasCod', p.cod_amount));

  if v_action = 'resend' then
    -- Same parcel, out again. The edit flags let exactly this UPDATE through
    -- the parcel guards; they end with the transaction.
    perform set_config('novax.parcel_edit', '1', true);
    perform set_config('novax.recover_edit', '1', true);
    update public.parcels set consignee = v_name, phone = v_phone, address = v_addr, cod_amount = v_cod,
           meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('reattemptRequestedAt', now(), 'recover', v_info)
     where id = p.id;
    perform set_config('novax.parcel_edit', '', true);
    perform set_config('novax.recover_edit', '', true);

    -- Operations sends it out: one ticket, the same queue the desk already uses.
    select count(*) into v_outs from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = 'Parcel out for delivery';
    v_problem := case when v_fault then 'Fake attempt / proof dispute: ' else 'Nova Recover, deliver again: ' end || p.awb;
    select id into v_issue from public.operations_issues where problem = v_problem and resolved = false limit 1;
    if v_issue is null then
      insert into public.operations_issues(branch, urgency, problem, awb, resolved, meta)
      values (coalesce(nullif(p.meta->>'branch', ''), coalesce(nullif(p.city, ''), 'Destination') || ' Hub'),
              case when v_fault then 'super urgent' else 'urgent' end, v_problem, p.awb, false,
              jsonb_build_object('exceptionType', case when v_fault then 'Fake attempt / proof dispute' else 'Nova Recover' end, 'source', 'nova-recover'))
      returning id into v_issue;
    end if;
    update public.operations_issues set updated_at = now(), meta = coalesce(meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'source', 'nova-recover', 'recoverCase', k.code, 'riderReason', coalesce(nullif(p.exception, ''), p.meta->>'exception'),
        'customerSays', coalesce(v_note, case when v_fault then 'Customer says the rider never came.' else 'Customer agreed to take the order.' end),
        'redeliverOn', p_date, 'newCod', v_cod, 'oldCod', p.cod_amount,
        'addressFix', case when v_addr is distinct from p.address then v_addr end,
        'outsSoFar', v_outs, 'raisedBy', public.nv_recover_agent_name(v_uid), 'raisedAt', now()))
     where id = v_issue;
    v_awb := p.awb;
  else
    -- A new order, booked the way NovaX books for a merchant. The booking
    -- core only lets an admin, a merchant for their own account, or NovaX
    -- itself (no signed-in user) book, so for this one call the function
    -- stands in as NovaX and then puts the agent's identity back.
    v_claims := current_setting('request.jwt.claims', true);
    v_sub := current_setting('request.jwt.claim.sub', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    v_new := public.nv_book_parcel_core(
      k.client_id, v_name, v_phone,
      coalesce(nullif(p.meta->>'pickupCity', ''), nullif(p.meta->>'origin', ''), 'Karachi'),
      v_city, v_addr, v_cod,
      coalesce(nullif(p.meta->>'weight', ''), '0.8 kg'), coalesce(nullif(p.meta->>'service', ''), 'COD Standard'),
      coalesce(nullif(p.meta->>'category', ''), ''), coalesce(nullif(p.meta->>'fragile', ''), 'No'),
      case when v_cod > 0 then 'COD' else coalesce(nullif(p.meta->>'paymentMode', ''), 'Prepaid') end,
      coalesce(p.meta->>'orderId', ''), 'Recovered from ' || p.awb, 'nova_recover', 'admin');
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);

    update public.parcels set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('recover', v_info || jsonb_build_object('from', p.awb))
     where id = v_new.id;
    update public.parcels set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('recover', jsonb_build_object('case', k.code, 'rebookedAs', v_new.awb, 'at', now()))
     where id = p.id;
    update public.parcel_admin_audit set action = 'recover_booked', actor_id = v_uid, actor_role = case when v_mode = 'admin' then 'admin' else 'support' end
     where awb = v_new.awb and action = 'admin_booked';
    v_awb := v_new.awb;
  end if;

  -- The fee. The wallet may go below zero; a withdrawal above the balance is
  -- refused, so whatever lands next covers it first.
  select * into cl from public.clients x where x.id = k.client_id for update;
  if not v_fault and c.fee > 0 then
    v_fee := c.fee;
    update public.clients set wallet_balance = coalesce(wallet_balance, 0) - v_fee where id = k.client_id;
    insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
    values (k.client_id, 'admin_adjustment', -v_fee, true, 'Adjustment', 'recover_case', k.id, v_awb,
            'Nova Recover fee: order ' || v_awb || ' recovered by NovaX' || case when v_action = 'rebook' then ' (was ' || p.awb || ').' else '.' end)
    returning id into v_ledger;
  end if;

  insert into public.nv_recover_calls (case_id, parcel_id, client_id, agent_id, agent_user, shift_id, outcome, reason, note, handle_seconds)
  values (k.id, k.parcel_id, k.client_id, v_agent, v_uid, v_shift, 'recovered', case when v_fault then 'Rider never came' end, v_note,
          case when p_opened_at is null then null else least(greatest(extract(epoch from now() - p_opened_at)::int, 0), 3600) end);

  update public.nv_recover_cases set
    status = 'recovered', mode = v_action, closed_at = now(), closed_by = v_uid, held_by = null, held_until = null,
    rider_fault = v_fault, agreed_date = p_date, agreed_cod = v_cod, agreed_note = v_note,
    new_parcel_id = v_new.id, new_awb = v_new.awb, fee = v_fee, fee_ledger_id = v_ledger, ops_issue_id = v_issue,
    reason = case when v_fault then 'Rider never came' end
  where id = k.id;

  return jsonb_build_object('status', 'recovered', 'repeat', false, 'mode', v_action, 'awb', v_awb, 'new_awb', v_new.awb,
    'fee', v_fee, 'agreed_date', p_date, 'agreed_cod', v_cod, 'merchant', cl.name, 'merchant_phone', cl.phone,
    'wallet_after', coalesce(cl.wallet_balance, 0) - v_fee);
end $$;

-- Numbers for My day (an agent's own) and Analytics (admin: everyone).
create or replace function public.cs_recover_stats(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_mode text := public.cs_recover_access(); v_admin boolean := public.is_admin();
  v_from timestamptz := (p_from::text || ' 00:00 Asia/Karachi')::timestamptz;
  v_to timestamptz := ((p_to + 1)::text || ' 00:00 Asia/Karachi')::timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'Pick a range of up to three months.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
        'pushed', (select count(*) from public.nv_recover_cases k where k.pushed_at >= v_from and k.pushed_at < v_to and k.status <> 'withdrawn'),
        'recovered', count(*) filter (where k.status = 'recovered'),
        'delivered', count(*) filter (where k.status = 'recovered' and t.status = 'Delivered'
                                        and (k.mode = 'rebook' or t.delivered_at > k.closed_at)),
        'refused_again', count(*) filter (where k.status = 'recovered' and t.status in ('Refused', 'Return to shipper', 'Return in transit', 'Ready for return')
                                        and (k.mode = 'rebook' or t.status_since > k.closed_at)),
        'not_recovered', count(*) filter (where k.status = 'not_recovered'),
        'unreachable', count(*) filter (where k.status = 'unreachable'),
        'fees', coalesce(sum(k.fee) filter (where k.status = 'recovered'), 0),
        'cod', coalesce(sum(k.agreed_cod) filter (where k.status = 'recovered'), 0))
      from public.nv_recover_cases k
      left join public.parcels t on t.id = coalesce(k.new_parcel_id, k.parcel_id)
      where k.closed_at >= v_from and k.closed_at < v_to and (v_admin or k.closed_by = auth.uid())),
    'agents', (select coalesce(jsonb_agg(a order by (a->>'recovered')::int desc, a->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'name', public.nv_recover_agent_name(q.agent_user),
          'calls', count(*),
          'no_answer', count(*) filter (where q.outcome = 'no_answer'),
          'callbacks', count(*) filter (where q.outcome = 'callback'),
          'not_interested', count(*) filter (where q.outcome = 'not_interested'),
          'recovered', count(*) filter (where q.outcome = 'recovered'),
          'delivered', count(*) filter (where q.outcome = 'recovered' and exists (
              select 1 from public.nv_recover_cases k join public.parcels t on t.id = coalesce(k.new_parcel_id, k.parcel_id)
               where k.id = q.case_id and t.status = 'Delivered' and (k.mode = 'rebook' or t.delivered_at > k.closed_at))),
          'fees', coalesce((select sum(k.fee) from public.nv_recover_cases k where k.status = 'recovered' and k.closed_by = q.agent_user
                             and k.closed_at >= v_from and k.closed_at < v_to), 0),
          'avg_handle_seconds', round(avg(q.handle_seconds))) as a
        from public.nv_recover_calls q
        where q.created_at >= v_from and q.created_at < v_to and (v_admin or q.agent_user = auth.uid())
        group by q.agent_user) s));
end $$;

revoke all on function
  public.nv_recover_cities(), public.nv_recover_reasons(), public.nv_recover_agent_name(uuid), public.nv_recover_action(text),
  public.nv_recover_case_json(public.nv_recover_cases),
  public.client_recover_state(), public.client_recover_seen(), public.client_recover_withdraw(uuid),
  public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text),
  public.cs_recover_queue(), public.cs_recover_open(uuid), public.cs_recover_release(uuid),
  public.cs_recover_log(uuid, text, text, text, timestamptz, timestamptz),
  public.cs_recover_complete(uuid, text, text, text, text, numeric, date, text, boolean, timestamptz),
  public.cs_recover_stats(date, date)
from public, anon, authenticated;
grant execute on function
  public.client_recover_state(), public.client_recover_seen(), public.client_recover_withdraw(uuid),
  public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text),
  public.cs_recover_queue(), public.cs_recover_open(uuid), public.cs_recover_release(uuid),
  public.cs_recover_log(uuid, text, text, text, timestamptz, timestamptz),
  public.cs_recover_complete(uuid, text, text, text, text, numeric, date, text, boolean, timestamptz),
  public.cs_recover_stats(date, date)
to authenticated;
