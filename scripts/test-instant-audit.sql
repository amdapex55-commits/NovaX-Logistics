-- Nova Instant tests for the 6 Oct 2026 audit fixes (NVI-01 to NVI-09) and
-- the booking steps from quote to delivery. One transaction, ROLLED BACK:
-- nothing is kept. Stops at the first wrong answer.
--   npm run test:instant              a throwaway Postgres on this Mac (all checks)
--   scripts/test-instant-wallets.sh   the live database, rolled back (the checks
--                                     that need a fake router, CAPTCHA or file
--                                     store are skipped there)
\set ON_ERROR_STOP 1
\set QUIET 1
begin;
set local lock_timeout = '5s';
select to_regclass('public.nvi_local_test_db') is not null as local \gset

create function pg_temp.eq(label text, got bigint, want bigint) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got %, want %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create function pg_temp.is(label text, got text, want text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got %, want %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create function pg_temp.bal(kind text, owner uuid, bucket text default 'available') returns bigint language sql as $$
  select coalesce(sum(l.amount), 0) from public.nvi_ledger l join public.nvi_wallets w on w.id = l.wallet_id
   where w.kind = $1 and w.owner = $2 and l.bucket = $3
$$;
create function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.rider(tag text, kind text default 'freelance') returns uuid language sql as $$
  insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, kind)
  values ('Audit Rider ' || $1, lower($1) || '@audit.invalid', '030011100' || lpad((ascii($1) % 100)::text, 2, '0'), 'Active', gen_random_uuid(), now(), now(), $2)
  returning id
$$;
create function pg_temp.uid(rider uuid) returns uuid language sql as $$ select auth_user_id from public.nvi_riders where id = $1 $$;
-- A receiver-pays cash job, already picked up by this rider.
create function pg_temp.job(code text, rider uuid, fare int) returns uuid language sql as $$
  insert into public.nvi_jobs (code, status, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address, sender_name, sender_phone,
    receiver_name, receiver_phone, item, payer, distance_m, distance_source, fare, rider_id, assigned_at, picked_at, confirmed_at)
  values ($1, 'Picked up', 24.86, 67.06, 24.81, 67.03, 'Shop 1, Audit Road', 'House 2, Audit Street', 'Audit Sender', '03001119000',
    'Audit Receiver', '03211119000', 'Audit parcel', 'receiver', 5000, 'road', $3, $2, now(), now(), now())
  returning id
$$;
create function pg_temp.pin(job uuid) returns text language sql as $$ select delivery_pin from public.nvi_jobs where id = $1 $$;
create function pg_temp.fund(wallet uuid, amount int) returns void language sql as $$
  select public.nvi_post('audit-fund:' || $1, 'adjustment', jsonb_build_array(
    jsonb_build_object('w', $1, 'a', $2),
    jsonb_build_object('w', public.nvi_wallet_id('house', null, 'adjustments'), 'a', -$2)), null, null, 'audit test')
$$;

select id as admin from public.profiles where role::text = 'admin' limit 1 \gset
update public.nvi_config set commission_pct = 20, min_withdraw = 500, withdrawals_enabled = true, relay_pickup_pct = 40 where id;
select pg_temp.rider('A') as ra \gset
select pg_temp.rider('B') as rb \gset
select pg_temp.rider('C') as rc \gset
select pg_temp.rider('R', 'route') as rr \gset
select pg_temp.uid(:'ra') as ua \gset
select pg_temp.uid(:'rb') as ub \gset
select pg_temp.uid(:'rc') as uc \gset
select pg_temp.uid(:'rr') as ur \gset
insert into public.nvi_clients (auth_user_id, full_name, phone) values (gen_random_uuid(), 'Audit Client', '03001119201') returning id as k, auth_user_id as uk \gset

