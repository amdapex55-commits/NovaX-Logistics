-- 28 Sep 2026: close anonymous EXECUTE on SECURITY DEFINER functions.
--
-- 63 SECURITY DEFINER functions in public were executable by anon (via the
-- default PUBLIC grant or a direct grant). Each was probed as anon first:
-- every one checks its caller internally, so none was exploitable today --
-- but one missing check is how nvsh_admin_link let anyone rebind a Shopify
-- store (26 Sep). This removes the exposure so a future missing check is
-- not reachable from the internet.
--
--   keep public (17)       called by signed-out pages or by RLS policies
--   authenticated (26)     called only from signed-in pages / the AI function
--   no API access (20)     trigger functions + the event-trigger hook; a
--                          trigger never needs EXECUTE to fire
--
-- GRANT to authenticated comes BEFORE the PUBLIC revoke on purpose:
-- authenticated often held EXECUTE only through PUBLIC.
grant execute on function public.ai_action_fix_address(p_awb text, p_address text, p_phone text) to authenticated, service_role; revoke all on function public.ai_action_fix_address(p_awb text, p_address text, p_phone text) from public, anon;
grant execute on function public.ai_context_digest() to authenticated, service_role; revoke all on function public.ai_context_digest() from public, anon;
grant execute on function public.ai_conv_start(p_title text) to authenticated, service_role; revoke all on function public.ai_conv_start(p_title text) from public, anon;
grant execute on function public.ai_history(p_conv uuid, p_limit integer) to authenticated, service_role; revoke all on function public.ai_history(p_conv uuid, p_limit integer) from public, anon;
grant execute on function public.ai_msg_log(p_conv uuid, p_role text, p_content text, p_tools text[]) to authenticated, service_role; revoke all on function public.ai_msg_log(p_conv uuid, p_role text, p_content text, p_tools text[]) from public, anon;
grant execute on function public.ai_quota_consume() to authenticated, service_role; revoke all on function public.ai_quota_consume() from public, anon;
grant execute on function public.ai_quota_request_reset(p_reason text) to authenticated, service_role; revoke all on function public.ai_quota_request_reset(p_reason text) from public, anon;
grant execute on function public.ai_quota_status() to authenticated, service_role; revoke all on function public.ai_quota_status() from public, anon;
grant execute on function public.ai_tool_consignee_history(p_phone text) to authenticated, service_role; revoke all on function public.ai_tool_consignee_history(p_phone text) from public, anon;
grant execute on function public.ai_tool_exceptions() to authenticated, service_role; revoke all on function public.ai_tool_exceptions() from public, anon;
grant execute on function public.ai_tool_get_parcel(p_awb text) to authenticated, service_role; revoke all on function public.ai_tool_get_parcel(p_awb text) from public, anon;
grant execute on function public.ai_tool_list_invoices(p_limit integer) to authenticated, service_role; revoke all on function public.ai_tool_list_invoices(p_limit integer) from public, anon;
grant execute on function public.ai_tool_list_parcels(p_status text, p_limit integer) to authenticated, service_role; revoke all on function public.ai_tool_list_parcels(p_status text, p_limit integer) from public, anon;
grant execute on function public.ai_tool_rate_card() to authenticated, service_role; revoke all on function public.ai_tool_rate_card() from public, anon;
grant execute on function public.ai_tool_remember(p_fact text, p_source text) to authenticated, service_role; revoke all on function public.ai_tool_remember(p_fact text, p_source text) from public, anon;
grant execute on function public.ai_tool_search_parcels(p_status text, p_city text, p_consignee text, p_days integer, p_stale_hours integer, p_limit integer) to authenticated, service_role; revoke all on function public.ai_tool_search_parcels(p_status text, p_city text, p_consignee text, p_days integer, p_stale_hours integer, p_limit integer) from public, anon;
grant execute on function public.client_delivery_estimate() to authenticated, service_role; revoke all on function public.client_delivery_estimate() from public, anon;
grant execute on function public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text) to authenticated, service_role; revoke all on function public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text) from public, anon;
grant execute on function public.novax_areas_list(p_city text) to authenticated, service_role; revoke all on function public.novax_areas_list(p_city text) from public, anon;
grant execute on function public.novax_pricing_config_get() to authenticated, service_role; revoke all on function public.novax_pricing_config_get() from public, anon;
grant execute on function public.novax_quote_booking(p_dest_city text, p_weight text, p_origin_area_id uuid, p_dest_area_id uuid) to authenticated, service_role; revoke all on function public.novax_quote_booking(p_dest_city text, p_weight text, p_origin_area_id uuid, p_dest_area_id uuid) from public, anon;
grant execute on function public.queue_notification_event(p_client_id uuid, p_awb text, p_event_type text, p_recipient text, p_payload jsonb) to authenticated, service_role; revoke all on function public.queue_notification_event(p_client_id uuid, p_awb text, p_event_type text, p_recipient text, p_payload jsonb) from public, anon;
grant execute on function public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text) to authenticated, service_role; revoke all on function public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text) from public, anon;
grant execute on function public.submit_client_review(p_rating integer, p_comment text) to authenticated, service_role; revoke all on function public.submit_client_review(p_rating integer, p_comment text) from public, anon;
revoke all on function public.enforce_parcel_status_transition() from public, anon, authenticated; grant execute on function public.enforce_parcel_status_transition() to service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated; grant execute on function public.handle_new_user() to service_role;
revoke all on function public.novax_client_default_pickup() from public, anon, authenticated; grant execute on function public.novax_client_default_pickup() to service_role;
revoke all on function public.novax_parcel_autoprice() from public, anon, authenticated; grant execute on function public.novax_parcel_autoprice() to service_role;
revoke all on function public.novax_ticket_stamp_first_response() from public, anon, authenticated; grant execute on function public.novax_ticket_stamp_first_response() to service_role;
revoke all on function public.nv_api_enqueue_status() from public, anon, authenticated; grant execute on function public.nv_api_enqueue_status() to service_role;
revoke all on function public.nv_backfill_client_contact() from public, anon, authenticated; grant execute on function public.nv_backfill_client_contact() to service_role;
revoke all on function public.nv_force_rls_on_new_table() from public, anon, authenticated; grant execute on function public.nv_force_rls_on_new_table() to service_role;
revoke all on function public.nv_freeze_parcel_money() from public, anon, authenticated; grant execute on function public.nv_freeze_parcel_money() to service_role;
revoke all on function public.nv_guard_payment_logs() from public, anon, authenticated; grant execute on function public.nv_guard_payment_logs() to service_role;
revoke all on function public.nv_guard_rider_cod_ledger() from public, anon, authenticated; grant execute on function public.nv_guard_rider_cod_ledger() to service_role;
revoke all on function public.nv_guard_rider_scans() from public, anon, authenticated; grant execute on function public.nv_guard_rider_scans() to service_role;
revoke all on function public.nv_log_cod_expected() from public, anon, authenticated; grant execute on function public.nv_log_cod_expected() to service_role;
revoke all on function public.nv_log_parcel_contact() from public, anon, authenticated; grant execute on function public.nv_log_parcel_contact() to service_role;
revoke all on function public.nv_log_parcel_owner_change() from public, anon, authenticated; grant execute on function public.nv_log_parcel_owner_change() to service_role;
revoke all on function public.nv_log_parcel_status() from public, anon, authenticated; grant execute on function public.nv_log_parcel_status() to service_role;
revoke all on function public.nv_parcel_owner_matches_invoice() from public, anon, authenticated; grant execute on function public.nv_parcel_owner_matches_invoice() to service_role;
revoke all on function public.nv_rider_evidence_guard() from public, anon, authenticated; grant execute on function public.nv_rider_evidence_guard() to service_role;
revoke all on function public.nv_rider_write_guard() from public, anon, authenticated; grant execute on function public.nv_rider_write_guard() to service_role;
revoke all on function public.nvsh_mark_ready_to_fulfill() from public, anon, authenticated; grant execute on function public.nvsh_mark_ready_to_fulfill() to service_role;
revoke all on function public.parcels_guard_columns() from public, anon, authenticated; grant execute on function public.parcels_guard_columns() to service_role;
revoke all on function public.trg_post_non_cod_delivery_charge() from public, anon, authenticated; grant execute on function public.trg_post_non_cod_delivery_charge() to service_role;

-- kept public:
-- keep public: public.ai_public_parcel(p_token text)
-- keep public: public.can_process_orders()
-- keep public: public.is_admin()
-- keep public: public.is_client_owner_seat()
-- keep public: public.is_staff_admin()
-- keep public: public.log_portal_error(p_source text, p_rpc_name text, p_page text, p_message text, p_severity text)
-- keep public: public.my_client_id()
-- keep public: public.my_rider_id()
-- keep public: public.nv_ai_my_client()
-- keep public: public.nv_signup_lead_create(p_name text, p_phone text, p_email text, p_city text, p_address text, p_business_type text, p_website text, p_auth_user_id uuid)
-- keep public: public.nv_signup_lead_mark(p_lead_id uuid, p_status text, p_error text)
-- keep public: public.ops_daily_report(p_token text, p_days integer)
-- keep public: public.public_reviews()
-- keep public: public.public_track_awb(p_awb text)
-- keep public: public.public_track_brand(p_token text)
-- keep public: public.public_track_parcel(p_token text)
-- keep public: public.visitor_ping(p_session_id text, p_portal text, p_activity text, p_path text, p_referrer text, p_user_agent text)
