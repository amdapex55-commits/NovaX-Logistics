import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The sales channel (every sql_novax_sales_*_20261002.sql, in order) on a throwaway
// local PostgreSQL with a minimal copy of the tables it reads. Never touches production.
// Google is replaced by public.test_http (the sheet the stub http_get returns).
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.ok(existsSync(path.join(bin, 'initdb')), 'Set PG_BIN to your PostgreSQL binaries.');
const dir = mkdtempSync(path.join(tmpdir(), 'novax-sales-test-'));
const data = path.join(dir, 'data');
const args = ['-h', dir, '-p', '55447', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const U = { admin: id(1), ayesha: id(2), bilal: id(3), stranger: id(4), merchant: id(5), owner1: id(11), owner2: id(12), owner3: id(13), owner4: id(14) };
const C = { one: id(101), two: id(102), three: id(103), four: id(104), test: id(105), merchant: id(106) };
// Run sql as a signed-in user (or anon when who is null); returns the last line.
// Through the API: connected as authenticator, then SET ROLE, exactly like PostgREST.
const qApi = sql => execFileSync(path.join(bin, 'psql'), [...args, '-U', 'authenticator'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const as = (who, sql) => qApi(`select set_config('request.jwt.claims', json_build_object('sub','${who ? U[who] : ''}','role','${who ? 'authenticated' : 'anon'}')::text, false);
  set role ${who ? 'authenticated' : 'anon'}; ${sql}`).split('\n').pop();
const fails = (who, sql, re) => assert.throws(() => as(who, sql), e => re.test(String(e.stderr || e.message)), `expected ${re} from: ${sql}`);
const J = s => JSON.parse(s);

let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'pg.log'), '-o', `-c listen_addresses='' -k ${dir} -p 55447 -c timezone=UTC`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  q(`create role anon; create role authenticated; create role service_role; create role authenticator login noinherit;
    grant anon, authenticated to authenticator;
    create schema extensions; create extension pgcrypto schema extensions;
    create schema auth; grant usage on schema auth to anon, authenticated;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $$;
    create type public.novax_role as enum ('admin', 'client', 'rider');
    create table public.clients(id uuid primary key, name text, phone text, city text, created_at timestamptz default now());
    create table public.profiles(id uuid primary key, email text, full_name text, role public.novax_role default 'client', client_id uuid, rider_id uuid, status text, created_at timestamptz default now());
    create table public.client_kyc(client_id uuid primary key, status text);
    create table public.parcels(id uuid primary key default gen_random_uuid(), client_id uuid, status text);
    create table public.nv_parcel_status_log(id bigserial primary key, parcel_id uuid, client_id uuid, from_status text, to_status text, changed_at timestamptz default now());
    create function public.is_admin() returns boolean language sql stable security definer set search_path = 'public' as $$ select exists(select 1 from profiles where id = auth.uid() and role = 'admin') $$;
    create table public.hits(k text primary key, n int);
    create function public.nv_track_rate_ok(p_key text, p_limit int, p_window interval) returns boolean language plpgsql security definer set search_path = 'public' as $$
      begin insert into hits values (p_key, 1) on conflict (k) do update set n = hits.n + 1; return (select n from hits where k = p_key) <= p_limit; end $$;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid $$;
    create function cron.unschedule(j int) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create table public.test_http(status int, body text, url text);
    create type extensions.http_response as (status int, content_type text, headers text, content text);
    create function extensions.http_get(u text) returns extensions.http_response language plpgsql as $$
      declare r extensions.http_response; begin update public.test_http set url = u; select t.status, 'application/json', null, t.body into r from public.test_http t limit 1; return r; end $$;
    create function extensions.http_set_curlopt(a text, b text) returns boolean language sql as $$ select true $$;
    grant usage on schema public to anon, authenticated;
    insert into auth.users(id, email) values ('${U.admin}', 'boss@novax.pk'), ('${U.ayesha}', 'ayesha@example.com'), ('${U.bilal}', 'bilal@example.com'),
      ('${U.stranger}', 'stranger@example.com'), ('${U.merchant}', 'shop@example.com');
    insert into public.profiles(id, email, role, client_id) values ('${U.admin}', 'boss@novax.pk', 'admin', null), ('${U.ayesha}', 'ayesha@example.com', 'client', null),
      ('${U.bilal}', 'bilal@example.com', 'client', null), ('${U.stranger}', 'stranger@example.com', 'client', null), ('${U.merchant}', 'shop@example.com', 'client', '${C.merchant}');
    insert into public.clients(id, name, phone, city, created_at) values ('${C.merchant}', 'Old Shop', '03000000001', 'Karachi', now() - interval '90 days');`);
  const files = ['channel', 'onboarding', 'onboarding_terms', 'sheet_pull', 'guide', 'hardening'].map(n =>
    readFileSync(new URL(`../sql_novax_sales_${n}_20261002.sql`, import.meta.url), 'utf8').replace(/^create extension if not exists http .*$/m, ''));
  for (const f of files) q(f);
  for (const f of files.slice(1)) q(f);   // safe to run twice (the first file adds an enum value once)
  assert.equal(q(`select count(*) from cron.job where jobname = 'novax-sales-refresh'`), '1');
  assert.equal(q(`select command from cron.job where jobname = 'novax-sales-sheet-pull'`), 'select public.sales_sheet_pull_cron()');
  assert.equal(q(`select count(*) from pg_proc where proname in ('sales_sheet_sync', 'sales_admin_sheet_key')`), '0');
  console.log('PASS: every sales migration applies in order, and again; jobs scheduled once; the retired sheet key sync is gone.');
  // A rep who finished the joining form and signed (the joining flow has its own UI test).
  const onboard = (code, phone, cnic) => q(`update public.sales_reps set profile_done_at = now(), phone = '${phone}', cnic = '${cnic}', address = 'House 1, Street 2, Karachi',
      emergency_name = 'Someone', emergency_phone = '03009999999' where code = '${code}';
    insert into public.sales_rep_signatures(rep_id, doc_version, docs_sha256, signed_name, signature_png)
    select id, '2026-10-02', repeat('a', 64), full_name, 'data:image/png;base64,' || repeat('A', 300) from public.sales_reps where code = '${code}';`);

  // ── reps ──
  assert.equal(J(as('admin', `select public.sales_admin_invite('Ayesha Khan', 'Ayesha@Example.com', '+92 300 1112233', 'ayesha')`)).code, 'AYESHA');
  as('admin', `select public.sales_admin_invite('Bilal Ahmed', 'bilal@example.com', '', 'BILAL')`);
  fails('admin', `select public.sales_admin_invite('X Y', 'x@example.com', '', 'AYESHA')`, /already taken/);
  fails('admin', `select public.sales_admin_invite('X Y', 'x@example.com', '', 'a b')`, /3 to 12 letters/);
  fails('ayesha', `select public.sales_admin_invite('X Y', 'x@example.com', '', 'XYZ')`, /Only NovaX admins/);
  fails('stranger', `select public.sales_join('AYESHA')`, /different email/);
  fails('merchant', `select public.sales_join('AYESHA')`, /different email/);
  q(`insert into public.sales_reps(code, full_name, email) values ('SHOPREP', 'Shop Rep', 'shop@example.com')`);
  fails('merchant', `select public.sales_join('SHOPREP')`, /already belongs to a NovaX account/);
  assert.equal(J(as('ayesha', `select public.sales_join(' ayesha ')`)).rep.status, 'Active');
  as('bilal', `select public.sales_join('BILAL')`);
  assert.equal(q(`select role from public.profiles where id = '${U.ayesha}'`), 'sales');
  fails('stranger', `select public.sales_my_leads()`, /for NovaX sales reps/);
  fails('ayesha', `select public.sales_my_leads()`, /joining form/);
  onboard('AYESHA', '03001112233', '3520200000001'); onboard('BILAL', '03004445566', '3520200000002');
  fails('admin', `select public.sales_admin_invite('Copy Cat', 'copy@example.com', '0300 1112233', 'COPY')`, /already belongs to another rep/);
  assert.throws(() => q(`update public.sales_reps set phone = '03001112233' where code = 'BILAL'`), /duplicate key/);
  console.log('PASS: admins invite reps; a rep joins only with the invited email; merchant logins cannot become reps.');

  // ── leads ──
  const rows = JSON.stringify([
    { lead_ref: 'L1', store_name: 'Glow Cosmetics', phone: '+92 321 0000001', city: 'Karachi', assign_to: 'ayesha' },
    { lead_ref: 'L2', store_name: 'Kids Corner', phone: '0321-0000002', city: 'Lahore' },
    { lead_ref: 'L3', store_name: 'Shoe Hub', phone: '0321 0000003', city: 'Karachi' },
    { lead_ref: 'L4', store_name: '', phone: '03210000004' },
    { lead_ref: 'L5', store_name: 'Bad Phone', phone: '12345' },
    { lead_ref: 'L6', store_name: 'Ghost', phone: '03210000006', assign_to: 'NOBODY' },
    { lead_ref: 'L7', store_name: 'Tea Time', phone: '03210000007', city: 'Karachi' },
  ]);
  const imp = J(as('admin', `select public.sales_admin_import('${rows}'::jsonb)`));
  assert.equal(imp.inserted, 4);
  assert.deepEqual(imp.skipped.map(s => s.reason), ['Store name is empty', 'Phone is not a Pakistani mobile number', 'No active rep with code NOBODY']);
  // One phone, one lead: a row with another Lead ID for a known phone is refused, never flips the lead.
  const clash = J(as('admin', `select public.sales_admin_import('[{"lead_ref":"L2b","store_name":"Kids Corner PK","phone":"03210000002","assign_to":"BILAL"}]'::jsonb)`));
  assert.deepEqual([clash.updated, clash.skipped[0].reason], [0, 'This phone already belongs to lead L2']);
  const again = J(as('admin', `select public.sales_admin_import('[{"lead_ref":"L2","store_name":"Kids Corner PK","phone":"03210000002"}]'::jsonb)`));
  assert.equal(again.updated, 1);
  assert.equal(q(`select store_name || '/' || lead_ref || '/' || coalesce(rep_id::text, 'pool') from public.sales_prospects where phone = '03210000002'`), 'Kids Corner PK/L2/pool');
  assert.equal(q(`select count(*) - count(distinct phone) from public.sales_prospects`), '0');
  assert.equal(as('admin', `select public.sales_admin_assign('${q(`select id from public.sales_reps where code='BILAL'`)}', 2, 'karachi')`), '2');
  const ay = J(as('ayesha', `select public.sales_my_leads()`)), bi = J(as('bilal', `select public.sales_my_leads()`));
  assert.deepEqual(ay.map(l => l.store_name), ['Glow Cosmetics']);
  assert.deepEqual(bi.map(l => l.store_name).sort(), ['Shoe Hub', 'Tea Time']);
  assert.equal(q(`select count(*) from public.sales_prospects where rep_id is null`), '1');
  const srch = t => J(as('admin', `select public.sales_admin_leads(null, null, '${t}', false)`)).map(l => l.store_name).sort();
  assert.deepEqual(srch('zzqxnothing'), []);
  assert.deepEqual(srch('glow'), ['Glow Cosmetics']);
  assert.deepEqual(srch('0000003'), ['Shoe Hub']);
  assert.deepEqual(srch('lahore'), ['Kids Corner PK']);
  console.log('PASS: import cleans phones and skips bad rows with reasons; one phone is one lead; search matches words and phones only; hand-out by city; each rep sees only their own leads.');

  // ── calls ──
  const glow = ay[0].id, shoe = bi.find(l => l.store_name === 'Shoe Hub').id;
  fails('ayesha', `select public.sales_log_call('${glow}', 'Signed up')`, /Pick what happened/);
  fails('ayesha', `select public.sales_log_call('${glow}', 'Call back')`, /Pick the date/);
  fails('ayesha', `select public.sales_log_call('${glow}', 'Interested', null, current_date - 1)`, /within the next 60 days/);
  fails('ayesha', `select public.sales_log_call('${shoe}', 'Interested')`, /not assigned to you/);
  const logged = J(as('ayesha', `select public.sales_log_call('${glow}', 'Call back', 'Owner busy, call at 4', (now() at time zone 'Asia/Karachi')::date + 1)`));
  assert.equal(logged.status, 'Call back'); assert.equal(logged.call_count, 1); assert.equal(logged.rep_id, undefined);
  as('bilal', `select public.sales_log_call('${shoe}', 'Interested', 'Wants rates on WhatsApp')`);
  console.log('PASS: calls need a real outcome and a follow-up date where it matters; a rep cannot log on another rep\'s lead.');

  // ── stores signing up ──
  q(`insert into auth.users(id, email, raw_user_meta_data) values
       ('${U.owner1}', 'glow@example.com', '{}'), ('${U.owner2}', 'kids@example.com', '{"sales_ref":"bilal"}'),
       ('${U.owner3}', 'shoe@example.com', '{"sales_ref":"AYESHA"}'), ('${U.owner4}', 'walkin@example.com', '{}');
     insert into public.clients(id, name, phone, city) values ('${C.one}', 'Glow Cosmetics', '03210000001', 'Karachi'),
       ('${C.two}', 'Kids Corner', '03210000002', 'Lahore'), ('${C.three}', 'Shoe Hub', '03210000003', 'Karachi'),
       ('${C.four}', 'Walk In', '03459999999', 'Karachi'), ('${C.test}', 'Test Store', '03210000001', 'Karachi');
     insert into public.profiles(id, email, client_id) values ('${U.owner1}', 'glow@example.com', '${C.one}'), ('${U.owner2}', 'kids@example.com', '${C.two}'),
       ('${U.owner3}', 'shoe@example.com', '${C.three}'), ('${U.owner4}', 'walkin@example.com', '${C.four}');`);
  fails('ayesha', `select public.sales_refresh()`, /Only NovaX admins/);
  q(`update public.sales_prospects set store_name = 'Kids Corner' where phone = '03210000002'`);
  const ref1 = J(q(`select public.sales_refresh()`));
  assert.equal(ref1.credited, 3);
  const att = q(`select string_agg(c.name || ':' || r.code || ':' || a.method || ':' || a.status, ' | ' order by c.name) from public.sales_attributions a
                 join public.clients c on c.id = a.client_id join public.sales_reps r on r.id = a.rep_id`);
  assert.equal(att, 'Glow Cosmetics:AYESHA:phone_match:Approved | Kids Corner:BILAL:ref_code:Approved | Shoe Hub:AYESHA:ref_code:Pending');
  assert.equal(q(`select status from public.sales_prospects where phone = '03210000003'`), 'Signed up');
  assert.equal(q(`select count(*) from public.sales_attributions where client_id in ('${C.four}', '${C.test}')`), '0');
  console.log('PASS: stores are credited by lead phone or rep code; code vs lead conflicts wait for an admin; walk-ins and test accounts credit nobody.');

  // ── rewards ──
  const rw = () => q(`select string_agg(c.name || ':' || w.kind || ':' || w.status, ' | ' order by c.name, w.kind) from public.sales_rewards w join public.clients c on c.id = w.client_id`);
  assert.equal(rw(), 'Glow Cosmetics:account_opened:Waiting | Kids Corner:account_opened:Waiting');
  // Terms are frozen when a store is credited: a later rate change does not reach it.
  q(`update public.sales_settings set value = '700' where key = 'reward_first_pickup'`);
  q(`insert into public.client_kyc values ('${C.one}', 'verified'), ('${C.two}', 'submitted');
     insert into public.parcels(id, client_id, status) values ('${id(901)}', '${C.one}', 'Arrived at warehouse'), ('${id(902)}', '${C.two}', 'New booked');
     insert into public.nv_parcel_status_log(parcel_id, client_id, from_status, to_status, changed_at) values ('${id(901)}', '${C.one}', 'New booked', 'Arrived at warehouse', now() - interval '1 day');
     select public.sales_refresh();`);
  assert.equal(rw(), 'Glow Cosmetics:account_opened:Earned | Glow Cosmetics:first_pickup:Waiting | Kids Corner:account_opened:Waiting');
  q(`update public.parcels set status = 'Delivered' where id = '${id(901)}'; select public.sales_refresh();`);
  assert.equal(rw(), 'Glow Cosmetics:account_opened:Earned | Glow Cosmetics:first_pickup:Earned | Kids Corner:account_opened:Waiting');
  // a pickup that was refused never pays, even after the hold
  q(`update public.client_kyc set status = 'verified' where client_id = '${C.two}';
     update public.parcels set status = 'Refused' where id = '${id(902)}';
     insert into public.nv_parcel_status_log(parcel_id, client_id, from_status, to_status, changed_at) values ('${id(902)}', '${C.two}', 'New booked', 'Arrived at warehouse', now() - interval '10 days');
     select public.sales_refresh();`);
  assert.match(rw(), /Kids Corner:account_opened:Earned \| Kids Corner:first_pickup:Waiting/);
  // A later parcel that is merely in transit does not rescue a refused first pickup...
  q(`insert into public.parcels(id, client_id, status) values ('${id(903)}', '${C.two}', 'Parcel now in transit');
     insert into public.nv_parcel_status_log(parcel_id, client_id, from_status, to_status, changed_at) values ('${id(903)}', '${C.two}', 'New booked', 'Arrived at warehouse', now() - interval '9 days');
     update public.nv_parcel_status_log set to_status = 'Refused' where parcel_id = '${id(902)}';
     insert into public.nv_parcel_status_log(parcel_id, client_id, from_status, to_status, changed_at) values ('${id(902)}', '${C.two}', 'Arrived at warehouse', 'Refused', now() - interval '8 days');
     select public.sales_refresh();`);
  assert.match(rw(), /Kids Corner:first_pickup:Waiting/);
  // ...and neither does a later parcel that is DELIVERED (2 Oct: it used to pay).
  q(`update public.parcels set status = 'Delivered' where id = '${id(903)}'; select public.sales_refresh();`);
  assert.match(rw(), /Kids Corner:first_pickup:Waiting/);
  assert.equal(q(`select amount from public.sales_rewards w join public.clients c on c.id = w.client_id where c.name = 'Glow Cosmetics' and kind = 'first_pickup'`), '500');
  q(`update public.sales_settings set value = '500' where key = 'reward_first_pickup'`);
  console.log('PASS: Rs 500 once the CNIC is verified; Rs 500 for the first pickup once delivered; a refused first pickup never pays through another parcel; amounts are the terms frozen at crediting.');

  // ── claims and decisions ──
  fails('bilal', `select public.sales_claim_store('03210000001')`, /already credited to another rep/);
  fails('bilal', `select public.sales_claim_store('0300 9999999')`, /No store with that number/);
  assert.match(as('bilal', `select public.sales_claim_store('+92 345 9999999', 'Met at the market')`), /Claim sent/);
  const pend = J(as('admin', `select public.sales_admin_attributions()`)).filter(a => a.status === 'Pending');
  assert.deepEqual(pend.map(a => a.store_name + ':' + a.rep_code + ':' + (a.alt_rep_code || '-')).sort(), ['Shoe Hub:AYESHA:BILAL', 'Walk In:BILAL:-']);
  as('admin', `select public.sales_admin_decide('${C.three}', 'Approved', '${q(`select id from public.sales_reps where code='BILAL'`)}')`);
  fails('admin', `select public.sales_admin_decide('${C.four}', 'Rejected')`, /Say why/);
  as('admin', `select public.sales_admin_decide('${C.four}', 'Rejected', null, 'Store says nobody called them')`);
  assert.equal(q(`select r.code || ':' || a.status from public.sales_attributions a join public.sales_reps r on r.id = a.rep_id where a.client_id = '${C.three}'`), 'BILAL:Approved');
  const bs = J(as('bilal', `select public.sales_my_stores()`));
  assert.deepEqual(bs.map(s => s.store_name + ':' + s.status).sort(), ['Kids Corner:Approved', 'Shoe Hub:Approved', 'Walk In:Rejected']);
  assert.equal(bs.find(s => s.store_name === 'Walk In').note, 'Store says nobody called them');
  fails('bilal', `select public.sales_claim_store('03459999999', 'Store says nobody called them')`, /Add new details/);
  assert.match(as('bilal', `select public.sales_claim_store('03459999999', 'Called on 1 Oct from 0300 4445566, sent link on WhatsApp')`), /Claim sent/);
  assert.equal(q(`select status from public.sales_attributions where client_id = '${C.four}'`), 'Pending');
  assert.deepEqual(J(as('ayesha', `select public.sales_my_stores()`)).map(s => s.store_name), ['Glow Cosmetics']);
  // Moving a store moves its unpaid rewards; a reject-then-approve brings them back.
  const kids = () => q(`select string_agg(r.code || ':' || w.kind || ':' || w.status, ' | ' order by w.kind) from public.sales_rewards w join public.sales_reps r on r.id = w.rep_id where w.client_id = '${C.two}'`);
  const ayeshaId = q(`select id from public.sales_reps where code='AYESHA'`), bilalId = q(`select id from public.sales_reps where code='BILAL'`);
  as('admin', `select public.sales_admin_credit('${C.two}', '${ayeshaId}')`);
  assert.equal(kids(), 'AYESHA:account_opened:Earned | AYESHA:first_pickup:Waiting');
  as('admin', `select public.sales_admin_decide('${C.two}', 'Rejected', null, 'Checking who called')`);
  assert.equal(kids(), 'AYESHA:account_opened:Rejected | AYESHA:first_pickup:Rejected');
  as('admin', `select public.sales_admin_decide('${C.two}', 'Approved', '${bilalId}')`);
  assert.equal(kids(), 'BILAL:account_opened:Earned | BILAL:first_pickup:Waiting');
  console.log('PASS: claims need an admin; a rejection carries its reason to the rep and can be re-claimed with new details; moving a store moves its unpaid rewards.');

  // ── paying ──
  const earned = J(as('admin', `select public.sales_admin_rewards('Earned')`));
  const glowIds = earned.filter(w => w.store_name === 'Glow Cosmetics').map(w => w.id);
  assert.equal(glowIds.length, 2);
  fails('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Paid', 'IBFT 77881')`, /Approve them first/);
  assert.equal(as('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Approved')`), '2');
  fails('admin', `select public.sales_admin_set_rewards(array['${glowIds[0]}']::uuid[], 'Paid', '')`, /bank or transfer reference/);
  fails('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Paid', 'IBFT 77881')`, /No payout account yet for AYESHA/);
  fails('ayesha', `select public.sales_set_payout('Bank', 'Ayesha Khan', 'PK36SCBL0000001123456703')`, /24-character IBAN/);
  fails('ayesha', `select public.sales_set_payout('JazzCash', 'Ayesha Khan', '12345')`, /JazzCash mobile number/);
  assert.equal(J(as('ayesha', `select public.sales_set_payout('Bank', 'Ayesha Khan', 'pk36 scbl 0000 0011 2345 6702')`)).rep.payout.account, 'PK36SCBL0000001123456702');
  assert.equal(as('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Paid', 'IBFT 77881')`), '2');
  const paidRow = J(as('admin', `select public.sales_admin_rewards('Paid')`))[0];
  assert.equal(paidRow.paid_to, 'Bank · Ayesha Khan · PK36SCBL0000001123456702');
  assert.equal(paidRow.paid_by, 'boss@novax.pk'); assert.equal(paidRow.approved_by, 'boss@novax.pk');
  fails('ayesha', `select public.sales_admin_set_rewards(array['${glowIds[0]}']::uuid[], 'Paid', 'x')`, /Only NovaX admins/);
  const me = J(as('ayesha', `select public.sales_my_earnings()`));
  assert.deepEqual(me.totals, { waiting: 0, earned: 0, approved: 0, paid: 1000 });
  assert.ok(me.rewards.every(w => w.paid_ref === 'IBFT 77881'));
  console.log('PASS: paid only after approval, only to a recorded IBAN or wallet, with who approved and who paid; the rep sees Rs 1,000 paid.');

  // ── stale leads, removing a rep ──
  q(`update public.sales_prospects set assigned_at = now() - interval '8 days' where store_name = 'Tea Time'; select public.sales_refresh();`);
  assert.equal(q(`select coalesce(rep_id::text, 'pool') from public.sales_prospects where store_name = 'Tea Time'`), 'pool');
  assert.equal(q(`select rep_id is not null from public.sales_prospects where store_name = 'Glow Cosmetics'`), 't');
  as('admin', `select public.sales_admin_set_rep_status('${q(`select id from public.sales_reps where code='AYESHA'`)}', 'Removed')`);
  fails('ayesha', `select public.sales_my_leads()`, /for NovaX sales reps/);
  assert.equal(q(`select role from public.profiles where id = '${U.ayesha}'`), 'client');
  // Credited before leaving, earned within 30 days: paid. After 30 days: not.
  as('admin', `select public.sales_admin_credit('${C.four}', '${ayeshaId}')`);
  assert.equal(q(`select status from public.sales_rewards where client_id = '${C.four}' and kind = 'account_opened'`), 'Waiting');
  q(`update public.sales_reps set removed_at = now() - interval '31 days' where code = 'AYESHA'; select public.sales_refresh();`);
  assert.equal(q(`select status || ':' || note from public.sales_rewards where client_id = '${C.four}' and kind = 'account_opened'`), 'Rejected:Not met within 30 days after the agreement ended');
  q(`insert into public.client_kyc values ('${C.four}', 'verified'); select public.sales_refresh();`);
  assert.equal(q(`select status from public.sales_rewards where client_id = '${C.four}' and kind = 'account_opened'`), 'Rejected');
  as('admin', `select public.sales_admin_credit('${C.four}', '${bilalId}')`);
  console.log('PASS: untouched leads return to the pool after 7 days; a removed rep loses access at once and stops earning 30 days after the end date.');

  // ── the sheet (Google stubbed by public.test_http) ──
  const gviz = (cols, rows) => `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify({ version: '0.6', status: 'ok',
    table: { cols: cols.map(l => ({ label: l, type: 'string' })), rows: rows.map(r => ({ c: r.map(v => v == null ? null : { v }) })) } })});`;
  const setHttp = (status, body) => q(`delete from public.test_http; insert into public.test_http(status, body) values (${status}, $b$${body}$b$)`);
  const ID1 = '1snlniTPUooDYdDStF-3U1qt8NVWXm_WjKwW5sPGa8ww', ID2 = '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  q(`select public.sales_sheet_pull_cron()`);   // nothing linked yet: quietly nothing
  setHttp(200, '<html>Sign in</html>');
  fails('admin', `select public.sales_admin_set_sheet('https://docs.google.com/spreadsheets/d/${ID1}/edit')`, /private.*not changed/);
  assert.equal(q(`select count(*) from public.sales_settings where key = 'sheet_id'`), '0');
  setHttp(200, gviz(['Store', 'Mobile', 'City', 'Notes'], [['Sheet Store', '0333 1234567', 'Karachi', 'x'], ['Dup Store', '03331234567', 'Lahore', 'y'],
    ['Clash', '0321 0000001', 'Karachi', 'z'], ['', '', '', '']]));
  const s1 = J(as('admin', `select public.sales_admin_set_sheet('https://docs.google.com/spreadsheets/d/${ID1}/edit?usp=sharing')`));
  assert.deepEqual([s1.ok, s1.rows, s1.inserted, s1.ignored_columns], [true, 2, 1, ['Notes']]);
  assert.deepEqual(s1.skipped.map(x => x.row + ':' + x.reason), ['3:Same phone as row 2', '4:This phone already belongs to lead L1']);
  assert.match(q(`select url from public.test_http`), new RegExp(ID1));
  // A bad new link never replaces the working one.
  setHttp(404, 'Not found');
  fails('admin', `select public.sales_admin_set_sheet('https://docs.google.com/spreadsheets/d/${ID2}/edit')`, /Google answered 404.*not changed/);
  assert.equal(q(`select value from public.sales_settings where key = 'sheet_id'`), ID1);
  // Headings are never guessed.
  setHttp(200, gviz(['A', 'B'], [['Shop', '0333 7654321']]));
  assert.match(J(as('admin', `select public.sales_admin_pull_sheet()`)).error, /needs the headings "Store name" and "Phone" \(found: A, B\)/);
  assert.throws(() => q(`select public.sales_sheet_pull_cron()`), /Sheet import failed: Row 1 of the sheet needs the headings/);
  // No 2,000-row stop.
  const big = Array.from({ length: 2600 }, (_, i) => [`Big ${i}`, '0344' + String(1000000 + i).padStart(7, '0')]);
  setHttp(200, gviz(['Store name', 'Phone'], big));
  const s2 = J(as('admin', `select public.sales_admin_pull_sheet()`));
  assert.deepEqual([s2.ok, s2.rows, s2.inserted], [true, 2600, 2600]);
  q(`select public.sales_sheet_pull_cron()`);
  assert.equal(J(as('admin', `select public.sales_admin_sheet_status()`)).last.updated, 2600);
  console.log('PASS: sheet links are tried before they are saved; headings by name only; duplicate phones skipped with the row; 2,600 rows import; cron fails loudly.');

  // ── nobody reaches the tables directly ──
  for (const who of [null, 'bilal']) fails(who, `select count(*) from public.sales_prospects`, /permission denied/);
  fails(null, `select public.sales_my_leads()`, /permission denied/);
  fails(null, `select public.sales_admin_overview()`, /permission denied/);
  const ov = J(as('admin', `select public.sales_admin_overview()`));
  assert.equal(ov.reps.find(r => r.code === 'BILAL').signups, 3);
  assert.equal(ov.settings.sheet_token_hash, undefined);
  console.log('PASS: tables are closed to the API; admin overview counts signups per rep and never returns the sheet key hash.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
