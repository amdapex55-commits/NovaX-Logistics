-- ---------------------------------------------------------------------------
-- The embedded app becomes a dispatch screen rather than a settings form.
-- The order list has to carry enough to decide from: who, where, how much, how
-- heavy, and what it cost -- so a merchant never has to open the portal to
-- answer "should I book this".
-- ---------------------------------------------------------------------------

begin;

drop function if exists public.nvsh_recent_orders(text,integer,integer,text,text);
create or replace function public.nvsh_recent_orders(
  p_shop text, p_limit integer default 25, p_offset integer default 0,
  p_filter text default 'all', p_search text default null)
returns table(order_name text, shopify_order_id text, awb text, status text,
              cod_amount numeric, received_at timestamptz, error text,
              hold_reason text, fulfill_state text, fulfill_error text,
              parcel_status text, recall_requested boolean, tracking_url text,
              extra_awbs text[], consignee text, city text, address text,
              weight text, fee numeric, total_count integer)
language sql security definer set search_path to 'public'
as $$
  with base as (
    select o.*, p.status as pstatus, p.consignee as pconsignee, p.city as pcity,
           p.address as paddress, p.meta->>'weight' as pweight, p.fee as pfee
      from public.nvsh_order o
      left join public.parcels p on p.awb = o.awb
     where o.shop_domain = p_shop
       and (p_filter = 'all'
            or (p_filter = 'held'   and o.status = 'awaiting_approval')
            or (p_filter = 'failed' and o.status in ('failed','skipped'))
            or (p_filter = 'sync'   and o.fulfill_state = 'failed')
            or (p_filter = 'moving' and o.status = 'booked'
                and p.status in ('Collected by rider','Arrived at warehouse',
                                 'Parcel now in transit','Parcel received at destination',
                                 'Parcel out for delivery')))
       and (p_search is null or btrim(p_search) = ''
            or o.order_name ilike '%'||btrim(p_search)||'%'
            or o.shopify_order_id ilike '%'||btrim(p_search)||'%'
            or o.awb ilike '%'||btrim(p_search)||'%'
            or p.consignee ilike '%'||btrim(p_search)||'%'
            or exists (select 1 from unnest(coalesce(o.extra_awbs,'{}')) x
                        where x ilike '%'||btrim(p_search)||'%'))
  )
  select b.order_name, b.shopify_order_id, b.awb, b.status, b.cod_amount,
         b.received_at, b.error, b.hold_reason, b.fulfill_state, b.fulfill_error,
         b.pstatus, b.recall_requested_at is not null,
         case when b.awb is not null
              then 'https://novaxlogistics.com/tracking.html?awb=' || b.awb end,
         b.extra_awbs,
         -- A held order has no parcel yet, so fall back to the payload it was
         -- mapped from. Deciding needs a name and a city, not a dash.
         coalesce(b.pconsignee, b.payload->'shipping_address'->>'name'),
         coalesce(b.pcity,      b.payload->'shipping_address'->>'city'),
         coalesce(b.paddress,   b.payload->'shipping_address'->>'address1'),
         b.pweight, b.pfee,
         (select count(*)::int from base)
    from base b
   order by b.received_at desc
   limit least(greatest(coalesce(p_limit,25),1),100)
  offset greatest(coalesce(p_offset,0),0);
$$;
revoke all on function public.nvsh_recent_orders(text,integer,integer,text,text)
  from public, anon, authenticated;

-- The queue counts behind the tabs, in one round trip.
drop function if exists public.nvsh_shop_state(text);
create or replace function public.nvsh_shop_state(p_shop text)
returns table(shop_domain text, status text, linked boolean, client_name text,
              installed_at timestamptz, last_order_at timestamptz,
              orders_booked integer, pending_count integer, failed_count integer,
              awaiting_count integer, sync_pending_count integer, sync_failed_count integer,
              moving_count integer, booking_mode text, rule_require_confirmed boolean,
              rule_payment_modes text[], rule_shipping_names text[],
              rule_location_ids text[], rule_exclude_tags text[],
              portal_url text, webhooks_ok boolean, last_error text,
              total_orders integer)
language sql security definer set search_path to 'public'
as $$
  select s.shop_domain, s.status, s.client_id is not null, c.name,
         s.installed_at, s.last_order_at, s.orders_booked,
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'pending_link'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status in ('failed','skipped')),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'awaiting_approval'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'ready'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'failed'),
         (select count(*)::int from public.nvsh_order o
            join public.parcels p on p.awb = o.awb
           where o.shop_domain = s.shop_domain and o.status = 'booked'
             and p.status in ('Collected by rider','Arrived at warehouse',
                              'Parcel now in transit','Parcel received at destination',
                              'Parcel out for delivery')),
         s.booking_mode, s.rule_require_confirmed, s.rule_payment_modes,
         s.rule_shipping_names, s.rule_location_ids, s.rule_exclude_tags,
         'https://novaxlogistics.com/client.html',
         s.webhooks_ok, s.last_error,
         (select count(*)::int from public.nvsh_order o where o.shop_domain = s.shop_domain)
    from public.nvsh_shop s
    left join public.clients c on c.id = s.client_id
   where s.shop_domain = p_shop;
$$;
revoke all on function public.nvsh_shop_state(text) from public, anon, authenticated;

-- "Another delivery fee" was too vague to decide from. This is the real number.
create or replace function public.nvsh_quote(p_shop text, p_city text, p_weight text)
returns numeric
language plpgsql security definer set search_path to 'public'
as $$
declare v_client uuid; v_fee numeric;
begin
  select client_id into v_client from public.nvsh_shop
   where shop_domain = p_shop and status = 'active';
  if v_client is null then return null; end if;
  select public.novax_quote_fee(v_client, p_city, p_weight, null, null, null) into v_fee;
  return v_fee;
exception when others then
  return null;   -- a quote is help, not a gate
end $$;
revoke all on function public.nvsh_quote(text,text,text) from public, anon, authenticated;

commit;
select 'ok' as applied;
