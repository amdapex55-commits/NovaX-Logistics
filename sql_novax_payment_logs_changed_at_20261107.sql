-- 7 Nov 2026: egress. Admin re-read the whole payment log (~3,000 rows) on
-- every change to any row: 168 times and 334,000 rows in 12 hours. Admin now
-- reads only rows changed since its last read (nvAdminDelta in admin.html),
-- like parcels.changed_at. Rows here are edited and deleted too, so the time
-- is stamped by a trigger on insert AND update; deletes are caught by a count.
-- wallet_ledger needs nothing: its rows are only ever inserted (created_at).
begin;
alter table public.payment_logs add column if not exists changed_at timestamptz not null default now();
create or replace function public.nv_payment_logs_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.changed_at := now(); return new; end $$;
drop trigger if exists zzzz_nv_payment_logs_changed_at on public.payment_logs;
create trigger zzzz_nv_payment_logs_changed_at before insert or update on public.payment_logs
  for each row execute function public.nv_payment_logs_touch();
create index if not exists payment_logs_changed_at_idx on public.payment_logs (changed_at);
create index if not exists wallet_ledger_created_at_idx on public.wallet_ledger (created_at);
commit;

-- Adding the column gave all 3,256 existing rows the same changed_at (the
-- moment of the ALTER), so every delta read returned the whole table. Each
-- old row's change time is set to its created_at instead. The trigger keeps
-- an explicitly written changed_at on UPDATE (and stamps now() otherwise), so
-- this needs no trigger switched off.
begin;
create or replace function public.nv_payment_logs_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.changed_at is distinct from old.changed_at then return new; end if;
  new.changed_at := now(); return new;
end $$;
update public.payment_logs set changed_at = created_at where changed_at = '2026-11-07 13:36:41.717558+00';
commit;
