-- Nova Instant wallets: freelance riders on commission, client accounts, COD.
-- 5 Oct 2026. Re-runnable. Apply AFTER sql_novax_nova_instant_20261004.sql.
-- sql_novax_instant_audit_20261006.sql replaces some functions made here, so
-- apply all three together and in order: scripts/instant-migrate.sh.
-- Nothing here touches NovaX Logistics money (wallet, payouts, merchants):
-- every table is nvi_*, and Instant clients have their own login role.
--
-- The rule: money is never a number that gets changed. It is a list of
-- entries (nvi_ledger), grouped in transactions (nvi_txns) whose entries add
-- up to zero. A balance is the sum of a wallet's entries. Entries are never
-- edited or deleted; a mistake is corrected with a new entry.
--
-- Sign: for a rider or client wallet, above zero = NovaX owes them, below
-- zero = they owe NovaX. House wallets: 'commission' (NovaX's earnings),
-- 'cash' (money NovaX holds; it goes below zero as cash comes in),
-- 'payouts_due' (asked for, not yet paid), 'adjustments' (ops corrections).
--
-- Per delivered job (F fare + return fee, C commission, A cash on delivery):
--   cash fare:  rider -C, commission +C               (the rider kept F)
--   COD:        rider -A +F -C, client pending +(A-F-fee), commission +C+fee
-- A rider's deposit: rider +D, cash -D; then the oldest COD jobs the deposit
-- covers move from the client's pending to available (nvi_release_cod).
-- A payout or withdrawal: wallet -W, payouts_due +W; paid: payouts_due -W,
-- cash +W; rejected: payouts_due -W, wallet +W.
--
-- Defaults (Aisha, 5 Oct): 20% commission, Rs 15,000 rider cash limit,
-- Rs 10,000 COD cap, no COD fee, Rs 500 minimum withdrawal, COD withdrawable
-- once the rider has deposited it, CNIC number before a client's first
-- withdrawal. All are nvi_config columns.

-- (Settings, nvi_clients and the job COD columns live in sql_novax_nova_instant_20261004.sql.)

-- ═══════════════════ Ledger ═══════════════════
create table if not exists public.nvi_wallets (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('rider', 'client', 'house')),
  owner      uuid,                       -- nvi_riders.id or nvi_clients.id
  code       text,                       -- house wallets only
  created_at timestamptz not null default now(),
  check ((kind = 'house') = (code is not null)),
  check ((kind = 'house') = (owner is null))
);
create unique index if not exists nvi_wallets_owner on public.nvi_wallets(kind, owner) where owner is not null;
create unique index if not exists nvi_wallets_code on public.nvi_wallets(code) where code is not null;

create table if not exists public.nvi_txns (
  id       uuid primary key default gen_random_uuid(),
  key      text not null unique,          -- the same key twice is the same money once
  kind     text not null,
  job_id   uuid references public.nvi_jobs(id),
  ref      text,
  note     text,
  by_user  uuid,
  at       timestamptz not null default now()
);
create table if not exists public.nvi_ledger (
  id        bigserial primary key,
  txn_id    uuid not null references public.nvi_txns(id),
  wallet_id uuid not null references public.nvi_wallets(id),
  bucket    text not null default 'available' check (bucket in ('available', 'pending')),
  amount    int not null check (amount <> 0),
  at        timestamptz not null default now()
);
create index if not exists nvi_ledger_wallet on public.nvi_ledger(wallet_id, at desc);
create index if not exists nvi_ledger_txn on public.nvi_ledger(txn_id);

-- A rider's "I sent the cash" and anyone's "pay me": requests ops acts on.
create table if not exists public.nvi_deposits (
  id         bigserial primary key,
  rider_id   uuid not null references public.nvi_riders(id),
  amount     int not null check (amount > 0),
  method     text not null check (method in ('JazzCash', 'Easypaisa', 'Bank', 'Office')),
  ref        text,
  status     text not null default 'Claimed' check (status in ('Claimed', 'Confirmed', 'Rejected')),
  confirmed_amount int,
  note       text,
  at         timestamptz not null default now(),
  done_at    timestamptz,
  done_by    uuid
);
create table if not exists public.nvi_payouts (
  id         bigserial primary key,
  wallet_id  uuid not null references public.nvi_wallets(id),
  amount     int not null check (amount > 0),
  method     text not null check (method in ('JazzCash', 'Easypaisa', 'Bank')),
  account_title  text not null,
  account_number text not null,
  status     text not null default 'Requested' check (status in ('Requested', 'Paid', 'Rejected')),
  ref        text,
  note       text,
  at         timestamptz not null default now(),
  done_at    timestamptz,
  done_by    uuid
);
create index if not exists nvi_payouts_open on public.nvi_payouts(status, at);
-- A deposit claim sent twice (a lost reply, a second tap) is the same claim.
alter table public.nvi_deposits add column if not exists req_key uuid;
create unique index if not exists nvi_deposits_key on public.nvi_deposits(req_key) where req_key is not null;
-- One transaction ID can be claimed once per method (a rejected claim frees it).
create unique index if not exists nvi_deposits_ref on public.nvi_deposits(method, lower(ref)) where ref is not null and status <> 'Rejected';
create index if not exists nvi_deposits_open on public.nvi_deposits(status, at);

