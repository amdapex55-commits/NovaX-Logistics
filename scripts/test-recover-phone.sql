-- Nova Recover, 10 Oct 2026: parcels with no phone number, and a parcel that
-- is delivered after it was sent to the desk. Throwaway local Postgres only.
\set ON_ERROR_STOP 1
\set QUIET 1
do $$ begin perform 1 from public.nv_recover_local_test_db; end $$;
\o /dev/null
create function pg_temp.eq(label text, got text, want text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got %, want %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create function pg_temp.has(label text, got text, want text) returns void language plpgsql as $$
begin
  if got is null or position(want in got) = 0 then raise exception 'FAIL %: got %, wanted it to contain %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create function pg_temp.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    execute p_sql into v;
  exception when others then v := 'ERR: ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

begin;
\set admin   '''00000000-0000-4000-8000-0000000000a1'''
\set owner   '''00000000-0000-4000-8000-0000000000b1'''
\set owner2  '''00000000-0000-4000-8000-0000000000c1'''
\set store   '''00000000-0000-4000-8000-00000000c001'''
\set store2  '''00000000-0000-4000-8000-00000000c002'''
insert into auth.users (id, email) values (:admin, 'admin@test.invalid'), (:owner, 'owner@test.invalid'), (:owner2, 'owner2@test.invalid');
insert into public.clients (id, name, owner, phone, city, wallet_balance) values (:store, 'Test Scents', 'Owner One', '03001112222', 'Karachi', 500), (:store2, 'Quiet Store', 'Owner Two', '03003334444', 'Lahore', 500);
insert into public.profiles (id, email, role, client_id) values (:admin, 'admin@test.invalid', 'admin', null), (:owner, 'owner@test.invalid', 'client', :store), (:owner2, 'owner2@test.invalid', 'client', :store2);
insert into public.parcels (id, awb, client_id, consignee, phone, city, address, status, cod_amount, fee, exception, status_since, meta) values
  ('00000000-0000-4000-8000-000000000201', 'N201', :store, 'Ayesha', '03001234567', 'Lahore', 'House 1, A street', 'Refused', 2500, 250, 'Changed mind', now() - interval '1 day', '{}'),
  ('00000000-0000-4000-8000-000000000202', 'N202', :store, 'Old One', '', 'Lahore', '', 'Return to shipper', 1800, 250, '', now() - interval '60 days', '{}'),
  ('00000000-0000-4000-8000-000000000203', 'N203', :store, 'Old Two', null, 'Karachi', null, 'Return to shipper', 900, 225, '', now() - interval '70 days', '{}'),
  ('00000000-0000-4000-8000-000000000204', 'N204', :store, 'Omar', '03001112224', 'Lahore', 'House 4, D street', 'Refused', 1000, 250, '', now() - interval '2 days', '{}');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"all","desk":"agents"}'')::text');
select pg_temp.as_user(:owner, 'select public.client_recover_accept(''2026-10-08'')::text');

-- 1. The merchant's list says which parcels have no number, and never carries one.
select pg_temp.eq('two of four parcels have no number', pg_temp.as_user(:owner, $q$select (select count(*) from jsonb_array_elements(public.client_recover_list()->'parcels') x where (x->>'no_phone')::boolean)::text$q$), '2');
select pg_temp.eq('the list holds no phone numbers', pg_temp.as_user(:owner, $q$select (public.client_recover_list()::text ~ '0300')::text$q$), 'false');

-- 2. Sending.
select pg_temp.has('a parcel with no number is not sent without one', pg_temp.as_user(:owner, $q$select public.client_recover_push(array['00000000-0000-4000-8000-000000000202']::uuid[], 0, true, '{}'::jsonb, '', 'key-phone-000000001')::text$q$), 'Add the customer''s phone number for: N202');
select pg_temp.has('a five-digit number is not a number', pg_temp.as_user(:owner, $q$select public.client_recover_push(array['00000000-0000-4000-8000-000000000202']::uuid[], 0, true, '{}'::jsonb, '', 'key-phone-000000002', '{"00000000-0000-4000-8000-000000000202":"12345"}'::jsonb)::text$q$), 'Add the customer''s phone number');
select pg_temp.has('one missing number stops the whole batch', pg_temp.as_user(:owner, $q$select public.client_recover_push(array['00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000202']::uuid[], 0, true, '{}'::jsonb, '', 'key-phone-000000003')::text$q$), 'N202');
select pg_temp.eq('nothing was sent by the refused tries', (select count(*)::text from public.nv_recover_cases), '0');
select pg_temp.eq('with the number typed it goes', pg_temp.as_user(:owner, $q$select public.client_recover_push(array['00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000202']::uuid[], 0, true, '{}'::jsonb, '', 'key-phone-000000004', '{"00000000-0000-4000-8000-000000000202":"0300 5550000","00000000-0000-4000-8000-000000000201":"0399 9999999"}'::jsonb)->>'pushed'$q$), '2');
select pg_temp.eq('the typed number is on the case, with who and when', (select phone || '/' || phone_source || '/' || (phone_added_by = :owner)::text || '/' || (phone_added_at is not null)::text from public.nv_recover_cases where awb = 'N202'), '0300 5550000/merchant/true/true');
select pg_temp.eq('a parcel that has a number keeps its own', (select phone || '/' || phone_source || '/' || (phone_added_by is null)::text from public.nv_recover_cases where awb = 'N201'), '03001234567/parcel/true');
select pg_temp.eq('the parcel itself is not changed', (select coalesce(phone, '') || '|' || coalesce(address, '') from public.parcels where awb = 'N202'), '|');
select pg_temp.eq('the older six-argument call still works', pg_temp.as_user(:owner, $q$select public.client_recover_push(p_parcels => array['00000000-0000-4000-8000-000000000204']::uuid[], p_max_discount => 0, p_in_stock => true, p_items => '{}'::jsonb, p_note => '', p_key => 'key-phone-000000005')->>'pushed'$q$), '1');
select pg_temp.eq('there is one push function, not two', (select count(*)::text from pg_proc where proname = 'client_recover_push' and pronamespace = 'public'::regnamespace), '1');

