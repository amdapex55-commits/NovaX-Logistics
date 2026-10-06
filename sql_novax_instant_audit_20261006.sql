-- Nova Instant: fixes from the outside audit of 6 Oct 2026 (NVI-01 to NVI-13).
-- Re-runnable. This is the THIRD Nova Instant file. It replaces functions made
-- by the first two, so the three are always applied together and in order:
--   scripts/instant-migrate.sh "<connection>"     (each file in its own transaction)
-- Running an older file alone puts older functions back.
--
-- NVI-01  a withdrawal sent twice is one withdrawal (nvi_payouts.req_key)
-- NVI-02  a cash fare is booked at the cash taken, and corrected when ops
--         settles a short payment at another amount
-- NVI-05  the rules version a booking records is the one on instant-terms.html
-- NVI-06  a CAPTCHA answer must come from this site
-- NVI-07  one address cannot use up everybody's road lookups
-- NVI-08  one login is a customer or a rider, never both
-- NVI-09  only an active rider can add document photos, and only a few
-- Refuses to run by itself once a later Nova Instant file has been applied:
-- alone, it would put older functions back over newer ones. The files are
-- applied together and in order by scripts/instant-migrate.sh.
do $$
declare v_later boolean := false;
begin
  if to_regclass('public.nvi_schema') is not null and coalesce(current_setting('nvi.migrate', true), '') <> 'all' then
    execute 'select exists (select 1 from public.nvi_schema where n > 3)' into v_later;
    if v_later then
      raise exception 'A later Nova Instant database file is already applied. Run scripts/instant-migrate.sh (every file, in order); this file alone would put older functions back.';
    end if;
  end if;
end $$;

set local lock_timeout = '8s';

-- ═══════════════════ NVI-01: withdrawals ═══════════════════
-- The page makes one key for one withdrawal and keeps it until NovaX answers.
alter table public.nvi_payouts add column if not exists req_key uuid;
create unique index if not exists nvi_payouts_key on public.nvi_payouts(wallet_id, req_key) where req_key is not null;

