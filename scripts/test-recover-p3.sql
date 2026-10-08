-- Nova Recover phase 3 tests: the Settings functions, the refusal notice,
-- the Reports summary and the two emails. Throwaway local Postgres only.
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
\set agent   '''00000000-0000-4000-8000-0000000000d1'''
\set store   '''00000000-0000-4000-8000-00000000c001'''
\set store2  '''00000000-0000-4000-8000-00000000c002'''
insert into auth.users (id, email) values (:admin, 'admin@test.invalid'), (:owner, 'owner@test.invalid'), (:owner2, 'owner2@test.invalid'), (:agent, 'agent@test.invalid');
insert into public.clients (id, name, owner, phone, city, wallet_balance) values (:store, 'Test Scents', 'Owner One', '03001112222', 'Karachi', 500), (:store2, 'Quiet Store', 'Owner Two', '03003334444', 'Lahore', 0);
insert into public.profiles (id, email, role, client_id) values (:admin, 'admin@test.invalid', 'admin', null), (:owner, 'owner@test.invalid', 'client', :store),
  (:owner2, 'owner2@test.invalid', 'client', :store2), (:agent, 'agent@test.invalid', 'support', null);
insert into public.cs_agents (id, full_name, auth_user_id) values ('00000000-0000-4000-8000-0000000a6e01', 'Sara', :agent);
insert into public.cs_shifts (agent_id) values ('00000000-0000-4000-8000-0000000a6e01');
insert into public.parcels (id, awb, client_id, consignee, phone, city, address, status, cod_amount, fee, exception, status_since, meta) values
  ('00000000-0000-4000-8000-000000000101', 'N1', :store, 'Ayesha', '03001234567', 'Lahore', 'House 1, A street', 'Refused', 2500, 250, 'Changed mind', now() - interval '1 day', '{}'),
  ('00000000-0000-4000-8000-000000000102', 'N2', :store, 'Bilal', '03007654321', 'Karachi', 'Flat 2, B street', 'Refused', 900, 225, '', now() - interval '2 days', '{"reattemptRequestedAt":"2026-10-07T10:00:00Z"}'),
  ('00000000-0000-4000-8000-000000000103', 'N3', :store, 'Sana', '03001112223', 'Lahore', 'House 3, C street', 'Parcel out for delivery', 4000, 250, '', now(), '{}'),
  ('00000000-0000-4000-8000-000000000104', 'N4', :store, 'Omar', '03001112224', 'Lahore', 'House 4, D street', 'Return to shipper', 1000, 250, '', now() - interval '6 days', '{}');

-- 1. What every login is told about free calls.
select pg_temp.eq('agent without Resell still learns free calls are on', pg_temp.as_user(:agent, 'select (public.cs_recover_peek()->>''show'') || ''/'' || (public.cs_recover_peek()->>''free_calls'')'), 'false/true');

