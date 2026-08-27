-- =====================================================================
-- NovaX - the invoice becomes the only source of truth for the wallet
--
-- SCENARIOS THIS IMPLEMENTS (Aisha, 27 Aug 2026)
--
--   1  Mixed account. 10 parcels, 6 COD (Rs 10,000, Rs 1,200 charges) and
--      4 non-COD (Rs 800 charges). One invoice: 10,000 - 1,200 - 800 = 8,000.
--      ALREADY CORRECT. admin_generate_invoice_v2 nets exactly this today
--      and nothing below changes that arithmetic.
--
--   2  Zero-COD account. Every charge is a negative that sums up in the
--      client's account. Today the invoice records due_to_novax but NOTHING
--      moves the wallet, so the negative exists only on a list.
--
--   3  Merchant holds Rs 5,000, five zero-COD parcels invoice at -Rs 1,000.
--      The wallet must drop to Rs 4,000 at generation. If they had already
--      withdrawn the 5,000 it must go to -Rs 1,000, and the next COD credit
--      must absorb that 1,000 automatically.
--
-- WHAT WAS ACTUALLY BROKEN
--   No code path anywhere debits a wallet for due_to_novax.
--   admin_generate_invoice_v2 never touched clients.wallet_balance.
--   admin_push_invoice_to_wallet REFUSES a negative invoice outright
--     ("has no client-payable amount") and can only ever ADD.
--   admin_mark_invoice_paid only rewrites a status string.
--   The one thing that ever debited a wallet was trg_post_non_cod_delivery_
--     charge, dropped on 24 Aug for double-charging (commit d00b505).
--   Result: Rs 9,337 across 28 invoices has never moved a single wallet.
--
-- THE FIX IS ONE MOVEMENT IN ONE PLACE
--   Generation applies the invoice to the wallet. Everything in scenario 3
--   then follows without further code: going negative is just arithmetic,
--   the withdrawal block is request_wallet_withdrawal's existing
--   `amount > balance` test, and the next COD credit nets by addition.
--
-- WHAT THIS FILE DOES NOT DO
--   It does not touch the 26 existing 'Generated' invoices carrying
--   Rs 8,860 of never-applied dues, and it does not reverse the Rs 5,527
--   the dropped trigger already took out of wallets. Those two overlap: a
--   backfill that ignores the trigger's rows would charge that Rs 5,527 a
--   second time. PART 5 previews the overlap read-only. Do the backfill as
--   its own reviewed step, after this behaviour has been watched working.
--
-- ORDER: read PART 0, then run PARTS 1-4 in one go. PART 5 is read-only.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 0 - preconditions (read-only). Run this first and read it.
--
-- Every one of these must hold before the parts below are run.
-- ---------------------------------------------------------------------
select 'wallet invariant' as check,
       count(*) filter (where c.wallet_balance is distinct from coalesce(l.s,0)) as must_be_zero,
       count(*) as clients
  from public.clients c
  left join (select client_id, sum(amount) s from public.wallet_ledger
              where affects_balance group by client_id) l on l.client_id = c.id;

-- The double-charging trigger must still be gone. If this returns a row,
-- STOP: running the parts below would reinstate the double charge.
select 'trigger must be absent' as check, t.tgname
  from pg_trigger t
 where t.tgrelid = 'public.parcels'::regclass
   and not t.tgisinternal
   and t.tgname like '%non_cod_delivery_charge%';

-- Nothing should already be using this ledger type.
select 'invoice_due_debit rows (expect 0)' as check, count(*)
  from public.wallet_ledger where entry_type = 'invoice_due_debit';


