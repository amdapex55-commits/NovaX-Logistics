begin;

-- NovaX security batch 3, 10 Sep 2026 (night audit). Grants only; no data or
-- function bodies change.

-- nvsh_book_parcel booked a parcel onto whichever merchant owns a linked,
-- active Shopify shop, given only the shop's domain -- and PUBLIC could
-- execute it. The Shopify edge function calls it with the service role.
--
-- The rest are internal: API health across every merchant (names, key
-- prefixes, call and booking volumes), business and infrastructure reports,
-- health/backup writers, and the SLA tick that files tickets. Any signed-in
-- merchant could run them. cron runs as the owner and the API edge function
-- uses the service role, so neither is affected.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('nvsh_book_parcel','admin_api_health','admin_api_silent_keys',
              'nv_health_report','nv_outreach_report','nv_backup_verify','nv_health_take','nv_backup_beat','sla_enforce_tick')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

commit;
