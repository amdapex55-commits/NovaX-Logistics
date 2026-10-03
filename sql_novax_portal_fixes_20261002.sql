-- 2 Oct 2026: three findings from the 1 Oct evening portals audit
-- (audits/portals-hard-audit-2026-10-01-pm.md, items 1, 2 and 4).

------------------------------------------------------------------------
-- 1. Transit batches close when their parcels arrive, by any route.
--    Only rider_station_action('receive') wrote received_awbs, so a batch
--    whose parcels the office received (admin processing, API) stayed
--    "Sent" forever: 20 such batches on 2 Oct.
------------------------------------------------------------------------
create or replace function public.nv_transit_batch_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(new.meta->>'transitBatch', ''); v_awb text := upper(new.awb);
begin
  if v_code is null then return null; end if;
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
revoke all on function public.nv_transit_batch_receipt() from public, anon, authenticated;

drop trigger if exists nv_transit_batch_receipt_trg on public.parcels;
create trigger nv_transit_batch_receipt_trg
  after update of status on public.parcels
  for each row
  when (old.status in ('Parcel now in transit', 'Return in transit')
        and new.status is distinct from old.status
        and new.status not in ('New booked', 'Collected by rider', 'Arrived at warehouse',
                               'Parcel now in transit', 'Return in transit'))
  execute function public.nv_transit_batch_receipt();

-- Backfill: every batch parcel that has already left transit (forward)
-- counts as received.
with moved as (
  select b.code, array_agg(distinct upper(p.awb)) as awbs
    from public.nv_transit_batches b
    join public.parcels p on upper(p.awb) = any(b.awbs)
   where p.status not in ('New booked', 'Collected by rider', 'Arrived at warehouse',
                          'Parcel now in transit', 'Return in transit')
   group by b.code
)
update public.nv_transit_batches b
   set received_awbs = (select array_agg(distinct x) from unnest(coalesce(b.received_awbs, '{}') || m.awbs) x),
       received_at = coalesce(b.received_at, now())
  from moved m
 where m.code = b.code
   and exists (select 1 from unnest(m.awbs) a where a <> all(coalesce(b.received_awbs, '{}')));
update public.nv_transit_batches b
   set status = case when (select count(*) from unnest(b.awbs) a where a <> all(coalesce(b.received_awbs, '{}'))) = 0
                     then 'Received' else 'Partly received' end
 where cardinality(coalesce(b.received_awbs, '{}')) > 0
   and b.status is distinct from case when (select count(*) from unnest(b.awbs) a where a <> all(coalesce(b.received_awbs, '{}'))) = 0
                                      then 'Received' else 'Partly received' end;

------------------------------------------------------------------------
-- 2. A merchant's browser can change only its own fields of meta.
--    The portal's background save sends the whole cached meta, so a stale
--    tab printing a label could wipe processHistory, steps, transitBatch,
--    nextAttempt and pickupCity written by the office since. This guard is
--    SECURITY INVOKER on purpose: current_user is then the caller's role,
--    so it applies to direct writes from the browser and never to server
--    functions, which run as their owner.
------------------------------------------------------------------------
create or replace function public.parcels_guard_merchant_meta()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_mine jsonb;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.meta is not distinct from old.meta then return new; end if;
  if public.is_admin() or public.can_process_orders() or public.my_rider_id() is not null then return new; end if;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_mine
    from jsonb_each(coalesce(new.meta, '{}'::jsonb)) e
   where e.key in ('awbPrinted', 'awbPrintedAt', 'comments', 'clientFeedback');
  new.meta := coalesce(old.meta, '{}'::jsonb) || v_mine;
  return new;
end $$;
revoke all on function public.parcels_guard_merchant_meta() from public, anon, authenticated;

drop trigger if exists parcels_guard_merchant_meta_trg on public.parcels;
create trigger parcels_guard_merchant_meta_trg
  before update on public.parcels
  for each row execute function public.parcels_guard_merchant_meta();

------------------------------------------------------------------------
-- 4. The first-pickup reward pays only for the store's first pickup.
--    `r.delivered or ...` paid as soon as ANY parcel was delivered, so a
--    refused first pickup still paid through a later parcel -- against
--    the agreement ("after its first pickup is delivered") and the test.
------------------------------------------------------------------------
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.sales_refresh()'::regprocedure);
  v_new := replace(v_def,
    'if r.delivered or (v_first is not null and v_picked_at < now() - make_interval(days => v_hold) and not v_first_bad) then',
    'if v_first is not null and not v_first_bad
         and (exists (select 1 from public.parcels p where p.id = v_first and p.status = ''Delivered'')
              or v_picked_at < now() - make_interval(days => v_hold)) then');
  if v_new = v_def then
    if position('p.id = v_first and p.status' in v_def) > 0 then return; end if;  -- already applied
    raise exception 'sales_refresh: reward condition not found';
  end if;
  execute v_new;
end $$;

notify pgrst, 'reload schema';
