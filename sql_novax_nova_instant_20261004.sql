-- Nova Instant (4 Oct 2026). instant.html, instant-rider.html, instant-ops.html.
-- Point-to-point bike parcel delivery inside Karachi, booked without a NovaX
-- merchant account. A booking is its own record: it never touches parcels,
-- the COD ledger, invoices or wallets.
--   fare     Rs 25 per km of road distance, pickup pin to delivery pin,
--            minimum Rs 100 (nvi_config; change the row, not the code)
--   hours    10:00 to 01:00 Pakistan time
--   who pays the person booking chooses: sender or receiver, cash to the rider
--   riders   a separate set of Instant riders; nvi_config.open stays false and
--            only an admin can book until launch
-- Road distance comes from Mapbox Directions (Aisha's account, free tier), and
-- from the free FOSSGIS OpenStreetMap router if Mapbox does not answer. A
-- measured trip is kept in nvi_route_cache for a day, so the same two pins
-- price the same. If neither answers, the customer sees a straight-line
-- estimate (x 1.4) and is asked to try again: only a measured road can be
-- booked, because only a measured road proves a rider can reach both pins.
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
-- The life of a job:
--   Awaiting confirmation  a first-time sender; NovaX phones them, then
--   Booked -> Rider assigned -> Picked up -> Delivered
--                               Picked up -> Failed delivery -> Returning -> Returned
--   Cancelled              only before pickup. Once a rider holds the parcel
--                          it is delivered or it goes back to the sender.
-- Cash is never assumed. The rider (or ops, closing a step by hand) states the
-- rupees received; each receipt is a row in nvi_cash, and a shortfall puts the
-- job's payment in 'Disputed' until ops settles it.
--
-- This file can be run again at any time. The enum value below is only used
-- inside function bodies, which Postgres does not read until they are called,
-- so it no longer needs a separate run first.
alter type public.novax_role add value if not exists 'instant';

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
-- A sender whose number has never had a delivery waits for a phone call from
-- NovaX before any rider sees the job.
alter table public.nvi_config add column if not exists confirm_first boolean not null default true;
-- What the return leg costs, as a share of the fare. 0 = the return is free.
alter table public.nvi_config add column if not exists return_fee_pct int not null default 0 check (return_fee_pct between 0 and 200);
alter table public.nvi_config add column if not exists max_kg int not null default 10;
alter table public.nvi_config add column if not exists max_value int not null default 10000;
alter table public.nvi_config add column if not exists support_phone text not null default '03123922558';
alter table public.nvi_config add column if not exists terms_version text not null default 'draft-2026-10-04';
-- Days a closed booking stays readable from its tracking link.
alter table public.nvi_config add column if not exists track_days int not null default 7 check (track_days between 1 and 90);
-- Cloudflare Turnstile (free). With no secret set, no CAPTCHA is asked for.
--   update public.nvi_config set turnstile_site = '<site key>', turnstile_secret = '<secret key>' where id;
alter table public.nvi_config add column if not exists turnstile_site text;
alter table public.nvi_config add column if not exists turnstile_secret text;

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
alter table public.nvi_quotes add column if not exists ip text;
create index if not exists nvi_quotes_ip on public.nvi_quotes(ip, created_at);

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
  status          text not null default 'Booked',
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

-- What NovaX collects before a rider can go online (5 Oct 2026): a photo of
-- their CNIC, a photo of a home utility bill, and an emergency contact. The
-- photos live in the private bucket nvi-rider-docs under the rider's own
-- login id; only that rider and NovaX admins can read them.
alter table public.nvi_riders add column if not exists emergency_name  text;
alter table public.nvi_riders add column if not exists emergency_phone text;
alter table public.nvi_riders add column if not exists cnic_path       text;
alter table public.nvi_riders add column if not exists bill_path       text;
alter table public.nvi_riders add column if not exists docs_at         timestamptz;
alter table public.nvi_riders add column if not exists docs_checked_at timestamptz;
alter table public.nvi_riders add column if not exists docs_checked_by uuid;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('nvi-rider-docs', 'nvi-rider-docs', false, 3145728, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Is the caller on the Instant rider roster (any status)? Used by the storage rules.
create or replace function public.nvi_is_rider()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.nvi_riders r where r.auth_user_id = (select auth.uid()))
$$;

drop policy if exists nvi_rider_docs_insert on storage.objects;
create policy nvi_rider_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'nvi-rider-docs'
              and split_part(name, '/', 1) = ((select auth.uid()))::text
              and name ~ '^[0-9a-f-]{36}/(cnic|bill)-[0-9]{10,16}-[0-9a-f]{8}\.jpg$'
              and (select public.nvi_is_rider()));
drop policy if exists nvi_rider_docs_select on storage.objects;
create policy nvi_rider_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'nvi-rider-docs'
         and ((select public.is_admin()) or split_part(name, '/', 1) = ((select auth.uid()))::text));

-- Cash a rider handed to the office, confirmed by an admin.
create table if not exists public.nvi_handovers (
  id           bigserial primary key,
  rider_id     uuid not null references public.nvi_riders(id),
  amount       int  not null,
  jobs         int  not null,
  confirmed_by uuid,
  created_at   timestamptz not null default now()
);
-- The ops page makes one key per press. The same key twice is the same
-- handover, never a second one.
alter table public.nvi_handovers add column if not exists idem_key uuid;
create unique index if not exists nvi_handovers_idem on public.nvi_handovers(idem_key);

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

-- Every rupee a rider says they received, one row per receipt. The rider who
-- took the cash owes it, even if the parcel later moves to another rider.
create table if not exists public.nvi_cash (
  id          bigserial primary key,
  job_id      uuid not null references public.nvi_jobs(id),
  rider_id    uuid not null references public.nvi_riders(id),
  amount      int  not null check (amount > 0),
  kind        text not null check (kind in ('fare', 'return')),
  noted_by    text not null check (noted_by in ('rider', 'admin')),
  at          timestamptz not null default now(),
  handover_id bigint references public.nvi_handovers(id),
  unique (job_id, kind)
);
create index if not exists nvi_cash_rider_open on public.nvi_cash(rider_id) where handover_id is null;
-- 'topup': the rest of a short payment, collected after the first part had
-- already been handed to the office.
alter table public.nvi_cash drop constraint if exists nvi_cash_kind_check;
alter table public.nvi_cash add constraint nvi_cash_kind_check check (kind in ('fare', 'return', 'topup'));

-- Tries at the "find my booking" form, for the rate limit.
create table if not exists public.nvi_hits (
  id   bigserial primary key,
  kind text not null,
  ip   text,
  at   timestamptz not null default now()
);
create index if not exists nvi_hits_kind_ip on public.nvi_hits(kind, ip, at);

