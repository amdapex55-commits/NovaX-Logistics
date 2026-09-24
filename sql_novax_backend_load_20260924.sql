-- NovaX backend load, 24 Sep 2026.
--
-- 1. Row-level security ran its checks once PER ROW. Policies call
--    is_admin(), my_client_id(), my_rider_id(), is_staff_admin(),
--    can_process_orders() and auth.uid() bare, so Postgres re-evaluated each
--    one for every row a query touched -- every call a lookup in profiles.
--    profiles showed 10.3 million index scans since the last stats reset for
--    31 rows. Admin's parcels load (936 rows) took 307 ms, nearly all of it
--    policy evaluation, and realtime runs the same policies per change per
--    subscriber.
--
--    Wrapping each call as ( SELECT f() ) makes it an InitPlan: evaluated once
--    per query, same value, same rules. Rehearsed in BEGIN/ROLLBACK against
--    production: for admin, merchant (KKM), rider (Khalid) and anon, every one
--    of 53 policy-bearing tables returned the identical row set (count + md5 of
--    every row) before and after; total policy time 1,369 ms -> 285 ms.
--
--    Generated from pg_policies by text substitution of the bare calls only;
--    no predicate was retyped.
--
-- 2. cron.job_run_details had 47,374 rows (16 MB) back to 27 Jul and grows
--    ~1,500 a day (nv_api_webhook_tick runs every minute). Nothing reads it
--    past a few days. Keep 14 days.
--
-- Apply as ONE statement batch (psql -c "$(cat file)"), not psql -f: ALTER
-- POLICY takes an exclusive lock per table, and 90+ separate round trips to
-- Sydney would hold parcels/clients locked for ~30 s. lock_timeout makes it
-- fail rather than queue behind live traffic.

begin;
set local lock_timeout = '3s';
set local search_path = public, extensions;

alter policy "profiles_self_read" on public."profiles" using (((id = ( SELECT auth.uid())) OR ( SELECT is_admin())));
alter policy "profiles_admin_all" on public."profiles" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "clients_owner_read" on public."clients" using (((id = ( SELECT my_client_id())) OR ( SELECT is_admin())));
alter policy "clients_admin_all" on public."clients" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "riders_self_read" on public."riders" using (((id = ( SELECT my_rider_id())) OR ( SELECT is_admin())));
alter policy "riders_admin_all" on public."riders" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "parcels_scoped_read" on public."parcels" using ((( SELECT is_admin()) OR (client_id = ( SELECT my_client_id())) OR (rider_id = ( SELECT my_rider_id()))));
alter policy "parcels_admin_all" on public."parcels" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "scans_scoped_read" on public."scans" using ((( SELECT is_admin()) OR (rider_id = ( SELECT my_rider_id())) OR (EXISTS ( SELECT 1
   FROM parcels p
  WHERE ((p.id = scans.parcel_id) AND (p.client_id = ( SELECT my_client_id())))))));