-- ---------------------------------------------------------------------
-- PART 1a - allow the two new ledger types
--
-- wallet_ledger.entry_type carries a CHECK constraint listing every allowed
-- type. Without this the insert in PART 1 fails at runtime with
-- "violates check constraint wallet_ledger_entry_type_check" -- which is
-- exactly what happened on the first rehearsal of this migration.
--
-- Widening a CHECK cannot invalidate existing rows, and the two new types
-- are deliberately NOT delivery_charge_due: that type belongs to the dropped
-- trigger, and PART 5 relies on it to tell what was already taken from a
-- wallet. Reusing it would make the historical backfill uncountable.
-- ---------------------------------------------------------------------
alter table public.wallet_ledger drop constraint if exists wallet_ledger_entry_type_check;
alter table public.wallet_ledger add constraint wallet_ledger_entry_type_check
  check (entry_type = any (array[
    'invoice_credit', 'withdrawal_requested', 'payout_fee', 'payout_paid',
    'payout_rejected', 'admin_adjustment', 'delivery_charge_due',
    'invoice_due_debit', 'invoice_due_reversal'
  ]));


-- ---------------------------------------------------------------------
-- PART 1 - generation applies the invoice to the wallet
--
-- This is the live money function. The body below is the CURRENT deployed
-- definition with one block added before each of its two return points;
-- the netting arithmetic above it is untouched, byte for byte, so
-- scenario 1 cannot change.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_generate_invoice_v2(p_client_id uuid, p_awbs text[], p_net_returns boolean DEFAULT true)
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, cod_total numeric, fee_total numeric, net_payable numeric, due_to_novax numeric, return_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cod_total  numeric := 0;   -- COD collected on delivered COD parcels
  v_cod_fee    numeric := 0;   -- delivery charges on those
  v_due_fee    numeric := 0;   -- charges owed: prepaid deliveries + returns
  v_ret_fee    numeric := 0;   -- of which, returns
  v_cod_count  int := 0;
  v_ret_count  int := 0;
  v_due_count  int := 0;
  v_payable    numeric := 0;
  v_due        numeric := 0;
  v_code       text;
  v_type       text;
  v_id         uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null or p_awbs is null or array_length(p_awbs,1) is null then
    raise exception 'Select a client and at least one parcel.';
  end if;

  -- Lock the rows so two admins cannot invoice the same parcels at once.
  perform 1 from public.parcels
   where client_id = p_client_id and awb = any(p_awbs) for update;

  select
    count(*) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),
    count(*) filter (where public.is_return_chargeable(p.status)),
    count(*) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'),
    coalesce(sum(p.cod_amount) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),0),
    coalesce(sum(p.fee)        filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),0),
    coalesce(sum(p.fee)        filter (where public.is_return_chargeable(p.status)),0),
    coalesce(sum(p.fee)        filter (where public.is_return_chargeable(p.status)
                       or coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'),0)
    into v_cod_count, v_ret_count, v_due_count,
         v_cod_total, v_cod_fee, v_ret_fee, v_due_fee
    from public.parcels p
   where p.client_id = p_client_id
     and p.awb = any(p_awbs)
     and p.invoice_id is null
     and (
       p.status = 'Delivered'
       or (p.meta->'steps') @> '"COD collected"'::jsonb
       or public.is_return_chargeable(p.status)
     );

  if coalesce(v_cod_count,0) + coalesce(v_ret_count,0) + coalesce(v_due_count,0) = 0 then
    raise exception 'None of the selected parcels are invoice-eligible (or they are already invoiced).';
  end if;

  v_code := 'INV-' || to_char(now(),'YYMMDD') || substr(replace(gen_random_uuid()::text,'-',''),1,5);

  if p_net_returns then
    -- ONE netted invoice: COD minus its own charges minus return/prepaid charges.
    v_payable := greatest(0, v_cod_total - v_cod_fee - v_due_fee);
    -- Whatever the COD could not absorb stays owed, and surfaces in the
    -- Negative Accounts pool rather than being written off silently.
    v_due     := greatest(0, v_due_fee - greatest(0, v_cod_total - v_cod_fee));
    v_type    := case
                   when v_cod_count = 0 then 'Delivery Charges'
                   when v_ret_count > 0 or v_due_count > 0 then 'Mixed'
                   else 'COD Settlement'
                 end;

    insert into public.invoices (
      code, client_id, parcel_refs, cod_total, fee_total,
      net_payable, due_to_novax, invoice_type, status, meta
    )
    select v_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb),
           v_cod_total, v_cod_fee + v_due_fee, v_payable, v_due, v_type, 'Generated',
           jsonb_build_object(
             'returnCount',   v_ret_count,
             'returnCharges', v_ret_fee,
             'prepaidCharges', v_due_fee - v_ret_fee,
             'nettedReturns', true
           )
      from public.parcels p
     where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
       and (p.status = 'Delivered'
            or (p.meta->'steps') @> '"COD collected"'::jsonb
            or public.is_return_chargeable(p.status))
    returning id into v_id;

    update public.parcels p
       set invoice_id = v_id, invoiced_at = now()
     where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
       and (p.status = 'Delivered'
            or (p.meta->'steps') @> '"COD collected"'::jsonb
            or public.is_return_chargeable(p.status));


    -- ---- SCENARIO 2 + 3: the invoice moves the wallet, here, once. --------
    -- v_payable and v_due are mutually exclusive by construction above: if
    -- the COD covered the charges v_due is 0, and if it did not v_payable is
    -- 0. So this is one signed movement, not two competing ones.
    --
    -- The debit is what makes the invoice the only source of truth. Before
    -- this, a negative invoice moved nothing: the wallet stayed where it was
    -- and the debt lived only in the Negative Accounts list, which is why a
    -- merchant could hold Rs 10,083 and owe Rs 477 at the same time and
    -- withdraw all of it.
    --
    -- Two behaviours come free once the money actually lands in the wallet,
    -- and neither needs its own code:
    --   * a merchant who already withdrew goes negative, and
    --     request_wallet_withdrawal's `amount > balance` check then blocks
    --     any further payout on its own;
    --   * the next COD invoice pushed to that wallet nets against it by
    --     ordinary arithmetic (-1000 + 8000 = 7000).
    if v_due > 0 then
      update public.clients
         set wallet_balance = coalesce(wallet_balance, 0) - v_due
       where id = p_client_id;

      -- clients.wallet_balance must always equal the sum of that client's
      -- affects_balance ledger rows. It does today for all 216 clients, and
      -- computeWalletReconciliation() BLOCKS payouts for anyone it does not
      -- hold for -- so the balance move and this row are one transaction.
      insert into public.wallet_ledger
        (client_id, entry_type, amount, affects_balance, status,
         reference_type, reference_id, reference_code, note)
      values
        (p_client_id, 'invoice_due_debit', -v_due, true, 'Delivery charge',
         'invoice', v_id, v_code,
         'Invoice ' || v_code || ' - delivery charges owed on prepaid and returned parcels, taken from wallet.');
    end if;

    return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                        v_payable, v_due, v_ret_count;
    return;
  end if;

  -- Not netting: single Delivery Charges invoice for the returns/prepaid only.
  v_payable := greatest(0, v_cod_total - v_cod_fee);
  v_due     := v_due_fee;
  v_type    := case when v_cod_count = 0 then 'Delivery Charges' else 'Mixed' end;

  insert into public.invoices (
    code, client_id, parcel_refs, cod_total, fee_total,
    net_payable, due_to_novax, invoice_type, status, meta
  )
  select v_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb),
         v_cod_total, v_cod_fee + v_due_fee, v_payable, v_due, v_type, 'Generated',
         jsonb_build_object('returnCount', v_ret_count, 'returnCharges', v_ret_fee,
                            'nettedReturns', false)
    from public.parcels p
   where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
     and (p.status = 'Delivered'
          or (p.meta->'steps') @> '"COD collected"'::jsonb
          or public.is_return_chargeable(p.status))
  returning id into v_id;

  update public.parcels p
     set invoice_id = v_id, invoiced_at = now()
   where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
     and (p.status = 'Delivered'
          or (p.meta->'steps') @> '"COD collected"'::jsonb
          or public.is_return_chargeable(p.status));


  -- ---- SCENARIO 2 + 3: the invoice moves the wallet, here, once. --------
  -- v_payable and v_due are mutually exclusive by construction above: if
  -- the COD covered the charges v_due is 0, and if it did not v_payable is
  -- 0. So this is one signed movement, not two competing ones.
  --
  -- The debit is what makes the invoice the only source of truth. Before
  -- this, a negative invoice moved nothing: the wallet stayed where it was
  -- and the debt lived only in the Negative Accounts list, which is why a
  -- merchant could hold Rs 10,083 and owe Rs 477 at the same time and
  -- withdraw all of it.
  --
  -- Two behaviours come free once the money actually lands in the wallet,
  -- and neither needs its own code:
  --   * a merchant who already withdrew goes negative, and
  --     request_wallet_withdrawal's `amount > balance` check then blocks
  --     any further payout on its own;
  --   * the next COD invoice pushed to that wallet nets against it by
  --     ordinary arithmetic (-1000 + 8000 = 7000).
  if v_due > 0 then
    update public.clients
       set wallet_balance = coalesce(wallet_balance, 0) - v_due
     where id = p_client_id;

    -- clients.wallet_balance must always equal the sum of that client's
    -- affects_balance ledger rows. It does today for all 216 clients, and
    -- computeWalletReconciliation() BLOCKS payouts for anyone it does not
    -- hold for -- so the balance move and this row are one transaction.
    insert into public.wallet_ledger
      (client_id, entry_type, amount, affects_balance, status,
       reference_type, reference_id, reference_code, note)
    values
      (p_client_id, 'invoice_due_debit', -v_due, true, 'Delivery charge',
       'invoice', v_id, v_code,
       'Invoice ' || v_code || ' - delivery charges owed on prepaid and returned parcels, taken from wallet.');
  end if;

  return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                      v_payable, v_due, v_ret_count;
