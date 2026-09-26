-- ---------------------------------------------------------------------------
-- Shopify fulfillment fires at handover, not at booking.
--
-- Before this, processOrder() called fulfillmentCreate the instant the AWB was
-- generated. An AWB is a booking reference: it means a merchant asked for a
-- pickup, not that a parcel exists in NovaX's hands. Shopify treats a
-- fulfillment as "it has shipped" and emails the buyer a tracking number, so
-- every cancelled-before-pickup booking told a buyer their parcel was on its
-- way when nothing had moved.
--
-- Handover is the first time a parcel leaves 'New booked' into a NovaX-held
-- status. That is the moment NovaX physically has the parcel, and the moment
-- the buyer's tracking number becomes true.
--
-- Cancelled-before-pickup and out-of-service-area are NOT handover: the parcel
-- never moved, so Shopify must never be told it shipped.
-- ---------------------------------------------------------------------------

begin;

alter table public.nvsh_order
  add column if not exists fulfill_state    text not null default 'none',
  add column if not exists fulfill_attempts integer not null default 0,
  add column if not exists fulfilled_at     timestamptz,
  add column if not exists fulfill_error    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nvsh_order_fulfill_state_check') then
    alter table public.nvsh_order
      add constraint nvsh_order_fulfill_state_check
      check (fulfill_state in ('none','ready','done','failed'));
  end if;
end $$;

-- The drain scans this and nothing else, so keep it narrow.
create index if not exists nvsh_order_fulfill_ready_idx
  on public.nvsh_order (updated_at)
  where fulfill_state = 'ready';

-- --------------------------------------------------------------- trigger ----

create or replace function public.nvsh_mark_ready_to_fulfill()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Only parcels this app booked. A parcel booked in the portal has no Shopify
  -- order to fulfil, and must not be matched by AWB alone.
  if coalesce(new.meta->>'source','') <> 'shopify' then
    return new;
  end if;

  if old.status = 'New booked'
     and new.status <> 'New booked'
     and new.status not in ('Cancelled by client','Out of service area','Return to shipper')
  then
    update public.nvsh_order
       set fulfill_state = 'ready',
           updated_at    = now()
     where awb = new.awb
       and fulfill_state = 'none';
  end if;

  return new;
end $$;

drop trigger if exists nvsh_fulfill_on_handover on public.parcels;
create trigger nvsh_fulfill_on_handover
  after update of status on public.parcels
  for each row
  when (old.status is distinct from new.status)
  execute function public.nvsh_mark_ready_to_fulfill();

-- ----------------------------------------------------------------- drain ----
-- Its own token rather than sharing the merchant-API one: two drains that can
-- be triggered independently should not be one stolen string apart.

insert into public.nv_api_secret (name, value)
select 'shopify_drain_token', encode(gen_random_bytes(32), 'hex')
where not exists (select 1 from public.nv_api_secret where name = 'shopify_drain_token');

create or replace function public.nvsh_drain_token()
returns text
language sql
stable security definer
set search_path to 'public'
as $$
  select value from public.nv_api_secret where name = 'shopify_drain_token'
$$;

revoke all on function public.nvsh_drain_token() from public, anon, authenticated;

create or replace function public.nvsh_fulfill_tick()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_pending int;
begin
  select count(*) into v_pending
    from public.nvsh_order
   where fulfill_state = 'ready' and fulfill_attempts < 6;
  if v_pending = 0 then return; end if;

  perform net.http_post(
    url     := 'https://novaxlogistics.com/shopify/fulfill',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-novax-drain', public.nvsh_drain_token()),
    timeout_milliseconds := 20000
  );
end $$;

revoke all on function public.nvsh_fulfill_tick() from public, anon, authenticated;

select cron.unschedule('novax-shopify-fulfill')
 where exists (select 1 from cron.job where jobname = 'novax-shopify-fulfill');

select cron.schedule('novax-shopify-fulfill', '* * * * *', 'select public.nvsh_fulfill_tick();');

commit;

-- What this should print: the new columns, the trigger, and the job.
select 'columns' as check, string_agg(column_name, ', ' order by column_name) as detail
  from information_schema.columns
 where table_schema='public' and table_name='nvsh_order' and column_name like 'fulfill%'
union all
select 'trigger', tgname from pg_trigger where tgname = 'nvsh_fulfill_on_handover'
union all
select 'cron', jobname || ' @ ' || schedule from cron.job where jobname = 'novax-shopify-fulfill';
