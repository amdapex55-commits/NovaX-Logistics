-- ── Root-cause guard for the operations_issues_backup_20260825 incident ──
-- The postgres-owned default privileges were cleared on 2026-08-30, but a
-- SECOND set owned by supabase_admin still grants anon/authenticated arwdDxtm
-- on every FUTURE table in public. postgres is NOT a member of supabase_admin,
-- so "alter default privileges for role supabase_admin" fails with
-- "permission denied to change default privileges". It cannot be fixed here.
--
-- This event trigger makes it harmless instead: anything created in public gets
-- RLS enabled and anon revoked automatically.
--
-- IMPORTANT: it must cover CREATE TABLE AS and SELECT INTO, not just
-- CREATE TABLE. The 2026-08-25 leak was a `create table ... as select ...`
-- backup, which carries the command tag 'CREATE TABLE AS' and was missed by the
-- first version of this trigger.
--
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
      if r.schema_name = 'public' and r.object_type in ('table', 'materialized view') then
        if r.object_type = 'table' then
          execute format('alter table %s enable row level security', r.object_identity);
        end if;
        execute format('revoke all on %s from anon', r.object_identity);
        raise notice 'nv_force_rls: secured % (%)', r.object_identity, r.command_tag;
      end if;
    exception when others then
      -- never block DDL; the RLS coverage check catches anything missed
      raise notice 'nv_force_rls: skipped % (%)', r.object_identity, sqlerrm;
    end;
  end loop;
end $$;

drop event trigger if exists nv_force_rls_trg;
create event trigger nv_force_rls_trg
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE MATERIALIZED VIEW')
  execute function public.nv_force_rls_on_new_table();
