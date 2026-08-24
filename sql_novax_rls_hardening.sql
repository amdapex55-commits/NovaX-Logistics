-- ============================================================================
-- NovaX -- RLS hardening
--
-- Written from a live pg_policies export on 2026-08-22, not from guesswork.
-- Three real holes, each verified against the exported policy set. Safe to
-- re-run; every statement is idempotent.
--
-- VERIFIED SAFE, no change needed (recorded so nobody re-audits them):
--   * admin_mark_withdrawal_paid does `select ... for update` before checking
--     status, inside the same transaction as the update. Two concurrent admins
--     cannot double-pay: the second blocks on the lock, re-reads the committed
--     row, sees 'Paid' and raises. The audit flagged this as unverified; it is
--     now verified correct.
--   * withdrawals and wallet_ledger have rowsecurity = true and NO policies,
--     so direct access is denied outright and everything goes through
--     SECURITY DEFINER RPCs. That is the strongest configuration, not a gap.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. novax_state was world-readable AND world-writable
--
--    Policy was:  novax_anon_all | ALL | {public} | USING(true) | CHECK(true)
--
--    No condition at all, and {public} includes anon. Anyone holding the
--    publishable key -- which is printed in the source of every page -- could
--    read, rewrite or delete that row without logging in.
--
--    It is not empty. The single row still holds a legacy state blob
--    containing staff records: names, emails and roles. reset.html correctly
--    describes the table as legacy and no portal reads it for live data, but
--    stale PII exposed to the internet is still exposed PII.
--
--    Locked to admin. The table is left in place because reset.html still
--    references it and dropping it is irreversible -- clear the row from that
--    page if you want the old data gone as well.
-- ----------------------------------------------------------------------------
drop policy if exists novax_anon_all on public.novax_state;

drop policy if exists novax_state_admin_all on public.novax_state;
create policy novax_state_admin_all on public.novax_state
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ----------------------------------------------------------------------------
-- 2. Two visitor_sessions policies did not do what their names claimed
--
--    "Anyone can update their own visitor heartbeat"
--        UPDATE | {anon} | USING(true) | CHECK(true)
--      -> any anonymous caller could update ANY row, not their own.
--
--    "Only signed-in staff can read visitor sessions"
--        SELECT | {authenticated} | USING(true)
--      -> every authenticated user, including every merchant and every rider,
--         could read the full visitor table. Not staff-only in any sense.
--
--    Heartbeat writes stay open because they are genuinely anonymous, but a
--    session may now only update its own row. Reads become admin-only; the
--    duplicate admin_read_visitor_sessions policy already covered that case
--    correctly, so nothing legitimate loses access.
-- ----------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='visitor_sessions'
                and column_name='session_id') then

    drop policy if exists "Anyone can update their own visitor heartbeat" on public.visitor_sessions;
    execute $p$
      create policy "Anyone can update their own visitor heartbeat"
        on public.visitor_sessions for update to anon
        using (session_id = current_setting('request.headers', true)::json->>'x-visitor-session')
        with check (session_id = current_setting('request.headers', true)::json->>'x-visitor-session')
    $p$;
  else
    -- No session_id column to scope on. Rather than guess at a column name,
    -- remove the write-anything policy entirely: an anon UPDATE that can
    -- rewrite any row is worse than no anon UPDATE at all.
    drop policy if exists "Anyone can update their own visitor heartbeat" on public.visitor_sessions;
  end if;
end
$do$;

drop policy if exists "Only signed-in staff can read visitor sessions" on public.visitor_sessions;


-- ----------------------------------------------------------------------------
-- 3. A merchant could rewrite the fee on their own parcels
--
--    Policy parcels_client_upd correctly scopes UPDATE to the merchant's own
--    rows -- but says nothing about WHICH COLUMNS. So a merchant with devtools
--    and the publishable key could run, against their own parcels:
--
--        update parcels set fee = 0 where client_id = <mine>;
--
--    and pay nothing for delivery, with no audit trail anywhere.
--
--    Column-level restriction is not expressible in an RLS policy, so this is
--    a trigger. It deliberately allows what the merchant portal genuinely
--    writes -- status, exception, awbPrinted/awbPrintedAt via meta -- and the
--    rider app's own status/meta updates, while freezing the money columns
--    and the ownership columns against everyone except an admin.
-- ----------------------------------------------------------------------------
create or replace function public.nv_freeze_parcel_money()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

drop trigger if exists trg_nv_freeze_parcel_money on public.parcels;
create trigger trg_nv_freeze_parcel_money
  before update on public.parcels
  for each row execute function public.nv_freeze_parcel_money();


-- ----------------------------------------------------------------------------
-- 4. OPTIONAL -- duplicate policy cleanup. Left commented ON PURPOSE.
--
--    cod_ledger carries three identical admin-all policies and scans carries
--    six policies covering four distinct rules. RLS is permissive, so
--    duplicates simply OR together and change nothing functionally -- this is
--    readability, not security, and dropping live policies for tidiness is not
--    worth any risk to a working system. Run these deliberately, one at a
--    time, if you want the noise gone.
--
-- drop policy if exists "admin all cod_ledger"   on public.cod_ledger;
-- drop policy if exists "cod_admin_all"          on public.cod_ledger;
-- --  keep cod_ledger_admin_all
-- drop policy if exists "rider insert own cod_ledger" on public.cod_ledger;
-- drop policy if exists "rider read own cod_ledger"   on public.cod_ledger;
-- --  keep cod_rider_ins / cod_rider_read
-- drop policy if exists "admin all scans"        on public.scans;
-- drop policy if exists "rider insert own scans" on public.scans;
-- drop policy if exists "rider read own scans"   on public.scans;
-- --  keep scans_admin_all / scans_rider_ins / scans_rider_read / scans_scoped_read


-- ----------------------------------------------------------------------------
-- 5. Verify
-- ----------------------------------------------------------------------------
-- Expect exactly one novax_state policy, admin-scoped:
--   select policyname, cmd, roles::text, qual::text from pg_policies
--    where tablename='novax_state';
--
-- Expect no policy whose qual is a bare true on visitor_sessions:
--   select policyname, cmd, roles::text, qual::text from pg_policies
--    where tablename='visitor_sessions';
--
-- Expect the trigger to exist:
--   select tgname from pg_trigger where tgname='trg_nv_freeze_parcel_money';
--
-- Then, as a MERCHANT (not admin), this must now fail:
--   update parcels set fee = 0 where awb = '<one of your own>';
--
-- ...and so must a raw COD rewrite, even on your own New booked parcel,
-- because a plain UPDATE never sets the novax.parcel_edit flag:
--   update parcels set cod_amount = 1 where awb = '<one of your own>';
--
-- ...while the supported path must still succeed (see
-- sql_novax_client_edit_parcel.sql):
--   select public.client_edit_new_booked_parcel('<your New booked awb>', ...);
