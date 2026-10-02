-- NovaX public (signed-out) writes go through functions only (2 Oct 2026).
-- Three tables let anyone INSERT directly: sales_leads ("Talk to sales" on the
-- homepage), signup_leads and visitor_sessions. The homepage already writes
-- signup_leads and visitor_sessions through nv_signup_lead_create and
-- visitor_ping, so their direct-insert policies are removed now. sales_leads
-- moves to nv_sales_lead_create(); its direct-insert policy is removed by a
-- one-shot job 5 hours later, once any copy of the old page has expired.
-- Limits: signup leads 10 per connection an hour; new visitor sessions 120 per
-- connection an hour (heartbeats on an existing session are unaffected).

begin;

create or replace function public.nv_client_net_key(p_tag text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_h jsonb; v_ip text;
begin
  begin v_h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_h := null; end;
  v_ip := coalesce(nullif(v_h->>'cf-connecting-ip', ''), nullif(btrim(split_part(coalesce(v_h->>'x-forwarded-for', ''), ',', 1)), ''), '');
  return case when v_ip = '' then '' else p_tag || ':' || md5(v_ip || ':novax-' || p_tag) end;   -- hashed, never stored raw
end $$;
revoke all on function public.nv_client_net_key(text) from public, anon, authenticated;

-- "Talk to sales": the row still passes nv_sales_lead_guard (name, phone,
-- one lead per phone a day, 5 per network an hour, 30 every 10 minutes).
create or replace function public.nv_sales_lead_create(p_name text, p_phone text, p_parcels text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sales_leads(name, phone, parcels_per_month, status)
  values (p_name, p_phone, p_parcels, 'New');
  return true;
end $$;
revoke all on function public.nv_sales_lead_create(text, text, text) from public, anon, authenticated;
grant execute on function public.nv_sales_lead_create(text, text, text) to anon, authenticated;

create or replace function public.nv_signup_lead_create(p_name text, p_phone text, p_email text, p_city text, p_address text, p_business_type text, p_website text, p_auth_user_id uuid default null)
returns uuid language plpgsql security definer set search_path = 'public' as $$
declare v_id uuid; v_key text := public.nv_client_net_key('signuplead');
begin
  if v_key <> '' and not public.nv_track_rate_ok(v_key, 10, interval '1 hour') then
    raise exception 'Too many signups from this connection. Please try again later.' using errcode = '54000';
  end if;
  insert into public.signup_leads (name, phone, email, city, address, business_type, website, auth_user_id, status)
  values (left(coalesce(p_name, ''), 200), left(coalesce(p_phone, ''), 40), left(lower(coalesce(p_email, '')), 200),
          left(coalesce(p_city, ''), 80), left(coalesce(p_address, ''), 500), left(coalesce(p_business_type, ''), 200),
          left(coalesce(p_website, ''), 300),
          -- only a user id that exists AND belongs to this email is linked
          (select u.id from auth.users u where u.id = p_auth_user_id and lower(u.email) = lower(coalesce(p_email, ''))),
          'pending_workspace')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.visitor_ping(p_session_id text, p_portal text, p_activity text, p_path text, p_referrer text, p_user_agent text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  v_session_id text; v_portal text; v_activity text; v_path text; v_referrer text; v_user_agent text;
  v_key text;
begin
  v_session_id := btrim(coalesce(p_session_id, ''));
  if v_session_id = '' then
    raise exception 'session_id is required.';
  end if;
  v_session_id := left(v_session_id, 100);

  -- A new session costs a row: at most 120 new ones per connection an hour.
  -- Over the limit the ping is dropped quietly (never an error a page sees).
  if not exists (select 1 from public.visitor_sessions s where s.session_id = v_session_id) then
    v_key := public.nv_client_net_key('visit');
    if v_key <> '' and not public.nv_track_rate_ok(v_key, 120, interval '1 hour') then return; end if;
  end if;

  v_portal := lower(btrim(coalesce(p_portal, '')));
  if v_portal not in ('index', 'client', 'admin', 'rider', 'tracking', 'reset', 'landing') then
    v_portal := 'index';
  end if;

  v_activity := left(coalesce(p_activity, ''), 200);
  v_path := left(coalesce(p_path, ''), 300);
  v_referrer := left(coalesce(p_referrer, ''), 300);
  v_user_agent := left(coalesce(p_user_agent, ''), 400);

  insert into public.visitor_sessions (session_id, portal, activity, path, referrer, user_agent, first_seen, last_seen)
  values (v_session_id, v_portal, v_activity, v_path, v_referrer, v_user_agent, now(), now())
  on conflict (session_id) do update
    set portal = excluded.portal,
        activity = excluded.activity,
        path = excluded.path,
        referrer = excluded.referrer,
        user_agent = excluded.user_agent,
        last_seen = now();
end $$;

-- Unused direct-insert doors.
drop policy if exists "anon insert signup_leads" on public.signup_leads;
drop policy if exists "Anyone can insert their own visitor heartbeat" on public.visitor_sessions;
revoke insert, update, delete on public.signup_leads, public.visitor_sessions from anon;

-- Nightly cleanup also covers visitor sessions and old rate-limit buckets.
create or replace function public.nv_prune_logs()
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  delete from public.nv_api_request_log where created_at < now() - interval '30 days';
  delete from supabase_functions.hooks   where created_at < now() - interval '7 days';
  delete from public.visitor_sessions    where last_seen < now() - interval '90 days';
  delete from public.nv_track_hits       where window_at < now() - interval '2 days';
  begin
    delete from net._http_response where created < now() - interval '3 days';
  exception when undefined_table or insufficient_privilege then null;
  end;
end $$;

commit;

-- In 5 hours: close the last direct-insert door, then remove this job.
select cron.schedule('novax-close-sales-leads-insert',
  to_char(now() at time zone 'UTC' + interval '5 hours', 'MI HH24 DD MM') || ' *',
  $job$drop policy if exists "public insert sales leads" on public.sales_leads;
       revoke insert on public.sales_leads from anon;
       select cron.unschedule('novax-close-sales-leads-insert');$job$)
where not exists (select 1 from cron.job where jobname = 'novax-close-sales-leads-insert');
