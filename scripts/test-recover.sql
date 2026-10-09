-- Nova Recover phase 1 tests. Runs on the throwaway local Postgres made by
-- scripts/test-recover-local.sh. Stops at the first wrong answer.
\set ON_ERROR_STOP 1
\set QUIET 1
do $$ begin perform 1 from public.nv_recover_local_test_db; end $$;   -- refuses to run anywhere else
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
-- Run one statement as a signed-in user; its text result, or 'ERR: message'.
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
\set finance '''00000000-0000-4000-8000-0000000000b2'''
\set other   '''00000000-0000-4000-8000-0000000000c1'''
\set agent   '''00000000-0000-4000-8000-0000000000d1'''
\set store   '''00000000-0000-4000-8000-00000000c001'''
\set store2  '''00000000-0000-4000-8000-00000000c002'''

insert into auth.users (id, email) values
  (:admin, 'admin@test.invalid'), (:owner, 'owner@test.invalid'), (:finance, 'finance@test.invalid'),
  (:other, 'other@test.invalid'), (:agent, 'agent@test.invalid');
insert into public.clients (id, name, owner, phone, wallet_balance) values
  (:store, 'Test Scents', 'Owner One', '03001112222', 500), (:store2, 'Other Store', 'Owner Two', '03003334444', 0);
insert into public.profiles (id, email, role, client_id) values
  (:admin, 'admin@test.invalid', 'admin', null), (:owner, 'owner@test.invalid', 'client', :store),
  (:finance, 'finance@test.invalid', 'client', :store), (:other, 'other@test.invalid', 'client', :store2),
  (:agent, 'agent@test.invalid', 'support', null);
