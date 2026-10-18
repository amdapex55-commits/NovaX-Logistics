-- NovaX: merchants buy courier flyers (packing mailer bags) from the portal.
-- 18 Oct 2026, Aisha: price = cost + Rs 10 per flyer. Paid from the NovaX
-- Wallet when the balance covers the whole order; otherwise cash to the rider
-- who brings the flyers.
--
-- Packs of 100 flyers per size (qty is in flyers, a multiple of 100, up to
-- 10,000 per size per order). The server prices every order from
-- nv_flyer_sizes; the portal's numbers are only a preview.
-- Wallet payment is an 'admin_adjustment' ledger row with
-- reference_type 'flyer_order' (the same pattern as the Nova Recover fee), so
-- every existing wallet total already counts it; the portal names it.
-- Who: the owner, Warehouse and Finance seats may order. Only the owner and
-- Finance may pay from the wallet; a Warehouse order is always cash.
--
-- Run in one transaction:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>

create table if not exists public.nv_flyer_sizes (
  code   text primary key,
  label  text not null,
  cost   numeric(10,2) not null check (cost >= 0),
  price  numeric(10,2) not null check (price > 0),
  sort   integer not null default 0,
  active boolean not null default true
);
insert into public.nv_flyer_sizes (code, label, cost, price, sort) values
  ('7x9',   '7 × 9 in',   4.28, 14.28, 1),
  ('8x11',  '8 × 11 in',  5.45, 15.45, 2),
  ('10x11', '10 × 11 in', 7.05, 17.05, 3),
  ('10x14', '10 × 14 in', 8.00, 18.00, 4),
  ('12x16', '12 × 16 in', 10.00, 20.00, 5),
  ('14x19', '14 × 19 in', 16.00, 26.00, 6),
  ('16x22', '16 × 22 in', 27.00, 37.00, 7),
  ('18x24', '18 × 24 in', 30.00, 40.00, 8)
on conflict (code) do update set label = excluded.label, cost = excluded.cost, price = excluded.price, sort = excluded.sort;

create sequence if not exists public.nv_flyer_order_seq start 1001;
create table if not exists public.nv_flyer_orders (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique default ('FLY-' || nextval('public.nv_flyer_order_seq')),
  client_id      uuid not null references public.clients(id) on delete cascade,
  items          jsonb not null,
  flyers         integer not null check (flyers > 0),
  total          numeric(12,2) not null check (total > 0),
  pay_method     text not null check (pay_method in ('wallet', 'cash')),
  status         text not null default 'placed' check (status in ('placed', 'out_for_delivery', 'delivered', 'cancelled')),
  ledger_id      uuid,
  refund_ledger_id uuid,
  cash_collected boolean not null default false,
  address        text,
  city           text,
  note           text check (char_length(note) <= 300),
  placed_by      uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  delivered_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text
);
create index if not exists nv_flyer_orders_client on public.nv_flyer_orders (client_id, created_at desc);
create index if not exists nv_flyer_orders_open on public.nv_flyer_orders (status, created_at) where status in ('placed', 'out_for_delivery');

alter table public.nv_flyer_sizes enable row level security;
alter table public.nv_flyer_orders enable row level security;
revoke all on public.nv_flyer_sizes, public.nv_flyer_orders from anon, public;
revoke insert, update, delete, truncate on public.nv_flyer_sizes, public.nv_flyer_orders from authenticated;
grant select on public.nv_flyer_orders to authenticated;
drop policy if exists nv_flyer_orders_read on public.nv_flyer_orders;
create policy nv_flyer_orders_read on public.nv_flyer_orders for select to authenticated
  using (client_id = public.my_client_id() or public.is_admin());

-- The caller's seat on this workspace: owner (no seat row, or role Owner),
-- finance, warehouse, support or revoked.
create or replace function public.nv_flyer_seat()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_email text; v_client uuid := public.my_client_id(); su record;
begin
  if v_uid is null or v_client is null then return null; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  select * into su from public.staff_users s
   where s.client_id = v_client and (s.auth_user_id = v_uid or lower(s.email) = coalesce(v_email, ''))
   order by (s.auth_user_id = v_uid) desc limit 1;
  if su is null then return 'owner'; end if;
  if lower(coalesce(su.status, 'Active')) = 'revoked' then return 'revoked'; end if;
  return case lower(coalesce(su.role, '')) when 'owner' then 'owner' when 'finance' then 'finance'
              when 'support' then 'support' else 'warehouse' end;
end $$;

