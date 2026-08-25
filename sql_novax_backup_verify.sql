-- NovaX backup verification.
--
-- What this proves: that writes are reaching the write-ahead log, that the
-- WAL is being shipped off the machine, and that it is still moving right
-- now. Those are the things that silently stop.
--
-- What it does NOT prove: that a Supabase restore actually works. Only
-- performing a restore proves that. See the drill at the bottom of this
-- file -- it is the one thing here that cannot be automated, and it is the
-- one that matters most.
--
-- Current state at the time this was written: archive_mode = on,
-- archive_command = admin-mgr wal-push, archive_timeout = 120 (a WAL segment
-- is forced every two minutes even on an idle database), 40,829 segments
-- archived, 0 failures.

-- ── The canary ───────────────────────────────────────────────────────────
-- One heartbeat an hour carrying a fingerprint of the row counts that matter.
-- Two jobs: it proves writes are still landing in WAL, and after a
-- point-in-time restore it tells you exactly WHERE you landed. Restoring to
-- "yesterday 15:00" and finding the newest canary says 14:00 means the restore
-- is an hour short of what you asked for -- which you would otherwise discover
-- by noticing missing parcels.
create table if not exists public.nv_backup_canary(
  id          bigserial primary key,
  beat_at     timestamptz not null default now(),
  fingerprint jsonb       not null
);

create index if not exists nv_backup_canary_beat_at_idx
  on public.nv_backup_canary (beat_at desc);

alter table public.nv_backup_canary enable row level security;
drop policy if exists "staff read canary" on public.nv_backup_canary;
create policy "staff read canary" on public.nv_backup_canary
  for select to authenticated using (public.is_staff_admin());

create or replace function public.nv_backup_beat()
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare v_id bigint;
begin
  insert into public.nv_backup_canary(fingerprint)
  select jsonb_build_object(
    'clients',       (select count(*) from clients),
    'parcels',       (select count(*) from parcels),
    'invoices',      (select count(*) from invoices),
    'ledger_rows',   (select count(*) from wallet_ledger),
    'ledger_sum',    (select coalesce(sum(amount),0) from wallet_ledger where affects_balance),
    'newest_parcel', (select max(booked_at) from parcels),
    'wal_lsn',       pg_current_wal_lsn()::text
  )
  returning id into v_id;

  -- ~35 days of hourly beats. Bounded, always.
  delete from public.nv_backup_canary
  where id < (select max(id) - 840 from public.nv_backup_canary);

  return v_id;
end;
$$;

-- ── The verifier ─────────────────────────────────────────────────────────
create or replace function public.nv_backup_verify()
returns table(check_name text, status text, detail text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  a           record;
  mins        numeric;
  beat_mins   numeric;
  prev_count  bigint;
  cur_count   bigint;
begin
  select * into a from pg_stat_archiver;

  -- 1. Is archiving even turned on.
  if current_setting('archive_mode', true) <> 'on' then
    return query select 'archive mode'::text, 'CRITICAL'::text,
      'archive_mode is not on. Nothing is being shipped anywhere. There is no PITR.'::text;
  else
    return query select 'archive mode'::text, 'ok'::text,
      format('on, via %s, forced every %s',
             split_part(current_setting('archive_command', true), ' ', 1),
             current_setting('archive_timeout', true));
  end if;

  -- 2. Has anything ever been archived.
  if a.last_archived_time is null then
    return query select 'wal shipped'::text, 'CRITICAL'::text,
      'pg_stat_archiver has never recorded a successful archive.'::text;
  else
    mins := extract(epoch from (now() - a.last_archived_time)) / 60.0;
    return query select 'wal shipped'::text,
      case when mins > 30 then 'CRITICAL' else 'ok' end,
      format('%s segments archived, last one %s minutes ago (%s)',
             a.archived_count, round(mins, 1), a.last_archived_wal);
  end if;

  -- 3. Failures. One is one too many.
  return query select 'archive failures'::text,
    case when a.failed_count > 0 then 'CRITICAL' else 'ok' end,
    case when a.failed_count > 0
         then format('%s failed pushes, last was %s at %s',
                     a.failed_count, a.last_failed_wal, a.last_failed_time)
         else 'none since ' || a.stats_reset::date end;

  -- 4. Is it still MOVING. A stalled archiver can look healthy for a while
  --    on last_archived_time alone; the count is what gives it away.
  select (metrics->'archiver'->>'archived')::bigint into prev_count
  from nv_health_snapshot
  where taken_at < now() - interval '20 minutes'
  order by taken_at desc limit 1;

  cur_count := a.archived_count;
  if prev_count is null then
    return query select 'wal advancing'::text, 'unknown'::text,
      'Not enough snapshot history yet. Meaningful after the first two nights.'::text;
  elsif cur_count > prev_count then
    return query select 'wal advancing'::text, 'ok'::text,
      format('%s new segments since the last snapshot.', cur_count - prev_count);
  else
    return query select 'wal advancing'::text, 'CRITICAL'::text,
      format('No new WAL segments since the last snapshot, but archive_timeout is %s. Archiving has stalled.',
             current_setting('archive_timeout', true));
  end if;

  -- 5. Canary freshness -- proof that writes are actually landing.
  select extract(epoch from (now() - max(beat_at)))/60.0 into beat_mins
  from nv_backup_canary;

  if beat_mins is null then
    return query select 'canary'::text, 'unknown'::text,
      'No heartbeat recorded yet. nv_backup_beat() has not run.'::text;
  else
    return query select 'canary'::text,
      case when beat_mins > 90 then 'CRITICAL' else 'ok' end,
      format('last heartbeat %s minutes ago; %s beats held',
             round(beat_mins), (select count(*) from nv_backup_canary));
  end if;

  -- 6. What the data looked like at the last heartbeat. This is what you
  --    compare against after a restore.
  return query select 'restore fingerprint'::text, 'info'::text,
    coalesce((select fingerprint::text from nv_backup_canary order by id desc limit 1),
             'none yet');
end;
$$;

revoke all on function public.nv_backup_beat()   from public, anon;
revoke all on function public.nv_backup_verify() from public, anon;
grant execute on function public.nv_backup_verify() to authenticated;

/* ── THE RESTORE DRILL ────────────────────────────────────────────────────
   Everything above is automated and free. This part is not, and it is the
   only part that proves the backup is real. Do it once, now, and then once
   a quarter:

     1. Supabase dashboard -> Database -> Backups -> Restore to a new project,
        picking a point in time roughly one hour ago.
     2. On the restored project run:
          select beat_at, fingerprint from nv_backup_canary order by id desc limit 3;
     3. The newest beat_at should be within an hour of the point you chose.
        If it is much older, the restore did not land where the UI claimed.
     4. Compare the fingerprint's counts against what production had at that
        time -- nv_backup_canary on production holds the same beats.
     5. Delete the restored project.

   An untested backup is a belief, not a backup. */
