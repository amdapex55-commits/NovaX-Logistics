-- Nova Instant money tests. Runs every wallet flow against the real database
-- inside one transaction and ROLLS IT BACK: nothing is kept. Stops at the
-- first wrong number. Run with scripts/test-instant-wallets.sh.
--
-- Covers: role value, full COD, short COD settled later (correction posted),
-- short COD written off, cash fare, commission on a moved parcel, duplicate
-- deposit retry, duplicate transaction ID, partial then full deposit with COD
-- release, withdrawal hold and payout, second withdrawal refused, switches
-- off, client hold, rider removal while owing and after settling, legacy cash
-- not counted for booked jobs, unconfirmed booking expiry, ledger totals.
\set ON_ERROR_STOP 1
\set QUIET 1
begin;
set local lock_timeout = '5s';

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
create function pg_temp.job(code text, rider uuid, payer text, fare int, cod int, client uuid, status text default 'Picked up') returns uuid language sql as $$
  insert into public.nvi_jobs (code, status, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address, sender_name, sender_phone,
    receiver_name, receiver_phone, item, payer, distance_m, distance_source, fare, rider_id, assigned_at, picked_at, cod_amount, client_id, confirmed_at)
  values ($1, $7, 24.86, 67.06, 24.81, 67.03, 'Shop 1, Test Road', 'House 2, Test Street', 'Test Sender', '03001110000',
    'Test Receiver', '03211110000', 'Test parcel', $3, 5000, 'road', $4, $2, now(), now(), $5, $6, now())
  returning id
$$;

select pg_temp.is('role instant_client exists', 'instant_client'::public.novax_role::text, 'instant_client');

-- People: two checked riders, one client, one admin (the first admin profile).
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at)
values ('Test Rider A', 'a@test.invalid', '03000000101', 'Active', gen_random_uuid(), now(), now()) returning id as ra, auth_user_id as ua \gset
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at)
values ('Test Rider B', 'b@test.invalid', '03000000102', 'Active', gen_random_uuid(), now(), now()) returning id as rb, auth_user_id as ub \gset
insert into public.nvi_clients (auth_user_id, full_name, phone) values (gen_random_uuid(), 'Test Client', '03000000201') returning id as k, auth_user_id as uk \gset
select id as admin from public.profiles where role::text = 'admin' limit 1 \gset
update public.nvi_config set commission_pct = 20, cod_fee = 0, min_withdraw = 500, cod_enabled = true, withdrawals_enabled = true where id;

-- 1. Full COD: Rs 3,000 collected, fare 258, commission 52.
select pg_temp.job('T-COD1', :'ra', 'receiver', 258, 3000, :'k') as j1 \gset
select public.nvi_settle(:'j1', :'ra', 3000, 3000, null, 'fare', 'rider');
update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = :'j1';
select pg_temp.eq('COD: rider owes', pg_temp.bal('rider', :'ra'), -2794);
select pg_temp.eq('COD: client pending', pg_temp.bal('client', :'k', 'pending'), 2742);
select pg_temp.is('COD: cash settled by the ledger', (select bool_and(by_ledger)::text from public.nvi_cash where job_id = :'j1'), 'true');
update public.nvi_jobs set status = 'Delivered' where id = :'j1';   -- a second write must not post twice
select pg_temp.eq('COD: posted once', (select count(*) from public.nvi_txns where job_id = :'j1'), 1);

-- 2. Short COD, settled later: Rs 1,500 of 2,000 at the door, then Rs 2,000 in full.
select pg_temp.job('T-COD2', :'rb', 'receiver', 200, 2000, :'k') as j2 \gset
select public.nvi_settle(:'j2', :'rb', 2000, 1500, 'receiver short', 'fare', 'rider');
update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = :'j2';
select pg_temp.eq('short COD: rider owes', pg_temp.bal('rider', :'rb'), -1340);
select pg_temp.eq('short COD: client pending', pg_temp.bal('client', :'k', 'pending'), 2742 + 1300);
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('settle the dispute', public.nvi_admin_pay(:'j2', 'received', 2000, 'rest collected on a second visit')->>'ok', 'true');
reset role;
select pg_temp.eq('settled: rider owes the rest too', pg_temp.bal('rider', :'rb'), -1840);
select pg_temp.eq('settled: client gets the rest', pg_temp.bal('client', :'k', 'pending'), 2742 + 1800);

