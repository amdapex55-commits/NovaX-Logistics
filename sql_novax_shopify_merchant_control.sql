-- ---------------------------------------------------------------------------
-- Shopify app: merchants link themselves, control what gets booked, and can
-- stop a parcel without phoning anyone.
--
-- Three things this replaces:
--
-- 1. LINKING. nvsh_admin_link() is an admin running SQL by hand. Until someone
--    did, a merchant sat on "waiting for NovaX to confirm your account" with no
--    action available -- which is also what an app reviewer sees. Linking is now
--    a claim code: the merchant proves they own the NovaX account by being
--    signed into it in the portal, issues a short-lived code there, and pastes
--    it into Shopify. Ownership is proven by a session, never inferred by
--    matching an email address, which would let anyone who knows a merchant's
--    email attach their store to that merchant's wallet.
--
-- 2. BOOKING CONTROL. Every order was booked. A merchant who sells digital
--    goods, ships some orders themselves, or wants to eyeball an order first
--    had no way to say so.
--
-- 3. CANCELLATION. orders/cancelled wrote a note and did nothing. Before pickup
--    a cancellation can still cancel the parcel. After pickup it cannot -- a
--    rider is carrying it -- so it becomes a recall request for operations.
-- ---------------------------------------------------------------------------

begin;

-- ------------------------------------------------------------ settings -----

alter table public.nvsh_shop
  add column if not exists booking_mode           text    not null default 'auto',
  add column if not exists rule_require_confirmed boolean not null default false,
  add column if not exists rule_payment_modes     text[],
  add column if not exists rule_shipping_names    text[],
  add column if not exists rule_location_ids      text[],
  add column if not exists rule_exclude_tags      text[]  not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nvsh_shop_booking_mode_check') then
    alter table public.nvsh_shop add constraint nvsh_shop_booking_mode_check
      check (booking_mode in ('auto','manual'));
  end if;
end $$;

alter table public.nvsh_order
  add column if not exists hold_reason         text,
  add column if not exists approved_at         timestamptz,
  add column if not exists recall_requested_at timestamptz;

-- 'awaiting_approval' is a new resting state: received, mapped, priced, and
-- deliberately not booked.
alter table public.nvsh_order drop constraint if exists nvsh_order_status_check;
alter table public.nvsh_order add constraint nvsh_order_status_check
  check (status in ('received','pending_link','awaiting_approval','booked',
                    'skipped','failed','cancelled'));

create index if not exists nvsh_order_awaiting_idx
  on public.nvsh_order (shop_domain, received_at desc)
  where status = 'awaiting_approval';

-- --------------------------------------------------------- link codes ------

create table if not exists public.nvsh_link_code (
  code        text primary key,
  client_id   uuid not null references public.clients(id) on delete cascade,
  issued_by   uuid,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by_shop text
);

alter table public.nvsh_link_code enable row level security;
alter table public.nvsh_link_code force row level security;
-- No policies: reachable only through the SECURITY DEFINER functions below.

create index if not exists nvsh_link_code_client_idx
  on public.nvsh_link_code (client_id, issued_at desc);

/* Issued by the merchant, in the portal, while signed in. That session IS the
   proof of ownership -- there is no second factor to fake because there is no
   claim being made about an identity we did not already authenticate. */
create or replace function public.nvsh_link_code_issue()
returns table(code text, expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid := public.my_client_id();
  v_code   text;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.';
  end if;
  -- is_client_owner_seat() is the boolean. nv_client_seat_is_owner has a
  -- near-identical name and is a TRIGGER function: calling it here raises
  -- "argument of NOT must be type boolean, not type trigger".
  if not public.is_client_owner_seat() then
    raise exception 'Only an account owner can connect a Shopify store.';
  end if;

  -- One live code per merchant. Issuing again replaces the old one, so a code
  -- read off someone's screen an hour ago is already dead.
  delete from public.nvsh_link_code
   where client_id = v_client and used_at is null;

  -- Unambiguous alphabet: no O/0, no I/1.
  v_code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                    (floor(random()*32)+1)::int, 1), '')
               from generate_series(1,8));

  insert into public.nvsh_link_code (code, client_id, issued_by, expires_at)
  values (v_code, v_client, auth.uid(), now() + interval '20 minutes');

  return query select v_code, now() + interval '20 minutes';
end $$;

revoke all on function public.nvsh_link_code_issue() from public, anon;
grant execute on function public.nvsh_link_code_issue() to authenticated;

/* Claimed by the edge function, which has already proven WHICH shop is asking
   by verifying an App Bridge session token. The code proves which merchant. */
