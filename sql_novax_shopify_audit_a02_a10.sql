-- A04 -- a cancellation that arrives BEFORE the order creation was forgotten.
-- Shopify does not guarantee webhook ordering, and the handler answered "No
-- such order", logged success, and left nothing behind. The create that landed
-- afterwards then booked a parcel for an order the merchant had cancelled.
--
-- A tombstone row fixes it without new machinery: handleOrdersCreate already
-- refuses to book when a row exists whose status is not 'received', so a
-- pre-recorded 'cancelled' row makes the late create a no-op.
create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_awb text; v_extra text[]; v_all text[]; v_pstatus text;
  v_cancelled int := 0; v_recalled int := 0; v_awb2 text; v_found boolean;
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

  v_all := array_prepend(v_awb, v_extra);

  foreach v_awb2 in array v_all loop
    select status into v_pstatus from public.parcels where awb = v_awb2;
    if v_pstatus is null then continue; end if;

    if v_pstatus = 'New booked' then
      update public.parcels set status='Cancelled by client', updated_at=now() where awb=v_awb2;
      v_cancelled := v_cancelled + 1;
    elsif v_pstatus in ('Cancelled by client','Delivered','Return to shipper') then
      continue;
    else
      insert into public.operations_issues (branch, urgency, problem, awb, meta)
      values ('Karachi','High',
              'Shopify recall request: order cancelled after pickup (' || v_pstatus || ')',
              v_awb2,
              jsonb_build_object('source','shopify_app','shop',p_shop,'shopifyOrderId',p_order_id));
      v_recalled := v_recalled + 1;
    end if;
  end loop;

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
    perform public.nvsh_drop_from_pickup(
      (select client_id from public.nvsh_shop where shop_domain = p_shop), v_all);
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before pickup', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled', v_cancelled || ' parcel(s) cancelled before pickup.'; return;
  end if;

  return query select false, 'none', 'Nothing left to cancel on this order.';
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;
-- A09 -- reconciliation against Shopify, every 15 minutes. The booking drain
-- only re-reads rows we already hold, so an order whose webhook never reached
-- durable storage was invisible forever. This asks Shopify what it has.
create or replace function public.nvsh_reconcile_tick()
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.nvsh_shop
                  where status='active' and client_id is not null) then
    return;
  end if;
  perform net.http_post(
    url     := 'https://novaxlogistics.com/shopify/reconcile',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-novax-drain', public.nvsh_drain_token()),
    timeout_milliseconds := 55000
  );
end $$;

revoke all on function public.nvsh_reconcile_tick() from public, anon, authenticated;

-- A08 second half -- the booking drain had no schedule at all. Approved and
-- released orders sat in 'received' until something happened to touch them.
create or replace function public.nvsh_book_drain_tick()
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.nvsh_order where status in ('received','failed')) then
    return;
  end if;
  perform net.http_post(
    url     := 'https://novaxlogistics.com/shopify/drain',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-novax-drain', public.nvsh_drain_token()),
    timeout_milliseconds := 30000
  );
end $$;

revoke all on function public.nvsh_book_drain_tick() from public, anon, authenticated;

select cron.unschedule('novax-shopify-reconcile') where exists (select 1 from cron.job where jobname='novax-shopify-reconcile');
select cron.unschedule('novax-shopify-book-drain') where exists (select 1 from cron.job where jobname='novax-shopify-book-drain');
select cron.schedule('novax-shopify-reconcile',  '*/15 * * * *', 'select public.nvsh_reconcile_tick();');
select cron.schedule('novax-shopify-book-drain', '* * * * *',    'select public.nvsh_book_drain_tick();');

select jobname, schedule from cron.job where jobname like 'novax-shopify%' order by jobname;
