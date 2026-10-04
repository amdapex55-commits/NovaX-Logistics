-- Nova Instant, phase 1 (4 Oct 2026). instant.html.
-- Point-to-point bike parcel delivery inside Karachi, booked without a NovaX
-- merchant account. A booking is its own record: it never touches parcels,
-- the COD ledger, invoices or wallets.
--   fare     Rs 25 per km of road distance, pickup pin to delivery pin,
--            minimum Rs 100 (nvi_config; change the row, not the code)
--   hours    10:00 to 01:00 Pakistan time
--   who pays the person booking chooses: sender or receiver, cash to the rider
--   riders   a separate set of Instant riders (phase 2); none exist yet, so
--            nvi_config.open stays false and only an admin can book until launch
-- Road distance comes from Mapbox Directions (Aisha's account, free tier), and
-- from the free FOSSGIS OpenStreetMap router if Mapbox does not answer. A
-- measured trip is kept in nvi_route_cache for a day, so the same two pins
-- price the same. If neither answers, the straight-line distance x 1.4 is
-- used and the quote says it is an estimate; the page asks again by itself.
-- The Mapbox PUBLIC token (pk.) is kept in nvi_config.mapbox_token, set by hand
-- in the database and never written in this repo (GitHub's secret scanner
-- blocks it). instant.html gets it from nvi_status(). With no token, the map
-- falls back to OpenStreetMap tiles and the road to the free router. The
-- Referer lets the token keep working once it is restricted to
-- novaxlogistics.com in the Mapbox console.
-- The public (anon) role is cancelled at 3 seconds and a function cannot
-- extend that, so both router calls together stay under about 2.3 seconds.
-- Every table has RLS on and no grants; all access is through the functions.
--
-- Phases 2 and 3 are in the second half of this file: Instant riders
-- (instant-rider.html) and the ops board (instant-ops.html).
-- Run once BEFORE this file, on its own (a new enum value cannot be used in
-- the transaction that adds it):
--   alter type public.novax_role add value if not exists 'instant';

create table if not exists public.nvi_config (
  id          boolean primary key default true check (id),
  open        boolean not null default false,
  rate_per_km numeric not null default 25,
  min_fare    int     not null default 100,
  open_hour   int     not null default 10 check (open_hour between 0 and 23),
  close_hour  int     not null default 1  check (close_hour between 0 and 23),
  updated_at  timestamptz not null default now()
);
insert into public.nvi_config (id) values (true) on conflict (id) do nothing;
-- update public.nvi_config set mapbox_token = '<the pk. token>' where id;   -- by hand, not here
alter table public.nvi_config add column if not exists mapbox_token text;

create table if not exists public.nvi_quotes (
  id         uuid primary key default gen_random_uuid(),
  p_lat      double precision not null,
  p_lng      double precision not null,
  d_lat      double precision not null,
  d_lng      double precision not null,
  distance_m int  not null,
  source     text not null check (source in ('road', 'estimate')),
  fare       int  not null,
  created_at timestamptz not null default now()
);
create index if not exists nvi_quotes_created on public.nvi_quotes(created_at);
-- The booking a quote became. Pressing Book twice (a lost reply on a weak
-- connection) returns the same booking instead of making a second one.
alter table public.nvi_quotes add column if not exists job_id uuid;

-- A measured road trip between two pins (rounded to about 11 m).
create table if not exists public.nvi_route_cache (
  k          text primary key,
  distance_m int  not null,
  line       text,            -- encoded polyline, precision 5
  snap_p     int  not null default 0,
  snap_d     int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists nvi_route_cache_created on public.nvi_route_cache(created_at);

create sequence if not exists public.nvi_job_seq start 100001;

create table if not exists public.nvi_jobs (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  status          text not null default 'Booked'
                  check (status in ('Booked', 'Rider assigned', 'Picked up', 'Delivered', 'Cancelled')),
  p_lat           double precision not null,
  p_lng           double precision not null,
  d_lat           double precision not null,
  d_lng           double precision not null,
  pickup_address  text not null,
  drop_address    text not null,
  sender_name     text not null,
  sender_phone    text not null,
  receiver_name   text not null,
  receiver_phone  text not null,
  item            text not null,
  rider_note      text,
  payer           text not null check (payer in ('sender', 'receiver')),
  distance_m      int  not null,
  distance_source text not null,
  fare            int  not null,
  track_token     text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  delivery_pin    text not null default lpad((floor(random() * 10000))::int::text, 4, '0'),
  rider_id        uuid,
  booked_by       uuid,
  created_at      timestamptz not null default now(),
  assigned_at     timestamptz,
  picked_at       timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text
);
-- Only the browser that made the booking holds this, so the receiver, who is
-- sent the tracking link, cannot cancel it.
alter table public.nvi_jobs add column if not exists manage_token text not null default encode(extensions.gen_random_bytes(12), 'hex');
create index if not exists nvi_jobs_status_created on public.nvi_jobs(status, created_at);
create index if not exists nvi_jobs_sender_phone on public.nvi_jobs(sender_phone, created_at);

-- Instant riders: their own roster, separate from the NovaX station riders.
-- NovaX adds a rider by email; the rider makes their own login on
-- instant-rider.html (NovaX never sets a password).
create table if not exists public.nvi_riders (
  id           uuid primary key default gen_random_uuid(),
  full_name    text not null,
  email        text not null unique,
  phone        text not null,
  bike_plate   text,
  auth_user_id uuid unique,
  status       text not null default 'Invited' check (status in ('Invited', 'Active', 'Blocked', 'Removed')),
  online       boolean not null default false,
  last_seen    timestamptz,
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  joined_at    timestamptz
);

-- Cash a rider handed to the office, confirmed by an admin.
create table if not exists public.nvi_handovers (
  id           bigserial primary key,
  rider_id     uuid not null references public.nvi_riders(id),
  amount       int  not null,
  jobs         int  not null,
  confirmed_by uuid,
  created_at   timestamptz not null default now()
);

-- What happened to a job, and who did it.
create table if not exists public.nvi_job_events (
  id       bigserial primary key,
  job_id   uuid not null references public.nvi_jobs(id) on delete cascade,
  at       timestamptz not null default now(),
  actor    text not null check (actor in ('rider', 'admin', 'system')),
  actor_id uuid,
  kind     text not null,
  note     text
);
create index if not exists nvi_job_events_job on public.nvi_job_events(job_id, at);

alter table public.nvi_jobs add column if not exists cash_collected int;
alter table public.nvi_jobs add column if not exists cash_at timestamptz;
alter table public.nvi_jobs add column if not exists handover_id bigint references public.nvi_handovers(id);
alter table public.nvi_jobs add column if not exists pin_tries int not null default 0;
alter table public.nvi_jobs add column if not exists problem_note text;
alter table public.nvi_jobs add column if not exists problem_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'nvi_jobs_rider_fk') then
    alter table public.nvi_jobs add constraint nvi_jobs_rider_fk foreign key (rider_id) references public.nvi_riders(id);
  end if;
end $$;
create index if not exists nvi_jobs_rider on public.nvi_jobs(rider_id, status);
-- A rider carries one parcel at a time.
create unique index if not exists nvi_jobs_one_active_per_rider on public.nvi_jobs(rider_id)
  where rider_id is not null and status in ('Rider assigned', 'Picked up');

alter table public.nvi_riders     enable row level security;
alter table public.nvi_handovers  enable row level security;
alter table public.nvi_job_events enable row level security;
revoke all on public.nvi_riders, public.nvi_handovers, public.nvi_job_events from public, anon, authenticated;
revoke all on sequence public.nvi_handovers_id_seq, public.nvi_job_events_id_seq from public, anon, authenticated;

alter table public.nvi_config enable row level security;
alter table public.nvi_quotes enable row level security;
alter table public.nvi_route_cache enable row level security;
revoke all on public.nvi_route_cache from public, anon, authenticated;
alter table public.nvi_jobs   enable row level security;
revoke all on public.nvi_config, public.nvi_quotes, public.nvi_jobs from public, anon, authenticated;
revoke all on sequence public.nvi_job_seq from public, anon, authenticated;

-- 03XXXXXXXXX, or '' when it is not a Pakistani mobile number. Same rule as
-- nvNormalizePkPhone() in the portal.
create or replace function public.nvi_pk_phone(p text)
returns text language sql immutable set search_path = '' as $$
  select case when d ~ '^3[0-9]{9}$' then '0' || d else '' end
  from (
    select case
      when length(x) = 14 and left(x, 4) = '0092' then substr(x, 5)
      when length(x) = 13 and left(x, 3) = '092'  then substr(x, 4)
      when length(x) = 12 and left(x, 2) = '92'   then substr(x, 3)
      when length(x) = 11 and left(x, 1) = '0'    then substr(x, 2)
      else x end as d
    from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as x) s
  ) t
