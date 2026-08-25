-- =====================================================================
-- NovaX backend -- row level security
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 105 function(s) in this file.
-- =====================================================================

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopilot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_due_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_pickup_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cod_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices_backup_pre_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manifest_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_area_distance_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_cod_day_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_pricing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_ticket_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.novax_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ai_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ai_quota_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_hunt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_ops_report_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_parcel_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nv_review_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operations_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parcel_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parcel_contact_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parcels_deleted_backup_20260818 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resolved_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_push_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger_backup_pre_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert their own visitor heartbeat" ON public.visitor_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anyone can update their own visitor heartbeat" ON public.visitor_sessions FOR UPDATE TO anon USING ((session_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-session'::text))) WITH CHECK ((session_id = ((current_setting('request.headers'::text, true))::json ->> 'x-visitor-session'::text)));
CREATE POLICY "admin all cod_ledger" ON public.cod_ledger TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin all pickup_requests" ON public.pickup_requests TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin all scans" ON public.scans TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin delete sales leads" ON public.sales_leads FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "admin read autopilot_events" ON public.autopilot_events FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "admin read sales leads" ON public.sales_leads FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "admin read signup_leads" ON public.signup_leads FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "admin read visitor_sessions" ON public.visitor_sessions FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "admin update sales leads" ON public.sales_leads FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "admin update signup_leads" ON public.signup_leads FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "anon insert signup_leads" ON public.signup_leads FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon update pending signup_leads" ON public.signup_leads FOR UPDATE TO anon USING ((status = 'pending_workspace'::text)) WITH CHECK (true);
CREATE POLICY "anyone authenticated reads support hours" ON public.support_hours FOR SELECT TO authenticated USING (true);
CREATE POLICY audit_admin_read ON public.audit_log FOR SELECT USING (public.is_admin());
CREATE POLICY "client insert own pickup_requests" ON public.pickup_requests FOR INSERT TO authenticated WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY "client rates own tickets" ON public.tickets FOR UPDATE TO authenticated USING ((client_id = public.my_client_id())) WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY "client read own cod_ledger" ON public.cod_ledger FOR SELECT TO authenticated USING ((client_id = public.my_client_id()));
CREATE POLICY "client read own pickup_requests" ON public.pickup_requests FOR SELECT TO authenticated USING ((client_id = public.my_client_id()));
CREATE POLICY "client reads own team" ON public.staff_users FOR SELECT TO authenticated USING (((client_id IS NOT NULL) AND (client_id = public.my_client_id())));
CREATE POLICY "client reads own tickets" ON public.tickets FOR SELECT TO authenticated USING ((client_id = public.my_client_id()));
CREATE POLICY client_digests_own_select ON public.client_digests FOR SELECT TO authenticated USING ((client_id = public.my_client_id()));
CREATE POLICY client_due_payments_admin_select ON public.client_due_payments FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY client_notification_prefs_admin_all ON public.client_notification_prefs USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY client_pickup_admin ON public.client_pickup_locations TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY client_pickup_own ON public.client_pickup_locations FOR SELECT TO authenticated USING (((client_id = public.my_client_id()) OR public.is_admin()));
CREATE POLICY clients_admin_all ON public.clients USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY clients_owner_read ON public.clients FOR SELECT USING (((id = public.my_client_id()) OR public.is_admin()));
CREATE POLICY clients_rider_read ON public.clients FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.parcels p
  WHERE ((p.client_id = clients.id) AND (p.rider_id = public.my_rider_id())))));
CREATE POLICY cod_admin_all ON public.cod_ledger USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY cod_ledger_admin_all ON public.cod_ledger USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY cod_rider_ins ON public.cod_ledger FOR INSERT WITH CHECK ((rider_id = public.my_rider_id()));
CREATE POLICY cod_rider_read ON public.cod_ledger FOR SELECT USING ((rider_id = public.my_rider_id()));
CREATE POLICY cod_scoped_read ON public.cod_ledger FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id()) OR (rider_id = public.my_rider_id())));
CREATE POLICY expenses_admin_all ON public.expenses USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY invoices_admin_all ON public.invoices USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY invoices_owner_read ON public.invoices FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));
CREATE POLICY manifests_admin_all ON public.manifests USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY manifests_scoped_read ON public.manifests FOR SELECT USING ((public.is_admin() OR (rider_id = public.my_rider_id())));
CREATE POLICY notification_events_admin_all ON public.notification_events USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY novax_area_overrides_admin ON public.novax_area_distance_overrides TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_areas_admin ON public.novax_areas TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_areas_read ON public.novax_areas FOR SELECT TO authenticated USING (active);
CREATE POLICY novax_pricing_config_admin ON public.novax_pricing_config TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_pricing_config_read ON public.novax_pricing_config FOR SELECT TO authenticated USING (true);
CREATE POLICY novax_replies_admin_all ON public.novax_ticket_replies USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_replies_client_read ON public.novax_ticket_replies FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.novax_tickets t
  WHERE ((t.id = novax_ticket_replies.ticket_id) AND (t.client_id = public.my_client_id())))));
