-- ===========================================================================
-- NovaX Merchant API -- guardrails, 29 Aug 2026
--
-- WHY NOW
--   The API went from "just built" to real revenue in a day: Hayat Scents
--   booked 13 parcels, Rs 39,500 of COD, across three cities, on their first
--   afternoon. Nothing was watching it. There was no request log, no error
--   rate, and no ceiling -- a runaway loop on a merchant's side could have
--   booked hundreds of parcels and the first anyone would know is a rider
--   being sent to collect them.
-- ===========================================================================

-- Every call, one row. Kept 30 days -- long enough to see a pattern, short
-- enough that it never becomes the operations_issues table that reached
-- 412,000 rows and became most of the write load.
create table if not exists public.nv_api_request_log (
  id          bigserial primary key,
  key_id      uuid,
  client_id   uuid,
  route       text,
  method      text,
  status_code int,
  error_code  text,
  ms          int,
  created_at  timestamptz not null default now()
);
create index if not exists nv_api_request_log_time_idx on public.nv_api_request_log(created_at desc);
create index if not exists nv_api_request_log_client_idx on public.nv_api_request_log(client_id, created_at desc);
alter table public.nv_api_request_log enable row level security;

create or replace function public.nv_api_log_request(
  p_key_id uuid, p_client_id uuid, p_route text, p_method text,
  p_status int, p_error text, p_ms int)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.nv_api_request_log(key_id, client_id, route, method, status_code, error_code, ms)
  values (p_key_id, p_client_id, p_route, p_method, p_status, nullif(p_error,''), p_ms);
  -- Opportunistic trim, ~1 call in 200, so no cron is required for this.
  if random() < 0.005 then
    delete from public.nv_api_request_log where created_at < now() - interval '30 days';
  end if;
exception when others then
  null;  -- logging must never break a merchant's booking
end $$;

-- ------------------------------------------------------------ rate limit ---
-- A fixed window per key. Deliberately generous: the point is to stop a
-- runaway loop, not to ration a real merchant. Hayat Scents' busiest hour so
-- far is well under a hundred calls.
alter table public.nv_api_key add column if not exists rate_window_start timestamptz;
alter table public.nv_api_key add column if not exists rate_window_count int not null default 0;
alter table public.nv_api_key add column if not exists rate_limit_per_hour int not null default 1000;
alter table public.nv_api_key add column if not exists book_limit_per_hour int not null default 200;
alter table public.nv_api_key add column if not exists book_window_start timestamptz;
alter table public.nv_api_key add column if not exists book_window_count int not null default 0;

-- Resolve + count + rate-check in one call, so the edge function still makes
-- exactly one round trip to authenticate.
create or replace function public.nv_api_resolve_key_v2(p_key text, p_is_booking boolean default false)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_hash text; v_row public.nv_api_key; v_name text; v_now timestamptz := now();
begin
  v_hash := encode(extensions.digest(coalesce(p_key,''), 'sha256'), 'hex');
  select * into v_row from public.nv_api_key where key_hash = v_hash and not revoked;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_key'); end if;

  -- rolling hourly windows
  if v_row.rate_window_start is null or v_row.rate_window_start < v_now - interval '1 hour' then
    v_row.rate_window_start := v_now; v_row.rate_window_count := 0;
  end if;
  if v_row.book_window_start is null or v_row.book_window_start < v_now - interval '1 hour' then
    v_row.book_window_start := v_now; v_row.book_window_count := 0;
  end if;

  if v_row.rate_window_count >= v_row.rate_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'rate_limited',
      'limit', v_row.rate_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.rate_window_start + interval '1 hour' - v_now)))::int));
  end if;
  if p_is_booking and v_row.book_window_count >= v_row.book_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'booking_rate_limited',
      'limit', v_row.book_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.book_window_start + interval '1 hour' - v_now)))::int));
  end if;

  update public.nv_api_key
     set last_used_at = v_now,
         request_count = request_count + 1,
         rate_window_start = v_row.rate_window_start,
         rate_window_count = v_row.rate_window_count + 1,
         book_window_start = v_row.book_window_start,
         book_window_count = v_row.book_window_count + (case when p_is_booking then 1 else 0 end)
   where id = v_row.id;

  select name into v_name from public.clients where id = v_row.client_id;
  return jsonb_build_object('ok', true, 'client_id', v_row.client_id, 'client_name', v_name,
    'webhook_url', v_row.webhook_url, 'key_id', v_row.id);
end $$;

-- ---------------------------------------------------------------- health ---
create or replace function public.admin_api_health(p_hours int default 24)
returns table(
  client_name text, key_prefix text, calls bigint, errors bigint,
  error_pct numeric, p50_ms int, p95_ms int, bookings bigint,
  last_call timestamptz, top_error text)
language sql security definer set search_path to 'public' as $$
  select c.name, k.key_prefix,
         count(l.id),
         count(l.id) filter (where l.status_code >= 400),
         round(100.0 * count(l.id) filter (where l.status_code >= 400) / nullif(count(l.id),0), 1),
         percentile_disc(0.5) within group (order by l.ms)::int,
         percentile_disc(0.95) within group (order by l.ms)::int,
         count(l.id) filter (where l.route = '/orders' and l.method = 'POST' and l.status_code < 400),
         max(l.created_at),
         (select l2.error_code from public.nv_api_request_log l2
           where l2.key_id = k.id and l2.error_code is not null
             and l2.created_at > now() - make_interval(hours => p_hours)
           group by l2.error_code order by count(*) desc limit 1)
    from public.nv_api_key k
    join public.clients c on c.id = k.client_id
    left join public.nv_api_request_log l
      on l.key_id = k.id and l.created_at > now() - make_interval(hours => p_hours)
   where not k.revoked
   group by c.name, k.key_prefix, k.id
   order by count(l.id) desc;
$$;

-- ------------------------------------------------------- silence detector ---
-- A key that booked yesterday and has booked nothing today is the shape of a
-- broken integration. Cheaper to notice here than in a phone call.
create or replace function public.admin_api_silent_keys(p_quiet_hours int default 12)
returns table(client_name text, key_prefix text, last_booking timestamptz,
              hours_quiet numeric, bookings_prev_7d bigint)
language sql security definer set search_path to 'public' as $$
  with b as (
    select k.id, c.name, k.key_prefix,
           max(p.booked_at) filter (where p.booked_at is not null) as last_booking,
           count(p.id) filter (where p.booked_at > now() - interval '7 days') as prev7
      from public.nv_api_key k
      join public.clients c on c.id = k.client_id
      left join public.parcels p
        on p.client_id = k.client_id and p.meta->>'source' = 'merchant_api'
     where not k.revoked
     group by k.id, c.name, k.key_prefix)
  select name, key_prefix, last_booking,
         round(extract(epoch from (now() - last_booking))/3600.0, 1),
         prev7
    from b
   where last_booking is not null
     and prev7 > 0
     and last_booking < now() - make_interval(hours => p_quiet_hours)
   order by last_booking;
$$;

revoke all on function public.nv_api_resolve_key_v2(text,boolean) from public, anon, authenticated;
revoke all on function public.nv_api_log_request(uuid,uuid,text,text,int,text,int) from public, anon, authenticated;
revoke all on function public.admin_api_health(int) from public, anon;
revoke all on function public.admin_api_silent_keys(int) from public, anon;
grant execute on function public.admin_api_health(int) to authenticated;
grant execute on function public.admin_api_silent_keys(int) to authenticated;