-- Entries and transactions are permanent.
create or replace function public.nvi_ledger_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Ledger entries cannot be changed or deleted. Post a correction instead.' using errcode = '42501';
end $$;
drop trigger if exists nvi_ledger_frozen on public.nvi_ledger;
create trigger nvi_ledger_frozen before update or delete on public.nvi_ledger for each row execute function public.nvi_ledger_frozen();
drop trigger if exists nvi_txns_frozen on public.nvi_txns;
create trigger nvi_txns_frozen before update or delete on public.nvi_txns for each row execute function public.nvi_ledger_frozen();

alter table public.nvi_clients  enable row level security;
alter table public.nvi_wallets  enable row level security;
alter table public.nvi_txns     enable row level security;
alter table public.nvi_ledger   enable row level security;
alter table public.nvi_deposits enable row level security;
alter table public.nvi_payouts  enable row level security;
revoke all on public.nvi_clients, public.nvi_wallets, public.nvi_txns, public.nvi_ledger, public.nvi_deposits, public.nvi_payouts
  from public, anon, authenticated;
revoke all on sequence public.nvi_ledger_id_seq, public.nvi_deposits_id_seq, public.nvi_payouts_id_seq from public, anon, authenticated;

-- ═══════════════════ Ledger helpers ═══════════════════
create or replace function public.nvi_wallet_id(p_kind text, p_owner uuid, p_code text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if p_kind = 'house' then
    select id into v from public.nvi_wallets where code = p_code;
    if v is null then
      insert into public.nvi_wallets (kind, code) values ('house', p_code) on conflict do nothing;
      select id into v from public.nvi_wallets where code = p_code;
    end if;
  else
    select id into v from public.nvi_wallets where kind = p_kind and owner = p_owner;
    if v is null then
      insert into public.nvi_wallets (kind, owner) values (p_kind, p_owner) on conflict do nothing;
      select id into v from public.nvi_wallets where kind = p_kind and owner = p_owner;
    end if;
  end if;
  return v;
end $$;

-- Lines: [{"w": wallet uuid, "b": "available"|"pending", "a": rupees}, ...].
-- Zero lines are skipped; the rest must add up to zero. Returns the txn id,
-- or the earlier one when this key was already posted.
create or replace function public.nvi_post(p_key text, p_kind text, p_lines jsonb,
  p_job uuid default null, p_ref text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_txn uuid; v_sum bigint; l jsonb;
begin
  select id into v_txn from public.nvi_txns where key = p_key;
  if v_txn is not null then return v_txn; end if;
  select coalesce(sum((x->>'a')::int), 0) into v_sum from jsonb_array_elements(p_lines) x;
  if v_sum <> 0 then raise exception 'Unbalanced money movement % (off by %).', p_key, v_sum; end if;
  insert into public.nvi_txns (key, kind, job_id, ref, note, by_user)
  values (p_key, p_kind, p_job, nullif(left(btrim(coalesce(p_ref, '')), 120), ''), nullif(left(btrim(coalesce(p_note, '')), 300), ''), (select auth.uid()))
  returning id into v_txn;
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((l->>'a')::int, 0) <> 0 then
      insert into public.nvi_ledger (txn_id, wallet_id, bucket, amount)
      values (v_txn, (l->>'w')::uuid, coalesce(l->>'b', 'available'), (l->>'a')::int);
    end if;
  end loop;
  return v_txn;
end $$;

create or replace function public.nvi_balance(p_wallet uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'available', coalesce(sum(amount) filter (where bucket = 'available'), 0),
    'pending',   coalesce(sum(amount) filter (where bucket = 'pending'), 0))
    from public.nvi_ledger where wallet_id = p_wallet
$$;
create or replace function public.nvi_avail(p_wallet uuid)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0)::int from public.nvi_ledger where wallet_id = p_wallet and bucket = 'available'
$$;

-- A wallet's history, newest first, with the job each entry belongs to.
create or replace function public.nvi_entries(p_wallet uuid, p_limit int default 60)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'at' desc, (x->>'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object('id', l.id, 'at', l.at, 'amount', l.amount, 'bucket', l.bucket, 'kind', t.kind,
             'ref', t.ref, 'note', t.note, 'code', (select j.code from public.nvi_jobs j where j.id = t.job_id)) x
      from public.nvi_ledger l join public.nvi_txns t on t.id = l.txn_id
     where l.wallet_id = p_wallet
     order by l.at desc, l.id desc
     limit greatest(1, least(coalesce(p_limit, 60), 200))) s
$$;

