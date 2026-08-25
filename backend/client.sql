-- =====================================================================
-- NovaX backend -- client
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 21 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.client_bank_details() RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_bank jsonb;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  select meta->'bank' into v_bank from public.clients where id = v_client_id;
  if v_bank is null or v_bank = 'null'::jsonb then
    return;
  end if;

  holder_name := v_bank->>'holderName';
  iban := v_bank->>'iban';
  bank_name := v_bank->>'bankName';
  updated_at := nullif(v_bank->>'updatedAt','')::timestamptz;
  return next;
end;
$$;

CREATE FUNCTION public.client_book_parcel(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text) RETURNS public.parcels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_client_id uuid;
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
  v_allow text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;
  if coalesce(btrim(p_consignee), '') = '' then
    raise exception 'Consignee name is required.';
  end if;

  -- Only ever 'Yes' or 'No' — never free text on a rider-facing instruction.
  v_allow := case when lower(coalesce(btrim(p_allow_open), 'no')) in ('yes','true','y','1')
                  then 'Yes' else 'No' end;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || v_client_id::text));

  v_code   := lpad(right(regexp_replace(v_client_id::text, '\D', '', 'g'), 3), 3, '0');
  v_prefix := 'N' || v_code;
  select coalesce(max(substring(pa.awb from length(v_prefix) + 1)::int), 0)
    into v_max
    from public.parcels pa
   where pa.awb ~ ('^' || v_prefix || '[0-9]+$');
  v_awb := v_prefix || lpad((v_max + 1)::text, 4, '0');

  select c.rate, c.rate_card into v_rate, v_rate_card
    from public.clients c where c.id = v_client_id;
  v_rate := coalesce(v_rate, 250);

  v_zone := case when lower(coalesce(p_city, '')) = 'karachi' then 'A' else 'B' end;
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

  v_weight_kg := coalesce(nullif(regexp_replace(coalesce(p_weight, ''), '[^0-9.]', '', 'g'), '')::numeric, 0.8);
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;
  v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_fee      := v_base + (v_extra_kg * v_addl_rate);

  v_meta := jsonb_build_object(
    'source',      'client_portal',
    'pickupCity',  coalesce(p_pickup_city, ''),
    'service',     coalesce(p_service, ''),
    'category',    coalesce(p_category, ''),
    'fragile',     coalesce(p_fragile, 'No'),
    'weight',      coalesce(p_weight, '0.8 kg'),
    'paymentMode', coalesce(p_payment_mode, 'COD'),
    'orderId',     coalesce(p_order_id, ''),
    'referenceNo', coalesce(p_reference_no, ''),
    'allowOpen',   v_allow,                       -- NEW
    'branch',      coalesce(nullif(btrim(p_pickup_city), ''), 'Karachi') || ' Hub',
    'stage',       0,
    'totalStages', 16,
    'steps',       jsonb_build_array('New booked'),
    'statusSince', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.parcels (
    awb, client_id, consignee, phone, address, city, status,
    cod_amount, fee, booked_at, updated_at, meta
  ) values (
    v_awb, v_client_id, btrim(p_consignee), coalesce(p_phone, ''),
    coalesce(p_address, ''), coalesce(p_city, ''), 'New booked',
    coalesce(p_cod, 0), v_fee, v_now, v_now, v_meta
  )
  returning * into v_row;

  return v_row;
end;
$_$;

CREATE FUNCTION public.client_book_parcel_geo(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid) RETURNS public.parcels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row    public.parcels;
  v_client uuid;
  v_origin uuid;
  v_quote  jsonb;
  v_cfg    public.novax_pricing_config;
begin
  -- 1. Book exactly as today. AWB series, advisory lock, flat fee, meta --
  --    all produced by the untouched original function.
  v_row := public.client_book_parcel(
    p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod, p_weight,
    p_service, p_category, p_fragile, p_payment_mode, p_order_id,
    p_reference_no, p_allow_open);

  v_client := v_row.client_id;
  select * into v_cfg from public.novax_pricing_config where id;

  -- 2. Resolve the origin: explicit, else the merchant's default pickup.
  v_origin := p_origin_area_id;
  if v_origin is null then
    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = v_client and l.is_default
     limit 1;
  end if;

  -- 3. Price by distance ONLY when it is switched on and fully resolvable.
  if coalesce(v_cfg.distance_enabled, false)
     and v_origin is not null and p_dest_area_id is not null
     and lower(coalesce(p_city, '')) = 'karachi' then

    v_quote := public.novax_quote_fee(
      v_client, p_city, p_weight, v_origin, p_dest_area_id, 'distance');

    if (v_quote ->> 'mode') = 'distance' then
      update public.parcels
         set fee            = (v_quote ->> 'fee')::numeric,
             quoted_fee     = (v_quote ->> 'fee')::numeric,
             distance_km    = nullif(v_quote ->> 'distance_km', '')::numeric,
             origin_area_id = v_origin,
             dest_area_id   = p_dest_area_id,
             pricing_mode   = 'distance',
             rate_version   = v_quote ->> 'rate_version',
             meta           = coalesce(meta, '{}'::jsonb) || jsonb_build_object('quote', v_quote)
       where id = v_row.id
      returning * into v_row;
      return v_row;
    end if;
  end if;

  -- 4. Not priced by distance. Record the areas and -- when they are known
  --    -- what distance pricing WOULD have charged. This is the shadow
  --    data that answers "is the new curve viable" before switching it on.
  --    The fee itself is not touched.
  if v_origin is not null and p_dest_area_id is not null
     and lower(coalesce(p_city, '')) = 'karachi' then
    v_quote := public.novax_quote_fee(
      v_client, p_city, p_weight, v_origin, p_dest_area_id, 'distance');
  else
    v_quote := null;
  end if;

  update public.parcels
     set origin_area_id = v_origin,
         dest_area_id   = p_dest_area_id,
         distance_km    = nullif(v_quote ->> 'distance_km', '')::numeric,
         pricing_mode   = case when v_quote is null then 'flat' else 'shadow' end,
         quoted_fee     = nullif(v_quote ->> 'fee', '')::numeric,
         rate_version   = coalesce(v_quote ->> 'rate_version', v_cfg.rate_version),
         meta           = case when v_quote is null then meta
                               else coalesce(meta, '{}'::jsonb) || jsonb_build_object('shadowQuote', v_quote) end
   where id = v_row.id
  returning * into v_row;

  return v_row;
end
$$;

CREATE FUNCTION public.client_cancel_booking(p_awb text, p_reason text DEFAULT ''::text) RETURNS public.parcels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_row  public.parcels;
  v_now  timestamptz := now();
  v_note text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;

  if coalesce(btrim(p_awb), '') = '' then
    raise exception 'A tracking number is required to cancel a booking.';
  end if;

  -- Lock the row so two taps cannot both pass the status check.
  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = v_client_id
   for update;

  if not found then
    raise exception 'No booking with tracking number % was found on your account.', btrim(p_awb);
  end if;

  if v_row.status = 'Cancelled by client' then
    return v_row;                      -- already cancelled; idempotent
  end if;

  if v_row.status is distinct from 'New booked' then
    raise exception
      'This parcel can no longer be cancelled here - it is already "%". Once a rider has collected it, please contact NovaX support.',
      v_row.status;
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice, so it cannot be cancelled. Please contact NovaX support.';
  end if;

  -- Manifests store their contents as meta.parcels = ["AWB", "AWB", ...]
  -- (admin.html writes `parcels: parcels.map(p => p.awb)`). Belt-and-braces:
  -- manifesting also flips the status to "Parcel now in transit", so the
  -- status guard above would normally have caught it already.
  if exists (
        select 1 from public.manifest_logs m
         where jsonb_typeof(m.meta -> 'parcels') = 'array'
           and m.meta -> 'parcels' @> to_jsonb(array[v_row.awb::text])
      ) then
    raise exception 'This parcel is already on a manifest, so it cannot be cancelled here.';
  end if;

  v_note := nullif(btrim(p_reason), '');

  update public.parcels
     set status = 'Cancelled by client',
         meta = jsonb_set(
                  jsonb_set(
                    coalesce(meta, '{}'::jsonb),
                    '{steps}',
                    coalesce(meta->'steps', '[]'::jsonb) || to_jsonb('Cancelled by client'::text)
                  ),
                  '{cancelledByClient}',
                  jsonb_build_object(
                    'at',     to_char(v_now at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
                    'reason', coalesce(v_note, '')
                  )
                ),
         updated_at = v_now
   where id = v_row.id
   returning * into v_row;

  return v_row;
end
$$;

CREATE FUNCTION public.client_edit_new_booked_parcel(p_awb text, p_consignee text, p_phone text, p_address text, p_city text, p_cod numeric, p_weight text, p_category text, p_fragile text, p_service text, p_payment_mode text, p_allow_open text, p_order_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client uuid := public.nv_ai_my_client();
  v_row    public.parcels%rowtype;
  v_meta   jsonb;
  v_hist   jsonb;
  v_len    int;
begin
  if v_client is null then
    raise exception 'You are not signed in as a merchant.' using errcode = '28000';
  end if;

  -- Ownership is resolved from the JWT, never from anything the browser sent.
  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = v_client
   for update;

  if not found then
    raise exception 'That parcel is not on your account.' using errcode = 'P0002';
  end if;

  -- The same three conditions as delete_new_booked_parcel / the Cancel button.
  if coalesce(v_row.status, '') <> 'New booked' then
    raise exception
      'This parcel is already "%", so it can no longer be edited. Open a support ticket and our team will change it for you.',
      v_row.status
      using errcode = 'P0001';
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel has already been invoiced, so it can no longer be edited.'
      using errcode = 'P0001';
  end if;

  if coalesce(v_row.rider_id::text, '') <> '' then
    raise exception 'A rider is already assigned to collect this parcel, so it can no longer be edited.'
      using errcode = 'P0001';
  end if;

  -- Required fields. Rejected here rather than being silently reverted by
  -- trg_nv_protect_parcel_contact, so the merchant actually sees why.
  if btrim(coalesce(p_consignee, '')) = '' then
    raise exception 'Consignee name cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_phone, '')) = '' then
    raise exception 'Consignee phone cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_address, '')) = '' then
    raise exception 'Delivery address cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_city, '')) = '' then
    raise exception 'Destination city cannot be empty.' using errcode = 'P0001';
  end if;
  if p_cod is null or p_cod < 0 then
    raise exception 'COD amount must be zero or more.' using errcode = 'P0001';
  end if;

  -- ---- audit trail, inside the parcel's own meta -----------------------
  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  v_hist := coalesce(v_meta -> 'editHistory', '[]'::jsonb);

  v_hist := v_hist || jsonb_build_array(jsonb_build_object(
    'at',   to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'by',   auth.uid(),
    'from', jsonb_build_object(
              'consignee', v_row.consignee,
              'phone',     v_row.phone,
              'address',   v_row.address,
              'city',      v_row.city,
              'cod',       v_row.cod_amount,
              'weight',    v_meta ->> 'weight'),
    'to',   jsonb_build_object(
              'consignee', btrim(p_consignee),
              'phone',     btrim(p_phone),
              'address',   btrim(p_address),
              'city',      btrim(p_city),
              'cod',       p_cod,
              'weight',    btrim(coalesce(p_weight, '')))
  ));

  -- Keep the last 20. meta is carried on every parcel read; an unbounded
  -- array here would grow the payload of every dashboard load forever.
  v_len := jsonb_array_length(v_hist);
  if v_len > 20 then
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb)
      into v_hist
      from jsonb_array_elements(v_hist) with ordinality as t(e, i)
     where i > v_len - 20;
  end if;

  v_meta := v_meta || jsonb_build_object(
    'weight',       btrim(coalesce(p_weight, '')),
    'category',     btrim(coalesce(p_category, '')),
    'fragile',      case when btrim(coalesce(p_fragile, '')) = 'Yes' then 'Yes' else 'No' end,
    'service',      nullif(btrim(coalesce(p_service, '')), ''),
    'paymentMode',  nullif(btrim(coalesce(p_payment_mode, '')), ''),
    'allowOpen',    case when btrim(coalesce(p_allow_open, '')) = 'Yes' then 'Yes' else 'No' end,
    'orderId',      btrim(coalesce(p_order_id, '')),
    'editHistory',  v_hist,
    'lastEditedAt', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI')
  );

  -- Transaction-local. Tells trg_nv_freeze_parcel_money that this specific,
  -- re-checked path is the one changing cod_amount -- a browser doing a raw
  -- UPDATE cannot set this, because it never runs inside this function.
  perform set_config('novax.parcel_edit', '1', true);

  update public.parcels
     set consignee  = btrim(p_consignee),
         phone      = btrim(p_phone),
         address    = btrim(p_address),
         city       = btrim(p_city),
         cod_amount = p_cod,
         meta       = v_meta,
         updated_at = now()
   where id = v_row.id;
  --   fee is NOT in this list, and must never be added to it.

  return jsonb_build_object('ok', true, 'awb', v_row.awb);
end
$$;

CREATE FUNCTION public.client_fee_insights() RETURNS TABLE(payout_fees_month numeric, delivery_fees_month numeric, total_fees_month numeric, withdrawn_month numeric, cost_if_all_standard numeric, cost_if_all_instant numeric, potential_saving numeric, best_speed text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Payout fees actually charged this calendar month.
  -- AUDIT FIX (medium): this had no status filter, so REJECTED withdrawals
  -- counted as fees charged -- but admin_reject_wallet_withdrawal() refunds
  -- the full amount INCLUDING the fee back to wallet_balance. Pending ones
  -- have not been paid at all. Overstating fees to a paying merchant is
  -- exactly the trust failure this card exists to prevent, and it also
  -- inflated the "you would have saved Rs X" nudge. Paid only.
  select coalesce(sum(w.fee), 0), coalesce(sum(w.amount), 0)
    into payout_fees_month, withdrawn_month
    from public.withdrawals w
   where w.client_id = v_client_id
     and w.status = 'Paid'
     and date_trunc('month', w.created_at) = date_trunc('month', now());

  -- Delivery charges booked against this merchant this month.
  select coalesce(sum(p.fee), 0)
    into delivery_fees_month
    from public.parcels p
   where p.client_id = v_client_id
     and p.delivery_charge_posted_at is not null
     and date_trunc('month', p.delivery_charge_posted_at) = date_trunc('month', now());

  total_fees_month := coalesce(payout_fees_month, 0) + coalesce(delivery_fees_month, 0);

  -- What the SAME withdrawal volume would have cost at each speed.
  cost_if_all_standard := round(coalesce(withdrawn_month, 0) * 0.001);
  cost_if_all_instant  := round(coalesce(withdrawn_month, 0) * 0.007);

  potential_saving := greatest(coalesce(payout_fees_month, 0) - coalesce(cost_if_all_standard, 0), 0);

  best_speed := case
    when coalesce(withdrawn_month, 0) = 0 then null
    when payout_fees_month <= cost_if_all_standard then 'already_optimal'
    else 'standard'
  end;

  return next;
end;
$$;

CREATE FUNCTION public.client_generate_shopify_link(p_store_domain text DEFAULT NULL::text) RETURNS TABLE(intake_token text, has_secret boolean, store_url text, disabled boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_intake_token text;
  v_secret text;
  v_store_url text;
  v_disabled boolean;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  select s.intake_token, s.consumer_secret, s.store_url, s.disabled
    into v_intake_token, v_secret, v_store_url, v_disabled
    from public.store_secrets s where s.client_id = v_client_id and s.platform = 'shopify';

  if v_intake_token is null then
    v_intake_token := encode(extensions.gen_random_bytes(24), 'hex');
    v_store_url := coalesce(trim(p_store_domain), '');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (v_client_id, 'shopify', v_store_url, '', '', encode(extensions.gen_random_bytes(32), 'hex'), v_intake_token);
    v_secret := '';
    v_disabled := false;
  elsif p_store_domain is not null and length(trim(p_store_domain)) > 0 then
    update public.store_secrets set store_url = trim(p_store_domain), updated_at = now()
      where client_id = v_client_id and platform = 'shopify';
    v_store_url := trim(p_store_domain);
  end if;

  return query select v_intake_token, (v_secret is not null and length(v_secret) > 0), coalesce(v_store_url, ''), coalesce(v_disabled, false);
end;
$$;

CREATE FUNCTION public.client_get_notification_prefs() RETURNS public.client_notification_prefs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_row public.client_notification_prefs;
begin
  select client_id into v_client_id from public.profiles where id = auth.uid();
  if v_client_id is null then
    raise exception 'No client account linked to this login.';
  end if;
  insert into public.client_notification_prefs (client_id)
  values (v_client_id)
  on conflict (client_id) do nothing;
  select * into v_row from public.client_notification_prefs where client_id = v_client_id;
  return v_row;
end;
$$;

CREATE FUNCTION public.client_pickup_location_save(p_id uuid DEFAULT NULL::uuid, p_label text DEFAULT 'Main pickup'::text, p_address text DEFAULT ''::text, p_city text DEFAULT 'Karachi'::text, p_area_id uuid DEFAULT NULL::uuid, p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric, p_default boolean DEFAULT true) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_client uuid; v_id uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'Not signed in.'; end if;
  if p_area_id is not null and not exists (select 1 from public.novax_areas a where a.id = p_area_id) then
    raise exception 'That pickup area is not recognised.';
  end if;

  if p_id is not null then
    update public.client_pickup_locations
       set label = coalesce(nullif(btrim(p_label), ''), label),
           address = coalesce(p_address, address),
           city = coalesce(nullif(btrim(p_city), ''), city),
           area_id = p_area_id,
           lat = p_lat, lng = p_lng,
           verified_at = case when p_lat is not null then now() else verified_at end,
           updated_at = now()
     where id = p_id and client_id = v_client
     returning id into v_id;
    if v_id is null then raise exception 'Pickup location not found on your account.'; end if;
  else
    insert into public.client_pickup_locations (client_id, label, address, city, area_id, lat, lng, verified_at)
    values (v_client, coalesce(nullif(btrim(p_label), ''), 'Main pickup'), coalesce(p_address, ''),
            coalesce(nullif(btrim(p_city), ''), 'Karachi'), p_area_id, p_lat, p_lng,
            case when p_lat is not null then now() else null end)
    returning id into v_id;
  end if;

  -- Exactly one default, enforced here as well as by the unique index.
  if coalesce(p_default, false) then
    update public.client_pickup_locations set is_default = false
     where client_id = v_client and id <> v_id and is_default;
    update public.client_pickup_locations set is_default = true where id = v_id;
  end if;

  return v_id;
end
$$;

CREATE FUNCTION public.client_pickup_locations_list() RETURNS TABLE(id uuid, label text, address text, city text, area_id uuid, area_name text, lat numeric, lng numeric, is_default boolean, verified_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_client uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then return; end if;
  return query
    select l.id, l.label, l.address, l.city, l.area_id, a.name, l.lat, l.lng, l.is_default, l.verified_at
      from public.client_pickup_locations l
      left join public.novax_areas a on a.id = l.area_id
     where l.client_id = v_client
     order by l.is_default desc, l.created_at;
end
$$;

CREATE FUNCTION public.client_pricing_choice_state() RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_mode      text;
  v_at        timestamptz;
begin
  select c.id, c.pricing_mode, c.pricing_mode_at
    into v_client_id, v_mode, v_at
  from public.profiles pr
  join public.clients  c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('eligible', false, 'reason', 'no_workspace');
  end if;

  if v_at is not null then
    return json_build_object(
      'eligible', false,
      'reason',   'already_chosen',
      'mode',     v_mode,
      'chosen_at', v_at
    );
  end if;

  return json_build_object(
    'eligible', true,
    'reason',   'not_chosen',
    'mode',     coalesce(v_mode, 'flat')
  );
end
$$;

CREATE FUNCTION public.client_review_prompt_state() RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id  uuid;
  v_created    timestamptz;
  v_cutoff     timestamptz;
  v_has_review boolean;
  v_delivered  boolean;
  v_paid_out   boolean;
begin
  -- Identity comes from profiles.client_id -- the same link every other
  -- client-side RPC uses. clients has no auth_user_id column.
  select c.id, c.created_at into v_client_id, v_created
  from public.profiles pr
  join public.clients c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('eligible', false, 'reason', 'no_workspace');
  end if;

  select exists(select 1 from public.reviews r where r.client_id = v_client_id)
    into v_has_review;

  if v_has_review then
    return json_build_object('eligible', false, 'reason', 'already_reviewed');
  end if;

  select cutoff into v_cutoff from public.nv_review_config where id = 1;

  -- Existing merchants: ask straight away.
  if v_created < v_cutoff then
    return json_build_object('eligible', true, 'reason', 'existing_client');
  end if;

  -- New merchants: only after the whole journey has actually completed.
  select exists(
    select 1 from public.parcels p
    where p.client_id = v_client_id and p.status = 'Delivered'
  ) into v_delivered;

  select exists(
    select 1 from public.withdrawals w
    where w.client_id = v_client_id and w.status = 'Paid'
  ) into v_paid_out;

  if v_delivered and v_paid_out then
    return json_build_object('eligible', true, 'reason', 'journey_complete');
  end if;

  return json_build_object(
    'eligible', false, 'reason', 'journey_incomplete',
    'delivered', v_delivered, 'paid_out', v_paid_out
  );
end;
$$;

CREATE FUNCTION public.client_set_notification_prefs(p_whatsapp boolean, p_sms boolean, p_email boolean, p_events jsonb) RETURNS public.client_notification_prefs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_row public.client_notification_prefs;
begin
  select client_id into v_client_id from public.profiles where id = auth.uid();
  if v_client_id is null then
    raise exception 'No client account linked to this login.';
  end if;
  insert into public.client_notification_prefs (client_id, whatsapp_enabled, sms_enabled, email_enabled, events, updated_at)
  values (v_client_id, coalesce(p_whatsapp, true), coalesce(p_sms, false), coalesce(p_email, true), coalesce(p_events, '[]'::jsonb), now())
  on conflict (client_id) do update set
    whatsapp_enabled = coalesce(p_whatsapp, public.client_notification_prefs.whatsapp_enabled),
    sms_enabled = coalesce(p_sms, public.client_notification_prefs.sms_enabled),
    email_enabled = coalesce(p_email, public.client_notification_prefs.email_enabled),
    events = coalesce(p_events, public.client_notification_prefs.events),
    updated_at = now();
  select * into v_row from public.client_notification_prefs where client_id = v_client_id;
  return v_row;
end;
$$;

CREATE FUNCTION public.client_set_pricing_choice(p_choice text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_at        timestamptz;
begin
  if p_choice is null or p_choice not in ('flat','distance') then
    return json_build_object('ok', false, 'error', 'invalid_choice');
  end if;

  select c.id, c.pricing_mode_at
    into v_client_id, v_at
  from public.profiles pr
  join public.clients  c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('ok', false, 'error', 'no_workspace');
  end if;

  perform 1 from public.clients where id = v_client_id for update;

  select pricing_mode_at into v_at from public.clients where id = v_client_id;
  if v_at is not null then
    return json_build_object('ok', false, 'error', 'already_chosen');
  end if;

  update public.clients
     set pricing_mode        = p_choice,
         pricing_mode_at     = now(),
         pricing_mode_source = 'merchant'
   where id = v_client_id;

  return json_build_object('ok', true, 'mode', p_choice);
end
$$;

CREATE FUNCTION public.client_set_shopify_admin_token(p_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  update public.store_secrets
    set consumer_key = coalesce(trim(p_token), ''), updated_at = now()
    where client_id = v_client_id and platform = 'shopify';

  if not found then
    raise exception 'Generate the Shopify link first.';
  end if;
end;
$$;

CREATE FUNCTION public.client_set_shopify_secret(p_secret text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'Paste the Shopify signing secret first.';
  end if;

  update public.store_secrets
    set consumer_secret = trim(p_secret), last_error = null, updated_at = now()
    where client_id = v_client_id and platform = 'shopify';

  if not found then
    raise exception 'Generate the Shopify link first.';
  end if;
end;
$$;

CREATE FUNCTION public.client_set_store_credentials(p_platform text, p_store_url text, p_consumer_key text, p_consumer_secret text) RETURNS TABLE(intake_token text, webhook_secret text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_intake_token text;
  v_webhook_secret text;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  if p_platform is null or p_store_url is null or p_consumer_key is null or p_consumer_secret is null then
    raise exception 'Store URL, consumer key, and consumer secret are all required.';
  end if;

  select intake_token, webhook_secret into v_intake_token, v_webhook_secret
    from public.store_secrets where client_id = v_client_id and platform = p_platform;

  if v_intake_token is null then
    v_intake_token := encode(gen_random_bytes(24), 'hex');
    v_webhook_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (v_client_id, p_platform, p_store_url, p_consumer_key, p_consumer_secret, v_webhook_secret, v_intake_token);
  else
    update public.store_secrets
      set store_url = p_store_url, consumer_key = p_consumer_key, consumer_secret = p_consumer_secret, updated_at = now()
      where client_id = v_client_id and platform = p_platform;
  end if;

  if exists (select 1 from public.store_connections where client_id = v_client_id and platform = p_platform) then
    update public.store_connections
      set store_url = p_store_url, connected = true,
          meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('hasCreds', true, 'connectedAt', now()::text)
      where client_id = v_client_id and platform = p_platform;
  else
    insert into public.store_connections (client_id, platform, store_url, connected, meta)
    values (v_client_id, p_platform, p_store_url, true, jsonb_build_object('hasCreds', true, 'connectedAt', now()::text));
  end if;

  return query select v_intake_token, v_webhook_secret;
end;
$$;

CREATE FUNCTION public.client_shopify_status() RETURNS TABLE(intake_token text, has_secret boolean, has_admin_token boolean, store_url text, disabled boolean, last_order_at timestamp with time zone, last_order_awb text, last_signature_fail_at timestamp with time zone, last_error text, last_event text, imported_count integer, connection_status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  return query
    select s.intake_token,
           (s.consumer_secret is not null and length(s.consumer_secret) > 0),
           (s.consumer_key is not null and length(s.consumer_key) > 0),
           coalesce(s.store_url, ''),
           s.disabled,
           s.last_order_at,
           s.last_order_awb,
           s.last_signature_fail_at,
           s.last_error,
           s.last_event,
           s.imported_count,
           case
             when s.disabled then 'Disabled'
             when s.imported_count > 0 then 'Live'
             when s.last_signature_fail_at is not null then 'Signature failed'
             when s.consumer_secret is not null and length(s.consumer_secret) > 0 then 'Waiting for first order'
             when s.intake_token is not null then 'Secret needed'
             else 'Setup pending'
           end
    from public.store_secrets s
    where s.client_id = v_client_id and s.platform = 'shopify';
end;
$$;

CREATE FUNCTION public.client_smart_insights() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_out       jsonb := '[]'::jsonb;
  v_stuck     jsonb;
  r           record;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- ---- Insight 1: destination cities where failure rate has spiked. -----
  -- Requires at least 8 parcels in the recent window and 12 in the
  -- baseline, so a merchant with 3 parcels never gets a scary "300%
  -- increase" alert off statistical noise.
  for r in
    select city,
           recent_fail, recent_total, base_fail, base_total,
           round((recent_fail::numeric / nullif(recent_total, 0)) * 100) as recent_pct,
           round((base_fail::numeric   / nullif(base_total, 0))   * 100) as base_pct
      from (
        select p.city,
               count(*) filter (
                 where p.booked_at >= now() - interval '7 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as recent_fail,
               count(*) filter (where p.booked_at >= now() - interval '7 days') as recent_total,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as base_fail,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
               ) as base_total
          from public.parcels p
         where p.client_id = v_client_id
           and p.booked_at >= now() - interval '35 days'
           and coalesce(p.city, '') <> ''
         group by p.city
      ) s
     where recent_total >= 8
       and base_total   >= 12
       and (recent_fail::numeric / nullif(recent_total, 0))
           > (base_fail::numeric / nullif(base_total, 0)) * 1.5
       and (recent_fail::numeric / nullif(recent_total, 0)) >= 0.15
     order by recent_fail desc
     limit 3
  loop
    v_out := v_out || jsonb_build_object(
      'kind',     'anomaly_city',
      'severity', case when r.recent_pct >= 30 then 'high' else 'medium' end,
      'title',    r.city || ': failed deliveries are up',
      'body',     'Failed or refused deliveries in ' || r.city || ' are running at '
                  || r.recent_pct || '% this week, against ' || r.base_pct
                  || '% over the previous four weeks (' || r.recent_fail
                  || ' of ' || r.recent_total || ' parcels).',
      'action',   'open_ticket'
    );
  end loop;

  -- ---- Insight 2: parcels that have not moved in over 72 hours. --------
  select jsonb_build_object(
           'kind',     'stuck_parcels',
           'severity', case when count(*) >= 5 then 'high' else 'medium' end,
           'title',    count(*) || ' parcel(s) have not moved in 3 days',
           'body',     'These parcels have had no status change for over 72 hours: '
                       || string_agg(t.awb, ', ' order by t.updated_at asc),
           'action',   'open_ticket'
         )
    into v_stuck
    from (
      select p.awb, p.updated_at
        from public.parcels p
       where p.client_id = v_client_id
         and p.status not in (
           'Delivered', 'Parcel returned to consignee', 'Ready for return',
           'Return received at origin'
         )
         and p.updated_at < now() - interval '72 hours'
       order by p.updated_at asc
       limit 10
    ) t
   having count(*) > 0;

  if v_stuck is not null then
    v_out := v_out || v_stuck;
  end if;

  return v_out;
exception
  -- An insight panel must never be able to take the dashboard down.
  -- AUDIT FIX (low): but silently swallowing everything meant future
  -- schema drift here would be undetectable -- the panel would just stop
  -- appearing forever. Log it, then still fail safe.
  when others then
    raise warning 'client_smart_insights failed: %', sqlerrm;
    return '[]'::jsonb;
end;
$$;

CREATE FUNCTION public.client_wallet_incoming() RETURNS TABLE(in_transit_amount numeric, in_transit_count integer, delivered_uncleared numeric, delivered_uncleared_count integer, on_the_way_amount numeric, available_balance numeric, inflow_4w jsonb, outflow_4w jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Money still moving toward the merchant: booked through to out-for-
  -- delivery, plus the recoverable exception states that can still convert
  -- to a delivery. Return-flow statuses are excluded because that COD is
  -- never going to be collected.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into in_transit_amount, in_transit_count
    from public.parcels p
   where p.client_id = v_client_id
     and coalesce(p.cod_amount, 0) > 0
     and p.status in (
       'New booked', 'Collected by rider', 'Arrived at warehouse',
       'Parcel now in transit', 'Parcel received at destination',
       'Parcel out for delivery', 'Reattempt', 'Reassigned',
       'Consignee not available'
     );

  -- Delivered and collected, but not yet turned into an invoice credit.
  select coalesce(sum(p.cod_amount), 0), count(*)
    into delivered_uncleared, delivered_uncleared_count
    from public.parcels p
   where p.client_id = v_client_id
     and p.status = 'Delivered'
     and coalesce(p.cod_amount, 0) > 0
     and p.invoice_id is null;

  on_the_way_amount := coalesce(in_transit_amount, 0) + coalesce(delivered_uncleared, 0);

  select coalesce(c.wallet_balance, 0)
    into available_balance
    from public.clients c
   where c.id = v_client_id;

  -- Last 4 completed weeks of real wallet movement, straight from the
  -- ledger (money in) and paid withdrawals (money out).
  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into inflow_4w
    from (
      -- AUDIT FIX (low): pin bucketing to UTC. The browser builds its four
      -- Monday buckets in UTC; date_trunc() alone uses the DB session
      -- timezone, so if that is ever changed from the Supabase default,
      -- Sunday-evening PKT money would be drawn in the wrong week.
      select date_trunc('week', l.created_at at time zone 'UTC')::date as wk,
             coalesce(sum(l.amount), 0) as amt
        from public.wallet_ledger l
       where l.client_id = v_client_id
         and l.entry_type = 'invoice_credit'
         and l.created_at >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  select coalesce(jsonb_agg(jsonb_build_object('week_start', wk, 'amount', amt) order by wk), '[]'::jsonb)
    into outflow_4w
    from (
      select date_trunc('week', coalesce(w.paid_at, w.created_at) at time zone 'UTC')::date as wk,
             coalesce(sum(w.net), 0) as amt
        from public.withdrawals w
       where w.client_id = v_client_id
         and w.status = 'Paid'
         and coalesce(w.paid_at, w.created_at) >= date_trunc('week', now() at time zone 'UTC') - interval '3 weeks'
       group by 1
    ) s;

  return next;
end;
$$;

CREATE FUNCTION public.client_wallet_summary() RETURNS TABLE(available_balance numeric, pending_payout numeric, paid_this_month numeric, lifetime_withdrawn numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  select coalesce(c.wallet_balance,0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Pending admin payout'), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'
      and date_trunc('month', coalesce(w.paid_at, w.created_at)) = date_trunc('month', now())), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'), 0)
  into available_balance, pending_payout, paid_this_month, lifetime_withdrawn
  from public.clients c where c.id = v_client_id;

  return next;
end;
$$;
