-- =====================================================================
-- NovaX backend -- pricing
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 12 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.novax_area_distance_km(p_from uuid, p_to uuid) RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  v_km numeric; v_factor numeric; v_a record; v_b record;
begin
  if p_from is null or p_to is null then return null; end if;

  select o.km into v_km
    from public.novax_area_distance_overrides o
   where (o.from_area_id = p_from and o.to_area_id = p_to)
      or (o.from_area_id = p_to   and o.to_area_id = p_from)
   limit 1;
  if v_km is not null then return v_km; end if;

  select ar.lat, ar.lng into v_a from public.novax_areas ar where ar.id = p_from;
  select ar.lat, ar.lng into v_b from public.novax_areas ar where ar.id = p_to;
  if v_a is null or v_b is null then return null; end if;

  select pc.road_factor into v_factor from public.novax_pricing_config pc where pc.id;
  v_factor := coalesce(v_factor, 1.35);

  v_km := public.novax_haversine_km(v_a.lat, v_a.lng, v_b.lat, v_b.lng) * v_factor;
  -- Floor of 1.5 km: an intra-area drop is still a real trip, and a
  -- near-zero distance would price below the cost of making it.
  return round(greatest(coalesce(v_km, 0), 1.5), 2);
end
$$;

CREATE FUNCTION public.novax_areas_list(p_city text DEFAULT 'Karachi'::text) RETURNS TABLE(id uuid, city text, name text, aliases text[], lat numeric, lng numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select a.id, a.city, a.name, a.aliases, a.lat, a.lng
    from public.novax_areas a
   where a.active
     and (p_city is null or lower(a.city) = lower(p_city))
   order by a.sort, a.name;
$$;

CREATE FUNCTION public.novax_haversine_km(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  r  constant double precision := 6371.0088;   -- mean Earth radius, km
  a1 double precision; a2 double precision;
  dlat double precision; dlng double precision; h double precision;
begin
  if p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then
    return null;
  end if;
  a1   := radians(p_lat1::double precision);
  a2   := radians(p_lat2::double precision);
  dlat := radians((p_lat2 - p_lat1)::double precision);
  dlng := radians((p_lng2 - p_lng1)::double precision);
  h := sin(dlat / 2) ^ 2 + cos(a1) * cos(a2) * sin(dlng / 2) ^ 2;
  return round((2 * r * asin(least(1, sqrt(h))))::numeric, 3);
end
$$;

CREATE FUNCTION public.novax_parcel_autoprice() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_cfg    public.novax_pricing_config;
  v_origin uuid;
  v_dest   uuid;
  v_quote  jsonb;
begin
  if new.pricing_mode is not null then return new; end if;
  if lower(coalesce(new.city, '')) <> 'karachi' then return new; end if;

  begin
    select * into v_cfg from public.novax_pricing_config where id;
    if not coalesce(v_cfg.distance_enabled, false) then return new; end if;

    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = new.client_id and l.is_default
     limit 1;
    if v_origin is null then return new; end if;

    v_dest := public.novax_resolve_area('Karachi', new.address);
    if v_dest is null then return new; end if;

    v_quote := public.novax_quote_fee(
      new.client_id, new.city,
      coalesce(new.meta ->> 'weight', '0.8 kg'),
      v_origin, v_dest, 'distance');

    if (v_quote ->> 'mode') = 'distance' then
      new.fee            := (v_quote ->> 'fee')::numeric;
      new.quoted_fee     := (v_quote ->> 'fee')::numeric;
      new.distance_km    := nullif(v_quote ->> 'distance_km', '')::numeric;
      new.origin_area_id := v_origin;
      new.dest_area_id   := v_dest;
      new.pricing_mode   := 'distance-auto';   -- distinguishable from a merchant's explicit pick
      new.rate_version   := v_quote ->> 'rate_version';
      new.meta           := coalesce(new.meta, '{}'::jsonb) || jsonb_build_object('quote', v_quote, 'areaSource', 'address');
    end if;
  exception when others then
    -- Pricing must never block a booking.
    raise notice 'NovaX autoprice skipped for %: %', new.awb, sqlerrm;
  end;
  return new;
end
$$;

CREATE FUNCTION public.novax_pricing_config_get() RETURNS public.novax_pricing_config
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select * from public.novax_pricing_config where id; $$;

CREATE FUNCTION public.novax_pricing_config_set(p_enabled boolean DEFAULT NULL::boolean, p_base numeric DEFAULT NULL::numeric, p_included_km numeric DEFAULT NULL::numeric, p_per_km numeric DEFAULT NULL::numeric, p_max_fee numeric DEFAULT NULL::numeric, p_road_factor numeric DEFAULT NULL::numeric, p_rate_version text DEFAULT NULL::text) RETURNS public.novax_pricing_config
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_row public.novax_pricing_config; v_who text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  v_who := coalesce(auth.jwt() ->> 'email', '');
  update public.novax_pricing_config
     set distance_enabled = coalesce(p_enabled, distance_enabled),
         base_fee         = coalesce(p_base, base_fee),
         included_km      = coalesce(p_included_km, included_km),
         per_km           = coalesce(p_per_km, per_km),
         max_fee          = coalesce(p_max_fee, max_fee),
         road_factor      = coalesce(p_road_factor, road_factor),
         rate_version     = coalesce(nullif(btrim(p_rate_version), ''), rate_version),
         updated_at = now(), updated_by = v_who
   where id
  returning * into v_row;
  return v_row;
end
$$;

CREATE FUNCTION public.novax_pricing_coverage() RETURNS TABLE(client_id uuid, client_name text, city text, address text, pickup_area text, on_distance boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
    select c.id, c.name, c.city, c.address, a.name,
           (a.id is not null and lower(coalesce(c.city,'')) = 'karachi')
      from public.clients c
      left join public.client_pickup_locations l on l.client_id = c.id and l.is_default
      left join public.novax_areas a on a.id = l.area_id
     order by (a.id is not null), c.name;
end
$$;

CREATE FUNCTION public.novax_pricing_shadow_report(p_days integer DEFAULT 30) RETURNS TABLE(parcels bigint, charged_total numeric, distance_total numeric, delta_total numeric, delta_pct numeric, avg_km numeric, cheaper_count bigint, dearer_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
  with s as (
    select p.fee::numeric as charged, p.quoted_fee::numeric as quoted, p.distance_km
      from public.parcels p
     where p.quoted_fee is not null
       and p.distance_km is not null
       and p.booked_at >= now() - make_interval(days => greatest(1, coalesce(p_days, 30))))
  select count(*)::bigint,
         round(coalesce(sum(charged), 0), 2),
         round(coalesce(sum(quoted), 0), 2),
         round(coalesce(sum(quoted) - sum(charged), 0), 2),
         case when coalesce(sum(charged), 0) = 0 then null
              else round(((sum(quoted) - sum(charged)) / sum(charged)) * 100, 1) end,
         round(coalesce(avg(distance_km), 0), 2),
         count(*) filter (where quoted < charged)::bigint,
         count(*) filter (where quoted > charged)::bigint
    from s;
end
$$;

CREATE FUNCTION public.novax_quote_booking(p_dest_city text, p_weight text DEFAULT '0.8 kg'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_client uuid; v_origin uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  -- Default the origin to the merchant's default pickup point.
  v_origin := p_origin_area_id;
  if v_origin is null then
    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = v_client and l.is_default
     limit 1;
  end if;
  return public.novax_quote_fee(v_client, p_dest_city, p_weight, v_origin, p_dest_area_id, null);
end
$$;

CREATE FUNCTION public.novax_quote_fee(p_client_id uuid, p_dest_city text, p_weight text DEFAULT '0.8 kg'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid, p_force_mode text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.novax_resolve_area(p_city text, p_address text) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  select a.id
    from public.novax_areas a
   where a.active
     and a.auto_match
     and lower(a.city) = lower(coalesce(nullif(btrim(p_city), ''), 'Karachi'))
     and coalesce(p_address, '') <> ''
     and (
       p_address ~* ('(^|[^[:alnum:]])' || a.name || '([^[:alnum:]]|$)')
       or exists (
         select 1 from unnest(a.aliases) al
          -- Aliases shorter than 5 characters are too collision-prone for
          -- free-text matching ("nn", "site"). They still work in the
          -- merchant-facing picker; they just cannot auto-assign an origin.
          where length(al) >= 5
            and p_address ~* ('(^|[^[:alnum:]])' || al || '([^[:alnum:]]|$)')
       )
     )
   order by length(a.name) desc
   limit 1;
$_$;

CREATE FUNCTION public.nv_enforce_pricing_mode() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_mode text;
begin
  if new.client_id is null then
    return new;
  end if;

  select pricing_mode into v_mode
  from public.clients where id = new.client_id;

  if v_mode is null then
    return new;
  end if;

  if v_mode = 'flat' then
    if new.pricing_mode is not null and new.pricing_mode like 'distance%' then
      raise exception
        'Client % is on flat pricing but this parcel was priced by distance. Booking refused rather than silently charging a rate the merchant did not choose.',
        new.client_id;
    end if;
    new.pricing_mode := 'flat';
    new.distance_km  := null;
  end if;

  if v_mode = 'distance'
     and lower(coalesce(new.city, '')) = 'karachi'
     and coalesce(new.pricing_mode, '') not like 'distance%' then
    raise exception
      'Client % chose per-kilometre pricing but this Karachi parcel was priced flat. Booking refused rather than charging a rate the merchant declined.',
      new.client_id;
  end if;

  return new;
end
$$;
