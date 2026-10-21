-- 21 Oct 2026: a Reattempt booked for a later day no longer blocks every
-- rider until that day. Khalid marked one Reattempt for the next day and
-- Arsalan could not take it out. The app now warns ("customer asked for
-- 22 Oct, take it out early?") and sends p_extra.early = true when the rider
-- confirms; without that flag the old rule still holds.
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
      v_from := case when target = 'Return in transit' then d else o end;
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
                                              'branch', initcap(case when target in ('Collected by rider','Parcel now in transit','Return received at origin','Return out for delivery','Return to shipper') then public.nv_parcel_origin(p) else public.nv_parcel_dest(p) end) || ' Hub'));
    select coalesce(jsonb_agg(e order by k),'[]') into h from jsonb_array_elements(h) with ordinality t(e,k) where k > greatest(jsonb_array_length(h)-30,0);
    steps := case when jsonb_typeof(m->'steps') = 'array' then m->'steps' else '[]'::jsonb end;
    if not steps @> jsonb_build_array(target) then steps := steps || jsonb_build_array(target); end if;
    m := m || jsonb_build_object('processHistory', h, 'steps', steps);
    if target = 'Parcel received at destination' and nullif(m->>'destinationArrivedAt','') is null then m := m || jsonb_build_object('destinationArrivedAt', now()); end if;
    if p_action = 'transit' then m := m || jsonb_build_object('transitBatch', v_batch, 'transitRef', v_ref); end if;
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
