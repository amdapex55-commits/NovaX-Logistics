-- NovaX — the merchant's chosen city becomes their pickup city.
--
-- WHY. Pickup city was effectively hardcoded to Karachi: the booking form shipped
-- a readonly input reading "Karachi", and create_client_workspace never wrote
-- clients.meta.pickupCity, so the portal's `|| "Karachi"` fallback decided it for
-- everyone. 13 live clients already carry a pickup city that contradicts the city
-- they registered from -- 5 in Lahore and 2 in Rawalpindi are set to Karachi.
--
-- EXISTING ACCOUNTS ARE DELIBERATELY NOT TOUCHED. Pickup city decides which
-- rider is dispatched; silently moving a live merchant's pickup could send a
-- rider to the wrong city. Those 13 are reported for a human decision instead.
--
-- This only affects workspaces created from here on.

create or replace function public.nv_signup_provision(
  p_name text, p_owner text, p_phone text, p_city text,
  p_address text, p_business_type text, p_website text
) returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_client_id uuid;
  v_had_workspace uuid;
  v_city text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to set up your workspace.';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_uid::text));
  select email into v_email from auth.users where id = v_uid;
  select client_id into v_had_workspace from public.profiles where id = v_uid;

  v_client_id := public.create_client_workspace(
    p_name, p_owner, p_phone, p_city, p_address, p_business_type, p_website);

  -- Only the four cities NovaX actually collects from. Anything else falls back
  -- to Karachi rather than creating a workspace no rider can serve.
  v_city := initcap(btrim(coalesce(p_city,'')));
  if v_city not in ('Karachi','Lahore','Islamabad','Rawalpindi') then
    v_city := 'Karachi';
  end if;

  -- NEW workspaces only. An existing merchant signing in again keeps whatever
  -- pickup city they already have.
  if v_had_workspace is null then
    update public.clients
       set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('pickupCity', v_city)
     where id = v_client_id;
  end if;

  if v_had_workspace is null
     and not exists (select 1 from public.signup_leads where auth_user_id = v_uid) then
    insert into public.signup_leads
      (name, phone, email, city, address, business_type, website, auth_user_id, status)
    values (
      left(coalesce(nullif(btrim(p_name),''), split_part(coalesce(v_email,''),'@',1), 'Merchant'), 200),
      left(coalesce(p_phone,''), 40),
      left(lower(coalesce(v_email,'')), 200),
      left(v_city, 80),
      left(coalesce(p_address,''), 500),
      left(coalesce(p_business_type,''), 200),
      left(coalesce(p_website,''), 300),
      v_uid, 'workspace_created');
  end if;

  return v_client_id;
end
$$;

revoke all on function public.nv_signup_provision(text,text,text,text,text,text,text) from public;
grant execute on function public.nv_signup_provision(text,text,text,text,text,text,text) to authenticated;
