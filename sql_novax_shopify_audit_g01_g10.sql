-- ---------------------------------------------------------------------------
-- G01/G02/G04 -- approval released the hold BEFORE it validated anything.
--
-- nvsh_order_decide('approve') set the row to 'received', which is the state
-- the ordinary drain books from. Then the handler refreshed from Shopify. If
-- that refresh failed -- or returned data.order = null, which did not even
-- reach the catch -- the handler told the merchant nothing was booked and left
-- a fully bookable row behind. The drain picked it up a minute later and
-- shipped the address the merchant had just corrected.
--
-- Worse, the bulk path then wrote the row back to 'awaiting_approval'
-- unconditionally, so an order that had ALREADY been booked with a real parcel
-- reappeared in the approval queue with an AWB attached.
--
-- 'validating' is a claimed state no worker books from. Approval moves the row
-- there, validates, and only then releases it. Every failure path returns it to
-- the hold it came from, and nothing may demote a row that has an AWB.
-- ---------------------------------------------------------------------------

begin;

alter table public.nvsh_order drop constraint if exists nvsh_order_status_check;
alter table public.nvsh_order add constraint nvsh_order_status_check
  check (status in ('received','pending_link','awaiting_approval','validating',
                    'booked','skipped','failed','cancelled'));

create or replace function public.nvsh_order_decide(
  p_shop text, p_order_id text, p_decision text)
