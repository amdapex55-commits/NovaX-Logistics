-- ---------------------------------------------------------------------------
-- B01 -- the migration that should have existed.
--
-- Five schema objects were added with ad-hoc ALTER TABLE at a psql prompt while
-- fixing A23/A26/A41/A43/A25 and never written down. They exist in production
-- and in nothing else, so a database built from the README could not run the
-- deployed code: booking would commit a parcel and then fail the link update,
-- and the fulfillment query would error before processing anything.
--
-- Everything here is idempotent and safe to run against the live database.
-- ---------------------------------------------------------------------------

begin;

alter table public.nvsh_shop
  add column if not exists webhooks_ok      boolean not null default true,
  -- B08/B24: the reconciliation sweep resumes from a checkpoint, and shops are
  -- swept oldest-first so none is starved.
  add column if not exists reconcile_cursor text,
  add column if not exists reconciled_at    timestamptz;

create index if not exists nvsh_shop_reconcile_idx
  on public.nvsh_shop (reconciled_at nulls first)
  where status = 'active' and client_id is not null;

alter table public.nvsh_order
  add column if not exists next_attempt_at         timestamptz,
  add column if not exists fulfill_leased_until    timestamptz,
  add column if not exists shopify_fulfillment_ids text[],
  add column if not exists split_keys              text[] not null default '{}';

create index if not exists nvsh_order_next_attempt_idx
  on public.nvsh_order (next_attempt_at)
  where status in ('received','failed');

-- A25: the booking counter, as one atomic statement.
create or replace function public.nvsh_count_booked(p_shop text)
returns void language sql security definer set search_path to 'public' as $$
  update public.nvsh_shop
     set orders_booked = coalesce(orders_booked,0) + 1,
         last_order_at = now(), updated_at = now()
   where shop_domain = p_shop;