create or replace function public.nvi_request_payout(p_wallet uuid, p_amount int, p_method text, p_title text, p_number text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_num text := regexp_replace(coalesce(p_number, ''), '[^0-9A-Za-z]', '', 'g'); v_id bigint; v_key uuid; o public.nvi_payouts;
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
  if (p_method in ('JazzCash', 'Easypaisa') and public.nvi_pk_phone(v_num) = '') or (p_method = 'Bank' and length(v_num) < 10) then
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

drop function if exists public.nvi_client_withdraw(int, text, text, text, text);
create or replace function public.nvi_client_withdraw(p_amount int, p_method text, p_title text, p_number text, p_cnic text default null, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.nvi_clients := public.nvi_my_client(); v_cnic text := regexp_replace(coalesce(p_cnic, ''), '[^0-9]', '', 'g');
begin
  if k.id is null then return jsonb_build_object('ok', false, 'reason', 'signin'); end if;
  if k.cnic is null then
    if length(v_cnic) <> 13 then return jsonb_build_object('ok', false, 'reason', 'cnic'); end if;
    update public.nvi_clients set cnic = v_cnic where id = k.id;
  end if;
  return public.nvi_request_payout(public.nvi_wallet_id('client', k.id, null), p_amount, p_method, p_title, p_number, p_key::text);
end $$;

drop function if exists public.nvi_rider_payout(int, text, text, text);
create or replace function public.nvi_rider_payout(p_amount int, p_method text, p_title text, p_number text, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider();
begin
  return public.nvi_request_payout(public.nvi_wallet_id('rider', r.id, null), p_amount, p_method, p_title, p_number, p_key::text);
end $$;

-- ═══════════════════ NVI-02: cash fares paid short ═══════════════════
-- What the ledger should hold for a finished cash-fare job, from the cash the
-- riders said they took (nvi_cash). Paid in full, this is the old sum: the
-- rider who took the fare owes it, each rider is paid for their leg, NovaX
-- keeps the rest. Paid short, everything is worked out on the cash taken: a
-- rider who was given nothing owes nothing and earns nothing, and NovaX books
-- no commission it never saw.
create or replace function public.nvi_fare_split(j public.nvi_jobs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.nvi_config; v_base int := (j).fare + coalesce((j).return_fee, 0); v_last uuid := (j).rider_id; v_first uuid;
  v_t int; v_s1 int := 0; v_s2 int; v_e1 int := 0; v_e2 int; v_w jsonb := '{}'::jsonb; k record; v_id text;
begin
  select * into c from public.nvi_config where id;
  v_first := coalesce((j).pickup_rider,
                      (select x.rider_id from public.nvi_cash x where x.job_id = (j).id and x.kind = 'fare' order by x.id limit 1), v_last);
  select coalesce(sum(amount), 0) into v_t from public.nvi_cash where job_id = (j).id;
  if v_first <> v_last then
    v_s1 := round((j).fare * c.relay_pickup_pct / 100.0)::int;
    if v_t <> v_base then v_s1 := case when v_base > 0 then round(v_s1::numeric * v_t / v_base)::int else 0 end; end if;
    v_s2 := v_t - v_s1;
    v_e1 := public.nvi_rider_earning(v_first, v_s1);
  else
    v_s2 := v_t;
  end if;
  v_e2 := public.nvi_rider_earning(v_last, v_s2);
  for k in
    select public.nvi_wallet_id('rider', x.rider_id, null)::text as w, -sum(x.amount)::int as a from public.nvi_cash x where x.job_id = (j).id group by x.rider_id
    union all select public.nvi_wallet_id('rider', v_first, null)::text, v_e1 where v_first <> v_last
    union all select public.nvi_wallet_id('rider', v_last, null)::text, v_e2
    union all select public.nvi_wallet_id('house', null, 'commission')::text, v_t - v_e1 - v_e2
  loop
    v_w := jsonb_set(v_w, array[k.w], to_jsonb(coalesce((v_w->>k.w)::int, 0) + k.a));
  end loop;
  return jsonb_build_object('w', v_w, 'cash', v_t, 'first', v_first, 'e1', v_e1, 'e2', v_e2, 'commission', v_t - v_e1 - v_e2);
end $$;

create or replace function public.nvi_ledger_job()
returns trigger language plpgsql security definer set search_path = '' as $$
-- One movement per finished job. Every rider is paid for their leg and owes
-- the cash they took; NovaX keeps the rest.
--   legs: one rider, or two (a relay or a moved parcel): the pickup rider's
--         part is nvi_config.relay_pickup_pct of the fare, the delivery
--         rider's part is the rest plus any return fee.
--   pay:  a freelance rider earns their part less their commission; a route
--         rider (salaried) earns nothing on the job.
--   cash: whoever took the fare (at pickup, at the door or on the return)
--         owes what they took; with cash on delivery the delivering rider
--         owes it all, and the client is owed it less the fare and the COD fee.
--   short: a cash fare paid short is booked at the cash taken. Each rider's
--         part shrinks with it, and so does what NovaX keeps. If ops later
--         settles the job at another amount, nvi_ledger_fare_fix posts the
--         difference.
declare
  c public.nvi_config; v_base int; v_a int := 0; v_net int := 0; v_cw uuid; v_hw uuid;
  v_first uuid; v_last uuid; v_s1 int := 0; v_s2 int; v_e1 int := 0; v_e2 int := 0;
  v_fare_col uuid; v_lines jsonb := '[]'::jsonb; v_owed int := 0; v_cod boolean; v_sp jsonb;
begin
  if new.status not in ('Delivered', 'Returned') or old.status is not distinct from new.status
     or new.rider_id is null or new.ledger_at is not null then
    return null;
  end if;
  select * into c from public.nvi_config where id;
  v_cod := new.status = 'Delivered' and new.cod_amount > 0;
  v_base := new.fare + coalesce(new.return_fee, 0);
  v_last := new.rider_id;
  v_first := coalesce(new.pickup_rider,
                      (select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'fare' and not v_cod order by k.id limit 1),
                      v_last);
  if v_first <> v_last then
    v_s1 := round(new.fare * c.relay_pickup_pct / 100.0)::int;
    v_s2 := v_base - v_s1;
    v_e1 := public.nvi_rider_earning(v_first, v_s1);
  else
    v_s2 := v_base;
  end if;
  v_e2 := public.nvi_rider_earning(v_last, v_s2);
  v_hw := public.nvi_wallet_id('house', null, 'commission');

  if v_cod then
    v_a := least(new.cod_amount, coalesce(new.cash_collected, new.cod_amount));
    v_net := v_a - new.fare - new.cod_fee;
    v_cw := case when new.client_id is not null then public.nvi_wallet_id('client', new.client_id, null)
                 else public.nvi_wallet_id('house', null, 'adjustments') end;   -- no account behind it: ops sorts it out
    v_lines := jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_last, null), 'a', -v_a),
                                 jsonb_build_object('w', v_cw, 'b', 'pending', 'a', v_net));
    v_owed := v_a;
  else
    -- A cash fare is booked at the cash the riders said they took, never at
    -- the fare that should have been paid (nvi_fare_split).
    v_sp := public.nvi_fare_split(new);
    v_first := (v_sp->>'first')::uuid; v_e1 := (v_sp->>'e1')::int; v_e2 := (v_sp->>'e2')::int;
    v_fare_col := coalesce((select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'fare' order by k.id limit 1),
                           (select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'return' order by k.id limit 1), v_last);
    perform public.nvi_post('job:' || new.id || ':' || new.status, 'commission',
      (select jsonb_agg(jsonb_build_object('w', t.key, 'a', t.value::int)) from jsonb_each_text(v_sp->'w') t), new.id);
    update public.nvi_jobs set commission = (v_sp->>'commission')::int, commission_rider = v_fare_col,
           pickup_rider = v_first, earn_pickup = case when v_first <> v_last then v_e1 else 0 end, earn_delivery = v_e2,
           ledger_at = now(), ledger_cod = null where id = new.id;
    update public.nvi_cash set by_ledger = true where job_id = new.id;
    return null;
  end if;
  if v_e1 > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_first, null), 'a', v_e1)); end if;
  if v_e2 > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_last, null), 'a', v_e2)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', v_hw, 'a', v_owed - v_net - v_e1 - v_e2));

  perform public.nvi_post('job:' || new.id || ':' || new.status, 'cod_delivered', v_lines, new.id);
  update public.nvi_jobs set commission = v_owed - v_net - v_e1 - v_e2, commission_rider = v_last,
         pickup_rider = v_first, earn_pickup = case when v_first <> v_last then v_e1 else 0 end, earn_delivery = v_e2,
         ledger_at = now(), ledger_cod = v_a where id = new.id;
  update public.nvi_cash set by_ledger = true where job_id = new.id;
  perform public.nvi_release_cod(v_last);
  return null;
