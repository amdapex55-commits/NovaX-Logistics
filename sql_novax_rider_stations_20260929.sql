-- ═══ City rider app: Pickup / Delivery / Transit (29 Sep 2026) ══════════════
-- One rider IS the city: Khalid is Lahore, Naveed is Islamabad + Rawalpindi.
-- A rider used to see only parcels an admin had assigned to him by name, so
-- every status came in over WhatsApp instead. Now a rider sees, and may act on,
-- every parcel picked up in or going to his cities; the server checks the city,
-- and the rider is attached to the parcel at the moment he acts on it.
--
-- Where a parcel is, by status (origin = meta.pickupCity, destination = city):
--   New booked                      at the shipper, origin city        -> Pickup
--   Collected / Arrived at warehouse at the origin station              -> Transit (if going elsewhere)
--   In transit                      moving to the destination           -> Receive (destination)
--   Received / Refused / Not available / Reattempt   destination station -> Delivery
--   Ready for return                at the destination, going back      -> Transit (return)
--   Return in transit               moving back to the origin           -> Receive (origin)
--   Return received at origin       origin station                      -> Delivery (back to shipper)

alter table public.riders add column if not exists cities text[] not null default '{}';
update public.riders set cities = case
    when branch ilike 'lahore%' then array['Lahore']
    when branch ilike 'islamabad%' or branch ilike 'rawalpindi%' then array['Islamabad','Rawalpindi']
    else array['Karachi'] end
  where cardinality(cities) = 0;

alter table public.rider_cash_deposits add column if not exists method text;
alter table public.rider_cash_deposits add column if not exists reference text;

create table if not exists public.nv_transit_batches (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  kind          text not null default 'forward',          -- forward | return
  from_city     text not null,
  to_city       text not null,
  rider_id      uuid references public.riders(id),
  reference     text not null default '',                 -- bus / courier bilty
  awbs          text[] not null default '{}',
  received_awbs text[] not null default '{}',
  status        text not null default 'Sent',             -- Sent | Partly received | Received
  sent_at       timestamptz not null default now(),
  received_at   timestamptz
);
create index if not exists nv_transit_batches_to_idx on public.nv_transit_batches (lower(to_city), status);
alter table public.nv_transit_batches enable row level security;
drop policy if exists nv_transit_batches_admin_read on public.nv_transit_batches;
create policy nv_transit_batches_admin_read on public.nv_transit_batches for select to authenticated using (public.is_admin());
revoke all on public.nv_transit_batches from anon, public;
revoke insert, update, delete on public.nv_transit_batches from authenticated;
grant select on public.nv_transit_batches to authenticated;

create or replace function public.nv_rider_cities()
returns text[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array(select lower(btrim(c)) from unnest(r.cities) c where btrim(c) <> ''), '{}')
    from public.riders r where r.id = public.my_rider_id();
$$;

create or replace function public.nv_parcel_origin(p public.parcels)
returns text language sql immutable as $$ select lower(coalesce(nullif(btrim(p.meta->>'pickupCity'),''), 'karachi')) $$;
create or replace function public.nv_parcel_dest(p public.parcels)
returns text language sql immutable as $$ select lower(btrim(coalesce(p.city,''))) $$;

-- ---- the three new physical moves, for the rider carrying the parcel -------
-- City riders (29 Sep): no warehouse outside Karachi, same-city pickups go
-- straight to the station, a refused parcel can go out again, a local return
-- goes straight back to the shipper, and a failed door visit can be a reattempt.
CREATE OR REPLACE FUNCTION public.enforce_parcel_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_allowed text[];
  v_carrier boolean;
