-- 28 Sep 2026: nvsh_cancel_or_recall read parcels.branch, which does not exist,
-- so cancelling any booked Shopify order returned HTTP 500.
CREATE OR REPLACE FUNCTION public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
 RETURNS TABLE(ok boolean, outcome text, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_awb text; v_extra text[]; v_all text[]; v_pstatus text; v_branch text;
  v_cancelled int := 0; v_recalled int := 0; v_awb2 text; v_found boolean; v_hit int;
  v_client uuid; v_killed text[] := '{}';
begin
  select true, o.awb, coalesce(o.extra_awbs,'{}')
    into v_found, v_awb, v_extra
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;

  if not coalesce(v_found,false) then
    insert into public.nvsh_order (shop_domain, shopify_order_id, status, error, received_at, updated_at)
    values (p_shop, p_order_id, 'cancelled',
            'Cancelled in Shopify before the order reached NovaX', now(), now())
    on conflict (shop_domain, shopify_order_id) do nothing;
    return query select true, 'tombstone',
      'Cancelled before we received the order. It will not be booked.';
    return;
  end if;

  if v_awb is null then
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before booking', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled', 'Cancelled before it was booked.'; return;
  end if;

  select client_id into v_client from public.nvsh_shop where shop_domain = p_shop;
  -- parcels has no branch column; this read crashed every cancel of a booked
  -- order. A recall is for a box already with the pickup rider, so it belongs
  -- to the merchant's own hub.
  select initcap(coalesce(nullif(btrim(c.city),''),'Karachi')) || ' Hub'
    into v_branch from public.clients c where c.id = v_client;
  v_branch := coalesce(v_branch, 'Karachi Hub');
  v_all := array_prepend(v_awb, v_extra);

  foreach v_awb2 in array v_all loop
    v_pstatus := null;
    select status into v_pstatus
      from public.parcels where awb = v_awb2 for update;
    if v_pstatus is null then continue; end if;
    if v_pstatus in ('Cancelled by client','Delivered','Return to shipper') then continue; end if;

    update public.parcels
       set status='Cancelled by client', updated_at=now()
     where awb = v_awb2 and status = 'New booked';
    get diagnostics v_hit = row_count;

    if v_hit = 1 then
      v_cancelled := v_cancelled + 1;
      v_killed := array_append(v_killed, v_awb2);
    else
      -- A53: one open recall per box, enforced by the index above.
      insert into public.operations_issues (branch, urgency, problem, awb, meta)
      values (v_branch, 'High',
              'Shopify recall request: order cancelled after pickup (' || v_pstatus || ')',
              v_awb2,
              jsonb_build_object('source','shopify_app','shop',p_shop,
                                 'shopifyOrderId',p_order_id,'shopifyRecallAwb',v_awb2))
      on conflict do nothing;
      v_recalled := v_recalled + 1;
    end if;
  end loop;

  -- A52: drop cancelled boxes from the pickup on EVERY path, before returning.
  if array_length(v_killed,1) is not null then
    perform public.nvsh_drop_from_pickup(v_client, v_killed);
  end if;

  if v_recalled > 0 then
    update public.nvsh_order
       set recall_requested_at=now(),
           error='Recall requested for '||v_recalled||' parcel(s) already picked up',
           updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'recall',
      'Recall raised for ' || v_recalled || ' parcel(s) already with a rider' ||
      case when v_cancelled>0 then '; '||v_cancelled||' cancelled before pickup.' else '.' end;
    return;
  end if;

  if v_cancelled > 0 then
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before pickup', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled', v_cancelled || ' parcel(s) cancelled before pickup.'; return;
  end if;

  return query select false, 'none', 'Nothing left to cancel on this order.';
end $function$;

revoke all on function public.nvsh_cancel_or_recall(text, text) from public, anon, authenticated;
grant execute on function public.nvsh_cancel_or_recall(text, text) to service_role;