end $$;

-- Ops settles a short cash fare at another amount (nvi_admin_pay 'received'):
-- the difference between what the ledger holds for the job and what it should
-- hold now is posted as one new movement. Writing a short fare off changes
-- nothing here: the ledger already holds only the cash that was taken.
create or replace function public.nvi_ledger_fare_fix()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_sp jsonb; v_lines jsonb; v_n int;
begin
  if new.ledger_at is null or new.rider_id is null or new.status not in ('Delivered', 'Returned')
     or (new.status = 'Delivered' and new.cod_amount > 0)
     or new.cash_collected is not distinct from old.cash_collected then
    return null;
  end if;
  v_sp := public.nvi_fare_split(new);
  select jsonb_agg(jsonb_build_object('w', z.w, 'a', z.d)) into v_lines from (
    select coalesce(t.key, p.w) as w, coalesce(t.value::int, 0) - coalesce(p.a, 0) as d
      from jsonb_each_text(v_sp->'w') t
      full join (select l.wallet_id::text as w, sum(l.amount)::int as a
                   from public.nvi_ledger l join public.nvi_txns x on x.id = l.txn_id
                  where x.job_id = new.id and x.kind in ('commission', 'fare_correction') group by l.wallet_id) p on p.w = t.key) z
   where z.d <> 0;
  if v_lines is null then return null; end if;
  select count(*) + 1 into v_n from public.nvi_txns where job_id = new.id and kind = 'fare_correction';
  perform public.nvi_post('fare_fix:' || new.id || ':' || v_n, 'fare_correction', v_lines, new.id, null,
                          'Fare cash settled at Rs ' || (v_sp->>'cash'));
  update public.nvi_jobs set commission = (v_sp->>'commission')::int,
         earn_pickup = case when (v_sp->>'first')::uuid <> new.rider_id then (v_sp->>'e1')::int else 0 end,
         earn_delivery = (v_sp->>'e2')::int where id = new.id;
  return null;
