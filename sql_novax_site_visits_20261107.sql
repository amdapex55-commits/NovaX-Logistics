-- 7 Nov 2026: homepage visitor log for the ad campaigns. One row per visit
-- (a browser tab), no name, no IP: where they came from (utm / Facebook /
-- Google click ids, referrer), device, city from Cloudflare when present,
-- how far they scrolled, which sections they saw, what they tapped (in
-- order), and the signup steps they reached. If they open an account, the
-- visit id rides in the signup metadata, so the admin report can name the
-- business. Admin -> Website visitors reads it through admin_site_report.
begin;

create table if not exists public.nv_site_visits (
  visit_id    text primary key check (char_length(visit_id) between 8 and 64),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  landing     text not null default '',
  source      text not null default '',
  medium      text not null default '',
  campaign    text not null default '',
  content     text not null default '',
  ad_click    text not null default '',      -- 'facebook' (fbclid) / 'google' (gclid) / ''
  ref_host    text not null default '',
  device      text not null default '',
  os          text not null default '',
  app         text not null default '',      -- in-app browser: Facebook / Instagram / ...
  screen_w    integer,
  country     text not null default '',
  city        text not null default '',
  scroll_pct  integer not null default 0,
  secs        integer not null default 0,
  seen        text[] not null default '{}',
  taps        jsonb not null default '{}'::jsonb,
  tap_path    text[] not null default '{}',
  events      text[] not null default '{}',
  updates     integer not null default 0
);
create index if not exists nv_site_visits_first_idx on public.nv_site_visits (first_seen desc);
alter table public.nv_site_visits enable row level security;
revoke all on public.nv_site_visits from anon, authenticated;

