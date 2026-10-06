-- Nova Instant: fixes from the second outside audit of 6 Oct 2026 (NI-21 to NI-31).
-- The FOURTH Nova Instant file. Re-runnable. Applied last, after the other three:
--   scripts/instant-migrate.sh "<connection>"     (each file in its own transaction)
--
-- NI-21  one transaction ID pays one payout
-- NI-24  a bank account for a withdrawal is a valid Pakistani IBAN
-- NI-25  the 40 road lookups a minute hold even when many callers arrive together
-- NI-28  an older Nova Instant file refuses to run alone over a newer one
-- NI-31  job alerts go only to riders who are on duty and free to accept
set local lock_timeout = '8s';

-- ═══════════════════ NI-21: one transaction ID, one payout ═══════════════════
-- How a transaction ID is compared: capitals, no spaces. "tx 123 a" and "TX123A" are the same receipt.
create or replace function public.nvi_ref_key(p text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g'))
$$;
create unique index if not exists nvi_payouts_paid_ref on public.nvi_payouts (method, public.nvi_ref_key(ref)) where status = 'Paid' and ref is not null;

create or replace function public.nvi_admin_payout(p_id bigint, p_ok boolean, p_ref text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.nvi_payouts; v_due uuid := public.nvi_wallet_id('house', null, 'payouts_due'); v_ref text := left(btrim(coalesce(p_ref, '')), 80); v_other bigint;
begin
  perform public.nvi_require_admin();
  select * into p from public.nvi_payouts where id = p_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p.status <> 'Requested' then return jsonb_build_object('ok', false, 'reason', 'done'); end if;
  if coalesce(p_ok, false) then
    if length(v_ref) < 4 then return jsonb_build_object('ok', false, 'reason', 'need_ref'); end if;
    -- One transfer pays one payout. The same transaction ID on a second
    -- payout is a receipt pasted twice: refused before any money is booked.
    select o.id into v_other from public.nvi_payouts o
     where o.status = 'Paid' and o.id <> p.id and o.method = p.method and public.nvi_ref_key(o.ref) = public.nvi_ref_key(v_ref) limit 1;
    if v_other is not null then return jsonb_build_object('ok', false, 'reason', 'dup_ref', 'other', v_other); end if;
    perform public.nvi_post('payout:' || p.id || ':paid', 'payout_paid', jsonb_build_array(
      jsonb_build_object('w', v_due, 'a', -p.amount),
      jsonb_build_object('w', public.nvi_wallet_id('house', null, 'cash'), 'a', p.amount)), null, p_ref, p_note);
    update public.nvi_payouts set status = 'Paid', ref = v_ref, note = nullif(left(btrim(coalesce(p_note, '')), 200), ''),
           done_at = now(), done_by = (select auth.uid()) where id = p.id;
  else
    if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
    perform public.nvi_post('payout:' || p.id || ':back', 'payout_rejected', jsonb_build_array(
      jsonb_build_object('w', v_due, 'a', -p.amount),
      jsonb_build_object('w', p.wallet_id, 'a', p.amount)), null, null, p_note);
    update public.nvi_payouts set status = 'Rejected', note = left(btrim(p_note), 200), done_at = now(), done_by = (select auth.uid()) where id = p.id;
  end if;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  -- Two staff marking two payouts with one ID at the same moment: the index stops the second, and nothing of it is kept.
  return jsonb_build_object('ok', false, 'reason', 'dup_ref');
end $$;

create or replace function public.nvi_admin_money_check()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_total bigint; v_unbal int; v_unposted jsonb; v_overdue jsonb; v_dep int; v_pay int; v_cod jsonb; v_dup int;
begin
  perform public.nvi_require_admin();
  select * into c from public.nvi_config where id;
  select coalesce(sum(amount), 0) into v_total from public.nvi_ledger;
  select count(*) into v_unbal from (select txn_id from public.nvi_ledger group by txn_id having sum(amount) <> 0) x;
  select coalesce(jsonb_agg(code order by code), '[]'::jsonb) into v_unposted from public.nvi_jobs
   where status in ('Delivered', 'Returned') and rider_id is not null and ledger_at is null
     and coalesce(delivered_at, returned_at) > c.wallets_since;
  -- A rider who has owed money for more than a day without paying any in.
  select coalesce(jsonb_agg(jsonb_build_object('name', x.full_name, 'phone', x.phone, 'owes', -x.bal, 'since', x.since) order by x.bal), '[]'::jsonb) into v_overdue from (
    select r.full_name, r.phone, public.nvi_avail(w.id) as bal,
           (select min(l.at) from public.nvi_ledger l where l.wallet_id = w.id and l.amount < 0
              and l.at > coalesce((select max(d.done_at) from public.nvi_deposits d where d.rider_id = r.id and d.status = 'Confirmed'), '-infinity'::timestamptz)) as since
      from public.nvi_riders r join public.nvi_wallets w on w.kind = 'rider' and w.owner = r.id) x
   where x.bal < 0 and x.since < now() - interval '24 hours';
  select count(*) into v_dep from public.nvi_deposits where status = 'Claimed' and at < now() - interval '24 hours';
  select count(*) into v_pay from public.nvi_payouts where status = 'Requested' and at < now() - interval '48 hours';
  select jsonb_build_object('n', count(*), 'amount', coalesce(sum(cod_amount), 0)) into v_cod from public.nvi_jobs
   where cod_amount > 0 and status = 'Delivered' and ledger_at is not null and cod_released_at is null and delivered_at < now() - interval '48 hours';
  -- Paid payouts that share a transaction ID (the index makes this impossible; a number here means it was bypassed).
  select count(*) into v_dup from (select 1 from public.nvi_payouts where status = 'Paid' and ref is not null
                                    group by method, public.nvi_ref_key(ref) having count(*) > 1) x;
  return jsonb_build_object(
    'clear', v_dup = 0 and v_total = 0 and v_unbal = 0 and jsonb_array_length(v_unposted) = 0 and jsonb_array_length(v_overdue) = 0 and v_dep = 0 and v_pay = 0 and (v_cod->>'n')::int = 0,
    'ledger_total', v_total, 'unbalanced', v_unbal, 'unposted', v_unposted, 'overdue', v_overdue,
    'stale_deposits', v_dep, 'stale_payouts', v_pay, 'dup_payout_refs', v_dup, 'cod_waiting', v_cod, 'at', now());
end $$;

-- ═══════════════════ NI-24: a bank account is an IBAN ═══════════════════
-- A Pakistani IBAN: PK, two check digits, four bank letters, sixteen digits,
-- and the check digits must be right (ISO 13616, mod 97). Returns it tidied,
-- or '' when it is not one.
create or replace function public.nvi_pk_iban(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g')); r text; ch text; d text; m int := 0; i int; k int;
begin
  if v !~ '^PK[0-9]{2}[A-Z]{4}[0-9]{16}$' then return ''; end if;
  r := substr(v, 5) || substr(v, 1, 4);
  for i in 1..length(r) loop
    ch := substr(r, i, 1);
    d := case when ch between 'A' and 'Z' then (ascii(ch) - 55)::text else ch end;
    for k in 1..length(d) loop m := (m * 10 + substr(d, k, 1)::int) % 97; end loop;
  end loop;
  return case when m = 1 then v else '' end;
end $$;

create or replace function public.nvi_request_payout(p_wallet uuid, p_amount int, p_method text, p_title text, p_number text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_num text := upper(regexp_replace(coalesce(p_number, ''), '[^0-9A-Za-z]', '', 'g')); v_id bigint; v_key uuid; o public.nvi_payouts;
begin
  begin v_key := nullif(btrim(coalesce(p_key, '')), '')::uuid;
  exception when others then return jsonb_build_object('ok', false, 'reason', 'key'); end;
  -- Locked first, so two taps at the same moment cannot both pass the checks below.
  perform 1 from public.nvi_wallets where id = p_wallet for update;
  -- The same request sent again (a second tap, or a retry after the answer was
  -- lost) is the same request: it gets the first one back, whatever became of it.
  if v_key is not null then
    select * into o from public.nvi_payouts where wallet_id = p_wallet and req_key = v_key;
    if o.id is not null then
      return jsonb_build_object('ok', true, 'id', o.id, 'already', true, 'status', o.status, 'amount', o.amount, 'at', o.at);
    end if;
  end if;
  select * into c from public.nvi_config where id;
  if not c.withdrawals_enabled then return jsonb_build_object('ok', false, 'reason', 'withdrawals_off'); end if;
  if p_amount is null or p_amount < c.min_withdraw then return jsonb_build_object('ok', false, 'reason', 'min', 'min', c.min_withdraw); end if;
  if p_method not in ('JazzCash', 'Easypaisa', 'Bank') then return jsonb_build_object('ok', false, 'reason', 'method'); end if;
  if length(btrim(coalesce(p_title, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  if (p_method in ('JazzCash', 'Easypaisa') and public.nvi_pk_phone(v_num) = '') or (p_method = 'Bank' and public.nvi_pk_iban(v_num) = '') then
    return jsonb_build_object('ok', false, 'reason', 'number');
  end if;
  if exists (select 1 from public.nvi_payouts where wallet_id = p_wallet and status = 'Requested') then
    return jsonb_build_object('ok', false, 'reason', 'open');
  end if;
  -- An old page sends no key. The same amount to the same account twice inside
  -- ten minutes is then taken for a retry, not a second withdrawal.
  if v_key is null and exists (select 1 from public.nvi_payouts where wallet_id = p_wallet and amount = p_amount
                                and account_number = left(v_num, 34) and at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'recent');
  end if;
  if public.nvi_avail(p_wallet) < p_amount then return jsonb_build_object('ok', false, 'reason', 'balance'); end if;
  insert into public.nvi_payouts (wallet_id, amount, method, account_title, account_number, req_key)
  values (p_wallet, p_amount, p_method, left(btrim(p_title), 80), left(v_num, 34), v_key) returning id into v_id;
  perform public.nvi_post('payout:' || v_id || ':hold', 'payout_requested', jsonb_build_array(
    jsonb_build_object('w', p_wallet, 'a', -p_amount),
    jsonb_build_object('w', public.nvi_wallet_id('house', null, 'payouts_due'), 'a', p_amount)), null, p_method);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ═══════════════════ NI-25: road lookups under load ═══════════════════
create or replace function public.nvi_quote(p_plat double precision, p_plng double precision,
                                            p_dlat double precision, p_dlng double precision)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.nvi_config;
  v_straight double precision;
  v_key text; v_hit public.nvi_route_cache; v_r jsonb;
  v_m int; v_src text := 'estimate'; v_line text; v_sp int := 0; v_sd int := 0;
  v_fare int; v_id uuid; v_recent int;
  v_pts text; v_tail text := '?overview=full&geometries=polyline';
  v_mapbox text;
  v_ip text := public.nvi_client_ip();
  v_admin boolean := coalesce((select public.is_admin()), false);
  v_may boolean := true; v_fresh boolean := false; v_i int;
begin
  if p_plat is null or p_plng is null or p_dlat is null or p_dlng is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_point');
  end if;
  if not public.nvi_in_karachi(p_plat, p_plng) then
    return jsonb_build_object('ok', false, 'reason', 'pickup_outside');
  end if;
  if not public.nvi_in_karachi(p_dlat, p_dlng) then
    return jsonb_build_object('ok', false, 'reason', 'drop_outside');
  end if;
  select * into c from public.nvi_config where id;
  v_straight := public.nvi_straight_m(p_plat, p_plng, p_dlat, p_dlng);
  if v_straight < 150 then
    return jsonb_build_object('ok', false, 'reason', 'too_close');
  end if;
  -- One address asking for fares all day is a script, not a customer. Phone
  -- networks put many people behind one address, so the allowance is wide.
  if v_ip is not null and not v_admin
     and (select count(*) from public.nvi_quotes where ip = v_ip and created_at > now() - interval '10 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'slow_down');
  end if;

  v_key := round(p_plat::numeric, 4) || ',' || round(p_plng::numeric, 4) || ';'
        || round(p_dlat::numeric, 4) || ',' || round(p_dlng::numeric, 4);
  select * into v_hit from public.nvi_route_cache where k = v_key;
  if found then
    v_m := v_hit.distance_m; v_line := v_hit.line; v_sp := v_hit.snap_p; v_sd := v_hit.snap_d; v_src := 'road';
  else
    -- At most 40 new road lookups a minute from here (it protects the free
    -- allowance); past that the estimate is shown and cannot be booked. Every
    -- try counts, answered or not. One address gets 12 of the 40 and one
    -- lookup at a time, so a single caller cannot use up everybody's.
    select count(*) into v_recent from public.nvi_quotes where fresh and created_at > now() - interval '1 minute';
    if v_ip is not null and not v_admin then
      v_may := (select count(*) from public.nvi_quotes where ip = v_ip and fresh and created_at > now() - interval '1 minute') < 12
               and pg_try_advisory_xact_lock(hashtext('nvi_route:' || v_ip));
    end if;
    -- Callers arriving together cannot see each other's lookups until they
    -- finish, so the count alone could be passed by all of them. At most 6
    -- lookups run at once across everyone, and room is kept for those 6:
    -- 34 finished plus 6 running is the 40.
    if v_recent < 35 and v_may then
      v_may := false;
      for v_i in 1..6 loop
        if pg_try_advisory_xact_lock(7461, v_i) then v_may := true; exit; end if;
      end loop;
    end if;
    if v_recent < 35 and v_may then
      v_fresh := true;
      v_pts := p_plng::text || ',' || p_plat::text || ';' || p_dlng::text || ',' || p_dlat::text;
      -- Mapbox's free allowance is monthly. The cache holds one day of
      -- lookups, so past 2,500 in a day only the free router is asked.
      v_mapbox := c.mapbox_token;
      if v_mapbox is not null and (select count(*) from public.nvi_route_cache) < 2500 then
        v_r := public.nvi_route_from('https://api.mapbox.com/directions/v5/mapbox/driving/' || v_pts || v_tail || '&access_token=' || v_mapbox, 900);
      end if;
      if v_r is null then
        v_r := public.nvi_route_from('https://routing.openstreetmap.de/routed-car/route/v1/driving/' || v_pts || v_tail, 1300);
      end if;
      begin perform extensions.http_reset_curlopt(); exception when others then null; end;
      -- A road distance shorter than the straight line, or wildly longer, is a
      -- router fault, not a route.
      if v_r is not null and (v_r->>'m')::int >= v_straight * 0.95
         and (v_r->>'m')::int <= greatest(v_straight * 4, v_straight + 6000) then
        v_m := (v_r->>'m')::int; v_line := v_r->>'line'; v_src := 'road';
        v_sp := (v_r->>'snap_p')::int; v_sd := (v_r->>'snap_d')::int;
        insert into public.nvi_route_cache (k, distance_m, line, snap_p, snap_d)
        values (v_key, v_m, v_line, v_sp, v_sd) on conflict (k) do nothing;
      end if;
    end if;
  end if;

  -- A pin the router had to move more than 300 m is in the sea, a field or a
  -- closed compound: no rider can get to it.
  if v_src = 'road' and v_sp > 300 then return jsonb_build_object('ok', false, 'reason', 'pickup_off_road'); end if;
  if v_src = 'road' and v_sd > 300 then return jsonb_build_object('ok', false, 'reason', 'drop_off_road'); end if;

  if v_m is null then
    v_m := round(v_straight * 1.4)::int; v_src := 'estimate';
  end if;

  v_fare := greatest(c.min_fare, round(c.rate_per_km * round(v_m / 1000.0, 1))::int);
  insert into public.nvi_quotes (p_lat, p_lng, d_lat, d_lng, distance_m, source, fare, ip, fresh)
  values (p_plat, p_plng, p_dlat, p_dlng, v_m, v_src, v_fare, v_ip, v_fresh)
  returning id into v_id;
  delete from public.nvi_quotes where created_at < now() - interval '2 days';
  delete from public.nvi_route_cache where created_at < now() - interval '1 day';
  delete from public.nvi_hits where at < now() - interval '2 days';

  -- 'bookable' is false for an estimate: nvi_book refuses it.
  return jsonb_build_object('ok', true, 'quote', v_id,
    'km', round(v_m / 1000.0, 1), 'fare', v_fare, 'source', v_src, 'bookable', v_src = 'road', 'line', v_line,
    'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare);
end $$;

-- ═══════════════════ NI-31: who a job alert goes to ═══════════════════
create or replace function public.nvi_push_targets(p_job uuid, p_test text default null, p_user uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_test is not null then
    -- A test reaches only a phone of the rider who is signed in and asking.
    return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint)) from public.nvi_push_subs s
                      join public.nvi_riders r on r.id = s.rider_id
                     where s.endpoint = p_test and p_user is not null and r.auth_user_id = p_user), '[]'::jsonb);
  end if;
  update public.nvi_jobs set push_at = now()
   where id = p_job and status = 'Booked' and rider_id is null
     and coalesce(confirmed_at, created_at) > now() - interval '2 hours'
     and (push_at is null or push_at < now() - interval '2 minutes');
  get diagnostics v_n = row_count;
  if v_n = 0 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint))
    from public.nvi_push_subs s join public.nvi_riders r on r.id = s.rider_id
   where r.status = 'Active' and r.online and r.docs_checked_at is not null and s.fails < 5
     -- On duty: the app was opened in the last 12 hours (the same rule that counts a rider as on).
     and r.last_seen > now() - interval '12 hours'
     and not exists (select 1 from public.nvi_jobs j where j.rider_id = r.id
                      and j.status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning'))
     -- Kept for a parcel another rider is bringing: they could not accept this one.
     and not exists (select 1 from public.nvi_jobs j where j.relay_rider = r.id
                      and j.relay_state in ('planned', 'at_point') and j.status in ('Rider assigned', 'Picked up'))), '[]'::jsonb);
end $$;

-- ═══════════════════ Who may call what ═══════════════════
do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_ref_key', 'nvi_pk_iban', 'nvi_admin_payout', 'nvi_admin_money_check', 'nvi_request_payout', 'nvi_quote', 'nvi_push_targets')
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'nvi_quote'
  loop
    execute 'grant execute on function ' || f || ' to anon, authenticated';
  end loop;
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('nvi_admin_payout', 'nvi_admin_money_check')
  loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;
-- The alert sender runs with the service role.
grant execute on function public.nvi_push_targets(uuid, text, uuid) to service_role;

-- This file is now applied (see the note at the top about running it alone).
create table if not exists public.nvi_schema (n int primary key, file text not null, applied_at timestamptz not null default now());
alter table public.nvi_schema enable row level security;
revoke all on public.nvi_schema from public, anon, authenticated;
insert into public.nvi_schema (n, file) values (4, 'sql_novax_instant_fixes_20261006.sql') on conflict (n) do update set file = excluded.file, applied_at = now();

notify pgrst, 'reload schema';
