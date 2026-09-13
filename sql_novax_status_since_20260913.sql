-- NovaX, 13 Sep 2026: parcel aging was measured from updated_at, which any
-- write bumps -- printing a label reset a parcel's age and its SLA warning.
-- Measured drift before this fix: avg 116.8h, worst 550h, 273 of 445 logged
-- parcels off by more than an hour.
begin;

alter table public.parcels add column if not exists status_since timestamptz;

-- Backfill from the status log, which already records every change.
-- nv_log_parcel_status stamps INSERT rows with booked_at, so max(changed_at)
-- is a true status-change time; booked_at covers parcels with no log row.
update public.parcels p
   set status_since = coalesce(
         (select max(l.changed_at) from public.nv_parcel_status_log l where l.parcel_id = p.id),
         p.booked_at)
 where p.status_since is null;

alter table public.parcels alter column status_since set default now();

create or replace function public.nv_stamp_status_since()
returns trigger
language plpgsql
as $fn$
begin
  if TG_OP = 'INSERT' then
    new.status_since := coalesce(new.status_since, new.booked_at, now());
    return new;
  end if;
  -- Exactly the test nv_log_parcel_status uses, so this column and the log
  -- can never disagree about when the status last changed.
  if new.status is distinct from old.status then
    new.status_since := now();
  else
    new.status_since := old.status_since;   -- never let an unrelated write move it
  end if;
  return new;
end;
$fn$;

-- Named to sort AFTER parcels_guard_columns_trg: BEFORE triggers fire in
-- alphabetical order, and this must be the last word on the column.
drop trigger if exists zz_nv_stamp_status_since on public.parcels;
create trigger zz_nv_stamp_status_since
  before insert or update on public.parcels
  for each row execute function public.nv_stamp_status_since();

commit;
