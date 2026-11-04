-- 4 Nov 2026: the signup ("on the list") email shows the same place in line
-- as the portal's waiting screen.
begin;
create or replace function public.nv_queue_number(p_uid uuid)
returns integer language sql immutable set search_path to '' as $$
  select 101 + (((hashtext(p_uid::text)::bigint % 99) + 99) % 99)::int;
$$;
revoke all on function public.nv_queue_number(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_existing_client_id uuid;
  v_existing_role text;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id, role::text into v_existing_client_id, v_existing_role
    from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
  end if;
  /* The upsert below sets role = 'client'. Called from an admin, staff or
     rider session -- any profile that exists and is not a merchant -- it
     silently turned that account into a merchant and cut it off from
     admin.html / rider.html. Only a brand-new login or a merchant profile
     still waiting for its workspace may be provisioned here. */
  if v_existing_role is not null and v_existing_role <> 'client' then
    raise exception 'This login is a % account, not a merchant account. Sign in to the right portal.', v_existing_role
      using errcode = '42501';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.clients (
    name, owner, meta, phone, business_type, address, city, website,
    status, wallet_balance, rate, rate_card, pricing_mode, risk_score
  )
  values (
    coalesce(nullif(btrim(p_name), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    coalesce(nullif(btrim(p_owner), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    jsonb_build_object('email', coalesce(v_email, '')),
    coalesce(p_phone, ''), coalesce(p_business_type, ''), coalesce(p_address, ''), coalesce(p_city, ''), coalesce(p_website, ''),
    'Active', 0,
    225,                                     -- Zone A base; Zone B is 250
    jsonb_build_object(
      'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    ),
    'flat',
    0
  )
  returning id into v_client_id;

  -- 4 Nov 2026: a merchant who signs up waits in the queue until an admin
  -- lets them in (nv_client_queue). The number (101-199) comes from the login
  -- id, so the "on the list" email sent at signup (nv_email_on_signup) shows
  -- the same number before this row exists.
  insert into public.nv_client_queue (client_id, number)
  values (v_client_id, public.nv_queue_number(v_uid))
  on conflict (client_id) do nothing;

  insert into public.profiles (id, email, role, status, client_id)
  values (v_uid, v_email, 'client', 'active', v_client_id)
  on conflict (id) do update
    set email = coalesce(public.profiles.email, excluded.email),
        role = 'client',
        status = 'active',
        client_id = excluded.client_id;

  return v_client_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nv_email_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if new.raw_user_meta_data->>'role'='client' and nullif(new.raw_user_meta_data->>'created_by_owner','') is null and new.invited_at is null then
 perform public.nv_email_enqueue('welcome:'||new.id,'welcome',new.email,jsonb_build_object('name',coalesce(new.raw_user_meta_data->>'full_name',''),'business',coalesce(new.raw_user_meta_data->>'business_name',''),'number',public.nv_queue_number(new.id)));
 end if; return new;
exception when others then raise warning 'NovaX email enqueue failed (welcome), SQLSTATE %',SQLSTATE; return new;
end; $function$;

commit;
