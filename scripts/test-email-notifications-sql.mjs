import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.ok(existsSync(path.join(bin, 'initdb')), 'Set PG_BIN to your PostgreSQL binaries.');
const directory = mkdtempSync(path.join(tmpdir(), 'novax-email-test-'));
const data = path.join(directory, 'data');
const args = ['-h', directory, '-p', '55441', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8' }).trim();
const asyncQuery = sql => promisify(execFile)(path.join(bin, 'psql'), [...args, '-c', sql]);
const migration = readFileSync(new URL('../sql_novax_email_notifications_20260927.sql', import.meta.url), 'utf8');
let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'),
    '-o', `-c listen_addresses='' -k ${directory} -p 55441`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  q(`create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', invited_at timestamptz);
    create table clients(id uuid primary key, name text, meta jsonb default '{}');
    create table profiles(id uuid primary key, client_id uuid, role text default 'client',
      status text default 'active', created_at timestamptz default now());
    create table staff_users(auth_user_id uuid, client_id uuid, email text, role text, status text);
    create table parcels(id uuid primary key default gen_random_uuid(), client_id uuid, awb text,
      booked_at timestamptz default now());
    create table withdrawals(id uuid primary key, client_id uuid, amount numeric, fee numeric, net numeric,
      status text, paid_at timestamptz, paid_txn_id text);
    insert into clients values ('${uuid(1)}','Existing merchant','{"email":"owner1@example.com"}'),
      ('${uuid(2)}','New merchant','{"email":"owner2@example.com"}'),
      ('${uuid(3)}','Revoked owner','{}'), ('${uuid(4)}','Concurrent merchant','{}');
    insert into auth.users(id,email) values ('${uuid(101)}','owner1@example.com'),
      ('${uuid(102)}','owner2@example.com'), ('${uuid(103)}','revoked@example.com'),
      ('${uuid(104)}','concurrent@example.com'), ('${uuid(105)}','finance@example.com');
    insert into profiles(id,client_id) values ('${uuid(101)}','${uuid(1)}'),
      ('${uuid(102)}','${uuid(2)}'), ('${uuid(103)}','${uuid(3)}'),
      ('${uuid(104)}','${uuid(4)}'), ('${uuid(105)}','${uuid(3)}');
    insert into staff_users values ('${uuid(103)}','${uuid(3)}','revoked@example.com','Owner','Revoked'),
      ('${uuid(105)}','${uuid(3)}','finance@example.com','Finance','Active');
    insert into parcels(client_id,awb) values ('${uuid(1)}','OLD-BOOKING');
    insert into withdrawals values ('${uuid(301)}','${uuid(1)}',10500,500,10000,'Paid',now(),'OLD-PAYMENT'),
      ('${uuid(302)}','${uuid(2)}',10500,500,10000,'Pending admin payout',null,null),
      ('${uuid(303)}','${uuid(2)}',10500,500,10000,'Pending admin payout',null,null);`);
  q(migration);
  assert.equal(q('select count(*) from nv_email_queue'), '0');
  q(`begin; insert into auth.users(id,email,raw_user_meta_data) values
    ('${uuid(109)}','rollback@example.com','{"role":"client"}'); rollback;`);
  assert.equal(q('select count(*) from nv_email_queue'), '0');
  q(`insert into auth.users(id,email,raw_user_meta_data) values
    ('${uuid(110)}','signup@example.com','{"role":"client","full_name":"Sample Owner"}'),
    ('${uuid(111)}','admin@example.com','{"role":"admin"}'),
    ('${uuid(112)}','team@example.com','{"role":"client","created_by_owner":"fixture"}'),
    ('${uuid(113)}','invite@example.com','{"novax_role":"Warehouse"}');`);
  assert.equal(q("select count(*) from nv_email_queue where kind='welcome'"), '1');
  q(`update auth.users set email='signup@example.com' where id='${uuid(110)}';`);
  assert.equal(q("select count(*) from nv_email_queue where kind='welcome'"), '1');
  q(`insert into parcels(client_id,awb) values ('${uuid(1)}','NOT-FIRST'),
    ('${uuid(2)}','FIRST-BOOKING'), ('${uuid(2)}','SECOND-BOOKING'), ('${uuid(3)}','REVIEW-BOOKING');`);
  assert.equal(q("select count(*) from nv_email_queue where kind='first_booking'"), '2');
  assert.equal(q("select recipient from nv_email_queue where payload->>'awb'='FIRST-BOOKING'"), 'owner2@example.com');
  assert.equal(q("select state||':'||last_error from nv_email_queue where payload->>'awb'='REVIEW-BOOKING'"), 'review:owner_email_missing');
  q(`delete from parcels where client_id='${uuid(2)}';
    insert into parcels(client_id,awb) values ('${uuid(2)}','AFTER-DELETE');`);
  assert.equal(q("select count(*) from nv_email_queue where kind='first_booking'"), '2');
  await Promise.all([
    asyncQuery(`begin; insert into parcels(client_id,awb) values ('${uuid(4)}','CONCURRENT-1'); select pg_sleep(0.2); commit;`),
    asyncQuery(`begin; insert into parcels(client_id,awb) values ('${uuid(4)}','CONCURRENT-2'); commit;`),
  ]);
  assert.equal(q(`select count(*) from nv_email_queue where event_key='first_booking:${uuid(4)}'`), '1');
  q(`update withdrawals set status='Paid',paid_at=now(),paid_txn_id='TRANSFER-001' where id='${uuid(302)}';
    update withdrawals set status='Paid' where id='${uuid(302)}';
    update withdrawals set status='Rejected' where id='${uuid(303)}';
    update withdrawals set status='Pending admin payout' where id in ('${uuid(301)}','${uuid(302)}');
    update withdrawals set status='Paid' where id in ('${uuid(301)}','${uuid(302)}');`);
  assert.equal(q("select count(*) from nv_email_queue where kind='payout_paid'"), '1');
  assert.equal(q("select recipient||':'||(payload->>'net') from nv_email_queue where kind='payout_paid'"), 'owner2@example.com:10000');
  q(migration);
  assert.equal(q('select count(*) from nv_email_queue'), '5');
  console.log('PASS: migration/rerun, signup filtering, existing clients, concurrent first booking, deletion and paid transitions.');

  for (const role of ['anon', 'authenticated']) {
    assert.equal(q(`select has_table_privilege('${role}','nv_email_queue','SELECT')`), 'f');
    assert.equal(q(`select has_function_privilege('${role}','nv_email_claim(integer)','EXECUTE')`), 'f');
    assert.equal(q(`select has_function_privilege('${role}','nv_email_enqueue(text,text,text,jsonb)','EXECUTE')`), 'f');
  }
  assert.equal(q("select has_table_privilege('service_role','nv_email_queue','INSERT')"), 'f');
  assert.equal(q("select has_function_privilege('service_role','nv_email_claim(integer)','EXECUTE')"), 't');
  const claimed = JSON.parse(q('select coalesce(json_agg(c),\'[]\'::json) from nv_email_claim(100) c'));
  assert.equal(claimed.length, 4);
  assert.equal(q('select count(*) from nv_email_claim(5)'), '0');
  const job = claimed[0];
  assert.equal(q(`select nv_email_prepare('${job.id}','${uuid(999)}','{"subject":"Wrong"}') is null`), 't');
  assert.equal(q(`select nv_email_prepare('${job.id}','${job.lease_token}','{"subject":"Original"}')`), '{"subject":"Original"}');
  assert.equal(q(`select nv_email_prepare('${job.id}','${job.lease_token}','{"subject":"Edited"}')`), '{"subject":"Original"}');
  assert.equal(q(`select nv_email_result('${job.id}','${uuid(999)}','wrong-provider',null)`), 'f');
  assert.equal(q(`select nv_email_result('${job.id}','${job.lease_token}','provider-accepted',null)`), 't');
  assert.equal(q(`select state||':'||provider_id from nv_email_queue where id='${job.id}'`), 'accepted:provider-accepted');
  const expired = claimed[1];
  q(`update nv_email_queue set lease_until=now()-interval '1 minute',
    first_attempt_at=now()-interval '23 hours', next_attempt_at=now() where id='${expired.id}';`);
  q('select count(*) from nv_email_claim(5)');
  assert.equal(q(`select state||':'||last_error from nv_email_queue where id='${expired.id}'`), 'review:retry_window_expired');
  const retry = claimed[2];
  assert.equal(q(`select nv_email_result('${retry.id}','${retry.lease_token}',null,'resend_http_500',false,120)`), 't');
  assert.equal(q(`select state||':'||attempts from nv_email_queue where id='${retry.id}'`), 'pending:1');
  assert.equal(q(`select next_attempt_at > now()+interval '110 seconds' from nv_email_queue where id='${retry.id}'`), 't');
  q(`update nv_email_queue set next_attempt_at=now() where id='${retry.id}';`);
  const renewed = JSON.parse(q('select json_agg(c) from nv_email_claim(5) c'))[0];
  assert.notEqual(renewed.lease_token, retry.lease_token);
  assert.equal(q(`select nv_email_result('${retry.id}','${retry.lease_token}','stale-provider',null)`), 'f');
  assert.equal(q(`select nv_email_result('${renewed.id}','${renewed.lease_token}',null,'resend_http_422',true)`), 't');
  assert.equal(q(`select state from nv_email_queue where id='${renewed.id}'`), 'review');
  console.log('PASS: access control, bounded claim, leases, immutable body, retries and 23-hour cutoff.');

  // Verify scheduler control flow without installing pg_net/pg_cron in this fixture.
  q(`create schema vault; create schema net; create schema cron;
    create table vault.decrypted_secrets(name text, decrypted_secret text);
    create table net.requests(url text, headers jsonb, body jsonb, timeout_milliseconds integer);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
    returns bigint language plpgsql as $$ begin
      insert into net.requests values(url,headers,body,timeout_milliseconds); return 1; end $$;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;`);
  const schedule = readFileSync(new URL('../sql_novax_email_schedule_20260927.sql', import.meta.url), 'utf8')
    .replace(/^create extension[^\n]+\n/gm, '');
  q(schedule);
  q('select nv_email_tick()');
  assert.equal(q('select count(*) from net.requests'), '0');
  q(`insert into vault.decrypted_secrets values ('novax_email_drain_token',repeat('x',64));
    update nv_email_queue set state='accepted' where state='pending'; select nv_email_tick();`);
  assert.equal(q('select count(*) from net.requests'), '0');
  q(`update nv_email_queue set state='pending',next_attempt_at=now(),lease_until=null
    where id='${expired.id}'; select nv_email_tick();`);
  assert.equal(q('select count(*) from net.requests'), '1');
  assert.equal(q("select headers->>'x-novax-email-drain'=repeat('x',64) from net.requests"), 't');
  assert.equal(q("select url like '%/functions/v1/novax-email-drain' from net.requests"), 't');
  assert.equal(q("select has_function_privilege('authenticated','nv_email_tick()','EXECUTE')"), 'f');
  q(`create function public.nv_api_drain_token() returns text language sql as $$ select repeat('y',64) $$;
    delete from vault.decrypted_secrets; select nv_email_tick();`);
  assert.equal(q('select count(*) from net.requests'), '2');
  assert.equal(q("select bool_or(headers->>'x-novax-email-drain'=repeat('y',64)) from net.requests"), 't');
  console.log('PASS: scheduler stays disabled without token, skips idle queue and sends only to NovaX worker.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
