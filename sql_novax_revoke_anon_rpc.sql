-- Defence in depth: anon must not be able to CALL admin_*/client_* RPCs.
-- All were verified internally guarded (is_admin/is_staff_admin/my_client_id/auth.uid),
-- and no unauthenticated page calls any of them (verified 2026-08-30).
--
-- NOTE: many were granted to PUBLIC, not to anon directly, so REVOKE ... FROM anon
-- is a no-op for those. We revoke from PUBLIC and then grant explicitly to the
-- roles that genuinely need them, so the admin and client portals keep working.
-- client_delivery_estimate is excluded on purpose (public quote calculator).
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prosecdef
      and (p.proname like 'client\_%' or p.proname like 'admin\_%')
      and p.proname <> 'client_delivery_estimate'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon',   r.sig);
    execute format('grant  execute on function %s to authenticated', r.sig);
    execute format('grant  execute on function %s to service_role',  r.sig);
    n := n + 1;
  end loop;
  raise notice 'locked % security-definer RPC(s) to authenticated/service_role', n;
end $$;