end $$;
drop trigger if exists nvi_jobs_fare_fix on public.nvi_jobs;
create trigger nvi_jobs_fare_fix after update of cash_collected on public.nvi_jobs
  for each row execute function public.nvi_ledger_fare_fix();

-- ═══════════════════ NVI-05: the rules version ═══════════════════
-- instant-terms.html shows this number; scripts/test-instant-pages.mjs fails
-- the build if the two differ. Change both together.
alter table public.nvi_config alter column terms_version set default '1.2';
update public.nvi_config set terms_version = '1.2' where id and terms_version is distinct from '1.2';

-- ═══════════════════ NVI-06: CAPTCHA ═══════════════════
-- Still off until turnstile_site and turnstile_secret are set (Cloudflare
-- dashboard, Turnstile, free). Once on, an answer counts only if Cloudflare
-- says it was solved on one of these hostnames.
alter table public.nvi_config add column if not exists turnstile_hosts text[] not null default array['novaxlogistics.com', 'www.novaxlogistics.com'];

create or replace function public.nvi_captcha_ok(p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_hosts text[]; v_res extensions.http_response; v_j jsonb;
begin
  select turnstile_secret, turnstile_hosts into v_secret, v_hosts from public.nvi_config where id;
  if v_secret is null then return true; end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 2100 then return false; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '1500');
  select * into v_res from extensions.http((
    'POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', null,
    'application/x-www-form-urlencoded',
    'secret=' || extensions.urlencode(v_secret::varchar) || '&response=' || extensions.urlencode(p_token::varchar))::extensions.http_request);
  begin perform extensions.http_reset_curlopt(); exception when others then null; end;
  if v_res.status <> 200 then return false; end if;
  v_j := v_res.content::jsonb;
  -- An answer solved on another site, or for another form, is not an answer.
  return coalesce((v_j->>'success')::boolean, false)
     and lower(coalesce(v_j->>'hostname', '')) = any (v_hosts)
     and coalesce(v_j->>'action', '') in ('', 'nvi_book');
exception when others then
  return false;
end $$;

-- ═══════════════════ NVI-07: road lookups ═══════════════════
-- true: this quote asked a router (answered or not), not the day's cache.
alter table public.nvi_quotes add column if not exists fresh boolean not null default false;
create index if not exists nvi_quotes_fresh on public.nvi_quotes(created_at) where fresh;

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
  v_may boolean := true; v_fresh boolean := false;
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
    if v_recent < 40 and v_may then
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

-- ═══════════════════ NVI-08: customer or rider, never both ═══════════════════
create or replace function public.nvi_rider_join()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := (select lower(u.email) from auth.users u where u.id = auth.uid());
  r public.nvi_riders;