insert into public.staff_users (client_id, email, auth_user_id, role, status) values (:store, 'finance@test.invalid', :finance, 'Finance', 'Active');
insert into public.cs_agents (id, full_name, auth_user_id) values ('00000000-0000-4000-8000-0000000a6e01', 'Sara Agent', :agent);
insert into public.parcels (id, awb, client_id, consignee, phone, city, address, status, cod_amount, exception, status_since) values
  ('00000000-0000-4000-8000-000000000101', 'N1', :store, 'Ayesha', '03001', 'Lahore', 'A st', 'Refused', 2500, 'Changed mind', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000102', 'N2', :store, 'Bilal', '03002', 'Karachi', 'B st', 'Return to shipper', 300, '', now() - interval '40 days'),
  ('00000000-0000-4000-8000-000000000103', 'N3', :store, 'Sana', '03003', 'Lahore', 'C st', 'Return to shipper', 4000, 'Refused', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000104', 'N4', :store, 'Done', '03004', 'Lahore', 'D st', 'Delivered', 900, '', now()),
  ('00000000-0000-4000-8000-000000000201', 'M1', :store2, 'Else', '03005', 'Lahore', 'E st', 'Refused', 1200, '', now());

-- 1. Everything starts closed.
select pg_temp.eq('tab is off for the merchant', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''visible'''), 'false');
select pg_temp.has('list refuses while off', pg_temp.as_user(:owner, 'select public.client_recover_list()::text'), 'not open for this account');
select pg_temp.eq('signed-out visitor cannot call it', left(pg_temp.as_user(null, 'select public.client_recover_state()::text'), 4), 'ERR:');
select pg_temp.has('agent cannot open Resell while locked', pg_temp.as_user(:agent, 'select public.cs_recover_queue()::text'), 'not open yet');
select pg_temp.eq('agent is not shown the tab', pg_temp.as_user(:agent, 'select public.cs_recover_peek()->>''show'''), 'false');
select pg_temp.eq('admin is shown the tab', pg_temp.as_user(:admin, 'select public.cs_recover_peek()->>''show'''), 'true');
select pg_temp.eq('admin sees it is locked for agents', pg_temp.as_user(:admin, 'select public.cs_recover_peek()->>''locked_for_agents'''), 'true');
select pg_temp.has('merchant cannot change the switches', pg_temp.as_user(:owner, 'select public.cs_recover_config_set(''{"merchant_tab":"all"}'')::text'), 'Only NovaX admins');
select pg_temp.has('merchant cannot read the tables', pg_temp.as_user(:owner, 'select count(*)::text from public.nv_recover_cases'), 'permission denied');

-- 2. Admin opens it for one chosen merchant.
select pg_temp.eq('admin opens the tab for one store',
  pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"chosen","chosen_clients":["00000000-0000-4000-8000-00000000c001"]}'')->>''merchant_tab'''), 'chosen');
select pg_temp.eq('chosen store sees the tab', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''visible'''), 'true');
select pg_temp.eq('other store does not', pg_temp.as_user(:other, 'select public.client_recover_state()->>''visible'''), 'false');
select pg_temp.eq('not accepted yet', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'false');
select pg_temp.eq('three parcels to recover', pg_temp.as_user(:owner, 'select public.client_recover_state()->''counts''->>''to_recover'''), '3');
select pg_temp.eq('list holds refused and returned only', pg_temp.as_user(:owner, 'select jsonb_array_length(public.client_recover_list()->''parcels'')::text'), '3');
select pg_temp.eq('newest first', pg_temp.as_user(:owner, 'select public.client_recover_list()->''parcels''->0->>''awb'''), 'N1');
select pg_temp.eq('fee is Rs 100', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''fee'''), '100');

-- 3. Pushing needs the pop-up accepted, the stock tick, and a seat that may book.
select pg_temp.has('push before accepting is refused',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)::text'), 'Start recovering');
select pg_temp.has('a finance seat cannot accept the price for the account', pg_temp.as_user(:finance, 'select public.client_recover_accept(''2026-10-08'')::text'), 'team role cannot start');
select pg_temp.eq('so the account is still not accepted', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'false');
select pg_temp.has('old wording version is refused', pg_temp.as_user(:owner, 'select public.client_recover_accept(''1999'')::text'), 'was updated');
select pg_temp.eq('accept', pg_temp.as_user(:owner, 'select public.client_recover_accept(''2026-10-08'')->>''accepted'''), 'true');
select pg_temp.eq('accepted now', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'true');
select pg_temp.has('the stock tick is required for a parcel that went back to the merchant',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000102'']::uuid[], 0, false)::text'), 'still have the returned items');
select pg_temp.has('and for a mix of refused and returned',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'',''00000000-0000-4000-8000-000000000102'']::uuid[], 0, false)::text'), 'still have the returned items');
select pg_temp.has('empty selection is refused', pg_temp.as_user(:owner, 'select public.client_recover_push(''{}''::uuid[], 0, true)::text'), 'at least one');
select pg_temp.has('finance seat cannot push',
  pg_temp.as_user(:finance, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)::text'), 'team role cannot');
select pg_temp.eq('finance seat is told so up front', pg_temp.as_user(:finance, 'select public.client_recover_state()->>''may_push'''), 'false');
select pg_temp.has('a delivered parcel cannot be pushed',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000104'']::uuid[], 0, true)::text'), 'N4');
select pg_temp.has('another store''s parcel cannot be pushed',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000201'']::uuid[], 0, true)::text'), 'can no longer be sent');
select pg_temp.has('a fraction of a rupee off is refused',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 50.5, true)::text'), 'whole number');

-- 4. A real push: two parcels, Rs 500 off allowed, one item line, a key.
select pg_temp.eq('push two',
  pg_temp.as_user(:owner, $q$select public.client_recover_push(
    array['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102']::uuid[], 500, true,
    '{"00000000-0000-4000-8000-000000000101":"Oud perfume 50ml"}'::jsonb, 'Call after 5pm', 'key-0123456789abcdef')->>'pushed'$q$), '2');
select pg_temp.eq('same key again pushes nothing new',
  pg_temp.as_user(:owner, $q$select public.client_recover_push(
    array['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102']::uuid[], 500, true,
    '{}'::jsonb, '', 'key-0123456789abcdef')->>'repeat'$q$), 'true');
