-- Nova Recover phase 2 tests: the agent's calls, Recovered, the fee and the
-- wallet. Runs on the throwaway local Postgres (scripts/test-recover-local.sh).
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
\set agent   '''00000000-0000-4000-8000-0000000000d1'''
\set agent2  '''00000000-0000-4000-8000-0000000000d2'''
\set store   '''00000000-0000-4000-8000-00000000c001'''
insert into auth.users (id, email) values (:admin, 'admin@test.invalid'), (:owner, 'owner@test.invalid'), (:agent, 'agent@test.invalid'), (:agent2, 'agent2@test.invalid');
insert into public.clients (id, name, owner, phone, wallet_balance) values (:store, 'Test Scents', 'Owner One', '03001112222', 150);
insert into public.profiles (id, email, role, client_id) values (:admin, 'admin@test.invalid', 'admin', null), (:owner, 'owner@test.invalid', 'client', :store),
  (:agent, 'agent@test.invalid', 'support', null), (:agent2, 'agent2@test.invalid', 'support', null);
insert into public.cs_agents (id, full_name, auth_user_id) values ('00000000-0000-4000-8000-0000000a6e01', 'Sara', :agent), ('00000000-0000-4000-8000-0000000a6e02', 'Rehman', :agent2);
insert into public.cs_shifts (agent_id) values ('00000000-0000-4000-8000-0000000a6e01'), ('00000000-0000-4000-8000-0000000a6e02');
insert into public.parcels (id, awb, client_id, consignee, phone, city, address, status, cod_amount, fee, exception, status_since, meta) values
  ('00000000-0000-4000-8000-000000000101', 'N1', :store, 'Ayesha', '03001234567', 'Lahore', 'House 1, A street', 'Refused', 2500, 250, 'Changed mind', now() - interval '1 day', '{"category":"Oud 50ml","pickupCity":"Karachi","weight":"1 kg"}'),
  ('00000000-0000-4000-8000-000000000102', 'N2', :store, 'Bilal', '03007654321', 'Karachi', 'Flat 2, B street', 'Return to shipper', 900, 225, '', now() - interval '9 days', '{"pickupCity":"Karachi"}'),
  ('00000000-0000-4000-8000-000000000103', 'N3', :store, 'Sana', '03001112223', 'Lahore', 'House 3, C street', 'Refused', 4000, 250, 'Refused', now() - interval '2 days', '{}'),
  ('00000000-0000-4000-8000-000000000104', 'N4', :store, 'Omar', '03001112224', 'Lahore', 'House 4, D street', 'Refused', 1000, 250, '', now() - interval '3 days', '{}'),
  ('00000000-0000-4000-8000-000000000105', 'N5', :store, 'Hina', '03001112225', 'Lahore', 'House 5, E street', 'Refused', 1500, 250, '', now() - interval '4 days', '{}');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"all","desk":"agents"}'')::text');
select pg_temp.as_user(:owner, 'select public.client_recover_accept(''2026-10-08'')::text');
select pg_temp.eq('push five, Rs 300 off allowed', pg_temp.as_user(:owner, $q$select public.client_recover_push(array['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000105']::uuid[], 300, true)->>'pushed'$q$), '5');
select pg_temp.eq('item line comes from the booking when none is typed', (select item_note from public.nv_recover_cases where awb = 'N1'), 'Oud 50ml');
create temp table c as select awb, id from public.nv_recover_cases; grant select on c to authenticated;

