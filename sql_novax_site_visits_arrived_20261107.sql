-- 7 Nov 2026: count visitors who tapped the ad and left before the page
-- finished loading (a visit with 'arrived' from <head> but never 'loaded').
begin;
CREATE OR REPLACE FUNCTION public.admin_site_report(p_days integer DEFAULT 1, p_only text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
                 'medianSecs', coalesce(percentile_cont(0.5) within group (order by secs), 0), 'medianLoadMs', percentile_cont(0.5) within group (order by load_ms), 'slowLoads', count(*) filter (where load_ms > 4000), 'arrived', count(*) filter (where 'arrived' = any(events)), 'leftBeforeLoad', count(*) filter (where 'arrived' = any(events) and not ('loaded' = any(events))), 'bounced', count(*) filter (where bounced),
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
        'secs', secs, 'loadMs', load_ms, 'scroll', scroll_pct, 'seen', seen, 'path', tap_path, 'events', events, 'signedUpAs', signed_up_as) order by first_seen desc)
      from (select * from f order by first_seen desc limit 60) r), '[]'::jsonb)
  ));
end $function$;
commit;
