-- 27 Oct 2026: Lahore hub.
--   Karachi head office marks a parcel for any other city "in transit": it now
--   goes in the KAR-LAH sack (meta.hub = Lahore). The Lahore rider receives
--   it (status stays "Parcel now in transit", meta.atHub = Lahore, the sack is
--   marked received) and it waits in his Transit tab; he sends each city its
--   own batch (meta.viaHub, new transitBatch), and that city receives as before.
--   Customers and merchants keep seeing "in transit" the whole way.
-- Rehearse in BEGIN/ROLLBACK. Re-running is safe.
-- The hub a forward leg travels through. 27 Oct 2026 (owner): every parcel
-- picked up in Karachi for another city goes to Lahore first; Lahore sends
-- each city its own batch. Returns are unchanged. Edit here to change routes.
create or replace function public.nv_hub_city(p_from text, p_to text)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_from,''))) = 'karachi'
               and lower(btrim(coalesce(p_to,''))) not in ('', 'karachi', 'lahore') then 'lahore' end
$$;

CREATE OR REPLACE FUNCTION public.nv_auto_transit_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_from text; v_to text; v_code text; v_kind text; v_hub text;
begin
  if new.status not in ('Parcel now in transit','Return in transit') or old.status is not distinct from new.status then return new; end if;
  if coalesce(new.meta->>'transitBatch','') <> '' then return new; end if;
  v_kind := case when new.status = 'Return in transit' then 'return' else 'forward' end;
  v_from := case when v_kind = 'return' then lower(btrim(coalesce(new.city,''))) else lower(coalesce(nullif(btrim(new.meta->>'pickupCity'),''),'karachi')) end;
  v_to   := case when v_kind = 'return' then lower(coalesce(nullif(btrim(new.meta->>'pickupCity'),''),'karachi')) else lower(btrim(coalesce(new.city,''))) end;
  if v_from = '' or v_to = '' or v_from = v_to then return new; end if;
  -- 27 Oct 2026: forward legs travel to the hub first (one Karachi sack to
  -- Lahore); the hub rider receives them and sends each city its own batch.
  if v_kind = 'forward' then
    v_hub := public.nv_hub_city(v_from, v_to);
    if v_hub is not null and v_hub <> v_to then
      v_to := v_hub;
      new.meta := coalesce(new.meta,'{}'::jsonb) || jsonb_build_object('hub', initcap(v_hub));
    end if;
  end if;
  v_code := upper(left(regexp_replace(v_from,'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(v_to,'[^a-z]','','g'),3)) || '-' ||
            to_char(now() at time zone 'Asia/Karachi','MMDD') || '-HO' || case when v_kind = 'return' then 'R' else '' end;
  insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs)
  values (v_code, v_kind, initcap(v_from), initcap(v_to), null, 'Head office dispatch', array[upper(new.awb)])
  on conflict (code) do update
     set awbs = (select array_agg(distinct x) from unnest(public.nv_transit_batches.awbs || array[upper(new.awb)]) x),
         status = case when public.nv_transit_batches.status = 'Received' then 'Partly received' else public.nv_transit_batches.status end;
  new.meta := coalesce(new.meta,'{}'::jsonb) || jsonb_build_object('transitBatch', v_code, 'transitRef', 'Head office dispatch');
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.nv_rider_station_stamp(p_rider uuid, p_cities text[])
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select md5(
    coalesce((select string_agg(p.id::text || '|' || p.status || '|' || coalesce(p.rider_id::text, '') || '|' || coalesce(p.updated_at::text, '')
                || '|' || coalesce(p.status_since::text, '') || '|' || coalesce(p.cod_amount::text, '') || '|' || md5(coalesce(p.address, '') || coalesce(p.phone, '')), ',' order by p.id)
       from public.parcels p
      where (public.nv_parcel_origin(p) = any(p_cities) or public.nv_parcel_dest(p) = any(p_cities) or p.rider_id = p_rider
             or lower(coalesce(p.meta->>'hub','')) = any(p_cities) or lower(coalesce(p.meta->>'atHub','')) = any(p_cities))
        and (p.status not in ('Delivered','Return to shipper','Cancelled') or p.updated_at > now() - interval '37 hours')), '')
    || '#' || coalesce((select string_agg(b.code || b.status || coalesce(cardinality(b.received_awbs), 0)::text, ',' order by b.code)
       from public.nv_transit_batches b
      where (lower(b.to_city) = any(p_cities) and b.status <> 'Received') or (b.rider_id = p_rider and b.sent_at > now() - interval '3 days')), '')
    || '#' || coalesce((select max(cr.created_at)::text from public.nv_customer_replies cr where cr.created_at > now() - interval '4 days'), '')
    || '#' || coalesce((select max(x.created_at)::text from public.scans x where x.rider_id = p_rider and x.created_at > now() - interval '1 day'), ''))
$function$;

CREATE OR REPLACE FUNCTION public.rider_station_view()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities(); rr public.riders; out jsonb;
begin
  select * into rr from public.riders where id = r;
  with base as (
    select p.*, public.nv_parcel_origin(p) o, public.nv_parcel_dest(p) d from public.parcels p
     where public.nv_parcel_origin(p) = any(c) or public.nv_parcel_dest(p) = any(c)
        or (p.rider_id = r and p.status in ('Parcel out for delivery','Return out for delivery'))
        or lower(coalesce(p.meta->>'hub','')) = any(c) or lower(coalesce(p.meta->>'atHub','')) = any(c)
  ), tagged as (
    select b.*, case
      when b.status = 'New booked' and b.o = any(c) and coalesce(b.meta->>'swapLeg','') <> 'back' then 'pickup'
      -- 27 Oct 2026, Lahore hub: on its way to the hub, then waiting at the hub to be sent on
      when b.status = 'Parcel now in transit' and lower(coalesce(b.meta->>'atHub','')) = any(c) and not (b.d = any(c)) then 'transit'
      when b.status = 'Parcel now in transit' and lower(coalesce(b.meta->>'hub','')) = any(c) and nullif(b.meta->>'atHub','') is null and not (b.d = any(c)) then 'incoming'
      when b.status = 'Parcel now in transit' and b.d = any(c) and not (b.o = any(c)) then 'incoming'
      when b.status = 'Return in transit' and b.o = any(c) and not (b.d = any(c)) then 'incoming'
      when b.status in ('Collected by rider','Arrived at warehouse') and b.o = any(c) and not (b.d = any(c)) then 'transit'
      when b.status in ('Collected by rider','Arrived at warehouse') and b.o = any(c) and b.d = any(c) then 'station'
      when b.status = 'Ready for return' and b.d = any(c) and not (b.o = any(c)) then 'transit'
      when b.status = 'Ready for return' and b.d = any(c) and b.o = any(c) then 'station'
      when b.status in ('Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned') and b.d = any(c) then 'station'
      when b.status = 'Return received at origin' and b.o = any(c) then 'station'
      when b.status = 'Parcel out for delivery' and b.d = any(c) and public.nv_rider_can_take(b.rider_id, b.d, r) then 'out'
      when b.status = 'Return out for delivery' and b.o = any(c) and public.nv_rider_can_take(b.rider_id, b.o, r) then 'out'
      when b.status in ('Parcel out for delivery','Return out for delivery') and b.rider_id = r then 'out'
      when b.status = 'Delivered' and b.rider_id = r and b.updated_at > now() - interval '36 hours' then 'done'
      else null end as bucket
      from base b
  )
  select jsonb_build_object(
    'rider', jsonb_build_object('id', rr.id, 'name', rr.name, 'branch', rr.branch, 'cities', to_jsonb(rr.cities), 'cash_limit', rr.cash_limit),
    'parcels', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'awb', t.awb, 'client_id', t.client_id, 'consignee', t.consignee, 'phone', t.phone, 'address', t.address,
        'city', t.city, 'origin', initcap(t.o), 'cod_amount', t.cod_amount, 'status', t.status, 'bucket', t.bucket,
        'status_since', t.status_since, 'updated_at', t.updated_at, 'delivered_at', t.delivered_at, 'rider_id', t.rider_id,
        'held_by', case when t.rider_id is not null and t.rider_id <> r then (select x.name from public.riders x where x.id = t.rider_id) end,
        'outside', not (t.o = any(c) or t.d = any(c)),
        -- 14 Oct 2026: only what the app reads (the full meta, mostly processHistory, was 3/4 of a 310 KB refresh)
        'meta', (select coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb) from jsonb_each(t.meta) e(k, v)
                  where e.k in ('paymentMode','payment_mode','swapLeg','swapPairAwb','swapId','recover','pickupContact','weight','steps',
                                'nextAttempt','transitBatch','hub','atHub','viaHub','category','orderId','cashReceived','cashDepositStatus','comments','allowOpen','fragile')),
        'exception', t.exception,
        'customer_reply', (select jsonb_build_object('choice', cr.choice, 'note', cr.note, 'at', cr.created_at)
                             from public.nv_customer_replies cr
                            where cr.parcel_id = t.id and cr.created_at > now() - interval '4 days'
                            order by cr.created_at desc limit 1),
        'attempts', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = t.id and l.to_status = 'Parcel out for delivery'),
        'shipper', (select jsonb_build_object('name', cl.name, 'phone', cl.phone,
                       'address', coalesce(nullif(btrim(pr.pickup_address),''), cl.address),
                       'from_request', pr.id is not null, 'requested_for', pr.requested_for, 'note', pr.note)
                      from public.clients cl
                      left join lateral (select q.id, q.pickup_address, q.requested_for, q.note from public.pickup_requests q
                                          where t.bucket = 'pickup' and q.client_id = t.client_id and q.awbs ? t.awb
                                            and coalesce(q.status,'') not in ('Picked Up','Cancelled','Completed')
                                          order by q.created_at desc limit 1) pr on true
                     where cl.id = t.client_id)
      ) order by t.bucket, t.status_since) from tagged t where t.bucket is not null), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from_city', b.from_city, 'to_city', b.to_city,
        'reference', b.reference, 'awbs', to_jsonb(b.awbs), 'received', to_jsonb(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at)
        order by b.sent_at desc)
      from public.nv_transit_batches b
      where (lower(b.to_city) = any(c) and b.status <> 'Received') or (b.rider_id = r and b.sent_at > now() - interval '3 days')), '[]'::jsonb),
    'route', public.nv_rider_route(r, (now() at time zone 'Asia/Karachi')::date),
    'stamp', public.nv_rider_station_stamp(r, c),
    'server_time', now()
  ) into out;
  return out;
