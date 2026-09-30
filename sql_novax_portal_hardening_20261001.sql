-- Portal hardening (1 Oct 2026), from the 38-point review.
-- 1. Team seats: Warehouse, Support and revoked seats can no longer read the
--    wallet ledger, withdrawals (with IBANs) or invoices; only Owners can
--    change store connections; seats see only their own team row; revoking a
--    seat unlinks its login.
-- 2. Payouts: a Pakistani IBAN must be 24 characters with a valid checksum;
--    the smallest withdrawal is Rs 1, with at most two decimals.
-- 3. Bookings: a real name, an address that is more than junk, a Pakistani phone;
--    COD above Rs 200,000 is refused.
-- 4. Tickets: length limits, and an AWB must be the merchant's own parcel.
-- 5. Store URLs NovaX calls must be public https addresses.
-- Checked against live data first: every saved IBAN and every portal booking
-- that still has contact details passes the new rules.
begin;

create or replace function public.nv_client_can_see_money()
returns boolean language sql stable security definer set search_path = 'public' as $$
  select public.my_client_id() is not null and not exists (
    select 1 from public.staff_users su
     where su.client_id = public.my_client_id()
       and (su.auth_user_id = auth.uid()
            or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
       and (lower(coalesce(su.status, 'Active')) = 'revoked'
            or lower(coalesce(su.role, '')) in ('warehouse', 'support'))
  );
$$;
revoke all on function public.nv_client_can_see_money() from public, anon;
grant execute on function public.nv_client_can_see_money() to authenticated, service_role;

create or replace function public.nv_iban_pk_valid(p text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s text := upper(regexp_replace(coalesce(p, ''), '[\s-]+', '', 'g')); r text; d text := ''; c text; i int; m int := 0;
begin
  if s !~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$' then return false; end if;
  r := substr(s, 5) || substr(s, 1, 4);
  for i in 1..length(r) loop
    c := substr(r, i, 1);
    if c ~ '[A-Z]' then d := d || (ascii(c) - 55)::text; else d := d || c; end if;
  end loop;
  for i in 1..length(d) loop m := (m * 10 + substr(d, i, 1)::int) % 97; end loop;
  return m = 1;
end;
$$;
grant execute on function public.nv_iban_pk_valid(text) to authenticated, service_role;

create or replace function public.nv_public_https_url(p text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare u text := btrim(coalesce(p, '')); h text;
begin
  if u !~* '^https://[a-z0-9.-]+(:443)?(/[^\s<>"]*)?$' or char_length(u) > 300 then return false; end if;
  h := lower(substring(u from '^https://([^/:]+)'));
  if h !~ '\.' or h ~ '^[0-9.]+$' or h = 'localhost'
     or h ~ '\.(localhost|local|internal|lan|home|corp|intranet)$' then return false; end if;
  return true;
end;
$$;
grant execute on function public.nv_public_https_url(text) to authenticated, service_role;

-- Money tables: Owner and Finance seats (and the account holder) only.
alter policy wallet_ledger_client_select on public.wallet_ledger
  using (client_id = (select public.my_client_id()) and (select public.nv_client_can_see_money()));
alter policy wd_sel on public.withdrawals
  using ((client_id = (select public.my_client_id()) and (select public.nv_client_can_see_money())) or (select public.is_admin()));
alter policy invoices_owner_read on public.invoices
  using ((select public.is_admin()) or (client_id = (select public.my_client_id()) and (select public.nv_client_can_see_money())));

-- Store connections: every seat can see them, only an Owner can change them.
drop policy if exists sc_all on public.store_connections;
drop policy if exists sc_select on public.store_connections;
drop policy if exists sc_owner_write on public.store_connections;
create policy sc_select on public.store_connections for select
  using (client_id = (select public.my_client_id()) or (select public.is_admin()));
create policy sc_owner_write on public.store_connections for all
  using ((client_id = (select public.my_client_id()) and (select public.is_client_owner_seat())) or (select public.is_admin()))
  with check ((client_id = (select public.my_client_id()) and (select public.is_client_owner_seat())) or (select public.is_admin()));

-- Team list: Owners see the whole team; any other seat sees only its own row
-- (the portal reads it to know the seat's role).
alter policy "client reads own team" on public.staff_users
  using (client_id is not null and client_id = (select public.my_client_id()) and (
    (select public.is_client_owner_seat())
    or auth_user_id = (select auth.uid())
    or lower(coalesce(email, '')) = lower(coalesce((select auth.jwt() ->> 'email'), ''))));

-- Summary and statement: nothing for Warehouse and Support seats.
create or replace function public.client_wallet_summary()
 returns table(available_balance numeric, pending_payout numeric, paid_this_month numeric, lifetime_withdrawn numeric)
 language plpgsql security definer set search_path to 'public' as $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_can_see_money() then
    return;
  end if;

  select coalesce(c.wallet_balance,0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Pending admin payout'), 0),
    -- Pakistan months, like every date the merchant sees.
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'
      and date_trunc('month', coalesce(w.paid_at, w.created_at) at time zone 'Asia/Karachi')
        = date_trunc('month', now() at time zone 'Asia/Karachi')), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'), 0)
  into available_balance, pending_payout, paid_this_month, lifetime_withdrawn
  from public.clients c where c.id = v_client_id;

  return next;
end;
$function$;

create or replace function public.client_wallet_statement(p_period text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id();
  v_from timestamptz;
  v_to timestamptz;
  v_out jsonb;
begin
  if v_client is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_can_see_money() then
    raise exception 'Only the Owner and Finance can see wallet statements.' using errcode = '42501';
  end if;
  if p_period = 'all' then
    v_from := '-infinity'; v_to := 'infinity';
  elsif p_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    v_from := (p_period || '-01')::timestamp at time zone 'Asia/Karachi';
    v_to := ((p_period || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
  else
    raise exception 'Pick a month to see its statement.';
  end if;

  -- One statement, one snapshot: the balance and the ledger cannot drift apart.
  with c as (
    select coalesce(wallet_balance, 0) as now_balance from public.clients where id = v_client
  ), l as (
    select id, created_at, entry_type, amount, reference_type, reference_id, reference_code, note
    from public.wallet_ledger
    where client_id = v_client and affects_balance
  ), t as (
    select (select now_balance from c) as now_balance,
      coalesce((select sum(amount) from l where created_at >= v_to), 0) as after_period,
      coalesce((select sum(amount) from l where created_at >= v_from and created_at < v_to), 0) as in_period,
      coalesce((select sum(amount) from l where created_at >= v_from and created_at < v_to and amount > 0), 0) as money_in,
      coalesce((select -sum(amount) from l where created_at >= v_from and created_at < v_to and amount < 0), 0) as money_out
  ), lines as (
    select l.*, (t.now_balance - t.after_period - t.in_period)
      + sum(l.amount) over (order by l.created_at, l.id rows unbounded preceding) as balance
    from l, t
    where l.created_at >= v_from and l.created_at < v_to
  )
  select jsonb_build_object(
    'period', p_period,
    'opening', t.now_balance - t.after_period - t.in_period,
    'closing', t.now_balance - t.after_period,
    'money_in', t.money_in,
    'money_out', t.money_out,
    'balance_now', t.now_balance,
    'first_day', case when p_period = 'all'
      then (select to_char(min(created_at) at time zone 'Asia/Karachi', 'YYYY-MM-DD') from l)
      else p_period || '-01' end,
    'last_day', to_char(least(v_to - interval '1 microsecond', now()) at time zone 'Asia/Karachi', 'YYYY-MM-DD'),
    'generated_at', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id,
        'at', to_char(created_at at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
        'entry_type', entry_type, 'amount', amount,
        'reference_type', reference_type, 'reference_id', reference_id,
        'reference_code', reference_code, 'note', note,
        'balance', balance) order by created_at, id) from lines), '[]'::jsonb))
  into v_out
  from t;
  return v_out;
end;
$$;

CREATE OR REPLACE FUNCTION public.client_wallet_incoming()
 RETURNS TABLE(in_transit_amount numeric, in_transit_count integer, delivered_uncleared numeric, delivered_uncleared_count integer, on_the_way_amount numeric, available_balance numeric, inflow_4w jsonb, outflow_4w jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  -- Warehouse and Support seats do not see wallet figures.
  if not public.nv_client_can_see_money() then
    return;
  end if;

  -- Money still moving toward the merchant: COLLECTED through to
  -- out-for-delivery, plus the recoverable exception states that can still
  -- convert to a delivery. Return-flow statuses are excluded because that
  -- COD is never going to be collected.
  --
  -- 'New booked' was in this list and is deliberately no longer. A parcel
  -- nobody has picked up is not money on its way to anyone -- no rider
  -- holds it, no cash exists anywhere in the system for it, and the
  -- merchant can still cancel or edit it. Counting its face value under
  -- "On its way to you" told merchants they were owed money that had not
  -- been created yet, and it moved every time they booked rather than every
  -- time NovaX collected.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into in_transit_amount, in_transit_count
    from public.parcels p
   where p.client_id = v_client_id
     and coalesce(p.cod_amount, 0) > 0
     and p.status in (
       'Collected by rider', 'Arrived at warehouse',
       'Parcel now in transit', 'Parcel received at destination',
       'Parcel out for delivery', 'Reattempt', 'Reassigned',
       'Consignee not available'
     );

  -- Delivered and collected, but not yet turned into an invoice credit.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into delivered_uncleared, delivered_uncleared_count
    from public.parcels p
   where p.client_id = v_client_id
     and p.status = 'Delivered'
     and coalesce(p.cod_amount, 0) > 0
     and p.invoice_id is null;

  on_the_way_amount := coalesce(in_transit_amount, 0) + coalesce(delivered_uncleared, 0);

  select coalesce(c.wallet_balance, 0)
    into available_balance
    from public.clients c
   where c.id = v_client_id;

  -- Last 4 completed weeks of real wallet movement, straight from the
  -- ledger (money in) and paid withdrawals (money out).
  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into inflow_4w
    from (
      -- AUDIT FIX (low): pin bucketing to UTC. The browser builds its four
      -- Monday buckets in UTC; date_trunc() alone uses the DB session
      -- timezone, so if that is ever changed from the Supabase default,
      -- Sunday-evening PKT money would be drawn in the wrong week.
      select date_trunc('week', l.created_at at time zone 'UTC')::date as wk,
             coalesce(sum(l.amount), 0) as amt
        from public.wallet_ledger l
       where l.client_id = v_client_id
         and l.entry_type = 'invoice_credit'
         and l.created_at >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into outflow_4w
    from (
      select date_trunc('week', coalesce(w.paid_at, w.created_at) at time zone 'UTC')::date as wk,
             coalesce(sum(w.net), 0) as amt
        from public.withdrawals w
       where w.client_id = v_client_id
         and w.status = 'Paid'
         and coalesce(w.paid_at, w.created_at) >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  return next;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nv_request_wallet_withdrawal_core(p_amount numeric, p_iban text, p_speed text, p_request_key text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_balance numeric;
  v_fee numeric;
  v_net numeric;
  v_rate numeric;
  v_iban text;
  v_key text := nullif(btrim(coalesce(p_request_key, '')), '');
  v_holder_name text;
  v_bank_name text;
  v_row public.withdrawals;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_money_allowed() then
    raise exception 'Only the workspace Owner can request a withdrawal.' using errcode = '42501';
  end if;
  -- Rs 0.01 used to pass and was shown to the merchant as "Rs 0".
  if p_amount is null or p_amount < 1 then
    raise exception 'The smallest withdrawal is Rs 1.';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'A withdrawal can have at most two decimal places.';
  end if;
  if v_key is not null and (
    length(v_key) < 16 or length(v_key) > 200 or v_key ~ '[[:cntrl:]]'
  ) then
    raise exception 'Withdrawal request key is invalid.';
  end if;

  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '[\s-]+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN / bank account details are required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  -- A Pakistani IBAN is exactly 24 characters with a checksum. Any length
  -- from 15 to 34 used to pass, so a mistyped account reached the payout queue.
  if not public.nv_iban_pk_valid(v_iban) then
    raise exception 'That IBAN is not valid. A Pakistani IBAN has 24 characters, like PK36SCBL0000001123456702. Copy it from your bank app.';
  end if;
  if p_speed not in ('24h', '12h', 'instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  -- This is the serialization point. Every idempotency, duplicate and balance
  -- decision below observes the result of the preceding request for this
  -- merchant.
  select coalesce(c.wallet_balance, 0),
         btrim(coalesce(c.meta->'bank'->>'holderName', '')),
         btrim(coalesce(c.meta->'bank'->>'bankName', ''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients c
   where c.id = v_client_id
   for update;
  if not found then
    raise exception 'Client wallet not found.';
  end if;

  -- A lost response can be replayed forever with the same key. Return the
  -- original row regardless of its current payout status; never debit again.
  if v_key is not null then
    select * into v_row
      from public.withdrawals w
     where w.client_id = v_client_id and w.request_key = v_key;
    if found then
      return v_row;
    end if;
  end if;

  -- Keep the short duplicate guard for old clients that do not yet send a
  -- durable key. It is safe now because it runs after the wallet lock.
  if exists (
    select 1
      from public.withdrawals w
     where w.client_id = v_client_id
       and w.status = 'Pending admin payout'
       and w.created_at > now() - interval '15 seconds'
  ) then
    raise exception 'A withdrawal request was already submitted. Please wait a moment before trying again.';
  end if;

  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients
     set wallet_balance = v_balance - p_amount
   where id = v_client_id;

  insert into public.withdrawals (
    client_id, amount, fee, net, iban, speed, status, balance_before,
    holder_name, bank_name, request_key
  ) values (
    v_client_id, p_amount, v_fee, v_net, v_iban, p_speed,
    'Pending admin payout', v_balance, nullif(v_holder_name, ''),
    nullif(v_bank_name, ''), v_key
  ) returning * into v_row;

  insert into public.wallet_ledger (
    client_id, entry_type, amount, affects_balance, status,
    reference_type, reference_id, reference_code, note
  ) values (
    v_client_id, 'withdrawal_requested', -p_amount, true,
    'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested: Rs ' || p_amount || ' reserved, ' || v_net ||
    ' net after Rs ' || v_fee || ' fee (' || p_speed || ').'
  );

  insert into public.wallet_ledger (
    client_id, entry_type, amount, affects_balance, status,
    reference_type, reference_id, reference_code, note
  ) values (
    v_client_id, 'payout_fee', -v_fee, false, 'Informational',
    'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).'
  );


  -- The withdrawal payment-history row is written HERE, in the same
  -- transaction as the withdrawal and its ledger entries, because it used to
  -- be created in the browser and inserted fire-and-forget afterwards. That
  -- had two failure modes on a merchant's money history:
  --   * tab closed before the insert ran  -> the entry was lost outright
  --   * response dropped after the commit -> no _uuid came back, so the
  --     browser retried and could write it twice
  -- and a third, subtler one: nv_guard_payment_logs() only accepts this type
  -- when a matching withdrawal exists within the last hour, so any retry
  -- after that window was rejected and the entry was lost permanently.
  --
  -- reference now carries the withdrawal id, which is what makes the row
  -- idempotent (see payment_logs_withdrawal_uniq). The guard trigger still
  -- runs and still overwrites status from the withdrawal, which is correct.
  insert into public.payment_logs (client_id, type, amount, status, reference)
  values (
    v_client_id,
    'Wallet withdrawal requested',
    p_amount,
    'Rs ' || v_net || ' net after Rs ' || v_fee || ' fee',
    v_row.id::text
  )
  on conflict do nothing;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text DEFAULT ''::text)
 RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_holder text;
  v_iban text;
  v_bank text;
  v_now timestamptz;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_money_allowed() then
    raise exception 'Only the workspace Owner can change bank details.' using errcode = '42501';
  end if;

  v_holder := btrim(coalesce(p_holder_name, ''));
  if v_holder = '' then
    raise exception 'Account holder name is required.';
  end if;

  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '[\s-]+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN is required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  -- A Pakistani IBAN is exactly 24 characters with a checksum. Any length
  -- from 15 to 34 used to pass, so a mistyped account reached the payout queue.
  if not public.nv_iban_pk_valid(v_iban) then
    raise exception 'That IBAN is not valid. A Pakistani IBAN has 24 characters, like PK36SCBL0000001123456702. Copy it from your bank app.';
  end if;

  v_bank := btrim(coalesce(p_bank_name, ''));
  v_now := now();

  update public.clients
    set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{bank}', jsonb_build_object(
      'holderName', v_holder, 'iban', v_iban, 'bankName', v_bank, 'updatedAt', v_now
    ), true)
    where id = v_client_id;

  holder_name := v_holder; iban := v_iban; bank_name := v_bank; updated_at := v_now;
  return next;
end;
$function$;

CREATE OR REPLACE FUNCTION public.client_book_parcel(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
  v_allow text;
  v_phone text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;
  if coalesce(btrim(p_consignee), '') = '' then
    raise exception 'Consignee name is required.';
  end if;

  -- A parcel with no phone and no address is not a booking, it is a parcel
  -- nobody can deliver. This used to be written as coalesce(p_phone,'') and
  -- caught only AFTER the commit, by the browser, which then asked the
  -- merchant to open Edit and fix a parcel that was already dispatchable.
  if coalesce(btrim(p_phone), '') = '' then
    raise exception 'A contact phone is required so the rider can reach the consignee.'
      using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_address), '') = '' then
    raise exception 'A delivery address is required.'
      using errcode = 'P0001';
  end if;

  -- Non-empty was the only rule, so "a" was a name and an address. Only obvious
  -- junk is refused: addresses are otherwise not judged (they come in too many
  -- real forms). Any script counts as a letter; digits, spaces and ASCII
  -- punctuation alone do not.
  if char_length(btrim(p_consignee)) < 2 or btrim(p_consignee) !~ '[^0-9[:space:][:punct:]]' then
    raise exception 'Enter the consignee''s full name.' using errcode = 'P0001';
  end if;
  if char_length(btrim(p_address)) < 5 or btrim(p_address) !~ '[^0-9[:space:][:punct:]]' then
    raise exception 'Enter the full delivery address: house, street and area.' using errcode = 'P0001';
  end if;
  v_phone := regexp_replace(p_phone, '\D', '', 'g');
  if v_phone ~ '^92' and char_length(v_phone) = 12 then v_phone := '0' || substr(v_phone, 3); end if;
  if v_phone ~ '^3[0-9]{9}$' then v_phone := '0' || v_phone; end if;
  if v_phone !~ '^0[0-9]{9,10}$' then
    raise exception 'Enter the consignee''s phone number, like 0300 1234567.' using errcode = 'P0001';
  end if;
  -- No parcel has carried more than Rs 14,090; this stops a slipped extra zero.
  if coalesce(p_cod, 0) > 200000 then
    raise exception 'COD above Rs 200,000 cannot be booked online. Message NovaX support to arrange it.' using errcode = 'P0001';
  end if;

  -- 'Infinity' and 'NaN' are valid numerics in Postgres; neither is a COD.
  if p_cod is not null and (p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric) then
    raise exception 'COD amount must be a number, zero or more.' using errcode = 'P0001';
  end if;

  -- Same guard as nv_book_parcel_core. This function does NOT delegate to the
  -- core -- it is its own implementation -- so guarding only the core left the
  -- portal path open. And the booking form deriving the payment mode from the
  -- COD amount is not a guard: client_book_parcel is SECURITY DEFINER and any
  -- authenticated merchant can call the RPC directly with whatever it likes.
  -- client_book_parcel_geo delegates here, so it is covered by this.
  if public.nv_is_payment_conflict(p_payment_mode, p_cod) then
    raise exception
      'This parcel is marked "%" but carries a COD amount of Rs %. A prepaid parcel collects nothing at the door. Set COD to 0, or change the payment mode to COD.',
      btrim(p_payment_mode), trim(to_char(p_cod, 'FM999,999,999'))
      using errcode = 'P0001';
  end if;

  -- Only ever 'Yes' or 'No' — never free text on a rider-facing instruction.
  v_allow := case when lower(coalesce(btrim(p_allow_open), 'no')) in ('yes','true','y','1')
                  then 'Yes' else 'No' end;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || v_client_id::text));

  v_awb := public.nv_next_awb(v_client_id);

  select c.rate, c.rate_card into v_rate, v_rate_card
    from public.clients c where c.id = v_client_id;
  v_rate := coalesce(v_rate, 250);

  v_zone := case when lower(coalesce(p_city, '')) = 'karachi' then 'A' else 'B' end;
  if v_rate_card is not null and jsonb_typeof(v_rate_card -> v_zone) = 'object' then
    v_base      := coalesce((v_rate_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_rate_card is not null and (v_rate_card ->> 'overnight') is not null then
    v_base      := coalesce((v_rate_card ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card ->> 'additionalKg')::numeric, 85);
  else
    v_base      := v_rate;
    v_addl_rate := 85;
  end if;

  v_weight_kg := public.nv_parse_weight_kg(p_weight);
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;
  v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_fee      := v_base + (v_extra_kg * v_addl_rate);

  v_meta := jsonb_build_object(
    'source',      'client_portal',
    'pickupCity',  coalesce(p_pickup_city, ''),
    'service',     coalesce(p_service, ''),
    'category',    coalesce(p_category, ''),
    'fragile',     coalesce(p_fragile, 'No'),
    'weight',      coalesce(p_weight, '0.8 kg'),
    'paymentMode', coalesce(p_payment_mode, 'COD'),
    'orderId',     coalesce(p_order_id, ''),
    'referenceNo', coalesce(p_reference_no, ''),
    'allowOpen',   v_allow,                       -- NEW
    'branch',      coalesce(nullif(btrim(p_pickup_city), ''), 'Karachi') || ' Hub',
    'stage',       0,
    'totalStages', 16,
    'steps',       jsonb_build_array('New booked'),
    'statusSince', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.parcels (
    awb, client_id, consignee, phone, address, city, status,
    cod_amount, fee, booked_at, updated_at, meta
  ) values (
    v_awb, v_client_id, btrim(p_consignee), coalesce(p_phone, ''),
    coalesce(p_address, ''), coalesce(p_city, ''), 'New booked',
    coalesce(p_cod, 0), v_fee, v_now, v_now, v_meta
  )
  returning * into v_row;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.novax_ticket_open(p_subject text, p_body text DEFAULT ''::text, p_awb text DEFAULT ''::text, p_priority text DEFAULT 'normal'::text)
 RETURNS novax_tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_row public.novax_tickets; v_name text; v_open int;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  if coalesce(btrim(p_subject),'') = '' then
    raise exception 'Please describe the issue in one line.';
  end if;
  if char_length(btrim(p_subject)) < 3 then
    raise exception 'Say a little more about the problem.';
  end if;
  if char_length(btrim(p_subject)) > 150 then
    raise exception 'Keep the first line under 150 characters and put the details below it.';
  end if;
  if char_length(coalesce(p_body, '')) > 4000 then
    raise exception 'Keep the message under 4,000 characters.';
  end if;
  -- An AWB on a ticket must be one of this merchant's parcels.
  if nullif(btrim(coalesce(p_awb, '')), '') is not null and not exists (
    select 1 from public.parcels where client_id = v_client and upper(awb) = upper(btrim(p_awb))
  ) then
    raise exception 'AWB % is not one of your parcels. Check the number, or leave it empty.', btrim(p_awb);
  end if;

  -- Return the existing ticket rather than making another one. Deliberately
  -- silent: the merchant asked for help once and gets one ticket, which is
  -- what they expected. An error here would just look like a broken button.
  select * into v_row
    from public.novax_tickets
   where client_id = v_client
     and status <> 'resolved'
     and lower(btrim(subject)) = lower(btrim(p_subject))
     and coalesce(nullif(btrim(awb),''),'') = coalesce(nullif(btrim(p_awb),''),'')
     and created_at > now() - interval '10 minutes'
   order by created_at desc
   limit 1;
  if found then
    return v_row;
  end if;

  select count(*) into v_open from public.novax_tickets
   where client_id = v_client and status <> 'resolved';
  if v_open >= 20 then
    raise exception 'You already have 20 open tickets. Please wait for those to be answered first.';
  end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_tickets (client_id, awb, subject, body, priority, opened_by, opened_by_name)
  values (v_client, nullif(btrim(p_awb),''), btrim(p_subject),
          coalesce(btrim(p_body),''),
          case when p_priority in ('low','normal','high') then p_priority else 'normal' end,
          'client', coalesce(v_name,''))
  returning * into v_row;

  return v_row;
end $function$;

CREATE OR REPLACE FUNCTION public.client_set_store_credentials(p_platform text, p_store_url text, p_consumer_key text, p_consumer_secret text)
 RETURNS TABLE(intake_token text, webhook_secret text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_intake_token text;
  v_webhook_secret text;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  if p_platform is null or p_store_url is null or p_consumer_key is null or p_consumer_secret is null then
    raise exception 'Store URL, consumer key, and consumer secret are all required.';
  end if;
  -- Any seat could replace the store connection; only an Owner may now.
  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can connect a store.' using errcode = '42501';
  end if;
  -- NovaX's servers call this address, so it must be a public https site.
  if p_platform in ('woocommerce', 'web') and not public.nv_public_https_url(p_store_url) then
    raise exception 'Use your store''s public https address, like https://yourstore.com.';
  end if;

  select intake_token, webhook_secret into v_intake_token, v_webhook_secret
    from public.store_secrets where client_id = v_client_id and platform = p_platform;

  if v_intake_token is null then
    v_intake_token := encode(gen_random_bytes(24), 'hex');
    v_webhook_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (v_client_id, p_platform, p_store_url, p_consumer_key, p_consumer_secret, v_webhook_secret, v_intake_token);
  else
    update public.store_secrets
      set store_url = p_store_url, consumer_key = p_consumer_key, consumer_secret = p_consumer_secret, updated_at = now()
      where client_id = v_client_id and platform = p_platform;
  end if;

  if exists (select 1 from public.store_connections where client_id = v_client_id and platform = p_platform) then
    update public.store_connections
      set store_url = p_store_url, connected = true,
          meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('hasCreds', true, 'connectedAt', now()::text)
      where client_id = v_client_id and platform = p_platform;
  else
    insert into public.store_connections (client_id, platform, store_url, connected, meta)
    values (v_client_id, p_platform, p_store_url, true, jsonb_build_object('hasCreds', true, 'connectedAt', now()::text));
  end if;

  return query select v_intake_token, v_webhook_secret;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_staff_user(p_staff_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_role      text;
  v_owners    int;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can revoke access.' using errcode = '42501';
  end if;

  select lower(coalesce(su.role, '')) into v_role
  from public.staff_users su
  where su.id = p_staff_id and su.client_id = v_client_id;

  if v_role is null then
    raise exception 'That team member was not found in your workspace.' using errcode = 'P0002';
  end if;

  if v_role = 'owner' then
    -- The account holder is an Owner even with NO staff_users row -- that is
    -- exactly what is_client_owner_seat() says: "no seat row => the account
    -- that owns the workspace is the owner". This count looked only at
    -- staff_users, so a workspace whose real owner signed up normally and then
    -- added ONE Owner sub-account counted exactly one owner and refused to
    -- revoke it. Reported by Hayat Scents: the seat was Pending, had never
    -- logged in, and could not be removed -- "even though I should already
    -- have the original zeeshan account set as owner of the workspace".
    select count(*) into v_owners
    from public.staff_users su
    where su.client_id = v_client_id
      and lower(coalesce(su.role, '')) = 'owner'
      and coalesce(su.status, 'Active') <> 'Revoked';

    -- Add the account holder, if they hold access without a seat row.
    if exists (
      select 1
      from public.profiles pr
      where pr.client_id = v_client_id
        and not exists (
          select 1 from public.staff_users s2
          where s2.client_id = v_client_id
            and (s2.auth_user_id = pr.id
                 or lower(coalesce(s2.email,'')) = lower(coalesce(pr.email,'')))
        )
    ) then
      v_owners := v_owners + 1;
    end if;

    if v_owners <= 1 then
      raise exception 'You cannot revoke the last Owner of the workspace.' using errcode = '42501';
    end if;
  end if;

  update public.staff_users
     set status = 'Revoked',
         permissions = '[]'::jsonb,
         updated_at = now()
   where id = p_staff_id
     and client_id = v_client_id;

  -- Revoking only flagged the seat: the login stayed linked to the workspace
  -- and could still read its parcels and wallet. Unlink it too. A re-invite
  -- links it again (client-create-subuser accepts an unlinked profile).
  update public.profiles pr
     set client_id = null
   where pr.client_id = v_client_id
     and pr.id <> auth.uid()
     and pr.id = (select su.auth_user_id from public.staff_users su where su.id = p_staff_id);

  return true;
end;
$function$;

commit;
