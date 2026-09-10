begin;

-- NovaX security batch 4, 10 Sep 2026: IBAN characters.

-- ---------------------------------------------------------------- request_wallet_withdrawal
CREATE OR REPLACE FUNCTION public.request_wallet_withdrawal(p_amount numeric, p_iban text, p_speed text)
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

  -- NovaX fix (withdrawal UX v3): saved bank details are only a
  -- convenience/default now, never a hard lock -- p_iban is always what
  -- actually gets paid, whether it matches a saved account or is a brand
  -- new one the client typed/pasted for this withdrawal. It still gets the
  -- same normalization + validation as save_client_bank_details.
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

  -- Letters and digits only. Only "starts with PK" and a minimum length were
  -- checked, so an IBAN could carry markup straight into the admin payout
  -- queue. Dashes are accepted as typed and removed above.
  if v_iban !~ '^PK[0-9A-Z]{13,32}$' then
    raise exception 'IBAN can only contain letters and digits, like PK36SCBL0000001123456702.';
  end if;
  if p_speed not in ('24h','12h','instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  -- Prevent duplicate rapid submissions (double-click / retry storms):
  -- one still-pending request per client per 15-second window.
  if exists (
    select 1 from public.withdrawals
    where client_id = v_client_id and status = 'Pending admin payout'
      and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'A withdrawal request was already submitted. Please wait a moment before trying again.';
  end if;

  -- holder_name/bank_name are read only to snapshot onto the withdrawal row
  -- for admin visibility if the client has saved them -- never required and
  -- never compared against p_iban.
  select coalesce(wallet_balance,0),
    btrim(coalesce(meta->'bank'->>'holderName','')),
    btrim(coalesce(meta->'bank'->>'bankName',''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients where id = v_client_id for update;
  if v_balance is null then
    raise exception 'Client wallet not found.';
  end if;
  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients set wallet_balance = v_balance - p_amount where id = v_client_id;

  insert into public.withdrawals (client_id, amount, fee, net, iban, speed, status, balance_before, holder_name, bank_name)
  values (v_client_id, p_amount, v_fee, v_net, v_iban, p_speed, 'Pending admin payout', v_balance, nullif(v_holder_name,''), nullif(v_bank_name,''))
  returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'withdrawal_requested', -p_amount, true, 'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested: Rs ' || p_amount || ' reserved, ' || v_net || ' net after Rs ' || v_fee || ' fee (' || p_speed || ').');
  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'payout_fee', -v_fee, false, 'Informational', 'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).');

  return v_row;
end;
$function$;

-- ---------------------------------------------------------------- save_client_bank_details
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
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;

  -- Letters and digits only. Only "starts with PK" and a minimum length were
  -- checked, so an IBAN could carry markup straight into the admin payout
  -- queue. Dashes are accepted as typed and removed above.
  if v_iban !~ '^PK[0-9A-Z]{13,32}$' then
    raise exception 'IBAN can only contain letters and digits, like PK36SCBL0000001123456702.';
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

commit;
