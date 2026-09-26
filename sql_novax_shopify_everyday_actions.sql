-- ---------------------------------------------------------------------------
-- Everyday merchant actions, available from inside Shopify.
--
--  * which stores are connected, visible in the portal (it showed nothing)
--  * request a pickup for booked parcels
--  * raise a support ticket about an order
--  * approve every held order at once
--  * more than one package for a single order
--
-- Everything reuses the RPCs the portal already uses, so a pickup booked from
-- Shopify is the same row, in the same queue, as one booked in the portal.
-- ---------------------------------------------------------------------------

begin;

-- More than one parcel per Shopify order, deliberately. The unique index added
-- in sql_novax_shopify_parcel_link.sql allowed exactly one, which is right for
-- an accidental replay and wrong for a merchant who ships an order in two
-- boxes. The package number is what tells those two cases apart.
alter table public.nvsh_order
  add column if not exists extra_awbs text[] not null default '{}';

drop index if exists public.parcels_shopify_app_order_uidx;
create unique index if not exists parcels_shopify_app_order_uidx
  on public.parcels (client_id, (meta->>'shopifyShop'), (meta->>'shopifyOrderId'),
                     (coalesce(meta->>'shopifyPackage','1')))
  where meta->>'shopifyOrderId' is not null;

-- The 13-argument version MUST go: with both present a 13-argument call
-- matches the old signature and the new one's default, and PostgREST gets
-- "function is not unique" -- every booking would fail.
drop function if exists public.nvsh_book_parcel(text,text,text,text,text,numeric,text,text,text,text,text,text,text);

create or replace function public.nvsh_book_parcel(
  p_shop text, p_consignee text, p_phone text, p_city text, p_address text,
  p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text,
  p_payment_mode text, p_order_id text, p_reference_no text, p_package_no integer default 1)
returns public.parcels
language plpgsql security definer set search_path to 'public'
as $function$
declare v_client uuid; v_status text; v_pickup text; v_row public.parcels;
begin
  select s.client_id, s.status, coalesce(nullif(btrim(c.city), ''), 'Karachi')
    into v_client, v_status, v_pickup
    from public.nvsh_shop s
    left join public.clients c on c.id = s.client_id
   where s.shop_domain = p_shop;

  if v_client is null then
    raise exception 'shop % is not linked to a NovaX merchant', p_shop;
  end if;
  if v_status <> 'active' then
    raise exception 'shop % is %, not active', p_shop, v_status;
  end if;

  v_row := public.nv_book_parcel_core(
    v_client, p_consignee, p_phone, v_pickup, p_city, p_address,
    p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_id, p_reference_no, 'shopify_app', 'shopify');

  update public.parcels
     set meta = meta || jsonb_build_object('shopifyShop', p_shop,
                                           'shopifyOrderId', p_reference_no,
                                           'shopifyPackage', greatest(coalesce(p_package_no,1),1)::text)
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function public.nvsh_book_parcel(text,text,text,text,text,numeric,text,text,text,text,text,text,text,integer)
  from public, anon, authenticated;

-- ------------------------------------------------- connected stores --------

/* The portal showed a connect code and nothing else, so a merchant could not
   tell from the portal whether connecting had worked, or which stores were
   attached. Reads through my_client_id(), so a merchant sees only their own. */
create or replace function public.nvsh_my_stores()
returns table(shop_domain text, status text, linked_at timestamptz,
              orders_booked integer, last_order_at timestamptz)
language sql stable security definer set search_path to 'public'
as $$
  select s.shop_domain, s.status, s.linked_at, s.orders_booked, s.last_order_at
    from public.nvsh_shop s
   where s.client_id = public.my_client_id()
     and public.my_client_id() is not null
   order by s.linked_at desc nulls last
$$;

revoke all on function public.nvsh_my_stores() from public, anon;
grant execute on function public.nvsh_my_stores() to authenticated;

-- ------------------------------------------------------------ pickup -------

