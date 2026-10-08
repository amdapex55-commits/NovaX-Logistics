-- Nova Recover: how to take it back out (written 8 Oct 2026, before it was applied).
-- Run only if Nova Recover has to be removed from the live database. It puts
-- back the two things the install changed outside its own tables, then drops
-- everything of its own. Recovered orders, their fees in wallet_ledger and
-- the parcels' meta.recover marks are real history and are NOT touched.
-- Close the switches first (Settings > Merchant tab > Off) and ship the pages
-- without the tab, or the portal will ask for functions that are gone.
begin;
set local lock_timeout = '5s';
drop trigger if exists nv_recover_email_refused on public.parcels;
drop trigger if exists nv_recover_email_won on public.nv_recover_cases;
-- 1. The money guard exactly as it was before Nova Recover.
CREATE OR REPLACE FUNCTION public.nv_freeze_parcel_money()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Admins and any SECURITY DEFINER booking RPC running as the owner are
  -- unaffected; this exists to stop a browser writing to these columns.
  if public.is_admin() then
    return new;
  end if;

  if new.fee is distinct from old.fee then
    raise exception 'Delivery fee cannot be changed from the portal. Contact NovaX support if it is wrong.';
  end if;
  -- COD is editable in exactly one situation: the merchant is fixing their
  -- own booking through client_edit_new_booked_parcel(), which has already
  -- re-checked ownership, status, invoicing and rider assignment, and which
  -- sets this transaction-local flag immediately before its UPDATE.
  --
  -- A browser cannot forge this. set_config(..., true) is scoped to the
  -- transaction, and the only statement that sets it lives inside a
  -- SECURITY DEFINER function the merchant cannot modify. The status
  -- re-check below is deliberately redundant with the one in that function:
  -- if a future caller ever sets the flag without checking, COD still
  -- cannot be rewritten on a parcel that has already moved.
  if new.cod_amount is distinct from old.cod_amount then
    if coalesce(current_setting('novax.parcel_edit', true), '') <> '1'
       or coalesce(old.status, '') <> 'New booked' then
      raise exception 'COD amount cannot be changed after booking. Contact NovaX support if it is wrong.';
    end if;
  end if;
  if new.client_id is distinct from old.client_id then
    raise exception 'A parcel cannot be moved to another merchant.';
  end if;

  return new;
end
$function$
;
-- 2. The email kinds exactly as they were.
alter table public.nv_email_queue drop constraint nv_email_queue_kind_check, add constraint nv_email_queue_kind_check CHECK ((kind = ANY (ARRAY['welcome'::text, 'first_booking'::text, 'payout_paid'::text, 'cnic_verified'::text, 'cnic_rejected'::text, 'first_parcel_d1'::text, 'first_parcel_d3'::text, 'first_parcel_d7'::text, 'back_quiet'::text, 'back_tried'::text, 'setup_ready'::text])));
delete from public.nv_email_queue where kind in ('recover_refused', 'recover_won', 'recover_launch') and state <> 'accepted';
-- 3. Nova Recover's own functions and tables.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname like 'client\_recover\_%' or p.proname like 'cs\_recover\_%' or p.proname like 'nv\_recover\_%') loop
    execute 'drop function if exists ' || r.f || ' cascade';
  end loop; end $$;
drop table if exists public.nv_recover_calls, public.nv_recover_cases, public.nv_recover_accept, public.nv_recover_config;
drop sequence if exists public.nv_recover_code_seq;
commit;