-- Move the oldest COD jobs this rider's deposits have covered from the
-- client's pending to available. The cash a rider still owes is counted
-- against their newest COD jobs, so a client is paid only from cash NovaX holds.
create or replace function public.nvi_release_cod(p_rider uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_debt int := greatest(0, -public.nvi_avail(public.nvi_wallet_id('rider', p_rider, null)));
  v_left int; v_a int; v_net int; v_cw uuid; v_n int := 0; j record;
begin
  select coalesce(sum(least(cod_amount, coalesce(cash_collected, cod_amount))), 0) into v_left
    from public.nvi_jobs where rider_id = p_rider and cod_amount > 0 and status = 'Delivered'
     and ledger_at is not null and cod_released_at is null;
  for j in select * from public.nvi_jobs where rider_id = p_rider and cod_amount > 0 and status = 'Delivered'
             and ledger_at is not null and cod_released_at is null order by delivered_at, id for update loop
    v_a := least(j.cod_amount, coalesce(j.cash_collected, j.cod_amount));
    exit when v_left - v_a < v_debt;
    v_left := v_left - v_a;
    v_net := v_a - j.fare - j.cod_fee;
    if j.client_id is not null and v_net <> 0 then
      v_cw := public.nvi_wallet_id('client', j.client_id, null);
      perform public.nvi_post('cod_release:' || j.id, 'cod_release',
        jsonb_build_array(jsonb_build_object('w', v_cw, 'b', 'pending', 'a', -v_net),
                          jsonb_build_object('w', v_cw, 'b', 'available', 'a', v_net)), j.id);
    end if;
    update public.nvi_jobs set cod_released_at = now() where id = j.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- What a rider earns for a part of a fare: a freelance rider keeps it less
-- their commission; a route rider is on salary and earns nothing per job.
create or replace function public.nvi_rider_earning(p_rider uuid, p_part int)
returns int language sql stable security definer set search_path = '' as $$
  select case when r.kind = 'route' then 0
              else greatest(0, p_part - round(p_part * coalesce(r.commission_pct, (select c.commission_pct from public.nvi_config c where c.id)) / 100.0)::int) end
    from public.nvi_riders r where r.id = p_rider
$$;

-- A job delivered or returned books its money. Runs inside the rider's (or
-- ops') own step, and is posted once per job and outcome.
create or replace function public.nvi_ledger_job()
returns trigger language plpgsql security definer set search_path = '' as $$
-- One movement per finished job. Every rider is paid for their leg and owes
-- the cash they took; NovaX keeps the rest.
--   legs: one rider, or two (a relay or a moved parcel): the pickup rider's
--         part is nvi_config.relay_pickup_pct of the fare, the delivery
--         rider's part is the rest plus any return fee.
--   pay:  a freelance rider earns their part less their commission; a route
--         rider (salaried) earns nothing on the job.
--   cash: whoever took the fare (at pickup, at the door or on the return)
--         owes it; with cash on delivery the delivering rider owes it all,
--         and the client is owed it less the fare and the COD fee.
declare
  c public.nvi_config; v_base int; v_a int := 0; v_net int := 0; v_cw uuid; v_hw uuid;
  v_first uuid; v_last uuid; v_s1 int := 0; v_s2 int; v_e1 int := 0; v_e2 int := 0;
  v_fare_col uuid; v_ret_col uuid; v_lines jsonb := '[]'::jsonb; v_owed int := 0; v_cod boolean;
begin
  if new.status not in ('Delivered', 'Returned') or old.status is not distinct from new.status
     or new.rider_id is null or new.ledger_at is not null then
    return null;
  end if;
  select * into c from public.nvi_config where id;
  v_cod := new.status = 'Delivered' and new.cod_amount > 0;
  v_base := new.fare + coalesce(new.return_fee, 0);
  v_last := new.rider_id;
  v_first := coalesce(new.pickup_rider,
                      (select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'fare' and not v_cod order by k.id limit 1),
                      v_last);
  if v_first <> v_last then
    v_s1 := round(new.fare * c.relay_pickup_pct / 100.0)::int;
    v_s2 := v_base - v_s1;
    v_e1 := public.nvi_rider_earning(v_first, v_s1);
  else
    v_s2 := v_base;
  end if;
  v_e2 := public.nvi_rider_earning(v_last, v_s2);
  v_hw := public.nvi_wallet_id('house', null, 'commission');

  if v_cod then
    v_a := least(new.cod_amount, coalesce(new.cash_collected, new.cod_amount));
    v_net := v_a - new.fare - new.cod_fee;
    v_cw := case when new.client_id is not null then public.nvi_wallet_id('client', new.client_id, null)
                 else public.nvi_wallet_id('house', null, 'adjustments') end;   -- no account behind it: ops sorts it out
    v_lines := jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_last, null), 'a', -v_a),
                                 jsonb_build_object('w', v_cw, 'b', 'pending', 'a', v_net));
    v_owed := v_a;
  else
    v_fare_col := coalesce((select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'fare' order by k.id limit 1),
                           (select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'return' order by k.id limit 1), v_last);
    v_ret_col := coalesce((select k.rider_id from public.nvi_cash k where k.job_id = new.id and k.kind = 'return' order by k.id limit 1), v_last);
    v_lines := jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_fare_col, null), 'a', -new.fare));
    if coalesce(new.return_fee, 0) > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_ret_col, null), 'a', -new.return_fee));
    end if;
    v_owed := v_base;
  end if;
  if v_e1 > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_first, null), 'a', v_e1)); end if;
  if v_e2 > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', public.nvi_wallet_id('rider', v_last, null), 'a', v_e2)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('w', v_hw, 'a', v_owed - v_net - v_e1 - v_e2));

  perform public.nvi_post('job:' || new.id || ':' || new.status, case when v_cod then 'cod_delivered' else 'commission' end, v_lines, new.id);
  update public.nvi_jobs set commission = v_owed - v_net - v_e1 - v_e2, commission_rider = coalesce(v_fare_col, v_last),
         pickup_rider = v_first, earn_pickup = case when v_first <> v_last then v_e1 else 0 end, earn_delivery = v_e2,
         ledger_at = now(), ledger_cod = case when v_cod then v_a end where id = new.id;
  update public.nvi_cash set by_ledger = true where job_id = new.id;
  if v_cod then perform public.nvi_release_cod(v_last); end if;
  return null;