-- 3. Short COD written off: the wallet keeps what was collected.
select pg_temp.job('T-COD3', :'rb', 'receiver', 100, 1000, :'k') as j3 \gset
select public.nvi_settle(:'j3', :'rb', 1000, 800, 'receiver short', 'fare', 'rider');
update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = :'j3';
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('write off', public.nvi_admin_pay(:'j3', 'writeoff', null, 'receiver will not pay more')->>'ok', 'true');
reset role;
select pg_temp.eq('written off: client pending', pg_temp.bal('client', :'k', 'pending'), 2742 + 1800 + 700);

-- 4. Cash fare picked up by A, parcel moved to B, delivered by B: two legs.
--    A took Rs 400: owes it, earns 40% (160) less 20% = 128. B earns 240 less 20% = 192. NovaX keeps 80.
select pg_temp.job('T-MOVE', :'ra', 'sender', 400, 0, null, 'Rider assigned') as j4 \gset
select public.nvi_settle(:'j4', :'ra', 400, 400, null, 'fare', 'rider');
update public.nvi_jobs set status = 'Picked up', picked_at = now() where id = :'j4';
update public.nvi_jobs set rider_id = :'rb' where id = :'j4';
update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = :'j4';
select pg_temp.eq('moved: rider A owes the cash less his leg', pg_temp.bal('rider', :'ra'), -2794 - 400 + 128);
select pg_temp.eq('moved: rider B paid for his leg', pg_temp.bal('rider', :'rb'), -1840 - 720 + 192);
select pg_temp.eq('moved: NovaX keeps 80', (select commission from public.nvi_jobs where id = :'j4'), 80);
select pg_temp.is('moved: commission rider recorded', (select commission_rider::text from public.nvi_jobs where id = :'j4'), :'ra');

-- 5. Legacy cash only counts jobs the ledger has not booked.
select pg_temp.eq('no legacy cash for booked jobs', (select count(*) from public.nvi_cash where rider_id in (:'ra', :'rb') and not by_ledger), 0);

-- 6. Deposits: a retried claim is one claim; a reused transaction ID is refused.
select pg_temp.as_user(:'ua');
set local role authenticated;
select public.nvi_rider_deposit(1000, 'JazzCash', 'TEST-TX-1', '11111111-1111-4111-8111-111111111111');
select pg_temp.is('retry same key', public.nvi_rider_deposit(1000, 'JazzCash', 'TEST-TX-1', '11111111-1111-4111-8111-111111111111')->>'already', 'true');
select pg_temp.is('same transaction ID refused', public.nvi_rider_deposit(1000, 'JazzCash', 'test-tx-1', '22222222-2222-4222-8222-222222222222')->>'reason', 'dup_ref');
reset role;
select pg_temp.eq('one claim stored', (select count(*) from public.nvi_deposits where rider_id = :'ra'), 1);

-- 7. Partial deposit releases nothing; the full amount releases the client's COD.
select id as d1 from public.nvi_deposits where rider_id = :'ra' \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_deposit(:d1, true, null, null);
reset role;
select pg_temp.eq('partial: client still pending', pg_temp.bal('client', :'k', 'available'), 0);
select pg_temp.as_user(:'ua');
set local role authenticated;
select public.nvi_rider_deposit(2066, 'Bank', 'TEST-IBFT-2', '33333333-3333-4333-8333-333333333333');
reset role;
select id as d2 from public.nvi_deposits where req_key = '33333333-3333-4333-8333-333333333333' \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_deposit(:d2, true, null, null);
reset role;
select pg_temp.eq('settled: rider A square', pg_temp.bal('rider', :'ra'), 0);
select pg_temp.eq('released: client can withdraw', pg_temp.bal('client', :'k', 'available'), 2742);

