-- Existing accounts call list (4 Oct 2026).
-- Merchants who signed up but never had a parcel picked up. NovaX (admin)
-- chooses which ones to push to which rep; a rep sees ONLY the accounts
-- pushed to them, in their own "Existing accounts" section, clearly marked
-- as existing NovaX accounts (signup date, city, product). These are not
-- leads: no sheet import, no 7-day pool return, no signup link.
-- Reward: a rep is credited (method 'reactivation') only when they logged a
-- call before the store's first pickup and that pickup came within 30 days
-- of their first call. Such a store earns the first-pickup reward only.

create table if not exists public.sales_existing_accounts (
  client_id       uuid primary key references public.clients(id) on delete cascade,
  rep_id          uuid references public.sales_reps(id),
  pushed_at       timestamptz not null default now(),
  pushed_by       uuid,
  assigned_at     timestamptz,
  status          text not null default 'Not called'
                  check (status in ('Not called','No answer','Busy','Interested','Call back','Not interested','Wrong number','Shipped')),
  call_count      int not null default 0,
  first_called_at timestamptz,
  last_called_at  timestamptz,
  next_followup_on date,
  last_note       text,
  shipped_at      timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists sales_existing_accounts_rep_idx on public.sales_existing_accounts(rep_id);
create table if not exists public.sales_existing_calls (
  id         bigserial primary key,
  client_id  uuid not null references public.clients(id) on delete cascade,
  rep_id     uuid not null references public.sales_reps(id),
  outcome    text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists sales_existing_calls_client_idx on public.sales_existing_calls(client_id);
alter table public.sales_existing_accounts enable row level security;
alter table public.sales_existing_calls enable row level security;
revoke all on public.sales_existing_accounts, public.sales_existing_calls from public, anon, authenticated;
revoke all on sequence public.sales_existing_calls_id_seq from public, anon, authenticated;

alter table public.sales_attributions drop constraint if exists sales_attributions_method_check;
alter table public.sales_attributions add constraint sales_attributions_method_check
  check (method = any (array['ref_code','phone_match','claim','admin','reactivation']));

-- Never-shipped merchants the admin can push: no parcel ever picked up, not a
-- test account, not already credited to a rep. Already-pushed ones are
-- returned too, with their rep and status, so the admin sees the whole list.
create or replace function public.sales_admin_existing_candidates(p_city text default null, p_search text default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(x order by x->>'signed_up_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'client_id', c.id, 'store_name', c.name, 'owner', c.owner, 'phone', c.phone, 'city', c.city,
      'product', c.business_type, 'website', c.website, 'signed_up_at', c.created_at,
      'booked', (select count(*) from public.parcels p where p.client_id = c.id),
      'credited_to', (select s.code from public.sales_attributions a join public.sales_reps s on s.id = a.rep_id
                       where a.client_id = c.id and a.status <> 'Rejected'),
      'pushed_rep', (select s.code from public.sales_reps s where s.id = e.rep_id),
      'pushed_rep_id', e.rep_id, 'pushed_status', e.status, 'pushed', e.client_id is not null,
      'calls', coalesce(e.call_count, 0), 'last_note', e.last_note) as x
    from public.clients c
    left join public.sales_existing_accounts e on e.client_id = c.id
    where public.is_admin()
      and c.name !~* '^\s*(test|testt|test account|test accoiunt|test client|test store|novax merchant)\s*$'
      and not exists (select 1 from public.parcels p where p.client_id = c.id and p.status not in ('New booked', 'Cancelled by client'))
      and (p_city is null or c.city ilike p_city)
      and (p_search is null or c.name ilike '%' || p_search || '%' or c.phone like '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
  ) t;
$$;

create or replace function public.sales_admin_existing_push(p_clients uuid[], p_rep uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_pushed int := 0; v_moved int := 0; v_skipped int := 0; v_c uuid; v_prev uuid; v_had boolean;
begin
  perform public.sales_require_admin();
  if p_rep is null or not exists (select 1 from public.sales_reps where id = p_rep and status = 'Active') then
    raise exception 'Pick an active rep who has joined.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_reps r where r.id = p_rep and r.profile_done_at is not null)
     or public.sales_docs_signed(p_rep) is null then
    raise exception 'This rep has not finished their joining form and documents, so they cannot see accounts yet.' using errcode = '22023';
  end if;
  if p_clients is null or cardinality(p_clients) = 0 then raise exception 'Tick at least one account.' using errcode = '22023'; end if;
  if cardinality(p_clients) > 500 then raise exception 'Push at most 500 at a time.' using errcode = '22023'; end if;
  foreach v_c in array p_clients loop
    -- Shipped already, credited to a rep already, or a test account: skip.
    if exists (select 1 from public.parcels p where p.client_id = v_c and p.status not in ('New booked', 'Cancelled by client'))
       or exists (select 1 from public.sales_attributions a where a.client_id = v_c and a.status <> 'Rejected')
       or not exists (select 1 from public.clients c where c.id = v_c) then
      v_skipped := v_skipped + 1; continue;
    end if;
    select rep_id, true into v_prev, v_had from public.sales_existing_accounts where client_id = v_c;
    insert into public.sales_existing_accounts(client_id, rep_id, pushed_by, assigned_at)
    values (v_c, p_rep, auth.uid(), now())
    on conflict (client_id) do update set rep_id = excluded.rep_id, assigned_at = now(), pushed_by = excluded.pushed_by, updated_at = now()
      where public.sales_existing_accounts.status <> 'Shipped'
        and public.sales_existing_accounts.rep_id is distinct from excluded.rep_id;
    if found then
      if coalesce(v_had, false) and v_prev is not null then v_moved := v_moved + 1; else v_pushed := v_pushed + 1; end if;
    end if;
    v_prev := null; v_had := null;
  end loop;
  return jsonb_build_object('pushed', v_pushed, 'moved', v_moved, 'skipped', v_skipped);
end $$;

create or replace function public.sales_admin_existing_unpush(p_client uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.sales_require_admin();
  delete from public.sales_existing_accounts where client_id = p_client and status <> 'Shipped';
end $$;

create or replace function public.sales_my_existing()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'client_id', c.id, 'store_name', c.name, 'owner', c.owner, 'phone', c.phone, 'city', c.city,
      'product', c.business_type, 'website', c.website, 'signed_up_at', c.created_at,
      'booked', (select count(*) from public.parcels p where p.client_id = c.id),
      'status', e.status, 'call_count', e.call_count, 'last_called_at', e.last_called_at,
      'first_called_at', e.first_called_at, 'next_followup_on', e.next_followup_on,
      'last_note', e.last_note, 'assigned_at', e.assigned_at, 'shipped_at', e.shipped_at,
      'credited', exists (select 1 from public.sales_attributions a where a.client_id = c.id and a.rep_id = e.rep_id and a.method = 'reactivation'))
    order by (e.status = 'Shipped'), (e.next_followup_on is null), e.next_followup_on, e.assigned_at), '[]'::jsonb)
  from public.sales_existing_accounts e join public.clients c on c.id = e.client_id
  where e.rep_id = public.sales_require_rep();
$$;

create or replace function public.sales_log_existing_call(p_client uuid, p_outcome text, p_note text default null, p_followup date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_rep uuid := public.sales_require_rep();
  v_e public.sales_existing_accounts;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if p_outcome not in ('No answer', 'Busy', 'Interested', 'Call back', 'Not interested', 'Wrong number') then
    raise exception 'Pick what happened on the call.' using errcode = '22023';
  end if;
  select * into v_e from public.sales_existing_accounts where client_id = p_client for update;
  if v_e.client_id is null or v_e.rep_id is distinct from v_rep then
    raise exception 'This account is not assigned to you any more.' using errcode = '42501';
  end if;
  if v_e.status = 'Shipped' then raise exception 'This store has already shipped.' using errcode = '22023'; end if;
  if p_outcome = 'Call back' and p_followup is null then raise exception 'Pick the date to follow up.' using errcode = '22023'; end if;
  if p_followup is not null and (p_followup < v_today or p_followup > v_today + 60) then
    raise exception 'Pick a follow-up date within the next 60 days.' using errcode = '22023';
  end if;
  if (select count(*) from public.sales_existing_calls c where c.rep_id = v_rep and c.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many calls logged in a minute. Wait a moment.' using errcode = '54000';
  end if;
  insert into public.sales_existing_calls(client_id, rep_id, outcome, note) values (p_client, v_rep, p_outcome, v_note);
  update public.sales_existing_accounts set
    status = p_outcome, call_count = call_count + 1, last_called_at = now(),
    first_called_at = coalesce(first_called_at, now()),
    next_followup_on = case when p_outcome in ('Not interested', 'Wrong number') then null else p_followup end,
    last_note = coalesce(v_note, last_note), updated_at = now()
  where client_id = p_client;
  return jsonb_build_object('ok', true, 'status', p_outcome);
end $$;

-- sales_refresh: step 1b added; reactivated stores earn the first-pickup reward only.
CREATE OR REPLACE FUNCTION public.sales_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_window int := public.sales_setting_int('lead_window_days');
  v_untouched int := public.sales_setting_int('lead_untouched_days');
  v_new int := 0; v_freed int := 0; v_earned int := 0;
  r record; v_terms jsonb; v_hold int;
  v_code_rep uuid; v_lead_rep uuid; v_lead uuid;
  v_first uuid; v_picked_at timestamptz; v_first_bad boolean;
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
      insert into public.sales_attributions(client_id, rep_id, alt_rep_id, method, status, note, terms)
      values (r.id, coalesce(v_code_rep, v_lead_rep),
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then v_lead_rep end,
              case when v_code_rep is not null then 'ref_code' else 'phone_match' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then 'Pending' else 'Approved' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep
                   then 'Signed up with one rep''s code but was on another rep''s lead list.' end,
              public.sales_terms_now())
      on conflict (client_id) do nothing;
      v_new := v_new + 1;
    end if;
    update public.sales_prospects s set status = 'Signed up', client_id = r.id, signed_up_at = r.created_at,
           next_followup_on = null, updated_at = now()
     where s.phone = public.sales_norm_phone(r.phone) and s.client_id is null;
    v_lead_rep := null; v_lead := null; v_code_rep := null;
  end loop;

  -- 1b. Existing accounts NovaX pushed to a rep (4 Oct 2026). When the store's
  -- first parcel is picked up the row closes as Shipped. The rep is credited
  -- only if they logged a call BEFORE that pickup and the pickup came within
  -- 30 days of their first call; such a store earns the first-pickup reward
  -- only (it was opened long before the rep called).
  for r in
    select e.client_id, e.rep_id, e.first_called_at,
      (select min(l.changed_at) from public.nv_parcel_status_log l
        where l.client_id = e.client_id and l.from_status = 'New booked' and l.to_status <> 'Cancelled by client') as picked_at
    from public.sales_existing_accounts e
    where e.status <> 'Shipped'
  loop
    if r.picked_at is null then continue; end if;
    update public.sales_existing_accounts set status = 'Shipped', shipped_at = r.picked_at, next_followup_on = null, updated_at = now()
     where client_id = r.client_id;
    if r.rep_id is not null and r.first_called_at is not null
       and r.picked_at >= r.first_called_at and r.picked_at <= r.first_called_at + interval '30 days'
       and exists (select 1 from public.sales_reps s where s.id = r.rep_id and s.status <> 'Removed') then
      insert into public.sales_attributions(client_id, rep_id, method, status, note, terms)
      values (r.client_id, r.rep_id, 'reactivation', 'Approved', 'Existing account: first parcel after the rep''s call.', public.sales_terms_now())
      on conflict (client_id) do nothing;
      if found then v_new := v_new + 1; end if;
    end if;
  end loop;

  -- 2. Rewards for credited stores, at the terms frozen when each was credited.
  for r in
    select a.client_id, a.rep_id, a.method, coalesce(a.terms, public.sales_terms_now()) as terms, rp.status as rep_status, rp.removed_at,
      exists (select 1 from public.client_kyc k where k.client_id = a.client_id and k.status = 'verified') as verified,
      exists (select 1 from public.parcels p where p.client_id = a.client_id
               and p.status not in ('New booked', 'Cancelled by client')) as picked_any,
      exists (select 1 from public.parcels p where p.client_id = a.client_id and p.status = 'Delivered') as delivered
    from public.sales_attributions a join public.sales_reps rp on rp.id = a.rep_id
    where a.status = 'Approved'
  loop
    -- A removed rep is paid for what is met within 30 days of the end date, nothing after.
    if r.rep_status = 'Removed' and r.removed_at < now() - interval '30 days' then
      update public.sales_rewards set status = 'Rejected', rejected_at = now(),
             note = 'Not met within 30 days after the agreement ended'
       where client_id = r.client_id and rep_id = r.rep_id and status = 'Waiting';
      continue;
    end if;
    v_hold := coalesce((r.terms->>'pickup_hold_days')::int, public.sales_setting_int('pickup_hold_days'));
    -- An existing account the rep reactivated was not opened by them.
    if r.method <> 'reactivation' then
    insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
    values (r.rep_id, r.client_id, 'account_opened', coalesce((r.terms->>'account_opened')::numeric, public.sales_setting_int('reward_account_opened')), 'Waiting')
    on conflict (client_id, kind) do nothing;
    end if;
    if r.verified and r.method <> 'reactivation' then
      update public.sales_rewards set status = 'Earned', earned_at = now()
       where client_id = r.client_id and rep_id = r.rep_id and kind = 'account_opened' and status = 'Waiting';
      if found then v_earned := v_earned + 1; end if;
    end if;
    if r.picked_any then
      insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
      values (r.rep_id, r.client_id, 'first_pickup', coalesce((r.terms->>'first_pickup')::numeric, public.sales_setting_int('reward_first_pickup')), 'Waiting')
      on conflict (client_id, kind) do nothing;
      -- The first parcel picked up (its first move out of "New booked" that
      -- was not a cancellation), and whether it was ever cancelled, refused or returned.
      v_first := null; v_picked_at := null;
      select l.parcel_id, l.changed_at into v_first, v_picked_at from public.nv_parcel_status_log l
       where l.client_id = r.client_id and l.from_status = 'New booked' and l.to_status <> 'Cancelled by client'
       order by l.changed_at limit 1;
      v_first_bad := v_first is null
        or exists (select 1 from public.nv_parcel_status_log l where l.parcel_id = v_first
                    and l.to_status in ('Refused', 'Return to shipper', 'Cancelled by client'))
        or exists (select 1 from public.parcels p where p.id = v_first
                    and p.status in ('Refused', 'Return to shipper', 'Cancelled by client'));
      if v_first is not null and not v_first_bad
         and (exists (select 1 from public.parcels p where p.id = v_first and p.status = 'Delivered')
              or v_picked_at < now() - make_interval(days => v_hold)) then
        update public.sales_rewards set status = 'Earned', earned_at = now()
         where client_id = r.client_id and rep_id = r.rep_id and kind = 'first_pickup' and status = 'Waiting';
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
end $function$;

-- Removing a rep releases their open pushed accounts.
CREATE OR REPLACE FUNCTION public.sales_admin_set_rep_status(p_rep uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- Pushed existing accounts they had not closed go back to NovaX to re-push.
    update public.sales_existing_accounts set rep_id = null, assigned_at = null, updated_at = now()
     where rep_id = p_rep and status <> 'Shipped';
    if v_rep.auth_user_id is not null then
      update public.profiles set role = 'client' where id = v_rep.auth_user_id and role = 'sales';
    end if;
  else
    update public.sales_reps set status = case when auth_user_id is null then 'Invited' else 'Active' end, removed_at = null where id = p_rep;
    if v_rep.auth_user_id is not null then
      update public.profiles set role = 'sales' where id = v_rep.auth_user_id and role = 'client' and client_id is null;
    end if;
  end if;
end $function$;

revoke all on function public.sales_admin_existing_candidates(text, text) from public, anon;
revoke all on function public.sales_admin_existing_push(uuid[], uuid) from public, anon;
revoke all on function public.sales_admin_existing_unpush(uuid) from public, anon;
revoke all on function public.sales_my_existing() from public, anon;
revoke all on function public.sales_log_existing_call(uuid, text, text, date) from public, anon;
grant execute on function public.sales_admin_existing_candidates(text, text) to authenticated;
grant execute on function public.sales_admin_existing_push(uuid[], uuid) to authenticated;
grant execute on function public.sales_admin_existing_unpush(uuid) to authenticated;
grant execute on function public.sales_my_existing() to authenticated;
grant execute on function public.sales_log_existing_call(uuid, text, text, date) to authenticated;

notify pgrst, 'reload schema';
