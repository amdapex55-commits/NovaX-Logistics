-- ---------------------------------------------------------------------------
-- One shared parcel record: the Shopify store and order are written onto the
-- parcel, and the database refuses a second parcel for the same order.
--
-- Found by booking a real order through the live pipeline, 26 Sep 2026.
-- nv_book_parcel_core writes meta.source = 'shopify_app' (the value
-- nvsh_book_parcel passes) and meta.orderId = the order name. It never writes
-- meta.shopifyOrderId. So:
--
--   parcels_shopify_order_uidx  -- partial ON (meta->>'source') = 'shopify'
--                                  AND meta->>'shopifyOrderId' IS NOT NULL
--
-- matched nothing, and neither did parcels_manual_order_uidx, whose predicate
-- requires source 'manual'. Shopify-booked parcels had NO unique constraint at
-- all. The application-level guards (nvsh_order_unique, the webhook-id claim)
-- still stopped the ordinary duplicate paths, but the database backstop that
-- everyone assumed was there was not.
--
-- This writes the identifiers the parcel should have carried all along, and
-- indexes what is actually written rather than what was hoped for.
-- ---------------------------------------------------------------------------

begin;

-- Backfill the parcels already booked through the app, so the new index can be
-- created and so existing rows are linkable.
update public.parcels p
   set meta = p.meta
            || jsonb_build_object('shopifyShop', o.shop_domain,
                                  'shopifyOrderId', o.shopify_order_id)
  from public.nvsh_order o
 where o.awb = p.awb
   and o.awb is not null
   and p.meta->>'shopifyOrderId' is null;

create unique index if not exists parcels_shopify_app_order_uidx
  on public.parcels (client_id, (meta->>'shopifyShop'), (meta->>'shopifyOrderId'))
  where meta->>'shopifyOrderId' is not null;

-- nvsh_book_parcel now stamps the link on the way in.
create or replace function public.nvsh_book_parcel(
  p_shop text, p_consignee text, p_phone text, p_city text, p_address text,
  p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text,
  p_payment_mode text, p_order_id text, p_reference_no text)
returns public.parcels
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_client uuid; v_status text; v_pickup text; v_row public.parcels;
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

  -- The link that makes a replay impossible. p_reference_no carries the
  -- numeric Shopify order id; p_order_id carries the merchant-facing name.
  update public.parcels
     set meta = meta || jsonb_build_object('shopifyShop', p_shop,
                                           'shopifyOrderId', p_reference_no)
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function public.nvsh_book_parcel(text,text,text,text,text,numeric,text,text,text,text,text,text,text)
  from public, anon, authenticated;

-- The handover trigger checked for source 'shopify', which is never written.
create or replace function public.nvsh_mark_ready_to_fulfill()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- 'shopify_app' is what nvsh_book_parcel passes to nv_book_parcel_core.
  -- 'shopify' is accepted too so an older row is not silently skipped.
  if coalesce(new.meta->>'source','') not in ('shopify','shopify_app') then
    return new;
  end if;

  if old.status = 'New booked'
     and new.status <> 'New booked'
     and new.status not in ('Cancelled by client','Out of service area','Return to shipper')
  then
    update public.nvsh_order
       set fulfill_state = 'ready',
           updated_at    = now()
     where awb = new.awb
       and fulfill_state = 'none';
  end if;

  return new;
end $$;

commit;

select 'linked parcels' as check, count(*)::text as detail
  from public.parcels where meta->>'shopifyOrderId' is not null
union all
select 'index', indexname from pg_indexes where indexname = 'parcels_shopify_app_order_uidx';
