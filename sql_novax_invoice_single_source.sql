-- =====================================================================
-- NovaX — make the INVOICE the only source of truth for delivery charges
--
-- THE BUG
--   A prepaid (non-COD) parcel collects no cash, so the merchant owes the
--   delivery fee. Two independent systems were both collecting it:
--
--     1. trg_parcels_post_non_cod_delivery_charge posts the fee to the
--        merchant's wallet as a delivery_charge_due ledger row, and
--     2. the invoice generator nets that same fee inside "charges".
--
--   KKM SWEETS & NIMCO, invoice INV-26082350ad3:
--     3 parcels, Rs 1,775 COD collected - Rs 720 charges = Rs 1,055 payable
--     720 = 200 (N8530001, COD) + 200 (N8530003, prepaid) + 320 (N8530002, prepaid)
--   The invoice had already taken all three. The wallet then took the two
--   prepaid ones AGAIN: 1,055 - 520 = Rs 535. The merchant was short Rs 520.
--
-- THE DECISION
--   The invoice wins. Its statement -- "3 parcels, Rs 1,775 collected minus
--   Rs 720 charges" -- is complete and is what the merchant reads. Fixing it
--   the other way (removing prepaid fees from the invoice) would leave the
--   statement showing 1,775 - 200 = 1,575 with no explanation of the other
--   520. So: the trigger stops, the invoice keeps netting.
--
-- HOW THIS IS SAFE WITHOUT READING THE TRIGGER'S SOURCE
--   Part 2 does not assume what the trigger did. It computes, per client,
--   what the duplicate SHOULD be from the parcels table, and compares it to
--   what the ledger actually holds. Only clients where those two numbers
--   agree are corrected automatically. Anything that disagrees is listed for
--   a human and left untouched.
--
-- RUN PART 0 AND PART 1 FIRST AND READ THEM. They are read-only.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 0 — what the trigger actually does (read-only, for the record)
-- ---------------------------------------------------------------------
select p.proname, pg_get_functiondef(p.oid) as body
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in ('trg_post_non_cod_delivery_charge', 'parcels_guard_columns');


-- ---------------------------------------------------------------------
-- PART 1 — blast radius (read-only). Who was double-charged, and by how much?
--
--   ledger_charged  = what the trigger actually took, per client
--   invoiced_dupes  = fee on non-COD parcels that ALSO sit on an invoice,
--                     i.e. the amount the invoice already collected
--   agrees          = the two reconcile, so the reversal below is exact
--
-- A client with agrees = false is NOT corrected by part 3. Look at them by
-- hand. Do not widen the rule to sweep them in.
-- ---------------------------------------------------------------------
with charged as (
  select l.client_id, sum(l.amount) as ledger_charged
  from public.wallet_ledger l
  where l.entry_type = 'delivery_charge_due'
    and l.affects_balance
  group by l.client_id
),
dupes as (
  select p.client_id, sum(p.fee) as invoiced_dupes, count(*) as parcels
  from public.parcels p
  where p.invoice_id is not null
    and coalesce(p.cod_amount, 0) = 0            -- prepaid: no cash was collected
    and coalesce(p.fee, 0) > 0
  group by p.client_id
),
by_meta as (
  -- Cross-check on how "prepaid" is identified. The query above calls a
  -- parcel prepaid when cod_amount = 0; the booking form records it
  -- explicitly in meta.paymentMode. If these two disagree for a client, the
  -- cod_amount proxy is not safe for them and part 3 should not be trusted
  -- on that row -- look before you run it.
  select p.client_id, sum(p.fee) as by_meta_dupes
  from public.parcels p
  where p.invoice_id is not null
    and coalesce(p.meta ->> 'paymentMode', 'COD') <> 'COD'
    and coalesce(p.fee, 0) > 0
  group by p.client_id
),
led as (
  select l.client_id, sum(l.amount) as ledger_sum
  from public.wallet_ledger l
  where l.affects_balance
  group by l.client_id
),
manual as (
  -- A refund already given by hand through Add to Wallet. Without this, a
  -- client who was already made whole would be paid the same money twice.
  select l.client_id, sum(l.amount) as manual_credits
  from public.wallet_ledger l
  where l.entry_type = 'admin_adjustment'
    and l.affects_balance
    and l.amount > 0
  group by l.client_id
)
select c.name,
       c.wallet_balance,
       coalesce(-charged.ledger_charged, 0) as ledger_charged,
       coalesce(dupes.invoiced_dupes, 0)    as invoiced_dupes,
       coalesce(by_meta.by_meta_dupes, 0)   as same_by_payment_mode,
       coalesce(dupes.parcels, 0)           as prepaid_parcels_on_invoices,
       (coalesce(-charged.ledger_charged, 0) = coalesce(dupes.invoiced_dupes, 0)) as agrees,
       -- Does this client's balance already disagree with their own ledger,
       -- BEFORE anything here runs? Such a client is already payout-blocked
       -- and that is a separate problem this migration does not fix.
       (c.wallet_balance is distinct from coalesce(led.ledger_sum, 0))            as already_mismatched,
       coalesce(manual.manual_credits, 0)                                        as manual_credits_given,
       (coalesce(manual.manual_credits, 0) >= coalesce(dupes.invoiced_dupes, 0)
        and coalesce(dupes.invoiced_dupes, 0) > 0)                               as already_refunded_by_hand