end $$;
drop trigger if exists nvi_jobs_ledger on public.nvi_jobs;
create trigger nvi_jobs_ledger after update of status on public.nvi_jobs
  for each row execute function public.nvi_ledger_job();

-- A short COD payment settled later (nvi_admin_pay) changes cash_collected
-- after the ledger booked the job. The difference is posted as its own
-- movement: the rider owes it, the client is owed it.
create or replace function public.nvi_ledger_cod_fix()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_new int; v_d int; v_cw uuid;
begin
  if new.ledger_at is null or new.cod_amount = 0 or new.status <> 'Delivered' or new.ledger_cod is null
     or new.cash_collected is not distinct from old.cash_collected then
    return null;
  end if;
  v_new := least(new.cod_amount, coalesce(new.cash_collected, new.cod_amount));
  v_d := v_new - new.ledger_cod;
  if v_d = 0 then return null; end if;
  v_cw := case when new.client_id is not null then public.nvi_wallet_id('client', new.client_id, null)
               else public.nvi_wallet_id('house', null, 'adjustments') end;
  perform public.nvi_post('cod_fix:' || new.id || ':' || new.ledger_cod || ':' || v_new, 'cod_correction', jsonb_build_array(
    jsonb_build_object('w', public.nvi_wallet_id('rider', new.rider_id, null), 'a', -v_d),
    jsonb_build_object('w', v_cw, 'b', case when new.cod_released_at is null then 'pending' else 'available' end, 'a', v_d)),
    new.id, null, 'Cash on delivery settled at Rs ' || v_new);
  update public.nvi_jobs set ledger_cod = v_new where id = new.id;
  return null;
end $$;
drop trigger if exists nvi_jobs_cod_fix on public.nvi_jobs;
create trigger nvi_jobs_cod_fix after update of cash_collected on public.nvi_jobs
  for each row execute function public.nvi_ledger_cod_fix();

-- ═══════════════════ Clients ═══════════════════


-- Called right after sign-up or sign-in on the Instant pages. Creates or
-- updates the client. A NovaX Logistics login (merchant, rider, staff) is
-- refused: Instant accounts are kept apart.
create or replace function public.nvi_client_save(p_name text, p_phone text, p_address text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := (select lower(u.email) from auth.users u where u.id = (select auth.uid()));
  v_ph text := public.nvi_pk_phone(p_phone);
  k public.nvi_clients;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signin'); end if;
  if exists (select 1 from public.profiles p where p.id = v_uid
             and (p.client_id is not null or p.rider_id is not null or p.role::text in ('admin', 'rider', 'sales', 'support', 'instant'))) then
    return jsonb_build_object('ok', false, 'reason', 'novax_login');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if v_ph = '' then return jsonb_build_object('ok', false, 'reason', 'phone'); end if;
  insert into public.nvi_clients (auth_user_id, full_name, phone, email, address)
  values (v_uid, left(btrim(p_name), 80), v_ph, v_email, nullif(left(btrim(coalesce(p_address, '')), 300), ''))
  on conflict (auth_user_id) do update
     set full_name = excluded.full_name, phone = excluded.phone,
         address = coalesce(excluded.address, public.nvi_clients.address)
  returning * into k;
  update public.profiles set role = 'instant_client', full_name = k.full_name where id = v_uid and role::text = 'client' and client_id is null;
  perform public.nvi_wallet_id('client', k.id, null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_client_me()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k public.nvi_clients := public.nvi_my_client(); c public.nvi_config; v_w uuid;
begin
  if k.id is null then return null; end if;
  select * into c from public.nvi_config where id;
  select id into v_w from public.nvi_wallets where kind = 'client' and owner = k.id;
  return jsonb_build_object(
    'client', jsonb_build_object('name', k.full_name, 'phone', k.phone, 'email', k.email, 'address', k.address,
                                 'cnic', case when k.cnic is not null then '•••••' || right(k.cnic, 4) end, 'since', k.created_at,
                                 'status', k.status, 'block_reason', k.block_reason),
    'wallet', case when v_w is null then jsonb_build_object('available', 0, 'pending', 0) else public.nvi_balance(v_w) end,
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'method', p.method,
                 'number', '•••' || right(p.account_number, 4), 'status', p.status, 'at', p.at, 'done_at', p.done_at, 'ref', p.ref, 'note', p.note) order by p.at desc)
                 from (select * from public.nvi_payouts where wallet_id = v_w order by at desc limit 20) p), '[]'::jsonb),
    'min_withdraw', c.min_withdraw, 'cod_max', c.cod_max, 'cod_fee', c.cod_fee, 'support', c.support_phone,
    'cod_enabled', c.cod_enabled, 'withdrawals_enabled', c.withdrawals_enabled);
end $$;

