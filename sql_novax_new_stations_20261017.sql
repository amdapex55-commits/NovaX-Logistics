-- NovaX new stations, 17 Oct 2026.
-- Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala and
-- Adda Gamber open as DELIVERY destinations, priced as Zone B (novax_quote_fee
-- and nv_book_parcel_core already price every non-Karachi city as B, so no
-- pricing change is needed). Pickup stays the original four cities
-- (nv_signup_provision is untouched).
-- Changes: riders may cover the new cities, each station may be a rider's hub,
-- and the admin Stations overview lists all twelve in launch order.
begin;
CREATE OR REPLACE FUNCTION public.admin_add_rider(p_name text, p_branch text, p_cities text[], p_phone text DEFAULT ''::text, p_limit numeric DEFAULT 75000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_cities text[];
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if length(v_name) < 2 then raise exception 'Enter the rider''s name.'; end if;
  if coalesce(p_branch, '') not in ('Karachi Hub', 'Lahore Hub', 'Islamabad Hub', 'Rawalpindi Hub', 'Faisalabad Hub', 'Multan Hub', 'Sahiwal Hub', 'Okara Hub', 'Chichawatni Hub', 'Harappa Hub', 'Yousuf Wala Hub', 'Adda Gamber Hub') then raise exception 'Choose the rider''s hub.'; end if;
  select coalesce(array_agg(distinct initcap(btrim(c))), '{}') into v_cities from unnest(coalesce(p_cities, '{}')) c
   where lower(btrim(c)) in ('karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'sahiwal', 'okara', 'chichawatni', 'harappa', 'yousuf wala', 'adda gamber');
  if cardinality(v_cities) = 0 then raise exception 'Tick at least one city the rider covers.'; end if;
  if p_limit is null or p_limit < 1000 or p_limit > 2000000 then raise exception 'Enter a cash limit between Rs 1,000 and Rs 20,00,000.'; end if;
  insert into public.riders (name, phone, branch, access, cash_limit, cities, meta)
  values (v_name, btrim(coalesce(p_phone, '')), p_branch, 'Active', round(p_limit), v_cities,
          jsonb_build_object('manager', p_branch || ' Manager', 'cashHeld', 0))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$
;


CREATE OR REPLACE FUNCTION public.admin_set_rider_cities(p_rider uuid, p_cities text[])
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v text[];
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select coalesce(array_agg(distinct initcap(btrim(x))), '{}') into v from unnest(p_cities) x
   where lower(btrim(x)) in ('karachi','lahore','islamabad','rawalpindi','faisalabad','multan','sahiwal','okara','chichawatni','harappa','yousuf wala','adda gamber');
  update public.riders set cities = v where id = p_rider;
  if not found then raise exception 'Rider not found.'; end if;
  return v;
end $function$
;


CREATE OR REPLACE FUNCTION public.admin_station_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (public.is_admin() or public.nv_staff_can('riders')) then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'cities', (select jsonb_agg(jsonb_build_object('city', initcap(cty),
        'to_pickup', (select count(*) from public.parcels p where p.status = 'New booked' and public.nv_parcel_origin(p) = cty and coalesce(p.meta->>'swapLeg','') <> 'back'),
        'incoming', (select count(*) from public.parcels p where p.status = 'Parcel now in transit' and public.nv_parcel_dest(p) = cty),
        'at_station', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status in ('Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned')),
        'out_now', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Parcel out for delivery'),
        'to_send', (select count(*) from public.parcels p where public.nv_parcel_origin(p) = cty and public.nv_parcel_dest(p) <> cty and p.status in ('Collected by rider','Arrived at warehouse')),
        'no_gps_7d', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Delivered'
            and p.delivered_at > now() - interval '7 days' and jsonb_typeof(p.meta->'deliveryLocation'->'lat') is distinct from 'number'),
        'delivered_today', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Delivered' and (p.delivered_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date),
        'riders', (select coalesce(jsonb_agg(jsonb_build_object('name', rd.name, 'access', rd.access)), '[]'::jsonb) from public.riders rd where lower(cty) = any(select lower(x) from unnest(rd.cities) x))
      ) order by u.ord) from unnest(array['karachi','lahore','islamabad','rawalpindi','faisalabad','multan','sahiwal','okara','chichawatni','harappa','yousuf wala','adda gamber']) with ordinality u(cty, ord)),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from', b.from_city, 'to', b.to_city,
        'reference', b.reference, 'sent', cardinality(b.awbs), 'received', cardinality(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at,
        'missing', to_jsonb(array(select a from unnest(b.awbs) a where a <> all(b.received_awbs)))) order by b.sent_at desc), '[]'::jsonb)
      from public.nv_transit_batches b where b.sent_at > now() - interval '14 days'),
    'deposits', (select coalesce(jsonb_agg(jsonb_build_object('rider', rd.name, 'net', d.net, 'method', d.method, 'reference', d.reference, 'at', d.created_at)
        order by d.created_at desc), '[]'::jsonb)
      from public.rider_cash_deposits d join public.riders rd on rd.id = d.rider_id where d.created_at > now() - interval '14 days')
  );
end $function$
;


commit;