end;
$function$;

-- ---------------------------------------------------------------------
-- PART 2 - cancelling an invoice gives the money back
--
-- REQUIRED, not optional. admin_cancel_invoice only accepts invoices that
-- are still 'Generated' -- which, after PART 1, are exactly the ones whose
-- debit has already been applied. Without this, cancelling a negative
-- invoice would release the parcels, mark it Cancelled, and silently keep
-- the merchant's money, breaking the balance/ledger invariant and blocking
-- their payouts.
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_invoice(p_invoice_id uuid)
 returns public.invoices
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice  public.invoices;
  v_debited  numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice is null then
    raise exception 'Invoice not found.';
  end if;
  if v_invoice.status <> 'Generated' then
    raise exception 'Invoice % can only be cancelled while still Generated (not yet pushed to wallet or closed).', v_invoice.code;
  end if;

  -- Reverse the generation debit, if there was one. Summed from the ledger
  -- rather than recomputed from due_to_novax, so this reverses exactly what
  -- was taken even if the invoice row were later edited.
  select coalesce(sum(l.amount), 0) into v_debited
    from public.wallet_ledger l
   where l.reference_type = 'invoice'
     and l.reference_id   = p_invoice_id
     and l.entry_type     = 'invoice_due_debit'
     and l.affects_balance;

  if v_debited < 0 then
    update public.clients
       set wallet_balance = coalesce(wallet_balance, 0) - v_debited   -- v_debited is negative: this adds it back
     where id = v_invoice.client_id;

    insert into public.wallet_ledger
      (client_id, entry_type, amount, affects_balance, status,
       reference_type, reference_id, reference_code, note)
    values
      (v_invoice.client_id, 'invoice_due_reversal', -v_debited, true, 'Reversed',
       'invoice', p_invoice_id, v_invoice.code,
       'Invoice ' || v_invoice.code || ' cancelled - delivery charges taken at generation returned to wallet.');
  end if;

  update public.parcels set invoice_id = null, invoiced_at = null where invoice_id = p_invoice_id;
  update public.invoices set status = 'Cancelled' where id = p_invoice_id returning * into v_invoice;
  return v_invoice;
