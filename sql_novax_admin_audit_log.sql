-- Audit trail for admin actions that touch merchant credentials.
-- Written by the admin-reset-password Edge Function on every attempt, allowed
-- or refused, so a password change is never invisible.
create table if not exists public.admin_audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  actor_auth_id   uuid,
  actor_email     text,
  action          text not null,
  target_client_id uuid,
  allowed         boolean not null,
  detail          text
);

-- The nv_force_rls_trg event trigger already enables RLS and revokes anon on
-- anything created in public; these are explicit so the intent is readable.
alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon;

drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read on public.admin_audit_log
  for select to authenticated using (public.is_admin());

-- No insert policy for anon/authenticated on purpose: only the service-role
-- key inside the Edge Function writes here, and service_role bypasses RLS.
grant select on public.admin_audit_log to authenticated;