alter policy "scans_admin_all" on public."scans" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "manifests_scoped_read" on public."manifests" using ((( SELECT is_admin()) OR (rider_id = ( SELECT my_rider_id()))));
alter policy "manifests_admin_all" on public."manifests" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "invoices_owner_read" on public."invoices" using ((( SELECT is_admin()) OR (client_id = ( SELECT my_client_id()))));
alter policy "invoices_admin_all" on public."invoices" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "expenses_admin_all" on public."expenses" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "tickets_owner_read" on public."tickets" using ((( SELECT is_admin()) OR (client_id = ( SELECT my_client_id()))));
alter policy "tickets_owner_insert" on public."tickets" with check ((( SELECT is_admin()) OR (client_id = ( SELECT my_client_id()))));
alter policy "tickets_admin_all" on public."tickets" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "cod_scoped_read" on public."cod_ledger" using ((( SELECT is_admin()) OR (client_id = ( SELECT my_client_id())) OR (rider_id = ( SELECT my_rider_id()))));
alter policy "cod_admin_all" on public."cod_ledger" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "audit_admin_read" on public."audit_log" using (( SELECT is_admin()));
alter policy "wd_sel" on public."withdrawals" using (((client_id = ( SELECT my_client_id())) OR ( SELECT is_admin())));
alter policy "pl_sel" on public."payment_logs" using (((client_id = ( SELECT my_client_id())) OR ( SELECT is_admin())));
alter policy "pl_ins" on public."payment_logs" with check ((client_id = ( SELECT my_client_id())));
alter policy "sc_all" on public."store_connections" using (((client_id = ( SELECT my_client_id())) OR ( SELECT is_admin()))) with check (((client_id = ( SELECT my_client_id())) OR ( SELECT is_admin())));
alter policy "parcels_client_upd" on public."parcels" using ((client_id = ( SELECT my_client_id()))) with check ((client_id = ( SELECT my_client_id())));
alter policy "tickets_client_ins" on public."tickets" with check ((client_id = ( SELECT my_client_id())));
alter policy "cod_ledger_admin_all" on public."cod_ledger" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "withdrawals_admin_all" on public."withdrawals" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "payment_logs_admin_all" on public."payment_logs" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "store_connections_admin_all" on public."store_connections" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "parcels_rider_upd" on public."parcels" using ((rider_id = ( SELECT my_rider_id()))) with check ((rider_id = ( SELECT my_rider_id())));
alter policy "clients_rider_read" on public."clients" using ((EXISTS ( SELECT 1
   FROM parcels p
  WHERE ((p.client_id = clients.id) AND (p.rider_id = ( SELECT my_rider_id()))))));