-- 8. Withdrawal: held at once, second refused, then paid.
select pg_temp.as_user(:'uk');
set local role authenticated;
select pg_temp.is('needs CNIC', public.nvi_client_withdraw(2000, 'JazzCash', 'Test Client', '03000000201', null)->>'reason', 'cnic');
select pg_temp.is('withdraw', public.nvi_client_withdraw(2000, 'JazzCash', 'Test Client', '03000000201', '4210112345671')->>'ok', 'true');
select pg_temp.is('second refused', public.nvi_client_withdraw(500, 'JazzCash', 'Test Client', '03000000201', null)->>'reason', 'open');
reset role;
select pg_temp.eq('held from the wallet', pg_temp.bal('client', :'k', 'available'), 742);
select id as p1 from public.nvi_payouts order by id desc limit 1 \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('paid needs a reference', public.nvi_admin_payout(:p1, true, null, null)->>'reason', 'need_ref');
select pg_temp.is('paid', public.nvi_admin_payout(:p1, true, 'TEST-PAID-1', null)->>'ok', 'true');
reset role;

-- 9. Switches and holds.
update public.nvi_config set withdrawals_enabled = false where id;
select pg_temp.as_user(:'uk');
set local role authenticated;
select pg_temp.is('withdrawals off', public.nvi_client_withdraw(500, 'JazzCash', 'Test Client', '03000000201', null)->>'reason', 'withdrawals_off');
reset role;
update public.nvi_config set withdrawals_enabled = true where id;
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('hold needs a reason', public.nvi_admin_set_client(:'k', true, null)->>'reason', 'need_note');
select pg_temp.is('hold', public.nvi_admin_set_client(:'k', true, 'Too many refused parcels')->>'ok', 'true');
reset role;
select pg_temp.as_user(:'uk');
set local role authenticated;
select pg_temp.is('held client sees it', public.nvi_client_me()->'client'->>'status', 'Blocked');
select pg_temp.is('held client can still withdraw', coalesce(public.nvi_client_withdraw(100, 'JazzCash', 'Test Client', '03000000201', null)->>'reason', ''), 'min');
reset role;

-- 10. Removing a rider: refused while owing, allowed once square.
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('owing rider not removed (B owes)', public.nvi_admin_set_rider(:'rb', 'Removed')->>'reason', 'rider_owes');
select pg_temp.is('square rider removed', public.nvi_admin_set_rider(:'ra', 'Removed')->>'ok', 'true');
reset role;

-- 11. An unconfirmed first booking expires.
insert into public.nvi_jobs (code, status, p_lat, p_lng, d_lat, d_lng, pickup_address, drop_address, sender_name, sender_phone,
  receiver_name, receiver_phone, item, payer, distance_m, distance_source, fare, created_at)
values ('T-OLD', 'Awaiting confirmation', 24.86, 67.06, 24.81, 67.03, 'Shop 1, Test Road', 'House 2, Test Street', 'X', '03001110001',
  'Y', '03211110001', 'Box', 'sender', 5000, 'road', 125, now() - interval '3 hours') returning id as j5 \gset
select public.nvi_expire_unconfirmed();
select pg_temp.is('expired', (select status from public.nvi_jobs where id = :'j5'), 'Cancelled');

-- 12. Route rider (on salary): everything goes to NovaX.
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, kind)
values ('Test Route Rider', 'r@test.invalid', '03000000103', 'Active', gen_random_uuid(), now(), now(), 'route') returning id as rr, auth_user_id as ur \gset
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at)
values ('Test Rider C', 'c@test.invalid', '03000000104', 'Active', gen_random_uuid(), now(), now()) returning id as rc, auth_user_id as uc \gset
select pg_temp.job('T-ROUTE', :'rr', 'sender', 300, 0, null, 'Rider assigned') as j6 \gset
select public.nvi_settle(:'j6', :'rr', 300, 300, null, 'fare', 'rider');
update public.nvi_jobs set status = 'Picked up', picked_at = now(), pickup_rider = :'rr' where id = :'j6';
update public.nvi_jobs set status = 'Delivered', delivered_at = now() where id = :'j6';
select pg_temp.eq('route rider owes the whole fare', pg_temp.bal('rider', :'rr'), -300);
select pg_temp.eq('route rider earns nothing per job', (select earn_delivery from public.nvi_jobs where id = :'j6'), 0);