begin
  if v_uid is null then return; end if;
  if exists (select 1 from public.nvi_riders where auth_user_id = v_uid) then return; end if;
  select * into r from public.nvi_riders where email = v_email and status = 'Invited' and auth_user_id is null for update;
  if r.id is null then return; end if;
  if exists (select 1 from public.profiles p where p.id = v_uid
             and (p.client_id is not null or p.rider_id is not null or p.role::text in ('admin', 'rider', 'sales', 'support'))) then
    raise exception 'This login already belongs to a NovaX account. Use a separate email for Nova Instant.' using errcode = '42501';
  end if;
  if exists (select 1 from public.nvi_clients k where k.auth_user_id = v_uid)
     or exists (select 1 from public.profiles p where p.id = v_uid and p.role::text = 'instant_client') then
    raise exception 'This login is a Nova Instant customer account. Riders need a separate email.' using errcode = '42501';
  end if;
  update public.nvi_riders set auth_user_id = v_uid, status = 'Active', joined_at = now() where id = r.id;
  insert into public.profiles(id, email, full_name, role) values (v_uid, v_email, r.full_name, 'instant')
  on conflict (id) do update set role = 'instant', full_name = excluded.full_name;
end $$;

create or replace function public.nvi_client_save(p_name text, p_phone text, p_address text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := (select lower(u.email) from auth.users u where u.id = (select auth.uid()));
  v_ph text := public.nvi_pk_phone(p_phone);
  k public.nvi_clients;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signin'); end if;
  if exists (select 1 from public.profiles p where p.id = v_uid
             and (p.client_id is not null or p.rider_id is not null or p.role::text in ('admin', 'rider', 'sales', 'support', 'instant'))) then
    return jsonb_build_object('ok', false, 'reason', 'novax_login');
  end if;
  if exists (select 1 from public.nvi_riders r where r.auth_user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'novax_login');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if v_ph = '' then return jsonb_build_object('ok', false, 'reason', 'phone'); end if;
  insert into public.nvi_clients (auth_user_id, full_name, phone, email, address)
  values (v_uid, left(btrim(p_name), 80), v_ph, v_email, nullif(left(btrim(coalesce(p_address, '')), 300), ''))
  on conflict (auth_user_id) do update
     set full_name = excluded.full_name, phone = excluded.phone,
         address = coalesce(excluded.address, public.nvi_clients.address)
  returning * into k;
  update public.profiles set role = 'instant_client', full_name = k.full_name where id = v_uid and role::text = 'client' and client_id is null;
  perform public.nvi_wallet_id('client', k.id, null);
  return jsonb_build_object('ok', true);
end $$;

-- The same rule on the tables, for every path there is or will be.
create or replace function public.nvi_one_side()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.auth_user_id is null then return new; end if;
  if tg_table_name = 'nvi_riders' and exists (select 1 from public.nvi_clients k where k.auth_user_id = new.auth_user_id) then
    raise exception 'This login is a Nova Instant customer account. Riders need a separate login.' using errcode = '42501';
  end if;
  if tg_table_name = 'nvi_clients' and exists (select 1 from public.nvi_riders r where r.auth_user_id = new.auth_user_id) then
    raise exception 'This login is a Nova Instant rider. Customers need a separate login.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists nvi_one_side on public.nvi_riders;
create trigger nvi_one_side before insert or update of auth_user_id on public.nvi_riders
  for each row execute function public.nvi_one_side();
drop trigger if exists nvi_one_side on public.nvi_clients;
create trigger nvi_one_side before insert or update of auth_user_id on public.nvi_clients
  for each row execute function public.nvi_one_side();

-- ═══════════════════ NVI-09: rider document photos ═══════════════════
-- Only an active rider may add photos (a paused or removed one may not), at
-- most 8 in their folder, and the rider app deletes the ones a newer pair
-- replaced. The two photos on the rider's record can never be deleted by them.
create or replace function public.nvi_is_rider()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.nvi_riders r where r.auth_user_id = (select auth.uid()) and r.status = 'Active')
$$;

create or replace function public.nvi_docs_room()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select count(*) from storage.objects o
           where o.bucket_id = 'nvi-rider-docs' and o.name like ((select auth.uid()))::text || '/%') < 8
$$;

create or replace function public.nvi_doc_spare(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.nvi_riders r
                      where r.auth_user_id = (select auth.uid()) and p_name in (r.cnic_path, r.bill_path))
$$;