-- ═══ NVI-01: a withdrawal sent twice is one withdrawal ═══
select public.nvi_wallet_id('client', :'k', null) as wk \gset
select pg_temp.fund(:'wk', 3000);
select pg_temp.as_user(:'uk');
set local role authenticated;
select public.nvi_client_withdraw(1000, 'JazzCash', 'Audit Client', '03001119201', '4210112345671', 'aaaaaaaa-0000-4000-8000-000000000001') as w1 \gset
select pg_temp.is('withdrawal accepted', (:'w1'::jsonb)->>'ok', 'true');
select pg_temp.is('second tap is the same withdrawal', public.nvi_client_withdraw(1000, 'JazzCash', 'Audit Client', '03001119201', null, 'aaaaaaaa-0000-4000-8000-000000000001')->>'id', (:'w1'::jsonb)->>'id');
reset role;
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('staff pay it', public.nvi_admin_payout(((:'w1'::jsonb)->>'id')::bigint, true, 'AUDIT-PAID-1', null)->>'ok', 'true');
reset role;
select pg_temp.as_user(:'uk');
set local role authenticated;
-- The audit's case: the first answer was lost, staff paid, the customer retries.
select public.nvi_client_withdraw(1000, 'JazzCash', 'Audit Client', '03001119201', null, 'aaaaaaaa-0000-4000-8000-000000000001') as w2 \gset
select pg_temp.is('retry after payment: the same one comes back', (:'w2'::jsonb)->>'id', (:'w1'::jsonb)->>'id');
select pg_temp.is('retry after payment: marked as a repeat', (:'w2'::jsonb)->>'already', 'true');
select pg_temp.is('retry after payment: says it was paid', (:'w2'::jsonb)->>'status', 'Paid');
select pg_temp.is('old page (no key), same amount again: refused', public.nvi_client_withdraw(1000, 'JazzCash', 'Audit Client', '03001119201', null)->>'reason', 'recent');
reset role;
select pg_temp.eq('one payout exists', (select count(*) from public.nvi_payouts where wallet_id = :'wk'), 1);
select pg_temp.eq('wallet charged once', pg_temp.bal('client', :'k'), 2000);
select pg_temp.as_user(:'uk');
set local role authenticated;
select pg_temp.is('a new key is a new withdrawal', public.nvi_client_withdraw(1000, 'JazzCash', 'Audit Client', '03001119201', null, 'aaaaaaaa-0000-4000-8000-000000000002')->>'ok', 'true');
select pg_temp.is('one at a time still holds', public.nvi_client_withdraw(500, 'JazzCash', 'Audit Client', '03001119201', null, 'aaaaaaaa-0000-4000-8000-000000000003')->>'reason', 'open');
reset role;
select pg_temp.is('a key that is not a key is refused', public.nvi_request_payout(:'wk', 500, 'JazzCash', 'Audit Client', '03001119201', 'not-a-key')->>'reason', 'key');
select public.nvi_wallet_id('rider', :'rb', null) as wb \gset
select pg_temp.fund(:'wb', 800);
select pg_temp.as_user(:'ub');
set local role authenticated;
select pg_temp.is('rider payout accepted', public.nvi_rider_payout(600, 'Easypaisa', 'Audit Rider B', '03001110066', 'bbbbbbbb-0000-4000-8000-000000000001')->>'ok', 'true');
select pg_temp.is('rider retry is the same payout', public.nvi_rider_payout(600, 'Easypaisa', 'Audit Rider B', '03001110066', 'bbbbbbbb-0000-4000-8000-000000000001')->>'already', 'true');
reset role;
select pg_temp.eq('rider: one payout', (select count(*) from public.nvi_payouts where wallet_id = :'wb'), 1);
select pg_temp.eq('rider: charged once', pg_temp.bal('rider', :'rb'), 200);

-- ═══ NI-21: one transaction ID pays one payout ═══
-- The client's second withdrawal (Rs 1,000, JazzCash) is waiting; the first was paid with AUDIT-PAID-1.
select id as p2 from public.nvi_payouts where wallet_id = :'wk' and status = 'Requested' \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('the same transaction ID on a second payout: refused', public.nvi_admin_payout(:p2, true, 'audit-paid-1', null)->>'reason', 'dup_ref');
select pg_temp.is('spaces and capitals do not make it new', public.nvi_admin_payout(:p2, true, ' Audit - Paid - 1 ', null)->>'reason', 'dup_ref');
reset role;
select pg_temp.is('the refused payout is still waiting', (select status from public.nvi_payouts where id = :p2), 'Requested');
select pg_temp.eq('nothing was booked for it', (select count(*) from public.nvi_txns where key = 'payout:' || :p2 || ':paid'), 0);
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('its own transaction ID: paid', public.nvi_admin_payout(:p2, true, 'AUDIT-PAID-2', null)->>'ok', 'true');
select pg_temp.eq('the money check finds no shared IDs', (public.nvi_admin_money_check()->>'dup_payout_refs')::bigint, 0);
reset role;
do $$ begin
  begin update public.nvi_payouts set ref = 'AUDIT-PAID-1' where ref = 'AUDIT-PAID-2'; raise exception 'FAIL two paid payouts share a transaction ID';
  exception when unique_violation then raise notice 'ok  the table itself refuses a shared transaction ID'; end;