end;
$function$;


-- ---------------------------------------------------------------------
-- PART 3 - Outstanding Balances stops asking for money already taken
--
-- Two exclusions, both of which are live double-counts today:
--
--   1. an invoice whose due has been debited to the wallet. The negative
--      wallet is now the record of that debt; leaving it here as well is
--      the same money in two places, which is the bug this whole file is
--      about.
--   2. status 'Paid to NovaX'. Global Tech's two invoices were marked paid
--      on 20 and 23 July and are STILL listed as Rs 477 outstanding,
--      because the view only ever excluded deleted/cancelled.
-- ---------------------------------------------------------------------
create or replace view public.client_dues_summary as
 with invoiced as (
         select i.client_id,
            coalesce(sum(i.due_to_novax), 0::numeric) as due_invoiced,
            count(*) as due_invoice_count,
            min(i.created_at) filter (where i.due_to_novax > 0::numeric) as oldest_due_at,
            max(i.created_at) filter (where i.due_to_novax > 0::numeric) as newest_due_at
           from invoices i
          where coalesce(i.due_to_novax, 0::numeric) > 0::numeric
            and (lower(coalesce(i.status, ''::text)) <> all (array['deleted'::text, 'cancelled'::text, 'canceled'::text, 'paid to novax'::text]))
            and not exists (
                  select 1 from wallet_ledger l
                   where l.reference_type = 'invoice'
                     and l.reference_id = i.id
                     and l.entry_type = 'invoice_due_debit'
                     and l.affects_balance)
          group by i.client_id
        ), paid as (
         select p.client_id,
            coalesce(sum(p.amount), 0::numeric) as due_paid,
            max(p.created_at) as last_payment_at
           from client_due_payments p
          group by p.client_id
        )
 select c.id as client_id,
    c.name as client_name,
    coalesce(inv.due_invoiced, 0::numeric) as due_invoiced,
    coalesce(pd.due_paid, 0::numeric) as due_paid,
    coalesce(inv.due_invoiced, 0::numeric) - coalesce(pd.due_paid, 0::numeric) as outstanding,
    coalesce(inv.due_invoice_count, 0::bigint) as due_invoice_count,
    inv.oldest_due_at,
    inv.newest_due_at,
    pd.last_payment_at,
    coalesce(c.wallet_balance, 0::numeric) as wallet_balance,
        case
            when inv.oldest_due_at is null then null::integer
            else floor(extract(epoch from now() - inv.oldest_due_at) / 86400::numeric)::integer
        end as oldest_due_age_days
   from clients c
     left join invoiced inv on inv.client_id = c.id
     left join paid pd on pd.client_id = c.id;


