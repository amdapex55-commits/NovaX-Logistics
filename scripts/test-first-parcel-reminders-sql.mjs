import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// First-parcel reminders, against a throwaway local PostgreSQL with fake data.
// Never contacts the live project.
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.ok(existsSync(path.join(bin, 'initdb')), 'Set PG_BIN to your PostgreSQL binaries.');
const directory = mkdtempSync(path.join(tmpdir(), 'novax-reminders-test-'));
const data = path.join(directory, 'data');
const args = ['-h', directory, '-p', '55443', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const migration = read('sql_novax_first_parcel_reminders_20260930.sql');

// Thursday 1 Oct 2026, 11:00 Pakistan time.
const T0 = "timestamptz '2026-10-01 11:00+05'";
const at = hours => `(${T0} + interval '${hours} hours')`;
let serial = 0;
// A merchant whose workspace and owner login were created `ageDays` before T0.
function merchant(name, ageDays, extra = {}) {
  serial++;
  const client = `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`;
  const user = `00000000-0000-0000-0001-${String(serial).padStart(12, '0')}`;
  const email = extra.email ?? `owner${serial}@example.com`;
  const clientAge = extra.clientAgeDays ?? ageDays;
  q(`insert into clients(id,name,status,created_at) values ('${client}','${name}','${extra.status ?? 'Active'}',
      ${T0} - interval '${clientAge * 24} hours');
    insert into auth.users(id,email,raw_user_meta_data,created_at) values ('${user}','${email}',
      '${JSON.stringify({ role: 'client', full_name: extra.fullName ?? 'Owner ' + serial, ...(extra.meta ?? {}) })}',
      ${T0} - interval '${ageDays * 24} hours');
    insert into profiles(id,client_id) values ('${user}','${client}');
    update nv_email_queue set created_at = ${T0} - interval '${ageDays * 24} hours'
      where event_key = 'welcome:${user}';`);
  return { client, user, email };
}
// Run the job at a simulated time and stamp its rows with that time.
function run(when) {
  const n = Number(q(`select nv_email_first_parcel_reminders(${when})`));
  q(`update nv_email_queue set created_at = ${when} where created_at > now() - interval '1 minute'
     and created_at < now() + interval '1 minute';`);
  return n;
}
const queued = client => q(`select coalesce(string_agg(kind, ',' order by kind), '') from nv_email_queue
  where event_key like 'first_parcel_d%:${client}'`);

let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'),
    '-o', `-c listen_addresses='' -k ${directory} -p 55443`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  // Supabase grants new tables and functions to the browser roles by default.
  q(`create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      invited_at timestamptz, created_at timestamptz default now());
    create table clients(id uuid primary key, name text, meta jsonb default '{}', status text default 'Active',
      created_at timestamptz default now());
    create table profiles(id uuid primary key, client_id uuid, role text default 'client',
      status text default 'active', created_at timestamptz default now());
    create table staff_users(auth_user_id uuid, client_id uuid, email text, role text, status text);
    create table parcels(id uuid primary key default gen_random_uuid(), client_id uuid, awb text,
      booked_at timestamptz default now());
    create table withdrawals(id uuid primary key, client_id uuid, amount numeric, fee numeric, net numeric,
      status text, paid_at timestamptz, paid_txn_id text);
    create table client_notification_prefs(client_id uuid primary key, email_enabled boolean default true);
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text, schedule text, command text,
      active boolean default true);
    create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint
      language sql as $$ insert into cron.job(jobname,schedule,command) values (p_name,p_schedule,p_command)
      returning jobid $$;
    create function cron.alter_job(job_id bigint, schedule text default null, command text default null,
      database text default null, username text default null, active boolean default null) returns void
      language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active)
      where jobid = alter_job.job_id $$;`);
  q(read('sql_novax_email_notifications_20260927.sql'));
  q(migration);

  // Installed switched off, and a rerun neither duplicates nor flips it.
  assert.equal(q("select count(*)||':'||bool_or(active)||':'||min(schedule) from cron.job where jobname='novax-first-parcel-reminders'"), '1:false:7 * * * *');
  assert.equal(q("select command from cron.job where jobname='novax-first-parcel-reminders'"), 'select public.nv_email_first_parcel_reminders();');
  q("update cron.job set active=true where jobname='novax-first-parcel-reminders'");
  q(migration);
  assert.equal(q("select count(*)||':'||bool_or(active) from cron.job where jobname='novax-first-parcel-reminders'"), '1:true');

  const a = merchant('Day One Store', 1.5);
  const b = merchant('Day Three Store', 4);
  const c = merchant('Day Seven Store', 8);
  const young = merchant('Too New', 0.5);
  const old = merchant('Too Old', 11);
  const shipped = merchant('Already Shipping', 2);
  q(`insert into parcels(client_id,awb) values ('${shipped.client}','NVX-1');`);
  const stopped = merchant('Said Stop', 2);
  q(`insert into nv_email_reminders(client_id,stopped_at) values ('${stopped.client}',now());`);
  const noEmail = merchant('Email Off', 2);
  q(`insert into client_notification_prefs values ('${noEmail.client}',false);`);
  const onEmail = merchant('Email On', 2);
  q(`insert into client_notification_prefs values ('${onEmail.client}',true);`);
  const suspended = merchant('Suspended', 2, { status: 'Suspended' });
  const badEmail = merchant('Bad Email', 2, { email: 'not an email' });
  const seat = merchant('Team Seat Only', 2, { meta: { created_by_owner: 'x' } });
  const busy = merchant('Just Got Mail', 2);
  q(`select nv_email_enqueue('payout_paid:busy','payout_paid','${busy.email}','{}');
     update nv_email_queue set created_at = ${T0} - interval '5 hours' where event_key='payout_paid:busy';`);
  const lateLogin = merchant('Old Workspace New Login', 2, { clientAgeDays: 20 });
  const noName = merchant('No Name', 1.2, { fullName: '' });

  // Sunday, early morning and evening in Pakistan: nothing.
  assert.equal(run("timestamptz '2026-10-04 11:00+05'"), 0);
  assert.equal(run("timestamptz '2026-10-01 09:59+05'"), 0);
  assert.equal(run("timestamptz '2026-10-01 20:00+05'"), 0);
  assert.equal(q("select count(*) from nv_email_queue where kind like 'first_parcel%'"), '0');
  // Signing up still sends the welcome email, which the reminders never replace.
  assert.equal(q("select count(*) from nv_email_queue where kind='welcome'"), '14');

  assert.equal(run(T0), 6);
  assert.equal(queued(a.client), 'first_parcel_d1');
  assert.equal(queued(b.client), 'first_parcel_d3');
  assert.equal(queued(c.client), 'first_parcel_d7');
  assert.equal(queued(onEmail.client), 'first_parcel_d1');
  assert.equal(queued(lateLogin.client), 'first_parcel_d1');
  assert.equal(queued(noName.client), 'first_parcel_d1');
  for (const skipped of [young, old, shipped, stopped, noEmail, suspended, badEmail, seat, busy]) {
    assert.equal(queued(skipped.client), '', 'should skip ' + skipped.email);
  }
  const job = JSON.parse(q(`select row_to_json(x) from (select recipient, state, payload from nv_email_queue
    where event_key='first_parcel_d1:${a.client}') x`));
  assert.equal(job.recipient, a.email);
  assert.equal(job.state, 'pending');
  assert.equal(job.payload.business, 'Day One Store');
  assert.equal(job.payload.name, 'Owner 1');
  assert.equal(job.payload.step, 1);
  assert.equal(job.payload.token, q(`select token from nv_email_reminders where client_id='${a.client}'`));
  assert.equal(q(`select payload->>'name' from nv_email_queue where event_key='first_parcel_d1:${noName.client}'`), '');
  console.log('PASS: day 1/3/7 by age, daytime Monday to Saturday only, and every skip rule.');

  // Same hour: nothing new.
  assert.equal(run(T0), 0);
  // Friday 5 pm: the too-new merchant reaches day 1; the busy inbox has cooled and
  // gets day 3. Day-1 merchants now at day 3 wait for the 44-hour gap.
  assert.equal(run(at(30)), 2);
  assert.equal(queued(young.client), 'first_parcel_d1');
  assert.equal(queued(busy.client), 'first_parcel_d3');
  assert.equal(queued(onEmail.client), 'first_parcel_d1');
  // Saturday 1 pm: the gap has passed.
  assert.equal(run(at(50)), 4);
  for (const m of [a, onEmail, lateLogin, noName]) assert.equal(queued(m.client), 'first_parcel_d1,first_parcel_d3');
  assert.equal(queued(b.client), 'first_parcel_d3');
  assert.equal(queued(c.client), 'first_parcel_d7');
  assert.equal(queued(old.client), '');
  // A books. Monday: B reaches day 7, the too-new merchant day 3; nothing for A.
  q(`insert into parcels(client_id,awb) values ('${a.client}','NVX-2');`);
  assert.equal(run(at(24 * 4)), 2);
  assert.equal(queued(b.client), 'first_parcel_d3,first_parcel_d7');
  assert.equal(queued(young.client), 'first_parcel_d1,first_parcel_d3');
  // Wednesday: day 7 for everyone still waiting, except A, who booked.
  assert.equal(run(at(24 * 6)), 4);
  assert.equal(queued(a.client), 'first_parcel_d1,first_parcel_d3');
  for (const m of [onEmail, lateLogin, noName]) assert.equal(queued(m.client), 'first_parcel_d1,first_parcel_d3,first_parcel_d7');
  assert.equal(queued(busy.client), 'first_parcel_d3,first_parcel_d7');
  assert.equal(q("select count(*) from nv_email_queue where kind like 'first_parcel%'"), '18');
  assert.equal(q("select max(n) from (select count(*) n from nv_email_queue where kind like 'first_parcel%' group by recipient) x"), '3');
  console.log('PASS: at most three per merchant, 44 hours apart, and they stop once the merchant books.');

  // "Stop these reminders", from a signed-out browser.
  const token = q(`select token from nv_email_reminders where client_id='${onEmail.client}'`);
  q(`update nv_email_queue set state='pending', next_attempt_at=now(), lease_until=null
     where event_key='first_parcel_d7:${onEmail.client}';`);
  assert.equal(q(`set role anon; select nv_email_reminders_stop('${token}');`), 't');
  const firstStop = q(`select stopped_at from nv_email_reminders where client_id='${onEmail.client}'`);
  assert.ok(firstStop);
  assert.equal(q(`select state||':'||last_error from nv_email_queue where event_key='first_parcel_d7:${onEmail.client}'`), 'review:reminders_stopped');
  assert.equal(q(`set role anon; select nv_email_reminders_stop('${token}');`), 't');
  assert.equal(q(`select stopped_at from nv_email_reminders where client_id='${onEmail.client}'`), firstStop);
  assert.equal(q(`set role anon; select nv_email_reminders_stop(gen_random_uuid());`), 'f');
  // A reminder being sent right now is left to finish.
  const leased = q(`select token from nv_email_reminders where client_id='${lateLogin.client}'`);
  q(`update nv_email_queue set state='pending', lease_until=now()+interval '5 minutes'
     where event_key='first_parcel_d3:${lateLogin.client}';`);
  assert.equal(q(`set role authenticated; select nv_email_reminders_stop('${leased}');`), 't');
  assert.equal(q(`select state from nv_email_queue where event_key='first_parcel_d3:${lateLogin.client}'`), 'pending');
  console.log('PASS: stop link works signed out, is idempotent, cancels a waiting reminder and leaves a sending one.');

  // Browser roles: stop only. No reading tokens, no triggering sends.
  for (const role of ['anon', 'authenticated']) {
    assert.equal(q(`select has_table_privilege('${role}','nv_email_reminders','SELECT')`), 'f');
    assert.equal(q(`select has_table_privilege('${role}','nv_email_reminders','UPDATE')`), 'f');
    assert.equal(q(`select has_function_privilege('${role}','nv_email_first_parcel_reminders(timestamptz)','EXECUTE')`), 'f');
    assert.equal(q(`select has_function_privilege('${role}','nv_email_reminders_stop(uuid)','EXECUTE')`), 't');
  }
  assert.equal(q("select has_function_privilege('service_role','nv_email_first_parcel_reminders(timestamptz)','EXECUTE')"), 'f');
  assert.throws(() => q('set role anon; select nv_email_first_parcel_reminders();'), /permission denied/);
  assert.throws(() => q('set role anon; select * from nv_email_reminders;'), /permission denied/);
  console.log('PASS: browsers can only use the stop link; tokens and the sender stay private.');

  // Daily email budget: at 80 sent in 24 hours, none; at 75, five. 20 per run at most.
  q(`update clients set status='Closed'; delete from nv_email_queue; delete from nv_email_milestones;`);
  const later = at(24 * 9);  // Saturday 10 Oct, 11 am
  const fresh = Array.from({ length: 30 }, (_, i) => merchant('Batch ' + i, 2 - 9));
  // Their welcome emails went out when they signed up, two days earlier.
  q("update nv_email_queue set state='accepted', accepted_at=created_at where kind='welcome';");
  q(`insert into nv_email_milestones select 'sent:'||g from generate_series(1,80) g;
     insert into nv_email_queue(event_key,kind,recipient,payload,state,accepted_at)
     select 'sent:'||g,'welcome','old'||g||'@example.com','{}','accepted',${later} - interval '2 hours'
     from generate_series(1,80) g;`);
  assert.equal(run(later), 0);
  q("update nv_email_queue set accepted_at = accepted_at - interval '2 days' where event_key in (select 'sent:'||g from generate_series(1,5) g);");
  assert.equal(run(later), 5);
  q(`update nv_email_queue set accepted_at = accepted_at - interval '2 days' where event_key like 'sent:%';
     update nv_email_queue set state='accepted', accepted_at = ${later} - interval '30 hours' where kind like 'first_parcel%';`);
  assert.equal(run(later), 20);
  assert.equal(run(later), 5);
  assert.equal(run(later), 0);
  assert.equal(q(`select count(*) from nv_email_queue where kind='first_parcel_d1' and recipient in (${fresh.map(f => `'${f.email}'`).join(',')})`), '30');
  // With room for one, the reminder about to expire wins over a fresh day 1.
  q(`update clients set status='Closed'; delete from nv_email_queue; delete from nv_email_milestones;`);
  const expiring = merchant('Last Chance', 9.9 - 9);
  const newcomer = merchant('Newcomer', 1.1 - 9);
  q(`update nv_email_queue set state='accepted', accepted_at=created_at where kind='welcome';
     insert into nv_email_milestones select 'sent:'||g from generate_series(1,79) g;
     insert into nv_email_queue(event_key,kind,recipient,payload,state,accepted_at)
     select 'sent:'||g,'welcome','old'||g||'@example.com','{}','accepted',${later} - interval '2 hours'
     from generate_series(1,79) g;`);
  assert.equal(run(later), 1);
  assert.equal(queued(expiring.client), 'first_parcel_d7');
  assert.equal(queued(newcomer.client), '');
  console.log('PASS: reminders keep 20 of the 100 daily emails free, send at most 20 an hour, most urgent first.');

  // Deleting a workspace removes its token; the kind list still takes every kind.
  q(`delete from clients where id='${fresh[0].client}';`);
  assert.equal(q(`select count(*) from nv_email_reminders where client_id='${fresh[0].client}'`), '0');
  for (const kind of ['welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected', 'first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7']) {
    q(`select nv_email_enqueue('kind-check:${kind}','${kind}','k@example.com','{}');`);
  }
  assert.throws(() => q(`select nv_email_enqueue('kind-check:bad','first_parcel_d2','k@example.com','{}');`), /nv_email_queue_kind_check/);
  assert.equal(Number(q('select nv_email_first_parcel_reminders()')) >= 0, true);
  console.log('PASS: workspace deletion cleans up, kinds are constrained, and the default clock runs.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