create or replace function public.site_visit(p_visit text, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v text := btrim(coalesce(p_visit, '')); d jsonb := coalesce(p_data, '{}'::jsonb); h json; k text;
  t text := lower(coalesce(d->>'ua', ''));
begin
  if char_length(v) < 8 or char_length(v) > 64 or pg_column_size(d) > 12000 then return; end if;
  if t ~ '(bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|preview)' then return; end if;
  if not exists (select 1 from public.nv_site_visits where visit_id = v) then
    k := public.nv_client_net_key('site');
    if k <> '' and not public.nv_track_rate_ok(k, 120, interval '1 hour') then return; end if;
    begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
    insert into public.nv_site_visits (visit_id, landing, source, medium, campaign, content, ad_click, ref_host, device, os, app, screen_w, country, city)
    values (v, left(coalesce(d->>'landing',''),200), left(coalesce(d->>'source',''),60), left(coalesce(d->>'medium',''),60),
            left(coalesce(d->>'campaign',''),120), left(coalesce(d->>'content',''),120), left(coalesce(d->>'adClick',''),20),
            left(coalesce(d->>'refHost',''),100), left(coalesce(d->>'device',''),20), left(coalesce(d->>'os',''),20), left(coalesce(d->>'app',''),30),
            case when (d->>'sw') ~ '^[0-9]{2,5}$' then (d->>'sw')::int end,
            left(coalesce(h->>'cf-ipcountry',''),8), left(coalesce(h->>'cf-ipcity',''),60))
    on conflict (visit_id) do nothing;
  end if;
  update public.nv_site_visits s set
    last_seen  = now(),
    scroll_pct = greatest(s.scroll_pct, least(100, coalesce(case when (d->>'scroll') ~ '^[0-9]{1,3}$' then (d->>'scroll')::int end, 0))),
    secs       = greatest(s.secs, least(86400, coalesce(case when (d->>'secs') ~ '^[0-9]{1,6}$' then (d->>'secs')::int end, 0))),
    seen       = case when jsonb_typeof(d->'seen') = 'array' then (select coalesce(array_agg(distinct left(x,40)), '{}') from (select unnest(s.seen) x union select jsonb_array_elements_text(d->'seen') limit 40) u) else s.seen end,
    taps       = case when jsonb_typeof(d->'taps') = 'object' then d->'taps' else s.taps end,
    tap_path   = case when jsonb_typeof(d->'path') = 'array' then (select coalesce(array_agg(left(x,80)), '{}') from (select jsonb_array_elements_text(d->'path') x limit 40) u) else s.tap_path end,
    events     = case when jsonb_typeof(d->'events') = 'array' then (select coalesce(array_agg(distinct left(x,40)), '{}') from (select unnest(s.events) x union select jsonb_array_elements_text(d->'events') limit 20) u) else s.events end,
    updates    = s.updates + 1
  where s.visit_id = v and s.updates < 200 and s.first_seen > now() - interval '12 hours';
end $$;
revoke all on function public.site_visit(text, jsonb) from public;
grant execute on function public.site_visit(text, jsonb) to anon, authenticated;

create or replace function public.admin_site_report(p_days integer default 1, p_only text default 'all')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := ((now() at time zone 'Asia/Karachi')::date - greatest(0, least(p_days, 60) - 1))::timestamp at time zone 'Asia/Karachi';
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  return (
  with v as (
    select s.*, (s.ad_click <> '' or s.medium ~* '(cpc|paid|ads?|cpm)' or s.source ~* '(fb|facebook|ig|instagram|meta|google|tiktok)_?ads?') as is_ad,
           (s.secs < 10 and s.taps = '{}'::jsonb) as bounced,
           (select c.name from auth.users u join public.profiles p on p.id = u.id join public.clients c on c.id = p.client_id
             where u.raw_user_meta_data->>'nv_visit' = s.visit_id limit 1) as signed_up_as
      from public.nv_site_visits s
     where s.first_seen >= v_from
  ), f as (select * from v where p_only = 'all' or (p_only = 'ads' and is_ad) or (p_only = 'other' and not is_ad))
  select jsonb_build_object(
    'from', v_from,
    'totals', (select jsonb_build_object('visits', count(*), 'ads', count(*) filter (where is_ad), 'mobile', count(*) filter (where device = 'mobile'),
                 'medianSecs', coalesce(percentile_cont(0.5) within group (order by secs), 0), 'bounced', count(*) filter (where bounced),
                 'openedSignup', count(*) filter (where 'open_signup' = any(events)), 'submittedSignup', count(*) filter (where 'signup_submit' = any(events)),
                 'signedUp', count(*) filter (where 'signup_done' = any(events) or signed_up_as is not null),
                 'whatsapp', count(*) filter (where 'whatsapp' = any(events)), 'demo', count(*) filter (where 'demo' = any(events))) from f),
    'sources', coalesce((select jsonb_agg(x order by (x->>'visits')::int desc) from (
        select jsonb_build_object('source', src, 'campaign', campaign, 'ad', bool_or(is_ad), 'visits', count(*),
          'medianSecs', coalesce(percentile_cont(0.5) within group (order by secs), 0),
          'bounced', count(*) filter (where bounced), 'openedSignup', count(*) filter (where 'open_signup' = any(events)),
          'signedUp', count(*) filter (where 'signup_done' = any(events) or signed_up_as is not null)) x
        from (select f.*, case when source <> '' then source when ad_click <> '' then ad_click || ' ad' when ref_host <> '' then ref_host else 'direct' end as src from f) g
        group by src, campaign) z), '[]'::jsonb),
    'sections', coalesce((select jsonb_object_agg(sec, n) from (select unnest(seen) sec, count(*) n from f group by 1) z), '{}'::jsonb),
    'taps', coalesce((select jsonb_object_agg(key, jsonb_build_object('taps', taps, 'people', people)) from (
        select e.key, sum((e.value)::int) taps, count(*) people from f, jsonb_each_text(f.taps) e group by e.key) z), '{}'::jsonb),
    'devices', coalesce((select jsonb_object_agg(k, n) from (select coalesce(nullif(app,''), nullif(os,''), 'other') || ' · ' || coalesce(nullif(device,''),'?') k, count(*) n from f group by 1) z), '{}'::jsonb),
    'cities', coalesce((select jsonb_object_agg(k, n) from (select coalesce(nullif(city,''), nullif(country,''), 'unknown') k, count(*) n from f group by 1) z), '{}'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('at', first_seen, 'source', case when source <> '' then source when ad_click <> '' then ad_click || ' ad' when ref_host <> '' then ref_host else 'direct' end,
        'campaign', campaign, 'ad', is_ad, 'device', device, 'os', os, 'app', app, 'city', coalesce(nullif(city,''), country), 'landing', landing,
        'secs', secs, 'scroll', scroll_pct, 'seen', seen, 'path', tap_path, 'events', events, 'signedUpAs', signed_up_as) order by first_seen desc)
      from (select * from f order by first_seen desc limit 60) r), '[]'::jsonb)
  ));
end $$;
revoke all on function public.admin_site_report(integer, text) from public, anon;
grant execute on function public.admin_site_report(integer, text) to authenticated;
commit;
