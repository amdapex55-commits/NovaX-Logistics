-- ===========================================================================
-- novax_quote_fee -- tenant authorization  (30 Aug 2026)
--
-- The function is SECURITY DEFINER, granted to authenticated, and read
-- clients.rate and clients.rate_card for whatever p_client_id it was handed,
-- with no check that the caller owned that account. Any logged-in merchant
-- could learn a competitor's negotiated rate and full rate card by passing
-- their UUID.
--
-- Guard added at the top of the body. Merchants may quote only for
-- themselves; admins and service-role callers are unaffected, which is what
-- novax_quote_booking, client_book_parcel_geo, novax_parcel_autoprice and the
-- merchant API's test mode all rely on. Rehearsed under BEGIN/ROLLBACK first:
-- a service-role quote still returns Rs 200.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.novax_quote_fee(p_client_id uuid, p_dest_city text, p_weight text DEFAULT '0.8 kg'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid, p_force_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric;
  v_weight_charge numeric; v_fee numeric; v_flat_fee numeric;
  v_cfg public.novax_pricing_config;
  v_mode text; v_km numeric; v_billable_km numeric;
  v_distance_component numeric := 0; v_capped boolean := false;
  v_is_karachi boolean;
begin
  /* AUTHORIZATION. This is SECURITY DEFINER, granted to authenticated, and it
     reads clients.rate and clients.rate_card for whatever p_client_id the
     caller passes -- with no check that the caller owns it. Any logged-in
     merchant could read another merchant's negotiated rate and full rate card
     by supplying their UUID.

     A merchant may only quote for themselves. Admins and service-role callers
     (my_client_id() is null for both) keep the existing behaviour, which is
     what novax_quote_booking, client_book_parcel_geo, novax_parcel_autoprice
     and the merchant API all depend on.

     Raises rather than returning a wrong number: a quote silently computed
     against the wrong rate card is worse than a refusal. */
  if public.my_client_id() is not null
     and p_client_id is not null
     and p_client_id <> public.my_client_id()
     and not public.is_admin() then
    raise exception 'Not authorised to quote for another account.';
  end if;
  select * into v_cfg from public.novax_pricing_config where id;

  ---------------------------------------------------------------------
  -- FLAT: unchanged, byte for byte.
  ---------------------------------------------------------------------
  select c.rate, c.rate_card into v_rate, v_rate_card
    from public.clients c where c.id = p_client_id;
  v_rate := coalesce(v_rate, 250);

  v_zone := case when lower(coalesce(p_dest_city, '')) = 'karachi' then 'A' else 'B' end;

  if v_rate_card is not null and jsonb_typeof(v_rate_card -> v_zone) = 'object' then
    v_base      := coalesce((v_rate_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_rate_card is not null and (v_rate_card ->> 'overnight') is not null then
    v_base      := coalesce((v_rate_card ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card ->> 'additionalKg')::numeric, 85);
  else
    v_base      := v_rate;
    v_addl_rate := 85;
  end if;

  begin
    v_weight_kg := coalesce(
      nullif(regexp_replace(coalesce(p_weight, ''), '[^0-9.]', '', 'g'), '')::numeric, 0.8);
  exception when others then
    v_weight_kg := 0.8;
  end;
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;

  v_extra_kg      := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_weight_charge := v_extra_kg * v_addl_rate;
  v_flat_fee      := v_base + v_weight_charge;

  ---------------------------------------------------------------------
  -- MODE: there is only one now.
  --
  -- This used to read p_force_mode first, then fall back to
  -- v_cfg.distance_enabled. Both routes to 'distance' are gone. The
  -- parameter is still accepted so existing callers -- including
  -- client_book_parcel_geo, which passes 'distance' -- keep working; it
  -- simply no longer changes the answer.
  ---------------------------------------------------------------------
  v_is_karachi := lower(coalesce(p_dest_city, '')) = 'karachi';
  v_mode := 'flat';
  v_fee  := v_flat_fee;

  return jsonb_build_object(
    'mode',             v_mode,
    'fee',              round(v_fee, 2),
    'flat_fee',         round(v_flat_fee, 2),
    'zone',             v_zone,
    'base',             round(coalesce(v_base, 0), 2),
    'weight_kg',        v_weight_kg,
    'extra_kg',         v_extra_kg,
    'weight_charge',    round(v_weight_charge, 2),
    'distance_km',      v_km,
    'billable_km',      v_billable_km,
    'per_km',           null,
    'included_km',      null,
    'distance_charge',  round(v_distance_component, 2),
    'capped',           v_capped,
    'rate_version',     coalesce(v_cfg.rate_version, 'flat-v1')
  );
end
$function$


