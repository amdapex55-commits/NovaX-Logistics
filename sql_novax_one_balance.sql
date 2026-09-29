-- ONE balance per merchant (29 Sep 2026).
--
-- The problem. Prepaid-parcel delivery charges were collected two ways:
--   1. per parcel, straight from the wallet (trg_post_non_cod_delivery_charge,
--      wallet_ledger 'delivery_charge_due') -- July to 24 Aug;
--   2. on a "Delivery Charges" invoice counted as Outstanding until someone
--      pressed Record payment (client_dues_summary).
-- client_dues_summary only skipped invoices settled with 'invoice_due_debit',
-- not parcels already charged one by one, so 12 invoices / Rs 4,810 were
-- counted twice. And admin_generate_invoice_v2 (the current generator) takes
-- an invoice's charges from the wallet but leaves it "Generated", so the
-- merchant's Money tab added "owed invoices" and "negative wallet" together,
-- and admin could still "Mark Paid To NovaX" -- collecting it again.
--
-- The rule from here on: the WALLET is the one balance. Every charge lives in
-- it; a negative wallet is what the merchant owes. An invoice whose charges
-- are in the wallet carries wallet_pushed_at (its status stays "Generated",
-- so admin can still cancel it and admin_cancel_invoice still reverses it).
--
-- Nothing is deleted or rewritten: old invoices keep their numbers; the move
-- into the wallet is a new ledger row per invoice, so clients.wallet_balance
-- keeps equalling the sum of its ledger (the payout reconciliation check).

-- ----------------------------------------------------------------- schema
alter table public.client_due_payments add column if not exists consolidated_at timestamptz;

-- A payment NovaX receives towards charges is now a wallet credit.
alter table public.wallet_ledger drop constraint if exists wallet_ledger_entry_type_check;
alter table public.wallet_ledger add constraint wallet_ledger_entry_type_check check (entry_type = any (array[
  'invoice_credit','withdrawal_requested','payout_fee','payout_paid','payout_rejected','admin_adjustment',
  'delivery_charge_due','invoice_due_debit','invoice_due_reversal','due_payment']));

-- Outstanding, computed honestly: an invoice's due minus any of its parcels'
-- fees already taken from the wallet, and only while nothing has moved it
-- into the wallet. (After the migration below this is 0 for everyone; it is
-- kept correct so no future edge case can double-count again.)
create or replace view public.client_dues_summary as
 WITH inv_due AS (
         SELECT i.id, i.client_id, i.created_at,
                greatest(0::numeric, COALESCE(i.due_to_novax, 0::numeric)
                  - COALESCE((SELECT sum(p.fee) FROM parcels p
                               WHERE p.invoice_id = i.id AND p.delivery_charge_posted_at IS NOT NULL), 0::numeric)) AS due
           FROM invoices i
          WHERE COALESCE(i.due_to_novax, 0::numeric) > 0::numeric
            AND i.wallet_pushed_at IS NULL
            AND (lower(COALESCE(i.status, ''::text)) <> ALL (ARRAY['deleted'::text, 'cancelled'::text, 'canceled'::text, 'paid to novax'::text, 'settled'::text, 'pushed to wallet'::text]))
            AND NOT (EXISTS ( SELECT 1 FROM wallet_ledger l
                  WHERE l.reference_type = 'invoice'::text AND l.reference_id = i.id AND l.entry_type = 'invoice_due_debit'::text AND l.affects_balance))
        ), invoiced AS (
         SELECT d.client_id,
            COALESCE(sum(d.due), 0::numeric) AS due_invoiced,
            count(*) FILTER (WHERE d.due > 0::numeric) AS due_invoice_count,
            min(d.created_at) FILTER (WHERE d.due > 0::numeric) AS oldest_due_at,
            max(d.created_at) FILTER (WHERE d.due > 0::numeric) AS newest_due_at
           FROM inv_due d
          GROUP BY d.client_id
        ), paid AS (
         SELECT p.client_id,
            COALESCE(sum(p.amount) FILTER (WHERE p.consolidated_at IS NULL), 0::numeric) AS due_paid,
            max(p.created_at) AS last_payment_at
           FROM client_due_payments p
          GROUP BY p.client_id
        )
 SELECT c.id AS client_id,
    c.name AS client_name,
    COALESCE(inv.due_invoiced, 0::numeric) AS due_invoiced,
    COALESCE(pd.due_paid, 0::numeric) AS due_paid,
    greatest(0::numeric, COALESCE(inv.due_invoiced, 0::numeric) - COALESCE(pd.due_paid, 0::numeric)) AS outstanding,
    COALESCE(inv.due_invoice_count, 0::bigint) AS due_invoice_count,
    inv.oldest_due_at,
    inv.newest_due_at,
    pd.last_payment_at,
    COALESCE(c.wallet_balance, 0::numeric) AS wallet_balance,
        CASE
            WHEN inv.oldest_due_at IS NULL THEN NULL::integer
            ELSE floor(EXTRACT(epoch FROM now() - inv.oldest_due_at) / 86400::numeric)::integer
        END AS oldest_due_age_days
   FROM clients c
     LEFT JOIN invoiced inv ON inv.client_id = c.id
     LEFT JOIN paid pd ON pd.client_id = c.id;