create or replace function public.nvi_client_jobs(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k public.nvi_clients := public.nvi_my_client();
begin
  if k.id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code', j.code, 'status', j.status, 'token', j.track_token,
      'from', j.pickup_address, 'to', j.drop_address, 'receiver', j.receiver_name, 'item', j.item,
      'fare', j.fare, 'cod', j.cod_amount, 'cod_fee', j.cod_fee, 'payer', j.payer,
      'cod_released', j.cod_released_at is not null, 'at', j.created_at,
      'done_at', coalesce(j.delivered_at, j.returned_at, j.cancelled_at)) order by j.created_at desc)
    from (select * from public.nvi_jobs where client_id = k.id order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 100), 300))) j), '[]'::jsonb);
end $$;

create or replace function public.nvi_client_ledger(p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k public.nvi_clients := public.nvi_my_client(); v_w uuid;
begin
  if k.id is null then return '[]'::jsonb; end if;
  select id into v_w from public.nvi_wallets where kind = 'client' and owner = k.id;
  if v_w is null then return '[]'::jsonb; end if;
  return public.nvi_entries(v_w, p_limit);
end $$;

-- Shared by riders and clients: ask NovaX to pay out of an available balance.
create or replace function public.nvi_request_payout(p_wallet uuid, p_amount int, p_method text, p_title text, p_number text, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_num text := regexp_replace(coalesce(p_number, ''), '[^0-9A-Za-z]', '', 'g'); v_id bigint;
begin
  select * into c from public.nvi_config where id;
  if not c.withdrawals_enabled then return jsonb_build_object('ok', false, 'reason', 'withdrawals_off'); end if;
  if p_amount is null or p_amount < c.min_withdraw then return jsonb_build_object('ok', false, 'reason', 'min', 'min', c.min_withdraw); end if;
  if p_method not in ('JazzCash', 'Easypaisa', 'Bank') then return jsonb_build_object('ok', false, 'reason', 'method'); end if;
  if length(btrim(coalesce(p_title, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  if (p_method in ('JazzCash', 'Easypaisa') and public.nvi_pk_phone(v_num) = '') or (p_method = 'Bank' and length(v_num) < 10) then
    return jsonb_build_object('ok', false, 'reason', 'number');
  end if;
  -- Locked first, so two taps at the same moment cannot both pass the checks below.
  perform 1 from public.nvi_wallets where id = p_wallet for update;
  if exists (select 1 from public.nvi_payouts where wallet_id = p_wallet and status = 'Requested') then
    return jsonb_build_object('ok', false, 'reason', 'open');
  end if;
  if public.nvi_avail(p_wallet) < p_amount then return jsonb_build_object('ok', false, 'reason', 'balance'); end if;
  insert into public.nvi_payouts (wallet_id, amount, method, account_title, account_number)
  values (p_wallet, p_amount, p_method, left(btrim(p_title), 80), left(v_num, 34)) returning id into v_id;
  perform public.nvi_post('payout:' || v_id || ':hold', 'payout_requested', jsonb_build_array(
    jsonb_build_object('w', p_wallet, 'a', -p_amount),
    jsonb_build_object('w', public.nvi_wallet_id('house', null, 'payouts_due'), 'a', p_amount)), null, p_method);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.nvi_client_withdraw(p_amount int, p_method text, p_title text, p_number text, p_cnic text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.nvi_clients := public.nvi_my_client(); v_cnic text := regexp_replace(coalesce(p_cnic, ''), '[^0-9]', '', 'g');
begin
  if k.id is null then return jsonb_build_object('ok', false, 'reason', 'signin'); end if;
  if k.cnic is null then
    if length(v_cnic) <> 13 then return jsonb_build_object('ok', false, 'reason', 'cnic'); end if;
    update public.nvi_clients set cnic = v_cnic where id = k.id;
  end if;
  return public.nvi_request_payout(public.nvi_wallet_id('client', k.id, null), p_amount, p_method, p_title, p_number, null);
end $$;

-- ═══════════════════ Riders ═══════════════════
create or replace function public.nvi_rider_wallet()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); c public.nvi_config; v_w uuid;
        v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  select * into c from public.nvi_config where id;
  v_w := public.nvi_wallet_id('rider', r.id, null);
  return jsonb_build_object(
    'balance', public.nvi_avail(v_w),
    'commission_pct', coalesce(r.commission_pct, c.commission_pct), 'cash_limit', c.rider_cash_limit, 'min_withdraw', c.min_withdraw, 'kind', r.kind,
    'today', jsonb_build_object(
      'jobs', (select count(*) from public.nvi_jobs where rider_id = r.id and ledger_at is not null and (ledger_at at time zone 'Asia/Karachi')::date = v_day),
      'fares', (select coalesce(sum(k.amount), 0) from public.nvi_cash k join public.nvi_jobs j on j.id = k.job_id
                 where k.rider_id = r.id and j.cod_amount = 0 and k.by_ledger and (j.ledger_at at time zone 'Asia/Karachi')::date = v_day)
             + (select coalesce(sum(fare), 0) from public.nvi_jobs where rider_id = r.id and cod_amount > 0 and status = 'Delivered'
                 and ledger_at is not null and (ledger_at at time zone 'Asia/Karachi')::date = v_day),
      'commission', (select coalesce(sum(commission), 0) from public.nvi_jobs where commission_rider = r.id and ledger_at is not null and (ledger_at at time zone 'Asia/Karachi')::date = v_day),
      'earned', (select coalesce(sum(case when pickup_rider = r.id and pickup_rider <> rider_id then earn_pickup else 0 end)
                                 + sum(case when rider_id = r.id then earn_delivery else 0 end), 0)
                   from public.nvi_jobs where (rider_id = r.id or pickup_rider = r.id) and ledger_at is not null and (ledger_at at time zone 'Asia/Karachi')::date = v_day),
      'cod', (select coalesce(sum(cod_amount), 0) from public.nvi_jobs where rider_id = r.id and status = 'Delivered' and ledger_at is not null and (ledger_at at time zone 'Asia/Karachi')::date = v_day)),
    'entries', public.nvi_entries(v_w, 60),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'amount', d.amount, 'confirmed', d.confirmed_amount, 'method', d.method,
                   'ref', d.ref, 'status', d.status, 'note', d.note, 'at', d.at) order by d.at desc)
                   from (select * from public.nvi_deposits where rider_id = r.id order by at desc limit 15) d), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'method', p.method,
                   'number', '•••' || right(p.account_number, 4), 'status', p.status, 'ref', p.ref, 'note', p.note, 'at', p.at) order by p.at desc)
                   from (select * from public.nvi_payouts where wallet_id = v_w order by at desc limit 15) p), '[]'::jsonb));
