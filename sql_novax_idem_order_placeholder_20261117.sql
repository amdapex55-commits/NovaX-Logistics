-- Booking key fix (17 Nov 2026). Royal Art typed "None" as the Order ID; the
-- portal keys a booking on "order:<Order ID>", so every later booking with
-- "None" was treated as a resend and returned the old parcel N1500002.
-- 1. A placeholder Order ID (None, N/A, 0, 0000, -, test, ...) gets the parcel
--    details' hash appended to the key, so different parcels never collide
--    while an exact resend still returns the same parcel.
-- 2. A key hit whose parcel has a different phone, city or consignee is not a
--    resend: book a new parcel and point the key at it.
-- Signature unchanged, so grants are unchanged.
CREATE OR REPLACE FUNCTION public.client_book_parcel_idem(p_idem_key text, p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client uuid := public.my_client_id();
  v_key text := left(btrim(coalesce(p_idem_key, '')), 200);
  v_hit public.nv_booking_idempotency;
  v_row public.parcels;
  v_fp text := md5(concat_ws('|',
    lower(btrim(coalesce(p_consignee,''))), regexp_replace(coalesce(p_phone,''), '\D', '', 'g'),
    lower(btrim(coalesce(p_city,''))), lower(btrim(coalesce(p_address,''))),
    coalesce(p_cod,0)::text, lower(btrim(coalesce(p_weight,''))), coalesce(p_payment_mode,''),
    coalesce(p_reference_no,''), coalesce(p_dest_area_id::text,'')));
begin
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;
  if v_key = '' or v_key ~ '[[:cntrl:]]' then
    raise exception 'Booking request key is invalid.';
  end if;
  -- Placeholder order IDs are not real order numbers.
  if v_key ~* '^order:\s*(none|null|nil|n/?a|na|no|nothing|-+|_+|\.+|0+|x+|tbd|tba|test|order|abc|123|1)\s*$' then
    v_key := left(v_key, 150) || ':' || v_fp;
  end if;

  perform pg_advisory_xact_lock(hashtext('novax_idem_' || v_client::text || ':' || v_key));
  select * into v_hit from public.nv_booking_idempotency
   where client_id = v_client and idem_key = v_key;
  if found then
    select * into v_row from public.parcels
     where id = v_hit.parcel_id and client_id = v_client;
    if found and v_row.status is distinct from 'Cancelled by client'
       and regexp_replace(coalesce(v_row.phone,''), '\D', '', 'g') = regexp_replace(coalesce(p_phone,''), '\D', '', 'g')
       and lower(btrim(coalesce(v_row.city,''))) = lower(btrim(coalesce(p_city,'')))
       and lower(btrim(coalesce(v_row.consignee,''))) = lower(btrim(coalesce(p_consignee,''))) then
      return v_row;
    end if;
  end if;

  if p_dest_area_id is not null then
    v_row := public.client_book_parcel_geo(
      p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod,
      p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open, p_origin_area_id, p_dest_area_id);
  else
    v_row := public.client_book_parcel(
      p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod,
      p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open);
  end if;

  insert into public.nv_booking_idempotency (client_id, idem_key, parcel_id, awb)
  values (v_client, v_key, v_row.id, v_row.awb)
  on conflict (client_id, idem_key) do update
    set parcel_id = excluded.parcel_id, awb = excluded.awb, created_at = now();
  return v_row;
end;
$function$;