alter policy "scans_rider_read" on public."scans" using ((rider_id = ( SELECT my_rider_id())));
alter policy "scans_rider_ins" on public."scans" with check ((rider_id = ( SELECT my_rider_id())));
alter policy "cod_rider_read" on public."cod_ledger" using ((rider_id = ( SELECT my_rider_id())));
alter policy "cod_rider_ins" on public."cod_ledger" with check ((rider_id = ( SELECT my_rider_id())));
alter policy "novax_state_admin_all" on public."novax_state" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "staff manage staff_users" on public."staff_users" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "staff manage staff_tickets" on public."staff_tickets" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "staff manage staff_activity" on public."staff_activity" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "admin read sales leads" on public."sales_leads" using (( SELECT is_admin()));
alter policy "admin update sales leads" on public."sales_leads" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "admin delete sales leads" on public."sales_leads" using (( SELECT is_admin()));
alter policy "admin read signup_leads" on public."signup_leads" using (( SELECT is_admin()));
alter policy "admin update signup_leads" on public."signup_leads" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "store_push_failures_admin_select" on public."store_push_failures" using (( SELECT is_admin()));
alter policy "admin all scans" on public."scans" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "admin all cod_ledger" on public."cod_ledger" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "rider insert own scans" on public."scans" with check ((rider_id = ( SELECT my_rider_id())));
alter policy "rider read own scans" on public."scans" using ((rider_id = ( SELECT my_rider_id())));
alter policy "rider insert own cod_ledger" on public."cod_ledger" with check ((rider_id = ( SELECT my_rider_id())));
alter policy "rider read own cod_ledger" on public."cod_ledger" using ((rider_id = ( SELECT my_rider_id())));
alter policy "client read own cod_ledger" on public."cod_ledger" using ((client_id = ( SELECT my_client_id())));
alter policy "admin read autopilot_events" on public."autopilot_events" using (( SELECT is_admin()));
alter policy "admin read visitor_sessions" on public."visitor_sessions" using (( SELECT is_admin()));
alter policy "notification_events_admin_all" on public."notification_events" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "client_notification_prefs_admin_all" on public."client_notification_prefs" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "portal_error_logs_admin_all" on public."portal_error_logs" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "wallet_ledger_client_select" on public."wallet_ledger" using ((client_id = ( SELECT my_client_id())));
alter policy "wallet_ledger_admin_select" on public."wallet_ledger" using (( SELECT is_admin()));
alter policy "staff manage operations_issues" on public."operations_issues" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "staff manage resolved_alerts" on public."resolved_alerts" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "staff manage manifest_logs" on public."manifest_logs" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "staff manage ticket_notifications" on public."ticket_notifications" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "client insert own pickup_requests" on public."pickup_requests" with check ((client_id = ( SELECT my_client_id())));
alter policy "client read own pickup_requests" on public."pickup_requests" using ((client_id = ( SELECT my_client_id())));
alter policy "admin all pickup_requests" on public."pickup_requests" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "client reads own team" on public."staff_users" using (((client_id IS NOT NULL) AND (client_id = ( SELECT my_client_id()))));
alter policy "staff admin writes support hours" on public."support_hours" using (( SELECT is_staff_admin())) with check (( SELECT is_staff_admin()));
alter policy "client reads own tickets" on public."tickets" using ((client_id = ( SELECT my_client_id())));
alter policy "client rates own tickets" on public."tickets" using ((client_id = ( SELECT my_client_id()))) with check ((client_id = ( SELECT my_client_id())));
alter policy "admin_audit_log_admin_read" on public."admin_audit_log" using (( SELECT is_admin()));
alter policy "client_digests_own_select" on public."client_digests" using ((client_id = ( SELECT my_client_id())));
alter policy "client_due_payments_admin_select" on public."client_due_payments" using (( SELECT is_admin()));
alter policy "parcel_admin_audit_admin_select" on public."parcel_admin_audit" using (( SELECT is_admin()));
alter policy "parcel_admin_audit_client_select" on public."parcel_admin_audit" using ((client_id = ( SELECT my_client_id())));
alter policy "novax_tickets_admin_all" on public."novax_tickets" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "novax_tickets_client_read" on public."novax_tickets" using ((client_id = ( SELECT my_client_id())));
alter policy "novax_replies_admin_all" on public."novax_ticket_replies" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "novax_replies_client_read" on public."novax_ticket_replies" using ((EXISTS ( SELECT 1
   FROM novax_tickets t
  WHERE ((t.id = novax_ticket_replies.ticket_id) AND (t.client_id = ( SELECT my_client_id()))))));
alter policy "novax_areas_admin" on public."novax_areas" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "novax_pricing_config_admin" on public."novax_pricing_config" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "novax_area_overrides_admin" on public."novax_area_distance_overrides" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "client_pickup_own" on public."client_pickup_locations" using (((client_id = ( SELECT my_client_id())) OR ( SELECT is_admin())));
alter policy "client_pickup_admin" on public."client_pickup_locations" using (( SELECT is_admin())) with check (( SELECT is_admin()));
alter policy "pch_admin_read" on public."parcel_contact_history" using (( SELECT is_admin()));
alter policy "staff read canary" on public."nv_backup_canary" using (( SELECT is_staff_admin()));
alter policy "rider_batches_own" on public."rider_batches" using (((rider_id = ( SELECT my_rider_id())) OR ( SELECT is_admin())));
alter policy "staff read health" on public."nv_health_snapshot" using (( SELECT is_staff_admin()));
alter policy "rider_cash_deposits_own" on public."rider_cash_deposits" using (((rider_id = ( SELECT my_rider_id())) OR ( SELECT is_admin())));
alter policy "nvai_qr_admin" on public."nv_ai_quota_requests" using (( SELECT is_admin()));
alter policy "nvai_conv_admin" on public."nv_ai_conversations" using (( SELECT is_admin()));
alter policy "nvai_msg_admin" on public."nv_ai_messages" using (( SELECT is_admin()));

select cron.schedule(
  'nv_purge_cron_history',
  '23 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '14 days'$$
);

commit;