end $$;

drop function if exists public.nvi_rider_deposit(int, text, text);
create or replace function public.nvi_rider_deposit(p_amount int, p_method text, p_ref text, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider(); d public.nvi_deposits;
begin
  if p_key is not null then
    select * into d from public.nvi_deposits where req_key = p_key;
    if d.id is not null then
      if d.rider_id <> r.id then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
      return jsonb_build_object('ok', true, 'already', true);
    end if;
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 500000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if p_method not in ('JazzCash', 'Easypaisa', 'Bank', 'Office') then return jsonb_build_object('ok', false, 'reason', 'method'); end if;
  if p_method <> 'Office' and length(btrim(coalesce(p_ref, ''))) < 4 then return jsonb_build_object('ok', false, 'reason', 'ref'); end if;
  if (select count(*) from public.nvi_deposits where rider_id = r.id and status = 'Claimed') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if p_ref is not null and length(btrim(p_ref)) > 0 and exists (select 1 from public.nvi_deposits
       where method = p_method and lower(ref) = lower(left(btrim(p_ref), 60)) and status <> 'Rejected') then
    return jsonb_build_object('ok', false, 'reason', 'dup_ref');
  end if;
  insert into public.nvi_deposits (rider_id, amount, method, ref, req_key) values (r.id, p_amount, p_method, nullif(left(btrim(coalesce(p_ref, '')), 60), ''), p_key);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.nvi_rider_payout(p_amount int, p_method text, p_title text, p_number text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.nvi_riders := public.nvi_require_rider();
begin
  return public.nvi_request_payout(public.nvi_wallet_id('rider', r.id, null), p_amount, p_method, p_title, p_number, null);
end $$;

-- ═══════════════════ Ops ═══════════════════
create or replace function public.nvi_admin_wallets()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config;
begin
  perform public.nvi_require_admin();
  select * into c from public.nvi_config where id;
  return jsonb_build_object(
    'config', jsonb_build_object('commission_pct', c.commission_pct, 'rider_cash_limit', c.rider_cash_limit, 'cod_max', c.cod_max,
                                 'cod_fee', c.cod_fee, 'min_withdraw', c.min_withdraw),
    'house', jsonb_build_object(
      'commission', public.nvi_avail(public.nvi_wallet_id('house', null, 'commission')),
      'cash', -public.nvi_avail(public.nvi_wallet_id('house', null, 'cash')),
      'payouts_due', public.nvi_avail(public.nvi_wallet_id('house', null, 'payouts_due')),
      'adjustments', public.nvi_avail(public.nvi_wallet_id('house', null, 'adjustments'))),
    'riders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'wallet', w.id, 'name', r.full_name, 'phone', r.phone,
                 'balance', public.nvi_avail(w.id), 'commission_pct', coalesce(r.commission_pct, c.commission_pct),
                 'cod_held', (select coalesce(sum(least(j.cod_amount, coalesce(j.cash_collected, j.cod_amount))), 0) from public.nvi_jobs j
                               where j.rider_id = r.id and j.cod_amount > 0 and j.status = 'Delivered' and j.cod_released_at is null and j.ledger_at is not null))
                 order by public.nvi_avail(w.id))
               from public.nvi_riders r join public.nvi_wallets w on w.kind = 'rider' and w.owner = r.id), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'wallet', w.id, 'name', k.full_name, 'phone', k.phone, 'email', k.email,
                 'cnic', k.cnic is not null, 'status', k.status, 'block_reason', k.block_reason, 'since', k.created_at,
                 'available', (public.nvi_balance(w.id)->>'available')::int, 'pending', (public.nvi_balance(w.id)->>'pending')::int,
                 'jobs', (select count(*) from public.nvi_jobs j where j.client_id = k.id)) order by k.created_at desc)
               from public.nvi_clients k join public.nvi_wallets w on w.kind = 'client' and w.owner = k.id), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'rider', r.full_name, 'rider_id', r.id, 'amount', d.amount,
                 'confirmed', d.confirmed_amount, 'method', d.method, 'ref', d.ref, 'status', d.status, 'note', d.note, 'at', d.at, 'done_at', d.done_at)
                 order by (d.status = 'Claimed') desc, d.at desc)
               from (select * from public.nvi_deposits order by (status = 'Claimed') desc, at desc limit 60) d
               join public.nvi_riders r on r.id = d.rider_id), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'method', p.method, 'title', p.account_title,
                 'number', p.account_number, 'status', p.status, 'ref', p.ref, 'note', p.note, 'at', p.at, 'done_at', p.done_at,
                 'kind', w.kind, 'who', coalesce((select r.full_name from public.nvi_riders r where w.kind = 'rider' and r.id = w.owner),
                                                 (select k.full_name from public.nvi_clients k where w.kind = 'client' and k.id = w.owner)),
                 'phone', coalesce((select r.phone from public.nvi_riders r where w.kind = 'rider' and r.id = w.owner),
                                   (select k.phone from public.nvi_clients k where w.kind = 'client' and k.id = w.owner)),
                 'cnic', (select '•••••' || right(k.cnic, 4) from public.nvi_clients k where w.kind = 'client' and k.id = w.owner and k.cnic is not null))
                 order by (p.status = 'Requested') desc, p.at desc)
               from (select * from public.nvi_payouts order by (status = 'Requested') desc, at desc limit 60) p
               join public.nvi_wallets w on w.id = p.wallet_id), '[]'::jsonb));
