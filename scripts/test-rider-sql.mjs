import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const bin=process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const dir=mkdtempSync(path.join(tmpdir(),'novax-rider-sql-')), db=path.join(dir,'data');
const args=['-h',dir,'-p','55443','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'];
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const q=sql=>execFileSync(path.join(bin,'psql'),args,{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const asRider=`set request.jwt.claim.sub='${id(101)}';`;
const rpc=(awb,to,key,reason="''",loc='null')=>`select rider_batch_update_status(array[${awb}], '${to}',${reason},'${key}',${loc});`;
const fails=(sql,text)=>{try{q(sql);assert.fail('Expected rejection');}catch(e){assert.match(String(e.stderr || e.message),text);}};
let started=false;
try {
  execFileSync(path.join(bin,'initdb'),['-D',db,'-A','trust','--no-locale'],{stdio:'ignore'});
  execFileSync(path.join(bin,'pg_ctl'),['-D',db,'-l',path.join(dir,'log'),'-o',`-c listen_addresses='' -k ${dir} -p 55443`,'-w','start'],{stdio:'ignore'});started=true;
  q(`create role anon;create role authenticated;create role service_role;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function is_admin() returns boolean language sql stable as $$select coalesce(current_setting('fixture.admin',true),'')='1'$$;
    create function can_process_orders() returns boolean language sql as $$select false$$;
    create table riders(id uuid primary key,name text,branch text);
    create table profiles(id uuid primary key,rider_id uuid,role text,status text);
    create table parcels(id uuid primary key default gen_random_uuid(),awb text unique,client_id uuid,rider_id uuid,
      cod_amount numeric default 0,status text not null,exception text,meta jsonb default '{}',updated_at timestamptz default now());
    create table scans(parcel_id uuid,rider_id uuid,type text,status text,lat numeric,lng numeric,note text);
    create table cod_ledger(parcel_id uuid,client_id uuid,rider_id uuid,direction text,amount numeric,reference text);
    create table rider_batches(batch_key text primary key,rider_id uuid,result jsonb);
    create table rider_cash_deposits(batch_key text primary key,rider_id uuid,gross numeric,expenses numeric,net numeric,parcel_ids uuid[],created_at timestamptz default now());
    insert into riders values('${id(1)}','Karachi Rider','Karachi'),('${id(2)}','Other Rider','Lahore');
    insert into profiles values('${id(101)}','${id(1)}','rider','active'),('${id(102)}','${id(2)}','rider','active');
    insert into parcels(awb,rider_id,status,cod_amount) values
      ('PICKUP','${id(1)}','New booked',1000),('RETURN','${id(1)}','Ready for return',1000),
      ('DELIVERY','${id(1)}','Parcel out for delivery',1000),('PREPAID','${id(1)}','Parcel out for delivery',0),
      ('OTHER','${id(2)}','Parcel now in transit',500),('TRANSIT','${id(1)}','Parcel now in transit',500),
      ('CONFLICT','${id(1)}','Parcel out for delivery',900);
    update parcels set meta='{"paymentMode":"non-cod"}' where awb='CONFLICT';`);
  const dump=readFileSync(new URL('../backend/functions/production_functions.sql',import.meta.url),'utf8');
  const trigger=dump.match(/CREATE OR REPLACE FUNCTION public\.enforce_parcel_status_transition\(\)[\s\S]*?\$function\$\s*;/)[0];
  q(trigger+`create trigger status_check before update on parcels for each row execute function enforce_parcel_status_transition();`);
  q(`alter table parcels add column consignee text,add column city text,add column address text,add column phone text,
    add column fee numeric,add column booked_at timestamptz,add column invoice_id uuid,add column invoiced_at timestamptz,
    add column delivery_charge_posted_at timestamptz,add column delivered_at timestamptz;`);
  const guards=readFileSync(new URL('../sql_novax_reversed_delivery_20260924.sql',import.meta.url),'utf8');
  q(guards.match(/CREATE OR REPLACE FUNCTION public\.novax_stamp_delivered_at\(\)[\s\S]*?\$function\$;/)[0]);
  q(guards.match(/CREATE OR REPLACE FUNCTION public\.parcels_guard_columns\(\)[\s\S]*?\$function\$;/)[0]);
  q('create trigger novax_delivered_at_trg before update on parcels for each row execute function novax_stamp_delivered_at();create trigger parcels_guard_columns_trg before update on parcels for each row execute function parcels_guard_columns();');
  const migration=readFileSync(new URL('../sql_novax_rider_launch_20260927.sql',import.meta.url),'utf8');q(migration);q(migration);
  assert.equal(q(`${asRider}select my_rider_id();`),id(1));
  fails(`${asRider}${rpc("'TRANSIT','OTHER'",'Parcel received at destination','rb-mixed-000000001')}`,/not assigned/);
  assert.equal(q("select status from parcels where awb='TRANSIT'"),'Parcel now in transit');
  fails(`${asRider}${rpc("'TRANSIT','UNKNOWN'",'Parcel received at destination','rb-missing-00000001')}`,/not assigned/);
  fails(`${asRider}${rpc("'PICKUP'",'Cancelled by client','rb-cancel-000000001')}`,/cannot move/);
  fails(`${asRider}${rpc("'DELIVERY'",'Refused','rb-reason-000000001')}`,/reason is required/);
  fails(`${asRider}${rpc("'CONFLICT'",'Delivered','rb-conflict-0000001')}`,/COD\/prepaid conflict/);
  fails(`${asRider}${rpc("'DELIVERY'",'Delivered','rb-gps-000000000001',"''",`'{"lat":200,"lng":1}'`)}`,/out of range/);
  fails(`${asRider}${rpc("'DELIVERY'",'Delivered','rb-gps-000000000002',"''",`'{"lat":"bad","lng":1}'`)}`,/Invalid GPS/);
  for(const [awb,steps] of [['PICKUP',['Collected by rider','Arrived at warehouse']],['RETURN',['Return in transit','Return received at origin','Return out for delivery','Return to shipper']]])
    for(const [i,to] of steps.entries())q(`${asRider}${rpc(`'${awb}'`,to,`rb-${awb}-step-0000${i}`)}`);
  const delivered=JSON.parse(q(`${asRider}${rpc("'DELIVERY'",'Delivered','rb-delivery-0000001',"''",`'{"lat":24.9,"lng":67.1,"accuracy":30}'`)}`));assert.equal(delivered.count,1);
  assert.deepEqual(JSON.parse(q(`${asRider}${rpc("'DELIVERY'",'Delivered','rb-delivery-0000001')}`)),delivered);
  assert.equal(JSON.parse(q(`${asRider}${rpc("'DELIVERY'",'Delivered','rb-rescan-000000001')}`)).count,0);
  assert.equal(q("select count(*) from cod_ledger where reference='DELIVERY'"),'1');
  q(`${asRider}${rpc("'PREPAID'",'Delivered','rb-prepaid-00000001')}`);
  assert.equal(q("select meta->>'cashDepositStatus' from parcels where awb='PREPAID'"),'not_required');
  fails(`${asRider}update parcels set meta=meta||'{"cashReceived":true}' where awb='DELIVERY';`,/secure rider/);
  fails(`${asRider}insert into cod_ledger(rider_id,amount) values('${id(1)}',999);`,/secure rider/);
  fails(`${asRider}insert into scans(rider_id,status) values('${id(1)}','Delivered');`,/secure rider/);
  fails(`${asRider}select rider_add_expense('expense-negative-0001','Fuel',-1,'');`,/Invalid expense/);
  fails(`${asRider}select rider_add_expense('expense-precision-01','Fuel',1.001,'');`,/Invalid expense/);
  q(`${asRider}select rider_add_expense('expense-unique-00001','Fuel',100,'receipt');`);
  q(`${asRider}select rider_add_expense('expense-unique-00001','Fuel',100,'receipt');`);
  assert.equal(q('select count(*) from rider_expense_requests'),'1');
  assert.equal(JSON.parse(q(`${asRider}select rider_cash_summary();`)).net,900);
  fails(`${asRider}select rider_deposit_cash_checked('deposit-wrong-000001',1000,100,901);`,/Cash position changed/);
  const deposit=JSON.parse(q(`${asRider}select rider_deposit_cash_checked('deposit-correct-0001',1000,100,900);`));assert.equal(deposit.net,900);
  assert.equal(JSON.parse(q(`${asRider}select rider_deposit_cash_checked('deposit-correct-0001',1000,100,900);`)).replayed,true);
  assert.equal(JSON.parse(q(`${asRider}select rider_cash_summary();`)).expenses,0);
  q(`set fixture.admin='1';insert into parcels(awb,rider_id,status,cod_amount) values('NEXT-DAY','${id(1)}','Delivered',500);`);
  assert.equal(JSON.parse(q(`${asRider}select rider_deposit_cash('deposit-next-day-001');`)).net,500);
  q(`update profiles set status='blocked' where id='${id(101)}';`);
  assert.equal(q(`${asRider}select my_rider_id() is null;`),'t');
  fails(`${asRider}${rpc("'TRANSIT'",'Parcel received at destination','rb-blocked-00000001')}`,/active rider/);
  q(`update profiles set status='active' where id='${id(101)}';`);
  const asyncQ=sql=>promisify(execFile)(path.join(bin,'psql'),[...args,'-c',sql]);
  await Promise.all([asyncQ(`${asRider}begin;${rpc("'TRANSIT'",'Parcel received at destination','rb-concurrent-00001')}select pg_sleep(0.15);commit;`),asyncQ(`${asRider}${rpc("'TRANSIT'",'Parcel received at destination','rb-concurrent-00001')}`)]);
  assert.equal(q("select count(*) from scans where status='Parcel received at destination'"),'1');
  assert.equal(q("select has_function_privilege('anon','rider_cash_summary()','execute')"),'f');
  assert.equal(q("select has_function_privilege('authenticated','nv_rider_expenses(uuid)','execute')"),'f');
  console.log('PASS rider SQL: migration replay, mixed-batch rollback, ownership, status whitelist, pickup/return chains, reasons, GPS, payment conflict, idempotency, concurrent replay, blocked accounts, expense validation, cash confirmation and one-time deductions.');
} finally {if(started)execFileSync(path.join(bin,'pg_ctl'),['-D',db,'-m','immediate','-w','stop'],{stdio:'ignore'});rmSync(dir,{recursive:true,force:true});}