from public.clients c
left join charged on charged.client_id = c.id
left join dupes   on dupes.client_id   = c.id
left join by_meta on by_meta.client_id = c.id
left join led     on led.client_id     = c.id
left join manual  on manual.client_id  = c.id
where charged.client_id is not null or dupes.client_id is not null
order by coalesce(dupes.invoiced_dupes, 0) desc;


-- ---------------------------------------------------------------------
-- PART 2 — stop the double charge
--
-- The trigger is dropped, not the function. Recreating it is one statement
-- if this turns out to be wrong:
--
--   create trigger trg_parcels_post_non_cod_delivery_charge
--     before insert or update on public.parcels
--     for each row execute function public.trg_post_non_cod_delivery_charge();
--
-- From here the invoice generator is the ONLY thing that charges for a
-- delivery. A prepaid parcel that has been delivered but not yet invoiced
-- carries no wallet charge until its invoice is generated -- which is what
-- the merchant's "Being counted / delivered, not released yet" figure is for.
-- ---------------------------------------------------------------------
drop trigger if exists trg_parcels_post_non_cod_delivery_charge on public.parcels;


-- ---------------------------------------------------------------------
-- PART 3 — give back what was taken twice
--
-- Writes ONE admin_adjustment per affected client, and moves wallet_balance
-- by the same amount in the same transaction, so clients.wallet_balance
-- still equals the sum of that client's affects_balance ledger rows. Break
-- that and computeWalletReconciliation() flags the client as mismatched and
-- BLOCKS their payouts.
--
-- A client is corrected ONLY when all four hold:
--   agrees = true                (ledger matches what the parcels say)
--   same_by_payment_mode matches (both definitions of prepaid agree)
--   already_mismatched = false   (their books balance before we start)
--   already_refunded_by_hand = false (you have not already paid it manually)
--   no existing refund row       (so re-running changes nothing)
-- Everything else is reported by part 1 and deliberately left alone.
-- Re-running this is a no-op: the guard skips any client that already has a
-- refund row carrying this exact reference_code.
-- ---------------------------------------------------------------------
do $$
declare
  r        record;
  v_ref    text := 'DUPFEE-REFUND-2026-08';
  v_count  int  := 0;
  v_total  numeric := 0;
