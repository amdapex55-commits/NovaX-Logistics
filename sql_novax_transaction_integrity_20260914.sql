begin;

-- NovaX transaction integrity, 14 Sep 2026.
--
-- 1. A payout request has a durable caller identity.
-- 2. Every payout decision is made only after the merchant wallet row is
--    locked, so concurrent requests cannot all pass a stale duplicate/balance
--    check.
-- 3. The debit, withdrawal and both ledger rows remain one transaction.
--
-- Existing production guarantees verified before this patch:
--   parcels.awb                         UNIQUE
--   nv_booking_idempotency(client_id, idem_key) PRIMARY KEY
--   wallet_ledger(client_id, entry_type, reference_type, reference_id)
--                                       UNIQUE when reference_id is present

alter table public.withdrawals
  add column if not exists request_key text;

alter table public.withdrawals
  drop constraint if exists withdrawals_request_key_format;
alter table public.withdrawals
  add constraint withdrawals_request_key_format
  check (
    request_key is null
    or (
      request_key = btrim(request_key)
      and length(request_key) between 16 and 200
      and request_key !~ '[[:cntrl:]]'
    )
  );

create unique index if not exists withdrawals_client_request_key_uidx
  on public.withdrawals (client_id, request_key)
  where request_key is not null;

create or replace function public.nv_request_wallet_withdrawal_core(
  p_amount numeric,
  p_iban text,
  p_speed text,
  p_request_key text
)
returns public.withdrawals
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal amount must be greater than zero.';
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
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;
  if v_iban !~ '^PK[0-9A-Z]{13,32}$' then
    raise exception 'IBAN can only contain letters and digits, like PK36SCBL0000001123456702.';
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

  return v_row;
end;
$function$;

-- New clients must supply a durable request key.
create or replace function public.request_wallet_withdrawal_idem(
  p_amount numeric,
  p_iban text,
  p_speed text,
  p_request_key text
)
returns public.withdrawals
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if nullif(btrim(coalesce(p_request_key, '')), '') is null then
    raise exception 'Withdrawal request key is required.';
  end if;
  return public.nv_request_wallet_withdrawal_core(
    p_amount, p_iban, p_speed, p_request_key
  );
end;
$function$;

-- Compatibility for already-open portal tabs. These calls still serialize
-- correctly and retain the post-lock rapid-repeat guard.
create or replace function public.request_wallet_withdrawal(
  p_amount numeric,
  p_iban text,
  p_speed text
)
returns public.withdrawals
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return public.nv_request_wallet_withdrawal_core(
    p_amount, p_iban, p_speed, null
  );
end;
$function$;

revoke all on function public.nv_request_wallet_withdrawal_core(numeric, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.request_wallet_withdrawal_idem(numeric, text, text, text)
  from public, anon;
grant execute on function public.request_wallet_withdrawal_idem(numeric, text, text, text)
  to authenticated, service_role;
revoke execute on function public.request_wallet_withdrawal(numeric, text, text)
  from public, anon;
grant execute on function public.request_wallet_withdrawal(numeric, text, text)
  to authenticated, service_role;

-- Booking keys are durable request identities. Time must not turn the same
-- key into permission to create a second parcel after a delayed retry.
create or replace function public.client_book_parcel_idem(
  p_idem_key text, p_consignee text, p_phone text, p_pickup_city text, p_city text,
  p_address text, p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_id text default ''::text,
  p_reference_no text default ''::text, p_allow_open text default 'No'::text,
  p_origin_area_id uuid default null, p_dest_area_id uuid default null
)
returns public.parcels
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_client uuid := public.my_client_id();
  v_key text := left(btrim(coalesce(p_idem_key, '')), 200);
  v_hit public.nv_booking_idempotency;
  v_row public.parcels;
begin
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;
  -- Order IDs may legitimately be short (for example order 1042). The
  -- merchant-scoped primary key provides uniqueness; only empty/control input
  -- is rejected here.
  if v_key = '' or v_key ~ '[[:cntrl:]]' then
    raise exception 'Booking request key is invalid.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('novax_idem_' || v_client::text || ':' || v_key)
  );
  select * into v_hit
    from public.nv_booking_idempotency
   where client_id = v_client and idem_key = v_key;
  if found then
    select * into v_row
      from public.parcels
     where id = v_hit.parcel_id and client_id = v_client;
    if found and v_row.status is distinct from 'Cancelled by client' then
      return v_row;
    end if;
  end if;

  if p_dest_area_id is not null then
    v_row := public.client_book_parcel_geo(
      p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod,
      p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open, p_origin_area_id, p_dest_area_id
    );
  else
    v_row := public.client_book_parcel(
      p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod,
      p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open
    );
  end if;

  insert into public.nv_booking_idempotency (client_id, idem_key, parcel_id, awb)
  values (v_client, v_key, v_row.id, v_row.awb)
  on conflict (client_id, idem_key) do update
    set parcel_id = excluded.parcel_id,
        awb = excluded.awb,
        created_at = now();
  return v_row;
end;
$function$;

revoke execute on function public.client_book_parcel_idem(
  text, text, text, text, text, text, numeric, text, text, text, text,
  text, text, text, text, uuid, uuid
) from public, anon;
grant execute on function public.client_book_parcel_idem(
  text, text, text, text, text, text, numeric, text, text, text, text,
  text, text, text, text, uuid, uuid
) to authenticated, service_role;

comment on column public.withdrawals.request_key is
  'Opaque client request identity. Unique per merchant; safe retries return the original withdrawal.';

commit;