alter table public.nvi_jobs add column if not exists cash_collected int;
alter table public.nvi_jobs add column if not exists cash_at timestamptz;
alter table public.nvi_jobs drop column if exists handover_id;   -- moved to nvi_cash
alter table public.nvi_jobs add column if not exists pin_tries int not null default 0;
alter table public.nvi_jobs add column if not exists problem_note text;
alter table public.nvi_jobs add column if not exists problem_at timestamptz;
alter table public.nvi_jobs add column if not exists ip text;
alter table public.nvi_jobs add column if not exists device text;
alter table public.nvi_jobs add column if not exists terms_version text;
alter table public.nvi_jobs add column if not exists confirmed_at timestamptz;
alter table public.nvi_jobs add column if not exists confirmed_by uuid;
alter table public.nvi_jobs add column if not exists attempts int not null default 1;
alter table public.nvi_jobs add column if not exists failed_at timestamptz;
alter table public.nvi_jobs add column if not exists fail_reason text;
alter table public.nvi_jobs add column if not exists fail_note text;
alter table public.nvi_jobs add column if not exists returning_at timestamptz;
alter table public.nvi_jobs add column if not exists returned_at timestamptz;
alter table public.nvi_jobs add column if not exists return_fee int not null default 0;
alter table public.nvi_jobs add column if not exists pay_state text not null default 'Due';
alter table public.nvi_jobs add column if not exists pay_note text;
-- Where the booking started: the homepage, the merchant portal, or a direct visit.
alter table public.nvi_jobs add column if not exists source text;

-- What customers tell NovaX about the service. Written only by nvi_feedback().
create table if not exists public.nvi_feedback (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  job_id    uuid references public.nvi_jobs(id) on delete set null,
  source    text,
  would_use text check (would_use is null or would_use in ('yes', 'maybe', 'no')),
  fare_fair text check (fare_fair is null or fare_fair in ('fair', 'bit_high', 'too_high')),
  note      text,
  fare      int,
  km        numeric(6,1),
  ip        text
);
create index if not exists nvi_feedback_at on public.nvi_feedback(at desc);
alter table public.nvi_feedback enable row level security;
revoke all on public.nvi_feedback from public, anon, authenticated;
revoke all on sequence public.nvi_feedback_id_seq from public, anon, authenticated;
alter table public.nvi_jobs drop constraint if exists nvi_jobs_status_check;
alter table public.nvi_jobs add constraint nvi_jobs_status_check check (status in
  ('Awaiting confirmation', 'Booked', 'Rider assigned', 'Picked up', 'Failed delivery', 'Returning', 'Returned', 'Delivered', 'Cancelled'));
alter table public.nvi_jobs drop constraint if exists nvi_jobs_fail_reason_check;
alter table public.nvi_jobs add constraint nvi_jobs_fail_reason_check check (fail_reason is null or fail_reason in
  ('receiver_unavailable', 'refused', 'wrong_address', 'damaged', 'payment_refused'));
