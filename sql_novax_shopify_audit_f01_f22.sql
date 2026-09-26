-- ---------------------------------------------------------------------------
-- Fourth audit pass, database half.
-- ---------------------------------------------------------------------------

begin;

-- F01 -- the revoke listed public and anon and omitted authenticated. The LIVE
-- ACL happens to be clean (checked: postgres and service_role only), so this
-- was never exploitable here -- but a fresh deploy onto a project whose default
-- privileges grant authenticated would hand every signed-in merchant the
-- ability to mark someone's privacy request fulfilled under a forged name.
-- Revoked explicitly, and the function now refuses a non-admin caller outright.
create or replace function public.nvsh_privacy_complete(p_id uuid, p_by text, p_note text)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare v_hit int;
begin
  -- auth.uid() is null for the service role and cron, which is how ops tooling
  -- reaches this. A signed-in merchant is not an operator.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only a NovaX admin can complete a privacy request.';
  end if;
  update public.nvsh_privacy_request
     set status='fulfilled', completed_at=now(),
         completed_by=left(coalesce(nullif(btrim(p_by),''),
                                    coalesce(auth.uid()::text,'service')),120),
         note=left(coalesce(p_note,''),1000)
   where id = p_id and status in ('open','in_progress');
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;
revoke all on function public.nvsh_privacy_complete(uuid,text,text)
  from public, anon, authenticated;

-- F07 -- novax_quote_fee returns JSONB, not numeric. Assigning it to a numeric
-- variable raised a conversion error that the exception handler swallowed into
-- NULL, so the fee preview always read "quoted at pickup" -- which is also a
-- lie, because booking is what creates the charge.
create or replace function public.nvsh_quote(p_shop text, p_city text, p_weight text)
returns numeric
language plpgsql security definer set search_path to 'public'
as $$
declare v_client uuid; v_out jsonb; v_fee numeric;
begin
  select client_id into v_client from public.nvsh_shop
   where shop_domain = p_shop and status = 'active';
  if v_client is null then return null; end if;

  v_out := public.novax_quote_fee(v_client, p_city, p_weight, null, null, null);
  -- Accept the documented shape and a bare number, and nothing else.
  v_fee := coalesce(
    nullif(v_out->>'fee','')::numeric,
    nullif(v_out->>'total','')::numeric,
    case when jsonb_typeof(v_out) = 'number' then v_out::text::numeric end);
  return v_fee;
exception when others then
  return null;
end $$;
revoke all on function public.nvsh_quote(text,text,text) from public, anon, authenticated;

-- F08 -- split_keys and extra_awbs were parallel arrays, and the migration
-- seeded split_keys empty on orders that ALREADY had extra boxes. A new key
-- then landed at index 1 while its parcel was package 4, so a retry of that key
-- returned the legacy box. Pad the key array so position and package agree.
update public.nvsh_order
   set split_keys = (
     select array_agg(coalesce(split_keys[i], 'legacy:' || extra_awbs[i]))
       from generate_subscripts(extra_awbs, 1) i)
 where coalesce(array_length(extra_awbs,1),0) > coalesce(array_length(split_keys,1),0);