$$;

-- Greater Karachi, DHA City and Bahria Town included.
create or replace function public.nvi_in_karachi(p_lat double precision, p_lng double precision)
returns boolean language sql immutable set search_path = '' as $$
  select p_lat between 24.74 and 25.20 and p_lng between 66.80 and 67.55
$$;

create or replace function public.nvi_straight_m(a_lat double precision, a_lng double precision,
                                                 b_lat double precision, b_lng double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2) +
    cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)))
$$;

-- Is the desk taking bookings right now? Hours wrap past midnight (10 -> 1).
create or replace function public.nvi_hours_open(c public.nvi_config)
returns boolean language sql stable set search_path = '' as $$
  select case
    when (c).open_hour = (c).close_hour then true
    when (c).open_hour < (c).close_hour then h >= (c).open_hour and h < (c).close_hour
    else h >= (c).open_hour or h < (c).close_hour end
  from (select extract(hour from (now() at time zone 'Asia/Karachi'))::int as h) t
$$;

create or replace function public.nvi_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.nvi_config;
begin
  select * into c from public.nvi_config where id;
  return jsonb_build_object(
    'open', c.open,
    'preview', (not c.open) and coalesce((select public.is_admin()), false),
    'hours_open', public.nvi_hours_open(c),
    'open_hour', c.open_hour, 'close_hour', c.close_hour,
    'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare, 'mapbox', c.mapbox_token);
end $$;

-- Ask one router for the road between two pins. Returns null when it does
-- not answer in time or the answer is not a route. Mapbox and OSRM answer in
-- the same shape.
drop function if exists public.nvi_route_from(text, int, double precision, double precision, double precision, double precision);
create or replace function public.nvi_route_from(p_url text, p_ms int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res extensions.http_response; v_json jsonb;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', p_ms::text);
  select * into v_res from extensions.http((
    'GET', p_url,
    array[extensions.http_header('User-Agent', 'NovaInstant/1.0 (+https://novaxlogistics.com)'),
          extensions.http_header('Referer', 'https://novaxlogistics.com/')],
    null, null)::extensions.http_request);
  if v_res.status <> 200 then return null; end if;
  v_json := v_res.content::jsonb;
  if v_json->>'code' <> 'Ok' or (v_json#>>'{routes,0,distance}') is null then return null; end if;
  return jsonb_build_object(
    'm', round((v_json#>>'{routes,0,distance}')::numeric)::int,
    'line', v_json#>>'{routes,0,geometry}',
    'snap_p', round(coalesce((v_json#>>'{waypoints,0,distance}')::numeric, 0))::int,
    'snap_d', round(coalesce((v_json#>>'{waypoints,1,distance}')::numeric, 0))::int);
exception when others then
  return null;
end $$;

-- Price a trip. The quote is stored, and a booking can only be made against a
-- stored quote, so the browser never supplies the distance or the fare.
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

  v_key := round(p_plat::numeric, 4) || ',' || round(p_plng::numeric, 4) || ';'
        || round(p_dlat::numeric, 4) || ',' || round(p_dlng::numeric, 4);
  select * into v_hit from public.nvi_route_cache where k = v_key;
  if found then
    v_m := v_hit.distance_m; v_line := v_hit.line; v_sp := v_hit.snap_p; v_sd := v_hit.snap_d; v_src := 'road';
  else
    -- At most 40 new road lookups a minute from here (it protects the free
    -- allowance); past that the estimate is used.
    select count(*) into v_recent from public.nvi_route_cache where created_at > now() - interval '1 minute';
    if v_recent < 40 then
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
  insert into public.nvi_quotes (p_lat, p_lng, d_lat, d_lng, distance_m, source, fare)
  values (p_plat, p_plng, p_dlat, p_dlng, v_m, v_src, v_fare)
  returning id into v_id;
  delete from public.nvi_quotes where created_at < now() - interval '2 days';
  delete from public.nvi_route_cache where created_at < now() - interval '1 day';

  return jsonb_build_object('ok', true, 'quote', v_id,
    'km', round(v_m / 1000.0, 1), 'fare', v_fare, 'source', v_src, 'line', v_line,
    'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare);
end $$;

create or replace function public.nvi_book(
  p_quote uuid,
  p_pickup_address text, p_drop_address text,
  p_sender_name text, p_sender_phone text,
  p_receiver_name text, p_receiver_phone text,
  p_item text, p_payer text, p_rider_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.nvi_config; q public.nvi_quotes; j public.nvi_jobs;
  v_admin boolean := coalesce((select public.is_admin()), false);
  v_sp text := public.nvi_pk_phone(p_sender_phone);
  v_rp text := public.nvi_pk_phone(p_receiver_phone);
  v_code text;
begin
  select * into c from public.nvi_config where id;
  if not c.open and not v_admin then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;
  if not public.nvi_hours_open(c) and not v_admin then
    return jsonb_build_object('ok', false, 'reason', 'closed_now');
  end if;
  select * into q from public.nvi_quotes where id = p_quote for update;
  if found and q.job_id is not null then
    select * into j from public.nvi_jobs where id = q.job_id;
    if found then
      return jsonb_build_object('ok', true, 'code', j.code, 'token', j.track_token, 'manage', j.manage_token,
        'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1), 'payer', j.payer, 'pin', j.delivery_pin);
    end if;
  end if;
  if q.id is null or q.created_at < now() - interval '20 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired');
  end if;
  if length(btrim(coalesce(p_pickup_address, ''))) < 8 then return jsonb_build_object('ok', false, 'reason', 'pickup_address'); end if;
  if length(btrim(coalesce(p_drop_address, '')))   < 8 then return jsonb_build_object('ok', false, 'reason', 'drop_address'); end if;
  if length(btrim(coalesce(p_sender_name, '')))    < 2 then return jsonb_build_object('ok', false, 'reason', 'sender_name'); end if;
  if length(btrim(coalesce(p_receiver_name, '')))  < 2 then return jsonb_build_object('ok', false, 'reason', 'receiver_name'); end if;
  if v_sp = '' then return jsonb_build_object('ok', false, 'reason', 'sender_phone'); end if;
  if v_rp = '' then return jsonb_build_object('ok', false, 'reason', 'receiver_phone'); end if;
  if length(btrim(coalesce(p_item, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'item'); end if;
  if p_payer is null or p_payer not in ('sender', 'receiver') then return jsonb_build_object('ok', false, 'reason', 'payer'); end if;
  -- One phone cannot hold a pile of live bookings.
  if (select count(*) from public.nvi_jobs
       where sender_phone = v_sp and status in ('Booked', 'Rider assigned', 'Picked up')) >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_open');
  end if;

  v_code := 'NI' || nextval('public.nvi_job_seq')::text;
  insert into public.nvi_jobs (code, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address,
    sender_name, sender_phone, receiver_name, receiver_phone, item, rider_note, payer,
    distance_m, distance_source, fare, booked_by)
  values (v_code, q.p_lat, q.p_lng, q.d_lat, q.d_lng,
    left(btrim(p_pickup_address), 300), left(btrim(p_drop_address), 300),
    left(btrim(p_sender_name), 80), v_sp, left(btrim(p_receiver_name), 80), v_rp,
    left(btrim(p_item), 160), nullif(left(btrim(coalesce(p_rider_note, '')), 240), ''), p_payer,
    q.distance_m, q.source, q.fare, (select auth.uid()))
  returning * into j;
  update public.nvi_quotes set job_id = j.id where id = q.id;

  return jsonb_build_object('ok', true, 'code', j.code, 'token', j.track_token, 'manage', j.manage_token,
    'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1), 'payer', j.payer, 'pin', j.delivery_pin);
end $$;

-- What anyone holding the tracking link sees. Phone numbers are not returned.
create or replace function public.nvi_track(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  if p_token is null or length(p_token) < 24 then return jsonb_build_object('ok', false); end if;
  select * into j from public.nvi_jobs where track_token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'code', j.code, 'status', j.status,
    'pickup_address', j.pickup_address, 'drop_address', j.drop_address,
    'sender_name', j.sender_name, 'receiver_name', j.receiver_name, 'item', j.item,
    'payer', j.payer, 'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1),
    'pin', case when j.status in ('Delivered', 'Cancelled') then null else j.delivery_pin end,
    'rider', case when j.rider_id is not null and j.status in ('Rider assigned', 'Picked up') then
      (select jsonb_build_object('name', split_part(r.full_name, ' ', 1), 'phone', r.phone, 'plate', r.bike_plate)
         from public.nvi_riders r where r.id = j.rider_id) end,
    'p', jsonb_build_array(j.p_lat, j.p_lng), 'd', jsonb_build_array(j.d_lat, j.d_lng),
    'created_at', j.created_at, 'assigned_at', j.assigned_at, 'picked_at', j.picked_at,
    'delivered_at', j.delivered_at, 'cancelled_at', j.cancelled_at);
end $$;

-- The person who booked can cancel until a rider has the parcel. It takes the
-- manage token their browser was given at booking; the tracking link alone
-- (which the receiver also has) is not enough.
drop function if exists public.nvi_cancel(text);
create or replace function public.nvi_cancel(p_token text, p_manage text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  select * into j from public.nvi_jobs where track_token = p_token for update;
  if not found or p_manage is null or j.manage_token <> p_manage then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if j.status not in ('Booked', 'Rider assigned') then
    return jsonb_build_object('ok', false, 'reason', 'too_late', 'status', j.status);
  end if;
  update public.nvi_jobs set status = 'Cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by customer', rider_id = null
   where id = j.id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.nvi_pk_phone(text) from public, anon, authenticated;
revoke all on function public.nvi_in_karachi(double precision, double precision) from public, anon, authenticated;
revoke all on function public.nvi_straight_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.nvi_hours_open(public.nvi_config) from public, anon, authenticated;
revoke all on function public.nvi_route_from(text, int) from public, anon, authenticated;
revoke all on function public.nvi_status() from public, anon, authenticated;
revoke all on function public.nvi_quote(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.nvi_book(uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.nvi_track(text) from public, anon, authenticated;
revoke all on function public.nvi_cancel(text, text) from public, anon, authenticated;
-- Public on purpose: Nova Instant is booked without an account.
grant execute on function public.nvi_status() to anon, authenticated;
grant execute on function public.nvi_quote(double precision, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.nvi_book(uuid, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.nvi_track(text) to anon, authenticated;
grant execute on function public.nvi_cancel(text, text) to anon, authenticated;


-- ═══════════════════ Phase 2: Instant riders ═══════════════════

create or replace function public.nvi_event(p_job uuid, p_actor text, p_kind text, p_note text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.nvi_job_events (job_id, actor, actor_id, kind, note)
  values (p_job, p_actor, (select auth.uid()), p_kind, nullif(left(btrim(coalesce(p_note, '')), 300), ''))
$$;

-- A rider NovaX invited signs up with that email; this links the login.
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
  update public.nvi_riders set auth_user_id = v_uid, status = 'Active', joined_at = now() where id = r.id;
  insert into public.profiles(id, email, full_name, role) values (v_uid, v_email, r.full_name, 'instant')
  on conflict (id) do update set role = 'instant', full_name = excluded.full_name;
end $$;

create or replace function public.nvi_rider_me()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  perform public.nvi_rider_join();
  select * into r from public.nvi_riders where auth_user_id = auth.uid();
  return jsonb_build_object(
    'email', (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'is_admin', coalesce((select public.is_admin()), false),
    'rider', case when r.id is null then null else
      jsonb_build_object('id', r.id, 'full_name', r.full_name, 'status', r.status, 'online', r.online) end);
end $$;

-- The signed-in, Active Instant rider, or an error.
create or replace function public.nvi_require_rider()
returns public.nvi_riders language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders;
begin
  select * into r from public.nvi_riders where auth_user_id = auth.uid();
  if r.id is null or r.status <> 'Active' then
    raise exception 'This login is not an active Nova Instant rider.' using errcode = '42501';
  end if;
  return r;
end $$;

create or replace function public.nvi_rider_job_json(j public.nvi_jobs, p_full boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', j.id, 'code', j.code, 'status', j.status,
      'pickup_address', j.pickup_address, 'drop_address', j.drop_address, 'item', j.item,
      'payer', j.payer, 'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1),
      'p', jsonb_build_array(j.p_lat, j.p_lng), 'd', jsonb_build_array(j.d_lat, j.d_lng),
      'created_at', j.created_at, 'assigned_at', j.assigned_at, 'picked_at', j.picked_at)
    || case when p_full then jsonb_build_object(
      'sender_name', j.sender_name, 'sender_phone', j.sender_phone,
      'receiver_name', j.receiver_name, 'receiver_phone', j.receiver_phone,
      'rider_note', j.rider_note, 'pin_tries', j.pin_tries, 'problem_note', j.problem_note) else '{}'::jsonb end
$$;

-- Everything the rider screen shows, in one call. Phone numbers only come
-- with a job the rider has accepted.
create or replace function public.nvi_rider_feed()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.nvi_riders := public.nvi_require_rider();
  c public.nvi_config; a public.nvi_jobs;
  v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  update public.nvi_riders set last_seen = now() where id = r.id;
  select * into c from public.nvi_config where id;
  select * into a from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up');
  return jsonb_build_object(
    'rider', jsonb_build_object('full_name', r.full_name, 'online', r.online),
    'hours_open', public.nvi_hours_open(c), 'open_hour', c.open_hour, 'close_hour', c.close_hour,
    'active', case when a.id is null then null else public.nvi_rider_job_json(a, true) end,
    'open', case when a.id is null and r.online then
      coalesce((select jsonb_agg(public.nvi_rider_job_json(j, false) order by j.created_at)
                  from public.nvi_jobs j
                 where j.id in (select id from public.nvi_jobs where status = 'Booked' and rider_id is null
                                 order by created_at limit 20)), '[]'::jsonb) else '[]'::jsonb end,
    'today', jsonb_build_object(
      'done', (select count(*) from public.nvi_jobs where rider_id = r.id and status = 'Delivered'
                and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'fares', (select coalesce(sum(fare), 0) from public.nvi_jobs where rider_id = r.id and status = 'Delivered'
                and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'cash_in_hand', (select coalesce(sum(cash_collected), 0) from public.nvi_jobs
                        where rider_id = r.id and cash_collected is not null and handover_id is null)));
end $$;

create or replace function public.nvi_rider_online(p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider();
begin
  update public.nvi_riders set online = coalesce(p_on, false), last_seen = now() where id = r.id;
  return jsonb_build_object('ok', true, 'online', coalesce(p_on, false));
end $$;

-- First rider to press Accept gets the job.
create or replace function public.nvi_rider_accept(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if not r.online then return jsonb_build_object('ok', false, 'reason', 'offline'); end if;
  if exists (select 1 from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up')) then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  update public.nvi_jobs set rider_id = r.id, status = 'Rider assigned', assigned_at = now()
   where id = p_job and status = 'Booked' and rider_id is null
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'taken'); end if;
  perform public.nvi_event(j.id, 'rider', 'accepted', r.full_name);
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'busy');
end $$;

-- Give a job back before pickup, with a reason. It returns to the open list.
create or replace function public.nvi_rider_release(p_job uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_reason'); end if;
  update public.nvi_jobs set rider_id = null, status = 'Booked', assigned_at = null
   where id = p_job and rider_id = r.id and status = 'Rider assigned'
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  perform public.nvi_event(j.id, 'rider', 'released', r.full_name || ': ' || p_reason);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_rider_picked(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  update public.nvi_jobs set status = 'Picked up', picked_at = now(),
         cash_collected = case when payer = 'sender' then fare else cash_collected end,
         cash_at        = case when payer = 'sender' then now() else cash_at end
   where id = p_job and rider_id = r.id and status = 'Rider assigned'
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  perform public.nvi_event(j.id, 'rider', 'picked_up', case when j.payer = 'sender' then 'Collected Rs ' || j.fare || ' from the sender' end);
  return jsonb_build_object('ok', true);
end $$;

-- Delivery needs the 4-digit PIN from the receiver's tracking link. Five wrong
-- tries lock it; ops can then close the job from the board.
create or replace function public.nvi_rider_delivered(p_job uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id and status = 'Picked up' for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.pin_tries >= 5 then return jsonb_build_object('ok', false, 'reason', 'pin_locked'); end if;
  if regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g') <> j.delivery_pin then
    update public.nvi_jobs set pin_tries = pin_tries + 1 where id = j.id;
    return jsonb_build_object('ok', false, 'reason', case when j.pin_tries + 1 >= 5 then 'pin_locked' else 'wrong_pin' end,
                              'left', greatest(0, 4 - j.pin_tries));
  end if;
  update public.nvi_jobs set status = 'Delivered', delivered_at = now(),
         cash_collected = case when payer = 'receiver' then fare else cash_collected end,
         cash_at        = case when payer = 'receiver' then now() else cash_at end
   where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'delivered', case when j.payer = 'receiver' then 'Collected Rs ' || j.fare || ' from the receiver' end);
  return jsonb_build_object('ok', true);
end $$;

-- "I cannot finish this": the note goes to the ops board. The job keeps its status.
create or replace function public.nvi_rider_problem(p_job uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  update public.nvi_jobs set problem_note = left(btrim(p_note), 300), problem_at = now()
   where id = p_job and rider_id = r.id and status in ('Rider assigned', 'Picked up')
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  perform public.nvi_event(j.id, 'rider', 'problem', p_note);
  return jsonb_build_object('ok', true);
end $$;

-- ═══════════════════ Phase 3: the ops board ═══════════════════

create or replace function public.nvi_require_admin()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce((select public.is_admin()), false) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
end $$;

create or replace function public.nvi_admin_job_json(j public.nvi_jobs)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(j) - 'track_token' - 'manage_token' - 'booked_by'
    || jsonb_build_object('km', round(j.distance_m / 1000.0, 1), 'token', j.track_token,
         'rider_name', (select r.full_name from public.nvi_riders r where r.id = j.rider_id))
$$;

create or replace function public.nvi_admin_board()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform public.nvi_require_admin();
  select * into c from public.nvi_config where id;
  return jsonb_build_object(
    'config', jsonb_build_object('open', c.open, 'hours_open', public.nvi_hours_open(c), 'open_hour', c.open_hour,
                                 'close_hour', c.close_hour, 'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare),
    'live', coalesce((select jsonb_agg(public.nvi_admin_job_json(j) order by j.created_at)
                        from public.nvi_jobs j where j.status in ('Booked', 'Rider assigned', 'Picked up')), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(public.nvi_admin_job_json(j) order by coalesce(j.delivered_at, j.cancelled_at) desc)
                          from public.nvi_jobs j
                         where j.id in (select id from public.nvi_jobs where status in ('Delivered', 'Cancelled')
                                         order by coalesce(delivered_at, cancelled_at) desc limit 60)), '[]'::jsonb),
    'riders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'full_name', r.full_name, 'email', r.email, 'phone', r.phone, 'bike_plate', r.bike_plate,
        'status', r.status, 'online', r.online, 'last_seen', r.last_seen, 'joined_at', r.joined_at,
        'active_code', (select j.code from public.nvi_jobs j where j.rider_id = r.id and j.status in ('Rider assigned', 'Picked up')),
        'done_today', (select count(*) from public.nvi_jobs j where j.rider_id = r.id and j.status = 'Delivered'
                        and (j.delivered_at at time zone 'Asia/Karachi')::date = v_day),
        'cash_in_hand', (select coalesce(sum(j.cash_collected), 0) from public.nvi_jobs j
                          where j.rider_id = r.id and j.cash_collected is not null and j.handover_id is null))
        order by (r.status = 'Active') desc, r.online desc, r.full_name)
      from public.nvi_riders r where r.status <> 'Removed'), '[]'::jsonb),
    'today', jsonb_build_object(
      'booked', (select count(*) from public.nvi_jobs where (created_at at time zone 'Asia/Karachi')::date = v_day),
      'delivered', (select count(*) from public.nvi_jobs where status = 'Delivered' and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'cancelled', (select count(*) from public.nvi_jobs where status = 'Cancelled' and (cancelled_at at time zone 'Asia/Karachi')::date = v_day),
      'fares', (select coalesce(sum(fare), 0) from public.nvi_jobs where status = 'Delivered' and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'cash_out', (select coalesce(sum(cash_collected), 0) from public.nvi_jobs where cash_collected is not null and handover_id is null)));
end $$;

create or replace function public.nvi_admin_job(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  perform public.nvi_require_admin();
  select * into j from public.nvi_jobs where id = p_job;
  if j.id is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'job', public.nvi_admin_job_json(j),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'kind', e.kind, 'note', e.note) order by e.at)
                          from public.nvi_job_events e where e.job_id = j.id), '[]'::jsonb));
end $$;

-- Assign, reassign, or (with no rider) put a job back in the open list.
create or replace function public.nvi_admin_assign(p_job uuid, p_rider uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs; r public.nvi_riders;
begin
  perform public.nvi_require_admin();
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.status not in ('Booked', 'Rider assigned') then return jsonb_build_object('ok', false, 'reason', 'too_late', 'status', j.status); end if;
  if p_rider is null then
    update public.nvi_jobs set rider_id = null, status = 'Booked', assigned_at = null where id = j.id;
    perform public.nvi_event(j.id, 'admin', 'unassigned');
    return jsonb_build_object('ok', true);
  end if;
  select * into r from public.nvi_riders where id = p_rider;
  if r.id is null or r.status <> 'Active' then return jsonb_build_object('ok', false, 'reason', 'rider_inactive'); end if;
  if exists (select 1 from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up') and id <> j.id) then
    return jsonb_build_object('ok', false, 'reason', 'rider_busy');
  end if;
  update public.nvi_jobs set rider_id = r.id, status = 'Rider assigned', assigned_at = now() where id = j.id;
  perform public.nvi_event(j.id, 'admin', 'assigned', r.full_name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_admin_cancel(p_job uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_reason, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_reason'); end if;
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.status in ('Delivered', 'Cancelled') then return jsonb_build_object('ok', false, 'reason', 'closed', 'status', j.status); end if;
  update public.nvi_jobs set status = 'Cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_reason), 200) where id = j.id;
  perform public.nvi_event(j.id, 'admin', 'cancelled', p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- Ops closes a step by hand: the rider's phone died, or the PIN is locked.
create or replace function public.nvi_admin_mark(p_job uuid, p_status text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.rider_id is null then return jsonb_build_object('ok', false, 'reason', 'no_rider'); end if;
  if p_status = 'Picked up' and j.status = 'Rider assigned' then
    update public.nvi_jobs set status = 'Picked up', picked_at = now(),
           cash_collected = case when payer = 'sender' then fare else cash_collected end,
           cash_at        = case when payer = 'sender' then now() else cash_at end where id = j.id;
  elsif p_status = 'Delivered' and j.status = 'Picked up' then
    update public.nvi_jobs set status = 'Delivered', delivered_at = now(),
           cash_collected = case when payer = 'receiver' then fare else cash_collected end,
           cash_at        = case when payer = 'receiver' then now() else cash_at end where id = j.id;
  else
    return jsonb_build_object('ok', false, 'reason', 'wrong_step', 'status', j.status);
  end if;
  perform public.nvi_event(j.id, 'admin', 'marked ' || p_status, p_note);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_admin_invite_rider(p_name text, p_email text, p_phone text, p_plate text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := public.nvi_pk_phone(p_phone); r public.nvi_riders;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_name, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'reason', 'email'); end if;
  if v_phone = '' then return jsonb_build_object('ok', false, 'reason', 'phone'); end if;
  select * into r from public.nvi_riders where email = v_email;
  if r.id is not null and r.status <> 'Removed' then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
  if r.id is not null then
    update public.nvi_riders set full_name = left(btrim(p_name), 80), phone = v_phone,
           bike_plate = nullif(left(btrim(coalesce(p_plate, '')), 20), ''),
           status = case when auth_user_id is null then 'Invited' else 'Active' end where id = r.id;
  else
    insert into public.nvi_riders (full_name, email, phone, bike_plate, invited_by)
    values (left(btrim(p_name), 80), v_email, v_phone, nullif(left(btrim(coalesce(p_plate, '')), 20), ''), (select auth.uid()));
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_admin_set_rider(p_rider uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders;
begin
  perform public.nvi_require_admin();
  if p_status not in ('Active', 'Blocked', 'Removed') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  select * into r from public.nvi_riders where id = p_rider for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  update public.nvi_riders
     set status = case when p_status = 'Active' and auth_user_id is null then 'Invited' else p_status end,
         online = case when p_status = 'Active' then online else false end
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- The office took the rider's cash: every fare they hold is marked handed over.
create or replace function public.nvi_admin_handover(p_rider uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_amount int; v_jobs int; v_id bigint;
begin
  perform public.nvi_require_admin();
  select coalesce(sum(cash_collected), 0), count(*) into v_amount, v_jobs from public.nvi_jobs
   where rider_id = p_rider and cash_collected is not null and handover_id is null;
  if v_jobs = 0 then return jsonb_build_object('ok', false, 'reason', 'nothing'); end if;
  insert into public.nvi_handovers (rider_id, amount, jobs, confirmed_by)
  values (p_rider, v_amount, v_jobs, (select auth.uid())) returning id into v_id;
  update public.nvi_jobs set handover_id = v_id
   where rider_id = p_rider and cash_collected is not null and handover_id is null;
  return jsonb_build_object('ok', true, 'amount', v_amount, 'jobs', v_jobs);
end $$;

-- The launch switch: when off, the public sees fares but cannot book.
create or replace function public.nvi_admin_set_open(p_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.nvi_require_admin();
  update public.nvi_config set open = coalesce(p_open, false), updated_at = now() where id;
  return jsonb_build_object('ok', true, 'open', coalesce(p_open, false));
end $$;

do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'nvi\_rider\_%' or p.proname like 'nvi\_admin\_%' or p.proname in ('nvi_event', 'nvi_require_rider', 'nvi_require_admin'))
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- Signed-in users only; each function checks who is calling.
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_rider_me', 'nvi_rider_feed', 'nvi_rider_online', 'nvi_rider_accept', 'nvi_rider_release',
                         'nvi_rider_picked', 'nvi_rider_delivered', 'nvi_rider_problem',
                         'nvi_admin_board', 'nvi_admin_job', 'nvi_admin_assign', 'nvi_admin_cancel', 'nvi_admin_mark',
                         'nvi_admin_invite_rider', 'nvi_admin_set_rider', 'nvi_admin_handover', 'nvi_admin_set_open')
  loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

notify pgrst, 'reload schema';
