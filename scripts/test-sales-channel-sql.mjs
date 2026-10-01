import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The sales channel (sql_novax_sales_channel_20261002.sql) on a throwaway local
// PostgreSQL with a minimal copy of the tables it reads. Never touches production.
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
    grant usage on schema public to anon, authenticated;
    insert into auth.users(id, email) values ('${U.admin}', 'boss@novax.pk'), ('${U.ayesha}', 'ayesha@example.com'), ('${U.bilal}', 'bilal@example.com'),
      ('${U.stranger}', 'stranger@example.com'), ('${U.merchant}', 'shop@example.com');
    insert into public.profiles(id, email, role, client_id) values ('${U.admin}', 'boss@novax.pk', 'admin', null), ('${U.ayesha}', 'ayesha@example.com', 'client', null),
      ('${U.bilal}', 'bilal@example.com', 'client', null), ('${U.stranger}', 'stranger@example.com', 'client', null), ('${U.merchant}', 'shop@example.com', 'client', '${C.merchant}');
    insert into public.clients(id, name, phone, city, created_at) values ('${C.merchant}', 'Old Shop', '03000000001', 'Karachi', now() - interval '90 days');`);
  const migration = readFileSync(new URL('../sql_novax_sales_channel_20261002.sql', import.meta.url), 'utf8');
  q(migration);
  q(migration);   // safe to run twice
  assert.equal(q(`select count(*) from cron.job where jobname = 'novax-sales-refresh'`), '1');
  console.log('PASS: migration applies, and again without changes; refresh job scheduled once.');

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
  const again = J(as('admin', `select public.sales_admin_import('[{"lead_ref":"L2b","store_name":"Kids Corner PK","phone":"03210000002"}]'::jsonb)`));
  assert.equal(again.updated, 1);
  assert.equal(q(`select store_name || '/' || lead_ref from public.sales_prospects where phone = '03210000002'`), 'Kids Corner PK/L2b');
  assert.equal(as('admin', `select public.sales_admin_assign('${q(`select id from public.sales_reps where code='BILAL'`)}', 2, 'karachi')`), '2');
  const ay = J(as('ayesha', `select public.sales_my_leads()`)), bi = J(as('bilal', `select public.sales_my_leads()`));
  assert.deepEqual(ay.map(l => l.store_name), ['Glow Cosmetics']);
  assert.deepEqual(bi.map(l => l.store_name).sort(), ['Shoe Hub', 'Tea Time']);
  assert.equal(q(`select count(*) from public.sales_prospects where rep_id is null`), '1');
  console.log('PASS: import cleans phones, skips bad rows with reasons, updates by phone; hand-out by city; each rep sees only their own leads.');

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
  console.log('PASS: Rs 500 once the CNIC is verified; Rs 500 for the first pickup once delivered (a refused pickup waits, never pays).');

  // ── claims and decisions ──
  fails('bilal', `select public.sales_claim_store('03210000001')`, /already credited to another rep/);
  fails('bilal', `select public.sales_claim_store('0300 9999999')`, /No store with that number/);
  assert.match(as('bilal', `select public.sales_claim_store('+92 345 9999999', 'Met at the market')`), /Claim sent/);
  const pend = J(as('admin', `select public.sales_admin_attributions()`)).filter(a => a.status === 'Pending');
  assert.deepEqual(pend.map(a => a.store_name + ':' + a.rep_code + ':' + (a.alt_rep_code || '-')).sort(), ['Shoe Hub:AYESHA:BILAL', 'Walk In:BILAL:-']);
  as('admin', `select public.sales_admin_decide('${C.three}', 'Approved', '${q(`select id from public.sales_reps where code='BILAL'`)}')`);
  as('admin', `select public.sales_admin_decide('${C.four}', 'Rejected')`);
  assert.equal(q(`select r.code || ':' || a.status from public.sales_attributions a join public.sales_reps r on r.id = a.rep_id where a.client_id = '${C.three}'`), 'BILAL:Approved');
  assert.deepEqual(J(as('bilal', `select public.sales_my_stores()`)).map(s => s.store_name).sort(), ['Kids Corner', 'Shoe Hub']);
  assert.deepEqual(J(as('ayesha', `select public.sales_my_stores()`)).map(s => s.store_name), ['Glow Cosmetics']);
  console.log('PASS: reps claim unmatched stores, admins approve or reject and can move a conflict to the right rep.');

  // ── paying ──
  const earned = J(as('admin', `select public.sales_admin_rewards('Earned')`));
  const glowIds = earned.filter(w => w.store_name === 'Glow Cosmetics').map(w => w.id);
  assert.equal(glowIds.length, 2);
  assert.equal(as('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Approved')`), '2');
  fails('admin', `select public.sales_admin_set_rewards(array['${glowIds[0]}']::uuid[], 'Paid', '')`, /bank or transfer reference/);
  assert.equal(as('admin', `select public.sales_admin_set_rewards(array['${glowIds.join("','")}']::uuid[], 'Paid', 'IBFT 77881')`), '2');
  fails('ayesha', `select public.sales_admin_set_rewards(array['${glowIds[0]}']::uuid[], 'Paid', 'x')`, /Only NovaX admins/);
  const me = J(as('ayesha', `select public.sales_my_earnings()`));
  assert.deepEqual(me.totals, { waiting: 0, earned: 0, approved: 0, paid: 1000 });
  assert.ok(me.rewards.every(w => w.paid_ref === 'IBFT 77881'));
  console.log('PASS: admin approves, pays with a bank reference, and the rep sees Rs 1,000 paid.');

  // ── stale leads, removing a rep ──
  q(`update public.sales_prospects set assigned_at = now() - interval '8 days' where store_name = 'Tea Time'; select public.sales_refresh();`);
  assert.equal(q(`select coalesce(rep_id::text, 'pool') from public.sales_prospects where store_name = 'Tea Time'`), 'pool');
  assert.equal(q(`select rep_id is not null from public.sales_prospects where store_name = 'Glow Cosmetics'`), 't');
  as('admin', `select public.sales_admin_set_rep_status('${q(`select id from public.sales_reps where code='AYESHA'`)}', 'Removed')`);
  fails('ayesha', `select public.sales_my_leads()`, /for NovaX sales reps/);
  assert.equal(q(`select role from public.profiles where id = '${U.ayesha}'`), 'client');
  console.log('PASS: untouched leads return to the pool after 7 days; a removed rep loses access at once.');

  // ── the sheet ──
  fails(null, `select public.sales_sheet_sync('nvs_wrong', '[]'::jsonb)`, /not connected/);
  const key = as('admin', `select public.sales_admin_sheet_key()`);
  assert.match(key, /^nvs_[0-9a-f]{48}$/);
  assert.equal(q(`select value <> '${key}' and length(value) = 64 from public.sales_settings where key = 'sheet_token_hash'`), 't');
  fails(null, `select public.sales_sheet_sync('nvs_wrong', '[]'::jsonb)`, /not connected/);
  const sync = J(as(null, `select public.sales_sheet_sync('${key}', '[{"lead_ref":"S1","store_name":"Sheet Store","phone":"0333 1234567","assign_to":"BILAL"}]'::jsonb)`));
  assert.equal(sync.inserted, 1);
  const s1 = sync.leads.find(l => l.lead_ref === 'S1');
  assert.equal(s1.rep_code, 'BILAL'); assert.equal(s1.status, 'Not called');
  assert.equal(sync.leads.find(l => l.lead_ref === 'L1').signed_up_on.length, 10);
  console.log('PASS: the sheet syncs only with the current key (stored hashed), adds leads and reads every status back.');

  // ── nobody reaches the tables directly ──
  for (const who of [null, 'bilal']) fails(who, `select count(*) from public.sales_prospects`, /permission denied/);
  fails(null, `select public.sales_my_leads()`, /permission denied/);
  fails(null, `select public.sales_admin_overview()`, /permission denied/);
  const ov = J(as('admin', `select public.sales_admin_overview()`));
  assert.equal(ov.reps.find(r => r.code === 'BILAL').signups, 2);
  assert.equal(ov.sheet_connected, true); assert.equal(ov.settings.sheet_token_hash, undefined);
  console.log('PASS: tables are closed to the API; admin overview counts signups per rep and never returns the sheet key hash.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