create or replace function public.nvsh_pickup_request(p_shop text, p_note text)
returns table(ok boolean, message text, awb_count integer)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_client uuid; v_awbs text[]; v_addr text;
begin
  select client_id into v_client from public.nvsh_shop
   where shop_domain = p_shop and status = 'active';
  if v_client is null then
    return query select false, 'This store is not connected to a NovaX account.', 0; return;
  end if;

  -- Only parcels that have not been collected yet. Asking a rider to collect a
  -- parcel that is already in the network wastes a trip.
  select array_agg(p.awb order by p.booked_at)
    into v_awbs
    from public.parcels p
   where p.client_id = v_client
     and p.status = 'New booked'
     and p.meta->>'shopifyShop' = p_shop;

  if v_awbs is null or array_length(v_awbs,1) is null then
    return query select false, 'No parcels are waiting for pickup from this store.', 0; return;
  end if;

  if exists (select 1 from public.pickup_requests r
              where r.client_id = v_client and r.status in ('Requested','Assigned')) then
    return query select false, 'You already have a pickup request open.',
                 array_length(v_awbs,1); return;
  end if;

  select coalesce(nullif(btrim(c.address),''), 'Pickup address on file')
    into v_addr from public.clients c where c.id = v_client;

  insert into public.pickup_requests (client_id, awbs, pickup_address, requested_for, note, status, meta)
  values (v_client, to_jsonb(v_awbs), v_addr, 'Today',
          left(coalesce(nullif(btrim(p_note),''), 'Requested from Shopify'), 500),
          'Requested', jsonb_build_object('source','shopify_app','shop',p_shop));

  return query select true,
    'Pickup requested for ' || array_length(v_awbs,1) || ' parcel' ||
    case when array_length(v_awbs,1) = 1 then '' else 's' end || '.',
    array_length(v_awbs,1);
end $$;

revoke all on function public.nvsh_pickup_request(text,text) from public, anon, authenticated;

-- ------------------------------------------------------------ support ------