-- 2. Settings.
select pg_temp.has('merchant cannot list merchants', pg_temp.as_user(:owner, 'select public.cs_recover_merchants()::text'), 'Only NovaX admins');
select pg_temp.eq('only merchants with something to recover are listed', pg_temp.as_user(:admin, 'select jsonb_array_length(public.cs_recover_merchants())::text'), '1');
select pg_temp.eq('with how many parcels', pg_temp.as_user(:admin, 'select public.cs_recover_merchants()->0->>''to_recover'''), '3');
select pg_temp.has('a silly fee is refused in words', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"fee":-5}'')::text'), 'whole number of rupees');
select pg_temp.has('a bad switch is refused in words', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"maybe"}'')::text'), 'off, chosen or all');
select pg_temp.has('a positive wallet limit is refused', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"wallet_floor":50}'')::text'), 'zero or below');
select pg_temp.eq('choose one merchant', pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"merchant_tab":"chosen","chosen_clients":["00000000-0000-4000-8000-00000000c001"]}'')->>''merchant_tab'''), 'chosen');
select pg_temp.eq('it shows as chosen', pg_temp.as_user(:admin, 'select public.cs_recover_merchants()->0->>''chosen'''), 'true');
select pg_temp.eq('emails start off', pg_temp.as_user(:admin, 'select public.cs_recover_config_get()->>''emails'''), 'false');
-- 2b. The launch email: counted first, sent once, only to merchants who have not started.
select pg_temp.eq('the Home card knows what the parcels are worth', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''to_recover_cod'''), '4400');
select pg_temp.has('a merchant cannot send the launch email', pg_temp.as_user(:owner, 'select public.cs_recover_announce(true)::text'), 'Only NovaX admins');
select pg_temp.eq('one merchant would get it', pg_temp.as_user(:admin, 'select public.cs_recover_announce(false)->>''ready'''), '1');
select pg_temp.eq('counting sends nothing', (select count(*)::text from public.nv_email_queue), '0');
select pg_temp.has('it cannot be sent while emails are off', pg_temp.as_user(:admin, 'select public.cs_recover_announce(true)::text'), 'Turn on');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"emails":true}'')::text');
select pg_temp.eq('sent to the one merchant', pg_temp.as_user(:admin, 'select public.cs_recover_announce(true)->>''sent'''), '1');
select pg_temp.eq('with their own count and value', (select (payload->>'count') || '/' || (payload->>'cod') || '/' || recipient from public.nv_email_queue where kind = 'recover_launch'), '3/4400/owner@test.invalid');
select pg_temp.eq('a second press sends nothing more', pg_temp.as_user(:admin, 'select (r->>''sent'') || ''/'' || (r->>''already_sent'') from public.cs_recover_announce(true) r'), '0/1');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"emails":false}'')::text');
delete from public.nv_email_queue where kind = 'recover_launch';
select pg_temp.eq('merchant accepts at Rs 100', pg_temp.as_user(:owner, 'select public.client_recover_accept(''2026-10-08'')->>''accepted'''), 'true');
select pg_temp.eq('changing the fee makes a new wording version', pg_temp.as_user(:admin, 'select (public.cs_recover_config_set(''{"fee":150}'')->>''terms_version'' <> ''2026-10-08'')::text'), 'true');
select pg_temp.eq('so the merchant must agree again', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'false');
select pg_temp.eq('and sees the new price', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''fee'''), '150');
select pg_temp.has('and cannot send parcels until then', pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)::text'), 'Start recovering');
select pg_temp.as_user(:owner, 'select public.client_recover_accept(public.client_recover_state()->>''terms_version'')::text');
select pg_temp.eq('the merchant agrees at Rs 150', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'true');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"fee":200}'')::text');
select pg_temp.eq('a second change in the same moment still asks again', pg_temp.as_user(:owner, 'select (s->>''accepted'') || ''/'' || (s->>''fee'') from public.client_recover_state() s'), 'false/200');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"fee":150}'')::text');
select pg_temp.eq('going back to a price they agreed to earlier still asks again', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''accepted'''), 'false');
select pg_temp.eq('saving the same fee keeps the version', pg_temp.as_user(:admin, 'select (public.cs_recover_config_set(''{"fee":150}'')->>''terms_version'') = (public.cs_recover_config_get()->>''terms_version'')'), 'true');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"fee":100}'')::text');
select pg_temp.as_user(:owner, 'select public.client_recover_accept(public.client_recover_state()->>''terms_version'')::text');

-- 3. The refusal notice on Home.
select pg_temp.eq('one refused parcel waits for a decision', pg_temp.as_user(:owner, 'select jsonb_array_length(public.client_recover_state()->''refused'')::text'), '1');
select pg_temp.eq('it is the one with no reattempt asked', pg_temp.as_user(:owner, 'select public.client_recover_state()->''refused''->0->>''awb'''), 'N1');
select pg_temp.eq('merchant is told free calls are still on', pg_temp.as_user(:owner, 'select public.client_recover_state()->>''free_calls'''), 'true');
select pg_temp.eq('send it to Recover', pg_temp.as_user(:owner, 'select public.client_recover_push(array[''00000000-0000-4000-8000-000000000101'']::uuid[], 0, true)->>''pushed'''), '1');
select pg_temp.eq('then it leaves the notice', pg_temp.as_user(:owner, 'select jsonb_array_length(public.client_recover_state()->''refused'')::text'), '0');

-- 4. Emails: nothing until switched on, then one a day per merchant on a refusal, one per recovered order.
update public.parcels set status = 'Refused', status_since = now() where awb = 'N3';
select pg_temp.eq('no email while the email switch is off', (select count(*)::text from public.nv_email_queue), '0');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"emails":true}'')::text');
update public.parcels set status = 'Parcel out for delivery' where awb = 'N3';
update public.parcels set status = 'Refused', status_since = now() where awb = 'N3';
select pg_temp.eq('no refusal email while NovaX still calls for free', (select count(*)::text from public.nv_email_queue), '0');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"free_calls":false}'')::text');
update public.parcels set status = 'Parcel out for delivery' where awb = 'N3';
update public.parcels set status = 'Refused', status_since = now() where awb = 'N3';
select pg_temp.eq('a refusal now queues an email to the owner', (select kind || ' ' || recipient || ' ' || (payload->>'awb') from public.nv_email_queue), 'recover_refused owner@test.invalid N3');
insert into public.parcels (id, awb, client_id, consignee, city, status, cod_amount) values ('00000000-0000-4000-8000-000000000109', 'N9', :store, 'Late', 'Lahore', 'Parcel out for delivery', 700);
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('a second refusal the same day does not send another', (select count(*)::text from public.nv_email_queue), '1');
insert into public.parcels (id, awb, client_id, consignee, city, status, cod_amount) values ('00000000-0000-4000-8000-000000000201', 'M1', :store2, 'Else', 'Lahore', 'Parcel out for delivery', 700);
update public.parcels set status = 'Refused' where awb = 'M1';
select pg_temp.eq('a merchant without the tab gets no email', (select count(*)::text from public.nv_email_queue), '1');
select pg_temp.as_user(:admin, 'select public.cs_recover_config_set(''{"desk":"agents"}'')::text');
select pg_temp.eq('an agent cannot read the cases table directly',
  pg_temp.as_user(:agent, 'select public.cs_recover_complete((select k.id from public.nv_recover_cases k where k.awb = ''N1''), ''Ayesha'', ''03001234567'', ''House 1, A street'', ''Lahore'', 2500, current_date + 1)->>''status'''), 'ERR: permission denied for table nv_recover_cases');
