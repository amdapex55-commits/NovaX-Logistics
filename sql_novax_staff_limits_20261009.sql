-- Limited staff logins for the admin portal (9 Oct 2026).
--
-- Until now every Admin Portal login was a full admin: Create User set
-- profiles.role = 'admin', and the "Allowed Controls" ticks were saved and
-- shown but nothing read them. This file makes a second kind of NovaX login
-- real: LIMITED STAFF.
--
--   * profile role 'support' (not 'admin'), so is_admin() is false and every
--     existing admin-only rule keeps refusing them: wallet ledger,
--     withdrawals, invoices, expenses, payouts, users, API keys, pricing.
--   * a staff_users row with client_id null, an admin-side access_side and
--     status Active. Only admins can write that table, so the row is the
--     proof that NovaX gave this person access. Its "permissions" list says
--     which sections.
--   * each permission opens exactly what its section needs, by ADDING row
--     rules and by letting a named function accept it. Nothing an admin,
--     merchant or rider can do today changes.
--
-- Permissions: orders-view, orders-book, orders-processing, manifest,
-- demanifest (both need orders-processing to move a parcel), pickups,
-- support-tickets, clients (read, CNIC review, profile changes), riders
-- (read only: boards and stations, no cash, limits or cities).
-- Not available to limited staff at all: finance, users, API, pricing,
-- deleting or repricing a parcel, creating or deleting a merchant.
--
-- Safe to run twice.

-- ── who is asking ──────────────────────────────────────────────────────
-- The caller's permissions as limited staff, or null when they are not one.
create or replace function public.nv_staff_perms() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text; v jsonb;
begin
  if v_uid is null then return null; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role::text = 'support'
                   and lower(coalesce(p.status::text, 'active')) not in ('blocked', 'disabled')) then
    return null;
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  select case when jsonb_typeof(su.permissions) = 'array' then su.permissions else '[]'::jsonb end into v
    from public.staff_users su
   where su.client_id is null and su.rider_id is null
     and lower(coalesce(su.status, '')) = 'active'
     and lower(coalesce(su.access_side, '')) in ('admin portal', 'both admin and web')
     and (su.auth_user_id = v_uid or (su.auth_user_id is null and lower(coalesce(su.email, '')) = coalesce(v_email, '~')))
   order by (su.auth_user_id = v_uid) desc nulls last, su.created_at desc
   limit 1;
  return v;
end $$;

create or replace function public.nv_staff_can(p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.nv_staff_perms() ? p_perm, false)
$$;

create or replace function public.nv_staff_any(p_perms text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.nv_staff_perms() ?| p_perms, false)
$$;

-- Any operations section at all: enough to read parcels, merchants' names and riders.
create or replace function public.nv_staff_ops() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.nv_staff_any(array['orders-view', 'orders-book', 'orders-processing', 'manifest', 'demanifest',
                                   'pickups', 'support-tickets', 'clients', 'riders'])
$$;

-- What the admin page asks before it draws anything.
create or replace function public.nv_staff_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text; v_perms jsonb;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select p.role::text into v_role from public.profiles p where p.id = v_uid;
  if public.is_admin() then return jsonb_build_object('signed_in', true, 'role', 'admin', 'limited', false); end if;
  v_perms := public.nv_staff_perms();
  return jsonb_build_object('signed_in', true, 'role', v_role, 'limited', v_perms is not null,
    'permissions', coalesce(v_perms, '[]'::jsonb),
    'support_desk', exists (select 1 from public.cs_agents a where a.auth_user_id = v_uid and a.status = 'Active'));
end $$;

