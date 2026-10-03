-- 3 Oct 2026: NovaX status changes flow back to the merchant's WooCommerce
-- order. Same shape as the API webhooks: a trigger queues, a cron tick asks
-- the edge function (woo-status-push) to drain, failures retry with backoff.

create table if not exists public.nv_woo_push_queue (
  id bigserial primary key,
  parcel_id uuid not null references public.parcels(id) on delete cascade,
  client_id uuid not null,
  awb text not null,
  status text not null,
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  done_at timestamptz,
  dead boolean not null default false,
  last_error text
);
alter table public.nv_woo_push_queue enable row level security;
revoke all on table public.nv_woo_push_queue from public, anon, authenticated;
revoke all on sequence public.nv_woo_push_queue_id_seq from public, anon, authenticated;
create index if not exists nv_woo_push_queue_due_idx on public.nv_woo_push_queue (next_attempt_at) where done_at is null and not dead;
create index if not exists nv_woo_push_queue_parcel_idx on public.nv_woo_push_queue (parcel_id);

create or replace function public.nv_woo_enqueue_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if coalesce(new.meta->>'source', '') <> 'woocommerce' then return new; end if;
  begin
    if exists (select 1 from public.store_secrets s where s.client_id = new.client_id and s.platform = 'woocommerce') then
      insert into public.nv_woo_push_queue (parcel_id, client_id, awb, status) values (new.id, new.client_id, new.awb, new.status);
    end if;
  exception when others then
    null;   -- a store update must never stop a parcel moving
  end;
  return new;
end $$;
revoke all on function public.nv_woo_enqueue_status() from public, anon, authenticated;

drop trigger if exists trg_nv_woo_enqueue_status on public.parcels;
create trigger trg_nv_woo_enqueue_status
  after insert or update of status on public.parcels
  for each row execute function public.nv_woo_enqueue_status();

create or replace function public.nv_woo_push_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.nv_woo_push_queue where done_at is null and not dead and next_attempt_at <= now()) then return; end if;
  perform net.http_post(
    url     := 'https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/woo-status-push',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-novax-drain', public.nv_api_drain_token()),
    timeout_milliseconds := 25000);
end $$;
revoke all on function public.nv_woo_push_tick() from public, anon, authenticated;

select cron.unschedule('novax-woo-push') where exists (select 1 from cron.job where jobname = 'novax-woo-push');
select cron.schedule('novax-woo-push', '* * * * *', 'select public.nv_woo_push_tick();');
