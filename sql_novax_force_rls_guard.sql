-- ── Root-cause guard for the operations_issues_backup_20260825 incident ──
-- The postgres-owned default privileges were cleared on 2026-08-30, but a
-- SECOND set owned by supabase_admin still grants anon/authenticated
-- arwdDxtm on every FUTURE table in public. The postgres role is not a member
-- of supabase_admin, so those cannot be altered from here.
--
-- This event trigger removes the need to: any table created in public gets RLS
-- enabled and anon revoked automatically, whichever default ACL applied.
-- It never raises, so it can never block a migration or a Supabase upgrade.

create or replace function public.nv_force_rls_on_new_table()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare r record;
begin
  for r in select * from pg_event_trigger_ddl_commands() loop
    begin
      if r.command_tag = 'CREATE TABLE' and r.schema_name = 'public' then
        execute format('alter table %s enable row level security', r.object_identity);
        execute format('revoke all on %s from anon', r.object_identity);
        raise notice 'nv_force_rls: RLS enabled and anon revoked on %', r.object_identity;
      end if;
    exception when others then
      -- never block DDL; a missed table is caught by the RLS coverage check
      raise notice 'nv_force_rls: skipped % (%)', r.object_identity, sqlerrm;
    end;
  end loop;
end $$;

drop event trigger if exists nv_force_rls_trg;
create event trigger nv_force_rls_trg
  on ddl_command_end
  when tag in ('CREATE TABLE')
  execute function public.nv_force_rls_on_new_table();