-- ── row rules, added beside the existing ones ──────────────────────────
do $pol$
declare r record;
begin
  for r in select * from (values
    ('parcels',              'nv_staff_parcels_read',  'select', '(select public.nv_staff_ops())', null),
    ('parcels',              'nv_staff_parcels_upd',   'update', '(select public.nv_staff_can(''orders-processing''))', '(select public.nv_staff_can(''orders-processing''))'),
    ('clients',              'nv_staff_clients_read',  'select', '(select public.nv_staff_ops())', null),
    ('riders',               'nv_staff_riders_read',   'select', '(select public.nv_staff_ops())', null),
    ('pickup_requests',      'nv_staff_pickups_read',  'select', '(select public.nv_staff_can(''pickups''))', null),
    ('pickup_requests',      'nv_staff_pickups_upd',   'update', '(select public.nv_staff_can(''pickups''))', '(select public.nv_staff_can(''pickups''))'),
    ('novax_tickets',        'nv_staff_tickets_all',   'all',    '(select public.nv_staff_can(''support-tickets''))', '(select public.nv_staff_can(''support-tickets''))'),
    ('novax_ticket_replies', 'nv_staff_replies_all',   'all',    '(select public.nv_staff_can(''support-tickets''))', '(select public.nv_staff_can(''support-tickets''))'),
    ('manifest_logs',        'nv_staff_manifest_all',  'all',    '(select public.nv_staff_any(array[''manifest'', ''demanifest'']))', '(select public.nv_staff_any(array[''manifest'', ''demanifest'']))'),
    ('operations_issues',    'nv_staff_issues_all',    'all',    '(select public.nv_staff_any(array[''orders-processing'', ''manifest'', ''demanifest'', ''support-tickets'']))', '(select public.nv_staff_any(array[''orders-processing'', ''manifest'', ''demanifest'', ''support-tickets'']))'),
    ('resolved_alerts',      'nv_staff_alerts_all',    'all',    '(select public.nv_staff_any(array[''orders-processing'', ''manifest'', ''demanifest'', ''support-tickets'']))', '(select public.nv_staff_any(array[''orders-processing'', ''manifest'', ''demanifest'', ''support-tickets'']))'),
    ('sales_leads',          'nv_staff_sales_leads_read',  'select', '(select public.nv_staff_can(''clients''))', null),
    ('signup_leads',         'nv_staff_signup_leads_read', 'select', '(select public.nv_staff_can(''clients''))', null),
    ('pickup_addresses',     'nv_staff_pickup_addr_read',  'select', '(select public.nv_staff_can(''pickups''))', null)
  ) as t(tbl, pol, cmd, using_expr, check_expr)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
    execute format('create policy %I on public.%I for %s to authenticated using (%s)%s',
      r.pol, r.tbl, r.cmd, r.using_expr, case when r.check_expr is null then '' else ' with check (' || r.check_expr || ')' end);
  end loop;
end $pol$;

-- A limited staff login reads its own staff row and nobody else's.
drop policy if exists nv_staff_own_row on public.staff_users;
create policy nv_staff_own_row on public.staff_users for select to authenticated
  using (client_id is null and (auth_user_id = (select auth.uid())
         or (auth_user_id is null and lower(coalesce(email, '')) = lower(coalesce((select auth.jwt() ->> 'email'), '~')))));

-- ── functions that now also accept the matching permission ─────────────
-- Each is patched from its live definition, and only if its admin check is
-- still the one line it was on 9 Oct 2026. If any has changed, nothing in
-- this block is applied.
do $fn$
declare
  r record; v_def text; v_new text;
  v_one text := $re$not\s+public\.is_admin\(\)$re$;