-- -------------------------------------------------------------- migration
-- Move every remaining genuine legacy charge into the wallet, once.
do $$
declare
  r        record;
  inv      record;
  v_pool   numeric;       -- cash already recorded for this client, applied oldest invoice first
  v_rem    numeric;
  v_apply  numeric;
  v_moved  numeric;
  v_total  numeric;
  v_posted numeric;
  v_now    timestamptz := now();
begin
  for r in
    select distinct i.client_id
      from invoices i
     where coalesce(i.due_to_novax,0) > 0 and i.status = 'Generated' and i.wallet_pushed_at is null
       and not exists (select 1 from wallet_ledger l where l.reference_type='invoice' and l.reference_id=i.id and l.entry_type='invoice_due_debit')
  loop
    select coalesce(sum(amount),0) into v_pool from client_due_payments where client_id = r.client_id and consolidated_at is null;
    v_total := 0;
    for inv in
      select i.* from invoices i
       where i.client_id = r.client_id and coalesce(i.due_to_novax,0) > 0 and i.status = 'Generated' and i.wallet_pushed_at is null
         and not exists (select 1 from wallet_ledger l where l.reference_type='invoice' and l.reference_id=i.id and l.entry_type='invoice_due_debit')
       order by i.created_at
       for update
    loop
      select coalesce(sum(p.fee),0) into v_posted from parcels p where p.invoice_id = inv.id and p.delivery_charge_posted_at is not null;
      v_rem   := greatest(0, inv.due_to_novax - v_posted);
      v_apply := least(v_pool, v_rem);
      v_pool  := v_pool - v_apply;
      v_moved := v_rem - v_apply;
      if v_moved > 0 then
        update clients set wallet_balance = coalesce(wallet_balance,0) - v_moved where id = inv.client_id;
        insert into wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
        values (inv.client_id, 'invoice_due_debit', -v_moved, true, 'Delivery charge', 'invoice', inv.id, inv.code,
                'Unpaid delivery charges on invoice ' || inv.code || ' moved into your wallet balance, so you have one balance with NovaX.');
        v_total := v_total + v_moved;
      end if;
      update invoices
         set wallet_pushed_at = v_now,
             meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object(
               'oneBalance', jsonb_build_object('at', v_now, 'due', inv.due_to_novax, 'alreadyTakenPerParcel', v_posted,
                                                'cashApplied', v_apply, 'movedToWallet', v_moved))
       where id = inv.id;
    end loop;
    update client_due_payments set consolidated_at = v_now where client_id = r.client_id and consolidated_at is null;
    insert into audit_log (actor, action, entity, entity_id, detail)
    values (null, 'one_balance_consolidation', 'client', r.client_id,
            jsonb_build_object('movedToWallet', v_total, 'unusedCashPayments', v_pool, 'at', v_now));
  end loop;

  -- Invoices the current generator already took from the wallet: stamp them,
  -- so no screen treats them as still owed.
  update invoices i
     set wallet_pushed_at = (select min(l.created_at) from wallet_ledger l
                              where l.reference_type='invoice' and l.reference_id=i.id and l.entry_type='invoice_due_debit')
   where i.wallet_pushed_at is null
     and exists (select 1 from wallet_ledger l where l.reference_type='invoice' and l.reference_id=i.id
                  and l.entry_type='invoice_due_debit' and l.affects_balance);
end $$;

