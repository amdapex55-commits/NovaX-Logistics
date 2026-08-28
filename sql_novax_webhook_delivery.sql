-- ===========================================================================
-- NovaX Merchant API -- outbound status webhooks, delivered for real.
--
-- WHY A QUEUE AND NOT A DIRECT POST FROM THE TRIGGER
--   A webhook that fires inline from the parcel UPDATE has two failure modes,
--   both unacceptable: if the merchant's server is slow, every rider status
--   tap waits on it; if it is down, the event is gone forever and the
--   merchant's site silently disagrees with ours about where a parcel is.
--   So the trigger only writes a row. A cron'd drain delivers it with
--   retries and gives up loudly, into a dead letter we can look at.
--
-- THE TRIGGER CAN NEVER BREAK A PARCEL UPDATE
--   The enqueue is wrapped in an exception handler that swallows everything.
--   Booking and status updates are the business; a webhook is a courtesy.
--   If this whole subsystem is broken, parcels must still move.
-- ===========================================================================

-- ------------------------------------------------------------- queue --------
create table if not exists public.nv_api_webhook_queue (
  id             uuid primary key default gen_random_uuid(),
  key_id         uuid not null references public.nv_api_key(id) on delete cascade,
  client_id      uuid not null references public.clients(id) on delete cascade,
  awb            text not null,
  event          text not null,
  payload        jsonb not null,
  attempts       int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at   timestamptz,
  dead           boolean not null default false,
  last_status    int,
  last_error     text,
  created_at     timestamptz not null default now()
);
-- The drain's hot path: undelivered, not dead, due now.
create index if not exists nv_api_webhook_queue_due_idx
  on public.nv_api_webhook_queue(next_attempt_at)
  where delivered_at is null and not dead;
create index if not exists nv_api_webhook_queue_client_idx
  on public.nv_api_webhook_queue(client_id, created_at desc);
alter table public.nv_api_webhook_queue enable row level security;

-- ------------------------------------------------------------ enqueue -------
create or replace function public.nv_api_enqueue_status()
returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_key public.nv_api_key;
begin
  -- Only real status changes.
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  begin
    -- One webhook per merchant: the newest live key that has a URL set.
    select * into v_key
      from public.nv_api_key
     where client_id = new.client_id
       and not revoked
       and webhook_url is not null
     order by created_at desc
     limit 1;

    if v_key.id is null then return new; end if;

    insert into public.nv_api_webhook_queue (key_id, client_id, awb, event, payload)
    values (
      v_key.id, new.client_id, new.awb, 'parcel.status',
      jsonb_build_object(
        'event',        'parcel.status',
        'awb',          new.awb,
        'status',       new.status,
        'exception',    new.exception,
        'cod_amount',   new.cod_amount,
        'delivery_charge', new.fee,
        'order_id',     nullif(new.meta->>'orderId',''),
        'reference',    nullif(new.meta->>'referenceNo',''),
        'consignee',    new.consignee,
        'city',         new.city,
        'occurred_at',  now(),   -- when the status actually changed
        'tracking_url', 'https://novaxlogistics.com/tracking.html?awb='||new.awb
      )
    );
  exception when others then
    -- Never let a webhook concern block a parcel moving.
    null;
  end;
  return new;
end $$;

drop trigger if exists trg_nv_api_enqueue_status on public.parcels;
create trigger trg_nv_api_enqueue_status
  after insert or update of status on public.parcels
  for each row execute function public.nv_api_enqueue_status();

-- -------------------------------------------------------------- claim -------
-- The drain claims a batch. SKIP LOCKED so two overlapping runs never send
-- the same event twice. Bumping attempts at claim time (not at result time)
-- means a drain that dies mid-flight still backs off instead of hot-looping.
create or replace function public.nv_api_webhook_claim(p_limit int default 20)
returns table(id uuid, url text, secret text, payload jsonb, attempts int)
language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  with due as (
    select q.id
      from public.nv_api_webhook_queue q
     where q.delivered_at is null and not q.dead and q.next_attempt_at <= now()
     order by q.next_attempt_at
     limit greatest(1, least(coalesce(p_limit,20), 100))
     for update skip locked
  ), bumped as (
    update public.nv_api_webhook_queue q
       set attempts = q.attempts + 1,
           next_attempt_at = now() + interval '10 minutes'  -- reclaim guard
      from due where q.id = due.id
     returning q.id, q.key_id, q.payload, q.attempts
  )
  select b.id, k.webhook_url, k.webhook_secret, b.payload, b.attempts
    from bumped b join public.nv_api_key k on k.id = b.key_id
   where k.webhook_url is not null and not k.revoked;
