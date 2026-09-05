CREATE OR REPLACE FUNCTION public.revoke_staff_user(p_staff_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_role      text;
  v_owners    int;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can revoke access.' using errcode = '42501';
  end if;

  select lower(coalesce(su.role, '')) into v_role
  from public.staff_users su
  where su.id = p_staff_id and su.client_id = v_client_id;

  if v_role is null then
    raise exception 'That team member was not found in your workspace.' using errcode = 'P0002';
  end if;

  if v_role = 'owner' then
    -- The account holder is an Owner even with NO staff_users row -- that is
    -- exactly what is_client_owner_seat() says: "no seat row => the account
    -- that owns the workspace is the owner". This count looked only at
    -- staff_users, so a workspace whose real owner signed up normally and then
    -- added ONE Owner sub-account counted exactly one owner and refused to
    -- revoke it. Reported by Hayat Scents: the seat was Pending, had never
    -- logged in, and could not be removed -- "even though I should already
    -- have the original zeeshan account set as owner of the workspace".
    select count(*) into v_owners
    from public.staff_users su
    where su.client_id = v_client_id
      and lower(coalesce(su.role, '')) = 'owner'
      and coalesce(su.status, 'Active') <> 'Revoked';

    -- Add the account holder, if they hold access without a seat row.
    if exists (
      select 1
      from public.profiles pr
      where pr.client_id = v_client_id
        and not exists (
          select 1 from public.staff_users s2
          where s2.client_id = v_client_id
            and (s2.auth_user_id = pr.id
                 or lower(coalesce(s2.email,'')) = lower(coalesce(pr.email,'')))
        )
    ) then
      v_owners := v_owners + 1;
    end if;

    if v_owners <= 1 then
      raise exception 'You cannot revoke the last Owner of the workspace.' using errcode = '42501';
    end if;
  end if;

  update public.staff_users
     set status = 'Revoked',
         permissions = '[]'::jsonb,
         updated_at = now()
   where id = p_staff_id
     and client_id = v_client_id;

  return true;
end;
$function$


