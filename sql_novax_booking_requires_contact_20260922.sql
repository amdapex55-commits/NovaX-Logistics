-- NovaX: a parcel with no phone and no address is not a booking.
--
-- client_book_parcel() validated the consignee name and the COD amount but
-- wrote coalesce(p_phone,'') and coalesce(p_address,''), so it would happily
-- create an AWB with neither. The portal noticed AFTER the fact and toasted
-- "Booked as N..., but the phone and address did not save. Open Edit and add
-- it before printing." -- by which point a dispatchable, undeliverable parcel
-- already existed and a rider could be sent for it.
--
-- The check belongs here, not in the browser: this function is SECURITY
-- DEFINER, so any authenticated merchant can call it directly with whatever
-- they like, and bulk CSV import plus the geo/idem wrappers all land here.
-- client_book_parcel_geo and client_book_parcel_idem delegate to this
-- function, so they are covered WITHOUT touching their signatures -- changing
-- that three-function chain on a live portal is a bigger risk than the bug.
-- The browser's post-booking check stays as a safety net that should now
-- never fire.
--
-- Checked before applying: every parcel booked in September carries a phone
-- and an address. The 298 blank-contact rows are all July/August and all
-- terminal, so nothing in flight relies on the old permissiveness.

CREATE OR REPLACE FUNCTION public.client_book_parcel(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- A parcel with no phone and no address is not a booking, it is a parcel
  -- nobody can deliver. This used to be written as coalesce(p_phone,'') and
  -- caught only AFTER the commit, by the browser, which then asked the
  -- merchant to open Edit and fix a parcel that was already dispatchable.
  if coalesce(btrim(p_phone), '') = '' then
    raise exception 'A contact phone is required so the rider can reach the consignee.'
      using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_address), '') = '' then
    raise exception 'A delivery address is required.'
      using errcode = 'P0001';
  end if;

  -- 'Infinity' and 'NaN' are valid numerics in Postgres; neither is a COD.
  if p_cod is not null and (p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric) then
    raise exception 'COD amount must be a number, zero or more.' using errcode = 'P0001';
  end if;

  -- Same guard as nv_book_parcel_core. This function does NOT delegate to the
  -- core -- it is its own implementation -- so guarding only the core left the
  -- portal path open. And the booking form deriving the payment mode from the
  -- COD amount is not a guard: client_book_parcel is SECURITY DEFINER and any
  -- authenticated merchant can call the RPC directly with whatever it likes.
  -- client_book_parcel_geo delegates here, so it is covered by this.
  if public.nv_is_payment_conflict(p_payment_mode, p_cod) then
    raise exception
      'This parcel is marked "%" but carries a COD amount of Rs %. A prepaid parcel collects nothing at the door. Set COD to 0, or change the payment mode to COD.',
      btrim(p_payment_mode), trim(to_char(p_cod, 'FM999,999,999'))
      using errcode = 'P0001';
  end if;

  -- Only ever 'Yes' or 'No' — never free text on a rider-facing instruction.
  v_allow := case when lower(coalesce(btrim(p_allow_open), 'no')) in ('yes','true','y','1')
                  then 'Yes' else 'No' end;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || v_client_id::text));

  v_awb := public.nv_next_awb(v_client_id);

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

  v_weight_kg := public.nv_parse_weight_kg(p_weight);
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
$function$;
