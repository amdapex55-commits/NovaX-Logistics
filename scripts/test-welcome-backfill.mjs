import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const directory = mkdtempSync(path.join(tmpdir(), 'novax-backfill-test-'));
const data = path.join(directory, 'data');
const args = ['-h', directory, '-p', '55442', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8' }).trim();
const sql = readFileSync(new URL('../sql_novax_welcome_backfill_20260927.sql', import.meta.url), 'utf8');
let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'),
    '-o', `-c listen_addresses='' -k ${directory} -p 55442`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  q(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      invited_at timestamptz, created_at timestamptz);
    create table clients(id uuid primary key, name text, meta jsonb default '{}', status text default 'Active');
    create table profiles(id uuid primary key, client_id uuid, role text default 'client',
      status text default 'active', created_at timestamptz default now());
    create table staff_users(auth_user_id uuid, client_id uuid, email text, role text, status text);
    create table parcels(id uuid primary key, client_id uuid, awb text, booked_at timestamptz);
    create table withdrawals(id uuid primary key, client_id uuid, amount numeric, fee numeric, net numeric,
      status text, paid_at timestamptz, paid_txn_id text);
    insert into clients(id,name) select md5('client-'||g)::uuid,'Business '||g from generate_series(1,292) g;
    insert into auth.users(id,email,created_at,raw_user_meta_data)
      select md5('owner-'||g)::uuid, 'owner'||g||'@example.com',
      timestamptz '2026-09-27 16:00+00' - (286-g)*interval '1 hour',
      jsonb_build_object('full_name','Owner '||g) from generate_series(1,286) g;
    insert into profiles(id,client_id)
      select md5('owner-'||g)::uuid,md5('client-'||g)::uuid from generate_series(1,286) g;`);
  q(readFileSync(new URL('../sql_novax_email_notifications_20260927.sql', import.meta.url), 'utf8'));
  q(`select nv_email_enqueue('welcome:'||md5('owner-286')::uuid,'welcome','OWNER286@example.com','{}');
    update nv_email_queue set state='accepted',provider_id='existing-welcome';`);
  q(sql);
  assert.equal(q("select count(*) from nv_email_queue where payload->>'campaign'='existing-clients-20260927'"), '285');
  assert.equal(q("select string_agg(n::text,',' order by batch) from (select payload->>'batch' batch,count(*) n from nv_email_queue where payload ? 'campaign' group by batch) s"), '75,75,75,60');
  assert.equal(q("select recipient from nv_email_queue where payload->>'priority'='1'"), 'owner285@example.com');
  assert.equal(q("select recipient from nv_email_queue where payload->>'priority'='285'"), 'owner1@example.com');
  assert.equal(q("select payload->>'name'||':'||(payload->>'business') from nv_email_queue where payload->>'priority'='1'"), 'Owner 285:Business 285');
  assert.equal(q("select count(*) from nv_email_queue where next_attempt_at < now()+interval '1 hour' and payload ? 'campaign'"), '75');
  assert.equal(q("select min(next_attempt_at)-max(previous_due) >= interval '24 hours' from (select next_attempt_at,(select max(next_attempt_at) from nv_email_queue where payload->>'batch'='1') previous_due from nv_email_queue where payload->>'batch'='2') s"), 't');
  q(sql);
  assert.equal(q('select count(*) from nv_email_queue'), '286');
  q(`update clients set status='Inactive' where name='Business 285';`);
  q(sql);
  assert.equal(q('select count(*) from nv_email_queue'), '286');
  console.log('PASS: latest signups first, 75/75/75/60 batches, 25-hour spacing, correct personalization, duplicate prevention and campaign rerun.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