-- -------------------------------------------------- one "owes NovaX" figure
-- Admin Negative Accounts: everyone whose ONE balance is below zero.
drop function if exists public.admin_list_client_dues();
create function public.admin_list_client_dues()
returns table(client_id uuid, client_name text, due_invoiced numeric, due_paid numeric, outstanding numeric,
              due_invoice_count integer, oldest_due_at timestamptz, oldest_due_age_days integer,
              last_payment_at timestamptz, wallet_balance numeric, charges jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
  with owing as (
    select c.id, c.name, coalesce(c.wallet_balance,0) as wallet, coalesce(s.outstanding,0) as legacy,
           greatest(0, coalesce(s.outstanding,0) - coalesce(c.wallet_balance,0)) as owed
      from clients c left join client_dues_summary s on s.client_id = c.id
     where coalesce(c.wallet_balance,0) - coalesce(s.outstanding,0) < 0
  ), led as (
    -- eff: when the charge really arose. A charge moved in from an old invoice
    -- is dated by that invoice, not by the day it was moved.
    select l.client_id, l.id, l.created_at, l.amount, l.entry_type, l.reference_code, l.note,
           case when l.entry_type = 'invoice_due_debit'
                then coalesce((select i.created_at from invoices i where i.id = l.reference_id), l.created_at)
                else l.created_at end as eff,
           sum(l.amount) over (partition by l.client_id order by l.created_at, l.id) as run
      from wallet_ledger l where l.affects_balance and l.client_id in (select id from owing)
  ), start_at as (
    -- the current negative stretch began with the first entry after the last
    -- moment the balance was at or above zero
    select o.id as client_id,
           (select min(x.created_at) from led x
             where x.client_id = o.id
               and x.created_at > coalesce((select max(y.created_at) from led y where y.client_id = o.id and y.run >= 0), '-infinity'::timestamptz)) as since,
           (select min(x.eff) from led x
             where x.client_id = o.id and x.amount < 0
               and x.created_at > coalesce((select max(y.created_at) from led y where y.client_id = o.id and y.run >= 0), '-infinity'::timestamptz)) as oldest
      from owing o
  )
  select o.id, o.name, o.legacy, 0::numeric, o.owed,
         (select count(*)::int from led x where x.client_id = o.id and x.amount < 0 and x.created_at >= coalesce(st.since, '-infinity'::timestamptz)),
         coalesce(st.oldest, st.since),
         case when coalesce(st.oldest, st.since) is null then null else floor(extract(epoch from now() - coalesce(st.oldest, st.since)) / 86400)::int end,
         (select max(x.created_at) from led x where x.client_id = o.id and x.amount > 0),
         o.wallet,
         coalesce((select jsonb_agg(jsonb_build_object('at', x.eff, 'type', x.entry_type, 'amount', x.amount,
                                                        'ref', x.reference_code, 'note', x.note) order by x.created_at)
                     from (select * from led x where x.client_id = o.id and x.created_at >= coalesce(st.since, '-infinity'::timestamptz)
                           order by x.created_at desc limit 60) x), '[]'::jsonb)
    from owing o left join start_at st on st.client_id = o.id
   order by o.owed desc, st.since asc nulls last;
end $$;

-- Wallet Balances page: "Owes NovaX" is the same one figure.
create or replace function public.admin_list_wallet_balances()
returns table(client_id uuid, client_name text, wallet_balance numeric, pending_payout numeric, lifetime_paid numeric,
              dues_outstanding numeric, net_position numeric, last_activity_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
    select c.id, c.name, coalesce(c.wallet_balance, 0),
           coalesce((select sum(w.net) from public.withdrawals w where w.client_id = c.id and w.status = 'Pending admin payout'), 0),
           coalesce((select sum(w.net) from public.withdrawals w where w.client_id = c.id and w.status = 'Paid'), 0),
           greatest(0, coalesce(s.outstanding, 0) - coalesce(c.wallet_balance, 0)),
           coalesce(c.wallet_balance, 0) - coalesce(s.outstanding, 0),
           (select max(l.created_at) from public.wallet_ledger l where l.client_id = c.id)
      from public.clients c
      left join public.client_dues_summary s on s.client_id = c.id
     order by coalesce(c.wallet_balance, 0) desc;
end $$;

-- ----------------------------------------------------- recording payments
-- A payment now goes INTO the wallet (one balance), with a ledger row, and is
-- also kept in client_due_payments for its reference / duplicate checks.
create or replace function public.admin_record_due_payment(p_client_id uuid, p_amount numeric, p_method text default 'Manual',
                                                           p_reference text default '', p_note text default '')
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_owed numeric;
  v_ref  text := btrim(coalesce(p_reference, ''));
  v_meth text := coalesce(nullif(btrim(p_method), ''), 'Manual');
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_client_id is null then raise exception 'Client is required.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount received.'; end if;
  perform pg_advisory_xact_lock(hashtext('novax_due_' || p_client_id::text));
  if v_ref <> '' and exists (select 1 from client_due_payments d where d.client_id = p_client_id and lower(btrim(d.reference)) = lower(v_ref)) then
    raise exception 'A payment with reference "%" is already recorded for this client. Nothing was recorded twice.', v_ref;
  end if;
  if v_ref = '' and exists (select 1 from client_due_payments d where d.client_id = p_client_id and d.amount = p_amount
                             and coalesce(d.reference,'') = '' and d.created_at > now() - interval '2 minutes') then
    raise exception 'The same amount was recorded for this client moments ago. If this really is a second payment, add its reference and record it again.';
  end if;
  select greatest(0, coalesce(s.outstanding,0) - coalesce(c.wallet_balance,0)) into v_owed
    from clients c left join client_dues_summary s on s.client_id = c.id where c.id = p_client_id for update of c;
  if v_owed is null then raise exception 'Client not found.'; end if;
  if v_owed <= 0 then raise exception 'This client does not owe NovaX anything.'; end if;
  if p_amount > v_owed then raise exception 'Payment of % is more than the % they owe.', p_amount, v_owed; end if;

  update clients set wallet_balance = coalesce(wallet_balance,0) + p_amount where id = p_client_id;
  insert into wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_code, note)
  values (p_client_id, 'due_payment', p_amount, true, 'Payment received', 'payment', nullif(v_ref,''),
          'Payment received by NovaX (' || v_meth || coalesce(', ref ' || nullif(v_ref,''), '') || ') towards charges owed.');
  insert into client_due_payments (client_id, amount, method, reference, note, recorded_by, consolidated_at)
  values (p_client_id, p_amount, v_meth, v_ref, coalesce(btrim(p_note), ''), auth.uid(), now());

  select greatest(0, coalesce(s.outstanding,0) - coalesce(c.wallet_balance,0)) into v_owed
    from clients c left join client_dues_summary s on s.client_id = c.id where c.id = p_client_id;
  return coalesce(v_owed, 0);
end $$;

-- "Settle" = record the whole amount owed as received.
create or replace function public.admin_settle_client_dues(p_client_id uuid, p_note text default 'Settled manually by admin')
returns numeric language plpgsql security definer set search_path = public as $$
declare v_owed numeric;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select greatest(0, coalesce(s.outstanding,0) - coalesce(c.wallet_balance,0)) into v_owed
    from clients c left join client_dues_summary s on s.client_id = c.id where c.id = p_client_id;
  if v_owed is null then raise exception 'Client not found.'; end if;
  if v_owed = 0 then return 0; end if;
  return public.admin_record_due_payment(p_client_id, v_owed, 'Settlement', '', coalesce(nullif(btrim(p_note), ''), 'Settled manually by admin'));
end $$;

-- ------------------------------------------------ never collect twice again
-- "Mark Paid To NovaX" on an invoice whose charges are already in the wallet
-- is how Rs 400 was collected twice on INV-260902fe245.
create or replace function public.admin_mark_invoice_paid(p_invoice_id uuid)
returns invoices language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.invoices;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice is null then raise exception 'Invoice not found.'; end if;
  if v_invoice.status in ('Settled', 'Paid to NovaX', 'Cancelled') then
    raise exception 'Invoice % is already closed (%).', v_invoice.code, v_invoice.status;
  end if;
  if coalesce(v_invoice.net_payable, 0) > 0 then
    if v_invoice.status <> 'Pushed to wallet' then
      raise exception 'Invoice % must be pushed to the client wallet before it can be closed as Settled.', v_invoice.code;
    end if;
    update public.invoices set status = 'Settled', settled_at = now() where id = p_invoice_id returning * into v_invoice;
  elsif coalesce(v_invoice.due_to_novax, 0) > 0 then
    if v_invoice.wallet_pushed_at is not null or exists (
         select 1 from public.wallet_ledger l where l.reference_type = 'invoice' and l.reference_id = p_invoice_id
            and l.entry_type = 'invoice_due_debit' and l.affects_balance) then
      raise exception 'Invoice %''s charges were already taken from the merchant''s wallet. There is nothing more to collect on it — record any money received against their balance instead.', v_invoice.code;
    end if;
    if v_invoice.status <> 'Generated' then
      raise exception 'Invoice % is not in a state that can be marked Paid to NovaX.', v_invoice.code;
    end if;
    update public.invoices set status = 'Paid to NovaX', settled_at = now() where id = p_invoice_id returning * into v_invoice;
    insert into public.payment_logs (client_id, type, amount, status, reference)
      values (v_invoice.client_id, 'Delivery charges paid to NovaX', v_invoice.due_to_novax, 'Paid to NovaX', v_invoice.code);
  else
    update public.invoices set status = 'Settled', settled_at = now() where id = p_invoice_id returning * into v_invoice;
  end if;
  return v_invoice;
end $$;

-- The current generator: stamp the invoice when it takes charges from the wallet.
CREATE OR REPLACE FUNCTION public.admin_generate_invoice_v2(p_client_id uuid, p_awbs text[], p_net_returns boolean DEFAULT true)
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, cod_total numeric, fee_total numeric, net_payable numeric, due_to_novax numeric, return_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_conflict_awbs text;
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

  -- P0-001. A parcel that says prepaid AND carries a COD amount was counted in
  -- the prepaid bucket, so its COD never reached cod_total and the merchant was
  -- never credited: exactly how Rs 3,049 vanished on N7810028. Refuse the whole
  -- run and name the parcels, rather than silently choosing one reading of a
  -- contradiction. Blocking is the point -- an invoice, once settled, is not
  -- something a merchant can un-ring.
  select string_agg(p.awb || ' (COD Rs ' || trim(to_char(p.cod_amount,'FM999,999,999'))
                    || ' but marked "' || coalesce(p.meta->>'paymentMode','') || '")', ', ' order by p.awb)
    into v_conflict_awbs
    from public.parcels p
   where p.client_id = p_client_id
     and p.awb = any(p_awbs)
     and p.invoice_id is null
     and public.nv_is_payment_conflict(p.meta->>'paymentMode', p.cod_amount);

  if v_conflict_awbs is not null then
    raise exception
      'Cannot invoice. These parcels carry a COD amount but are marked prepaid: %. Resolve the payment mode or zero the COD first, or the merchant will not be credited for money the rider collects.',
      v_conflict_awbs
      using errcode = 'P0001';
  end if;

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
    -- Everything charged, minus everything collected. The old form only
    -- carried return/prepaid charges into what is owed, so a COD parcel whose
    -- own charge exceeded its COD (Rs 100 collected, Rs 220 charge) produced
    -- Rs 0 due and the Rs 120 shortfall vanished.
    v_due     := greatest(0, (v_cod_fee + v_due_fee) - v_cod_total);
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
      -- one balance: the charge is now in the wallet, so this invoice is not owed separately
      update public.invoices set wallet_pushed_at = now() where id = v_id;
    end if;

    return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                        v_payable, v_due, v_ret_count;
    return;
  end if;

  -- Not netting: single Delivery Charges invoice for the returns/prepaid only.
  v_payable := greatest(0, v_cod_total - v_cod_fee);
  -- Same shortfall rule when returns are not netted.
  v_due     := v_due_fee + greatest(0, v_cod_fee - v_cod_total);
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
      -- one balance: the charge is now in the wallet, so this invoice is not owed separately
      update public.invoices set wallet_pushed_at = now() where id = v_id;
  end if;

  return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                      v_payable, v_due, v_ret_count;
end;
$function$;

-- Grants (same as before: admin functions callable by signed-in users, each
-- re-checks is_admin(); nothing for anon).
revoke all on function public.admin_list_client_dues() from public, anon;
revoke all on function public.admin_list_wallet_balances() from public, anon;
revoke all on function public.admin_record_due_payment(uuid, numeric, text, text, text) from public, anon;
revoke all on function public.admin_settle_client_dues(uuid, text) from public, anon;
revoke all on function public.admin_mark_invoice_paid(uuid) from public, anon;
grant execute on function public.admin_list_client_dues() to authenticated;
grant execute on function public.admin_list_wallet_balances() to authenticated;
grant execute on function public.admin_record_due_payment(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.admin_settle_client_dues(uuid, text) to authenticated;
grant execute on function public.admin_mark_invoice_paid(uuid) to authenticated;
