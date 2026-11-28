-- 28 Nov 2026: App health measurements for the NovaX app and portal.
--
-- nv-track.js (index.html + client.html) sends small batches of events:
--   screen, screen_bounce (left a screen within 3 s), rage_tap (3 quick taps
--   on one spot), booking_open / booking_done (with the time it took),
--   login_ok / login_fail, cnic_ok / cnic_fail, push_open, ready (time until
--   the portal had its data), js_error.
-- No names, phones, addresses or IPs are stored: a random per-tab session id,
-- the merchant id when signed in, the platform and the event.
-- admin_app_health(days) turns them into the admin "App health" tab, with
-- push delivery from nv_push_queue.
-- Safe to run again.

create table if not exists public.nv_app_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  session    text not null check (length(session) between 8 and 40),
  client_id  uuid,
  platform   text not null check (platform in ('android','ios','web')),
  source     text not null check (source in ('app','web')),
  name       text not null,
  screen     text,
  ms         int,
  meta       jsonb
);
create index if not exists nv_app_events_at_idx on public.nv_app_events (at);
create index if not exists nv_app_events_session_idx on public.nv_app_events (session, at);
alter table public.nv_app_events enable row level security;
alter table public.nv_app_events force row level security;
revoke all on public.nv_app_events from public, anon, authenticated;