-- 1. The queue and one agent per case.
select pg_temp.eq('queue lists five to call', pg_temp.as_user(:agent, 'select public.cs_recover_queue()->''counts''->>''to_call'''), '5');
select pg_temp.eq('newest refusal first', pg_temp.as_user(:agent, 'select public.cs_recover_queue()->''cases''->0->>''awb'''), 'N1');
select pg_temp.eq('a refused parcel can be sent again', pg_temp.as_user(:agent, 'select (select x->>''action'' from jsonb_array_elements(public.cs_recover_queue()->''cases'') x where x->>''awb'' = ''N1'')'), 'resend');
select pg_temp.eq('a returned parcel needs a new booking', pg_temp.as_user(:agent, 'select (select x->>''action'' from jsonb_array_elements(public.cs_recover_queue()->''cases'') x where x->>''awb'' = ''N2'')'), 'rebook');
select pg_temp.eq('agent opens a case', pg_temp.as_user(:agent, 'select public.cs_recover_open((select id from c where awb = ''N1''))->>''held'''), 'true');
select pg_temp.eq('merchant sees Calling', pg_temp.as_user(:owner, 'select (select x->>''status'' from jsonb_array_elements(public.client_recover_list()->''cases'') x where x->>''awb'' = ''N1'')'), 'calling');
select pg_temp.has('a second agent cannot open it', pg_temp.as_user(:agent2, 'select public.cs_recover_open((select id from c where awb = ''N1''))::text'), 'Sara is on this call');
select pg_temp.has('nor log on it', pg_temp.as_user(:agent2, 'select public.cs_recover_log((select id from c where awb = ''N1''), ''no_answer'')::text'), 'Sara is on this call');
select pg_temp.eq('second agent is told who has it', pg_temp.as_user(:agent2, 'select (select x->>''held_by'' from jsonb_array_elements(public.cs_recover_queue()->''cases'') x where x->>''awb'' = ''N1'')'), 'Sara');
select pg_temp.has('merchant cannot take back a case that is being called', pg_temp.as_user(:owner, 'select public.client_recover_withdraw((select id from c where awb = ''N1''))::text'), 'already started calling');
select pg_temp.eq('closing without a result puts it back', pg_temp.as_user(:agent, 'select public.cs_recover_release((select id from c where awb = ''N1''))->>''released'''), 'true');
select pg_temp.eq('status is waiting again', (select status from public.nv_recover_cases where awb = 'N1'), 'waiting');
update public.nv_recover_cases set status = 'calling', held_by = :agent2, held_until = now() - interval '1 minute' where awb = 'N3';
select pg_temp.eq('an abandoned call returns to the line', pg_temp.as_user(:agent, 'select (select x->>''status'' from jsonb_array_elements(public.cs_recover_queue()->''cases'') x where x->>''awb'' = ''N3'')'), 'waiting');

-- 2. Calls that do not recover.
select pg_temp.has('an unknown result is refused', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N4''), ''maybe'')::text'), 'Pick what happened');
select pg_temp.eq('no answer counts a try', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N4''), ''no_answer'')->>''tries'''), '1');
select pg_temp.eq('a case already tried waits behind the untried ones', pg_temp.as_user(:agent, 'select string_agg(x->>''awb'', '','') from jsonb_array_elements(public.cs_recover_queue()->''cases'') x where x->>''status'' = ''waiting'''), 'N1,N3,N5,N2,N4');
select pg_temp.eq('second no answer', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N4''), ''no_answer'')->>''status'''), 'waiting');
select pg_temp.eq('third closes it as could not reach', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N4''), ''no_answer'')->>''status'''), 'unreachable');
select pg_temp.has('a closed case takes no more calls', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N4''), ''no_answer'')::text'), 'already closed');
select pg_temp.has('call back needs a time', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N5''), ''callback'')::text'), 'Pick a time');
select pg_temp.eq('call back tomorrow', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N5''), ''callback'', null, ''After Maghrib'', now() + interval ''1 day'')->>''status'''), 'callback');
select pg_temp.eq('a call back does not count as a failed try', (select tries::text from public.nv_recover_cases where awb = 'N5'), '0');
select pg_temp.eq('a later call back is not in "to call" yet', pg_temp.as_user(:agent, 'select public.cs_recover_queue()->''counts''->>''to_call'''), '3');
select pg_temp.has('not interested needs a listed reason', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N5''), ''not_interested'', ''because'')::text'), 'Pick the reason');
select pg_temp.eq('not interested closes it', pg_temp.as_user(:agent, 'select public.cs_recover_log((select id from c where awb = ''N5''), ''not_interested'', ''Price too high'')->>''status'''), 'not_recovered');
select pg_temp.eq('the merchant sees the reason', pg_temp.as_user(:owner, 'select (select x->>''reason'' from jsonb_array_elements(public.client_recover_list()->''cases'') x where x->>''awb'' = ''N5'')'), 'Price too high');
select pg_temp.eq('no fee for a call that did not recover', (select wallet_balance::text from public.clients where id = :store), '150');

