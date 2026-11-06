-- 6 Nov 2026: a rider who types a tracking number that is not on his list
-- was told only "Not at your station". N8530344 and N9830081 were physically
-- with the Rawalpindi rider, but the office had marked them "Out of service
-- area" (Daultala, Wah Cantt), which takes a parcel off every rider list.
-- This tells the rider the real state and the office's reason, for parcels
-- going to or coming from his own cities only. No customer details.
create or replace function public.rider_awb_why(p_awbs text[])
 returns table(awb text, status text, city text, reason text, changed_at timestamptz)
 language sql stable security definer set search_path to ''
as $function$
  select p.awb, p.status, p.city, nullif(btrim(coalesce(p.exception,'')),''), p.updated_at
    from public.parcels p
    join public.riders r on r.id = public.my_rider_id()
   where public.my_rider_id() is not null
     and upper(p.awb) = any (select upper(x) from unnest(p_awbs[1:60]) x)
     and (lower(p.city) = any (select lower(c) from unnest(r.cities) c)
          or lower(coalesce(nullif(p.meta->>'pickupCity',''), p.meta->>'origin','')) = any (select lower(c) from unnest(r.cities) c));
$function$;
revoke all on function public.rider_awb_why(text[]) from public, anon;
grant execute on function public.rider_awb_why(text[]) to authenticated;

-- 6 Nov 2026 (owner): "don't change the status yet, at least show them on the
-- rider's app". Parcels the office marked "Out of service area" for the
-- rider's own cities, with what he needs to identify the parcel in his hand
-- and the office's reason. Read only: the app offers no action on them.
create or replace function public.rider_out_of_area()
 returns table(awb text, consignee text, city text, address text, phone text, cod_amount numeric,
               payment_mode text, shop text, reason text, changed_at timestamptz)
 language sql stable security definer set search_path to ''
as $function$
  select p.awb, p.consignee, p.city, p.address, p.phone, p.cod_amount, p.meta->>'paymentMode', c.name,
         nullif(btrim(coalesce(p.exception,'')),''),
         coalesce((select max(l.changed_at) from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = p.status), p.updated_at)
    from public.parcels p
    join public.riders r on r.id = public.my_rider_id()
    left join public.clients c on c.id = p.client_id
   where public.my_rider_id() is not null
     and p.status = 'Out of service area'
     and lower(p.city) = any (select lower(x) from unnest(r.cities) x)
   order by 10 desc
   limit 100;
$function$;
revoke all on function public.rider_out_of_area() from public, anon;
grant execute on function public.rider_out_of_area() to authenticated;
