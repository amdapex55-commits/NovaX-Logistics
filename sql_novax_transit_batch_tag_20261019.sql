-- 19 Oct 2026: a parcel's batch tag (meta.transitBatch) was lost on 3 parcels
-- (KAR-RAW-1003-HO, KAR-LAH-1010-HO). No function removes it; a staff screen
-- saving a whole cached meta does. Without the tag the receipt trigger skipped
-- the parcel and KAR-RAW-1003-HO stayed "Partly received" with every parcel
-- delivered.
--   1. the tag is kept on every save (nothing clears it on purpose);
--   2. receipts also match by AWB in a still-open batch;
--   3. the lost tags are put back and the stuck batch is closed.

create or replace function public.nv_keep_transit_batch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(old.meta->>'transitBatch', '') <> '' and not (coalesce(new.meta, '{}'::jsonb) ? 'transitBatch') then
    new.meta := coalesce(new.meta, '{}'::jsonb) || jsonb_build_object('transitBatch', old.meta->'transitBatch');
  end if;
  return new;
end $$;
drop trigger if exists parcels_keep_transit_batch_trg on public.parcels;
create trigger parcels_keep_transit_batch_trg before update of meta on public.parcels
  for each row execute function public.nv_keep_transit_batch();

create or replace function public.nv_transit_batch_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(new.meta->>'transitBatch', ''); v_awb text := upper(new.awb);
begin
  if v_code is null then
    -- no tag: the newest still-open batch that lists this parcel
    select b.code into v_code from public.nv_transit_batches b
     where v_awb = any(b.awbs) and b.status <> 'Received' order by b.sent_at desc limit 1;
    if v_code is null then return null; end if;
  end if;
  update public.nv_transit_batches b
     set received_awbs = (select array_agg(distinct x) from unnest(coalesce(b.received_awbs, '{}') || array[v_awb]) x),
         received_at = now(),
         status = case when (select count(*) from unnest(b.awbs) a
                              where a <> all(coalesce(b.received_awbs, '{}') || array[v_awb])) = 0
                       then 'Received' else 'Partly received' end
   where b.code = v_code
     and v_awb = any(b.awbs)
     and not (v_awb = any(coalesce(b.received_awbs, '{}')));
  return null;
end $$;

-- 3a. put the lost tags back (the newest batch that lists the parcel)
update public.parcels p set meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object('transitBatch', x.code)
  from (select distinct on (a) a as awb, b.code from public.nv_transit_batches b, unnest(b.awbs) a order by a, b.sent_at desc) x
 where p.awb = x.awb and coalesce(p.meta->>'transitBatch', '') = '';

-- 3b. open batches: count parcels that already left transit as received
update public.nv_transit_batches b
   set received_awbs = r.got,
       status = case when cardinality(r.got) >= cardinality(b.awbs) then 'Received' else 'Partly received' end,
       received_at = coalesce(b.received_at, now())
  from (select b2.id, (select array_agg(distinct x) from unnest(b2.received_awbs || coalesce(array_agg(p.awb) filter (
               where p.status not in ('New booked','Collected by rider','Arrived at warehouse','Parcel now in transit','Return in transit')), '{}')) x) got
          from public.nv_transit_batches b2 join public.parcels p on p.awb = any(b2.awbs)
         where b2.status <> 'Received' group by b2.id, b2.received_awbs) r
 where b.id = r.id and cardinality(r.got) > cardinality(b.received_awbs);