select pg_temp.eq('two cases exist', (select count(*)::text from public.nv_recover_cases), '2');
select pg_temp.eq('refused parcel is kind refused', (select kind from public.nv_recover_cases where awb = 'N1'), 'refused');
select pg_temp.eq('returned parcel is kind returned', (select kind from public.nv_recover_cases where awb = 'N2'), 'returned');
select pg_temp.eq('discount kept as given', (select max_discount::text from public.nv_recover_cases where awb = 'N1'), '500');
select pg_temp.eq('discount never above the COD', (select max_discount::text from public.nv_recover_cases where awb = 'N2'), '300');
select pg_temp.eq('item line saved', (select item_note from public.nv_recover_cases where awb = 'N1'), 'Oud perfume 50ml');
select pg_temp.eq('customer phone copied for the agent', (select phone from public.nv_recover_cases where awb = 'N1'), '03001');
select pg_temp.has('same parcel cannot be pushed twice',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)::text'), 'N1');
select pg_temp.eq('one left to recover', pg_temp.as_user(:owner, 'select public.client_recover_state()->''counts''->>''to_recover'''), '1');
select pg_temp.eq('two with NovaX', pg_temp.as_user(:owner, 'select public.client_recover_state()->''counts''->>''with_novax'''), '2');
select pg_temp.eq('list shows one parcel and two cases',
  pg_temp.as_user(:owner, 'select (jsonb_array_length(l->''parcels'') || ''/'' || jsonb_array_length(l->''cases'')) from public.client_recover_list() l'), '1/2');
select pg_temp.eq('the merchant list never carries the customer phone',
  pg_temp.as_user(:owner, 'select (public.client_recover_list()->''cases''->0 ? ''phone'')::text'), 'false');

-- 5. The desk: admin reads the queue, agent still cannot.
select pg_temp.eq('admin queue has two cases', pg_temp.as_user(:admin, 'select jsonb_array_length(public.cs_recover_queue()->''cases'')::text'), '2');
select pg_temp.eq('queue names the store', pg_temp.as_user(:admin, 'select public.cs_recover_queue()->''cases''->0->>''merchant'''), 'Test Scents');
select pg_temp.eq('queue carries the phone for the call',
  pg_temp.as_user(:admin, 'select (public.cs_recover_queue()->''cases''->0 ? ''phone'')::text'), 'true');
select pg_temp.eq('admin peek counts two waiting', pg_temp.as_user(:admin, 'select public.cs_recover_peek()->>''waiting'''), '2');
select pg_temp.has('agent still locked out', pg_temp.as_user(:agent, 'select public.cs_recover_queue()::text'), 'not open yet');
select pg_temp.has('merchant cannot open the desk queue', pg_temp.as_user(:owner, 'select public.cs_recover_queue()::text'), 'not open yet');

-- 6. Take back, and push again.
select pg_temp.eq('merchant cannot look up cases in the table itself',
  pg_temp.as_user(:owner, 'select public.client_recover_withdraw((select id from public.nv_recover_cases where awb = ''N2''))->>''withdrawn'''), 'ERR: permission denied for table nv_recover_cases');
select pg_temp.eq('take one back (by id)',
  pg_temp.as_user(:owner, format('select public.client_recover_withdraw(%L)->>''withdrawn''', (select id from public.nv_recover_cases where awb = 'N2'))), 'true');
select pg_temp.eq('taking back twice is harmless',
  pg_temp.as_user(:owner, format('select public.client_recover_withdraw(%L)->>''withdrawn''', (select id from public.nv_recover_cases where awb = 'N2'))), 'true');
select pg_temp.has('another store cannot take it back',
  pg_temp.as_user(:other, format('select public.client_recover_withdraw(%L)::text', (select id from public.nv_recover_cases where awb = 'N1'))), 'not with Nova Recover');