begin
  for r in
    with charged as (
      select l.client_id, sum(l.amount) as ledger_charged
      from public.wallet_ledger l
      where l.entry_type = 'delivery_charge_due' and l.affects_balance
      group by l.client_id
    ),
    dupes as (
      select p.client_id, sum(p.fee) as invoiced_dupes
      from public.parcels p
      where p.invoice_id is not null
        and coalesce(p.cod_amount, 0) = 0
        and coalesce(p.fee, 0) > 0
      group by p.client_id
    ),
    by_meta as (
      select p.client_id, sum(p.fee) as by_meta_dupes
      from public.parcels p
      where p.invoice_id is not null
        and coalesce(p.meta ->> 'paymentMode', 'COD') <> 'COD'
        and coalesce(p.fee, 0) > 0
      group by p.client_id
    ),
    led as (
      select l.client_id, sum(l.amount) as ledger_sum
      from public.wallet_ledger l
      where l.affects_balance
      group by l.client_id
    ),
    manual as (
      select l.client_id, sum(l.amount) as manual_credits
      from public.wallet_ledger l
      where l.entry_type = 'admin_adjustment'
        and l.affects_balance
        and l.amount > 0
      group by l.client_id
    )
    select d.client_id, d.invoiced_dupes as amount
    from dupes d
    join charged c   on c.client_id = d.client_id
    join public.clients cl on cl.id = d.client_id
    left join by_meta m on m.client_id = d.client_id
    left join led on led.client_id = d.client_id
    left join manual mn on mn.client_id = d.client_id
    where -c.ledger_charged = d.invoiced_dupes      -- the ledger and the parcels agree
      and d.invoiced_dupes > 0
      -- Both definitions of "prepaid" must agree. cod_amount = 0 is a proxy;
      -- meta.paymentMode is what the merchant actually chose at booking. A COD
      -- parcel that happened to collect Rs 0 satisfies the proxy and is NOT a
      -- prepaid duplicate, so a client where these diverge is left for a human.
      and coalesce(m.by_meta_dupes, 0) = d.invoiced_dupes
      -- Never adjust a client whose balance already disagrees with their own
      -- ledger. They are payout-blocked for a reason that predates this fix,
      -- and moving their balance again buries the original cause.
      and cl.wallet_balance is not distinct from coalesce(led.ledger_sum, 0)
      -- Already refunded by hand through the Add to Wallet tab. Paying it
      -- again would hand the merchant the same money a second time, which is
      -- the mirror image of the bug this file exists to fix.
      and coalesce(mn.manual_credits, 0) < d.invoiced_dupes
      and not exists (
        select 1 from public.wallet_ledger x
        where x.client_id = d.client_id
          and x.reference_code = v_ref
      )
  loop
    insert into public.wallet_ledger
      (client_id, entry_type, amount, affects_balance, reference_type, reference_code, note)
    values
      (r.client_id, 'admin_adjustment', r.amount, true, 'admin_adjustment', v_ref,
       'Refund of delivery charges collected twice: once by the wallet at delivery, once inside the invoice. The invoice is now the only source of truth.');

    update public.clients
       set wallet_balance = coalesce(wallet_balance, 0) + r.amount
     where id = r.client_id;

    v_count := v_count + 1;
    v_total := v_total + r.amount;
  end loop;

  raise notice 'Refunded % client(s), Rs % returned in total.', v_count, v_total;
end
$$;


-- ---------------------------------------------------------------------
-- PART 4 — verify (read-only)
-- ---------------------------------------------------------------------
-- The trigger must be gone:
--   select tgname from pg_trigger
--    where tgrelid = 'public.parcels'::regclass
--      and tgname = 'trg_parcels_post_non_cod_delivery_charge';
--   -> expect zero rows
--
-- Every client's balance must equal their ledger. Compare this against the
-- already_mismatched column from part 1: a client who was ALREADY mismatched
-- before this ran is a pre-existing problem, not damage from this migration,
-- and part 3 deliberately did not touch them. A client who was clean in part
-- 1 and appears here is a real regression -- stop and say so.
--
--   select c.name, c.wallet_balance,
--          (select coalesce(sum(l.amount),0) from public.wallet_ledger l
--            where l.client_id = c.id and l.affects_balance) as ledger_sum
--   from public.clients c
--   where c.wallet_balance is distinct from
--         (select coalesce(sum(l.amount),0) from public.wallet_ledger l
--           where l.client_id = c.id and l.affects_balance);
--   -> expect zero rows
--
-- And KKM specifically should be whole again (1,055, not 535):
--   select name, wallet_balance from public.clients where name ilike '%KKM%';
