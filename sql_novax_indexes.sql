-- ============================================================================
-- NovaX: indexes for the queries both portals actually run.
--
-- Every one is CREATE INDEX CONCURRENTLY -- it does NOT lock the table, so
-- bookings and status updates keep working while these build. Safe on a live
-- platform, and safe to re-run (IF NOT EXISTS).
--
-- IMPORTANT: CONCURRENTLY cannot run inside a transaction block. Run the
-- statements ONE AT A TIME in the SQL editor, not as one batch.
-- ============================================================================

-- ── client portal ───────────────────────────────────────────────────────────
-- loadAll: parcels WHERE client_id = ? AND status NOT IN (closed) ORDER BY booked_at DESC
create index concurrently if not exists idx_parcels_client_booked
  on public.parcels (client_id, booked_at desc);

-- the same query filters on status; this covers the status-filtered variant
create index concurrently if not exists idx_parcels_client_status_booked
  on public.parcels (client_id, status, booked_at desc);

-- the invoiced-parcel backfill: WHERE client_id = ? AND awb IN (...)
create index concurrently if not exists idx_parcels_client_awb
  on public.parcels (client_id, awb);

-- tracking.html and every AWB lookup
create index concurrently if not exists idx_parcels_awb
  on public.parcels (awb);

create index concurrently if not exists idx_invoices_client_created
  on public.invoices (client_id, created_at desc);

create index concurrently if not exists idx_withdrawals_client_created
  on public.withdrawals (client_id, created_at desc);

create index concurrently if not exists idx_wallet_ledger_client_created
  on public.wallet_ledger (client_id, created_at desc);

create index concurrently if not exists idx_payment_logs_client_created
  on public.payment_logs (client_id, created_at desc);

create index concurrently if not exists idx_pickup_requests_client_created
  on public.pickup_requests (client_id, created_at desc);

create index concurrently if not exists idx_store_connections_client
  on public.store_connections (client_id);

-- ── admin portal ────────────────────────────────────────────────────────────
-- the 120-day window: parcels WHERE booked_at >= ? ORDER BY booked_at DESC
create index concurrently if not exists idx_parcels_booked
  on public.parcels (booked_at desc);

-- rider route + rider cash reconciliation
create index concurrently if not exists idx_parcels_rider_status
  on public.parcels (rider_id, status);

-- ── verify ──────────────────────────────────────────────────────────────────
-- Run after the above. Every index should show up here.
select tablename, indexname
from pg_indexes
where schemaname='public' and indexname like 'idx_%'
order by tablename, indexname;

-- And confirm the planner is actually using one (should say Index Scan,
-- not Seq Scan):
-- explain analyze
-- select * from public.parcels
-- where client_id = (select id from public.clients limit 1)
-- order by booked_at desc limit 50;
