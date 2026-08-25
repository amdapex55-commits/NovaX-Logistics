-- NovaX health monitor.
--
-- Nothing was watching this database. The operations_issues loop ran for
-- weeks, reached 412,000 rows, and became most of the write load and the
-- 11.6% rollback rate before anyone looked. The SLA cron burned 25M writes a
-- day against a column that does not exist. 86,814 junk tickets accumulated.
-- Every one was found by hand, late.
--
-- This takes one snapshot a night and reports only what actually moved.
-- No LLM anywhere in it: nv_health_report() is plain SQL comparing the two
-- most recent snapshots. One row per night is 365 rows a year -- this must
-- not become the thing it was built to catch.

create table if not exists public.nv_health_snapshot(
  id       bigserial primary key,
  taken_at timestamptz not null default now(),
  metrics  jsonb       not null
);

create index if not exists nv_health_snapshot_taken_at_idx
  on public.nv_health_snapshot (taken_at desc);

alter table public.nv_health_snapshot enable row level security;

drop policy if exists "staff read health" on public.nv_health_snapshot;
create policy "staff read health" on public.nv_health_snapshot
  for select to authenticated using (public.is_staff_admin());

-- ── Take a snapshot ──────────────────────────────────────────────────────
create or replace function public.nv_health_take()
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_metrics jsonb;
  v_id      bigint;
begin
  select jsonb_build_object(
    'tables', (
      select jsonb_object_agg(relname, jsonb_build_object(
               'rows',      n_live_tup,
               'dead',      n_dead_tup,
               'bytes',     pg_total_relation_size(relid),
               'ins',       n_tup_ins,
               'upd',       n_tup_upd,
               'del',       n_tup_del))
      from pg_stat_user_tables
      where schemaname = 'public'
    ),
    'archiver', (
      select jsonb_build_object(
               'archived',           archived_count,
               'failed',             failed_count,
               'last_archived_time', last_archived_time,
               'last_failed_wal',    last_failed_wal)
      from pg_stat_archiver
    ),
    'db', (
      select jsonb_build_object(
               'commits',   xact_commit,
               'rollbacks', xact_rollback,
               'size',      pg_database_size(current_database()))
      from pg_stat_database where datname = current_database()
    ),
    -- Money. The KKM SWEETS bug was a wallet balance that did not match its
    -- own ledger. affects_balance is the flag the ledger itself uses to
    -- decide what counts, so this is the ledger's own arithmetic, checked
    -- against the denormalised column the portal actually displays.
    'wallet_mismatches', (
      with led as (
        select client_id, sum(amount) as bal
        from wallet_ledger where affects_balance group by client_id
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'client', c.name,
               'stored', coalesce(c.wallet_balance,0),
               'ledger', coalesce(l.bal,0))), '[]'::jsonb)
      from clients c left join led l on l.client_id = c.id
      where abs(coalesce(c.wallet_balance,0) - coalesce(l.bal,0)) > 0.01
    ),
    -- Delivered, money collected, never billed. Silent revenue loss.
    'delivered_uninvoiced', (
      select count(*) from parcels
      where status = 'Delivered' and invoice_id is null
        and delivered_at < now() - interval '7 days'
    ),
    -- Should be structurally impossible now (partial unique index), but if
    -- the index is ever dropped this catches the regression on night one.
    'ops_issue_dupes', (
      select count(*) from (
        select problem, awb from operations_issues
        where not resolved group by problem, awb having count(*) > 1
      ) t
    )
  ) into v_metrics;

  insert into public.nv_health_snapshot(metrics) values (v_metrics) returning id into v_id;

  -- Keep 400 nights. Never let the watchdog become the problem.
  delete from public.nv_health_snapshot
  where id < (select max(id) - 400 from public.nv_health_snapshot);

  return v_id;
end;
$$;