begin
  -- Admins AND any authorized order-processing staff keep full flexibility
  -- to correct/override status -- this is exactly what admin_processing_
  -- update_status relies on to move a parcel through every stage.
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;
  -- No status change on this update -- nothing to validate.
  if new.status is not distinct from old.status then
    return new;
  end if;
  /* Who is asking decides which moves exist. The sequence below is the
     physical journey: only the rider carrying the parcel, or the database
     itself (cron, service role -- no auth.uid()), walks it. A merchant session
     used to be able to walk it too, one legal step at a time, to Delivered. A
     merchant decides only what is theirs: cancel before pickup, and reattempt
     or return after a failed delivery. */
  v_carrier := auth.uid() is null
               or (old.rider_id is not null and old.rider_id = public.my_rider_id());
  if not v_carrier then
    v_allowed := case old.status
      when 'New booked' then array['Cancelled by client']
      when 'Refused' then array['Reattempt','Ready for return']
      when 'Consignee not available' then array['Reattempt','Ready for return']
      when 'Out of service area' then array['Reattempt','Ready for return']
      else array[]::text[]
    end;
    if not (new.status = any(v_allowed)) then
      raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
    end if;
    return new;
  end if;

  v_allowed := case old.status
    when 'New booked' then array['Collected by rider','Cancelled by client','Parcel received at destination']
    when 'Collected by rider' then array['Arrived at warehouse','Parcel now in transit','Parcel received at destination','Parcel out for delivery']
    when 'Arrived at warehouse' then array['Parcel now in transit','Parcel received at destination','Parcel out for delivery']
    when 'Parcel now in transit' then array['Parcel received at destination']
    when 'Parcel received at destination' then array['Parcel out for delivery']
    when 'Parcel out for delivery' then array['Delivered','Refused','Consignee not available','Reattempt']
    when 'Refused' then array['Reattempt','Ready for return','Parcel out for delivery']
    when 'Consignee not available' then array['Reattempt','Ready for return','Parcel out for delivery']
    when 'Reattempt' then array['Parcel out for delivery','Ready for return']
    when 'Reassigned' then array['Parcel out for delivery']
    when 'Out of service area' then array['Reattempt','Ready for return']
    when 'Ready for return' then array['Return in transit','Return out for delivery']
    when 'Return in transit' then array['Return received at origin']
    when 'Return received at origin' then array['Return out for delivery']
    when 'Return out for delivery' then array['Return to shipper','Consignee not available']
    else array[]::text[]
  end;
  if not (new.status = any(v_allowed)) then
    raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
  end if;
  return new;
end;
$function$;


-- ---- who may act on a parcel that is already out -----------------------------
-- Real data, 29 Sep: 14 Lahore parcels "out for delivery" sat on the BLOCKED,
-- login-less "Naveed / Lahore Hub" record, one refusal on the blocked test
-- login rider22. Assignment-by-name would have hidden them from Khalid for
-- good. A parcel belongs to the city's rider unless another ACTIVE rider with
-- a working login, who covers that same city, is holding it.
create or replace function public.nv_rider_can_take(p_holder uuid, p_city text, p_me uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_holder is null or p_holder = p_me or not exists (
    select 1 from public.riders x
     where x.id = p_holder and x.access = 'Active'
       and lower(p_city) = any(select lower(btrim(y)) from unnest(x.cities) y)
       and exists (select 1 from public.profiles pr where pr.rider_id = x.id
                    and lower(pr.role::text) = 'rider' and lower(pr.status::text) = 'active'));
$$;
revoke all on function public.nv_rider_can_take(uuid,text,uuid) from public, anon;

-- ---- one read for the whole app --------------------------------------------
create or replace function public.rider_station_view()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities(); rr public.riders; out jsonb;
begin
  select * into rr from public.riders where id = r;
  with base as (
    select p.*, public.nv_parcel_origin(p) o, public.nv_parcel_dest(p) d from public.parcels p
     where public.nv_parcel_origin(p) = any(c) or public.nv_parcel_dest(p) = any(c)
  ), tagged as (
    select b.*, case
      when b.status = 'New booked' and b.o = any(c) and coalesce(b.meta->>'swapLeg','') <> 'back' then 'pickup'
      when b.status in ('Parcel now in transit','Collected by rider','Arrived at warehouse') and b.d = any(c) and not (b.o = any(c)) then 'incoming'
      when b.status = 'Return in transit' and b.o = any(c) then 'incoming'
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
        'meta', t.meta, 'exception', t.exception,
        'attempts', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = t.id and l.to_status = 'Parcel out for delivery'),
        'shipper', (select jsonb_build_object('name', cl.name, 'phone', cl.phone, 'address', cl.address) from public.clients cl where cl.id = t.client_id)
      ) order by t.bucket, t.status_since) from tagged t where t.bucket is not null), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from_city', b.from_city, 'to_city', b.to_city,
        'reference', b.reference, 'awbs', to_jsonb(b.awbs), 'received', to_jsonb(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at)
        order by b.sent_at desc)
      from public.nv_transit_batches b
      where (lower(b.to_city) = any(c) and b.status <> 'Received') or (b.rider_id = r and b.sent_at > now() - interval '3 days')), '[]'::jsonb),
    'server_time', now()
  ) into out;
  return out;
end $$;