create or replace function public.nv_app_track(p_session text, p_platform text, p_source text, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid; e jsonb; n int := 0; v_name text; v_meta jsonb;
  v_ok text[] := array['screen','screen_bounce','rage_tap','booking_open','booking_done','login_ok','login_fail',
                       'cnic_ok','cnic_fail','push_open','ready','js_error','app_start'];
begin
  if p_session is null or length(p_session) not between 8 and 40 or p_session !~ '^[A-Za-z0-9_-]+$' then return jsonb_build_object('ok', false); end if;
  if p_platform not in ('android','ios','web') or p_source not in ('app','web') then return jsonb_build_object('ok', false); end if;
  if jsonb_typeof(p_events) <> 'array' then return jsonb_build_object('ok', false); end if;
  -- One tab cannot flood the table.
  if (select count(*) from public.nv_app_events where session = p_session and at > now() - interval '1 day') > 600 then
    return jsonb_build_object('ok', true, 'kept', 0);
  end if;
  if auth.uid() is not null then
    begin v_client := public.my_client_id(); exception when others then v_client := null; end;
  end if;
  for e in select * from jsonb_array_elements(p_events) limit 30 loop
    v_name := e->>'n';
    if v_name is null or not (v_name = any(v_ok)) then continue; end if;
    v_meta := case when jsonb_typeof(e->'m') = 'object' and length((e->'m')::text) <= 600 then e->'m' end;
    insert into public.nv_app_events (session, client_id, platform, source, name, screen, ms, meta)
    values (p_session, v_client, p_platform, p_source, v_name,
            left(nullif(e->>'s', ''), 60),
            case when (e->>'ms') ~ '^[0-9]{1,9}$' then least((e->>'ms')::int, 3600000) end,
            v_meta);
    n := n + 1;
  end loop;
  if random() < 0.01 then delete from public.nv_app_events where at < now() - interval '120 days'; end if;
  return jsonb_build_object('ok', true, 'kept', n);
end $$;
revoke all on function public.nv_app_track(text, text, text, jsonb) from public;
grant execute on function public.nv_app_track(text, text, text, jsonb) to anon, authenticated;

create or replace function public.admin_app_health(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := ((now() at time zone 'Asia/Karachi')::date - greatest(0, least(coalesce(p_days, 7), 90) - 1))::timestamp at time zone 'Asia/Karachi';
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  return (
  with ev as (select * from public.nv_app_events where at >= v_from),
  bk as (
    select session,
           bool_or(name = 'booking_open') as opened,
           bool_or(name = 'booking_done') as done
      from ev where name in ('booking_open','booking_done') group by session
  ),
  pq as (select state, count(*) c from public.nv_push_queue where created_at >= v_from group by state)
  select jsonb_build_object(
    'from', v_from,
    'totals', jsonb_build_object(
      'sessions',        (select count(distinct session) from ev),
      'appSessions',     (select count(distinct session) from ev where source = 'app'),
      'android',         (select count(distinct session) from ev where platform = 'android'),
      'ios',             (select count(distinct session) from ev where platform = 'ios'),
      'merchants',       (select count(distinct client_id) from ev where client_id is not null),
      'bookOpened',      (select count(*) from bk where opened),
      'bookDone',        (select count(*) from bk where opened and done),
      'bookings',        (select count(*) from ev where name = 'booking_done'),
      'bookMedianMs',    (select percentile_cont(0.5) within group (order by ms) from ev where name = 'booking_done' and ms > 0),
      'loginOk',         (select count(*) from ev where name = 'login_ok'),
      'loginFail',       (select count(*) from ev where name = 'login_fail'),
      'cnicOk',          (select count(*) from ev where name = 'cnic_ok'),
      'cnicFail',        (select count(*) from ev where name = 'cnic_fail'),
      'cnicMedianMs',    (select percentile_cont(0.5) within group (order by ms) from ev where name = 'cnic_ok' and ms > 0),
      'readyMedianMs',   (select percentile_cont(0.5) within group (order by ms) from ev where name = 'ready' and ms > 0),
      'readyAppMedianMs',(select percentile_cont(0.5) within group (order by ms) from ev where name = 'ready' and ms > 0 and source = 'app'),
      'jsErrors',        (select count(*) from ev where name = 'js_error'),
      'jsErrorSessions', (select count(distinct session) from ev where name = 'js_error'),
      'rageTaps',        (select count(*) from ev where name = 'rage_tap'),
      'pushQueued',      (select coalesce(sum(c), 0) from pq),
      'pushSent',        (select coalesce(sum(c), 0) from pq where state = 'sent'),
      'pushFailed',      (select coalesce(sum(c), 0) from pq where state = 'failed'),
      'pushSkipped',     (select coalesce(sum(c), 0) from pq where state = 'skipped'),
      'pushPending',     (select coalesce(sum(c), 0) from pq where state = 'pending'),
      'pushOpened',      (select count(*) from ev where name = 'push_open'),
      'pushPhones',      (select count(*) from public.nv_push_devices)
    ),
    'screens', coalesce((select jsonb_agg(x order by x->>'views' desc) from (
        select jsonb_build_object('screen', screen,
                 'views', count(*) filter (where name = 'screen'),
                 'bounces', count(*) filter (where name = 'screen_bounce'),
                 'rage', count(*) filter (where name = 'rage_tap'),
                 'errors', count(*) filter (where name = 'js_error')) x
          from ev where screen is not null and name in ('screen','screen_bounce','rage_tap','js_error')
         group by screen order by count(*) filter (where name = 'screen') desc limit 30) s), '[]'::jsonb),
    'rage', coalesce((select jsonb_agg(jsonb_build_object('screen', screen, 'what', what, 'n', n)) from (
        select screen, meta->>'el' what, count(*) n from ev where name = 'rage_tap'
         group by 1, 2 order by 3 desc limit 15) r), '[]'::jsonb),
    'loginWhy', coalesce((select jsonb_agg(jsonb_build_object('why', why, 'n', n)) from (
        select coalesce(meta->>'why', 'unknown') why, count(*) n from ev where name = 'login_fail'
         group by 1 order by 2 desc limit 10) r), '[]'::jsonb),
    'cnicWhy', coalesce((select jsonb_agg(jsonb_build_object('why', why, 'n', n)) from (
        select coalesce(meta->>'why', 'unknown') why, count(*) n from ev where name = 'cnic_fail'
         group by 1 order by 2 desc limit 10) r), '[]'::jsonb),
    'jsWhy', coalesce((select jsonb_agg(jsonb_build_object('why', why, 'n', n, 'platform', pf)) from (
        select coalesce(meta->>'why', 'unknown') why, string_agg(distinct platform, ', ') pf, count(*) n from ev where name = 'js_error'
         group by 1 order by 3 desc limit 10) r), '[]'::jsonb),
    'pushFailWhy', coalesce((select jsonb_agg(jsonb_build_object('why', why, 'n', n)) from (
        select coalesce(error, 'unknown') why, count(*) n from public.nv_push_queue
         where created_at >= v_from and state in ('failed','skipped') group by 1 order by 2 desc limit 8) r), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(d order by d->>'day') from (
        select jsonb_build_object('day', (at at time zone 'Asia/Karachi')::date,
                 'sessions', count(distinct session),
                 'bookings', count(*) filter (where name = 'booking_done'),
                 'loginFail', count(*) filter (where name = 'login_fail'),
                 'cnicFail', count(*) filter (where name = 'cnic_fail'),
                 'jsErrors', count(*) filter (where name = 'js_error')) d
          from ev group by (at at time zone 'Asia/Karachi')::date) q), '[]'::jsonb)
  ));
end $$;
revoke all on function public.admin_app_health(int) from public, anon;
grant execute on function public.admin_app_health(int) to authenticated;
