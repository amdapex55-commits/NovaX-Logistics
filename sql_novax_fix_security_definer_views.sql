-- ============================================================================
-- Advisor CRITICAL x2: SECURITY DEFINER views
--   public.client_dues_summary
--   public.ticket_sla_report
--
-- A SECURITY DEFINER view runs with the PERMISSIONS AND RLS OF ITS CREATOR,
-- not of the person querying it. On this project that means any authenticated
-- merchant who queries client_dues_summary sees EVERY client's dues, not
-- their own -- RLS on the underlying tables is bypassed entirely. Same for
-- ticket_sla_report.
--
-- Postgres 15+ (Supabase is on 15+) supports security_invoker on views, which
-- makes the view respect the CALLER's RLS instead. That is a one-line change
-- per view and does not alter the view's definition or its output for admin.
-- ============================================================================

-- STEP 1 -- see what they are before changing anything.
select table_name, view_definition
from information_schema.views
where table_schema='public'
  and table_name in ('client_dues_summary','ticket_sla_report');

-- STEP 2 -- confirm who can currently reach them. If 'authenticated' or
-- 'anon' appears here, merchants can read across accounts today.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public'
  and table_name in ('client_dues_summary','ticket_sla_report')
order by table_name, grantee;

-- STEP 3 -- make both views respect the caller's row level security.
alter view public.client_dues_summary set (security_invoker = on);
alter view public.ticket_sla_report  set (security_invoker = on);

-- STEP 4 -- admin.html reads these through the admin session, which passes
-- RLS as an admin, so admin output is unchanged. If your RLS policies do NOT
-- yet grant admins access to the underlying tables, the safer alternative is
-- to revoke merchant access entirely instead of step 3:
--
--   revoke all on public.client_dues_summary from anon, authenticated;
--   revoke all on public.ticket_sla_report  from anon, authenticated;
--
-- Use step 3 OR this, not both -- run step 5 first and decide.

-- STEP 5 -- verify. Re-run the Advisor after this; both CRITICALs should clear.
select c.relname as view_name, c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public'
  and c.relname in ('client_dues_summary','ticket_sla_report');