end $$;

-- ═══ NI-24: a bank account is a valid Pakistani IBAN ═══
select pg_temp.is('ten letters are not a bank account', public.nvi_request_payout(:'wk', 500, 'Bank', 'Audit Client', 'AAAAAAAAAA', 'cccccccc-0000-4000-8000-000000000001')->>'reason', 'number');
select pg_temp.is('an IBAN with a wrong check digit: refused', public.nvi_request_payout(:'wk', 500, 'Bank', 'Audit Client', 'PK36SCBL0000001123456703', 'cccccccc-0000-4000-8000-000000000002')->>'reason', 'number');
select pg_temp.is('a real IBAN, typed with spaces: accepted', public.nvi_request_payout(:'wk', 500, 'Bank', 'Audit Client', 'pk36 scbl 0000 0011 2345 6702', 'cccccccc-0000-4000-8000-000000000003')->>'ok', 'true');
select pg_temp.is('and stored tidy', (select account_number from public.nvi_payouts where req_key = 'cccccccc-0000-4000-8000-000000000003'), 'PK36SCBL0000001123456702');

-- ═══ NVI-02: a cash fare is booked at the cash taken ═══
-- Nothing paid on a Rs 100 fare: the rider owes nothing, NovaX earned nothing.
select pg_temp.job('T-ZERO', :'ra', 100) as z1 \gset
select pg_temp.pin(:'z1') as pin_z1 \gset
select pg_temp.as_user(:'ua');
set local role authenticated;
select pg_temp.is('zero cash needs a note', public.nvi_rider_delivered(:'z1', :'pin_z1', 0, null)->>'reason', 'short_note');
select pg_temp.is('zero cash: delivered, flagged', public.nvi_rider_delivered(:'z1', :'pin_z1', 0, 'receiver had no cash')->>'disputed', 'true');
reset role;
select pg_temp.eq('zero cash: rider owes nothing', pg_temp.bal('rider', :'ra'), 0);
select pg_temp.eq('zero cash: no commission booked', (select commission from public.nvi_jobs where id = :'z1'), 0);
select pg_temp.is('zero cash: waiting for ops', (select pay_state from public.nvi_jobs where id = :'z1'), 'Disputed');
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('write off', public.nvi_admin_pay(:'z1', 'writeoff', null, 'receiver refuses to pay')->>'ok', 'true');
reset role;
select pg_temp.eq('written off: still nothing owed', pg_temp.bal('rider', :'ra'), 0);
select pg_temp.eq('written off: no money moved for the job', (select count(*) from public.nvi_ledger l join public.nvi_txns t on t.id = l.txn_id where t.job_id = :'z1'), 0);

-- Rs 60 of Rs 100: the rider owes the 60 and keeps 48 of it; NovaX keeps 12.
select pg_temp.job('T-PART', :'ra', 100) as z2 \gset
select pg_temp.pin(:'z2') as pin_z2 \gset
select pg_temp.as_user(:'ua');
set local role authenticated;
select pg_temp.is('part paid: delivered', public.nvi_rider_delivered(:'z2', :'pin_z2', 60, 'receiver was short')->>'ok', 'true');
reset role;
select pg_temp.eq('part paid: rider owes commission on 60', pg_temp.bal('rider', :'ra'), -12);
select pg_temp.eq('part paid: NovaX keeps 12', (select commission from public.nvi_jobs where id = :'z2'), 12);
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('ops: the rest was collected', public.nvi_admin_pay(:'z2', 'received', 100, 'receiver paid the rest next day')->>'ok', 'true');
reset role;
select pg_temp.eq('settled in full: rider owes commission on 100', pg_temp.bal('rider', :'ra'), -20);
select pg_temp.eq('settled in full: NovaX keeps 20', (select commission from public.nvi_jobs where id = :'z2'), 20);
select pg_temp.eq('settled in full: one correction posted', (select count(*) from public.nvi_txns where job_id = :'z2' and kind = 'fare_correction'), 1);