CREATE POLICY novax_state_admin_all ON public.novax_state TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_tickets_admin_all ON public.novax_tickets USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY novax_tickets_client_read ON public.novax_tickets FOR SELECT USING ((client_id = public.my_client_id()));
CREATE POLICY nvai_conv_admin ON public.nv_ai_conversations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (lower((p.role)::text) = ANY (ARRAY['admin'::text, 'owner'::text]))))));
CREATE POLICY nvai_conv_own ON public.nv_ai_conversations FOR SELECT TO authenticated USING ((client_id = public.nv_ai_my_client()));
CREATE POLICY nvai_msg_admin ON public.nv_ai_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (lower((p.role)::text) = ANY (ARRAY['admin'::text, 'owner'::text]))))));
CREATE POLICY nvai_msg_own ON public.nv_ai_messages FOR SELECT TO authenticated USING ((client_id = public.nv_ai_my_client()));
CREATE POLICY nvai_qr_admin ON public.nv_ai_quota_requests FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (lower((p.role)::text) = ANY (ARRAY['admin'::text, 'owner'::text, 'staff'::text]))))));
CREATE POLICY nvai_qr_own ON public.nv_ai_quota_requests FOR SELECT TO authenticated USING ((client_id = public.nv_ai_my_client()));
CREATE POLICY nvai_usage_own ON public.nv_ai_usage FOR SELECT TO authenticated USING ((client_id = public.nv_ai_my_client()));
CREATE POLICY parcel_admin_audit_admin_select ON public.parcel_admin_audit FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY parcel_admin_audit_client_select ON public.parcel_admin_audit FOR SELECT TO authenticated USING ((client_id = public.my_client_id()));
CREATE POLICY parcels_admin_all ON public.parcels USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY parcels_client_ins ON public.parcels FOR INSERT WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY parcels_client_upd ON public.parcels FOR UPDATE USING ((client_id = public.my_client_id())) WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY parcels_rider_upd ON public.parcels FOR UPDATE USING ((rider_id = public.my_rider_id())) WITH CHECK ((rider_id = public.my_rider_id()));
CREATE POLICY parcels_scoped_read ON public.parcels FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id()) OR (rider_id = public.my_rider_id())));
CREATE POLICY payment_logs_admin_all ON public.payment_logs USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY pch_admin_read ON public.parcel_contact_history FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (lower((p.role)::text) = ANY (ARRAY['admin'::text, 'owner'::text, 'staff'::text]))))));
CREATE POLICY pl_ins ON public.payment_logs FOR INSERT WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY pl_sel ON public.payment_logs FOR SELECT USING (((client_id = public.my_client_id()) OR public.is_admin()));
CREATE POLICY portal_error_logs_admin_all ON public.portal_error_logs USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY profiles_admin_all ON public.profiles USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY profiles_self_read ON public.profiles FOR SELECT USING (((id = auth.uid()) OR public.is_admin()));
CREATE POLICY "public insert sales leads" ON public.sales_leads FOR INSERT WITH CHECK (true);
CREATE POLICY reviews_no_direct_access ON public.reviews TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "rider insert own cod_ledger" ON public.cod_ledger FOR INSERT TO authenticated WITH CHECK ((rider_id = public.my_rider_id()));
CREATE POLICY "rider insert own scans" ON public.scans FOR INSERT TO authenticated WITH CHECK ((rider_id = public.my_rider_id()));
CREATE POLICY "rider read own cod_ledger" ON public.cod_ledger FOR SELECT TO authenticated USING ((rider_id = public.my_rider_id()));
CREATE POLICY "rider read own scans" ON public.scans FOR SELECT TO authenticated USING ((rider_id = public.my_rider_id()));
CREATE POLICY riders_admin_all ON public.riders USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY riders_self_read ON public.riders FOR SELECT USING (((id = public.my_rider_id()) OR public.is_admin()));
CREATE POLICY sc_all ON public.store_connections USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));
CREATE POLICY scans_admin_all ON public.scans USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY scans_rider_ins ON public.scans FOR INSERT WITH CHECK ((rider_id = public.my_rider_id()));
CREATE POLICY scans_rider_read ON public.scans FOR SELECT USING ((rider_id = public.my_rider_id()));
CREATE POLICY scans_scoped_read ON public.scans FOR SELECT USING ((public.is_admin() OR (rider_id = public.my_rider_id()) OR (EXISTS ( SELECT 1
   FROM public.parcels p
  WHERE ((p.id = scans.parcel_id) AND (p.client_id = public.my_client_id()))))));
CREATE POLICY "staff admin writes support hours" ON public.support_hours TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage manifest_logs" ON public.manifest_logs TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage operations_issues" ON public.operations_issues TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage resolved_alerts" ON public.resolved_alerts TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage staff_activity" ON public.staff_activity TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage staff_tickets" ON public.staff_tickets TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage staff_users" ON public.staff_users TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY "staff manage ticket_notifications" ON public.ticket_notifications TO authenticated USING (public.is_staff_admin()) WITH CHECK (public.is_staff_admin());
CREATE POLICY store_connections_admin_all ON public.store_connections USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY store_push_failures_admin_select ON public.store_push_failures FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY tickets_admin_all ON public.tickets USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY tickets_client_ins ON public.tickets FOR INSERT WITH CHECK ((client_id = public.my_client_id()));
CREATE POLICY tickets_owner_insert ON public.tickets FOR INSERT WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));
CREATE POLICY tickets_owner_read ON public.tickets FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));
CREATE POLICY wallet_ledger_admin_select ON public.wallet_ledger FOR SELECT USING (public.is_admin());
CREATE POLICY wallet_ledger_client_select ON public.wallet_ledger FOR SELECT USING ((client_id = public.my_client_id()));
CREATE POLICY wd_sel ON public.withdrawals FOR SELECT USING (((client_id = public.my_client_id()) OR public.is_admin()));
CREATE POLICY withdrawals_admin_all ON public.withdrawals USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY delivery_proofs_authenticated_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'delivery-proofs'::text));
CREATE POLICY delivery_proofs_public_read ON storage.objects FOR SELECT USING ((bucket_id = 'delivery-proofs'::text));