drop policy if exists nvi_rider_docs_insert on storage.objects;
create policy nvi_rider_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'nvi-rider-docs'
              and split_part(name, '/', 1) = ((select auth.uid()))::text
              and name ~ '^[0-9a-f-]{36}/(cnic|bill)-[0-9]{10,16}-[0-9a-f]{8}\.jpg$'
              and (select public.nvi_is_rider())
              and (select public.nvi_docs_room()));
drop policy if exists nvi_rider_docs_delete on storage.objects;
create policy nvi_rider_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'nvi-rider-docs'
         and split_part(name, '/', 1) = ((select auth.uid()))::text
         and public.nvi_doc_spare(name));

create or replace function public.nvi_rider_docs(p_cnic text, p_bill text, p_em_name text, p_em_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.nvi_riders; v_uid text := (select auth.uid())::text;
  v_ph text := public.nvi_pk_phone(p_em_phone);
begin
  select * into r from public.nvi_riders where auth_user_id = (select auth.uid()) for update;
  if r.id is null or r.status <> 'Active' then
    raise exception 'This login is not a Nova Instant rider.' using errcode = '42501';
  end if;
  if exists (select 1 from public.nvi_jobs j where j.rider_id = r.id
              and j.status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning'))
     or exists (select 1 from public.nvi_jobs j where j.relay_rider = r.id
                 and j.relay_state in ('planned', 'at_point') and j.status in ('Rider assigned', 'Picked up')) then
    return jsonb_build_object('ok', false, 'reason', 'has_job');
  end if;
  if length(btrim(coalesce(p_em_name, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'em_name'); end if;
  if v_ph = '' then return jsonb_build_object('ok', false, 'reason', 'em_phone'); end if;
  if v_ph = public.nvi_pk_phone(r.phone) then return jsonb_build_object('ok', false, 'reason', 'em_same'); end if;
  if coalesce(p_cnic, '') !~ ('^' || v_uid || '/cnic-[0-9]{10,16}-[0-9a-f]{8}\.jpg$')
     or not exists (select 1 from storage.objects o where o.bucket_id = 'nvi-rider-docs' and o.name = p_cnic) then
    return jsonb_build_object('ok', false, 'reason', 'cnic');
  end if;
  if coalesce(p_bill, '') !~ ('^' || v_uid || '/bill-[0-9]{10,16}-[0-9a-f]{8}\.jpg$')
     or not exists (select 1 from storage.objects o where o.bucket_id = 'nvi-rider-docs' and o.name = p_bill) then
    return jsonb_build_object('ok', false, 'reason', 'bill');
  end if;
  update public.nvi_riders set cnic_path = p_cnic, bill_path = p_bill,
         emergency_name = left(btrim(p_em_name), 80), emergency_phone = v_ph,
         docs_at = now(), docs_checked_at = null, docs_checked_by = null
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- ═══════════════════ Who may call what ═══════════════════
do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_request_payout', 'nvi_client_withdraw', 'nvi_rider_payout', 'nvi_fare_split', 'nvi_ledger_job',
                         'nvi_ledger_fare_fix', 'nvi_captcha_ok', 'nvi_quote', 'nvi_rider_join', 'nvi_client_save', 'nvi_one_side',
                         'nvi_is_rider', 'nvi_docs_room', 'nvi_doc_spare', 'nvi_rider_docs')
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
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_client_withdraw', 'nvi_rider_payout', 'nvi_client_save',
                         'nvi_is_rider', 'nvi_docs_room', 'nvi_doc_spare', 'nvi_rider_docs')
  loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

-- This file is now applied (see the note at the top about running it alone).
create table if not exists public.nvi_schema (n int primary key, file text not null, applied_at timestamptz not null default now());
alter table public.nvi_schema enable row level security;
revoke all on public.nvi_schema from public, anon, authenticated;
insert into public.nvi_schema (n, file) values (3, 'sql_novax_instant_audit_20261006.sql') on conflict (n) do update set file = excluded.file, applied_at = now();

notify pgrst, 'reload schema';
