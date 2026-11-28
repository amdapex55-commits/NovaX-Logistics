-- 28 Nov 2026: account deletion a merchant can start themselves.
-- Google Play and Apple both require an account-deletion path that the user
-- can start from inside the app (and, for Play, from a public web page).
-- Until now privacy.html only said "contact us".
--
-- How it works:
--   * The owner of a merchant account asks for deletion in the portal
--     (Profile > Delete account). Team logins cannot; the server decides.
--   * A request is recorded with a 30-day due date and an operations issue is
--     opened so NovaX ops sees it the same day.
--   * The merchant can cancel while it is still pending.
--   * Ops completes it by hand: parcels still moving are delivered or
--     returned, the wallet is paid out, then the login, CNIC photos and
--     profile are deleted. Booking and money records the law requires us to
--     keep are kept, without the login. (That is what privacy.html says.)
-- Safe to run again.

create table if not exists public.nv_account_deletion_requests (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,
  user_id       uuid not null,
  email         text,
  reason        text,
  status        text not null default 'pending'
                check (status in ('pending','cancelled','completed','refused')),
  requested_at  timestamptz not null default now(),
  due_at        timestamptz not null default now() + interval '30 days',
  closed_at     timestamptz,
  closed_by     text,
  note          text
);
create unique index if not exists nv_account_deletion_one_pending
  on public.nv_account_deletion_requests (client_id) where status = 'pending';

alter table public.nv_account_deletion_requests enable row level security;
alter table public.nv_account_deletion_requests force row level security;
revoke all on public.nv_account_deletion_requests from public, anon, authenticated;
drop policy if exists nv_account_deletion_staff on public.nv_account_deletion_requests;
create policy nv_account_deletion_staff on public.nv_account_deletion_requests
  for all to authenticated
  using ((select public.is_staff_admin()))
  with check ((select public.is_staff_admin()));
grant select, update on public.nv_account_deletion_requests to authenticated;

-- What the portal shows: the pending request, if any.
create or replace function public.client_account_deletion_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  if public.my_client_id() is null then
    return jsonb_build_object('pending', false, 'can_request', false);
  end if;
  select id, requested_at, due_at into r
    from public.nv_account_deletion_requests
   where client_id = public.my_client_id() and status = 'pending'
   limit 1;
  return jsonb_build_object(
    'pending',     r.id is not null,
    'requested_at', r.requested_at,
    'due_at',      r.due_at,
    'can_request', public.is_client_owner_seat());
end $$;

create or replace function public.client_request_account_deletion(p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id();
  v_email  text;
  v_name   text;
  v_row    public.nv_account_deletion_requests;
begin
  if v_client is null then raise exception 'Sign in to your NovaX account first.'; end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can ask to delete this account.';
  end if;

  select * into v_row from public.nv_account_deletion_requests
   where client_id = v_client and status = 'pending' limit 1;
  if v_row.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'due_at', v_row.due_at);
  end if;

  select u.email into v_email from auth.users u where u.id = auth.uid();
  select c.name into v_name from public.clients c where c.id = v_client;

  insert into public.nv_account_deletion_requests (client_id, user_id, email, reason)
  values (v_client, auth.uid(), v_email, left(nullif(trim(p_reason), ''), 500))
  returning * into v_row;

  insert into public.operations_issues (branch, urgency, problem, meta)
  values ('Accounts', 'urgent',
          'Account deletion requested: ' || coalesce(v_name, v_email, v_client::text),
          jsonb_build_object('kind', 'account_deletion', 'request_id', v_row.id,
                             'client_id', v_client, 'email', v_email,
                             'due_at', v_row.due_at, 'reason', v_row.reason))
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'due_at', v_row.due_at);
end $$;

create or replace function public.client_cancel_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); n int;
begin
  if v_client is null then raise exception 'Sign in to your NovaX account first.'; end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can change this.';
  end if;
  update public.nv_account_deletion_requests
     set status = 'cancelled', closed_at = now(), closed_by = 'merchant'
   where client_id = v_client and status = 'pending';
  get diagnostics n = row_count;
  update public.operations_issues
     set resolved = true, resolved_at = now()::text, resolved_by = 'merchant',
         resolution_reason = 'Merchant cancelled the deletion request', updated_at = now()
   where not resolved and meta->>'kind' = 'account_deletion' and meta->>'client_id' = v_client::text;
  return jsonb_build_object('ok', true, 'cancelled', n > 0);
end $$;

revoke all on function public.client_account_deletion_status() from public, anon;
revoke all on function public.client_request_account_deletion(text) from public, anon;
revoke all on function public.client_cancel_account_deletion() from public, anon;
grant execute on function public.client_account_deletion_status() to authenticated;
grant execute on function public.client_request_account_deletion(text) to authenticated;
grant execute on function public.client_cancel_account_deletion() to authenticated;
