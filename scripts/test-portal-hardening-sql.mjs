import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Team seats against the live policy text of sql_novax_portal_hardening_20261001.sql,
// on a throwaway local PostgreSQL. Never contacts the live project.
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
assert.ok(existsSync(path.join(bin, 'initdb')), 'Set PG_BIN to your PostgreSQL binaries.');
const directory = mkdtempSync(path.join(tmpdir(), 'novax-seats-test-'));
const data = path.join(directory, 'data');
const args = ['-h', directory, '-p', '55445', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const q = sql => execFileSync(path.join(bin, 'psql'), args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const migration = readFileSync(new URL('../sql_novax_portal_hardening_20261001.sql', import.meta.url), 'utf8');
// Helpers and policies only; the big function bodies need the whole production schema.
const part = migration.slice(migration.indexOf('create or replace function public.nv_client_can_see_money()'),
  migration.indexOf('-- Summary and statement'));
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2);
const U = { owner: id(11), finance: id(12), warehouse: id(13), support: id(14), ownerSeat: id(15), revoked: id(16), otherOwner: id(21) };
const as = (who, sql) => q(`select set_config('request.jwt.claims', json_build_object('sub','${U[who]}','role','authenticated','email','${who}@example.com')::text, false);
  set role authenticated; ${sql}`).split('\n').pop();

let started = false;
try {
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'),
    '-o', `-c listen_addresses='' -k ${directory} -p 55445`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  q(`create role anon; create role authenticated; create role service_role;
    create schema auth; grant usage on schema auth to authenticated;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb $$;
    create table clients(id uuid primary key, name text);
    create table profiles(id uuid primary key, client_id uuid, role text default 'client', email text, created_at timestamptz default now());
    create table staff_users(id uuid primary key default gen_random_uuid(), client_id uuid, auth_user_id uuid, email text, role text, status text default 'Active');
    create table wallet_ledger(id serial primary key, client_id uuid, amount numeric);
    create table withdrawals(id serial primary key, client_id uuid, net numeric, iban text);
    create table invoices(id serial primary key, client_id uuid);
    create table store_connections(id serial primary key, client_id uuid, platform text, store_url text, meta jsonb default '{}');
    create function my_client_id() returns uuid language sql stable security definer set search_path to 'public' as $$ select client_id from profiles where id = auth.uid() $$;
    create function is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
    create function is_client_owner_seat() returns boolean language sql stable security definer set search_path to 'public' as $$
      select my_client_id() is not null and (
        not exists (select 1 from staff_users su where su.client_id = my_client_id()
          and (su.auth_user_id = auth.uid() or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), ''))))
        or exists (select 1 from staff_users su where su.client_id = my_client_id()
          and (su.auth_user_id = auth.uid() or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
          and lower(coalesce(su.role, '')) in ('owner', 'client') and coalesce(su.status, 'Active') <> 'Revoked')) $$;
    alter table wallet_ledger enable row level security; alter table withdrawals enable row level security;
    alter table invoices enable row level security; alter table store_connections enable row level security; alter table staff_users enable row level security;
    grant select, insert, update, delete on wallet_ledger, withdrawals, invoices, store_connections, staff_users to authenticated;
    grant usage on sequence store_connections_id_seq to authenticated;
    grant execute on function my_client_id(), is_admin(), is_client_owner_seat() to authenticated;
    create policy wallet_ledger_client_select on wallet_ledger for select using (client_id = (select my_client_id()));
    create policy wallet_ledger_admin_select on wallet_ledger for select using ((select is_admin()));
    create policy wd_sel on withdrawals for select using (client_id = (select my_client_id()) or (select is_admin()));
    create policy invoices_owner_read on invoices for select using ((select is_admin()) or client_id = (select my_client_id()));
    create policy sc_all on store_connections for all using (client_id = (select my_client_id()) or (select is_admin()));
    create policy "client reads own team" on staff_users for select using (client_id is not null and client_id = (select my_client_id()));
    insert into clients values ('${A}','Store A'), ('${B}','Store B');
    insert into auth.users select v, k || '@example.com' from (values ${Object.entries(U).map(([k, v]) => `('${k}','${v}'::uuid)`).join(',')}) x(k, v);
    insert into profiles(id, client_id, email) select v, case when k = 'otherOwner' then '${B}'::uuid else '${A}'::uuid end, k || '@example.com'
      from (values ${Object.entries(U).map(([k, v]) => `('${k}','${v}'::uuid)`).join(',')}) x(k, v);
    insert into staff_users(client_id, auth_user_id, email, role, status) values
      ('${A}','${U.finance}','finance@example.com','Finance','Active'), ('${A}','${U.warehouse}','warehouse@example.com','Warehouse','Active'),
      ('${A}','${U.support}','support@example.com','Support','Active'), ('${A}','${U.ownerSeat}','ownerSeat@example.com','Owner','Active'),
      ('${A}','${U.revoked}','revoked@example.com','Finance','Revoked');
    insert into wallet_ledger(client_id, amount) values ('${A}',100), ('${A}',-40), ('${B}',5);
    insert into withdrawals(client_id, net, iban) values ('${A}',40,'PK36SCBL0000001123456702');
    insert into invoices(client_id) values ('${A}'), ('${A}'), ('${B}');
    insert into store_connections(client_id, platform, store_url) values ('${A}','web','https://a.example.com');`);
  q(part);

  const money = who => as(who, `select (select count(*) from wallet_ledger)||'/'||(select count(*) from withdrawals)||'/'||(select count(*) from invoices);`);
  assert.equal(money('owner'), '2/1/2', 'the account holder sees the wallet');
  assert.equal(money('ownerSeat'), '2/1/2', 'an Owner seat sees the wallet');
  assert.equal(money('finance'), '2/1/2', 'Finance sees the wallet');
  assert.equal(money('warehouse'), '0/0/0', 'Warehouse does not');
  assert.equal(money('support'), '0/0/0', 'Support does not');
  assert.equal(money('revoked'), '0/0/0', 'a revoked seat does not');
  assert.equal(money('otherOwner'), '1/0/1', 'another merchant sees only their own');
  console.log('PASS: wallet ledger, withdrawals and invoices: Owner and Finance only, never Warehouse, Support or a revoked seat.');

  const team = who => as(who, 'select count(*) from staff_users;');
  assert.equal(team('owner'), '5'); assert.equal(team('ownerSeat'), '5');
  for (const who of ['finance', 'warehouse', 'support']) assert.equal(team(who), '1', who + ' sees only its own seat');
  assert.equal(team('otherOwner'), '0');
  console.log('PASS: team list: Owners see everyone, any other seat only its own row.');

  assert.equal(as('support', 'select count(*) from store_connections;'), '1', 'every seat can see the connection');
  assert.equal(as('support', "with u as (update store_connections set store_url='https://evil.example.com' returning 1) select count(*) from u;"), '0');
  assert.throws(() => as('warehouse', "insert into store_connections(client_id, platform, store_url) values ('" + A + "','web','https://x.example.com');"), /row-level security/);
  assert.equal(as('owner', "with u as (update store_connections set store_url='https://b.example.com' returning 1) select count(*) from u;"), '1');
  assert.equal(as('ownerSeat', "with u as (update store_connections set meta='{}' returning 1) select count(*) from u;"), '1');
  assert.equal(as('otherOwner', "with u as (update store_connections set meta='{}' returning 1) select count(*) from u;"), '0');
  console.log('PASS: store connections: every seat sees them, only an Owner can change them.');

  assert.equal(q(`select string_agg(public.nv_iban_pk_valid(x)::text, ',') from unnest(array['PK36SCBL0000001123456702','PK36 SCBL 0000 0011 2345 6702',
    'PK40MEZN0000001123456702','PK37SCBL0000001123456702','PK12INVALIDXXXXX','PK36SCBL000000112345670',null]) x;`), 'true,true,true,false,false,false,false');
  assert.equal(q(`select string_agg(public.nv_public_https_url(x)::text, ',') from unnest(array['https://shop.example.com/api/novax','https://shop.example.com:443/x',
    'http://shop.example.com','https://127.0.0.1/x','https://localhost/x','https://printer.local','https://shop','https://shop.example.com:8443/x']) x;`),
    'true,true,false,false,false,false,false,false');
  console.log('PASS: IBAN (24 characters with valid check digits) and public https URL checks.');
} finally {
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
