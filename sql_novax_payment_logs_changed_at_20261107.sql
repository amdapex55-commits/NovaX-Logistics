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