create temp table c as select awb, id from public.nv_recover_cases; grant select on c to authenticated;
select pg_temp.eq('agent recovers the order (by id)',
  pg_temp.as_user(:agent, 'select public.cs_recover_complete((select id from c where awb = ''N1''), ''Ayesha'', ''03001234567'', ''House 1, A street'', ''Lahore'', 2500, current_date + 1)->>''status'''), 'recovered');
select pg_temp.eq('that queues a "recovered" email', (select (payload->>'awb') || ' ' || (payload->>'fee') || ' ' || (payload->>'mode') from public.nv_email_queue where kind = 'recover_won'), 'N1 100 resend');
insert into public.client_notification_prefs (client_id, events) values (:store, '["booked", "delivered"]');
update public.parcels set status = 'Parcel out for delivery' where awb = 'N9';
delete from public.nv_email_queue where kind = 'recover_refused'; delete from public.nv_email_milestones where event_key like 'recover_refused:%';
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('a merchant who unticked "refused" news gets no refusal email', (select count(*)::text from public.nv_email_queue where kind = 'recover_refused'), '0');
update public.client_notification_prefs set events = '["refused"]' where client_id = :store;
update public.parcels set status = 'Parcel out for delivery' where awb = 'N9';
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('with "refused" ticked and email on, it is sent', (select count(*)::text from public.nv_email_queue where kind = 'recover_refused'), '1');
update public.client_notification_prefs set email_enabled = false where client_id = :store;
update public.parcels set status = 'Parcel out for delivery' where awb = 'N9';
delete from public.nv_email_queue where kind = 'recover_refused'; delete from public.nv_email_milestones where event_key like 'recover_refused:%';
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('a merchant who turned email off gets none', (select count(*)::text from public.nv_email_queue where kind = 'recover_refused'), '0');
alter table public.client_notification_prefs rename to client_notification_prefs_gone;
update public.parcels set status = 'Parcel out for delivery' where awb = 'N9';
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('if the email choice cannot be read, no email is sent', (select count(*)::text from public.nv_email_queue where kind = 'recover_refused'), '0');
alter table public.client_notification_prefs_gone rename to client_notification_prefs;
drop table public.nv_email_milestones cascade;
update public.parcels set status = 'Parcel out for delivery' where awb = 'N9';
update public.parcels set status = 'Refused' where awb = 'N9';
select pg_temp.eq('a broken email queue never blocks the parcel update', (select status from public.parcels where awb = 'N9'), 'Refused');

-- 5. The Reports summary.
select pg_temp.eq('summary: one recovered', pg_temp.as_user(:owner, 'select public.client_recover_summary(current_date - 1, current_date + 1)->>''recovered'''), '1');
select pg_temp.eq('summary: its COD and fee', pg_temp.as_user(:owner, 'select (s->>''cod'') || ''/'' || (s->>''fees'') from public.client_recover_summary(current_date - 1, current_date + 1) s'), '2500/100');
select pg_temp.eq('summary: outside the period, nothing', pg_temp.as_user(:owner, 'select public.client_recover_summary(current_date - 30, current_date - 10)->>''recovered'''), '0');
update public.parcels set status = 'Delivered', delivered_at = now() + interval '1 hour' where awb = 'N1';
select pg_temp.eq('summary: delivered after recovery', pg_temp.as_user(:owner, 'select public.client_recover_summary(null, null)->>''delivered'''), '1');
select pg_temp.eq('summary: another store sees nothing', pg_temp.as_user(:owner2, 'select public.client_recover_summary(null, null)->>''visible'''), 'false');
rollback;
\echo Nova Recover phase 3: all database tests passed.
