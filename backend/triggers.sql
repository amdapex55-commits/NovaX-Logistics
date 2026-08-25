-- =====================================================================
-- NovaX backend -- triggers
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 33 function(s) in this file.
-- =====================================================================

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER novax_client_default_pickup_trg AFTER INSERT ON public.clients FOR EACH ROW EXECUTE FUNCTION public.novax_client_default_pickup();
CREATE TRIGGER novax_stamp_delivered_at_trg BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.novax_stamp_delivered_at();
CREATE TRIGGER novax_ticket_code_trg BEFORE INSERT ON public.novax_tickets FOR EACH ROW EXECUTE FUNCTION public.novax_ticket_code();
CREATE TRIGGER novax_ticket_first_response_trg AFTER INSERT ON public.novax_ticket_replies FOR EACH ROW EXECUTE FUNCTION public.novax_ticket_stamp_first_response();
CREATE TRIGGER novax_ticket_touch_trg BEFORE UPDATE ON public.novax_tickets FOR EACH ROW EXECUTE FUNCTION public.novax_ticket_touch();
CREATE TRIGGER parcels AFTER UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/woo-status-push', 'POST', '{"Content-type":"application/json"}', '{}', '5000');
CREATE TRIGGER parcels_guard_columns_trg BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.parcels_guard_columns();
CREATE TRIGGER parcels_guard_tracking_token_trg BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.parcels_guard_tracking_token();
CREATE TRIGGER parcels_set_tracking_token_trg BEFORE INSERT ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.parcels_set_tracking_token();
CREATE TRIGGER "shopify-status-push" AFTER UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/shopify-status-push', 'POST', '{"Content-type":"application/json","Authorization":"Bearer <REDACTED-SEE-SUPABASE-DASHBOARD>"}', '{}', '5000');
CREATE TRIGGER trg_enforce_parcel_status_transition BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.enforce_parcel_status_transition();
CREATE TRIGGER trg_nv_backfill_client_contact AFTER INSERT OR UPDATE OF client_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.nv_backfill_client_contact();
CREATE TRIGGER trg_nv_freeze_parcel_money BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.nv_freeze_parcel_money();
CREATE TRIGGER trg_nv_log_parcel_contact AFTER UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.nv_log_parcel_contact();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.manifest_logs FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.operations_issues FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.payment_logs FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.pickup_requests FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.resolved_alerts FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.riders FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.staff_activity FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_no_blank_overwrite BEFORE UPDATE ON public.staff_users FOR EACH ROW EXECUTE FUNCTION public.nv_no_blank_overwrite();
CREATE TRIGGER trg_nv_protect_client_contact BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.nv_protect_client_contact();
CREATE TRIGGER trg_nv_protect_parcel_contact BEFORE UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.nv_protect_parcel_contact();
CREATE TRIGGER trg_parcel_status_log AFTER INSERT OR UPDATE OF status ON public.parcels FOR EACH ROW EXECUTE FUNCTION public.nv_log_parcel_status();
CREATE TRIGGER "web-status-push" AFTER UPDATE ON public.parcels FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/web-status-push', 'POST', '{"Content-type":"application/json","Authorization":"Bearer <REDACTED-SEE-SUPABASE-DASHBOARD>"}', '{}', '5000');
CREATE TRIGGER tr_check_filters BEFORE INSERT OR UPDATE ON realtime.subscription FOR EACH ROW EXECUTE FUNCTION realtime.subscription_check_filters();
CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();
CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();
