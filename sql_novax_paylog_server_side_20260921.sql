-- NovaX: move the withdrawal payment-history entry server-side.
--
-- Before: nv_request_wallet_withdrawal_core() wrote the withdrawal and two
-- wallet_ledger rows atomically, but the matching payment_logs entry was
-- built in the browser and inserted separately, fire-and-forget. Measured on
-- production before this migration: 112 withdrawals, 1 with no payment-history
-- entry at all, 0 duplicates. The withdrawal itself was never at risk -- it is
-- already idempotent on request_key -- only its history entry was.
--
-- After: the entry is written inside the same transaction and is idempotent on
-- the withdrawal id, so it can be neither lost nor duplicated.

begin;

-- Idempotency for the new rows. Scoped to references that are UUIDs so the 112
-- historical rows, whose reference holds a speed label like "24 hour payout"
-- and therefore repeats per client, are excluded and index creation cannot
-- fail on them. Mirrors payment_logs_cod_expected_uniq.
create unique index if not exists payment_logs_withdrawal_uniq
  on public.payment_logs (client_id, reference)
  where type = 'Wallet withdrawal requested'
    and reference ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

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


-- Backfill: the single withdrawal that never got its history entry. Written
-- with the withdrawal id as reference like every new row, and guarded by NOT
-- EXISTS on the same amount/time window the reconciliation check uses, so
-- re-running this migration cannot add a second one.
insert into public.payment_logs (client_id, type, amount, status, reference, created_at)
select w.client_id,
       'Wallet withdrawal requested',
       w.amount,
       'Rs ' || w.net || ' net after Rs ' || w.fee || ' fee',
       w.id::text,
       w.created_at
from public.withdrawals w
where not exists (
  select 1 from public.payment_logs p
   where p.client_id = w.client_id
     and p.type = 'Wallet withdrawal requested'
     and p.amount = w.amount
     and p.created_at between w.created_at - interval '5 minutes'
                          and w.created_at + interval '30 minutes'
)
on conflict do nothing;

-- Reconciliation. Read-only: reports, never repairs, so it is safe to run any
-- time and safe to schedule. One row per withdrawal that does not line up with
-- its payment-history entry or its ledger reservation.
create or replace function public.nv_reconcile_withdrawals()
returns table (
  withdrawal_id uuid,
  client_id uuid,
  amount numeric,
  created_at timestamptz,
  problem text
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select w.id, w.client_id, w.amount, w.created_at, x.problem
  from public.withdrawals w
  cross join lateral (
    select case
      when (select count(*) from public.payment_logs p
             where p.client_id = w.client_id
               and p.type = 'Wallet withdrawal requested'
               and (p.reference = w.id::text
                    or (p.amount = w.amount
                        and p.created_at between w.created_at - interval '5 minutes'
                                             and w.created_at + interval '30 minutes'))) = 0
        then 'no payment-history entry'
      when (select count(*) from public.payment_logs p
             where p.client_id = w.client_id
               and p.type = 'Wallet withdrawal requested'
               and (p.reference = w.id::text
                    or (p.amount = w.amount
                        and p.created_at between w.created_at - interval '5 minutes'
                                             and w.created_at + interval '30 minutes'))) > 1
        then 'duplicate payment-history entries'
      when not exists (select 1 from public.wallet_ledger l
                        where l.reference_type = 'withdrawal'
                          and l.reference_id = w.id
                          and l.entry_type = 'withdrawal_requested')
        then 'no ledger reservation'
      when (select l.amount from public.wallet_ledger l
             where l.reference_type = 'withdrawal' and l.reference_id = w.id
               and l.entry_type = 'withdrawal_requested' limit 1) <> -w.amount
        then 'ledger reservation does not match withdrawal amount'
      else null
    end as problem
  ) x
  where x.problem is not null
  order by w.created_at desc;
$fn$;

revoke all on function public.nv_reconcile_withdrawals() from public, anon;
grant execute on function public.nv_reconcile_withdrawals() to authenticated, service_role;

commit;