-- 3. Recovered: a refused parcel goes out again as the same parcel.
select pg_temp.has('COD cannot go up', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha'', ''03001234567'', ''House 1, A street'', ''Lahore'', 2600, current_date + 1)::text'), 'cannot be more');
select pg_temp.has('discount stops at what the merchant allowed', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha'', ''03001234567'', ''House 1, A street'', ''Lahore'', 2100, current_date + 1)::text'), 'lowest COD is Rs 2200');
select pg_temp.has('a date is required', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha'', ''03001234567'', ''House 1, A street'', ''Lahore'', 2500, null)::text'), 'delivery day');
select pg_temp.has('a real phone is required', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha'', ''123'', ''House 1, A street'', ''Lahore'', 2500, current_date + 1)::text'), 'phone number');
select pg_temp.eq('recover with Rs 300 off and a corrected address',
  pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha Khan'', ''03001234567'', ''House 1, A street, near the park'', ''Karachi'', 2200, current_date + 1, ''After 5pm'')->>''mode'''), 'resend');
select pg_temp.eq('same parcel, no second one', (select count(*)::text from public.parcels where client_id = :store), '5');
select pg_temp.eq('its COD is the agreed one', (select cod_amount::text from public.parcels where awb = 'N1'), '2200');
select pg_temp.eq('address corrected', (select address from public.parcels where awb = 'N1'), 'House 1, A street, near the park');
select pg_temp.eq('a parcel at the station does not change city', (select city from public.parcels where awb = 'N1'), 'Lahore');
select pg_temp.eq('status left for operations to move', (select status from public.parcels where awb = 'N1'), 'Refused');
select pg_temp.eq('marked recovered on the parcel', (select meta->'recover'->>'by' from public.parcels where awb = 'N1'), 'NovaX');
select pg_temp.eq('a ticket for operations', (select urgency || '|' || (meta->>'newCod') from public.operations_issues where problem = 'Nova Recover, deliver again: N1'), 'urgent|2200');
select pg_temp.eq('Rs 100 taken', (select wallet_balance::text from public.clients where id = :store), '50');
select pg_temp.eq('pressing Recovered again changes nothing', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha Khan'', ''03001234567'', ''House 1, A street, near the park'', ''Lahore'', 2200, current_date + 1)->>''repeat'''), 'true');
select pg_temp.eq('still one fee', (select count(*)::text from public.wallet_ledger where reference_type = 'recover_case'), '1');
select pg_temp.has('the merchant still cannot lower COD on a refused parcel', pg_temp.as_user(:owner, 'update public.parcels set cod_amount = 1 where awb = ''N3'' returning awb'), 'ERR:');