$$;
revoke all on function public.nvsh_count_booked(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B05 -- the fulfillment "lease" was a SELECT that checked expiry followed by a
-- PATCH that did not, so two workers that both read the row both got the lease.
-- One statement, SKIP LOCKED, and an ownership token.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_claim_fulfill(p_worker text, p_limit int default 25)
returns table(shop_domain text, shopify_order_id text, awb text,
              extra_awbs text[], fulfill_attempts integer)
language plpgsql security definer set search_path to 'public'
as $$
begin
  return query
  with picked as (
    select o.id
      from public.nvsh_order o
     where o.fulfill_state = 'ready'
       and o.awb is not null
       and o.fulfill_attempts < 12
       and (o.fulfill_leased_until is null or o.fulfill_leased_until < now())
     order by o.updated_at asc
     limit greatest(coalesce(p_limit,25), 1)
     for update skip locked
  )
  update public.nvsh_order o
     set fulfill_leased_until = now() + interval '3 minutes',
         fulfill_lease_owner  = p_worker
    from picked
   where o.id = picked.id
  returning o.shop_domain, o.shopify_order_id, o.awb, o.extra_awbs, o.fulfill_attempts;
end $$;

alter table public.nvsh_order add column if not exists fulfill_lease_owner text;
revoke all on function public.nvsh_claim_fulfill(text,int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B06 -- the scheduler only fired when some row had fewer than SIX attempts,
-- while the worker keeps rows 'ready' until TWELVE. Once every ready row passed
-- six, nothing scheduled them again and the retry button was not offered
-- either, because it only appears on 'failed'. The two now agree.
-- B12 -- nvsh_fulfill_backfill() had no caller at all.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_fulfill_tick()
returns void language plpgsql security definer set search_path to 'public'
as $$
declare v_pending int;
begin
  -- A parcel that entered custody before its order row carried an AWB matched
  -- no trigger and would never queue. Sweep for those first.
  perform public.nvsh_fulfill_backfill();

  select count(*) into v_pending
    from public.nvsh_order
   where fulfill_state = 'ready' and fulfill_attempts < 12;
  if v_pending = 0 then return; end if;

  perform net.http_post(
    url     := 'https://novaxlogistics.com/shopify/fulfill',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-novax-drain', public.nvsh_drain_token()),
    timeout_milliseconds := 25000
  );
end $$;
revoke all on function public.nvsh_fulfill_tick() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B07 -- booking validated the order status, then called the booking RPC, then
-- wrote the link, in three separate transactions. A cancellation landing in
-- either gap produced a real parcel for a cancelled order. All three now happen
-- under one lock on the order row.
-- B09 -- the package number came from array length, so a lost response and a
-- repeated request produced package 3 instead of recovering package 2. The
-- caller's idempotency key decides.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_book_linked(
  p_shop text, p_order_id text, p_consignee text, p_phone text, p_city text,
  p_address text, p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_name text, p_client_id uuid)
returns table(ok boolean, awb text, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare v_status text; v_awb text; v_row public.parcels;
begin
  select o.status, o.awb into v_status, v_awb
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;                                    -- the lock cancellation takes

  if not found then
    return query select false, null::text, 'order row missing'; return;
  end if;
  if v_status = 'cancelled' then
    return query select false, null::text, 'cancelled while processing'; return;
  end if;
  if v_awb is not null then
    return query select true, v_awb, 'already booked'; return;
  end if;

  -- An existing parcel for this order is adopted, never duplicated.
  select p.awb into v_awb from public.parcels p
   where p.client_id = p_client_id
     and p.meta->>'shopifyShop' = p_shop
     and p.meta->>'shopifyOrderId' = p_order_id
     and coalesce(p.meta->>'shopifyPackage','1') = '1';

  if v_awb is null then
    v_row := public.nvsh_book_parcel(
      p_shop, p_consignee, p_phone, p_city, p_address, p_cod, p_weight,
      p_service, p_category, p_fragile, p_payment_mode, p_order_name, p_order_id, 1);
    v_awb := v_row.awb;
  end if;

  update public.nvsh_order
     set status='booked', awb=v_awb, cod_amount=p_cod, client_id=p_client_id,
         booked_at=now(), updated_at=now(), error=null,
         attempts=0, next_attempt_at=null
   where shop_domain=p_shop and shopify_order_id=p_order_id;

  return query select true, v_awb, 'booked';
end $$;
revoke all on function public.nvsh_book_linked(text,text,text,text,text,text,numeric,text,text,text,text,text,text,uuid)
  from public, anon, authenticated;

create or replace function public.nvsh_add_package(
  p_shop text, p_order_id text, p_key text, p_consignee text, p_phone text,
  p_city text, p_address text, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_name text)
returns table(ok boolean, awb text, package_no integer, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_extra text[]; v_keys text[]; v_status text; v_recall timestamptz;
  v_no int; v_row public.parcels; v_idx int; v_awb2 text;
begin
  select coalesce(o.extra_awbs,'{}'), coalesce(o.split_keys,'{}'), o.status, o.recall_requested_at
    into v_extra, v_keys, v_status, v_recall
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;

  if not found then
    return query select false, null::text, 0, 'No such order.'; return;
  end if;
  if v_status <> 'booked' then
    return query select false, null::text, 0,
      'This order is ' || v_status || '. Extra boxes can only be added to a booked order.'; return;
  end if;
  if v_recall is not null then
    return query select false, null::text, 0,
      'A recall has been raised for this order, so no more boxes can be added.'; return;
  end if;

  -- B09: the same key is the same intent. A repeat returns what it made.
  v_idx := array_position(v_keys, p_key);
  if v_idx is not null then
    return query select true, v_extra[v_idx], v_idx + 1,
      'That box was already booked as ' || v_extra[v_idx] || '.'; return;
  end if;

  v_no := coalesce(array_length(v_extra,1),0) + 2;

  -- A19 again, from the other side: a parcel can exist at this package number
  -- while the order row does not know about it -- the booking committed and the
  -- extra_awbs write did not. Adopt it instead of colliding with the unique
  -- index, which is what turned a lost response into a permanent error.
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
           updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, v_awb2, v_no,
      'Package ' || v_no || ' was already booked as ' || v_awb2 || '.'; return;
  end if;

  v_row := public.nvsh_book_parcel(
    p_shop, p_consignee, p_phone, p_city, p_address,
    0,                       -- COD is collected once, on the first box
    p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_name, p_order_id, v_no);

  update public.nvsh_order
     set extra_awbs = array_append(coalesce(extra_awbs,'{}'), v_row.awb),
         split_keys = array_append(coalesce(split_keys,'{}'), p_key),
         updated_at = now()
   where shop_domain = p_shop and shopify_order_id = p_order_id;

  return query select true, v_row.awb, v_no, 'Package ' || v_no || ' booked as ' || v_row.awb || '.';
end $$;
revoke all on function public.nvsh_add_package(text,text,text,text,text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B20 -- the banner asked for webhooks_ok and last_error and the state RPC
-- never returned them, so a store whose order delivery was broken still showed
-- a green "Connected".
-- ---------------------------------------------------------------------------

drop function if exists public.nvsh_shop_state(text);
create or replace function public.nvsh_shop_state(p_shop text)
returns table(shop_domain text, status text, linked boolean, client_name text,
              installed_at timestamptz, last_order_at timestamptz,
              orders_booked integer, pending_count integer, failed_count integer,
              awaiting_count integer, sync_pending_count integer, sync_failed_count integer,
              booking_mode text, rule_require_confirmed boolean,
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
           where o.shop_domain = s.shop_domain and o.status = 'failed'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.status = 'awaiting_approval'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'ready'),
         (select count(*)::int from public.nvsh_order o
           where o.shop_domain = s.shop_domain and o.fulfill_state = 'failed'),
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

-- ---------------------------------------------------------------------------
-- B21 -- the order list was capped with a warning and no way past it.
-- Server-side paging and an "action required" filter.
-- ---------------------------------------------------------------------------

drop function if exists public.nvsh_recent_orders(text,integer);
create or replace function public.nvsh_recent_orders(
  p_shop text, p_limit integer default 50, p_offset integer default 0,
  p_filter text default 'all', p_search text default null)
returns table(order_name text, shopify_order_id text, awb text, status text,
              cod_amount numeric, received_at timestamptz, error text,
              hold_reason text, fulfill_state text, fulfill_error text,
              parcel_status text, recall_requested boolean, tracking_url text,
              extra_awbs text[], total_count integer)
language sql security definer set search_path to 'public'
as $$
  with base as (
    select o.*, p.status as pstatus
      from public.nvsh_order o
      left join public.parcels p on p.awb = o.awb
     where o.shop_domain = p_shop
       and (p_filter = 'all'
            or (p_filter = 'action' and (o.status in ('awaiting_approval','failed','skipped')
                                         or o.fulfill_state = 'failed'))
            or (p_filter = 'held'    and o.status = 'awaiting_approval')
            or (p_filter = 'failed'  and (o.status = 'failed' or o.fulfill_state = 'failed'))
            or (p_filter = 'booked'  and o.status = 'booked'))
       and (p_search is null or btrim(p_search) = ''
            or o.order_name ilike '%'||btrim(p_search)||'%'
            or o.shopify_order_id ilike '%'||btrim(p_search)||'%'
            or o.awb ilike '%'||btrim(p_search)||'%'
            or exists (select 1 from unnest(coalesce(o.extra_awbs,'{}')) x
                        where x ilike '%'||btrim(p_search)||'%'))
  )
  select b.order_name, b.shopify_order_id, b.awb, b.status, b.cod_amount,
         b.received_at, b.error, b.hold_reason, b.fulfill_state, b.fulfill_error,
         b.pstatus, b.recall_requested_at is not null,
         case when b.awb is not null
              then 'https://novaxlogistics.com/tracking.html?awb=' || b.awb end,
         b.extra_awbs,
         (select count(*)::int from base)
    from base b
   order by b.received_at desc
   limit least(greatest(coalesce(p_limit,50),1),100)
  offset greatest(coalesce(p_offset,0),0);
$$;
revoke all on function public.nvsh_recent_orders(text,integer,integer,text,text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B27 + B28 -- customers/redact wrote the WHOLE incoming payload into the
-- privacy queue. That payload can carry the customer's email and phone, so a
-- redaction request created a fresh permanent copy of the data it was asking us
-- to delete. And shop/redact never cleared the queue.
-- The queue also gains completion, an owner, and a retention sweep.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_privacy_log(
  p_shop text, p_kind text, p_customer text, p_orders text[], p_payload jsonb)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid;
begin
  insert into public.nvsh_privacy_request
    (shop_domain, kind, shopify_customer_id, orders_requested, payload, due_at,
     status, completed_at, note)
  values (
    p_shop, p_kind, p_customer, p_orders,
    -- B27: keep the SHAPE of the request, never its contents.
    jsonb_build_object(
      'received_at', now(),
      'order_count', coalesce(array_length(p_orders,1),0),
      'payload_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb)
                         from jsonb_object_keys(coalesce(p_payload,'{}'::jsonb)) k)),
    now() + interval '30 days',
    -- B28: a redact is executed by the handler that logs it. Recording it as
    -- 'open' generated overdue work for something already done.
    case when p_kind in ('customers/redact','shop/redact') then 'fulfilled' else 'open' end,
    case when p_kind in ('customers/redact','shop/redact') then now() end,
    case when p_kind in ('customers/redact','shop/redact')
         then 'Executed automatically when the webhook was received.' end)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.nvsh_privacy_log(text,text,text,text[],jsonb)
  from public, anon, authenticated;

create or replace function public.nvsh_privacy_complete(p_id uuid, p_by text, p_note text)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare v_hit int;
begin
  update public.nvsh_privacy_request
     set status='fulfilled', completed_at=now(),
         completed_by=left(coalesce(p_by,'ops'),120), note=left(coalesce(p_note,''),1000)
   where id = p_id and status in ('open','in_progress');
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;
revoke all on function public.nvsh_privacy_complete(uuid,text,text) from public, anon;

-- shop/redact must clear this queue for that shop too.
create or replace function public.nvsh_privacy_purge_shop(p_shop text)
returns void language sql security definer set search_path to 'public' as $$
  delete from public.nvsh_privacy_request
   where shop_domain = p_shop and kind <> 'shop/redact';
$$;
revoke all on function public.nvsh_privacy_purge_shop(text) from public, anon, authenticated;

create or replace function public.nvsh_gc() returns void
language sql security definer set search_path to 'public'
as $$
  delete from public.nvsh_oauth_state where created_at < now() - interval '1 hour';
  delete from public.nvsh_event        where created_at < now() - interval '30 days';
  delete from public.nvsh_link_code    where expires_at < now() - interval '1 day';
  -- B27: the queue has its own retention now.
  delete from public.nvsh_privacy_request
   where status = 'fulfilled' and completed_at < now() - interval '180 days';
  update public.nvsh_order
     set payload = null
   where payload is not null
     and status in ('booked','skipped','cancelled')
     and updated_at < now() - interval '30 days';
$$;
revoke all on function public.nvsh_gc() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B29 -- the portal comment said a live code is reused; the SQL always deleted
-- and replaced it, so opening a second tab invalidated a code already pasted
-- into Shopify. Reuse unless rotation is asked for explicitly.
-- ---------------------------------------------------------------------------

create or replace function public.nvsh_link_code_issue(p_force boolean default false)
returns table(code text, expires_at timestamptz)
language plpgsql security definer set search_path to 'public'
as $$
declare v_client uuid := public.my_client_id(); v_code text; v_exp timestamptz;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.';
  end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only an account owner can connect a Shopify store.';
  end if;

  -- One writer at a time, so two tabs cannot both mint.
  perform pg_advisory_xact_lock(hashtext('nvsh_link_code:' || v_client::text));

  if not coalesce(p_force,false) then
    select c.code, c.expires_at into v_code, v_exp
      from public.nvsh_link_code c
     where c.client_id = v_client and c.used_at is null and c.expires_at > now()
     order by c.issued_at desc limit 1;
    if v_code is not null then
      return query select v_code, v_exp; return;
    end if;
  end if;

  delete from public.nvsh_link_code where client_id = v_client and used_at is null;
  v_code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',(floor(random()*32)+1)::int,1),'')
               from generate_series(1,8));
  insert into public.nvsh_link_code (code, client_id, issued_by, expires_at)
  values (v_code, v_client, auth.uid(), now() + interval '20 minutes');
  return query select v_code, now() + interval '20 minutes';
end $$;
revoke all on function public.nvsh_link_code_issue(boolean) from public, anon;
grant execute on function public.nvsh_link_code_issue(boolean) to authenticated;
drop function if exists public.nvsh_link_code_issue();

commit;

select 'columns' as check, string_agg(column_name, ', ' order by column_name) as detail
  from information_schema.columns
 where table_schema='public' and table_name='nvsh_order'
   and column_name in ('next_attempt_at','fulfill_leased_until','shopify_fulfillment_ids','split_keys','fulfill_lease_owner')
union all
select 'functions', string_agg(proname, ', ' order by proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname in
  ('nvsh_count_booked','nvsh_claim_fulfill','nvsh_book_linked','nvsh_add_package',
   'nvsh_privacy_complete','nvsh_privacy_purge_shop');
