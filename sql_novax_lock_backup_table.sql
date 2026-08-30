-- ===========================================================================
-- CRITICAL: operations_issues_backup_20260825 was world-readable AND writable
-- 30 Aug 2026
--
-- The table kept the permissive grants it inherited when it was created as a
-- backup during the operations_issues cleanup. RLS was never enabled on it and
-- anon/authenticated held SELECT, INSERT, UPDATE, DELETE and TRUNCATE.
--
-- Demonstrated live before this fix, using only the publishable key that ships
-- in the page source:
--   GET /rest/v1/operations_issues_backup_20260825?select=*  ->  HTTP 200
--
-- 413,182 rows. 79 MB. 395 distinct AWBs. 14,682 rows whose meta matches
-- customer PII patterns (phone / consignee / address). And because DELETE and
-- TRUNCATE were granted too, anyone on the internet could have emptied it.
--
-- It is the only table in the schema in this state. Nothing reads it: no
-- application code, no function, no view -- only the cleanup script that
-- created it. So it can be locked with no behavioural change anywhere.
-- ===========================================================================

revoke all on public.operations_issues_backup_20260825 from anon, authenticated, public;
alter table public.operations_issues_backup_20260825 enable row level security;
-- No policy is created on purpose: with RLS on and no policy, only the service
-- role reaches it. A backup should be restorable, not queryable.