-- Sizes and prices for the order screen, plus what this login may do.
create or replace function public.client_flyer_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); v_seat text := public.nv_flyer_seat(); v_bal numeric;
begin
  if v_client is null then raise exception 'Sign in to buy flyers.' using errcode = '42501'; end if;
  select coalesce(wallet_balance, 0) into v_bal from public.clients where id = v_client;
  return jsonb_build_object(
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'label', s.label, 'price', s.price) order by s.sort), '[]'::jsonb)
                from public.nv_flyer_sizes s where s.active),
    'pack', 100,
    'can_order', v_seat in ('owner', 'finance', 'warehouse'),
    'can_use_wallet', v_seat in ('owner', 'finance'),
    'wallet', case when v_seat in ('owner', 'finance') then v_bal end);
end $$;

-- Place an order. p_items: [{"code":"10x14","qty":200}, ...]
create or replace function public.client_flyer_order(p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id(); v_seat text := public.nv_flyer_seat();
  it jsonb; s public.nv_flyer_sizes; v_qty integer; v_items jsonb := '[]'::jsonb; v_total numeric := 0; v_flyers integer := 0;
  cl public.clients; v_pay text; v_id uuid := gen_random_uuid(); v_code text; v_ledger uuid; v_addr text; v_city text; v_seen text[] := '{}';
begin
  if v_client is null then raise exception 'Sign in to buy flyers.' using errcode = '42501'; end if;
  if v_seat not in ('owner', 'finance', 'warehouse') then raise exception 'Your team role cannot order flyers. Ask the account owner.' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Choose at least one flyer size.'; end if;
  if jsonb_array_length(p_items) > 8 then raise exception 'Too many lines in one order.'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into s from public.nv_flyer_sizes x where x.code = it->>'code' and x.active;
    if s.code is null then raise exception 'Flyer size % is not available.', coalesce(it->>'code', '?'); end if;
    if s.code = any(v_seen) then raise exception 'Size % is listed twice.', s.label; end if;
    v_seen := v_seen || s.code;
    begin v_qty := (it->>'qty')::integer; exception when others then v_qty := null; end;
    if v_qty is null or v_qty < 100 or v_qty > 10000 or v_qty % 100 <> 0 then
      raise exception 'Order flyers in packs of 100 (100 to 10,000 per size). % has %.', s.label, coalesce(it->>'qty', 'none');
    end if;
    v_items := v_items || jsonb_build_object('code', s.code, 'label', s.label, 'qty', v_qty, 'price', s.price, 'line', round(s.price * v_qty, 2));
    v_total := v_total + round(s.price * v_qty, 2); v_flyers := v_flyers + v_qty;
  end loop;

  -- Delivered to the merchant's default pickup point, else the account address.
  select l.address, l.city into v_addr, v_city from public.client_pickup_locations l
   where l.client_id = v_client order by l.is_default desc, l.created_at limit 1;
  select * into cl from public.clients x where x.id = v_client for update;
  v_addr := coalesce(nullif(btrim(v_addr), ''), cl.address); v_city := coalesce(nullif(btrim(v_city), ''), cl.meta->>'pickupCity', cl.city);

  v_pay := case when v_seat in ('owner', 'finance') and coalesce(cl.wallet_balance, 0) >= v_total then 'wallet' else 'cash' end;
  insert into public.nv_flyer_orders (id, client_id, items, flyers, total, pay_method, address, city, note, placed_by)
  values (v_id, v_client, v_items, v_flyers, v_total, v_pay, v_addr, v_city, nullif(left(btrim(coalesce(p_note, '')), 300), ''), auth.uid())
  returning code into v_code;
  if v_pay = 'wallet' then
    update public.clients set wallet_balance = coalesce(wallet_balance, 0) - v_total where id = v_client;
    insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
    values (v_client, 'admin_adjustment', -v_total, true, 'Adjustment', 'flyer_order', v_id, v_code,
            'Flyers: ' || v_flyers || ' flyers, order ' || v_code || '.')
    returning id into v_ledger;
    update public.nv_flyer_orders set ledger_id = v_ledger where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'total', v_total, 'flyers', v_flyers,
    'pay_method', v_pay, 'wallet_after', case when v_pay = 'wallet' then coalesce(cl.wallet_balance, 0) - v_total end);
end $$;

create or replace function public.client_flyer_orders()
returns setof public.nv_flyer_orders language sql stable security definer set search_path = '' as $$
  select * from public.nv_flyer_orders where client_id = public.my_client_id() order by created_at desc limit 50;
$$;