returns table(ok boolean, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare v_status text;
begin
  select status into v_status from public.nvsh_order
   where shop_domain = p_shop and shopify_order_id = p_order_id for update;
  if not found then
    return query select false, 'No such order.'; return;
  end if;
  if v_status <> 'awaiting_approval' then
    return query select false, 'That order is already ' || v_status || '.'; return;
  end if;

  if p_decision = 'approve' then
    -- NOT 'received'. Nothing books from 'validating'.
    update public.nvsh_order
       set status = 'validating', approved_at = now(), hold_reason = null, updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, 'Checking the current order with Shopify…';
  elsif p_decision = 'reject' then
    update public.nvsh_order
       set status = 'skipped', skip_reason = 'declined by merchant',
           error = 'Declined by merchant', updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, 'Declined. No parcel was created.';
  else
    return query select false, 'Unknown decision.';
  end if;
end $$;
revoke all on function public.nvsh_order_decide(text,text,text) from public, anon, authenticated;

-- Release a validated row, or put it back. Both conditional, so neither can
-- act on a row something else has already moved on.
create or replace function public.nvsh_validation_done(
  p_shop text, p_order_id text, p_ok boolean, p_reason text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare v_hit int;
begin
  if p_ok then
    update public.nvsh_order
       set status = 'received', updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id
       and status = 'validating' and awb is null;
  else
    -- G02: never demote a row that already owns a parcel.
    update public.nvsh_order
       set status = 'awaiting_approval', approved_at = null,
           hold_reason = left(coalesce(p_reason,'Could not confirm the order with Shopify.'), 500),
           updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id
       and status = 'validating' and awb is null;
  end if;
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;
revoke all on function public.nvsh_validation_done(text,text,boolean,text)
  from public, anon, authenticated;

-- Bulk approval claims the same way.
create or replace function public.nvsh_approve_all(p_shop text)
returns table(ok boolean, message text, approved integer)
language plpgsql security definer set search_path to 'public'
as $$
declare v_n integer;
begin
  update public.nvsh_order
     set status = 'validating', approved_at = now(), hold_reason = null, updated_at = now()
   where shop_domain = p_shop and status = 'awaiting_approval';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return query select false, 'Nothing is waiting for approval.', 0; return;
  end if;
  return query select true,
    v_n || ' order' || case when v_n = 1 then '' else 's' end ||
    ' approved. Checking each one with Shopify before booking.', v_n;
end $$;
revoke all on function public.nvsh_approve_all(text) from public, anon, authenticated;

-- G05 -- a custody-read failure only incremented attempts, so at twelve the row
-- sat at 'ready' forever: the claim needs attempts < 12 and the Retry button
-- needs 'failed'. It fell out of both. One shared exhaustion transition.
create or replace function public.nvsh_fulfill_fail(
  p_shop text, p_order_id text, p_worker text, p_error text, p_exhaust boolean)
returns void
language sql security definer set search_path to 'public'
as $$
  update public.nvsh_order
     set fulfill_attempts = coalesce(fulfill_attempts,0) + 1,
         fulfill_state = case
           when p_exhaust or coalesce(fulfill_attempts,0) + 1 >= 12 then 'failed'
           else 'ready' end,
         fulfill_error = left(coalesce(p_error,'unknown'), 500),
         fulfill_leased_until = null, fulfill_lease_owner = null,
         updated_at = now()
   where shop_domain = p_shop and shopify_order_id = p_order_id
     and (fulfill_lease_owner = p_worker or fulfill_lease_owner is null);
$$;
revoke all on function public.nvsh_fulfill_fail(text,text,text,text,boolean)
  from public, anon, authenticated;

-- G07 -- the held-order review summed EVERY line item while booking excludes
-- requires_shipping = false, so a 1 kg physical item beside a 5 kg digital one
-- previewed as 6 kg and quoted a fee the booking would never charge.
-- G06 -- an item whose weight we have never seen was simply left out, and the
-- result was reported as a known weight. It is reported as an estimate now.
drop function if exists public.nvsh_recent_orders(text,integer,integer,text,text);
create or replace function public.nvsh_recent_orders(
  p_shop text, p_limit integer default 25, p_offset integer default 0,
  p_filter text default 'all', p_search text default null)
returns table(order_name text, shopify_order_id text, awb text, status text,
              cod_amount numeric, received_at timestamptz, error text,
              hold_reason text, fulfill_state text, fulfill_error text,
              parcel_status text, recall_requested boolean, tracking_url text,
              extra_awbs text[], consignee text, city text, address text,
              weight text, weight_known boolean, fee numeric, total_count integer)
language sql security definer set search_path to 'public'
as $$
  with base as (
    select o.*, p.status as pstatus, p.fee as pfee,
           coalesce(p.consignee, o.payload->'shipping_address'->>'name') as who,
           coalesce(p.city,      o.payload->'shipping_address'->>'city') as town,
           coalesce(p.address,
             nullif(concat_ws(', ',
               nullif(o.payload->'shipping_address'->>'address1',''),
               nullif(o.payload->'shipping_address'->>'address2','')), '')) as addr,
           -- Only items that actually ship, and only their remaining quantity:
           -- exactly what weightFromOrder() uses.
           (select sum(coalesce((li->>'grams')::numeric,0)
                     * coalesce(nullif(li->>'fulfillable_quantity','')::numeric,
                                nullif(li->>'quantity','')::numeric, 1))
              from jsonb_array_elements(coalesce(o.payload->'line_items','[]'::jsonb)) li
             where coalesce(li->>'requires_shipping','true') <> 'false') as grams,
           -- Any shippable item we could not weigh makes the total an estimate.
           (select bool_or(coalesce((li->>'grams')::numeric,0) <= 0)
              from jsonb_array_elements(coalesce(o.payload->'line_items','[]'::jsonb)) li
             where coalesce(li->>'requires_shipping','true') <> 'false') as any_unweighed
      from public.nvsh_order o
      left join public.parcels p on p.awb = o.awb
     where o.shop_domain = p_shop
       and (p_filter = 'all'
            or (p_filter = 'held'   and o.status in ('awaiting_approval','validating'))
            or (p_filter = 'failed' and o.status in ('failed','skipped'))
            or (p_filter = 'sync'   and o.fulfill_state = 'failed')
            or (p_filter = 'moving' and o.status = 'booked'
                and p.status in ('Collected by rider','Arrived at warehouse',
                                 'Parcel now in transit','Parcel received at destination',
                                 'Parcel out for delivery')))
  ), filtered as (
    select * from base b
     where p_search is null or btrim(p_search) = ''
        or b.order_name ilike '%'||btrim(p_search)||'%'
        or b.shopify_order_id ilike '%'||btrim(p_search)||'%'
        or b.awb ilike '%'||btrim(p_search)||'%'
        or b.who ilike '%'||btrim(p_search)||'%'
        or exists (select 1 from unnest(coalesce(b.extra_awbs,'{}')) x
                    where x ilike '%'||btrim(p_search)||'%')
  )
  select f.order_name, f.shopify_order_id, f.awb, f.status, f.cod_amount,
         f.received_at, f.error, f.hold_reason, f.fulfill_state, f.fulfill_error,
         f.pstatus, f.recall_requested_at is not null,
         case when f.awb is not null
              then 'https://novaxlogistics.com/tracking.html?awb=' || f.awb end,
         f.extra_awbs, f.who, f.town, f.addr,
         coalesce(f.pmeta_weight,
           case when f.grams > 0
                then round(greatest(0.5, ceil(f.grams / 100.0) / 10.0), 1)::text || ' kg' end),
         -- Known only when it came from a real parcel, or when every shippable
         -- item had a weight.
         (f.pmeta_weight is not null) or (f.grams > 0 and not coalesce(f.any_unweighed,false)),
         f.pfee,
         (select count(*)::int from filtered)
    from (select fl.*, p2.meta->>'weight' as pmeta_weight
            from filtered fl left join public.parcels p2 on p2.awb = fl.awb) f
   order by f.received_at desc
   limit least(greatest(coalesce(p_limit,25),1),100)
  offset greatest(coalesce(p_offset,0),0);
$$;
revoke all on function public.nvsh_recent_orders(text,integer,integer,text,text)
  from public, anon, authenticated;

commit;
select 'g01-g07' as check, 'applied' as detail;