-- ---- one write for every station action ------------------------------------
create or replace function public.rider_station_action(p_awbs text[], p_action text, p_reason text default '',
  p_key text default null, p_loc jsonb default null, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities();
  codes text[]; code text; p public.parcels; o text; d text; target text; targets text[] := '{}';
  res jsonb; m jsonb; h jsonb; steps jsonb; lat numeric; lng numeric; moved text[] := '{}';
  v_to text; v_ref text; v_kind text; v_batch text; v_attempts int; i int := 0; v_next text;
begin
  if cardinality(c) = 0 then raise exception 'No city is set on your rider account. Ask the office to set it.'; end if;
  if p_key is null or length(p_key) < 16 or length(p_key) > 200 or p_key ~ '[[:cntrl:]]' then raise exception 'Reference is invalid.'; end if;
  if p_action not in ('collect','receive','out','delivered','reattempt','refused','not_available','transit') then raise exception 'Unknown action.'; end if;
  if p_awbs is null or cardinality(p_awbs) < 1 or cardinality(p_awbs) > 200 then raise exception 'Choose between 1 and 200 parcels.'; end if;
  select array_agg(distinct upper(btrim(a)) order by upper(btrim(a))) into codes from unnest(p_awbs) a where btrim(coalesce(a,'')) <> '';
  if codes is null then raise exception 'No AWB given.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select x.result into res from public.rider_batches x where x.batch_key = p_key and x.rider_id = r;
  if found then return res; end if;
  if p_action in ('refused','not_available','reattempt') and nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'Choose a reason.'; end if;
  if length(coalesce(p_reason,'')) > 160 then raise exception 'Reason is too long.'; end if;
  if p_loc is not null and coalesce(p_loc->>'unavailable','false') <> 'true' then
    if jsonb_typeof(p_loc->'lat') <> 'number' or jsonb_typeof(p_loc->'lng') <> 'number' then raise exception 'Invalid GPS coordinates.'; end if;
    lat := (p_loc->>'lat')::numeric; lng := (p_loc->>'lng')::numeric;
    if abs(lat) > 90 or abs(lng) > 180 then raise exception 'GPS coordinates are out of range.'; end if;
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
                               when p.status in ('Parcel now in transit','Collected by rider','Arrived at warehouse') and d = any(c) and not (o = any(c)) then 'Parcel received at destination'
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
                                     when p.status = 'Return out for delivery' and (p.rider_id = r or (o = any(c) and public.nv_rider_can_take(p.rider_id, o, r))) then 'Consignee not available' end
      when 'transit' then case
                               when p.status in ('Collected by rider','Arrived at warehouse') and o = any(c) and d = v_to and not (d = any(c)) then 'Parcel now in transit'
                               when p.status = 'Ready for return' and d = any(c) and o = v_to and not (o = any(c)) then 'Return in transit' end
    end;
    if target is null then
      raise exception '%: cannot do "%" -- it is "%" (from % to %).', p.awb, p_action, p.status, initcap(o), initcap(d);
    end if;
    if p_action = 'reattempt' then
      select count(*) into v_attempts from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = 'Parcel out for delivery';
      if v_attempts >= 3 then raise exception '%: 3 delivery attempts already. Mark it Refused so it goes back to the shipper.', p.awb; end if;
    end if;
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0
       and btrim(coalesce(p.meta->>'paymentMode','')) ~* '(non\s*-?\s*cod|prepaid|^paid$)' then
      raise exception '%: COD/prepaid conflict. Contact the office.', p.awb;
    end if;
    if p_action = 'delivered' and coalesce(p.meta->>'swapLeg','') = 'out' then
      raise exception '%: this is a Nova Swap. Use Exchange done.', p.awb;
    end if;
    targets := targets || target;
  end loop;

  if p_action = 'transit' then
    v_kind := case when targets[1] = 'Return in transit' then 'return' else 'forward' end;
    if exists (select 1 from unnest(targets) t where (t = 'Return in transit') <> (v_kind = 'return')) then
      raise exception 'Send returns and new parcels as separate batches.';
    end if;
    v_batch := upper(left(regexp_replace(c[1],'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(v_to,'[^a-z]','','g'),3)) || '-' ||
               to_char(now() at time zone 'Asia/Karachi','MMDD') || '-' ||
               lpad((select count(*) + 1 from public.nv_transit_batches b where (b.sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date)::text, 2, '0');
    insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs)
    values (v_batch, v_kind, initcap(c[1]), initcap(v_to), r, v_ref, codes);
  end if;

  perform set_config('novax.rider_write','1',true);
  foreach code in array codes loop
    i := i + 1;
    select * into p from public.parcels where upper(awb) = code;
    target := targets[i];
    -- attach the rider acting on it (guard allows it only under this flag)
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
    if p_action = 'reattempt' then
      v_next := nullif(btrim(coalesce(p_extra->>'next_date','')),'');
      m := m || jsonb_build_object('nextAttempt', v_next, 'lastAttemptReason', p_reason);
    end if;
    if target = 'Delivered' then
      m := m || jsonb_build_object('deliveredBy', r, 'cashReceived', coalesce(p.cod_amount,0) = 0,
        'cashDepositStatus', case when coalesce(p.cod_amount,0) = 0 then 'not_required' else 'not_deposited' end,
        'deliveryLocation', coalesce(p_loc, jsonb_build_object('unavailable', true, 'at', now())));
    end if;
    update public.parcels
       set status = target,
           exception = case when target in ('Refused','Consignee not available','Reattempt') then coalesce(p_reason,'') else '' end,
           meta = m, updated_at = now()
     where id = p.id;
    insert into public.scans(parcel_id, rider_id, type, status, lat, lng, note)
    values (p.id, r, 'status', target, case when target = 'Delivered' then lat end, case when target = 'Delivered' then lng end, coalesce(p_reason,''));
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0 then
      insert into public.cod_ledger(parcel_id, client_id, rider_id, direction, amount, reference)
      select p.id, p.client_id, r, 'in', p.cod_amount, p.awb
       where not exists (select 1 from public.cod_ledger where parcel_id = p.id and direction = 'in');
    end if;
    -- a parcel arriving off a batch ticks the batch
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
end $$;

-- ---- Nova Swap at the door: same take-over rule ------------------------------
CREATE OR REPLACE FUNCTION public.rider_swap_complete(p_out_awb text, p_outcome text, p_reason text DEFAULT ''::text, p_key text DEFAULT NULL::text, p_loc jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r uuid := public.nv_require_rider(); res jsonb; o public.parcels; b public.parcels; s public.nv_swaps;
begin
  if p_key is null or length(p_key) < 16 or length(p_key) > 190 or p_key ~ '[[:cntrl:]]' then raise exception 'Swap reference is invalid.'; end if;
  if p_outcome not in ('exchanged','failed') then raise exception 'Unknown swap outcome.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select x.result into res from public.rider_batches x where x.batch_key = p_key and x.rider_id = r;
  if found then return res; end if;

  select * into o from public.parcels where upper(awb) = upper(btrim(coalesce(p_out_awb,''))) for update;
  if o.id is null then raise exception '%: no such AWB.', p_out_awb; end if;
  /* City riders (29 Sep): the out leg may still sit on a blocked or login-less
     rider record; the city's rider takes it over at the door. */
  if o.rider_id is distinct from r then
    if not (public.nv_parcel_dest(o) = any(public.nv_rider_cities()) and public.nv_rider_can_take(o.rider_id, public.nv_parcel_dest(o), r)) then
      raise exception '%: not assigned to you.', p_out_awb;
    end if;
    perform set_config('novax.swap_assign', '1', true);
    update public.parcels set rider_id = r where id = o.id;
    perform set_config('novax.swap_assign', '', true);
    o.rider_id := r;
  end if;
  if coalesce(o.meta->>'swapLeg','') <> 'out' then raise exception '%: not a Nova Swap delivery.', o.awb; end if;
  select * into s from public.nv_swaps where out_parcel_id = o.id for update;
  if s.id is null then raise exception '%: swap record missing. Contact the office.', o.awb; end if;
  select * into b from public.parcels where id = s.back_parcel_id for update;
  if o.status <> 'Parcel out for delivery' then raise exception '%: take it out for delivery first (now "%").', o.awb, o.status; end if;

  if p_outcome = 'exchanged' then
    if b.status <> 'New booked' then raise exception 'Return AWB % is already "%". Contact the office.', b.awb, b.status; end if;
    perform set_config('novax.swap_assign', '1', true);
    update public.parcels set rider_id = r, updated_at = now() where id = b.id;
    perform set_config('novax.swap_assign', '', true);
    perform public.rider_batch_update_status(array[o.awb], 'Delivered', '', p_key || ':out', p_loc);
    perform public.rider_batch_update_status(array[b.awb], 'Collected by rider', 'Nova Swap: collected from the customer', p_key || ':back', null);
  else
    perform public.rider_batch_update_status(array[o.awb], 'Refused',
      coalesce(nullif(btrim(p_reason),''), 'Nova Swap: customer did not hand over the old item'), p_key || ':out', null);
  end if;

  res := jsonb_build_object('outcome', p_outcome, 'code', s.code, 'out_awb', o.awb, 'back_awb', b.awb,
                            'moved', to_jsonb(case when p_outcome='exchanged' then array[o.awb, b.awb] else array[o.awb] end));
  insert into public.rider_batches(batch_key, rider_id, result) values (p_key, r, res);
  return res;
end $function$;

-- ---- daily cash handover with how it was sent -------------------------------
create or replace function public.rider_deposit_cash_v2(p_batch_key text, p_expected_gross numeric, p_expected_expenses numeric,
  p_expected_net numeric, p_method text, p_reference text default '')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); res jsonb;
begin
  if p_method not in ('Bank transfer','Easypaisa','JazzCash','Cash to office') then raise exception 'Choose how the cash was sent.'; end if;
  if p_method <> 'Cash to office' and length(btrim(coalesce(p_reference,''))) < 4 then
    raise exception 'Enter the transaction ID from the bank or wallet receipt.';
  end if;
  res := public.rider_deposit_cash_checked(p_batch_key, p_expected_gross, p_expected_expenses, p_expected_net);
  update public.rider_cash_deposits set method = p_method, reference = left(btrim(coalesce(p_reference,'')),80)
   where batch_key = p_batch_key and rider_id = r;
  return res || jsonb_build_object('method', p_method, 'reference', btrim(coalesce(p_reference,'')));
end $$;

-- ---- admin: set a rider's cities; the station picture -----------------------
create or replace function public.admin_set_rider_cities(p_rider uuid, p_cities text[])
returns text[] language plpgsql security definer set search_path to 'public' as $$
declare v text[];
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select coalesce(array_agg(distinct initcap(btrim(x))), '{}') into v from unnest(p_cities) x
   where lower(btrim(x)) in ('karachi','lahore','islamabad','rawalpindi');
  update public.riders set cities = v where id = p_rider;
  if not found then raise exception 'Rider not found.'; end if;
  return v;
end $$;

create or replace function public.admin_station_overview()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'cities', (select jsonb_agg(jsonb_build_object('city', initcap(cty),
        'to_pickup', (select count(*) from public.parcels p where p.status = 'New booked' and public.nv_parcel_origin(p) = cty and coalesce(p.meta->>'swapLeg','') <> 'back'),
        'incoming', (select count(*) from public.parcels p where p.status = 'Parcel now in transit' and public.nv_parcel_dest(p) = cty),
        'at_station', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status in ('Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned')),
        'out_now', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Parcel out for delivery'),
        'to_send', (select count(*) from public.parcels p where public.nv_parcel_origin(p) = cty and public.nv_parcel_dest(p) <> cty and p.status in ('Collected by rider','Arrived at warehouse')),
        'delivered_today', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Delivered' and (p.delivered_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date),
        'riders', (select coalesce(jsonb_agg(jsonb_build_object('name', rd.name, 'access', rd.access)), '[]'::jsonb) from public.riders rd where lower(cty) = any(select lower(x) from unnest(rd.cities) x))
      ) order by cty) from unnest(array['karachi','lahore','islamabad','rawalpindi']) cty),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from', b.from_city, 'to', b.to_city,
        'reference', b.reference, 'sent', cardinality(b.awbs), 'received', cardinality(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at,
        'missing', to_jsonb(array(select a from unnest(b.awbs) a where a <> all(b.received_awbs)))) order by b.sent_at desc), '[]'::jsonb)
      from public.nv_transit_batches b where b.sent_at > now() - interval '14 days'),
    'deposits', (select coalesce(jsonb_agg(jsonb_build_object('rider', rd.name, 'net', d.net, 'method', d.method, 'reference', d.reference, 'at', d.created_at)
        order by d.created_at desc), '[]'::jsonb)
      from public.rider_cash_deposits d join public.riders rd on rd.id = d.rider_id where d.created_at > now() - interval '14 days')
  );
end $$;

revoke all on function public.nv_rider_cities() from public, anon;
revoke all on function public.rider_station_view() from public, anon;
revoke all on function public.rider_station_action(text[],text,text,text,jsonb,jsonb) from public, anon;
revoke all on function public.rider_deposit_cash_v2(text,numeric,numeric,numeric,text,text) from public, anon;
revoke all on function public.admin_set_rider_cities(uuid,text[]) from public, anon;
revoke all on function public.admin_station_overview() from public, anon;
grant execute on function public.rider_station_view() to authenticated;
grant execute on function public.rider_station_action(text[],text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.rider_deposit_cash_v2(text,numeric,numeric,numeric,text,text) to authenticated;
grant execute on function public.admin_set_rider_cities(uuid,text[]) to authenticated;
grant execute on function public.admin_station_overview() to authenticated;
