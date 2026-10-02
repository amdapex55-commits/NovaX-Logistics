-- NovaX indexes (2 Oct 2026): the 29 foreign keys that had no index, built one at a
-- time without locking (CONCURRENTLY), and 3 exact duplicates dropped (each kept
-- its twin; constraint-backed ones are the ones kept). No behaviour changes.
-- Run with psql outside a transaction: CONCURRENTLY cannot run inside one.

create index concurrently if not exists audit_log_actor_fk_idx on public.audit_log (actor);
create index concurrently if not exists client_pickup_locations_area_id_fk_idx on public.client_pickup_locations (area_id);
create index concurrently if not exists cod_ledger_client_id_fk_idx on public.cod_ledger (client_id);
create index concurrently if not exists cod_ledger_rider_id_fk_idx on public.cod_ledger (rider_id);
create index concurrently if not exists expenses_created_by_fk_idx on public.expenses (created_by);
create index concurrently if not exists manifests_rider_id_fk_idx on public.manifests (rider_id);
create index concurrently if not exists novax_area_distance_overrides_to_area_id_fk_idx on public.novax_area_distance_overrides (to_area_id);
create index concurrently if not exists nv_api_webhook_queue_key_id_fk_idx on public.nv_api_webhook_queue (key_id);
create index concurrently if not exists nv_booking_idempotency_parcel_id_fk_idx on public.nv_booking_idempotency (parcel_id);
create index concurrently if not exists nv_swaps_back_parcel_id_fk_idx on public.nv_swaps (back_parcel_id);
create index concurrently if not exists nv_swaps_out_parcel_id_fk_idx on public.nv_swaps (out_parcel_id);
create index concurrently if not exists nv_transit_batches_rider_id_fk_idx on public.nv_transit_batches (rider_id);
create index concurrently if not exists pickup_requests_pickup_address_id_fk_idx on public.pickup_requests (pickup_address_id);
create index concurrently if not exists pickup_requests_rider_id_fk_idx on public.pickup_requests (rider_id);
create index concurrently if not exists portal_error_logs_client_id_fk_idx on public.portal_error_logs (client_id);
create index concurrently if not exists rider_expense_requests_rider_id_fk_idx on public.rider_expense_requests (rider_id);
create index concurrently if not exists sales_attributions_alt_rep_id_fk_idx on public.sales_attributions (alt_rep_id);
create index concurrently if not exists sales_attributions_rep_id_fk_idx on public.sales_attributions (rep_id);
create index concurrently if not exists sales_calls_prospect_id_fk_idx on public.sales_calls (prospect_id);
create index concurrently if not exists sales_prospects_client_id_fk_idx on public.sales_prospects (client_id);
create index concurrently if not exists sales_rewards_rep_id_fk_idx on public.sales_rewards (rep_id);
create index concurrently if not exists scans_rider_id_fk_idx on public.scans (rider_id);
create index concurrently if not exists staff_activity_owner_id_fk_idx on public.staff_activity (owner_id);
create index concurrently if not exists staff_tickets_owner_id_fk_idx on public.staff_tickets (owner_id);
create index concurrently if not exists staff_users_rider_id_fk_idx on public.staff_users (rider_id);
create index concurrently if not exists store_push_failures_client_id_fk_idx on public.store_push_failures (client_id);
create index concurrently if not exists tickets_client_id_fk_idx on public.tickets (client_id);
create index concurrently if not exists tickets_created_by_fk_idx on public.tickets (created_by);
create index concurrently if not exists tickets_parcel_id_fk_idx on public.tickets (parcel_id);

drop index concurrently if exists public.idx_parcels_awb;            -- twin: parcels_awb_key (unique constraint)
drop index concurrently if exists public.store_secrets_client_platform_uidx;  -- twin: store_secrets_client_id_platform_key (unique constraint)
drop index concurrently if exists public.wallet_ledger_client_idx;   -- twin: idx_wallet_ledger_client_created (same columns, same order)
