begin;

-- NovaX security batch 5, 10 Sep 2026 (night audit).
-- Four admin read policies tested profiles.role inline instead of calling
-- is_admin(), so they ignored profiles.status: a blocked admin could still
-- read every merchant's AI conversations and messages, AI quota requests,
-- and the parcel contact-change history. ('owner' and 'staff' are not values
-- of novax_role, so they never matched anyone.)
alter policy nvai_conv_admin on public.nv_ai_conversations using (public.is_admin());
alter policy nvai_msg_admin on public.nv_ai_messages using (public.is_admin());
alter policy nvai_qr_admin on public.nv_ai_quota_requests using (public.is_admin());
alter policy pch_admin_read on public.parcel_contact_history using (public.is_admin());

commit;
