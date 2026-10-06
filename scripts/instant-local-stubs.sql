-- The few Supabase things Nova Instant leans on, faked for a throwaway local
-- Postgres (scripts/test-instant-local.sh). Never run this on a real project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
                              metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant select, insert, delete on storage.objects to authenticated;

-- The http extension: every route lookup is answered with the road in
-- nvi_test.route (metres), or fails when that setting is empty.
create schema extensions;
create extension pgcrypto schema extensions;
create type extensions.http_header as (field varchar, value varchar);
create type extensions.http_request as (method varchar, uri varchar, headers extensions.http_header[], content_type varchar, content varchar);
create type extensions.http_response as (status int, content_type varchar, headers extensions.http_header[], content varchar);
create function extensions.http_header(varchar, varchar) returns extensions.http_header language sql as $$ select row($1, $2)::extensions.http_header $$;
create function extensions.http_set_curlopt(varchar, varchar) returns boolean language sql as $$ select true $$;
create function extensions.http_reset_curlopt() returns boolean language sql as $$ select true $$;
create function extensions.urlencode(varchar) returns text language sql as $$ select $1::text $$;
create function extensions.http(r extensions.http_request) returns extensions.http_response language plpgsql as $$
declare v_m text := nullif(current_setting('nvi_test.route', true), '');
begin
  if (r).uri like '%siteverify%' then
    return row(200, 'application/json', null, coalesce(nullif(current_setting('nvi_test.captcha', true), ''), '{"success":false}'))::extensions.http_response;
  end if;
  if v_m is null then return row(503, 'text/plain', null, 'down')::extensions.http_response; end if;
  return row(200, 'application/json', null,
    '{"code":"Ok","routes":[{"distance":' || v_m || ',"geometry":"abc"}],"waypoints":[{"distance":3},{"distance":4}]}')::extensions.http_response;
end $$;
grant usage on schema extensions to anon, authenticated, service_role;

-- NovaX Logistics tables Nova Instant reads.
create type public.novax_role as enum ('admin', 'client', 'rider', 'sales', 'support');
create table public.profiles (id uuid primary key, email text, full_name text, role public.novax_role not null default 'client',
                              client_id uuid, rider_id uuid, status text default 'active');
create table public.riders (id uuid primary key default gen_random_uuid(), name text, phone text);
create function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role::text = 'admin')
$$;
grant execute on function public.is_admin() to anon, authenticated;

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000001', 'admin@test.invalid');
insert into public.profiles (id, email, full_name, role) values ('00000000-0000-4000-8000-000000000001', 'admin@test.invalid', 'Test Admin', 'admin');
create table public.nvi_local_test_db ();   -- marks this database as the throwaway one