-- Paid in full: unchanged.
select pg_temp.job('T-FULL', :'ra', 100) as z3 \gset
select pg_temp.pin(:'z3') as pin_z3 \gset
select pg_temp.as_user(:'ua');
set local role authenticated;
select pg_temp.is('paid in full: delivered', public.nvi_rider_delivered(:'z3', :'pin_z3', 100, null)->>'ok', 'true');
reset role;
select pg_temp.eq('paid in full: rider owes 20 more', pg_temp.bal('rider', :'ra'), -40);

-- A route rider (salary): owes exactly the cash taken, never the fare unpaid.
select pg_temp.job('T-RZERO', :'rr', 100) as z4 \gset
select pg_temp.pin(:'z4') as pin_z4 \gset
select pg_temp.as_user(:'ur');
set local role authenticated;
select public.nvi_rider_delivered(:'z4', :'pin_z4', 0, 'receiver had no cash');
reset role;
select pg_temp.eq('route rider, nothing paid: owes nothing', pg_temp.bal('rider', :'rr'), 0);
select pg_temp.job('T-RPART', :'rr', 100) as z5 \gset
select pg_temp.pin(:'z5') as pin_z5 \gset
select pg_temp.as_user(:'ur');
set local role authenticated;
select public.nvi_rider_delivered(:'z5', :'pin_z5', 60, 'receiver was short');
reset role;
select pg_temp.eq('route rider, Rs 60 paid: owes 60', pg_temp.bal('rider', :'rr'), -60);
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_pay(:'z5', 'writeoff', null, 'receiver will not pay more');
reset role;
select pg_temp.eq('route rider, written off: still owes only 60', pg_temp.bal('rider', :'rr'), -60);
select pg_temp.eq('route rider, written off: NovaX booked 60', (select commission from public.nvi_jobs where id = :'z5'), 60);

-- Two riders, paid short at the door: C picked up, the route rider took Rs 150 of 300.
select pg_temp.job('T-LEGS', :'rc', 300) as z6 \gset
select pg_temp.pin(:'z6') as pin_z6 \gset
update public.nvi_jobs set pickup_rider = :'rc', rider_id = :'rr' where id = :'z6';
select pg_temp.as_user(:'ur');
set local role authenticated;
select public.nvi_rider_delivered(:'z6', :'pin_z6', 150, 'receiver paid half');
reset role;
select pg_temp.eq('two legs, half paid: route rider owes the 150', pg_temp.bal('rider', :'rr'), -60 - 150);
select pg_temp.eq('two legs, half paid: C paid on half his leg (60 less 20%)', pg_temp.bal('rider', :'rc'), 48);
select pg_temp.eq('two legs, half paid: NovaX keeps 102', (select commission from public.nvi_jobs where id = :'z6'), 102);
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_pay(:'z6', 'received', 300, 'receiver paid the rest');
reset role;
select pg_temp.eq('two legs, settled: route rider owes the 300', pg_temp.bal('rider', :'rr'), -60 - 300);
select pg_temp.eq('two legs, settled: C paid on his whole leg (120 less 20%)', pg_temp.bal('rider', :'rc'), 96);
select pg_temp.eq('two legs, settled: NovaX keeps 204', (select commission from public.nvi_jobs where id = :'z6'), 204);

-- ═══ NVI-08: a login is a customer or a rider, never both ═══
select pg_temp.as_user(:'ua');
set local role authenticated;
select pg_temp.is('a rider login cannot open a customer account', public.nvi_client_save('Audit Rider A', '03001119301', null)->>'reason', 'novax_login');
reset role;
do $$ begin
  begin
    insert into public.nvi_riders (full_name, email, phone, status, auth_user_id)
    select 'Both Sides', 'both@audit.invalid', '03001119302', 'Active', auth_user_id from public.nvi_clients where full_name = 'Audit Client';
    raise exception 'FAIL a customer login became a rider';
  exception when insufficient_privilege then raise notice 'ok  a customer login cannot be put on the rider list'; end;
  begin
    insert into public.nvi_clients (auth_user_id, full_name, phone)
    select auth_user_id, 'Both Sides', '03001119303' from public.nvi_riders where email = 'a@audit.invalid';
    raise exception 'FAIL a rider login became a customer';
  exception when insufficient_privilege then raise notice 'ok  a rider login cannot be put on the customer list'; end;