-- 13. A relay through the rider functions: C picks up (sender pays 300), hands to the route rider.
select pg_temp.job('T-RELAY', :'rc', 'sender', 300, 0, null, 'Rider assigned') as j7 \gset
select pg_temp.as_user(:'uc');
set local role authenticated;
select pg_temp.is('C picks up', public.nvi_rider_picked(:'j7', 300)->>'ok', 'true');
reset role;
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('relay to self refused', public.nvi_admin_relay(:'j7', :'rc', null)->>'reason', 'same_rider');
select pg_temp.is('relay planned', public.nvi_admin_relay(:'j7', :'rr', 'near Teen Talwar')->>'ok', 'true');
reset role;
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.eq('route rider sees it coming', jsonb_array_length(public.nvi_rider_feed()->'incoming'), 1);
select pg_temp.is('no code yet', public.nvi_rider_relay_take(:'j7', '1234')->>'reason', 'code_old');
reset role;
select pg_temp.as_user(:'uc');
set local role authenticated;
select public.nvi_rider_relay_code(:'j7')->>'code' as code \gset
reset role;
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.is('wrong code', public.nvi_rider_relay_take(:'j7', case when :'code' = '0000' then '1111' else '0000' end)->>'reason', 'wrong_code');
select pg_temp.is('right code', public.nvi_rider_relay_take(:'j7', :'code')->>'ok', 'true');
select pg_temp.is('second take is the same', public.nvi_rider_relay_take(:'j7', :'code')->>'already', 'true');
reset role;
select pg_temp.is('parcel is with the route rider', (select rider_id::text from public.nvi_jobs where id = :'j7'), :'rr');
select pg_temp.is('handover recorded', (select handover_from::text from public.nvi_jobs where id = :'j7'), :'rc');
select delivery_pin as pin7 from public.nvi_jobs where id = :'j7' \gset
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.is('route rider delivers', public.nvi_rider_delivered(:'j7', :'pin7', null, null)->>'ok', 'true');
reset role;
-- C took 300: owes it, earns 40% = 120 less 20% = 96. Route rider earns nothing. NovaX keeps 204.
select pg_temp.eq('relay: C owes the cash less his leg', pg_temp.bal('rider', :'rc'), -300 + 96);
select pg_temp.eq('relay: route rider unchanged', pg_temp.bal('rider', :'rr'), -300);
select pg_temp.eq('relay: NovaX keeps 204', (select commission from public.nvi_jobs where id = :'j7'), 204);

-- 14. A COD relay: C picks up, the route rider collects Rs 2,000 at the door (fare 200).
select pg_temp.job('T-RELAYCOD', :'rc', 'receiver', 200, 2000, :'k', 'Rider assigned') as j8 \gset
select pg_temp.as_user(:'uc');
set local role authenticated;
select public.nvi_rider_picked(:'j8', null);
reset role;
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_relay(:'j8', :'rr', null);
reset role;
select pg_temp.as_user(:'uc');
set local role authenticated;
select public.nvi_rider_relay_code(:'j8')->>'code' as code2 \gset
reset role;
select delivery_pin as pin8 from public.nvi_jobs where id = :'j8' \gset
select pg_temp.as_user(:'ur');
set local role authenticated;
select public.nvi_rider_relay_take(:'j8', :'code2');
select pg_temp.is('COD collected at the door', public.nvi_rider_delivered(:'j8', :'pin8', 2000, null)->>'ok', 'true');
reset role;
select pg_temp.eq('relay COD: route rider owes the COD', pg_temp.bal('rider', :'rr'), -300 - 2000);
select pg_temp.eq('relay COD: C paid 80 less 20% = 64', pg_temp.bal('rider', :'rc'), -204 + 64);
select pg_temp.eq('relay COD: NovaX keeps 136', (select commission from public.nvi_jobs where id = :'j8'), 136);

-- 15. A refused relay stays with the giving rider.
select pg_temp.job('T-REFUSE', :'rc', 'sender', 150, 0, null, 'Picked up') as j9 \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select public.nvi_admin_relay(:'j9', :'rr', null);
reset role;
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.is('refuse needs a note', public.nvi_rider_relay_refuse(:'j9', null)->>'reason', 'need_note');
select pg_temp.is('refused', public.nvi_rider_relay_refuse(:'j9', 'Bike puncture, cannot come')->>'ok', 'true');
reset role;
select pg_temp.is('still with C', (select rider_id::text from public.nvi_jobs where id = :'j9'), :'rc');