select pg_temp.eq('taken-back parcel returns to the list', pg_temp.as_user(:owner, 'select public.client_recover_state()->''counts''->>''to_recover'''), '2');
select pg_temp.eq('it can be pushed again',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000102'']::uuid[], 0, true)->>''pushed'''), '1');
update public.nv_recover_cases set tries = 1 where awb = 'N1';
select pg_temp.has('no taking back once calling has started',
  pg_temp.as_user(:owner, format('select public.client_recover_withdraw(%L)::text', (select id from public.nv_recover_cases where awb = 'N1' and status = 'waiting'))), 'already started calling');

-- 7. What a closed case does to the list.
update public.nv_recover_cases set status = 'not_recovered', closed_at = now() where awb = 'N1';
select pg_temp.eq('a "no" keeps the parcel in the list, marked done',
  pg_temp.as_user(:owner, 'select (select x->>''block'' from jsonb_array_elements(public.client_recover_list()->''parcels'') x where x->>''awb'' = ''N1'')'), 'done');
select pg_temp.has('and it cannot be pushed again',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)::text'), 'N1');
update public.nv_recover_cases set status = 'unreachable', closed_at = now() - interval '2 days' where awb = 'N1';
select pg_temp.eq('could-not-reach waits 7 days',
  pg_temp.as_user(:owner, 'select (select x->>''block'' from jsonb_array_elements(public.client_recover_list()->''parcels'') x where x->>''awb'' = ''N1'')'), 'wait');
update public.nv_recover_cases set closed_at = now() - interval '8 days' where awb = 'N1';
select pg_temp.eq('and can be pushed after that',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)->>''pushed'''), '1');

-- 8. Limits.
update public.clients set wallet_balance = -1500 where id = :store;
select pg_temp.eq('low wallet is flagged', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''wallet_low'''), 'true');
select pg_temp.has('low wallet cannot push',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000103'']::uuid[], 0, true)::text'), 'opens again once');
update public.clients set wallet_balance = -1000 where id = :store;
select pg_temp.eq('exactly at the floor may push',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000103'']::uuid[], 0, true)->>''pushed'''), '1');
-- (10 Oct 2026: a parcel with no phone number can no longer be sent without one, so these three carry one.)
insert into public.parcels (id, awb, client_id, phone, status, cod_amount, status_since) values ('00000000-0000-4000-8000-000000000107', 'N7', :store, '03007', 'Refused', 100, now());
select pg_temp.eq('a parcel still with NovaX needs no stock tick',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000107'']::uuid[], 0, false)->>''pushed'''), '1');
select pg_temp.eq('admin sets a push limit of 1', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"max_push":1}'')->>''max_push'''), '1');
insert into public.parcels (id, awb, client_id, phone, status, cod_amount, status_since) values
  ('00000000-0000-4000-8000-000000000105', 'N5', :store, '03005', 'Refused', 100, now()), ('00000000-0000-4000-8000-000000000106', 'N6', :store, '03006', 'Refused', 100, now());
select pg_temp.has('more than the limit is refused',
  pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000105'',''00000000-0000-4000-8000-000000000106'']::uuid[], 0, true)::text'), 'at most 1');

-- 9. The other switches.
select pg_temp.eq('admin opens Resell to agents', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"desk":"agents"}'')->>''desk'''), 'agents');
select pg_temp.eq('agent is now shown the tab', pg_temp.as_user(:agent, 'select public.cs_recover_peek()->>''show'''), 'true');
select pg_temp.has('but must be on the clock', pg_temp.as_user(:agent, 'select public.cs_recover_queue()::text'), 'Clock in');
insert into public.cs_shifts (agent_id) values ('00000000-0000-4000-8000-0000000a6e01');
select pg_temp.eq('clocked-in agent reads the queue', pg_temp.as_user(:agent, 'select public.cs_recover_queue()->>''mode'''), 'agent');
select pg_temp.has('agent cannot change the switches', pg_temp.as_user(:agent, 'select public.cs_recover_config_set(''{"fee":1}'')::text'), 'Only NovaX admins');
select pg_temp.eq('admin turns the tab off again', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"off"}'')->>''merchant_tab'''), 'off');
select pg_temp.eq('tab gone for the merchant', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''visible'''), 'false');
select pg_temp.has('and pushing is closed', pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000105'']::uuid[], 0, true)::text'), 'not open for this account');
select pg_temp.eq('open for everyone', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"all"}'')->>''merchant_tab'''), 'all');
select pg_temp.eq('the other store sees it now', pg_temp.as_user(:other, 'select public.client_recover_state()->>''visible'''), 'true');
select pg_temp.has('a bad switch value is refused', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"maybe"}'')::text'), 'ERR:');
rollback;
\echo Nova Recover phase 1: all database tests passed.