end $$;

create or replace function public.nvi_admin_deposit(p_id bigint, p_ok boolean, p_amount int default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.nvi_deposits; v_amt int;
begin
  perform public.nvi_require_admin();
  select * into d from public.nvi_deposits where id = p_id for update;
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status <> 'Claimed' then return jsonb_build_object('ok', false, 'reason', 'done'); end if;
  if not coalesce(p_ok, false) then
    if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
    update public.nvi_deposits set status = 'Rejected', note = left(btrim(p_note), 200), done_at = now(), done_by = (select auth.uid()) where id = d.id;
    return jsonb_build_object('ok', true);
  end if;
  v_amt := coalesce(p_amount, d.amount);
  if v_amt < 1 or v_amt > d.amount then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if v_amt < d.amount and length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  perform public.nvi_post('deposit:' || d.id, 'deposit', jsonb_build_array(
    jsonb_build_object('w', public.nvi_wallet_id('rider', d.rider_id, null), 'a', v_amt),
    jsonb_build_object('w', public.nvi_wallet_id('house', null, 'cash'), 'a', -v_amt)), null, d.method || coalesce(' ' || d.ref, ''), p_note);
  update public.nvi_deposits set status = 'Confirmed', confirmed_amount = v_amt, note = nullif(left(btrim(coalesce(p_note, '')), 200), ''),
         done_at = now(), done_by = (select auth.uid()) where id = d.id;
  return jsonb_build_object('ok', true, 'released', public.nvi_release_cod(d.rider_id));
end $$;

create or replace function public.nvi_admin_payout(p_id bigint, p_ok boolean, p_ref text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.nvi_payouts; v_due uuid := public.nvi_wallet_id('house', null, 'payouts_due');
begin
  perform public.nvi_require_admin();
  select * into p from public.nvi_payouts where id = p_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p.status <> 'Requested' then return jsonb_build_object('ok', false, 'reason', 'done'); end if;
  if coalesce(p_ok, false) then
    if length(btrim(coalesce(p_ref, ''))) < 4 then return jsonb_build_object('ok', false, 'reason', 'need_ref'); end if;
    perform public.nvi_post('payout:' || p.id || ':paid', 'payout_paid', jsonb_build_array(
      jsonb_build_object('w', v_due, 'a', -p.amount),
      jsonb_build_object('w', public.nvi_wallet_id('house', null, 'cash'), 'a', p.amount)), null, p_ref, p_note);
    update public.nvi_payouts set status = 'Paid', ref = left(btrim(p_ref), 80), note = nullif(left(btrim(coalesce(p_note, '')), 200), ''),
           done_at = now(), done_by = (select auth.uid()) where id = p.id;
  else
    if length(btrim(coalesce(p_note, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
    perform public.nvi_post('payout:' || p.id || ':back', 'payout_rejected', jsonb_build_array(
      jsonb_build_object('w', v_due, 'a', -p.amount),
      jsonb_build_object('w', p.wallet_id, 'a', p.amount)), null, null, p_note);
    update public.nvi_payouts set status = 'Rejected', note = left(btrim(p_note), 200), done_at = now(), done_by = (select auth.uid()) where id = p.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Ops corrections (a short COD, a goodwill credit). Always with a reason.
create or replace function public.nvi_admin_adjust(p_wallet uuid, p_amount int, p_note text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.nvi_wallets; v_rider uuid;
begin
  perform public.nvi_require_admin();
  select * into w from public.nvi_wallets where id = p_wallet;
  if w.id is null or w.kind = 'house' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 500000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  if p_key is null then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  perform public.nvi_post('adjust:' || p_key, 'adjustment', jsonb_build_array(
    jsonb_build_object('w', w.id, 'a', p_amount),
    jsonb_build_object('w', public.nvi_wallet_id('house', null, 'adjustments'), 'a', -p_amount)), null, null, p_note);
  if w.kind = 'rider' then v_rider := w.owner; perform public.nvi_release_cod(v_rider); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Hold a client account: no new cash on delivery, but money that is theirs
-- can still be withdrawn. Always with a reason.
create or replace function public.nvi_admin_set_client(p_client uuid, p_block boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.nvi_clients;
begin
  perform public.nvi_require_admin();
  select * into k from public.nvi_clients where id = p_client for update;
  if k.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(p_block, false) and length(btrim(coalesce(p_reason, ''))) < 5 then return jsonb_build_object('ok', false, 'reason', 'need_note'); end if;
  update public.nvi_clients set status = case when p_block then 'Blocked' else 'Active' end,
         block_reason = case when p_block then left(btrim(p_reason), 200) end,
         blocked_at = case when p_block then now() end, blocked_by = case when p_block then (select auth.uid()) end
   where id = k.id;
  return jsonb_build_object('ok', true);
end $$;

-- The money check on the Wallets tab: anything that needs a person. The
-- ledger must add up to zero overall and per movement, every job finished
-- since wallets started must be booked, and nothing should sit too long.
create or replace function public.nvi_admin_money_check()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.nvi_config; v_total bigint; v_unbal int; v_unposted jsonb; v_overdue jsonb; v_dep int; v_pay int; v_cod jsonb;
begin
  perform public.nvi_require_admin();
  select * into c from public.nvi_config where id;
  select coalesce(sum(amount), 0) into v_total from public.nvi_ledger;
  select count(*) into v_unbal from (select txn_id from public.nvi_ledger group by txn_id having sum(amount) <> 0) x;
  select coalesce(jsonb_agg(code order by code), '[]'::jsonb) into v_unposted from public.nvi_jobs
   where status in ('Delivered', 'Returned') and rider_id is not null and ledger_at is null
     and coalesce(delivered_at, returned_at) > c.wallets_since;
  -- A rider who has owed money for more than a day without paying any in.
  select coalesce(jsonb_agg(jsonb_build_object('name', x.full_name, 'phone', x.phone, 'owes', -x.bal, 'since', x.since) order by x.bal), '[]'::jsonb) into v_overdue from (
    select r.full_name, r.phone, public.nvi_avail(w.id) as bal,
           (select min(l.at) from public.nvi_ledger l where l.wallet_id = w.id and l.amount < 0
              and l.at > coalesce((select max(d.done_at) from public.nvi_deposits d where d.rider_id = r.id and d.status = 'Confirmed'), '-infinity'::timestamptz)) as since
      from public.nvi_riders r join public.nvi_wallets w on w.kind = 'rider' and w.owner = r.id) x
   where x.bal < 0 and x.since < now() - interval '24 hours';
  select count(*) into v_dep from public.nvi_deposits where status = 'Claimed' and at < now() - interval '24 hours';
  select count(*) into v_pay from public.nvi_payouts where status = 'Requested' and at < now() - interval '48 hours';
  select jsonb_build_object('n', count(*), 'amount', coalesce(sum(cod_amount), 0)) into v_cod from public.nvi_jobs
   where cod_amount > 0 and status = 'Delivered' and ledger_at is not null and cod_released_at is null and delivered_at < now() - interval '48 hours';
  return jsonb_build_object(
    'clear', v_total = 0 and v_unbal = 0 and jsonb_array_length(v_unposted) = 0 and jsonb_array_length(v_overdue) = 0 and v_dep = 0 and v_pay = 0 and (v_cod->>'n')::int = 0,
    'ledger_total', v_total, 'unbalanced', v_unbal, 'unposted', v_unposted, 'overdue', v_overdue,
    'stale_deposits', v_dep, 'stale_payouts', v_pay, 'cod_waiting', v_cod, 'at', now());
end $$;

create or replace function public.nvi_admin_ledger(p_wallet uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.nvi_require_admin();
  return public.nvi_entries(p_wallet, 200);
end $$;

-- ═══════════════════ Who may call what ═══════════════════
do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_wallet_id', 'nvi_post', 'nvi_balance', 'nvi_avail', 'nvi_entries', 'nvi_release_cod', 'nvi_ledger_job',
                         'nvi_ledger_frozen', 'nvi_ledger_cod_fix', 'nvi_rider_earning', 'nvi_request_payout', 'nvi_client_save', 'nvi_client_me', 'nvi_client_jobs',
                         'nvi_client_ledger', 'nvi_client_withdraw', 'nvi_rider_wallet', 'nvi_rider_deposit', 'nvi_rider_payout',
                         'nvi_admin_wallets', 'nvi_admin_deposit', 'nvi_admin_payout', 'nvi_admin_adjust', 'nvi_admin_ledger', 'nvi_admin_money_check', 'nvi_admin_set_client')
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- Signed-in users only; each function checks who is calling.
  for f in
    select p.oid::regprocedure::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('nvi_client_save', 'nvi_client_me', 'nvi_client_jobs', 'nvi_client_ledger', 'nvi_client_withdraw',
                         'nvi_rider_wallet', 'nvi_rider_deposit', 'nvi_rider_payout',
                         'nvi_admin_wallets', 'nvi_admin_deposit', 'nvi_admin_payout', 'nvi_admin_adjust', 'nvi_admin_ledger', 'nvi_admin_money_check', 'nvi_admin_set_client')
  loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

notify pgrst, 'reload schema';
