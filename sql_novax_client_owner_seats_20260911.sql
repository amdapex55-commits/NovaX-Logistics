begin;

-- NovaX batch 7, 11 Sep 2026: every merchant account's own login is its Owner.
--
-- Signups through the landing page get no staff_users row, and no row already
-- meant Owner. Accounts created from admin ("Create New Client", "Edit Login")
-- were given a seat with role "Client", which is_client_owner_seat() did not
-- count -- so the portal showed those merchants Owner controls while the
-- server refused their team invites and revocations. Team members an owner
-- invites (Finance, Warehouse, Support) keep the role they were given.

create or replace function public.is_client_owner_seat()
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select public.my_client_id() is not null
     and (
       -- No seat row yet => the account that owns the workspace is the owner.
       not exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
       )
       or exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
           -- "client" is the role admin used to give a merchant's own login.
           and lower(coalesce(su.role, '')) in ('owner', 'client')
           and coalesce(su.status, 'Active') <> 'Revoked'
       )
     );
$function$;

-- A merchant-side seat saved as "Client" is stored as Owner, whoever writes
-- it -- including admin's background save loop, which still holds "Client" in
-- memory for these rows and would otherwise write it straight back.
create or replace function public.nv_client_seat_is_owner()
 returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if lower(coalesce(new.role, '')) = 'client'
     and new.client_id is not null
     and lower(coalesce(new.access_side, 'client web portal')) in ('client web portal', 'client', '') then
    new.role := 'Owner';
  end if;
  return new;
end
$function$;
drop trigger if exists trg_nv_client_seat_is_owner on public.staff_users;
create trigger trg_nv_client_seat_is_owner before insert or update on public.staff_users
  for each row execute function public.nv_client_seat_is_owner();

update public.staff_users set role = 'Owner'
 where lower(coalesce(role, '')) = 'client' and client_id is not null;

commit;