begin
  for r in select * from (values
    ('admin_book_parcel_for_client', 'public.nv_staff_can(''orders-book'')'),
    ('admin_update_parcel_details',  'public.nv_staff_can(''orders-processing'')'),
    ('admin_status_counts_before',   'public.nv_staff_ops()'),
    ('admin_search_clients',         'public.nv_staff_ops()'),
    ('admin_rider_board',            'public.nv_staff_can(''riders'')'),
    ('admin_station_overview',       'public.nv_staff_can(''riders'')'),
    ('admin_kyc_list',               'public.nv_staff_can(''clients'')'),
    ('admin_kyc_events',             'public.nv_staff_can(''clients'')'),
    ('admin_kyc_orphans',            'public.nv_staff_can(''clients'')'),
    ('admin_kyc_review',             'public.nv_staff_can(''clients'')'),
    ('admin_profile_changes',        'public.nv_staff_can(''clients'')'),
    ('admin_profile_changes_seen',   'public.nv_staff_can(''clients'')')
  ) as t(fn, allow)
  loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = r.fn;
    if v_def is null then raise exception 'Function % not found. Nothing was changed.', r.fn; end if;
    if position('nv_staff_' in v_def) > 0 then continue; end if;       -- already patched
    if regexp_count(v_def, v_one) <> 1 or regexp_count(v_def, 'is_admin\(\)') <> 1 then
      raise exception 'Function % is not the shape this file expects. Nothing was changed.', r.fn;
    end if;
    v_new := regexp_replace(v_def, v_one, 'not (public.is_admin() or ' || r.allow || ')');
    execute v_new;
  end loop;

  -- The booking core: admins, NovaX itself, a merchant for their own account, and now staff who may book.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'nv_book_parcel_core';
  if v_def is null then raise exception 'nv_book_parcel_core not found. Nothing was changed.'; end if;
  if position('nv_staff_' in v_def) = 0 then
    if regexp_count(v_def, $re$public\.is_admin\(\)\s+or\s+public\.is_staff_admin\(\)\s+or\s+p_client_id\s*=\s*public\.my_client_id\(\)$re$) <> 1 then
      raise exception 'nv_book_parcel_core is not the shape this file expects. Nothing was changed.';
    end if;
    execute regexp_replace(v_def, $re$public\.is_admin\(\)\s+or\s+public\.is_staff_admin\(\)\s+or\s+p_client_id\s*=\s*public\.my_client_id\(\)$re$,
      'public.is_admin() or public.is_staff_admin() or public.nv_staff_can(''orders-book'') or p_client_id = public.my_client_id()');
  end if;

  -- Booking writes a "COD expected" line to the merchant's payment history
  -- through a trigger. Its guard knew only NovaX itself, admins and the
  -- merchant; staff who may book or process are let through for that one
  -- kind of line. They still cannot write payment history themselves: the
  -- table's own row rules keep refusing that.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'nv_guard_payment_logs';
  if v_def is not null and position('nv_staff_' in v_def) = 0 then
    if regexp_count(v_def, $re$if\s+auth\.uid\(\)\s+is\s+null\s+or\s+public\.is_admin\(\)\s+then\s+return\s+new;$re$) <> 1 then
      raise exception 'nv_guard_payment_logs is not the shape this file expects. Nothing was changed.';
    end if;
    execute regexp_replace(v_def, $re$if\s+auth\.uid\(\)\s+is\s+null\s+or\s+public\.is_admin\(\)\s+then\s+return\s+new;$re$,
      'if auth.uid() is null or public.is_admin() or (new.type = ''COD expected'' and public.nv_staff_any(array[''orders-book'', ''orders-processing''])) then return new;');
  end if;

  -- Opening an operations issue from the desk screens.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'nv_ops_issue_open';
  if v_def is not null and position('nv_staff_' in v_def) = 0 then
    if regexp_count(v_def, $re$not\s+public\.is_staff_admin\(\)$re$) <> 1 then
      raise exception 'nv_ops_issue_open is not the shape this file expects. Nothing was changed.';
    end if;
    execute regexp_replace(v_def, $re$not\s+public\.is_staff_admin\(\)$re$,
      'not (public.is_staff_admin() or public.nv_staff_any(array[''orders-processing'', ''manifest'', ''demanifest'', ''support-tickets'']))');
  end if;
end $fn$;

revoke all on function public.nv_staff_perms(), public.nv_staff_can(text), public.nv_staff_any(text[]), public.nv_staff_ops(), public.nv_staff_me()
  from public, anon;
grant execute on function public.nv_staff_perms(), public.nv_staff_can(text), public.nv_staff_any(text[]), public.nv_staff_ops(), public.nv_staff_me()
  to authenticated;