-- F13 + F17 -- a held order has no parcel row, so weight and recipient came
-- back null: the review panel showed the 0.8 kg default for a known 5 kg order,
-- and recipient search could not find the very order it had just displayed.
-- Everything falls back to the payload the order was mapped from.
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
           -- Weight from the parcel when it exists; otherwise derived from the
           -- webhook payload's grams, which is what booking would use.
           coalesce(p.meta->>'weight',
             case when o.payload is not null then (
               select case when sum(coalesce((li->>'grams')::numeric,0)
                                    * coalesce((li->>'fulfillable_quantity')::numeric,
                                               (li->>'quantity')::numeric, 1)) > 0
                           then round(greatest(0.5, ceil(
                                sum(coalesce((li->>'grams')::numeric,0)
                                  * coalesce((li->>'fulfillable_quantity')::numeric,
                                             (li->>'quantity')::numeric, 1)) / 100.0) / 10.0), 1)::text || ' kg'
                      end
                 from jsonb_array_elements(coalesce(o.payload->'line_items','[]'::jsonb)) li)
             end) as wt
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
  ), filtered as (
    select * from base b
     where p_search is null or btrim(p_search) = ''
        or b.order_name ilike '%'||btrim(p_search)||'%'
        or b.shopify_order_id ilike '%'||btrim(p_search)||'%'
        or b.awb ilike '%'||btrim(p_search)||'%'
        -- F17: the SAME value the screen shows, so a held order is findable.
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
         f.wt, f.wt is not null, f.pfee,
         (select count(*)::int from filtered)
    from filtered f
   order by f.received_at desc
   limit least(greatest(coalesce(p_limit,25),1),100)
  offset greatest(coalesce(p_offset,0),0);
$$;
revoke all on function public.nvsh_recent_orders(text,integer,integer,text,text)
  from public, anon, authenticated;

commit;

select 'quote' as check, coalesce(public.nvsh_quote('nova-test-sblskclr.myshopify.com','Karachi','0.5 kg')::text,'NULL') as detail
union all
select 'privacy acl', coalesce(array_to_string(proacl,' | '),'DEFAULT')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname='nvsh_privacy_complete';

-- ---------------------------------------------------------------------------
-- F20 -- the split idempotency key lived only in the page's memory. A lost
-- success response followed by a reload produced a NEW key, which the database
-- correctly treated as a new intent -- and booked a second chargeable box.
-- The database cannot know two keys mean one retry, so it asks: an unknown key
-- arriving within ten minutes of the last box on the same order is treated as a
-- probable retry and refused until the merchant says otherwise.
-- ---------------------------------------------------------------------------

begin;

alter table public.nvsh_order add column if not exists last_package_at timestamptz;

create or replace function public.nvsh_add_package(
  p_shop text, p_order_id text, p_key text, p_consignee text, p_phone text,
  p_city text, p_address text, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_name text,
  p_confirm_additional boolean default false)
returns table(ok boolean, awb text, package_no integer, message text, needs_confirm boolean)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_extra text[]; v_keys text[]; v_status text; v_recall timestamptz;
  v_no int; v_row public.parcels; v_idx int; v_awb2 text; v_last timestamptz;
begin
  select coalesce(o.extra_awbs,'{}'), coalesce(o.split_keys,'{}'), o.status,
         o.recall_requested_at, o.last_package_at
    into v_extra, v_keys, v_status, v_recall, v_last
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;

  if not found then
    return query select false, null::text, 0, 'No such order.', false; return;
  end if;
  if v_status <> 'booked' then
    return query select false, null::text, 0,
      'This order is ' || v_status || '. Extra boxes can only be added to a booked order.', false; return;
  end if;
  if v_recall is not null then
    return query select false, null::text, 0,
      'A recall has been raised for this order, so no more boxes can be added.', false; return;
  end if;

  -- Same intent, same box.
  v_idx := array_position(v_keys, p_key);
  if v_idx is not null then
    return query select true, v_extra[v_idx], v_idx + 1,
      'That box was already booked as ' || v_extra[v_idx] || '.', false; return;
  end if;

  -- F20: a new key moments after the last box is far more likely a retry that
  -- lost its response than a genuine second box.
  if not coalesce(p_confirm_additional,false)
     and v_last is not null and v_last > now() - interval '10 minutes'
     and array_length(v_extra,1) is not null then
    return query select false, v_extra[array_length(v_extra,1)], array_length(v_extra,1) + 1,
      'A box was already added to this order a moment ago (' ||
      v_extra[array_length(v_extra,1)] || '). If you meant to add ANOTHER one, press again to confirm — ' ||
      'it is a separate parcel and a separate delivery fee.', true;
    return;
  end if;

  v_no := coalesce(array_length(v_extra,1),0) + 2;

  select p.awb into v_awb2
    from public.parcels p
    join public.nvsh_shop s on s.shop_domain = p_shop
   where p.client_id = s.client_id
     and p.meta->>'shopifyShop' = p_shop
     and p.meta->>'shopifyOrderId' = p_order_id
     and p.meta->>'shopifyPackage' = v_no::text;
  if v_awb2 is not null then
    update public.nvsh_order
       set extra_awbs = array_append(coalesce(extra_awbs,'{}'), v_awb2),
           split_keys = array_append(coalesce(split_keys,'{}'), p_key),
           last_package_at = now(), updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, v_awb2, v_no,
      'Package ' || v_no || ' was already booked as ' || v_awb2 || '.', false; return;
  end if;

  v_row := public.nvsh_book_parcel(
    p_shop, p_consignee, p_phone, p_city, p_address, 0,
    p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_name, p_order_id, v_no);

  update public.nvsh_order
     set extra_awbs = array_append(coalesce(extra_awbs,'{}'), v_row.awb),
         split_keys = array_append(coalesce(split_keys,'{}'), p_key),
         last_package_at = now(), updated_at = now()
   where shop_domain = p_shop and shopify_order_id = p_order_id;

  return query select true, v_row.awb, v_no,
    'Package ' || v_no || ' booked as ' || v_row.awb || '.', false;
end $$;

revoke all on function public.nvsh_add_package(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean)
  from public, anon, authenticated;
drop function if exists public.nvsh_add_package(text,text,text,text,text,text,text,text,text,text,text,text,text);

commit;
select 'f20' as check, 'ok' as detail;
