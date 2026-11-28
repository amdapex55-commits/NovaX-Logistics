-- 28 Nov 2026: sign a login out on every phone and browser (lost or stolen
-- phone), without blocking the account. Admin → Edit Users → "Sign out on all
-- phones". Deletes the login's sessions (their refresh tokens go with them, so
-- no device can renew) and its notification phones. The portal and rider app
-- check every few minutes and on returning to the app, and go to the sign-in
-- screen as soon as the server says the session is gone; an access token
-- already handed out stops working when it expires (at most 1 hour).
-- Safe to run again.
drop function if exists public.admin_sign_out_everywhere(uuid);
create or replace function public.admin_sign_out_everywhere(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int; d int; p_user uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  select id into p_user from auth.users where lower(email) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if p_user is null then raise exception 'No login with that email.'; end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  delete from public.nv_push_devices where user_id = p_user;
  get diagnostics d = row_count;
  return jsonb_build_object('ok', true, 'sessions', n, 'phones', d);
end $$;
revoke all on function public.admin_sign_out_everywhere(text) from public, anon;
grant execute on function public.admin_sign_out_everywhere(text) to authenticated;