create or replace function public.nvsh_link_claim(p_shop text, p_code text)
returns table(ok boolean, client_name text, released integer, message text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.nvsh_link_code;
  v_name text;
  v_released integer := 0;
  v_existing uuid;
begin
  select client_id into v_existing from public.nvsh_shop where shop_domain = p_shop;
  if not found then
    return query select false, null::text, 0, 'This store is not installed.'; return;
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

  -- A merchant may connect more than one store, but a store belongs to one
  -- merchant. The check above is what enforces that.
  update public.nvsh_link_code
     set used_at = now(), used_by_shop = p_shop
   where code = v_row.code;

  update public.nvsh_shop
     set client_id = v_row.client_id, status = 'active',
         linked_at = now(), updated_at = now()
   where shop_domain = p_shop;

  update public.nvsh_order
     set status = 'received', client_id = v_row.client_id, updated_at = now()
   where shop_domain = p_shop and status = 'pending_link';
  get diagnostics v_released = row_count;

  select name into v_name from public.clients where id = v_row.client_id;
  return query select true, v_name, v_released,
    'Connected to ' || coalesce(v_name,'your NovaX account') || '.';
end $$;

revoke all on function public.nvsh_link_claim(text,text) from public, anon, authenticated;

-- ------------------------------------------------------- shop settings -----

create or replace function public.nvsh_settings_update(
  p_shop text,
  p_booking_mode text,
  p_require_confirmed boolean,
  p_payment_modes text[],
  p_shipping_names text[],
  p_location_ids text[],
  p_exclude_tags text[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_booking_mode not in ('auto','manual') then
    raise exception 'booking_mode must be auto or manual';
  end if;
  update public.nvsh_shop
     set booking_mode           = p_booking_mode,
         rule_require_confirmed = coalesce(p_require_confirmed,false),
         -- An empty array means "no restriction", same as null. Storing null
         -- keeps one meaning for one thing.
         rule_payment_modes     = nullif(p_payment_modes,  '{}'),
         rule_shipping_names    = nullif(p_shipping_names, '{}'),
         rule_location_ids      = nullif(p_location_ids,   '{}'),
         rule_exclude_tags      = coalesce(p_exclude_tags, '{}'),
         updated_at             = now()
   where shop_domain = p_shop;
end $$;

revoke all on function public.nvsh_settings_update(text,text,boolean,text[],text[],text[],text[])
  from public, anon, authenticated;

-- ---------------------------------------------------------- approvals ------

create or replace function public.nvsh_order_decide(
  p_shop text, p_order_id text, p_decision text)
returns table(ok boolean, message text)
language plpgsql
security definer
set search_path to 'public'
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
    -- 'received' is what the drain picks up, so approval reuses the one
    -- booking path rather than adding a second way to make a parcel.
    update public.nvsh_order
       set status = 'received', approved_at = now(), hold_reason = null, updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, 'Approved. It will be booked within a minute.';
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

-- ------------------------------------------------ cancel before pickup -----

/* Before pickup the parcel has not moved and can simply be cancelled. After
   pickup a rider is carrying it, so nothing here may change the parcel: it
   becomes a recall request that operations acts on. Silently "cancelling" a
   parcel that is already on a bike is how a courier loses a box. */
create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_awb text; v_status text; v_pstatus text;
begin
  select o.awb, o.status into v_awb, v_status
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;
  if not found then
    return query select false, 'none', 'No such order.'; return;
  end if;

  -- The AWB decides, not nvsh_order.status. A row can legitimately read
  -- 'received' AND already own a parcel: nvsh_link_claim() resets held rows to
  -- 'received' when a store is connected, and the drain leaves that value in
  -- place while it works. Reading the status first said "cancelled before it
  -- was booked" about a parcel that was on a rider's bike.
  if v_awb is null then
    update public.nvsh_order
       set status = 'cancelled', error = 'Cancelled in Shopify before booking', updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, 'cancelled', 'Cancelled before it was booked.'; return;
  end if;

  select status into v_pstatus from public.parcels where awb = v_awb;
  if v_pstatus is null then
    -- An AWB with no parcel should not happen; say so rather than guess.
    return query select false, 'none', 'Parcel ' || v_awb || ' not found.'; return;
  end if;

  if v_pstatus = 'New booked' then
    update public.parcels
       set status = 'Cancelled by client', updated_at = now()
     where awb = v_awb;
    update public.nvsh_order
       set status = 'cancelled', error = 'Cancelled in Shopify before pickup', updated_at = now()
     where shop_domain = p_shop and shopify_order_id = p_order_id;
    return query select true, 'cancelled', 'Parcel ' || v_awb || ' cancelled before pickup.'; return;
  end if;

  if v_pstatus in ('Cancelled by client','Delivered','Return to shipper') then
    return query select false, 'none',
      'Parcel ' || v_awb || ' is already ' || v_pstatus || '.'; return;
  end if;

  -- Past pickup. Record the request; do not touch the parcel.
  update public.nvsh_order
     set recall_requested_at = now(),
         error = 'Recall requested - parcel already picked up (' || v_pstatus || ')',
         updated_at = now()
   where shop_domain = p_shop and shopify_order_id = p_order_id;

  insert into public.operations_issues (branch, urgency, problem, awb, meta)
  values ('Karachi', 'High',
          'Shopify recall request: order cancelled after pickup (' || v_pstatus || ')',
          v_awb,
          jsonb_build_object('source','shopify_app','shop',p_shop,'shopifyOrderId',p_order_id));

  return query select true, 'recall',
    'Parcel ' || v_awb || ' is already with a rider. A recall request has been raised.';
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;

commit;

select 'settings columns' as check,
       string_agg(column_name, ', ' order by column_name) as detail
  from information_schema.columns
 where table_schema='public' and table_name='nvsh_shop'
   and (column_name like 'rule_%' or column_name = 'booking_mode')
union all
select 'link code table', to_regclass('public.nvsh_link_code')::text
union all
select 'new functions', string_agg(proname, ', ' order by proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and proname in
   ('nvsh_link_code_issue','nvsh_link_claim','nvsh_settings_update',
    'nvsh_order_decide','nvsh_cancel_or_recall');
