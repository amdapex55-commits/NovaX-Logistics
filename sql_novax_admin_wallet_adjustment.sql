-- =====================================================================
-- NovaX — admin_wallet_adjustment()
--
-- ONLY RUN PART 2 IF PART 1 RETURNS NO ROWS.
--
-- admin.html has called this function since Wallet Ledger v1. It may
-- already be deployed and working. If it is, DO NOT run part 2 -- a
-- CREATE OR REPLACE would overwrite a working money function with this
-- reconstruction, which is exactly the class of mistake that took
-- bookings down on 2026-08-22.
--
-- The "Add to Wallet" tab in admin tells you which case you are in: if
-- it says "not deployed on this database yet", run part 2.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1 — does it already exist? (read-only)
-- ---------------------------------------------------------------------
select p.oid::regprocedure as existing_signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_wallet_adjustment';
-- Rows returned  -> STOP. It exists. Nothing else to run.
-- No rows        -> continue to part 2.


-- ---------------------------------------------------------------------
-- PART 2 — only if part 1 was empty
--
-- WHY IT WRITES TWO THINGS
--   clients.wallet_balance must always equal the sum of that client's
--   wallet_ledger rows where affects_balance is true.
--   computeWalletReconciliation() in admin.html checks exactly that, and
--   flags any client who drifts as "mismatched" -- which BLOCKS their
--   payouts. So a balance update without a matching ledger row would
--   credit a merchant and simultaneously lock them out of withdrawing
--   it. Both writes happen here, in one transaction, or neither does.
-- ---------------------------------------------------------------------
create or replace function public.admin_wallet_adjustment(
  p_client_id uuid,
  p_amount    numeric,
  p_note      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name text;
  v_new  numeric;
  v_id   uuid;
begin
  if not public.is_admin() then
    raise exception 'Only NovaX admins can adjust a client wallet.' using errcode = '42501';
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'Enter an adjustment amount other than zero.' using errcode = 'P0001';
  end if;

  -- An unexplained movement of a merchant's money is not acceptable, so the
  -- note is enforced here and not only in the browser.
  if btrim(coalesce(p_note, '')) = '' then
    raise exception 'A reason is required for every wallet adjustment.' using errcode = 'P0001';
  end if;

  select name into v_name from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'That client does not exist.' using errcode = 'P0002';
  end if;

  insert into public.wallet_ledger
    (client_id, entry_type, amount, affects_balance, reference_type, reference_code, note)
  values
    (p_client_id, 'admin_adjustment', p_amount, true, 'admin_adjustment',
     to_char(now() at time zone 'Asia/Karachi', 'YYYYMMDDHH24MISS'), btrim(p_note))
  returning id into v_id;

  update public.clients
     set wallet_balance = coalesce(wallet_balance, 0) + p_amount
   where id = p_client_id
  returning wallet_balance into v_new;

  return jsonb_build_object('ok', true, 'ledger_id', v_id,
                            'client', v_name, 'new_balance', v_new);
end
$fn$;

revoke all on function public.admin_wallet_adjustment(uuid, numeric, text) from public;
grant execute on function public.admin_wallet_adjustment(uuid, numeric, text) to authenticated;


-- ---------------------------------------------------------------------
-- PART 3 — verify (read-only)
-- ---------------------------------------------------------------------
-- Exactly one signature, and the balance agrees with the ledger:
--
--   select p.oid::regprocedure from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname='public' and p.proname='admin_wallet_adjustment';
--
--   select c.name, c.wallet_balance,
--          (select coalesce(sum(l.amount),0) from public.wallet_ledger l
--            where l.client_id = c.id and l.affects_balance) as ledger_sum
--   from public.clients c where c.name ilike '%KKM%';
--
-- Those two numbers must match. If they do not, do not adjust anything
-- until the gap is explained.