-- 4. Recovered: a returned parcel is booked again; the wallet goes below zero.
select pg_temp.has('"the rider never came" is not for a returned parcel', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N2''), ''Bilal'', ''03007654321'', ''Flat 2, B street'', ''Karachi'', 900, current_date + 2, null, true)::text'), 'only for a parcel still with NovaX');
select pg_temp.has('a city we do not serve is refused', pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N2''), ''Bilal'', ''03007654321'', ''Flat 2, B street'', ''Quetta'', 900, current_date + 2)::text'), 'does not deliver to Quetta');
select pg_temp.eq('create new booking, to another served city',
  pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N2''), ''Bilal'', ''03007654321'', ''Flat 2, B street, Gulberg'', ''Lahore'', 900, current_date + 2)->>''mode'''), 'rebook');
select pg_temp.eq('a new parcel exists', (select count(*)::text from public.parcels where client_id = :store), '6');
select pg_temp.eq('booked as New booked for the new city', (select status || '|' || city from public.parcels where meta->>'source' = 'nova_recover'), 'New booked|Lahore');
select pg_temp.eq('it points back to the old AWB', (select meta->'recover'->>'from' from public.parcels where meta->>'source' = 'nova_recover'), 'N2');
select pg_temp.eq('the old parcel points forward', (select meta->'recover'->>'rebookedAs' from public.parcels where awb = 'N2'), (select awb from public.parcels where meta->>'source' = 'nova_recover'));
select pg_temp.eq('the case carries the new AWB', (select new_awb from public.nv_recover_cases where awb = 'N2'), (select awb from public.parcels where meta->>'source' = 'nova_recover'));
select pg_temp.eq('audit names the support agent', (select action || '|' || actor_role || '|' || (actor_id = :agent)::text from public.parcel_admin_audit limit 1), 'recover_booked|support|true');
select pg_temp.eq('wallet is now below zero', (select wallet_balance::text from public.clients where id = :store), '-50');
select pg_temp.eq('two fee lines, as adjustments', (select string_agg(entry_type || ' ' || amount, ', ' order by created_at) from public.wallet_ledger), 'admin_adjustment -100, admin_adjustment -100');
select pg_temp.eq('ledger still adds up to the wallet movement', (select sum(amount)::text from public.wallet_ledger where affects_balance), '-200');

-- 5. The rider never came: recovered, free, and operations is told.
select pg_temp.eq('rider never came',
  pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N3''), ''Sana'', ''03001112223'', ''House 3, C street'', ''Lahore'', 4000, current_date + 1, ''Nobody called her'', true)->>''fee'''), '0');
select pg_temp.eq('no fee for it', (select wallet_balance::text from public.clients where id = :store), '-50');
select pg_temp.eq('logged against the rider', (select urgency from public.operations_issues where problem = 'Fake attempt / proof dispute: N3'), 'super urgent');

-- 6. The merchant's side and the numbers.
select pg_temp.eq('merchant sees three recovered', pg_temp.as_user(:owner, 'select public.client_recover_state()->''counts''->>''recovered'''), '3');
select pg_temp.eq('recovered parcels cannot be pushed again', pg_temp.as_user(:owner, 'select (select x->>''block'' from jsonb_array_elements(public.client_recover_list()->''parcels'') x where x->>''awb'' = ''N3'')'), 'done');
select pg_temp.eq('marking them seen works', pg_temp.as_user(:owner, 'select public.client_recover_seen()->>''seen'''), 'true');
select pg_temp.eq('agent stats: three recovered', pg_temp.as_user(:agent, 'select public.cs_recover_stats(current_date - 1, current_date + 1)->''totals''->>''recovered'''), '3');
select pg_temp.eq('agent stats: Rs 200 in fees', pg_temp.as_user(:agent, 'select public.cs_recover_stats(current_date - 1, current_date + 1)->''totals''->>''fees'''), '200');
select pg_temp.eq('another agent sees only their own', pg_temp.as_user(:agent2, 'select public.cs_recover_stats(current_date - 1, current_date + 1)->''totals''->>''recovered'''), '0');
select pg_temp.eq('admin sees every agent', pg_temp.as_user(:admin, 'select public.cs_recover_stats(current_date - 1, current_date + 1)->''agents''->0->>''name'''), 'Sara');
update public.parcels set status = 'Delivered', delivered_at = now() + interval '1 hour' where awb = 'N1';
select pg_temp.eq('delivered after recovery is counted', pg_temp.as_user(:admin, 'select public.cs_recover_stats(current_date - 1, current_date + 1)->''totals''->>''delivered'''), '1');
select pg_temp.has('merchant cannot press Recovered', pg_temp.as_user(:owner, 'select public.cs_recover_complete((select id from c where awb = ''N5''), ''x'', ''03001112225'', ''House 5, E street'', ''Lahore'', 1500, current_date + 1)::text'), 'ERR:');
select pg_temp.eq('admin locks Resell again', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"desk":"admin"}'')->>''desk'''), 'admin');
select pg_temp.has('agents are out again', pg_temp.as_user(:agent, 'select public.cs_recover_queue()::text'), 'not open yet');
rollback;
\echo Nova Recover phase 2: all database tests passed.