-- 3. A case that reached the desk with no number (as 23 did on 9 Oct).
insert into public.nv_recover_cases (id, parcel_id, awb, client_id, kind, consignee, phone, city, address, cod)
values ('00000000-0000-4000-8000-00000000ca03', '00000000-0000-4000-8000-000000000203', 'N203', :store, 'returned', 'Old Two', null, 'Karachi', null, 900);
select pg_temp.eq('the merchant is told the case has no number', pg_temp.as_user(:owner, $q$select (select x->>'no_phone' from jsonb_array_elements(public.client_recover_list()->'cases') x where x->>'awb' = 'N203')$q$), 'true');
select pg_temp.eq('desk: not counted as to call', pg_temp.as_user(:admin, $q$select (c->>'to_call') || '/' || (c->>'no_phone') from (select public.cs_recover_queue()->'counts' c) t$q$), '3/1');
select pg_temp.has('another store cannot add the number', pg_temp.as_user(:owner2, $q$select public.client_recover_add_phone('00000000-0000-4000-8000-00000000ca03', '0300 1110000')::text$q$), 'not with Nova Recover');
select pg_temp.has('nobody signed out can', pg_temp.as_user(null, $q$select public.client_recover_add_phone('00000000-0000-4000-8000-00000000ca03', '0300 1110000')::text$q$), 'permission denied');
select pg_temp.has('letters are refused', pg_temp.as_user(:owner, $q$select public.client_recover_add_phone('00000000-0000-4000-8000-00000000ca03', 'call me')::text$q$), 'Check the phone number');
select pg_temp.eq('the owner adds it', pg_temp.as_user(:owner, $q$select public.client_recover_add_phone('00000000-0000-4000-8000-00000000ca03', '+92 300 1110000')->>'ok'$q$), 'true');
select pg_temp.has('a number on file is not replaced from the portal', pg_temp.as_user(:owner, $q$select public.client_recover_add_phone('00000000-0000-4000-8000-00000000ca03', '0300 2220000')::text$q$), 'already have a number');
select pg_temp.eq('desk: now it is to call', pg_temp.as_user(:admin, $q$select (c->>'to_call') || '/' || (c->>'no_phone') from (select public.cs_recover_queue()->'counts' c) t$q$), '4/0');
select pg_temp.has('a merchant cannot use the desk function', pg_temp.as_user(:owner, $q$select public.cs_recover_set_phone('00000000-0000-4000-8000-00000000ca03', '0300 3330000')::text$q$), 'ERR:');
select pg_temp.eq('the desk corrects a wrong number', pg_temp.as_user(:admin, $q$select public.cs_recover_set_phone('00000000-0000-4000-8000-00000000ca03', '0300-333-0000')->>'phone'$q$), '0300-333-0000');
select pg_temp.eq('and it is recorded as the desk', (select phone_source || '/' || (phone_added_by = :admin)::text from public.nv_recover_cases where awb = 'N203'), 'desk/true');
select pg_temp.has('the desk cannot save nonsense', pg_temp.as_user(:admin, $q$select public.cs_recover_set_phone('00000000-0000-4000-8000-00000000ca03', '12')::text$q$), 'Check the phone number');

-- 4. A parcel delivered after it was sent leaves the queue by itself.
update public.parcels set status = 'Delivered' where awb = 'N204';
select pg_temp.eq('the merchant no longer sees it waiting', pg_temp.as_user(:owner, $q$select (select count(*) from jsonb_array_elements(public.client_recover_list()->'cases') x where x->>'awb' = 'N204')::text$q$), '0');
select pg_temp.eq('the desk queue closes it', pg_temp.as_user(:admin, $q$select (select count(*) from jsonb_array_elements(public.cs_recover_queue()->'cases') x where x->>'awb' = 'N204')::text$q$), '0');
select pg_temp.eq('as withdrawn, with the reason', (select status || '/' || reason from public.nv_recover_cases where awb = 'N204'), 'withdrawn/Delivered before we called');
select pg_temp.eq('no fee was taken', (select coalesce(fee, 0)::text from public.nv_recover_cases where awb = 'N204'), '0');

-- 5. The number rule.
select pg_temp.eq('number rule', (select concat_ws('|', public.nv_recover_phone('0300-1234567'), public.nv_recover_phone('+92 300 1234567'), coalesce(public.nv_recover_phone('12345'), 'no'), coalesce(public.nv_recover_phone(null), 'no'), public.nv_recover_phone('0300<b>1234567'))), '0300-1234567|+92 300 1234567|no|no|03001234567');
rollback;