-- ---------------------------------------------------------------------
-- PART 4 - verify (read-only). Run immediately after parts 1-3.
-- ---------------------------------------------------------------------
-- The invariant must STILL hold for all 216 clients. Nothing above has run
-- against real data yet, so this must be unchanged from PART 0.
select 'wallet invariant after' as check,
       count(*) filter (where c.wallet_balance is distinct from coalesce(l.s,0)) as must_be_zero
  from public.clients c
  left join (select client_id, sum(amount) s from public.wallet_ledger
              where affects_balance group by client_id) l on l.client_id = c.id;

-- Global Tech's Rs 477 should now be gone from the dues list (both its
-- invoices are 'Paid to NovaX'), and the list total should drop from 9,337.
select round(sum(outstanding), 0) as outstanding_total, count(*) as merchants
  from public.client_dues_summary where outstanding <> 0;


-- ---------------------------------------------------------------------
-- PART 5 - the historical backfill, PREVIEW ONLY. Nothing here writes.
--
-- The 26 'Generated' invoices carrying Rs 8,860 of dues predate PART 1 and
-- will never debit a wallet on their own. But Rs 5,527 of that same debt
-- was ALREADY taken out of wallets by the trigger before it was dropped.
-- Applying the backfill without subtracting that would charge it twice --
-- the exact bug this file exists to end.
--
-- already_taken  = what the dropped trigger removed from this wallet
-- still_to_apply = what a backfill would need to move, and no more
-- ---------------------------------------------------------------------
with taken as (
  select client_id, -sum(amount) as already_taken
    from public.wallet_ledger
   where entry_type = 'delivery_charge_due' and affects_balance
   group by client_id
)
select s.client_name,
       s.outstanding                                   as shown_now,
       coalesce(t.already_taken, 0)                     as already_taken,
       s.outstanding - coalesce(t.already_taken, 0)     as still_to_apply,
       s.wallet_balance
  from public.client_dues_summary s
  left join taken t on t.client_id = s.client_id
 where s.outstanding <> 0
 order by coalesce(t.already_taken, 0) desc, s.outstanding desc;