end $function$;

CREATE OR REPLACE FUNCTION public.rider_station_action(p_awbs text[], p_action text, p_reason text DEFAULT ''::text, p_key text DEFAULT NULL::text, p_loc jsonb DEFAULT NULL::jsonb, p_extra jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities();
  codes text[]; code text; p public.parcels; o text; d text; target text; targets text[] := '{}';
  res jsonb; m jsonb; h jsonb; steps jsonb; lat numeric; lng numeric; moved text[] := '{}';
  v_to text; v_ref text; v_kind text; v_batch text; v_attempts int; i int := 0; v_next text; v_next_d date;
  v_from text; v_froms text[] := '{}'; v_n int; v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_pat text := '(non\s*-?\s*cod|prepaid|^paid$)';
  v_loc jsonb;
begin
  if cardinality(c) = 0 then raise exception 'No city is set on your rider account. Ask the office to set it.'; end if;
  if p_key is null or length(p_key) < 16 or length(p_key) > 200 or p_key ~ '[[:cntrl:]]' then raise exception 'Reference is invalid.'; end if;
  if p_action is null or p_action not in ('collect','receive','out','delivered','reattempt','refused','not_available','transit') then raise exception 'Unknown action.'; end if;
  if p_awbs is null or cardinality(p_awbs) < 1 or cardinality(p_awbs) > 200 then raise exception 'Choose between 1 and 200 parcels.'; end if;
  select array_agg(distinct upper(btrim(a)) order by upper(btrim(a))) into codes from unnest(p_awbs) a where btrim(coalesce(a,'')) <> '';
  if codes is null then raise exception 'No AWB given.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select x.result into res from public.rider_batches x where x.batch_key = p_key and x.rider_id = r;
  if found then return res; end if;
  if p_action in ('refused','not_available','reattempt') and nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'Choose a reason.'; end if;
  if length(coalesce(p_reason,'')) > 160 then raise exception 'Reason is too long.'; end if;
  if p_loc is not null then
    if coalesce(p_loc->>'unavailable','false') = 'true' then
      null;
    elsif jsonb_typeof(p_loc->'lat') = 'number' and jsonb_typeof(p_loc->'lng') = 'number' then
      lat := (p_loc->>'lat')::numeric; lng := (p_loc->>'lng')::numeric;
      if abs(lat) > 90 or abs(lng) > 180 then raise exception 'GPS coordinates are out of range.'; end if;
      if p_loc ? 'accuracy' and (jsonb_typeof(p_loc->'accuracy') <> 'number' or (p_loc->>'accuracy')::numeric < 0 or (p_loc->>'accuracy')::numeric > 100000) then
        raise exception 'GPS accuracy is invalid.';
      end if;
    else
      raise exception 'Invalid GPS data.';
    end if;
    v_loc := public.nv_gps_clean(p_loc);
  end if;
  if p_action = 'reattempt' then
    v_next := btrim(coalesce(p_extra->>'next_date',''));
    if v_next !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose the next delivery date.'; end if;
    begin v_next_d := v_next::date; exception when others then raise exception 'Choose the next delivery date.'; end;
    if v_next_d < v_today or v_next_d > v_today + 14 then raise exception 'The next delivery date must be between today and 14 days from now.'; end if;
  end if;
  if p_action = 'transit' then
    v_to := lower(btrim(coalesce(p_extra->>'to_city','')));
    v_ref := btrim(coalesce(p_extra->>'reference',''));
    if v_to = '' then raise exception 'Choose the city this batch is going to.'; end if;
    if length(v_ref) < 2 then raise exception 'Enter the bus or courier reference (bilty number).'; end if;
    if length(v_ref) > 80 then raise exception 'Reference is too long.'; end if;
  end if;

  perform id from public.parcels where upper(awb) = any(codes) order by id for update;

  -- validate everything first: all or nothing
  foreach code in array codes loop
    select * into p from public.parcels where upper(awb) = code;
    if not found then raise exception '%: no such AWB.', code; end if;
    o := public.nv_parcel_origin(p); d := public.nv_parcel_dest(p);
    target := case p_action
      when 'collect' then case when p.status = 'New booked' and o = any(c) and coalesce(p.meta->>'swapLeg','') <> 'back'
                               then case when d = any(c) then 'Parcel received at destination' else 'Collected by rider' end end
      when 'receive' then case
                               when p.status = 'Parcel now in transit' and lower(coalesce(p.meta->>'hub','')) = any(c)
                                    and nullif(p.meta->>'atHub','') is null and not (d = any(c)) then 'Parcel now in transit'
                               when p.status = 'Parcel now in transit' and d = any(c) and not (o = any(c)) then 'Parcel received at destination'
                               when p.status = 'Return in transit' and o = any(c) then 'Return received at origin' end
      when 'out' then case
                               when p.status in ('Parcel received at destination','Reattempt','Reassigned','Refused','Consignee not available') and d = any(c) then 'Parcel out for delivery'
                               when p.status in ('Collected by rider','Arrived at warehouse') and o = any(c) and d = any(c) then 'Parcel out for delivery'
                               when p.status = 'Return received at origin' and o = any(c) then 'Return out for delivery'
                               when p.status = 'Ready for return' and o = any(c) and d = any(c) then 'Return out for delivery' end
      when 'delivered' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Delivered'
                                 when p.status = 'Return out for delivery' and (p.rider_id = r or (o = any(c) and public.nv_rider_can_take(p.rider_id, o, r))) then 'Return to shipper' end
      when 'reattempt' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Reattempt' end
      when 'refused' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Refused' end
      when 'not_available' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Consignee not available'
                                     -- a return nobody took back goes back to the origin station, still a return
                                     when p.status = 'Return out for delivery' and (p.rider_id = r or (o = any(c) and public.nv_rider_can_take(p.rider_id, o, r))) then 'Return received at origin' end
      when 'transit' then case
                               when p.status = 'Parcel now in transit' and lower(coalesce(p.meta->>'atHub','')) = any(c)
                                    and d = v_to and not (d = any(c)) then 'Parcel now in transit'
                               when p.status in ('Collected by rider','Arrived at warehouse') and o = any(c) and d = v_to and not (d = any(c)) then 'Parcel now in transit'
                               when p.status = 'Ready for return' and d = any(c) and o = v_to and not (o = any(c)) then 'Return in transit' end
    end;
    if target is null then
      -- two riders, one station: say who has it, or that the step is already done
      if p.status in ('Parcel out for delivery','Return out for delivery') and p_action in ('out','delivered','reattempt','refused','not_available') then
        if p.rider_id = r then raise exception '%: you already have this parcel out for delivery. Refresh your list.', p.awb; end if;
        raise exception '%: % has this parcel out for delivery. Refresh your list.', p.awb,
          coalesce((select x.name from public.riders x where x.id = p.rider_id), 'Another rider');
      end if;
      if p_action = 'collect' and p.status in ('Collected by rider','Arrived at warehouse','Parcel received at destination','Parcel now in transit','Parcel out for delivery') then
        raise exception '%: already collected. Refresh your list.', p.awb;
      end if;
      if p_action = 'receive' and p.status in ('Parcel received at destination','Return received at origin','Parcel out for delivery','Return out for delivery') then
        raise exception '%: already received at the station. Refresh your list.', p.awb;
      end if;
      if p_action = 'transit' and p.status in ('Parcel now in transit','Return in transit') then
        raise exception '%: already sent in a batch. Refresh your list.', p.awb;
      end if;
      raise exception '%: cannot do "%" -- it is "%" (from % to %).', p.awb, p_action, p.status, initcap(o), initcap(d);
    end if;
    if p_action in ('reattempt','out') and target in ('Reattempt','Parcel out for delivery') then
      select count(*) into v_attempts from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = 'Parcel out for delivery';
      if p_action = 'reattempt' and v_attempts >= 3 then
        raise exception '%: 3 delivery attempts already. Mark it Refused so it goes back to the shipper.', p.awb;
      end if;
      if p_action = 'out' and v_attempts >= 3 then
        raise exception '%: already taken out 3 times. It goes back to the shipper -- ask the office to start the return.', p.awb;
      end if;
      if p_action = 'out' and p.status = 'Reattempt' and coalesce(p.meta->>'nextAttempt','') ~ '^\d{4}-\d{2}-\d{2}$'
         and (p.meta->>'nextAttempt')::date > v_today and coalesce(p_extra->>'early','') <> 'true' then
        raise exception '%: the customer asked for %. Confirm in the app to take it out early.', p.awb, to_char((p.meta->>'nextAttempt')::date, 'DD Mon');
      end if;
    end if;
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0
       and (btrim(coalesce(p.meta->>'paymentMode','')) ~* v_pat or btrim(coalesce(p.meta->>'payment_mode','')) ~* v_pat) then
      raise exception '%: COD/prepaid conflict. Contact the office.', p.awb;
    end if;
    if p_action = 'delivered' and coalesce(p.meta->>'swapLeg','') = 'out' then
      raise exception '%: this is a Nova Swap. Use Exchange done.', p.awb;
    end if;
    if p_action = 'transit' then
      v_from := case when target = 'Return in transit' then d
                     when nullif(p.meta->>'atHub','') is not null then lower(p.meta->>'atHub') else o end;
      if not (v_from = any(v_froms)) then v_froms := v_froms || v_from; end if;
    end if;
    targets := targets || target;
  end loop;

  if p_action = 'transit' then
    v_kind := case when targets[1] = 'Return in transit' then 'return' else 'forward' end;
    if exists (select 1 from unnest(targets) t where (t = 'Return in transit') <> (v_kind = 'return')) then
      raise exception 'Send returns and new parcels as separate batches.';
    end if;
    if cardinality(v_froms) <> 1 then
      raise exception 'These parcels are at different stations (%). Send one batch per city.', array_to_string(array(select initcap(x) from unnest(v_froms) x), ', ');
    end if;
    v_from := v_froms[1];
    select count(*) + 1 into v_n from public.nv_transit_batches b where (b.sent_at at time zone 'Asia/Karachi')::date = v_today;
    loop
      v_batch := upper(left(regexp_replace(v_from,'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(v_to,'[^a-z]','','g'),3)) || '-' ||
                 to_char(now() at time zone 'Asia/Karachi','MMDD') || '-' || lpad(v_n::text, greatest(2, length(v_n::text)), '0');
      exit when not exists (select 1 from public.nv_transit_batches b where b.code = v_batch);
      v_n := v_n + 1;
    end loop;
    insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs)
    values (v_batch, v_kind, initcap(v_from), initcap(v_to), r, v_ref, codes);
  end if;

  perform set_config('novax.rider_write','1',true);
  foreach code in array codes loop
    i := i + 1;
    select * into p from public.parcels where upper(awb) = code;
    target := targets[i];
    if p.rider_id is distinct from r then
      perform set_config('novax.swap_assign','1',true);
      update public.parcels set rider_id = r where id = p.id;
      perform set_config('novax.swap_assign','',true);
    end if;
    m := coalesce(p.meta,'{}');
    h := (case when jsonb_typeof(m->'processHistory') = 'array' then m->'processHistory' else '[]'::jsonb end)
      || jsonb_build_array(jsonb_build_object('at', to_char(now() at time zone 'Asia/Karachi','YYYY-MM-DD HH24:MI:SS'), 'by', 'Rider', 'rider', r,
                                              'to', target, 'status', target, 'reason', coalesce(p_reason,''),
                                              'branch', initcap(case when p_action in ('receive','transit') and target = 'Parcel now in transit'
                                                                   and coalesce(nullif(p.meta->>'atHub',''), nullif(p.meta->>'hub','')) is not null
                                                               then lower(coalesce(nullif(p.meta->>'atHub',''), p.meta->>'hub'))
                                                               when target in ('Collected by rider','Parcel now in transit','Return received at origin','Return out for delivery','Return to shipper') then public.nv_parcel_origin(p) else public.nv_parcel_dest(p) end) || ' Hub'));
    select coalesce(jsonb_agg(e order by k),'[]') into h from jsonb_array_elements(h) with ordinality t(e,k) where k > greatest(jsonb_array_length(h)-30,0);
    steps := case when jsonb_typeof(m->'steps') = 'array' then m->'steps' else '[]'::jsonb end;
    if not steps @> jsonb_build_array(target) then steps := steps || jsonb_build_array(target); end if;
    m := m || jsonb_build_object('processHistory', h, 'steps', steps);
    if target = 'Parcel received at destination' and nullif(m->>'destinationArrivedAt','') is null then m := m || jsonb_build_object('destinationArrivedAt', now()); end if;
    if p_action = 'transit' then m := m || jsonb_build_object('transitBatch', v_batch, 'transitRef', v_ref); end if;
    -- 27 Oct 2026, Lahore hub: received at the hub / sent on from the hub
    if p_action = 'receive' and target = 'Parcel now in transit' then
      m := m || jsonb_build_object('atHub', coalesce(nullif(p.meta->>'hub',''), 'Lahore'), 'hubReceivedAt', now());
    end if;
    if p_action = 'transit' and nullif(p.meta->>'atHub','') is not null then
      m := (m - 'atHub' - 'hub') || jsonb_build_object('viaHub', p.meta->>'atHub', 'hubForwardedAt', now());
    end if;
    if p_action = 'reattempt' then m := m || jsonb_build_object('nextAttempt', v_next, 'lastAttemptReason', p_reason); end if;
    -- 14 Oct 2026: where the rider stood when the customer refused or was not there
    if p_action in ('refused','not_available','reattempt') then
      m := m || jsonb_build_object('attemptLocation', coalesce(v_loc, jsonb_build_object('unavailable', true, 'at', now())));
    end if;
    if target = 'Delivered' then
      m := m || jsonb_build_object('deliveredBy', r, 'cashReceived', coalesce(p.cod_amount,0) = 0,
        'cashDepositStatus', case when coalesce(p.cod_amount,0) = 0 then 'not_required' else 'not_deposited' end,
        'deliveryLocation', coalesce(v_loc, jsonb_build_object('unavailable', true, 'at', now())));
    end if;
    update public.parcels
       set status = target,
           exception = case when target in ('Refused','Consignee not available','Reattempt') or (p_action = 'not_available') then coalesce(p_reason,'') else '' end,
           meta = m, updated_at = now()
     where id = p.id;
    -- 14 Oct 2026: every action keeps its GPS (it was Delivered only); the
    -- rider's route and distance are read from these rows (nv_rider_route)
    insert into public.scans(parcel_id, rider_id, type, status, lat, lng, note, meta)
    values (p.id, r, 'status', target, (v_loc->>'lat')::numeric, (v_loc->>'lng')::numeric, coalesce(p_reason,''),
            jsonb_strip_nulls(jsonb_build_object('key', p_key, 'action', p_action, 'loc', v_loc)));
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0 then
      insert into public.cod_ledger(parcel_id, client_id, rider_id, direction, amount, reference)
      select p.id, p.client_id, r, 'in', p.cod_amount, p.awb
       where not exists (select 1 from public.cod_ledger where parcel_id = p.id and direction = 'in');
    end if;
    if p_action = 'receive' and nullif(p.meta->>'transitBatch','') is not null then
      update public.nv_transit_batches b
         set received_awbs = (select array_agg(distinct x) from unnest(b.received_awbs || array[upper(p.awb)]) x),
             received_at = now()
       where b.code = p.meta->>'transitBatch';
      update public.nv_transit_batches b
         set status = case when (select count(*) from unnest(b.awbs) a where a <> all(b.received_awbs)) = 0 then 'Received' else 'Partly received' end
       where b.code = p.meta->>'transitBatch';
    end if;
    moved := moved || p.awb;
  end loop;

  res := jsonb_build_object('action', p_action, 'count', cardinality(moved), 'moved', to_jsonb(moved), 'batch', v_batch);
  insert into public.rider_batches(batch_key, rider_id, result) values (p_key, r, res);
  return res;
end $function$;
revoke all on function public.nv_hub_city(text, text) from public, anon, authenticated;