end $$;
\if :local
  -- An invited rider whose email already has a customer account.
  insert into auth.users (id, email) values (:'uk', 'client@audit.invalid');
  insert into public.profiles (id, email, role) values (:'uk', 'client@audit.invalid', 'client');
  insert into public.nvi_riders (full_name, email, phone, status) values ('Invited Client', 'client@audit.invalid', '03001119304', 'Invited');
  select pg_temp.as_user(:'uk');
  do $$ begin
    begin perform public.nvi_rider_join(); raise exception 'FAIL a customer joined as a rider';
    exception when insufficient_privilege then raise notice 'ok  an invited customer login is refused as a rider'; end;
  end $$;
\endif

-- ═══ NVI-09: rider document photos ═══
select pg_temp.as_user(:'uc');
set local role authenticated;
select pg_temp.is('active rider may add photos', public.nvi_is_rider()::text, 'true');
select pg_temp.is('and has room', public.nvi_docs_room()::text, 'true');
reset role;
update public.nvi_riders set cnic_path = :'uc' || '/cnic-1700000000001-abcdef01.jpg' where id = :'rc';
select pg_temp.as_user(:'uc');
set local role authenticated;
select pg_temp.is('the photo on record is not spare', public.nvi_doc_spare(:'uc' || '/cnic-1700000000001-abcdef01.jpg')::text, 'false');
select pg_temp.is('an older photo is spare', public.nvi_doc_spare(:'uc' || '/cnic-1600000000001-abcdef01.jpg')::text, 'true');
reset role;
\if :local
  select pg_temp.as_user(:'uc');
  set local role authenticated;
  insert into storage.objects (bucket_id, name) values ('nvi-rider-docs', :'uc' || '/cnic-1700000000001-abcdef01.jpg');
  insert into storage.objects (bucket_id, name) values ('nvi-rider-docs', :'uc' || '/cnic-1600000000001-abcdef01.jpg');
  with d as (delete from storage.objects where bucket_id = 'nvi-rider-docs' returning name)
  select pg_temp.is('rider can delete only the spare photo', (select string_agg(right(name, 31), ',') from d), 'cnic-1600000000001-abcdef01.jpg');
  reset role;
  insert into storage.objects (bucket_id, name) select 'nvi-rider-docs', :'uc' || '/bill-170000000000' || g || '-abcdef01.jpg' from generate_series(1, 7) g;
  select pg_temp.as_user(:'uc');
  set local role authenticated;
  do $$ begin
    begin insert into storage.objects (bucket_id, name) values ('nvi-rider-docs', (select auth.uid())::text || '/bill-1700000000099-abcdef01.jpg');
      raise exception 'FAIL a ninth photo was accepted';
    exception when insufficient_privilege then raise notice 'ok  a ninth photo is refused'; end;
  end $$;
  reset role;
  delete from storage.objects where bucket_id = 'nvi-rider-docs';
  update public.nvi_riders set status = 'Blocked' where id = :'rc';
  select pg_temp.as_user(:'uc');
  set local role authenticated;
  do $$ begin
    begin insert into storage.objects (bucket_id, name) values ('nvi-rider-docs', (select auth.uid())::text || '/bill-1700000000098-abcdef01.jpg');
      raise exception 'FAIL a paused rider added a photo';
    exception when insufficient_privilege then raise notice 'ok  a paused rider cannot add photos'; end;
  end $$;
  reset role;
\endif
update public.nvi_riders set status = 'Blocked' where id = :'rc';
select pg_temp.as_user(:'uc');
set local role authenticated;
select pg_temp.is('paused rider: not counted as a rider for photos', public.nvi_is_rider()::text, 'false');
reset role;

-- ═══ NI-31: a job alert goes only to riders who can take the job ═══
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, online, last_seen)
values ('Push Fresh', 'pf@audit.invalid', '03001110901', 'Active', gen_random_uuid(), now(), now(), true, now()) returning id as pf \gset
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, online, last_seen)
values ('Push Stale', 'ps@audit.invalid', '03001110902', 'Active', gen_random_uuid(), now(), now(), true, now() - interval '3 days') returning id as ps \gset
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, online, last_seen)
values ('Push Reserved', 'pr@audit.invalid', '03001110903', 'Active', gen_random_uuid(), now(), now(), true, now()) returning id as pr \gset
insert into public.nvi_push_subs (rider_id, endpoint) values (:'pf', 'https://push.invalid/fresh'), (:'ps', 'https://push.invalid/stale'), (:'pr', 'https://push.invalid/reserved');
select pg_temp.job('T-PUSHRELAY', :'ra', 150) as zr \gset
update public.nvi_jobs set relay_rider = :'pr', relay_state = 'planned' where id = :'zr';
insert into public.nvi_jobs (code, status, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address, sender_name, sender_phone,
  receiver_name, receiver_phone, item, payer, distance_m, distance_source, fare, confirmed_at)
