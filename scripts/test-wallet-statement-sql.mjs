import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// client_wallet_statement against a throwaway local PostgreSQL with fake data.
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.ok(existsSync(path.join(bin, 'initdb')), 'Set PG_BIN to your PostgreSQL binaries.');
const directory = mkdtempSync(path.join(tmpdir(), 'novax-statement-test-'));
const data = path.join(directory, 'data');
const args = ['-h', directory, '-p', '55444', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
const UA = '00000000-0000-0000-0001-00000000000a', UB = '00000000-0000-0000-0001-00000000000b';
// The statement as merchant `user` sees it.
const as = (user, period) => JSON.parse(q(`select set_config('request.jwt.claims', json_build_object('sub','${user}','role','authenticated')::text, false);
  set role authenticated; select client_wallet_statement('${period}');`).split('\n').pop());

let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'),
    '-o', `-c listen_addresses='' -k ${directory} -p 55444 -c timezone=UTC`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  q(`create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    create table clients(id uuid primary key, name text, wallet_balance numeric);
    create table profiles(id uuid primary key, client_id uuid, role text default 'client');
    create table withdrawals(id uuid primary key default gen_random_uuid(), client_id uuid, net numeric, status text,
      paid_at timestamptz, created_at timestamptz default now());
    create table wallet_ledger(id uuid primary key default gen_random_uuid(), client_id uuid, entry_type text, amount numeric,
      affects_balance boolean, status text, reference_type text, reference_id uuid, reference_code text, note text,
      created_at timestamptz);
    create function my_client_id() returns uuid language sql stable security definer set search_path to 'public' as
      $$ select client_id from profiles where id = auth.uid() $$;
    insert into clients values ('${A}','Store A',2500), ('${B}','Store B',100);
    insert into profiles values ('${UA}','${A}'), ('${UB}','${B}');
    insert into wallet_ledger(client_id,entry_type,amount,affects_balance,reference_code,created_at) values
      ('${A}','invoice_credit',5000,true,'INV-AUG','2026-08-20 10:00+05'),
      ('${A}','withdrawal_requested',-4000,true,'W1','2026-08-31 23:30+05'),
      ('${A}','payout_fee',-4,false,'W1','2026-08-31 23:30+05'),
      ('${A}','invoice_credit',2000,true,'INV-SEP-0030','2026-09-01 00:30+05'),
      ('${A}','invoice_due_debit',-500,true,'INV-SEP2','2026-09-20 10:00+05'),
      ('${B}','invoice_credit',100,true,'INV-B','2026-09-05 10:00+05');`);
  q(readFileSync(new URL('../sql_novax_wallet_statement_20260930.sql', import.meta.url), 'utf8'));

  const aug = as(UA, '2026-08'), sep = as(UA, '2026-09'), oct = as(UA, '2026-10'), all = as(UA, 'all');
  // 00:30 on 1 Sep in Karachi is still 31 Aug in UTC: it belongs to September.
  assert.deepEqual(aug.lines.map(l => l.reference_code), ['INV-AUG', 'W1']);
  assert.deepEqual(sep.lines.map(l => l.reference_code), ['INV-SEP-0030', 'INV-SEP2']);
  assert.equal(sep.lines[0].at, '2026-09-01 00:30');
  assert.equal(aug.lines[1].at, '2026-08-31 23:30');
  assert.deepEqual([aug.opening, aug.money_in, aug.money_out, aug.closing].map(Number), [0, 5000, 4000, 1000]);
  assert.deepEqual([sep.opening, sep.money_in, sep.money_out, sep.closing].map(Number), [1000, 2000, 500, 2500]);
  assert.deepEqual(sep.lines.map(l => Number(l.balance)), [3000, 2500]);
  assert.deepEqual([oct.opening, oct.closing, oct.lines.length].map(Number), [2500, 2500, 0]);
  assert.deepEqual([all.opening, all.closing, all.lines.length].map(Number), [0, 2500, 4]);
  assert.equal(all.first_day, '2026-08-20');
  assert.equal(sep.first_day, '2026-09-01');
  assert.equal(aug.last_day, '2026-08-31');
  assert.equal(Number(sep.balance_now), 2500);
  assert.ok(!aug.lines.some(l => l.entry_type === 'payout_fee'), 'info rows never move the balance');
  console.log('PASS: Pakistan months (00:30 on the 1st is the new month), opening + in - out = closing, months chain, running balance.');

  // Each merchant sees only their own wallet.
  const b = as(UB, 'all');
  assert.deepEqual(b.lines.map(l => l.reference_code), ['INV-B']);
  assert.equal(Number(b.closing), 100);
  assert.throws(() => as('00000000-0000-0000-0001-0000000000ff', '2026-09'), /No client account linked/);
  for (const bad of ['2026-13', '2026-9', 'x', "2026-09' or '1'='1"]) {
    assert.throws(() => as(UA, bad.replaceAll("'", "''")), /Pick a month/);
  }
  assert.equal(q("select has_function_privilege('anon','client_wallet_statement(text)','EXECUTE')"), 'f');
  assert.equal(q("select has_function_privilege('authenticated','client_wallet_statement(text)','EXECUTE')"), 't');
  console.log('PASS: only your own wallet, no account link refused, bad months refused, signed-out browsers refused.');

  // A payout this month still counts after the summary moved to Pakistan months.
  q(`insert into withdrawals(client_id,net,status,paid_at) values ('${A}',700,'Paid',now() - interval '1 minute'),
      ('${A}',300,'Pending admin payout',null), ('${A}',50,'Rejected / Cancelled',null);`);
  const summary = q(`select set_config('request.jwt.claims', json_build_object('sub','${UA}','role','authenticated')::text, false);
    set role authenticated; select row_to_json(s) from client_wallet_summary() s;`).split('\n').pop();
  assert.deepEqual(JSON.parse(summary), { available_balance: 2500, pending_payout: 300, paid_this_month: 700, lifetime_withdrawn: 700 });
  console.log('PASS: wallet summary: pending counts only payouts being paid, paid this month in Pakistan months.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
