-- ---------------------------------------------------------------------------
-- Closing the three that were left open.
--
-- F20 -- the extra-box "idempotency key" was minted in the page and lost on
-- reload, and the ten-minute window that covered for it was a timer, not
-- idempotency. The real identity was in front of us the whole time: the
-- merchant is asking for a SPECIFIC BOX NUMBER. The screen shows the boxes, so
-- a reload computes the same number, and a package number that already exists
-- is returned rather than booked again. No timer, no lost state.
--
-- F08 -- dissolves with it. The offset bug existed because a retry was looked
-- up by its position in a parallel key array. Identity is the package number
-- now, which is stored on the parcel itself and cannot drift.
-- ---------------------------------------------------------------------------

begin;

alter table public.nvsh_order add column if not exists synced_awbs text[] not null default '{}';

create or replace function public.nvsh_add_package(
  p_shop text, p_order_id text, p_key text, p_consignee text, p_phone text,
  p_city text, p_address text, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_name text,
  p_confirm_additional boolean default false, p_expect_package integer default null)
returns table(ok boolean, awb text, package_no integer, message text, needs_confirm boolean)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_extra text[]; v_status text; v_recall timestamptz; v_client uuid;
  v_no int; v_row public.parcels; v_awb2 text; v_have int;
begin
  select coalesce(o.extra_awbs,'{}'), o.status, o.recall_requested_at
    into v_extra, v_status, v_recall
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

  select client_id into v_client from public.nvsh_shop where shop_domain = p_shop;
  v_have := coalesce(array_length(v_extra,1),0);

  -- The box the merchant is asking for. A reload recomputes the same number
  -- from the same screen, which is what makes this idempotent.
  v_no := coalesce(p_expect_package, v_have + 2);
  if v_no < 2 then v_no := 2; end if;

  -- Already booked? Return it. This covers a lost response, a reload, a second
  -- tab and a double click, without a timer and without a client-side key.
  select p.awb into v_awb2
    from public.parcels p
   where p.client_id = v_client
     and p.meta->>'shopifyShop' = p_shop
     and p.meta->>'shopifyOrderId' = p_order_id
     and p.meta->>'shopifyPackage' = v_no::text;

  if v_awb2 is not null then
    if not (v_awb2 = any(v_extra)) then
      update public.nvsh_order
         set extra_awbs = array_append(coalesce(extra_awbs,'{}'), v_awb2),
             last_package_at = now(), updated_at = now()
       where shop_domain = p_shop and shopify_order_id = p_order_id;
    end if;
    return query select true, v_awb2, v_no,
      'Package ' || v_no || ' is already booked as ' || v_awb2 || '.', false; return;
  end if;

  -- Asking for a box beyond the next one means the screen is out of date.
  if v_no > v_have + 2 then
    return query select false, null::text, v_no,
      'This order has ' || v_have || ' extra box(es). Reload and try again.', false; return;
  end if;

  -- A genuinely NEW box is a new charge, so it is confirmed once.
  if not coalesce(p_confirm_additional,false) and v_have > 0 then
    return query select false, v_extra[v_have], v_no,
      'This order already has ' || v_have || ' extra box(es). Adding another books a separate parcel ' ||
      'and a separate delivery fee. Press again to confirm.', true;
    return;
  end if;

  v_row := public.nvsh_book_parcel(
    p_shop, p_consignee, p_phone, p_city, p_address, 0,
    p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_name, p_order_id, v_no);

  update public.nvsh_order
     set extra_awbs = array_append(coalesce(extra_awbs,'{}'), v_row.awb),
         last_package_at = now(), updated_at = now()
   where shop_domain = p_shop and shopify_order_id = p_order_id;

  return query select true, v_row.awb, v_no,
    'Package ' || v_no || ' booked as ' || v_row.awb || '.', false;
end $$;

revoke all on function public.nvsh_add_package(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,integer)
  from public, anon, authenticated;
drop function if exists public.nvsh_add_package(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean);

-- split_keys is no longer identity; keep the column so old rows still read.
comment on column public.nvsh_order.split_keys is
  'Historic. Package identity is meta->>shopifyPackage on the parcel (F08/F20).';

-- ---------------------------------------------------------------------------
-- F03 -- a box handed over AFTER the order already synced never requeued: the
-- trigger only fired when fulfill_state was 'none'. It requeues on 'done' too,
-- but only when the box entering custody has not already been published --
-- which is what synced_awbs records, so this cannot loop.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_mark_ready_to_fulfill()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if coalesce(new.meta->>'source','') not in ('shopify','shopify_app') then
    return new;
  end if;
  if new.status not in ('Collected by rider','Arrived at warehouse',
                        'Parcel now in transit','Parcel received at destination',
                        'Parcel out for delivery','Delivered') then
    return new;
  end if;

  update public.nvsh_order
     set fulfill_state = 'ready', fulfill_attempts = 0,
         fulfill_leased_until = null, fulfill_lease_owner = null, updated_at = now()
   where (awb = new.awb or new.awb = any(coalesce(extra_awbs,'{}')))
     and fulfill_state in ('none','done')
     and not (new.awb = any(coalesce(synced_awbs,'{}')));

  return new;
end $$;

create or replace function public.nvsh_fulfill_backfill()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_n int;
begin
  update public.nvsh_order o
     set fulfill_state = 'ready', updated_at = now()
    from public.parcels p
   where o.fulfill_state in ('none','done')
     and o.awb is not null
     and (p.awb = o.awb or p.awb = any(coalesce(o.extra_awbs,'{}')))
     and p.status in ('Collected by rider','Arrived at warehouse','Parcel now in transit',
                      'Parcel received at destination','Parcel out for delivery','Delivered')
     and not (p.awb = any(coalesce(o.synced_awbs,'{}')));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.nvsh_fulfill_backfill() from public, anon, authenticated;

commit;
select 'closed' as check, 'F03 F08 F20' as detail;