create or replace function public.nvsh_ticket_open(p_shop text, p_order_id text, p_body text)
returns table(ok boolean, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare v_client uuid; v_awb text; v_parcel uuid; v_name text;
begin
  select client_id into v_client from public.nvsh_shop
   where shop_domain = p_shop and status = 'active';
  if v_client is null then
    return query select false, 'This store is not connected to a NovaX account.'; return;
  end if;
  if coalesce(btrim(p_body),'') = '' then
    return query select false, 'Write what the problem is first.'; return;
  end if;

  select o.awb, o.order_name into v_awb, v_name
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id;

  select id into v_parcel from public.parcels where awb = v_awb;

  insert into public.tickets (client_id, parcel_id, subject, body, status, meta)
  values (v_client, v_parcel,
          left('Shopify order ' || coalesce(v_name, p_order_id) ||
               coalesce(' (' || v_awb || ')', ''), 200),
          left(btrim(p_body), 4000),
          'Open',
          jsonb_build_object('source','shopify_app','shop',p_shop,
                             'shopifyOrderId',p_order_id,'awb',v_awb));

  return query select true, 'Sent. NovaX support will reply in the portal.';
end $$;

revoke all on function public.nvsh_ticket_open(text,text,text) from public, anon, authenticated;

-- --------------------------------------------------------- bulk approve ----

create or replace function public.nvsh_approve_all(p_shop text)
returns table(ok boolean, message text, approved integer)
language plpgsql security definer set search_path to 'public'
as $$
declare v_n integer;
begin
  update public.nvsh_order
     set status = 'received', approved_at = now(), hold_reason = null, updated_at = now()
   where shop_domain = p_shop and status = 'awaiting_approval';
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return query select false, 'Nothing is waiting for approval.', 0; return;
  end if;
  return query select true,
    v_n || ' order' || case when v_n = 1 then '' else 's' end || ' approved.', v_n;
end $$;

revoke all on function public.nvsh_approve_all(text) from public, anon, authenticated;

commit;

select 'functions' as check, string_agg(proname, ', ' order by proname) as detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public'
   and proname in ('nvsh_my_stores','nvsh_pickup_request','nvsh_ticket_open','nvsh_approve_all')
union all
select 'package index', indexdef from pg_indexes where indexname='parcels_shopify_app_order_uidx';

drop function if exists public.nvsh_recent_orders(text,integer);
create or replace function public.nvsh_recent_orders(p_shop text, p_limit integer default 20)
returns table(order_name text, shopify_order_id text, awb text, status text,
              cod_amount numeric, received_at timestamptz, error text,
              hold_reason text, fulfill_state text, fulfill_error text,
              parcel_status text, recall_requested boolean, tracking_url text,
              extra_awbs text[])
language sql security definer set search_path to 'public'
as $f$
  select o.order_name, o.shopify_order_id, o.awb, o.status, o.cod_amount,
         o.received_at, o.error, o.hold_reason, o.fulfill_state, o.fulfill_error,
         p.status, o.recall_requested_at is not null,
         case when o.awb is not null
              then 'https://novaxlogistics.com/tracking.html?awb=' || o.awb end,
         o.extra_awbs
    from public.nvsh_order o
    left join public.parcels p on p.awb = o.awb
   where o.shop_domain = p_shop
   order by o.received_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$f$;
-- An order that ships in several boxes has several parcels. Cancelling only
-- nvsh_order.awb left the extra boxes booked and collectable -- the merchant
-- sees "cancelled" in Shopify and a rider still turns up for boxes 2 and 3.
create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_awb text; v_extra text[]; v_all text[]; v_pstatus text;
  v_cancelled int := 0; v_recalled int := 0; v_awb2 text;
begin
  select o.awb, coalesce(o.extra_awbs,'{}') into v_awb, v_extra
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;
  if not found then
    return query select false, 'none', 'No such order.'; return;
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
      continue;   -- already finished; nothing to do and nothing to raise
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
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before pickup', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled',
      v_cancelled || ' parcel(s) cancelled before pickup.'; return;
  end if;

  return query select false, 'none', 'Nothing left to cancel on this order.';
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;
-- Six merchants have no address on file. The old fallback put the literal
-- string "Pickup address on file" into the request, which is what a rider
-- would have been given to drive to.
create or replace function public.nvsh_pickup_request(p_shop text, p_note text)
returns table(ok boolean, message text, awb_count integer)
language plpgsql security definer set search_path to 'public'
as $$
declare v_client uuid; v_awbs text[]; v_addr text;
begin
  select client_id into v_client from public.nvsh_shop
   where shop_domain = p_shop and status = 'active';
  if v_client is null then
    return query select false, 'This store is not connected to a NovaX account.', 0; return;
  end if;

  select nullif(btrim(c.address),'') into v_addr from public.clients c where c.id = v_client;
  if v_addr is null then
    return query select false,
      'Add your pickup address in the NovaX portal first — a rider needs somewhere to go.', 0;
    return;
  end if;

  select array_agg(p.awb order by p.booked_at) into v_awbs
    from public.parcels p
   where p.client_id = v_client and p.status = 'New booked'
     and p.meta->>'shopifyShop' = p_shop;

  if v_awbs is null or array_length(v_awbs,1) is null then
    return query select false, 'No parcels are waiting for pickup from this store.', 0; return;
  end if;

  if exists (select 1 from public.pickup_requests r
              where r.client_id = v_client and r.status in ('Requested','Assigned')) then
    return query select false, 'You already have a pickup request open.', array_length(v_awbs,1); return;
  end if;

  insert into public.pickup_requests (client_id, awbs, pickup_address, requested_for, note, status, meta)
  values (v_client, to_jsonb(v_awbs), v_addr, 'Today',
          left(coalesce(nullif(btrim(p_note),''), 'Requested from Shopify'), 500),
          'Requested', jsonb_build_object('source','shopify_app','shop',p_shop));

  return query select true,
    'Pickup requested for ' || array_length(v_awbs,1) || ' parcel' ||
    case when array_length(v_awbs,1) = 1 then '' else 's' end || '.',
    array_length(v_awbs,1);
end $$;

revoke all on function public.nvsh_pickup_request(text,text) from public, anon, authenticated;
-- Cancelling a parcel left it inside any open pickup request, so a rider was
-- still sent to collect boxes that no longer existed. Found by cancelling a
-- 3-box order that had a pickup already booked.
create or replace function public.nvsh_drop_from_pickup(p_client uuid, p_awbs text[])
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare r record; v_left jsonb;
begin
  for r in select id, awbs from public.pickup_requests
            where client_id = p_client and status in ('Requested','Assigned')
  loop
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_left
      from jsonb_array_elements_text(r.awbs) as t(x)
     where t.x <> all(p_awbs);

    if jsonb_array_length(v_left) = 0 then
      update public.pickup_requests
         set status='Cancelled', awbs=v_left, updated_at=now(),
             note = coalesce(note,'') || ' (all parcels cancelled)'
       where id = r.id;
    elsif jsonb_array_length(v_left) <> jsonb_array_length(r.awbs) then
      update public.pickup_requests set awbs=v_left, updated_at=now() where id=r.id;
    end if;
  end loop;
end $$;

revoke all on function public.nvsh_drop_from_pickup(uuid,text[]) from public, anon, authenticated;
-- An order that ships in several boxes has several parcels. Cancelling only
-- nvsh_order.awb left the extra boxes booked and collectable -- the merchant
-- sees "cancelled" in Shopify and a rider still turns up for boxes 2 and 3.
create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_awb text; v_extra text[]; v_all text[]; v_pstatus text;
  v_cancelled int := 0; v_recalled int := 0; v_awb2 text;
begin
  select o.awb, coalesce(o.extra_awbs,'{}') into v_awb, v_extra
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;
  if not found then
    return query select false, 'none', 'No such order.'; return;
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
      continue;   -- already finished; nothing to do and nothing to raise
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
    -- Take the cancelled boxes out of any pickup a rider is already booked for.
    perform public.nvsh_drop_from_pickup(
      (select client_id from public.nvsh_shop where shop_domain = p_shop), v_all);
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before pickup', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled',
      v_cancelled || ' parcel(s) cancelled before pickup.'; return;
  end if;

  return query select false, 'none', 'Nothing left to cancel on this order.';
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;
