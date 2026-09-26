begin;

drop function if exists public.nvsh_recent_orders(text,integer);
drop function if exists public.nvsh_shop_state(text);

-- The embedded app needs to tell three different "not delivered yet" states
-- apart: booked and waiting for a rider, booked but Shopify has not been told,
-- and not booked at all. One "status" column cannot carry that, so the sync
-- state travels beside it.
create or replace function public.nvsh_recent_orders(p_shop text, p_limit integer default 20)
returns table(order_name text, shopify_order_id text, awb text, status text,
              cod_amount numeric, received_at timestamptz, error text,
              hold_reason text, fulfill_state text, fulfill_error text,
              parcel_status text, recall_requested boolean, tracking_url text)
language sql
security definer
set search_path to 'public'
as $function$
  select o.order_name, o.shopify_order_id, o.awb, o.status, o.cod_amount,
         o.received_at, o.error, o.hold_reason,
         o.fulfill_state, o.fulfill_error,
         p.status,
         o.recall_requested_at is not null,
         case when o.awb is not null
              then 'https://novaxlogistics.com/tracking.html?awb=' || o.awb end
    from public.nvsh_order o
    left join public.parcels p on p.awb = o.awb
   where o.shop_domain = p_shop
   order by o.received_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$function$;

create or replace function public.nvsh_shop_state(p_shop text)
returns table(shop_domain text, status text, linked boolean, client_name text,
              installed_at timestamptz, last_order_at timestamptz,
              orders_booked integer, pending_count integer, failed_count integer,
              awaiting_count integer, sync_pending_count integer, sync_failed_count integer,
              booking_mode text, rule_require_confirmed boolean,
              rule_payment_modes text[], rule_shipping_names text[],
              rule_location_ids text[], rule_exclude_tags text[],
              portal_url text)
language sql
security definer
set search_path to 'public'
as $function$
  select s.shop_domain, s.status, s.client_id is not null, c.name,
         s.installed_at, s.last_order_at, s.orders_booked,
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'pending_link'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'failed'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'awaiting_approval'),
         -- Booked, parcel real, Shopify not yet told. NOT a failure.
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'ready'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'failed'),
         s.booking_mode, s.rule_require_confirmed, s.rule_payment_modes,
         s.rule_shipping_names, s.rule_location_ids, s.rule_exclude_tags,
         'https://novaxlogistics.com/client.html'
    from public.nvsh_shop s
    left join public.clients c on c.id = s.client_id
   where s.shop_domain = p_shop;
$function$;

commit;
select 'ok' as applied;
