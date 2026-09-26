-- ---------------------------------------------------------------------------
-- Third audit pass, A31-A77 (database half).
-- ---------------------------------------------------------------------------

begin;

-- A36 -- the OAuth nonce was read, checked, then updated in three statements,
-- and its age was never checked at all. Two callbacks could both see it unused.
-- One conditional UPDATE, with a TTL, is the whole check.
create or replace function public.nvsh_consume_oauth_state(p_state text, p_shop text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare v_hit int;
begin
  update public.nvsh_oauth_state
     set used_at = now()
   where state = p_state
     and shop_domain = p_shop
     and used_at is null
     and created_at > now() - interval '15 minutes';
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;

revoke all on function public.nvsh_consume_oauth_state(text,text) from public, anon, authenticated;

-- A37 + A38 -- linking read the shop, then wrote it, so two different codes
-- could each see an unlinked shop and the last writer won. And an
-- administratively blocked shop was silently reactivated by anyone who linked
-- it. The UPDATE now carries both conditions, and the row count decides.
create or replace function public.nvsh_link_claim(p_shop text, p_code text)
returns table(ok boolean, client_name text, released integer, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_row public.nvsh_link_code; v_name text; v_released integer := 0;
  v_existing uuid; v_status text; v_hit int;
begin
  -- Lock the SHOP, not just the code. This is the row two racers contend for.
  select client_id, status into v_existing, v_status
    from public.nvsh_shop where shop_domain = p_shop for update;
  if not found then
    return query select false, null::text, 0, 'This store is not installed.'; return;
  end if;
  if v_status = 'blocked' then
    return query select false, null::text, 0,
      'This store is blocked. Contact NovaX support.'; return;
  end if;
  if v_existing is not null then
    select name into v_name from public.clients where id = v_existing;
    return query select false, v_name, 0,
      'This store is already connected to ' || coalesce(v_name,'a NovaX account') || '.'; return;
  end if;

  select * into v_row from public.nvsh_link_code
   where code = upper(btrim(p_code)) for update;

  if not found then
    return query select false, null::text, 0, 'That code is not valid.'; return;
  end if;
  if v_row.used_at is not null then
    return query select false, null::text, 0, 'That code has already been used.'; return;
  end if;
  if v_row.expires_at < now() then
    return query select false, null::text, 0, 'That code has expired. Generate a new one.'; return;
  end if;

  update public.nvsh_shop
     set client_id = v_row.client_id, status = 'active',
         linked_at = now(), updated_at = now()
   where shop_domain = p_shop
     and client_id is null          -- compare-and-set
     and status <> 'blocked';
  get diagnostics v_hit = row_count;
  if v_hit <> 1 then
    return query select false, null::text, 0,
      'This store was connected by someone else a moment ago.'; return;
  end if;

  update public.nvsh_link_code
     set used_at = now(), used_by_shop = p_shop
   where code = v_row.code;

  update public.nvsh_order
     set status = 'received', client_id = v_row.client_id, updated_at = now()
   where shop_domain = p_shop and status = 'pending_link';
  get diagnostics v_released = row_count;

  select name into v_name from public.clients where id = v_row.client_id;
  return query select true, v_name, v_released,
    'Connected to ' || coalesce(v_name,'your NovaX account') || '.';
end $$;

revoke all on function public.nvsh_link_claim(text,text) from public, anon, authenticated;

-- A46 + A47 -- "handover" was any status that was not one of three negatives,
-- so an administrative correction counted as physical custody and emailed the
-- buyer a tracking number. Custody is an explicit whitelist now. A47: the
-- trigger only fired on a transition OUT of 'New booked', so a parcel that
-- moved before nvsh_order.awb was written matched no order and never queued;
-- it now matches on any custody status while the order is still unfulfilled.
create or replace function public.nvsh_mark_ready_to_fulfill()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if coalesce(new.meta->>'source','') not in ('shopify','shopify_app') then
    return new;
  end if;

  -- Statuses that mean NovaX physically has the parcel.
  if new.status not in ('Collected by rider','Arrived at warehouse',
                        'Parcel now in transit','Parcel received at destination',
                        'Parcel out for delivery','Delivered') then
    return new;
  end if;

  update public.nvsh_order
     set fulfill_state = 'ready', updated_at = now()
   where fulfill_state = 'none'
     and (awb = new.awb or new.awb = any(coalesce(extra_awbs,'{}')));

  return new;
end $$;

-- A47 second half: a sweep for parcels that reached custody while their order
-- row had no AWB yet, so the trigger matched nothing and no later transition
-- would start it.
create or replace function public.nvsh_fulfill_backfill()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_n int;
begin
  update public.nvsh_order o
     set fulfill_state = 'ready', updated_at = now()
    from public.parcels p
   where o.fulfill_state = 'none'
     and o.awb is not null
     and p.awb = o.awb
     and p.status in ('Collected by rider','Arrived at warehouse','Parcel now in transit',
                      'Parcel received at destination','Parcel out for delivery','Delivered');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.nvsh_fulfill_backfill() from public, anon, authenticated;

-- A50 -- "is there an open pickup" then "insert one" is a check-then-insert
-- race: two clicks became two rider trips. A partial unique index makes the
-- database refuse the second one.
create unique index if not exists pickup_requests_one_open_per_client
  on public.pickup_requests (client_id)
  where status in ('Requested','Assigned');

-- A51 -- an open pickup blocked every later parcel and every other store on the
-- account. A second request now APPENDS the new AWBs to the open one instead of
-- refusing, and says so.
-- A54 -- the recall branch was hardcoded to Karachi; it follows the parcel now.
create or replace function public.nvsh_pickup_request(p_shop text, p_note text)
returns table(ok boolean, message text, awb_count integer)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_client uuid; v_awbs text[]; v_addr text; v_open uuid; v_have jsonb;
  v_new text[]; v_added int;
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

  select id, awbs into v_open, v_have
    from public.pickup_requests
   where client_id = v_client and status in ('Requested','Assigned')
   for update;

  if v_open is not null then
    select array_agg(a) into v_new
      from unnest(v_awbs) a
     where a not in (select jsonb_array_elements_text(v_have));
    if v_new is null or array_length(v_new,1) is null then
      return query select true,
        'These parcels are already on the pickup a rider is coming for.',
        array_length(v_awbs,1);
      return;
    end if;
    update public.pickup_requests
       set awbs = v_have || to_jsonb(v_new), updated_at = now()
     where id = v_open;
    v_added := array_length(v_new,1);
    return query select true,
      v_added || ' more parcel' || case when v_added=1 then '' else 's' end ||
      ' added to the pickup a rider is already coming for.',
      array_length(v_awbs,1);
    return;
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

-- A52 + A53 + A54 -- cancelled boxes were only dropped from the pickup on the
-- cancel branch, so a mixed cancel/recall left them on a rider's list. Recall
-- issues had no uniqueness key, so a retried webhook raised duplicates. And the
-- branch was always 'Karachi'.
create unique index if not exists operations_issues_one_open_recall
  on public.operations_issues ((meta->>'shopifyRecallAwb'))
  where not resolved and meta->>'shopifyRecallAwb' is not null;

create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql security definer set search_path to 'public'
as $$
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
  v_all := array_prepend(v_awb, v_extra);

  foreach v_awb2 in array v_all loop
    select status, coalesce(nullif(btrim(branch),''),'Karachi')
      into v_pstatus, v_branch
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
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;

-- A74 -- nvsh_gc() existed and nothing ever called it, and it pruned neither
-- used link codes nor order payloads. The raw Shopify payload is the largest
-- thing we keep and the most sensitive.
create or replace function public.nvsh_gc() returns void
language sql security definer set search_path to 'public'
as $$
  delete from public.nvsh_oauth_state where created_at < now() - interval '1 hour';
  delete from public.nvsh_event        where created_at < now() - interval '30 days';
  delete from public.nvsh_link_code    where expires_at < now() - interval '1 day';
  -- The payload is only needed until the parcel is booked and settled. After
  -- 30 days it is a copy of someone's name, address and phone with no job.
  update public.nvsh_order
     set payload = null
   where payload is not null
     and status in ('booked','skipped','cancelled')
     and updated_at < now() - interval '30 days';
$$;

revoke all on function public.nvsh_gc() from public, anon, authenticated;

select cron.unschedule('novax-shopify-gc') where exists (select 1 from cron.job where jobname='novax-shopify-gc');
select cron.schedule('novax-shopify-gc', '25 4 * * *', 'select public.nvsh_gc();');

commit;

select jobname, schedule from cron.job where jobname like 'novax-shopify%' order by jobname;
