-- 6 Nov 2026: egress. Hayat Scents polls GET /orders/:awb about 11,000 times a
-- day, and each call made three round trips from the edge function to the
-- database (resolve the key, read the parcel, write the log), each with its
-- own response headers. This does all three in one call. Same checks (it
-- calls nv_api_resolve_key_v2, so rate limits and inactive accounts behave
-- exactly as before), same columns as PARCEL_COLS in functions/api, same log
-- row. Anything other than a found / not found / deleted answer returns
-- handled=false and the function takes its normal path.
create or replace function public.nv_api_order_lookup(p_key text, p_awb text, p_route text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_who jsonb; v_client uuid; v_key uuid; v_p jsonb; v_del timestamptz; v_awb text := upper(btrim(coalesce(p_awb,'')));
begin
  v_who := public.nv_api_resolve_key_v2(p_key, false);
  if coalesce((v_who->>'ok')::boolean, false) is not true then
    return jsonb_build_object('handled', false);
  end if;
  v_client := (v_who->>'client_id')::uuid; v_key := (v_who->>'key_id')::uuid;
  select jsonb_build_object('id', p.id, 'awb', p.awb, 'status', p.status, 'consignee', p.consignee, 'phone', p.phone, 'city', p.city,
           'address', p.address, 'cod_amount', p.cod_amount, 'fee', p.fee, 'exception', p.exception, 'booked_at', p.booked_at,
           'delivered_at', p.delivered_at, 'updated_at', p.updated_at, 'invoice_id', p.invoice_id,
           'm_category', p.meta->'category', 'm_comments', p.meta->'comments', 'm_paymentMode', p.meta->'paymentMode',
           'm_allowOpen', p.meta->'allowOpen', 'm_orderId', p.meta->'orderId', 'm_weight', p.meta->'weight', 'm_steps', p.meta->'steps')
    into v_p
    from public.parcels p where p.client_id = v_client and p.awb = v_awb limit 1;
  if v_p is not null then
    perform public.nv_api_log_request(v_key, v_client, p_route, 'GET', 200, null, (extract(epoch from clock_timestamp() - now()) * 1000)::int);
    return jsonb_build_object('handled', true, 'parcel', v_p);
  end if;
  select a.created_at into v_del from public.parcel_admin_audit a
   where a.client_id = v_client and a.awb = v_awb and a.action = 'deleted' order by a.created_at desc limit 1;
  perform public.nv_api_log_request(v_key, v_client, p_route, 'GET', case when v_del is null then 404 else 410 end,
          case when v_del is null then 'order_not_found' else 'order_deleted' end, (extract(epoch from clock_timestamp() - now()) * 1000)::int);
  return jsonb_build_object('handled', true, 'parcel', null, 'deleted_at', v_del);
end $$;
revoke all on function public.nv_api_order_lookup(text, text, text) from public, anon, authenticated;
grant execute on function public.nv_api_order_lookup(text, text, text) to service_role;
