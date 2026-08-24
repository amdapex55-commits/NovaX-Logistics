-- ===========================================================================
-- Flat Rs 200, everywhere, for everyone. The database half.
--
-- The UI half shipped in a36e50b: per-km is unreachable from the portal and
-- the admin console. This is what makes the PRICE actually 200, which the UI
-- change does not touch.
--
-- Three separate places were not 200:
--   1. clients.rate_card Zone B is 180, so Lahore books at 180.
--   2. create_client_workspace inserts rate = 250 with no rate_card, so every
--      merchant who has ever signed up starts at Rs 250 -- not 200 -- in every
--      city. This is the one that matters most; it is silent and ongoing.
--   3. client_book_parcel falls back to coalesce(v_rate, 250) for a NULL rate.
--
-- 250 is a stale constant. PROJECT_HISTORY §3.5 records 250/240/180
-- reappearing in fallbacks repeatedly; these are two more of them.
--
-- RUN ONE STATEMENT AT A TIME. Read each result before the next.
-- ===========================================================================


-- STEP 1 -- what is actually out there right now. Read this before changing it.
select
  count(*)                                              as clients,
  count(*) filter (where pricing_mode = 'distance')     as on_per_km,
  count(*) filter (where rate = 250)                    as on_250,
  count(*) filter (where rate is null)                  as rate_null,
  count(*) filter (where (rate_card->'B'->>'overnight')::numeric = 180) as zone_b_180
from public.clients;


-- STEP 2 -- everyone flat. Safe to re-run.
update public.clients
   set pricing_mode = 'flat'
 where pricing_mode is distinct from 'flat';


-- STEP 3 -- both zones Rs 200, and the base rate with them.
--
-- additionalKg is left at 85 on purpose -- see the note at the bottom, it is a
-- decision you need to make rather than something to change quietly here.
update public.clients
   set rate = 200,
       rate_card = jsonb_set(
                     jsonb_set(
                       jsonb_set(
                         jsonb_set(coalesce(rate_card, '{}'::jsonb),
                                   '{A,overnight}',    '200'::jsonb, true),
                                   '{A,additionalKg}', to_jsonb(coalesce((rate_card->'A'->>'additionalKg')::numeric, 85)), true),
                                   '{B,overnight}',    '200'::jsonb, true),
                                   '{B,additionalKg}', to_jsonb(coalesce((rate_card->'B'->>'additionalKg')::numeric, 85)), true);


-- STEP 4 -- new signups start at 200 flat, not 250 with no card.
--
-- Same 7-argument signature, byte for byte. Changing the argument list would
-- create a SECOND create_client_workspace beside this one rather than
-- replacing it -- which is exactly what took bookings down this morning with
-- client_book_parcel. Only the values line and the column list change.
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
    200,                                     -- was 250
    jsonb_build_object(                      -- was absent, so v_base fell to rate
      'A', jsonb_build_object('overnight', 200, 'additionalKg', 85),
      'B', jsonb_build_object('overnight', 200, 'additionalKg', 85)
    ),
    'flat',                                  -- never ask, never per-km
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
$function$;


-- STEP 5 -- verify, then book a real parcel in each city.
select id, name, rate, pricing_mode,
       rate_card->'A'->>'overnight' as zone_a,
       rate_card->'B'->>'overnight' as zone_b
from public.clients
order by name;
-- Expect: every row rate 200, pricing_mode flat, zone_a 200, zone_b 200.


-- ===========================================================================
-- STILL OUTSTANDING, and it needs a decision from you
--
-- client_book_parcel also carries `coalesce(v_rate, 250)`. With STEP 3 no
-- client has a NULL rate, so it cannot fire today -- but it is a live landmine
-- for the next client inserted by hand. Fixing it means CREATE OR REPLACE on
-- the whole 14-argument body, so it is deliberately not bundled here with a
-- pricing migration; do it as its own change.
--
-- WEIGHT IS NOT FLAT. client_book_parcel charges:
--     v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
--     v_fee      := v_base + (v_extra_kg * v_addl_rate);
-- so at additionalKg = 85 a 1kg parcel is Rs 200, a 2kg parcel is Rs 285 and
-- a 3kg parcel is Rs 370. If "every parcel Rs 200" means regardless of weight
-- too, set additionalKg to 0 -- but that is a revenue change on every parcel
-- over 1kg, so it is being left alone until you say so.
-- ===========================================================================
