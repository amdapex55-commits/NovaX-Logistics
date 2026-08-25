-- NovaX: stop the operations_issues insert spiral for good.
--
-- WHY THIS IS STILL HAPPENING AFTER THE ADMIN.HTML FIX (commit 53dbbe8)
--
-- That fix was correct but it can never engage while the table is this big.
-- The admin dashboard loads the table with:
--     select * from operations_issues order by created_at desc limit 2000
-- under RLS policy "staff manage operations_issues" USING (is_staff_admin()).
-- is_staff_admin() is marked PARALLEL UNSAFE, so the planner cannot
-- parallelise, and with no index on created_at it seq-scans and evaluates the
-- policy once per row -- 412,000 times. Measured on production: 4.7 seconds.
-- That is at or past the PostgREST statement timeout, so the load
-- intermittently returns NO rows. Supabase's client surfaces that as
-- { data: null }, and admin.html's D(i) helper turns null into [].
--
-- So state.operationsIssues is EMPTY, the dedupe has nothing to compare
-- against, and all 298 live issues are re-inserted. Proof: every burst's
-- meta.localId restarts at OPS-0001 and runs to OPS-0298. nextId() only
-- produces OPS-0001 when the array it is counting is empty.
--
-- The bloat is now its own cause: more rows -> slower query -> more timeouts
-- -> more inserts. Deleting the junk is what breaks the loop.
--
-- SAFE TO RUN: nothing server-side reads or writes this table (no function,
-- no trigger except the blank-overwrite guard). Only the admin browser tab
-- touches it. Every distinct issue is kept -- newest copy of each.

begin;

-- 1. Snapshot before touching anything. Survives even if step 2 surprises us.
create table if not exists operations_issues_backup_20260825 as
  select * from operations_issues;

-- 2. Keep the newest copy of each distinct (problem, awb). 412,786 -> 779.
--    Anything resolved is kept regardless: resolution history is real data.
delete from operations_issues oi
where not oi.resolved
  and oi.id not in (
    select distinct on (problem, awb) id
    from operations_issues
    where not resolved
    order by problem, awb, created_at desc
  );

-- 3. The index the dashboard's ORDER BY has always needed.
create index if not exists operations_issues_created_at_idx
  on operations_issues (created_at desc);

-- 4. Structural backstop, so this cannot come back even if the browser is
--    running stale code. One unresolved row per problem+awb, enforced by the
--    database. admin.html's syncEntity() already handles a duplicate-key
--    rejection gracefully -- isDuplicateKeyError() routes it to
--    adoptExistingRow(), which links the local row to the existing server row
--    instead of retrying. So the failure mode here is "correct behaviour",
--    not an error storm.
create unique index if not exists operations_issues_open_unique
  on operations_issues (problem, awb)
  where not resolved;

commit;

-- 5. Reclaim the disk. Must run OUTSIDE the transaction above -- run this
--    line on its own after the commit succeeds.
-- vacuum full analyze operations_issues;

-- VERIFY
select 'rows now'          as check, count(*)::text as value from operations_issues
union all
select 'distinct open',    count(distinct (problem, awb))::text from operations_issues where not resolved
union all
select 'backup rows',      count(*)::text from operations_issues_backup_20260825
union all
select 'size',             pg_size_pretty(pg_total_relation_size('operations_issues'));