-- ── Report only what moved ───────────────────────────────────────────────
create or replace function public.nv_health_report()
returns table(severity text, check_name text, detail text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  cur  jsonb;
  prev jsonb;
  cur_at timestamptz;
  hours numeric;
  r record;
begin
  select metrics, taken_at into cur, cur_at
  from nv_health_snapshot order by id desc limit 1;

  if cur is null then
    return query select 'info'::text, 'no data'::text,
      'nv_health_take() has never run.'::text;
    return;
  end if;

  select metrics into prev
  from nv_health_snapshot order by id desc offset 1 limit 1;

  -- 1. WAL archiving. archive_timeout is 120s, so a segment is forced every
  --    two minutes even when idle. Anything past 30 minutes means PITR has
  --    a hole and the backup is not what it claims to be.
  if (cur->'archiver'->>'last_archived_time') is not null then
    hours := extract(epoch from (now() - (cur->'archiver'->>'last_archived_time')::timestamptz)) / 60.0;
    if hours > 30 then
      return query select 'critical'::text, 'wal archiving stalled'::text,
        format('Last WAL archived %s minutes ago. Point-in-time recovery is behind by that much.',
               round(hours));
    end if;
  else
    return query select 'critical'::text, 'wal archiving'::text,
      'pg_stat_archiver reports no successful archive at all.'::text;
  end if;

  if coalesce((cur->'archiver'->>'failed')::bigint,0)
     > coalesce((prev->'archiver'->>'failed')::bigint,0) then
    return query select 'critical'::text, 'wal archive failures'::text,
      format('%s new failed WAL pushes since the last snapshot (last failed: %s).',
             (cur->'archiver'->>'failed')::bigint - coalesce((prev->'archiver'->>'failed')::bigint,0),
             coalesce(cur->'archiver'->>'last_failed_wal','?'));
  end if;

  -- 2. Wallet balances that disagree with their own ledger.
  if jsonb_array_length(cur->'wallet_mismatches') > 0 then
    return query select 'critical'::text, 'wallet vs ledger'::text,
      format('%s client wallet(s) disagree with the ledger: %s',
             jsonb_array_length(cur->'wallet_mismatches'),
             cur->>'wallet_mismatches');
  end if;

  -- 3. Delivered, collected, never billed.
  if coalesce((cur->>'delivered_uninvoiced')::bigint,0) > 0 then
    return query select 'warning'::text, 'delivered but uninvoiced'::text,
      format('%s parcel(s) delivered more than 7 days ago with no invoice.',
             (cur->>'delivered_uninvoiced')::bigint);
  end if;

  if coalesce((cur->>'ops_issue_dupes')::bigint,0) > 0 then
    return query select 'critical'::text, 'ops issue duplicates'::text,
      format('%s duplicated open operations_issues. The partial unique index is gone.',
             (cur->>'ops_issue_dupes')::bigint);
  end if;

  -- 4. Runaway table growth. This is the operations_issues signature: a table
  --    growing far faster than parcels, which is the only table that SHOULD
  --    grow with the business.
  if prev is not null then
    for r in
      select key as tbl,
             (value->>'rows')::bigint  as rows_now,
             ((prev->'tables'->key)->>'rows')::bigint as rows_prev,
             (value->>'bytes')::bigint as bytes_now
      from jsonb_each(cur->'tables')
      where prev->'tables' ? key
    loop
      if r.rows_prev is not null and r.rows_now - r.rows_prev > 10000
         and r.rows_now > r.rows_prev * 1.25 then
        return query select 'warning'::text, 'table growing fast'::text,
          format('%s grew from %s to %s rows (%s) since the last snapshot.',
                 r.tbl, r.rows_prev, r.rows_now, pg_size_pretty(r.bytes_now));
      end if;
    end loop;
  end if;

  -- 5. Bloat. A table more dead than alive means writes are being rolled
  --    back or churned -- how the 513M phantom parcel updates showed up.
  for r in
    select key as tbl, (value->>'rows')::bigint rows_now, (value->>'dead')::bigint dead
    from jsonb_each(cur->'tables')
  loop
    if r.dead > 50000 and r.dead > r.rows_now then
      return query select 'warning'::text, 'dead rows exceed live'::text,
        format('%s has %s dead rows against %s live. Something is writing and rolling back.',
               r.tbl, r.dead, r.rows_now);
    end if;
  end loop;

  -- 6. Rollback ratio over the interval, not lifetime -- a bad afternoon
  --    should not be hidden by a good month.
  if prev is not null then
    declare
      dc bigint := (cur->'db'->>'commits')::bigint   - (prev->'db'->>'commits')::bigint;
      dr bigint := (cur->'db'->>'rollbacks')::bigint - (prev->'db'->>'rollbacks')::bigint;
    begin
      if dc + dr > 1000 and dr::numeric / (dc + dr) > 0.05 then
        return query select 'warning'::text, 'transactions rolling back'::text,
          format('%s%% of transactions rolled back since the last snapshot (%s of %s).',
                 round(100.0 * dr / (dc + dr), 1), dr, dc + dr);
      end if;
    end;
  end if;

  return;
end;
$$;

revoke all on function public.nv_health_take()   from public, anon;
revoke all on function public.nv_health_report() from public, anon;
grant execute on function public.nv_health_report() to authenticated;
