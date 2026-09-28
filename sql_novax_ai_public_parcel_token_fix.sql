-- 28 Sep 2026: the tracking-page AI never found a parcel.
-- ai_public_parcel matched p.meta->>'trackingToken', which no parcel has
-- (0 of 1,018); the token lives in parcels.tracking_token, which is what
-- public_track_parcel uses. Every buyer question on a tracking link got
-- "I could not find a parcel for that tracking link".
-- Same token rule as public_track_parcel; consignee reduced to first name to
-- match what the tracking page itself shows.
create or replace function public.ai_public_parcel(p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r jsonb; tok text;
begin
  tok := btrim(coalesce(p_token,''));
  if tok = '' then return jsonb_build_object('error','no_token'); end if;
  if length(tok) < 20 then return jsonb_build_object('found', false); end if;

  select jsonb_build_object(
           'awb', p.awb,
           'status', p.status,
           'city', p.city,
           'consignee', nullif(split_part(btrim(coalesce(p.consignee,'')),' ',1),''),
           'cod_amount', coalesce(p.cod_amount,0),
           'booked_at', p.booked_at,
           'last_update', p.updated_at,
           'hours_since_update',
             round(extract(epoch from (now() - p.updated_at)) / 3600.0, 1),
           'merchant', c.name)
    into r
    from public.parcels p
    left join public.clients c on c.id = p.client_id
   where p.tracking_token is not null
     and p.tracking_token = tok
   limit 1;

  if r is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'parcel', r);
end
$function$;