values ('T-PUSH', 'Booked', 24.86, 67.06, 24.81, 67.03, 'Shop 1, Audit Road', 'House 2, Audit Street', 'Audit Sender', '03001119500',
  'Audit Receiver', '03211119500', 'Audit parcel', 'sender', 5000, 'road', 125, now()) returning id as zp \gset
update public.nvi_jobs set push_at = null where id = :'zp';
select public.nvi_push_targets(:'zp') as targets \gset
select pg_temp.is('the rider on duty and free is alerted', ((:'targets')::jsonb @> '[{"endpoint":"https://push.invalid/fresh"}]')::text, 'true');
select pg_temp.is('a rider not seen for three days is not', ((:'targets')::jsonb @> '[{"endpoint":"https://push.invalid/stale"}]')::text, 'false');
select pg_temp.is('a rider kept for a relay is not', ((:'targets')::jsonb @> '[{"endpoint":"https://push.invalid/reserved"}]')::text, 'false');
update public.nvi_jobs set relay_rider = null, relay_state = null where id = :'zr';
update public.nvi_riders set online = false where id in (:'pf', :'ps', :'pr');

-- ═══ NVI-05: the rules version on record ═══
select pg_temp.is('rules version', (select terms_version from public.nvi_config where id), '1.2');

\if :local
  -- ═══ NVI-07: one address cannot use up everybody's road lookups ═══
  set local nvi_test.route = '9000';
  select set_config('request.jwt.claims', '', true);
  select set_config('request.headers', '{"cf-connecting-ip":"203.0.113.9"}', true);
  set local role anon;
  select pg_temp.eq('twelve new roads measured for one address',
    (select count(*) from generate_series(1, 12) g where public.nvi_quote(24.86, 67.06, 24.80 + g * 0.001, 67.03)->>'source' = 'road'), 12);
  select pg_temp.is('the thirteenth in a minute is only an estimate', public.nvi_quote(24.86, 67.06, 24.83, 67.03)->>'bookable', 'false');
  select pg_temp.is('a road already measured still answers', public.nvi_quote(24.86, 67.06, 24.801, 67.03)->>'source', 'road');
  select set_config('request.headers', '{"cf-connecting-ip":"203.0.113.10"}', true);
  select pg_temp.is('another address is not affected', public.nvi_quote(24.86, 67.06, 24.83, 67.03)->>'source', 'road');
  reset role;

  -- ═══ NVI-06: a CAPTCHA answer must come from this site ═══
  select pg_temp.is('CAPTCHA off: passes', public.nvi_captcha_ok(null)::text, 'true');
  update public.nvi_config set turnstile_site = 'site-key', turnstile_secret = 'secret-key' where id;
  set local nvi_test.captcha = '{"success":true,"hostname":"evil.example","action":"nvi_book"}';
  select pg_temp.is('solved on another site: refused', public.nvi_captcha_ok('0123456789abcdef')::text, 'false');
  set local nvi_test.captcha = '{"success":true,"hostname":"novaxlogistics.com","action":"login"}';
  select pg_temp.is('solved for another form: refused', public.nvi_captcha_ok('0123456789abcdef')::text, 'false');
  set local nvi_test.captcha = '{"success":true,"hostname":"novaxlogistics.com","action":"nvi_book"}';
  select pg_temp.is('solved here: accepted', public.nvi_captcha_ok('0123456789abcdef')::text, 'true');
  select pg_temp.is('no answer: refused', public.nvi_captcha_ok(null)::text, 'false');
  update public.nvi_config set turnstile_site = null, turnstile_secret = null where id;

  -- ═══ The booking steps, quote to delivery ═══
  update public.nvi_config set open = true, open_hour = 0, close_hour = 0, confirm_first = true where id;
  update public.nvi_riders set online = false;
  select set_config('request.headers', '{"cf-connecting-ip":"203.0.113.20"}', true);
  set local role anon;
  select public.nvi_quote(24.86, 67.06, 24.801, 67.03) as q \gset
  select pg_temp.is('quote can be booked', (:'q'::jsonb)->>'bookable', 'true');
  select pg_temp.is('no rider on duty: booking refused', public.nvi_book(((:'q'::jsonb)->>'quote')::uuid, 'Shop 1, Audit Road', 'House 2, Audit Street',
    'Audit Sender', '03001119400', 'Audit Receiver', '03211119400', 'Audit parcel', 'sender', null, true, 'audit-device', null, 'home', 0)->>'reason', 'no_rider');
  reset role;
  update public.nvi_riders set online = true, last_seen = now() where id = :'rb';
  set local role anon;
  select pg_temp.is('rules not accepted: refused', public.nvi_book(((:'q'::jsonb)->>'quote')::uuid, 'Shop 1, Audit Road', 'House 2, Audit Street',
    'Audit Sender', '03001119400', 'Audit Receiver', '03211119400', 'Audit parcel', 'sender', null, false, 'audit-device', null, 'home', 0)->>'reason', 'terms');
  select public.nvi_book(((:'q'::jsonb)->>'quote')::uuid, 'Shop 1, Audit Road', 'House 2, Audit Street',
    'Audit Sender', '03001119400', 'Audit Receiver', '03211119400', 'Audit parcel', 'sender', null, true, 'audit-device', null, 'home', 0) as b \gset
  select pg_temp.is('first booking waits for a call', (:'b'::jsonb)->>'status', 'Awaiting confirmation');
  select pg_temp.is('the same request again is the same booking', public.nvi_book(((:'q'::jsonb)->>'quote')::uuid, 'Shop 1, Audit Road', 'House 2, Audit Street',
    'Audit Sender', '03001119400', 'Audit Receiver', '03211119400', 'Audit parcel', 'sender', null, true, 'audit-device', null, 'home', 0)->>'code', (:'b'::jsonb)->>'code');
  reset role;
  select id as bj, fare as bfare, delivery_pin as bpin from public.nvi_jobs where code = (:'b'::jsonb)->>'code' \gset
  select pg_temp.is('booking records the rules version', (select terms_version from public.nvi_jobs where id = :'bj'), '1.2');
  select pg_temp.as_user(:'ub');
  set local role authenticated;
  select pg_temp.is('unconfirmed job cannot be taken', public.nvi_rider_accept(:'bj')->>'reason', 'taken');
  reset role;
  select pg_temp.as_user(:'admin');
  set local role authenticated;
  select pg_temp.is('ops confirm by phone', public.nvi_admin_confirm(:'bj')->>'ok', 'true');
  reset role;
  select pg_temp.as_user(:'ub');
  set local role authenticated;
  select pg_temp.is('rider accepts', public.nvi_rider_accept(:'bj')->>'ok', 'true');
  select pg_temp.is('pickup without the fare: refused', public.nvi_rider_picked(:'bj', 0)->>'reason', 'cash_needed');
  select pg_temp.is('pickup with the fare', public.nvi_rider_picked(:'bj', :bfare)->>'ok', 'true');
  reset role;
  select set_config('request.jwt.claims', '', true);
  set local role anon;
  select pg_temp.is('cancel after pickup: too late', public.nvi_cancel((:'b'::jsonb)->>'token', (:'b'::jsonb)->>'manage')->>'reason', 'too_late');
  select pg_temp.is('tracking shows it on the way', public.nvi_track((:'b'::jsonb)->>'token')->>'status', 'Picked up');
  reset role;
  select pg_temp.as_user(:'ub');
  set local role authenticated;
  select pg_temp.is('wrong PIN: refused', public.nvi_rider_delivered(:'bj', case when :'bpin' = '0000' then '1111' else '0000' end, null, null)->>'reason', 'wrong_pin');
  select pg_temp.is('right PIN: delivered', public.nvi_rider_delivered(:'bj', :'bpin', null, null)->>'ok', 'true');
  reset role;
  select pg_temp.eq('delivered: NovaX keeps 20% of the fare', (select commission from public.nvi_jobs where id = :'bj'), round(:bfare * 0.2)::int);
  select pg_temp.is('delivered: cash marked received', (select pay_state from public.nvi_jobs where id = :'bj'), 'Received');
\endif

-- ═══ The books still balance ═══
select pg_temp.eq('ledger sums to zero', (select coalesce(sum(amount), 0) from public.nvi_ledger), 0);
select pg_temp.eq('every movement balances', (select count(*) from (select txn_id from public.nvi_ledger group by txn_id having sum(amount) <> 0) x), 0);

\echo ALL NOVA INSTANT AUDIT TESTS PASSED (rolled back)
rollback;