-- 16. Relay reservations are real reservations, and every escape path cleans them up.
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, online)
values ('Test Rider D', 'd@test.invalid', '03000000105', 'Active', gen_random_uuid(), now(), now(), true) returning id as rd, auth_user_id as ud \gset
insert into public.nvi_riders (full_name, email, phone, status, auth_user_id, docs_at, docs_checked_at, online)
values ('Test Rider E', 'e@test.invalid', '03000000106', 'Active', gen_random_uuid(), now(), now(), true) returning id as re, auth_user_id as ue \gset
select pg_temp.job('T-RESERVE', :'rd', 'sender', 150, 0, null, 'Rider assigned') as j10 \gset
select pg_temp.job('T-OPEN', null, 'sender', 150, 0, null, 'Booked') as j11 \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('relay reserves receiver', public.nvi_admin_relay(:'j10', :'rr', null)->>'ok', 'true');
select pg_temp.is('reserved rider cannot be assigned elsewhere', public.nvi_admin_assign(:'j11', :'rr', null)->>'reason', 'relay_busy');
select pg_temp.is('cannot uncheck reserved rider documents', public.nvi_admin_check_docs(:'rr', false)->>'reason', 'rider_has_job');
reset role;
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.is('reserved rider cannot go offline', public.nvi_rider_online(false)->>'reason', 'has_job');
reset role;
update public.nvi_riders set online = true where id = :'rr';
select pg_temp.as_user(:'ur');
set local role authenticated;
select pg_temp.is('reserved rider cannot accept another job', public.nvi_rider_accept(:'j11')->>'reason', 'busy');
reset role;
select pg_temp.as_user(:'ud');
set local role authenticated;
select pg_temp.is('giving job back works', public.nvi_rider_release(:'j10', 'sender changed the time')->>'ok', 'true');
reset role;
select pg_temp.is('release clears relay rider', coalesce((select relay_rider::text from public.nvi_jobs where id = :'j10'), ''), '');
select pg_temp.is('release clears relay state', coalesce((select relay_state from public.nvi_jobs where id = :'j10'), ''), '');
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('receiver is free after cleanup', public.nvi_admin_assign(:'j11', :'rr', null)->>'ok', 'true');
select public.nvi_admin_assign(:'j11', null, null);
reset role;
select pg_temp.job('T-EMERGENCY', :'rd', 'sender', 200, 0, null, 'Picked up') as j12 \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('emergency transfer', public.nvi_admin_assign(:'j12', :'rr', 'giving rider phone died')->>'ok', 'true');
reset role;
select pg_temp.is('emergency transfer records pickup rider', (select pickup_rider::text from public.nvi_jobs where id = :'j12'), :'rd');
select pg_temp.is('emergency transfer records handover', (select handover_from::text from public.nvi_jobs where id = :'j12'), :'rd');
update public.nvi_config set rider_cash_limit = 100 where id;
select pg_temp.job('T-LIMIT', null, 'receiver', 100, 200, :'k', 'Booked') as j13 \gset
select pg_temp.as_user(:'admin');
set local role authenticated;
select pg_temp.is('admin assignment enforces COD cash limit', public.nvi_admin_assign(:'j13', :'re', null)->>'reason', 'cash_limit');
reset role;
update public.nvi_config set rider_cash_limit = 15000 where id;

-- 17. The books balance: overall and per movement.
select pg_temp.eq('ledger sums to zero', (select coalesce(sum(amount), 0) from public.nvi_ledger), 0);
select pg_temp.eq('every movement balances', (select count(*) from (select txn_id from public.nvi_ledger group by txn_id having sum(amount) <> 0) x), 0);
select pg_temp.is('entries cannot be edited', (select 'frozen'), 'frozen');
do $$ begin
  begin update public.nvi_ledger set amount = amount + 1 where id = (select max(id) from public.nvi_ledger); raise exception 'FAIL ledger edit allowed';
  exception when insufficient_privilege then raise notice 'ok  ledger edit refused'; end;
end $$;

\echo ALL NOVA INSTANT MONEY TESTS PASSED (rolled back)
rollback;
