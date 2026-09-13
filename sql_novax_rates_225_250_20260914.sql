-- NovaX, 14 Sep 2026: Zone A 220 -> 225, Zone B 225 -> 250. Extra kg stays 85.
--
-- FORWARD ONLY BY CONSTRUCTION. parcels.fee is a plain stored column stamped at
-- booking (is_generated = NEVER), so nothing already booked or in flight is
-- repriced. Verified in rehearsal: 0 of 122 in-flight parcels changed.
--
-- clients.rate moves too, not just the card: ai_tool_rate_card returns it as
-- base_rate to the merchant AI, and normalizeRateCard falls back to it, so
-- leaving it at 220 would have the AI quoting the old price.
begin;

update public.clients
   set rate = 225,
       rate_card = jsonb_set(
                     jsonb_set(coalesce(rate_card,'{}'::jsonb), '{A,overnight}', '225'::jsonb, true),
                     '{B,overnight}', '250'::jsonb, true);

-- every future signup starts on the new card
create or replace function public.create_client_workspace(
  p_name text, p_owner text, p_phone text, p_city text,
  p_address text, p_business_type text, p_website text)
returns uuid language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_existing_client_id uuid;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id into v_existing_client_id from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
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

  insert into public.profiles (id, email, role, status, client_id)
  values (v_uid, v_email, 'client', 'active', v_client_id)
  on conflict (id) do update
    set email = coalesce(public.profiles.email, excluded.email),
        role = 'client',
        status = 'active',
        client_id = excluded.client_id;

  return v_client_id;
end;
$fn$;

commit;
