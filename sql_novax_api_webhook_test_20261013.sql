-- Test events for a merchant's status webhook (13 Oct 2026).
--
-- A merchant wiring up their receiver needs to see every status arrive before
-- a real parcel depends on it. Until now the only way was to book a real
-- parcel and wait for a rider. nv_api_webhook_test() queues sample events to
-- the URL the merchant registered. They travel the same road as real ones:
-- same queue, same signature and headers, same retries. They are marked
-- "test": true and carry a TEST- tracking number, which no real parcel can
-- have, so one can never be filed as a real consignment.
--
-- Called by the API route POST /webhook/test (service role only).
create or replace function public.nv_api_webhook_test(p_key_id uuid, p_status text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key public.nv_api_key;
  -- every status a parcel can have, in the order a parcel usually meets them
  v_all text[] := array['New booked','Collected by rider','Arrived at warehouse','Parcel now in transit',
    'Parcel received at destination','Parcel out for delivery','Delivered','Consignee not available','Reattempt',
    'Reassigned','Refused','Ready for return','Return in transit','Return received at origin','Return out for delivery',
    'Return to shipper','Cancelled by client','Out of service area'];
  v_send text[]; v_awb text; v_recent int; v_city text; v_fee numeric; s text; i int := 0; v_t0 timestamptz := now();
begin
  select * into v_key from public.nv_api_key where id = p_key_id and not revoked;
  if v_key.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_key'); end if;
  if v_key.webhook_url is null then return jsonb_build_object('ok', false, 'error', 'no_webhook_url'); end if;

  if p_status is null or btrim(p_status) = '' or lower(btrim(p_status)) = 'all' then
    v_send := v_all;
  else
    select array_agg(x) into v_send from unnest(v_all) x where lower(x) = lower(btrim(p_status));
    if v_send is null then return jsonb_build_object('ok', false, 'error', 'unknown_status', 'valid', to_jsonb(v_all)); end if;
  end if;

  -- a test must not become a way to hammer someone's server
  select count(*) into v_recent from public.nv_api_webhook_queue
   where key_id = v_key.id and payload->>'test' = 'true' and created_at > now() - interval '1 hour';
  if v_recent + cardinality(v_send) > 100 then
    return jsonb_build_object('ok', false, 'error', 'test_limit', 'sent_last_hour', v_recent, 'limit_per_hour', 100);
  end if;

  select initcap(coalesce(nullif(btrim(c.meta->>'pickupCity'), ''), 'Karachi')) into v_city from public.clients c where c.id = v_key.client_id;
  begin v_fee := (public.novax_quote_fee(v_key.client_id, v_city, '0.5 kg')->>'fee')::numeric; exception when others then v_fee := 250; end;
  v_awb := 'TEST-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  foreach s in array v_send loop
    insert into public.nv_api_webhook_queue (key_id, client_id, awb, event, payload)
    values (v_key.id, v_key.client_id, v_awb, 'parcel.status',
      jsonb_build_object(
        'event',           'parcel.status',
        'test',            true,
        'awb',             v_awb,
        'status',          s,
        'exception',       case s when 'Refused' then 'Customer refused' when 'Consignee not available' then 'No answer on call'
                                  when 'Reattempt' then 'Customer asked for tomorrow' else '' end,
        'cod_amount',      1500,
        'delivery_charge', v_fee,
        'order_id',        'TEST-ORDER-1001',
        'reference',       null,
        'consignee',       'Test Customer',
        'city',            v_city,
        'occurred_at',     v_t0 + (i * interval '1 second'),
        'tracking_url',    null));
    i := i + 1;
  end loop;

  return jsonb_build_object('ok', true, 'queued', i, 'awb', v_awb, 'statuses', to_jsonb(v_send), 'webhook', v_key.webhook_url);
end $function$;

revoke all on function public.nv_api_webhook_test(uuid, text) from public, anon, authenticated;
grant execute on function public.nv_api_webhook_test(uuid, text) to service_role;
notify pgrst, 'reload schema';