-- Refund helper: a wallet-paid order that is cancelled gets its money back.
-- reference_type 'flyer_refund': nv_wl_idem_uq allows one row per
-- (client, entry_type, reference_type, reference_id).
create or replace function public.nv_flyer_refund(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.nv_flyer_orders; v_ledger uuid;
begin
  select * into o from public.nv_flyer_orders where id = p_order for update;
  if o.pay_method = 'wallet' and o.ledger_id is not null and o.refund_ledger_id is null then
    perform 1 from public.clients where id = o.client_id for update;
    update public.clients set wallet_balance = coalesce(wallet_balance, 0) + o.total where id = o.client_id;
    insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
    values (o.client_id, 'admin_adjustment', o.total, true, 'Adjustment', 'flyer_refund', o.id, o.code,
            'Flyers refunded: order ' || o.code || ' cancelled' || coalesce(' (' || p_reason || ')', '') || '.')
    returning id into v_ledger;
    update public.nv_flyer_orders set refund_ledger_id = v_ledger where id = o.id;
  end if;
end $$;

-- The merchant may cancel until the rider sets out.
create or replace function public.client_flyer_cancel(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.nv_flyer_orders; v_seat text := public.nv_flyer_seat();
begin
  select * into o from public.nv_flyer_orders where id = p_id and client_id = public.my_client_id() for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  if v_seat not in ('owner', 'finance', 'warehouse') then raise exception 'Your team role cannot cancel flyer orders.' using errcode = '42501'; end if;
  if o.status <> 'placed' then raise exception 'This order is already on its way and can no longer be cancelled. Message NovaX support.'; end if;
  update public.nv_flyer_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by merchant', updated_at = now() where id = o.id;
  perform public.nv_flyer_refund(o.id, 'by merchant');
  return jsonb_build_object('ok', true, 'refunded', o.pay_method = 'wallet');
end $$;

-- Head office: the orders, and moving them along.
create or replace function public.admin_flyer_orders(p_status text default null)
returns table (id uuid, code text, client text, phone text, items jsonb, flyers integer, total numeric, pay_method text,
               status text, cash_collected boolean, address text, city text, note text, created_at timestamptz, delivered_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_admin() or public.nv_staff_can('orders-processing')) then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return query
    select o.id, o.code, c.name, c.phone, o.items, o.flyers, o.total, o.pay_method, o.status, o.cash_collected,
           o.address, o.city, o.note, o.created_at, o.delivered_at
      from public.nv_flyer_orders o join public.clients c on c.id = o.client_id
     where p_status is null or o.status = p_status
     order by (o.status in ('placed', 'out_for_delivery')) desc, o.created_at desc
     limit 300;
end $$;

create or replace function public.admin_flyer_set_status(p_id uuid, p_status text, p_cash_collected boolean default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.nv_flyer_orders;
begin
  if not (public.is_admin() or public.nv_staff_can('orders-processing')) then raise exception 'Admin access required.' using errcode = '42501'; end if;
  select * into o from public.nv_flyer_orders where id = p_id for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'This order is already %.', o.status; end if;
  if p_status = 'out_for_delivery' then
    update public.nv_flyer_orders set status = 'out_for_delivery', updated_at = now() where id = o.id;
  elsif p_status = 'delivered' then
    if o.pay_method = 'cash' and p_cash_collected is not true then raise exception 'Confirm the cash was collected for this cash order.'; end if;
    update public.nv_flyer_orders set status = 'delivered', delivered_at = now(), updated_at = now(),
           cash_collected = (o.pay_method = 'cash') where id = o.id;
  elsif p_status = 'cancelled' then
    update public.nv_flyer_orders set status = 'cancelled', cancelled_at = now(), updated_at = now(),
           cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 200), '') where id = o.id;
    perform public.nv_flyer_refund(o.id, nullif(btrim(coalesce(p_reason, '')), ''));
  else
    raise exception 'Unknown status.';
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.nv_flyer_seat(), public.client_flyer_catalog(), public.client_flyer_order(jsonb, text),
  public.client_flyer_orders(), public.nv_flyer_refund(uuid, text), public.client_flyer_cancel(uuid),
  public.admin_flyer_orders(text), public.admin_flyer_set_status(uuid, text, boolean, text) from public, anon;
grant execute on function public.client_flyer_catalog(), public.client_flyer_order(jsonb, text), public.client_flyer_orders(),
  public.client_flyer_cancel(uuid), public.admin_flyer_orders(text), public.admin_flyer_set_status(uuid, text, boolean, text) to authenticated;
-- nv_flyer_seat and nv_flyer_refund are internal: called only by the functions above.
