-- ============================================================================
-- NovaX Shopify app - schema, built from scratch.
--
-- Deliberately shares nothing with the old pasted-token path
-- (shopify_connections / shopify-order-intake). That path stays untouched and
-- keeps working until every merchant has migrated; this one is prefixed nvsh_
-- so the two can never collide.
--
-- Everything here is reached ONLY by the edge function using the service role.
-- No table below is readable by a logged-in merchant or by anon: RLS is on with
-- no permissive policy, which denies both. Merchant-facing reads go through the
-- nvsh_* SECURITY DEFINER functions at the bottom, and none of those ever
-- return an access token.
-- ============================================================================

-- ---------------------------------------------------------------- shops -----
create table if not exists public.nvsh_shop (
  id              uuid primary key default gen_random_uuid(),
  shop_domain     text not null unique,
  access_token    text,
  scopes          text,

  -- Which NovaX merchant this store belongs to. NULL until an admin links it:
  -- at install time Shopify tells us the store, never who owns it.
  client_id       uuid references public.clients(id) on delete set null,

  status          text not null default 'pending_link'
                  check (status in ('pending_link','active','uninstalled','blocked')),

  installed_at    timestamptz not null default now(),
  linked_at       timestamptz,
  uninstalled_at  timestamptz,
  last_order_at   timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  orders_booked   integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists nvsh_shop_client_idx on public.nvsh_shop(client_id)
  where client_id is not null;
create index if not exists nvsh_shop_status_idx on public.nvsh_shop(status);

-- ------------------------------------------------------- oauth nonces -------
-- CSRF protection for the install redirect. Rows are single-use and short
-- lived; nvsh_gc() below deletes anything older than an hour.
create table if not exists public.nvsh_oauth_state (
  state       text primary key,
  shop_domain text not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

create index if not exists nvsh_oauth_state_created_idx
  on public.nvsh_oauth_state(created_at);

-- --------------------------------------------------------------- orders -----
-- One row per Shopify order we have seen. The unique index on
-- (shop_domain, shopify_order_id) is the idempotency key: Shopify retries
-- webhooks, and a retry must never create a second parcel.
create table if not exists public.nvsh_order (
  id                uuid primary key default gen_random_uuid(),
  shop_domain       text not null,
  shopify_order_id  text not null,
  order_name        text,
  awb               text,
  client_id         uuid,

  status            text not null default 'received'
                    check (status in ('received','pending_link','booked','skipped','failed','cancelled')),
  skip_reason       text,
  error             text,
  attempts          integer not null default 0,

  cod_amount        numeric,
  payload           jsonb,

  received_at       timestamptz not null default now(),
  booked_at         timestamptz,
  updated_at        timestamptz not null default now()
);

create unique index if not exists nvsh_order_unique
  on public.nvsh_order(shop_domain, shopify_order_id);
create index if not exists nvsh_order_status_idx on public.nvsh_order(status)
  where status in ('pending_link','failed');
create index if not exists nvsh_order_awb_idx on public.nvsh_order(awb)
  where awb is not null;

-- -------------------------------------------------------- webhook log -------
create table if not exists public.nvsh_event (
  id           bigserial primary key,
  shop_domain  text,
  topic        text,
  webhook_id   text,
  ok           boolean not null default true,
  detail       text,
  created_at   timestamptz not null default now()
);

create index if not exists nvsh_event_created_idx on public.nvsh_event(created_at desc);
create index if not exists nvsh_event_fail_idx on public.nvsh_event(created_at desc)
  where not ok;

-- Replay guard: Shopify's X-Shopify-Webhook-Id is unique per delivery, so a
-- duplicate id is a retry of something already handled.
create unique index if not exists nvsh_event_webhook_id_unique
  on public.nvsh_event(webhook_id) where webhook_id is not null;

-- ---------------------------------------------- protected data access -------
-- Shopify's protected-customer-data Level 2 requires an access log for
-- customer name / address / phone / email. Every read of those fields is
-- written here.
create table if not exists public.nvsh_access_log (
  id           bigserial primary key,
  shop_domain  text,
  purpose      text not null,
  fields       text[] not null,
  subject_ref  text,
  actor        text not null default 'edge:shopify',
  created_at   timestamptz not null default now()
);

create index if not exists nvsh_access_log_created_idx
  on public.nvsh_access_log(created_at desc);

-- ------------------------------------------------------------- lockdown -----
alter table public.nvsh_shop        enable row level security;
alter table public.nvsh_oauth_state enable row level security;
alter table public.nvsh_order       enable row level security;
alter table public.nvsh_event       enable row level security;
alter table public.nvsh_access_log  enable row level security;

-- No policies are created on purpose. RLS with zero permissive policies denies
-- every role except service_role, which bypasses RLS. Belt and braces:
revoke all on public.nvsh_shop, public.nvsh_oauth_state, public.nvsh_order,
              public.nvsh_event, public.nvsh_access_log
  from anon, authenticated;

-- ============================================================================
-- Functions
-- ============================================================================

-- Housekeeping: expire oauth nonces and trim the event log.
create or replace function public.nvsh_gc() returns void
  language sql security definer set search_path to 'public' as $$
  delete from public.nvsh_oauth_state where created_at < now() - interval '1 hour';
  delete from public.nvsh_event        where created_at < now() - interval '30 days';
$$;

-- What the embedded app shows a merchant. Never returns access_token.
create or replace function public.nvsh_shop_state(p_shop text)
returns table (
  shop_domain   text,
  status        text,
  linked        boolean,
  client_name   text,
  installed_at  timestamptz,
  last_order_at timestamptz,
  orders_booked integer,
  pending_count integer,
  failed_count  integer
)
language sql security definer set search_path to 'public' as $$
  select s.shop_domain,
         s.status,
         s.client_id is not null,
         c.name,
         s.installed_at,
         s.last_order_at,
         s.orders_booked,
         (select count(*)::int from public.nvsh_order o
            where o.shop_domain = s.shop_domain and o.status = 'pending_link'),
         (select count(*)::int from public.nvsh_order o
            where o.shop_domain = s.shop_domain and o.status = 'failed')
    from public.nvsh_shop s
    left join public.clients c on c.id = s.client_id
   where s.shop_domain = p_shop;
$$;

-- Recent bookings for the embedded app. Consignee name is deliberately NOT
-- returned -- the merchant already has it in Shopify, and not re-exposing
-- protected data is the cheapest way to satisfy data minimisation.
create or replace function public.nvsh_recent_orders(p_shop text, p_limit int default 20)
returns table (
  order_name text,
  awb        text,
  status     text,
  cod_amount numeric,
  received_at timestamptz,
  error      text
)
language sql security definer set search_path to 'public' as $$
  select o.order_name, o.awb, o.status, o.cod_amount, o.received_at, o.error
    from public.nvsh_order o
   where o.shop_domain = p_shop
   order by o.received_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Admin queue: stores waiting to be linked to a NovaX merchant.
create or replace function public.nvsh_admin_pending()
returns table (
  shop_domain   text,
  installed_at  timestamptz,
  waiting_orders integer
)
language sql security definer set search_path to 'public' as $$
  select s.shop_domain,
         s.installed_at,
         (select count(*)::int from public.nvsh_order o
            where o.shop_domain = s.shop_domain and o.status = 'pending_link')
    from public.nvsh_shop s
   where s.status = 'pending_link'
   order by s.installed_at;
$$;

-- Link a store to a merchant, then release every order that arrived while it
-- was unlinked. Booking those is the edge function's job -- this only flips
-- them from pending_link back to received so the next drain picks them up.
create or replace function public.nvsh_admin_link(p_shop text, p_client_id uuid)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v_released integer;
begin
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'no such client: %', p_client_id;
  end if;

  update public.nvsh_shop
     set client_id = p_client_id,
         status    = 'active',
         linked_at = now(),
         updated_at = now()
   where shop_domain = p_shop;

  if not found then
    raise exception 'no such shop: %', p_shop;
  end if;

  update public.nvsh_order
     set status = 'received', client_id = p_client_id, updated_at = now()
   where shop_domain = p_shop and status = 'pending_link';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke all on function public.nvsh_shop_state(text)        from anon, authenticated;
revoke all on function public.nvsh_recent_orders(text,int) from anon, authenticated;
revoke all on function public.nvsh_admin_pending()         from anon, authenticated;
revoke all on function public.nvsh_admin_link(text,uuid)   from anon, authenticated;
revoke all on function public.nvsh_gc()                    from anon, authenticated;


-- COD wallet for the embedded app. Same query as client_wallet_summary(), but
-- keyed off the installed shop instead of a NovaX login session -- inside
-- Shopify the merchant is authenticated by a Shopify session token and has no
-- NovaX cookie to read my_client_id() from.
--
-- This is the number no aggregator app can show, so it is the reason a
-- merchant opens our app rather than theirs.
create or replace function public.nvsh_wallet_summary(p_shop text)
returns table (
  available_balance   numeric,
  pending_payout      numeric,
  paid_this_month     numeric,
  lifetime_withdrawn  numeric
)
language plpgsql security definer set search_path to 'public' as $$
declare v_client_id uuid;
begin
  select s.client_id into v_client_id
    from public.nvsh_shop s
   where s.shop_domain = p_shop and s.status = 'active';

  if v_client_id is null then
    return;   -- unlinked shop: no rows, not an error
  end if;

  select coalesce(c.wallet_balance,0),
    coalesce((select sum(w.net) from public.withdrawals w
               where w.client_id = v_client_id and w.status = 'Pending admin payout'), 0),
    coalesce((select sum(w.net) from public.withdrawals w
               where w.client_id = v_client_id and w.status = 'Paid'
                 and date_trunc('month', coalesce(w.paid_at, w.created_at)) = date_trunc('month', now())), 0),
    coalesce((select sum(w.net) from public.withdrawals w
               where w.client_id = v_client_id and w.status = 'Paid'), 0)
  into available_balance, pending_payout, paid_this_month, lifetime_withdrawn
  from public.clients c where c.id = v_client_id;

  return next;
end;
$$;

revoke all on function public.nvsh_wallet_summary(text) from anon, authenticated;

-- ============================================================================
select 'nvsh schema installed' as result,
       (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name like 'nvsh_%') as tables_created,
       (select count(*) from information_schema.routines
         where routine_schema = 'public' and routine_name like 'nvsh_%') as functions_created;