end $$;

-- ------------------------------------------------------------- result -------
create or replace function public.nv_api_webhook_result(
  p_id uuid, p_ok boolean, p_status int, p_error text default null)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_row public.nv_api_webhook_queue; v_delay interval;
begin
  select * into v_row from public.nv_api_webhook_queue where id = p_id;
  if v_row.id is null then return; end if;

  if p_ok then
    update public.nv_api_webhook_queue
       set delivered_at = now(), last_status = p_status, last_error = null
     where id = p_id;
  else
    -- 1m, 5m, 30m, 2h, 6h, then dead. Six tries across ~9 hours covers an
    -- overnight outage on the merchant's side without hammering them.
    v_delay := case v_row.attempts
                 when 1 then interval '1 minute'
                 when 2 then interval '5 minutes'
                 when 3 then interval '30 minutes'
                 when 4 then interval '2 hours'
                 else        interval '6 hours' end;
    update public.nv_api_webhook_queue
       set next_attempt_at = now() + v_delay,
           last_status = p_status,
           last_error  = left(coalesce(p_error,''), 500),
           dead        = (v_row.attempts >= 6)
     where id = p_id;
  end if;

  insert into public.nv_api_webhook_log (client_id, awb, event, status_code, ok, error)
  values (v_row.client_id, v_row.awb, v_row.event, p_status, p_ok, left(coalesce(p_error,''),500));
end $$;

-- The drain is deployed without JWT verification (cron has no user session),
-- so it authenticates on a shared token instead. Kept in a one-row table
-- rather than inlined, so rotating it is an UPDATE and not a redeploy.
create table if not exists public.nv_api_secret (
  name  text primary key,
  value text not null
);
alter table public.nv_api_secret enable row level security;

create or replace function public.nv_api_drain_token()
returns text language sql security definer set search_path to 'public' stable as $$
  select value from public.nv_api_secret where name = 'drain_token'
$$;
revoke all on function public.nv_api_drain_token() from public, anon, authenticated;

-- --------------------------------------------------------------- tick -------
-- Cron pokes the drain. If nothing is due the drain returns immediately, so a
-- once-a-minute poke costs essentially nothing.
create or replace function public.nv_api_webhook_tick()
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_pending int;
begin
  select count(*) into v_pending
    from public.nv_api_webhook_queue
   where delivered_at is null and not dead and next_attempt_at <= now();
  if v_pending = 0 then return; end if;

  perform net.http_post(
    url     := 'https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/api-webhook-drain',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-novax-drain', public.nv_api_drain_token()),
    timeout_milliseconds := 20000
  );
end $$;

revoke all on function public.nv_api_webhook_claim(int)  from public, anon, authenticated;
revoke all on function public.nv_api_webhook_result(uuid,boolean,int,text) from public, anon, authenticated;
revoke all on function public.nv_api_webhook_tick()      from public, anon, authenticated;

-- --------------------------------------------------- set webhook (v2) -------
-- Returns the signing secret, which the merchant needs in order to verify our
-- signature. The original returned only a boolean, which left them no way to
-- get it. Shown on every set so it can be re-read, and rotated by passing
-- p_rotate -- a merchant who leaks the secret must be able to fix it alone.
create or replace function public.nv_api_set_webhook_v2(
  p_key_id uuid, p_url text, p_rotate boolean default false)
returns table(url text, secret text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_url is not null and p_url <> '' and p_url !~ '^https://' then
    raise exception 'Webhook URL must start with https://';
  end if;
  update public.nv_api_key k
     set webhook_url = nullif(btrim(p_url), ''),
         webhook_secret = case
           when p_rotate then encode(extensions.gen_random_bytes(24),'hex')
           else coalesce(k.webhook_secret, encode(extensions.gen_random_bytes(24),'hex'))
         end
   where k.id = p_key_id and not k.revoked
   returning k.webhook_url, k.webhook_secret into url, secret;
  if not found then return; end if;
  return next;
end $$;
revoke all on function public.nv_api_set_webhook_v2(uuid,text,boolean) from public, anon, authenticated;
