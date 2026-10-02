-- Parcel trigger walk (2 Oct 2026). Runs against PRODUCTION inside one
-- transaction and always rolls back: nothing it creates survives.
--   psql "$NOVAX_DB" -v ON_ERROR_STOP=1 -f scripts/test-parcel-walk.sql
-- For every legal move in enforce_parcel_status_transition (as the system
-- makes it: no signed-in user), a fresh parcel is booked at the "from" status
-- and moved to the "to" status. After each move it checks:
--   * nv_parcel_status_log has the from -> to row
--   * status_since moved, and only on a real status change
--   * delivered_at is set exactly when the parcel is Delivered
--   * the merchant webhook queue got one event for the move
--   * a Shopify order linked to the AWB is marked ready on handover statuses
--   * booking logged its COD expectation in payment_logs
-- Prints PASS lines and ends with "WALK OK n moves"; any failure raises and
-- aborts (still rolled back).

begin;
select 'tx-open' as check, txid_current() is not null as ok;

do $walk$
declare
  v_client uuid := gen_random_uuid();
  v_key uuid;
  e record; v_awb text; v_pid uuid; v_since timestamptz; v_n int := 0; v_i int := 0;
  edges text[][] := array[
    ['New booked','Collected by rider'], ['New booked','Cancelled by client'], ['New booked','Parcel received at destination'],
    ['Collected by rider','Arrived at warehouse'], ['Collected by rider','Parcel now in transit'],
    ['Collected by rider','Parcel received at destination'], ['Collected by rider','Parcel out for delivery'],
    ['Arrived at warehouse','Parcel now in transit'], ['Arrived at warehouse','Parcel received at destination'],
    ['Arrived at warehouse','Parcel out for delivery'],
    ['Parcel now in transit','Parcel received at destination'],
    ['Parcel received at destination','Parcel out for delivery'],
    ['Parcel out for delivery','Delivered'], ['Parcel out for delivery','Refused'],
    ['Parcel out for delivery','Consignee not available'], ['Parcel out for delivery','Reattempt'],
    ['Refused','Reattempt'], ['Refused','Ready for return'], ['Refused','Parcel out for delivery'],
    ['Consignee not available','Reattempt'], ['Consignee not available','Ready for return'], ['Consignee not available','Parcel out for delivery'],
    ['Reattempt','Parcel out for delivery'], ['Reattempt','Ready for return'],
    ['Reassigned','Parcel out for delivery'],
    ['Out of service area','Reattempt'], ['Out of service area','Ready for return'],
    ['Ready for return','Return in transit'], ['Ready for return','Return out for delivery'],
    ['Return in transit','Return received at origin'],
    ['Return received at origin','Return out for delivery'],
    ['Return out for delivery','Return to shipper'], ['Return out for delivery','Consignee not available'],
    ['Return out for delivery','Return received at origin']];
  v_from text; v_to text;
begin
  perform set_config('request.jwt.claims', '', true);   -- the system, not a user
  insert into public.clients(id, name, phone, city) values (v_client, 'Walk Test Store', '03000000000', 'Karachi');
  insert into public.nv_api_key(client_id, key_hash, key_prefix, webhook_url, webhook_secret)
  values (v_client, md5(random()::text), 'nvx_walk', 'https://example.com/hook', 'walk-secret') returning id into v_key;

  for v_i in 1 .. array_length(edges, 1) loop
    v_from := edges[v_i][1]; v_to := edges[v_i][2];
    v_awb := 'WALK' || lpad(v_i::text, 4, '0');
    -- booked an hour ago: now() is fixed inside one transaction, so the
    -- status change must be compared against an earlier stamp
    insert into public.parcels(awb, client_id, status, cod_amount, fee, city, status_since, meta)
    values (v_awb, v_client, v_from, 1500, 250, 'Karachi', now() - interval '1 hour',
            jsonb_build_object('source', 'shopify', 'steps', jsonb_build_array(v_from)))
    returning id, status_since into v_pid, v_since;
    insert into public.nvsh_order(shop_domain, shopify_order_id, awb, fulfill_state)
    values ('walk-test.myshopify.com', 'walk-' || v_i, v_awb, 'none');

    if v_i = 1 and not exists (select 1 from public.payment_logs where client_id = v_client and reference like '%' || v_awb || '%') then
      raise exception 'booking %: no COD expectation in payment_logs', v_awb;
    end if;

    -- an unrelated write must not move status_since
    update public.parcels set meta = meta || '{"note":"x"}' where id = v_pid;
    if (select status_since from public.parcels where id = v_pid) <> v_since then
      raise exception '%: status_since moved on an unrelated write', v_awb;
    end if;

    update public.parcels set status = v_to where id = v_pid;

    if not exists (select 1 from public.nv_parcel_status_log l where l.parcel_id = v_pid and l.from_status = v_from and l.to_status = v_to) then
      raise exception '% -> %: no status log row', v_from, v_to; end if;
    if (select status_since from public.parcels where id = v_pid) <= v_since then
      raise exception '% -> %: status_since did not move', v_from, v_to; end if;
    if (v_to = 'Delivered') <> ((select delivered_at from public.parcels where id = v_pid) is not null) then
      raise exception '% -> %: delivered_at wrong', v_from, v_to; end if;
    if (select count(*) from public.nv_api_webhook_queue q where q.awb = v_awb and q.key_id = v_key) < 2 then
      raise exception '% -> %: webhook queue missing the move (booking + change expected)', v_from, v_to; end if;
    if v_to in ('Collected by rider','Arrived at warehouse','Parcel now in transit','Parcel received at destination','Parcel out for delivery','Delivered')
       and (select fulfill_state from public.nvsh_order where awb = v_awb) <> 'ready' then
      raise exception '% -> %: Shopify order not marked ready', v_from, v_to; end if;
    v_n := v_n + 1;
    raise notice 'PASS % -> %', v_from, v_to;
  end loop;

  -- an illegal move is still refused for the system
  insert into public.parcels(awb, client_id, status, city) values ('WALKBAD', v_client, 'Delivered', 'Karachi') returning id into v_pid;
  begin
    update public.parcels set status = 'New booked' where id = v_pid;
    raise exception 'Delivered -> New booked was allowed';
  exception when others then
    if sqlerrm not like 'Illegal parcel status transition%' then raise; end if;
  end;
  raise notice 'WALK OK % moves', v_n;
end $walk$;

rollback;
select 'rolled-back' as check, not exists (select 1 from public.parcels where awb like 'WALK%') as ok;