alter table public.nvi_jobs drop constraint if exists nvi_jobs_pay_state_check;
alter table public.nvi_jobs add constraint nvi_jobs_pay_state_check check (pay_state in ('Due', 'Received', 'Disputed', 'Written off'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'nvi_jobs_rider_fk') then
    alter table public.nvi_jobs add constraint nvi_jobs_rider_fk foreign key (rider_id) references public.nvi_riders(id);
  end if;
end $$;
create index if not exists nvi_jobs_rider on public.nvi_jobs(rider_id, status);
create index if not exists nvi_jobs_ip on public.nvi_jobs(ip, created_at);
create index if not exists nvi_jobs_device on public.nvi_jobs(device, created_at);
-- A rider carries one parcel at a time, and still carries it while a failed
-- delivery is being sorted out or taken back.
drop index if exists public.nvi_jobs_one_active_per_rider;
create unique index nvi_jobs_one_active_per_rider on public.nvi_jobs(rider_id)
  where rider_id is not null and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning');

alter table public.nvi_riders     enable row level security;
alter table public.nvi_handovers  enable row level security;
alter table public.nvi_job_events enable row level security;
alter table public.nvi_cash       enable row level security;
alter table public.nvi_hits       enable row level security;
revoke all on public.nvi_riders, public.nvi_handovers, public.nvi_job_events, public.nvi_cash, public.nvi_hits from public, anon, authenticated;
revoke all on sequence public.nvi_handovers_id_seq, public.nvi_job_events_id_seq, public.nvi_cash_id_seq, public.nvi_hits_id_seq from public, anon, authenticated;

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

-- Greater Karachi, DHA City and Bahria Town included. The box also holds sea
-- and empty land; the measured road (nvi_quote) is what rules those out.
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

-- The caller's address as the API gateway reports it. Null when a function is
-- called from inside the database.
create or replace function public.nvi_client_ip()
returns text language plpgsql stable set search_path = '' as $$
declare h json;
begin
  h := nullif(current_setting('request.headers', true), '')::json;
  if h is null then return null; end if;
  return nullif(left(btrim(split_part(coalesce(nullif(h->>'cf-connecting-ip', ''), nullif(h->>'x-real-ip', ''), h->>'x-forwarded-for', ''), ',', 1)), 64), '');
exception when others then
  return null;
end $$;

-- "Online" means the rider's app answered in the last minute. A switch left
-- on in a closed app does not count.
create or replace function public.nvi_rider_fresh(r public.nvi_riders)
returns boolean language sql stable set search_path = '' as $$
  select (r).status = 'Active' and (r).online and (r).last_seen is not null and (r).last_seen > now() - interval '60 seconds'
$$;

-- Riders who could take a job this minute.
create or replace function public.nvi_riders_free()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.nvi_riders r
   where public.nvi_rider_fresh(r)
     and not exists (select 1 from public.nvi_jobs j where j.rider_id = r.id
                      and j.status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning'))
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
    'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare, 'mapbox', c.mapbox_token,
    'riders_online', public.nvi_riders_free(),
    'confirm_first', c.confirm_first, 'return_fee_pct', c.return_fee_pct,
    'max_kg', c.max_kg, 'max_value', c.max_value,
    'support', c.support_phone, 'terms', c.terms_version, 'track_days', c.track_days,
    'turnstile', case when c.turnstile_secret is not null then c.turnstile_site end);
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

-- Did the CAPTCHA pass? True when none is set up. Any doubt is a no.
create or replace function public.nvi_captcha_ok(p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_res extensions.http_response;
begin
  select turnstile_secret into v_secret from public.nvi_config where id;
  if v_secret is null then return true; end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 2100 then return false; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '1500');
  select * into v_res from extensions.http((
    'POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', null,
    'application/x-www-form-urlencoded',
    'secret=' || extensions.urlencode(v_secret::varchar) || '&response=' || extensions.urlencode(p_token::varchar))::extensions.http_request);
  begin perform extensions.http_reset_curlopt(); exception when others then null; end;
  return v_res.status = 200 and coalesce((v_res.content::jsonb->>'success')::boolean, false);
exception when others then
  return false;
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
  v_ip text := public.nvi_client_ip();
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
  if v_ip is not null and not coalesce((select public.is_admin()), false)
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
    -- allowance); past that the estimate is shown and cannot be booked.
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
  insert into public.nvi_quotes (p_lat, p_lng, d_lat, d_lng, distance_m, source, fare, ip)
  values (p_plat, p_plng, p_dlat, p_dlng, v_m, v_src, v_fare, v_ip)
  returning id into v_id;
  delete from public.nvi_quotes where created_at < now() - interval '2 days';
  delete from public.nvi_route_cache where created_at < now() - interval '1 day';
  delete from public.nvi_hits where at < now() - interval '2 days';

  -- 'bookable' is false for an estimate: nvi_book refuses it.
  return jsonb_build_object('ok', true, 'quote', v_id,
    'km', round(v_m / 1000.0, 1), 'fare', v_fare, 'source', v_src, 'bookable', v_src = 'road', 'line', v_line,
    'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare);
end $$;

drop function if exists public.nvi_book(uuid, text, text, text, text, text, text, text, text, text);
drop function if exists public.nvi_book(uuid, text, text, text, text, text, text, text, text, text, boolean, text, text);
create or replace function public.nvi_book(
  p_quote uuid,
  p_pickup_address text, p_drop_address text,
  p_sender_name text, p_sender_phone text,
  p_receiver_name text, p_receiver_phone text,
  p_item text, p_payer text, p_rider_note text default null,
  p_terms boolean default false, p_device text default null, p_captcha text default null,
  p_source text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.nvi_config; q public.nvi_quotes; j public.nvi_jobs;
  v_src text := case when p_source in ('home', 'portal') then p_source else 'direct' end;
  v_admin boolean := coalesce((select public.is_admin()), false);
  v_sp text := public.nvi_pk_phone(p_sender_phone);
  v_rp text := public.nvi_pk_phone(p_receiver_phone);
  v_ip text := public.nvi_client_ip();
  v_dev text := nullif(left(regexp_replace(coalesce(p_device, ''), '[^A-Za-z0-9_-]', '', 'g'), 40), '');
  v_code text; v_first boolean;
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
        'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1), 'payer', j.payer, 'pin', j.delivery_pin, 'status', j.status);
    end if;
  end if;
  if q.id is null or q.created_at < now() - interval '20 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'quote_expired');
  end if;
  -- An estimate was never checked against a road, so the pin may be in the
  -- sea. Only a measured trip becomes a job.
  if q.source <> 'road' then return jsonb_build_object('ok', false, 'reason', 'no_route'); end if;
  if length(btrim(coalesce(p_pickup_address, ''))) < 8 then return jsonb_build_object('ok', false, 'reason', 'pickup_address'); end if;
  if length(btrim(coalesce(p_drop_address, '')))   < 8 then return jsonb_build_object('ok', false, 'reason', 'drop_address'); end if;
  if length(btrim(coalesce(p_sender_name, '')))    < 2 then return jsonb_build_object('ok', false, 'reason', 'sender_name'); end if;
  if length(btrim(coalesce(p_receiver_name, '')))  < 2 then return jsonb_build_object('ok', false, 'reason', 'receiver_name'); end if;
  if v_sp = '' then return jsonb_build_object('ok', false, 'reason', 'sender_phone'); end if;
  if v_rp = '' then return jsonb_build_object('ok', false, 'reason', 'receiver_phone'); end if;
  if length(btrim(coalesce(p_item, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'item'); end if;
  if p_payer is null or p_payer not in ('sender', 'receiver') then return jsonb_build_object('ok', false, 'reason', 'payer'); end if;
  if not coalesce(p_terms, false) then return jsonb_build_object('ok', false, 'reason', 'terms'); end if;
  -- One phone cannot hold a pile of live bookings.
  if (select count(*) from public.nvi_jobs
       where sender_phone = v_sp
         and status in ('Awaiting confirmation', 'Booked', 'Rider assigned', 'Picked up', 'Failed delivery', 'Returning')) >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_open');
  end if;

  -- Does NovaX know this sender? A number with a delivery behind it is
  -- trusted; a new one is phoned first (nvi_config.confirm_first).
  v_first := not v_admin and c.confirm_first
             and not exists (select 1 from public.nvi_jobs where sender_phone = v_sp and status = 'Delivered');
  if not v_admin then
    -- A fake number gets past the per-phone rule, so the address and the
    -- browser are counted too.
    if v_ip is not null and (
         (select count(*) from public.nvi_jobs where ip = v_ip and created_at > now() - interval '1 hour') >= 6
      or (select count(*) from public.nvi_jobs where ip = v_ip and created_at > now() - interval '1 day') >= 20
      or (select count(*) from public.nvi_jobs where ip = v_ip and status = 'Awaiting confirmation') >= 3) then
      return jsonb_build_object('ok', false, 'reason', 'slow_down');
    end if;
    if v_dev is not null and (
         (select count(*) from public.nvi_jobs where device = v_dev and created_at > now() - interval '1 hour') >= 4
      or (select count(*) from public.nvi_jobs where device = v_dev and created_at > now() - interval '1 day') >= 10
      or (select count(*) from public.nvi_jobs where device = v_dev and status = 'Awaiting confirmation') >= 2) then
      return jsonb_build_object('ok', false, 'reason', 'slow_down');
    end if;
    if v_first and (select count(*) from public.nvi_jobs where sender_phone = v_sp and status = 'Awaiting confirmation') >= 1 then
      return jsonb_build_object('ok', false, 'reason', 'awaiting_call');
    end if;
    -- Last, so a form mistake does not use up the one-time CAPTCHA answer.
    if not public.nvi_captcha_ok(p_captcha) then
      return jsonb_build_object('ok', false, 'reason', 'captcha');
    end if;
  end if;

  v_code := 'NI' || nextval('public.nvi_job_seq')::text;
  insert into public.nvi_jobs (code, status, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address,
    sender_name, sender_phone, receiver_name, receiver_phone, item, rider_note, payer,
    distance_m, distance_source, fare, booked_by, ip, device, terms_version, source, confirmed_at)
  values (v_code, case when v_first then 'Awaiting confirmation' else 'Booked' end,
    q.p_lat, q.p_lng, q.d_lat, q.d_lng,
    left(btrim(p_pickup_address), 300), left(btrim(p_drop_address), 300),
    left(btrim(p_sender_name), 80), v_sp, left(btrim(p_receiver_name), 80), v_rp,
    left(btrim(p_item), 160), nullif(left(btrim(coalesce(p_rider_note, '')), 240), ''), p_payer,
    q.distance_m, q.source, q.fare, (select auth.uid()), v_ip, v_dev, c.terms_version, v_src,
    case when v_first then null else now() end)
  returning * into j;
  update public.nvi_quotes set job_id = j.id where id = q.id;

  return jsonb_build_object('ok', true, 'code', j.code, 'token', j.track_token, 'manage', j.manage_token,
    'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1), 'payer', j.payer, 'pin', j.delivery_pin, 'status', j.status);
end $$;

-- What anyone holding the tracking link sees. Phone numbers are not returned.
-- Once a booking has been closed for nvi_config.track_days, the link gives
-- the result and the dates only: no names, no addresses.
create or replace function public.nvi_track(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare j public.nvi_jobs; c public.nvi_config; v_closed timestamptz;
begin
  if p_token is null or length(p_token) < 24 then return jsonb_build_object('ok', false); end if;
  select * into j from public.nvi_jobs where track_token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into c from public.nvi_config where id;
  v_closed := case when j.status in ('Delivered', 'Cancelled', 'Returned') then coalesce(j.delivered_at, j.returned_at, j.cancelled_at) end;
  if v_closed is not null and v_closed < now() - make_interval(days => c.track_days) then
    return jsonb_build_object('ok', true, 'expired', true, 'code', j.code, 'status', j.status,
      'created_at', j.created_at, 'delivered_at', j.delivered_at, 'returned_at', j.returned_at,
      'cancelled_at', j.cancelled_at, 'support', c.support_phone);
  end if;
  return jsonb_build_object('ok', true, 'code', j.code, 'status', j.status,
    'pickup_address', j.pickup_address, 'drop_address', j.drop_address,
    'sender_name', j.sender_name, 'receiver_name', j.receiver_name, 'item', j.item,
    'payer', j.payer, 'fare', j.fare, 'km', round(j.distance_m / 1000.0, 1),
    'pin', case when j.status in ('Delivered', 'Cancelled', 'Returned') then null else j.delivery_pin end,
    'rider', case when j.rider_id is not null and j.status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning') then
      (select jsonb_build_object('name', split_part(r.full_name, ' ', 1), 'phone', r.phone, 'plate', r.bike_plate)
         from public.nvi_riders r where r.id = j.rider_id) end,
    'p', jsonb_build_array(j.p_lat, j.p_lng), 'd', jsonb_build_array(j.d_lat, j.d_lng),
    'created_at', j.created_at, 'assigned_at', j.assigned_at, 'picked_at', j.picked_at,
    'delivered_at', j.delivered_at, 'cancelled_at', j.cancelled_at,
    'failed_at', j.failed_at, 'returning_at', j.returning_at, 'returned_at', j.returned_at,
    'fail_reason', j.fail_reason, 'cancel_reason', j.cancel_reason,
    'return_due', case when j.status = 'Returning' then public.nvi_due_now(j) end,
    'riders_online', case when j.status = 'Booked' then public.nvi_riders_free() end,
    'support', c.support_phone, 'track_days', c.track_days);
end $$;

-- A lost link: the booking number and either phone number on it open the
-- tracking page again. It never gives back the right to cancel.
create or replace function public.nvi_find(p_code text, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := public.nvi_client_ip();
  v_ph text := public.nvi_pk_phone(p_phone);
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  j public.nvi_jobs;
begin
  if (select count(*) from public.nvi_hits where kind = 'find' and ip is not distinct from v_ip and at > now() - interval '10 minutes') >= 6 then
    return jsonb_build_object('ok', false, 'reason', 'slow_down');
  end if;
  insert into public.nvi_hits (kind, ip) values ('find', v_ip);
  if v_code ~ '^[0-9]+$' then v_code := 'NI' || v_code; end if;
  if v_ph = '' or length(v_code) < 6 then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into j from public.nvi_jobs where code = v_code and (sender_phone = v_ph or receiver_phone = v_ph);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'token', j.track_token);
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
  if j.status = 'Cancelled' then return jsonb_build_object('ok', true); end if;
  if j.status not in ('Awaiting confirmation', 'Booked', 'Rider assigned') then
    return jsonb_build_object('ok', false, 'reason', 'too_late', 'status', j.status);
  end if;
  update public.nvi_jobs set status = 'Cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by customer', rider_id = null
   where id = j.id;
  return jsonb_build_object('ok', true);
end $$;


-- ═══════════════════ Shared rules: cash and the PIN ═══════════════════

-- Three short answers from a customer. Nothing is required except one of them.
-- p_token ties the answer to a booking; p_quote ties it to a fare that was shown.
create or replace function public.nvi_feedback(p_use text, p_fair text, p_note text,
  p_source text default null, p_token text default null, p_quote uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := public.nvi_client_ip();
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_use text := case when p_use in ('yes', 'maybe', 'no') then p_use end;
  v_fair text := case when p_fair in ('fair', 'bit_high', 'too_high') then p_fair end;
  v_job uuid; v_fare int; v_m int;
begin
  if v_use is null and v_fair is null and v_note is null then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if (select count(*) from public.nvi_hits where kind = 'feedback' and ip is not distinct from v_ip and at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'slow_down');
  end if;
  insert into public.nvi_hits (kind, ip) values ('feedback', v_ip);
  if coalesce(p_token, '') <> '' then
    select id, fare, distance_m into v_job, v_fare, v_m from public.nvi_jobs where track_token = p_token;
  end if;
  if v_job is null and p_quote is not null then
    select fare, distance_m into v_fare, v_m from public.nvi_quotes where id = p_quote;
  end if;
  insert into public.nvi_feedback (job_id, source, would_use, fare_fair, note, fare, km, ip)
  values (v_job, case when p_source in ('home', 'portal') then p_source else 'direct' end,
          v_use, v_fair, v_note, v_fare, round(v_m / 1000.0, 1), v_ip);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_event(p_job uuid, p_actor text, p_kind text, p_note text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.nvi_job_events (job_id, actor, actor_id, kind, note)
  values (p_job, p_actor, (select auth.uid()), p_kind, nullif(left(btrim(coalesce(p_note, '')), 300), ''))
$$;

-- Cash the rider should be holding out their hand for at this step.
create or replace function public.nvi_due_now(j public.nvi_jobs)
returns int language sql immutable set search_path = '' as $$
  select case (j).status
    when 'Rider assigned'  then case when (j).payer = 'sender'   then (j).fare else 0 end
    when 'Picked up'       then case when (j).payer = 'receiver' then (j).fare else 0 end
    when 'Failed delivery' then case when (j).payer = 'receiver' then (j).fare else 0 end
    -- The parcel came back. A receiver who was to pay did not, so the sender
    -- owes the trip; the return leg is charged on top (nvi_config.return_fee_pct).
    when 'Returning'       then case when (j).payer = 'receiver' then (j).fare else 0 end + (j).return_fee
    else 0 end
$$;

-- Record what was actually received against what was due. Returns null when
-- it is recorded, or the reason it was not (and then nothing was written).
-- Less than the amount due needs a note, and leaves the payment 'Disputed'.
create or replace function public.nvi_settle(p_job uuid, p_rider uuid, p_due int, p_cash int, p_note text, p_kind text, p_by text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_due, 0) <= 0 then return null; end if;
  if p_cash is null then return 'cash_needed'; end if;
  if p_cash < 0 or p_cash > p_due then return 'cash_mismatch'; end if;
  if p_cash < p_due and length(btrim(coalesce(p_note, ''))) < 3 then return 'short_note'; end if;
  if p_cash > 0 then
    insert into public.nvi_cash (job_id, rider_id, amount, kind, noted_by)
    values (p_job, p_rider, p_cash, p_kind, p_by) on conflict (job_id, kind) do nothing;
  end if;
  update public.nvi_jobs
     set pay_state = case when p_cash = p_due then 'Received' else 'Disputed' end,
         pay_note  = case when p_cash < p_due then left('Rs ' || p_cash || ' of Rs ' || p_due || ': ' || btrim(p_note), 300) else pay_note end,
         cash_collected = (select coalesce(sum(amount), 0) from public.nvi_cash where job_id = p_job),
         cash_at = now()
   where id = p_job;
  return null;
end $$;

-- Five wrong tries lock the PIN; ops can then close the step from the board.
-- Returns null when the PIN is right, or the answer to send back.
create or replace function public.nvi_check_pin(j public.nvi_jobs, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if j.pin_tries >= 5 then return jsonb_build_object('ok', false, 'reason', 'pin_locked'); end if;
  if regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g') <> j.delivery_pin then
    update public.nvi_jobs set pin_tries = pin_tries + 1 where id = j.id;
    return jsonb_build_object('ok', false, 'reason', case when j.pin_tries + 1 >= 5 then 'pin_locked' else 'wrong_pin' end,
                              'left', greatest(0, 4 - j.pin_tries));
  end if;
  return null;
end $$;


-- ═══════════════════ Instant riders ═══════════════════
-- Every rider step answers ok when it has already happened, so a press that
-- is sent twice on a weak connection is safe.

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
      jsonb_build_object('id', r.id, 'full_name', r.full_name, 'status', r.status, 'online', r.online,
        'docs', r.docs_at is not null, 'docs_checked', r.docs_checked_at is not null,
        'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone) end);
end $$;

-- The rider's CNIC photo, home bill photo and emergency contact. The two
-- photos must already be in the rider's own folder of nvi-rider-docs.
create or replace function public.nvi_rider_docs(p_cnic text, p_bill text, p_em_name text, p_em_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.nvi_riders; v_uid text := (select auth.uid())::text;
  v_ph text := public.nvi_pk_phone(p_em_phone);
begin
  select * into r from public.nvi_riders where auth_user_id = (select auth.uid()) for update;
  if r.id is null or r.status not in ('Active', 'Blocked') then
    raise exception 'This login is not a Nova Instant rider.' using errcode = '42501';
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

-- Ops ticks the documents as checked (or un-ticks them).
create or replace function public.nvi_admin_check_docs(p_rider uuid, p_ok boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders;
begin
  perform public.nvi_require_admin();
  select * into r from public.nvi_riders where id = p_rider for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.docs_at is null then return jsonb_build_object('ok', false, 'reason', 'no_docs'); end if;
  update public.nvi_riders
     set docs_checked_at = case when coalesce(p_ok, false) then now() end,
         docs_checked_by = case when coalesce(p_ok, false) then (select auth.uid()) end
   where id = r.id;
  return jsonb_build_object('ok', true);
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
      'rider_note', j.rider_note, 'pin_tries', j.pin_tries, 'problem_note', j.problem_note,
      'due_now', public.nvi_due_now(j), 'return_fee', j.return_fee, 'attempts', j.attempts,
      'fail_reason', j.fail_reason, 'fail_note', j.fail_note, 'failed_at', j.failed_at) else '{}'::jsonb end
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
  select * into a from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning');
  return jsonb_build_object(
    'rider', jsonb_build_object('full_name', r.full_name, 'online', r.online),
    'hours_open', public.nvi_hours_open(c), 'open_hour', c.open_hour, 'close_hour', c.close_hour,
    'support', c.support_phone,
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
      'cash_in_hand', (select coalesce(sum(amount), 0) from public.nvi_cash where rider_id = r.id and handover_id is null)),
    -- What this rider closed today, newest first: their own record of the day.
    'recent', coalesce((select jsonb_agg(jsonb_build_object('code', j.code, 'status', j.status, 'to', j.drop_address,
        'fare', j.fare, 'cash', j.cash_collected, 'at', coalesce(j.delivered_at, j.returned_at))
        order by coalesce(j.delivered_at, j.returned_at) desc)
      from public.nvi_jobs j
     where j.rider_id = r.id and j.status in ('Delivered', 'Returned')
       and (coalesce(j.delivered_at, j.returned_at) at time zone 'Asia/Karachi')::date = v_day), '[]'::jsonb));
end $$;

-- A rider holding a parcel stays reachable: they cannot go offline with it.
create or replace function public.nvi_rider_online(p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider();
begin
  if not coalesce(p_on, false)
     and exists (select 1 from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning')) then
    return jsonb_build_object('ok', false, 'reason', 'has_job', 'online', r.online);
  end if;
  if coalesce(p_on, false) and r.docs_at is null then
    return jsonb_build_object('ok', false, 'reason', 'docs', 'online', false);
  end if;
  update public.nvi_riders set online = coalesce(p_on, false), last_seen = now() where id = r.id;
  return jsonb_build_object('ok', true, 'online', coalesce(p_on, false));
end $$;

-- First rider to press Accept gets the job.
create or replace function public.nvi_rider_accept(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if exists (select 1 from public.nvi_jobs where id = p_job and rider_id = r.id and status = 'Rider assigned') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if not r.online then return jsonb_build_object('ok', false, 'reason', 'offline'); end if;
  if exists (select 1 from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning')) then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  update public.nvi_jobs set rider_id = r.id, status = 'Rider assigned', assigned_at = now()
   where id = p_job and status = 'Booked' and rider_id is null
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'taken'); end if;
  update public.nvi_riders set last_seen = now() where id = r.id;
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
  if j.id is null then
    if exists (select 1 from public.nvi_job_events e where e.job_id = p_job and e.kind = 'released'
                and e.actor_id = auth.uid() and e.at > now() - interval '5 minutes') then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  perform public.nvi_event(j.id, 'rider', 'released', r.full_name || ': ' || p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- "I have the parcel". When the sender pays, the rider says how many rupees
-- they were handed; anything but the full fare and the parcel stays put.
drop function if exists public.nvi_rider_picked(uuid);
create or replace function public.nvi_rider_picked(p_job uuid, p_cash int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs; v_due int; v_why text;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status in ('Picked up', 'Failed delivery', 'Returning', 'Returned', 'Delivered') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if j.status <> 'Rider assigned' then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  v_due := public.nvi_due_now(j);
  if v_due > 0 and p_cash is distinct from v_due then
    return jsonb_build_object('ok', false, 'reason', 'cash_needed', 'due', v_due);
  end if;
  v_why := public.nvi_settle(j.id, r.id, v_due, p_cash, null, 'fare', 'rider');
  if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
  update public.nvi_jobs set status = 'Picked up', picked_at = now() where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'picked_up', case when v_due > 0 then 'Rs ' || v_due || ' cash received from the sender' end);
  return jsonb_build_object('ok', true);
end $$;

-- Delivery needs the 4-digit PIN from the receiver's tracking link, and when
-- the receiver pays, the rupees the rider was handed. Less than the fare
-- needs a note and goes to ops as a payment dispute.
drop function if exists public.nvi_rider_delivered(uuid, text);
create or replace function public.nvi_rider_delivered(p_job uuid, p_pin text, p_cash int default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs; v_due int; v_why text; v_bad jsonb;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status = 'Delivered' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status not in ('Picked up', 'Failed delivery') then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  v_due := public.nvi_due_now(j);
  if v_due > 0 and p_cash is null then return jsonb_build_object('ok', false, 'reason', 'cash_needed', 'due', v_due); end if;
  v_bad := public.nvi_check_pin(j, p_pin);
  if v_bad is not null then return v_bad; end if;
  v_why := public.nvi_settle(j.id, r.id, v_due, p_cash, p_note, 'fare', 'rider');
  if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
  update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'delivered',
    case when v_due > 0 then 'Rs ' || p_cash || ' of Rs ' || v_due || ' cash received from the receiver' || coalesce('. ' || nullif(btrim(p_note), ''), '') end);
  return jsonb_build_object('ok', true, 'disputed', v_due > 0 and p_cash < v_due);
end $$;

-- "I cannot finish this": the note goes to the ops board. The job keeps its status.
create or replace function public.nvi_rider_problem(p_job uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  update public.nvi_jobs set problem_note = left(btrim(p_note), 300), problem_at = now()
   where id = p_job and rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning')
  returning * into j;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  perform public.nvi_event(j.id, 'rider', 'problem', p_note);
  return jsonb_build_object('ok', true);
end $$;

-- The delivery could not be made. The rider keeps the parcel; the job shows
-- on the ops board until it is tried again or taken back.
create or replace function public.nvi_rider_failed(p_job uuid, p_reason text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  if p_reason is null or p_reason not in ('receiver_unavailable', 'refused', 'wrong_address', 'damaged', 'payment_refused') then
    return jsonb_build_object('ok', false, 'reason', 'need_reason');
  end if;
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status in ('Failed delivery', 'Returning', 'Returned') then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status <> 'Picked up' then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  update public.nvi_jobs set status = 'Failed delivery', failed_at = now(), fail_reason = p_reason,
         fail_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'failed_delivery', p_reason || coalesce(': ' || nullif(btrim(p_note), ''), ''));
  return jsonb_build_object('ok', true);
end $$;

-- The receiver turned up, or the address was corrected: try the delivery again.
create or replace function public.nvi_rider_retry(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status = 'Picked up' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status <> 'Failed delivery' then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  update public.nvi_jobs set status = 'Picked up', attempts = attempts + 1, pin_tries = 0 where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'retry');
  return jsonb_build_object('ok', true);
end $$;

-- Take the parcel back to the sender. The return charge is fixed here.
create or replace function public.nvi_rider_return(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs; c public.nvi_config;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status in ('Returning', 'Returned') then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status <> 'Failed delivery' then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  select * into c from public.nvi_config where id;
  update public.nvi_jobs set status = 'Returning', returning_at = now(), pin_tries = 0,
         return_fee = round(fare * c.return_fee_pct / 100.0)::int where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'returning');
  return jsonb_build_object('ok', true);
end $$;

-- The parcel is back with the sender, who shows the same PIN from their
-- booking page and pays whatever the return leaves owing.
create or replace function public.nvi_rider_returned(p_job uuid, p_pin text, p_cash int default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); j public.nvi_jobs; v_due int; v_why text; v_bad jsonb;
begin
  select * into j from public.nvi_jobs where id = p_job and rider_id = r.id for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if j.status = 'Returned' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status <> 'Returning' then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  v_due := public.nvi_due_now(j);
  if v_due > 0 and p_cash is null then return jsonb_build_object('ok', false, 'reason', 'cash_needed', 'due', v_due); end if;
  v_bad := public.nvi_check_pin(j, p_pin);
  if v_bad is not null then return v_bad; end if;
  v_why := public.nvi_settle(j.id, r.id, v_due, p_cash, p_note, 'return', 'rider');
  if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
  update public.nvi_jobs set status = 'Returned', returned_at = now() where id = j.id;
  perform public.nvi_event(j.id, 'rider', 'returned',
    case when v_due > 0 then 'Rs ' || p_cash || ' of Rs ' || v_due || ' cash received from the sender' || coalesce('. ' || nullif(btrim(p_note), ''), '') end);
  return jsonb_build_object('ok', true, 'disputed', v_due > 0 and p_cash < v_due);
end $$;

-- ═══════════════════ The ops board ═══════════════════

create or replace function public.nvi_require_admin()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce((select public.is_admin()), false) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
end $$;

create or replace function public.nvi_admin_job_json(j public.nvi_jobs)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(j) - 'track_token' - 'manage_token' - 'booked_by' - 'ip' - 'device'
    || jsonb_build_object('km', round(j.distance_m / 1000.0, 1), 'token', j.track_token,
         'rider_name', (select r.full_name from public.nvi_riders r where r.id = j.rider_id),
         'due_now', public.nvi_due_now(j),
         -- null: no cash taken. true: all of it is with the office.
         'cash_handed', (select bool_and(k.handover_id is not null) from public.nvi_cash k where k.job_id = j.id),
         'same_ip', case when j.status = 'Awaiting confirmation' and j.ip is not null then
           (select count(*) from public.nvi_jobs o where o.ip = j.ip and o.created_at > now() - interval '1 day') end)
$$;

create or replace function public.nvi_admin_board()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform public.nvi_require_admin();
  select * into c from public.nvi_config where id;
  return jsonb_build_object(
    'config', jsonb_build_object('open', c.open, 'hours_open', public.nvi_hours_open(c), 'open_hour', c.open_hour,
                                 'close_hour', c.close_hour, 'rate_per_km', c.rate_per_km, 'min_fare', c.min_fare,
                                 'confirm_first', c.confirm_first, 'return_fee_pct', c.return_fee_pct,
                                 'captcha', c.turnstile_secret is not null, 'riders_free', public.nvi_riders_free()),
    'live', coalesce((select jsonb_agg(public.nvi_admin_job_json(j) order by j.created_at)
                        from public.nvi_jobs j
                       where j.status in ('Awaiting confirmation', 'Booked', 'Rider assigned', 'Picked up', 'Failed delivery', 'Returning')), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(public.nvi_admin_job_json(j) order by (j.pay_state = 'Disputed') desc, coalesce(j.delivered_at, j.returned_at, j.cancelled_at) desc)
                          from public.nvi_jobs j
                         where j.id in (select id from public.nvi_jobs where status in ('Delivered', 'Returned', 'Cancelled')
                                         order by (pay_state = 'Disputed') desc, coalesce(delivered_at, returned_at, cancelled_at) desc limit 60)), '[]'::jsonb),
    'riders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'full_name', r.full_name, 'email', r.email, 'phone', r.phone, 'bike_plate', r.bike_plate,
        'status', r.status, 'online', public.nvi_rider_fresh(r),
        -- The switch is on but the app has stopped answering.
        'stale', r.status = 'Active' and r.online and not public.nvi_rider_fresh(r),
        'last_seen', r.last_seen, 'joined_at', r.joined_at,
        'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone,
        'cnic_path', r.cnic_path, 'bill_path', r.bill_path, 'docs_at', r.docs_at, 'docs_checked_at', r.docs_checked_at,
        'active_code', (select j.code from public.nvi_jobs j where j.rider_id = r.id and j.status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning')),
        'done_today', (select count(*) from public.nvi_jobs j where j.rider_id = r.id and j.status = 'Delivered'
                        and (j.delivered_at at time zone 'Asia/Karachi')::date = v_day),
        'cash_in_hand', (select coalesce(sum(k.amount), 0) from public.nvi_cash k where k.rider_id = r.id and k.handover_id is null))
        order by (r.status = 'Active') desc, public.nvi_rider_fresh(r) desc, r.full_name)
      from public.nvi_riders r where r.status <> 'Removed'), '[]'::jsonb),
    'today', jsonb_build_object(
      'booked', (select count(*) from public.nvi_jobs where (created_at at time zone 'Asia/Karachi')::date = v_day),
      'delivered', (select count(*) from public.nvi_jobs where status = 'Delivered' and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'returned', (select count(*) from public.nvi_jobs where status = 'Returned' and (returned_at at time zone 'Asia/Karachi')::date = v_day),
      'cancelled', (select count(*) from public.nvi_jobs where status = 'Cancelled' and (cancelled_at at time zone 'Asia/Karachi')::date = v_day),
      'fares', (select coalesce(sum(fare), 0) from public.nvi_jobs where status = 'Delivered' and (delivered_at at time zone 'Asia/Karachi')::date = v_day),
      'disputed', (select count(*) from public.nvi_jobs where pay_state = 'Disputed'),
      'cash_out', (select coalesce(sum(amount), 0) from public.nvi_cash where handover_id is null),
      'from_home', (select count(*) from public.nvi_jobs where source = 'home' and (created_at at time zone 'Asia/Karachi')::date = v_day),
      'from_portal', (select count(*) from public.nvi_jobs where source = 'portal' and (created_at at time zone 'Asia/Karachi')::date = v_day)),
    'feedback', coalesce((select jsonb_agg(jsonb_build_object('at', f.at, 'source', f.source, 'would_use', f.would_use,
        'fare_fair', f.fare_fair, 'note', f.note, 'fare', f.fare, 'km', f.km,
        'code', (select j.code from public.nvi_jobs j where j.id = f.job_id)) order by f.at desc)
      from (select * from public.nvi_feedback order by at desc limit 40) f), '[]'::jsonb));
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

-- NovaX phoned the first-time sender and the booking is real: riders can see it.
create or replace function public.nvi_admin_confirm(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  perform public.nvi_require_admin();
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.status = 'Booked' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.status <> 'Awaiting confirmation' then return jsonb_build_object('ok', false, 'reason', 'wrong_step', 'status', j.status); end if;
  update public.nvi_jobs set status = 'Booked', confirmed_at = now(), confirmed_by = (select auth.uid()) where id = j.id;
  perform public.nvi_event(j.id, 'admin', 'confirmed');
  return jsonb_build_object('ok', true);
end $$;

-- Assign, reassign, or (with no rider) put a job back in the open list. Once
-- the parcel is on a bike it can only move to another rider, with a note:
-- the first rider hands it over in person and keeps any cash they took.
drop function if exists public.nvi_admin_assign(uuid, uuid);
create or replace function public.nvi_admin_assign(p_job uuid, p_rider uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs; r public.nvi_riders; v_carrying boolean;
begin
  perform public.nvi_require_admin();
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_carrying := j.status in ('Picked up', 'Failed delivery', 'Returning');
  if j.status not in ('Booked', 'Rider assigned') and not v_carrying then
    return jsonb_build_object('ok', false, 'reason', case when j.status = 'Awaiting confirmation' then 'unconfirmed' else 'closed' end, 'status', j.status);
  end if;
  if p_rider is null then
    if v_carrying then return jsonb_build_object('ok', false, 'reason', 'has_parcel', 'status', j.status); end if;
    update public.nvi_jobs set rider_id = null, status = 'Booked', assigned_at = null where id = j.id;
    perform public.nvi_event(j.id, 'admin', 'unassigned');
    return jsonb_build_object('ok', true);
  end if;
  if v_carrying and length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  if p_rider = j.rider_id then return jsonb_build_object('ok', true, 'already', true); end if;
  select * into r from public.nvi_riders where id = p_rider;
  if r.id is null or r.status <> 'Active' then return jsonb_build_object('ok', false, 'reason', 'rider_inactive'); end if;
  if exists (select 1 from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning') and id <> j.id) then
    return jsonb_build_object('ok', false, 'reason', 'rider_busy');
  end if;
  if v_carrying then
    update public.nvi_jobs set rider_id = r.id where id = j.id;
    perform public.nvi_event(j.id, 'admin', 'transferred', r.full_name || ': ' || p_note);
  else
    update public.nvi_jobs set rider_id = r.id, status = 'Rider assigned', assigned_at = now() where id = j.id;
    perform public.nvi_event(j.id, 'admin', 'assigned', r.full_name);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Cancelling is for a job no rider has collected. A parcel on a bike cannot
-- be cancelled out from under the rider: it is delivered, or marked a failed
-- delivery and taken back.
create or replace function public.nvi_admin_cancel(p_job uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_reason, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_reason'); end if;
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.status in ('Delivered', 'Returned', 'Cancelled') then return jsonb_build_object('ok', false, 'reason', 'closed', 'status', j.status); end if;
  if j.status in ('Picked up', 'Failed delivery', 'Returning') then return jsonb_build_object('ok', false, 'reason', 'has_parcel', 'status', j.status); end if;
  update public.nvi_jobs set status = 'Cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_reason), 200) where id = j.id;
  perform public.nvi_event(j.id, 'admin', 'cancelled', p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- Ops closes a step by hand: the rider's phone died, or the PIN is locked.
-- Where cash was due at that step, ops says how much the rider has (p_cash);
-- less than the amount due leaves the payment 'Disputed'.
drop function if exists public.nvi_admin_mark(uuid, text, text);
create or replace function public.nvi_admin_mark(p_job uuid, p_status text, p_note text, p_cash int default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs; c public.nvi_config; v_due int; v_why text;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.rider_id is null then return jsonb_build_object('ok', false, 'reason', 'no_rider'); end if;
  if j.status = p_status then return jsonb_build_object('ok', true, 'already', true); end if;
  v_due := public.nvi_due_now(j);
  if p_status = 'Picked up' and j.status = 'Rider assigned' then
    v_why := public.nvi_settle(j.id, j.rider_id, v_due, p_cash, p_note, 'fare', 'admin');
    if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
    update public.nvi_jobs set status = 'Picked up', picked_at = now() where id = j.id;
  elsif p_status = 'Picked up' and j.status = 'Failed delivery' then
    update public.nvi_jobs set status = 'Picked up', attempts = attempts + 1, pin_tries = 0 where id = j.id;
  elsif p_status = 'Delivered' and j.status in ('Picked up', 'Failed delivery') then
    v_why := public.nvi_settle(j.id, j.rider_id, v_due, p_cash, p_note, 'fare', 'admin');
    if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
    update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = j.id;
  elsif p_status = 'Failed delivery' and j.status = 'Picked up' then
    if p_reason is null or p_reason not in ('receiver_unavailable', 'refused', 'wrong_address', 'damaged', 'payment_refused') then
      return jsonb_build_object('ok', false, 'reason', 'need_reason');
    end if;
    update public.nvi_jobs set status = 'Failed delivery', failed_at = now(), fail_reason = p_reason, fail_note = left(btrim(p_note), 300) where id = j.id;
  elsif p_status = 'Returning' and j.status = 'Failed delivery' then
    select * into c from public.nvi_config where id;
    update public.nvi_jobs set status = 'Returning', returning_at = now(), pin_tries = 0,
           return_fee = round(fare * c.return_fee_pct / 100.0)::int where id = j.id;
  elsif p_status = 'Returned' and j.status = 'Returning' then
    v_why := public.nvi_settle(j.id, j.rider_id, v_due, p_cash, p_note, 'return', 'admin');
    if v_why is not null then return jsonb_build_object('ok', false, 'reason', v_why, 'due', v_due); end if;
    update public.nvi_jobs set status = 'Returned', returned_at = now() where id = j.id;
  else
    return jsonb_build_object('ok', false, 'reason', 'wrong_step', 'status', j.status);
  end if;
  perform public.nvi_event(j.id, 'admin', 'marked ' || p_status,
    coalesce(p_reason || ': ', '') || p_note || case when v_due > 0 and p_status in ('Picked up', 'Delivered', 'Returned') and p_cash is not null
      then ' (Rs ' || p_cash || ' of Rs ' || v_due || ' cash)' else '' end);
  return jsonb_build_object('ok', true);
end $$;

-- Settle a payment dispute. 'received': p_amount is the total cash received
-- for this job, counting any part already handed to the office. 'writeoff':
-- NovaX accepts the shortfall.
create or replace function public.nvi_admin_pay(p_job uuid, p_action text, p_amount int, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.nvi_jobs; v_kind text; v_in int; v_slot text;
begin
  perform public.nvi_require_admin();
  if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  select * into j from public.nvi_jobs where id = p_job for update;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.pay_state <> 'Disputed' then return jsonb_build_object('ok', false, 'reason', 'not_disputed'); end if;
  if p_action = 'writeoff' then
    update public.nvi_jobs set pay_state = 'Written off', pay_note = left(coalesce(pay_note || ' | ', '') || 'Written off: ' || btrim(p_note), 300) where id = j.id;
  elsif p_action = 'received' then
    if p_amount is null or p_amount < 0 or p_amount > j.fare * 3 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
    if j.rider_id is null then return jsonb_build_object('ok', false, 'reason', 'no_rider'); end if;
    v_kind := case when j.status = 'Returned' then 'return' else 'fare' end;
    -- Cash already at the office is fixed; only what the rider still holds moves.
    select coalesce(sum(amount), 0) into v_in from public.nvi_cash where job_id = j.id and kind in (v_kind, 'topup') and handover_id is not null;
    if p_amount < v_in then return jsonb_build_object('ok', false, 'reason', 'handed_over', 'handed', v_in); end if;
    delete from public.nvi_cash where job_id = j.id and kind in (v_kind, 'topup') and handover_id is null;
    if p_amount > v_in then
      v_slot := case when not exists (select 1 from public.nvi_cash where job_id = j.id and kind = v_kind) then v_kind
                     when not exists (select 1 from public.nvi_cash where job_id = j.id and kind = 'topup') then 'topup' end;
      if v_slot is null then return jsonb_build_object('ok', false, 'reason', 'handed_over', 'handed', v_in); end if;
      insert into public.nvi_cash (job_id, rider_id, amount, kind, noted_by) values (j.id, j.rider_id, p_amount - v_in, v_slot, 'admin');
    end if;
    update public.nvi_jobs set pay_state = 'Received',
           pay_note = left(coalesce(pay_note || ' | ', '') || 'Settled at Rs ' || p_amount || ': ' || btrim(p_note), 300),
           cash_collected = (select coalesce(sum(amount), 0) from public.nvi_cash where job_id = j.id), cash_at = now()
     where id = j.id;
  else
    return jsonb_build_object('ok', false, 'reason', 'action');
  end if;
  perform public.nvi_event(j.id, 'admin', 'payment ' || p_action, p_note);
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

-- A rider with a job cannot be blocked or removed: move the job to another
-- rider or let it finish first. A rider holding cash cannot be removed until
-- the cash is in.
create or replace function public.nvi_admin_set_rider(p_rider uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders; v_code text;
begin
  perform public.nvi_require_admin();
  if p_status not in ('Active', 'Blocked', 'Removed') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  select * into r from public.nvi_riders where id = p_rider for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_status <> 'Active' then
    select code into v_code from public.nvi_jobs where rider_id = r.id and status in ('Rider assigned', 'Picked up', 'Failed delivery', 'Returning');
    if v_code is not null then return jsonb_build_object('ok', false, 'reason', 'rider_has_job', 'code', v_code); end if;
  end if;
  if p_status = 'Removed' and exists (select 1 from public.nvi_cash where rider_id = r.id and handover_id is null) then
    return jsonb_build_object('ok', false, 'reason', 'rider_has_cash');
  end if;
  update public.nvi_riders
     set status = case when p_status = 'Active' and auth_user_id is null then 'Invited' else p_status end,
         online = case when p_status = 'Active' then online else false end
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- The office took the rider's cash: every receipt they hold is marked handed
-- over. One press is one handover. The rider's row is locked so two presses
-- queue, the page's key makes a repeat return the first answer, and the
-- receipts are locked and counted before and after.
drop function if exists public.nvi_admin_handover(uuid);
create or replace function public.nvi_admin_handover(p_rider uuid, p_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare h public.nvi_handovers; v_ids bigint[]; v_amount int; v_jobs int; v_n int;
begin
  perform public.nvi_require_admin();
  if p_key is null then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  perform 1 from public.nvi_riders where id = p_rider for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into h from public.nvi_handovers where idem_key = p_key;
  if found then
    return jsonb_build_object('ok', true, 'amount', h.amount, 'jobs', h.jobs, 'already', true);
  end if;
  select array_agg(s.id), coalesce(sum(s.amount), 0)::int, count(distinct s.job_id)::int into v_ids, v_amount, v_jobs
    from (select id, amount, job_id from public.nvi_cash where rider_id = p_rider and handover_id is null for update) s;
  if v_ids is null then return jsonb_build_object('ok', false, 'reason', 'nothing'); end if;
  insert into public.nvi_handovers (rider_id, amount, jobs, confirmed_by, idem_key)
  values (p_rider, v_amount, v_jobs, (select auth.uid()), p_key) returning * into h;
  update public.nvi_cash set handover_id = h.id where id = any(v_ids) and handover_id is null;
  get diagnostics v_n = row_count;
  if v_n <> array_length(v_ids, 1) then
    raise exception 'Handover changed % receipts, expected %.', v_n, array_length(v_ids, 1);
  end if;
  return jsonb_build_object('ok', true, 'amount', v_amount, 'jobs', v_jobs);
end $$;

-- The launch switch: when off, the public sees fares but cannot book. It
-- only turns on while a rider is online to take the first job.
create or replace function public.nvi_admin_set_open(p_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.nvi_require_admin();
  if coalesce(p_open, false) and public.nvi_riders_free() = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_rider_online');
  end if;
  update public.nvi_config set open = coalesce(p_open, false), updated_at = now() where id;
  return jsonb_build_object('ok', true, 'open', coalesce(p_open, false));
end $$;


-- ═══════════════════ Live screens ═══════════════════
-- Every change to a job, and a rider going on or off, sends one small signal
-- on the public Realtime channel "nvi". It carries no data: a screen that
-- hears it asks for its own data again through the usual functions. A rider's
-- "still here" beat (last_seen) does not send one, or every screen would
-- answer every other screen for ever.
create or replace function public.nvi_ping()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(jsonb_build_object('at', (extract(epoch from clock_timestamp()) * 1000)::bigint), 'changed', 'nvi', false);
  exception when others then null;   -- a signal that fails must never fail the booking
  end;
  return null;
end $$;
drop trigger if exists nvi_jobs_ping on public.nvi_jobs;
create trigger nvi_jobs_ping after insert or update or delete on public.nvi_jobs
  for each statement execute function public.nvi_ping();
drop trigger if exists nvi_riders_ping on public.nvi_riders;
create trigger nvi_riders_ping after insert or delete or update of status, online, docs_at, docs_checked_at on public.nvi_riders
  for each statement execute function public.nvi_ping();

-- ═══════════════════ Who may call what ═══════════════════
do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'nvi\_%'
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- Public on purpose: Nova Instant is booked without an account.
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_status', 'nvi_quote', 'nvi_book', 'nvi_track', 'nvi_find', 'nvi_cancel', 'nvi_feedback')
  loop
    execute 'grant execute on function ' || f || ' to anon, authenticated';
  end loop;
  -- Signed-in users only; each function checks who is calling.
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_rider_me', 'nvi_rider_feed', 'nvi_rider_online', 'nvi_rider_accept', 'nvi_rider_release',
                         'nvi_rider_picked', 'nvi_rider_delivered', 'nvi_rider_problem', 'nvi_rider_failed',
                         'nvi_rider_retry', 'nvi_rider_return', 'nvi_rider_returned',
                         'nvi_admin_board', 'nvi_admin_job', 'nvi_admin_confirm', 'nvi_admin_assign', 'nvi_admin_cancel',
                         'nvi_admin_mark', 'nvi_admin_pay', 'nvi_admin_invite_rider', 'nvi_admin_set_rider',
                         'nvi_admin_handover', 'nvi_admin_set_open',
                         'nvi_rider_docs', 'nvi_admin_check_docs', 'nvi_is_rider')
  loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

notify pgrst, 'reload schema';
