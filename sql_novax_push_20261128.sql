-- 28 Nov 2026: phone notifications for the NovaX app (Android now; iPhone once
-- the Apple APNs key is in Firebase).
--
-- How it works:
--   * The app registers the phone with Firebase and hands its token to
--     client_push_register(). One row per phone in nv_push_devices.
--   * A parcel reaching Collected / Delivered / Refused / Not available /
--     Return to shipper, or a payout marked Paid, queues one message in
--     nv_push_queue for that merchant -- only if the merchant has a phone
--     registered and has not turned that event off in
--     client_notification_prefs.events.
--   * Every minute nv_push_tick() asks the edge function novax-push-drain to
--     send what is waiting (same private token as the email drain). The
--     function sends through Firebase (FCM HTTP v1) and forgets phones that
--     Firebase says are gone.
-- Safe to run again.

create table if not exists public.nv_push_devices (
  token        text primary key check (length(token) between 20 and 4096),
  user_id      uuid not null,
  client_id    uuid not null references public.clients(id) on delete cascade,
  platform     text not null check (platform in ('android','ios','web')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists nv_push_devices_client_idx on public.nv_push_devices (client_id);
alter table public.nv_push_devices enable row level security;
alter table public.nv_push_devices force row level security;
revoke all on public.nv_push_devices from public, anon, authenticated;
drop policy if exists nv_push_devices_staff on public.nv_push_devices;
create policy nv_push_devices_staff on public.nv_push_devices
  for select to authenticated using ((select public.is_staff_admin()));
grant select on public.nv_push_devices to authenticated;

create table if not exists public.nv_push_queue (
  id          bigint generated always as identity primary key,
  client_id   uuid not null references public.clients(id) on delete cascade,
  event       text not null,
  title       text not null,
  body        text not null,
  url         text not null default '/client.html?source=app',
  tag         text,
  state       text not null default 'pending' check (state in ('pending','sent','failed','skipped')),
  attempts    int not null default 0,
  lease_until timestamptz,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists nv_push_queue_pending_idx on public.nv_push_queue (created_at) where state = 'pending';
alter table public.nv_push_queue enable row level security;
alter table public.nv_push_queue force row level security;
revoke all on public.nv_push_queue from public, anon, authenticated;
drop policy if exists nv_push_queue_staff on public.nv_push_queue;
create policy nv_push_queue_staff on public.nv_push_queue
  for select to authenticated using ((select public.is_staff_admin()));
grant select on public.nv_push_queue to authenticated;

-- The app calls this after Firebase hands it a token. Any login of the
-- merchant (owner or team) may register its own phone.
create or replace function public.client_push_register(p_token text, p_platform text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); v_tok text := btrim(coalesce(p_token, ''));
begin
  if auth.uid() is null or v_client is null then raise exception 'Sign in to your NovaX account first.'; end if;
  if length(v_tok) < 20 or length(v_tok) > 4096 or v_tok ~ '[[:space:][:cntrl:]]' then raise exception 'Phone token is invalid.'; end if;
  if p_platform not in ('android','ios','web') then raise exception 'Unknown phone type.'; end if;
  insert into public.nv_push_devices (token, user_id, client_id, platform)
  values (v_tok, auth.uid(), v_client, p_platform)
  on conflict (token) do update
     set user_id = excluded.user_id, client_id = excluded.client_id,
         platform = excluded.platform, last_seen_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Sign-out: the phone stops getting this merchant's alerts.
create or replace function public.client_push_unregister(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', true, 'removed', 0); end if;
  delete from public.nv_push_devices where token = btrim(coalesce(p_token, '')) and user_id = auth.uid();
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'removed', n);
end $$;

revoke all on function public.client_push_register(text, text) from public, anon;
revoke all on function public.client_push_unregister(text) from public, anon;
grant execute on function public.client_push_register(text, text) to authenticated;
grant execute on function public.client_push_unregister(text) to authenticated;

-- Queue one message, if the merchant has a phone and wants this event.
create or replace function public.nv_push_enqueue(p_client uuid, p_event text, p_title text, p_body text, p_url text, p_tag text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_events jsonb;
begin
  if p_client is null then return; end if;
  if not exists (select 1 from public.nv_push_devices d where d.client_id = p_client) then return; end if;
  select events into v_events from public.client_notification_prefs where client_id = p_client;
  if v_events is not null and jsonb_typeof(v_events) = 'array' and not (v_events ? p_event) then return; end if;
  insert into public.nv_push_queue (client_id, event, title, body, url, tag)
  values (p_client, p_event, left(p_title, 120), left(p_body, 240), coalesce(p_url, '/client.html?source=app'), p_tag);
end $$;
revoke all on function public.nv_push_enqueue(uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function public.nv_push_parcel_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text; v_title text; v_body text; v_who text;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_who := coalesce(nullif(btrim(new.consignee), ''), 'your customer');
  if new.status = 'Delivered' then
    v_event := 'delivered'; v_title := 'Delivered · ' || new.awb;
    v_body := 'Delivered to ' || v_who || coalesce(' in ' || nullif(new.city, ''), '') || '.';
  elsif new.status = 'Refused' then
    v_event := 'refused'; v_title := 'Refused · ' || new.awb;
    v_body := v_who || ' refused the parcel. Open it to see the reason and what happens next.';
  elsif new.status = 'Consignee not available' then
    v_event := 'refused'; v_title := 'Customer not available · ' || new.awb;
    v_body := 'The rider could not reach ' || v_who || '. Open it to help us deliver.';
  elsif new.status = 'Return to shipper' then
    v_event := 'returned'; v_title := 'Returned to you · ' || new.awb;
    v_body := 'The parcel for ' || v_who || ' was handed back to you.';
  elsif new.status = 'Collected by rider'
        or (old.status = 'New booked' and new.status not in ('Cancelled by client', 'New booked')) then
    -- A same-city parcel can go from New booked straight to "received at
    -- destination" in one rider action, never showing Collected.
    v_event := 'picked_up'; v_title := 'Picked up · ' || new.awb;
    v_body := 'A NovaX rider collected the parcel for ' || v_who || '.';
  else
    return new;
  end if;
  begin
    perform public.nv_push_enqueue(new.client_id, v_event, v_title, v_body,
      '/client.html?source=app&awb=' || new.awb, 'awb-' || new.awb);
  exception when others then
    raise warning 'NovaX push enqueue failed for %: %', new.awb, sqlerrm;   -- never block a status change
  end;
  return new;
end $$;
drop trigger if exists zz_nv_push_parcel on public.parcels;
create trigger zz_nv_push_parcel after update of status on public.parcels
  for each row execute function public.nv_push_parcel_trg();

create or replace function public.nv_push_withdrawal_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'Paid' and old.status is distinct from 'Paid' then
    begin
      perform public.nv_push_enqueue(new.client_id, 'wallet_paid', 'Payout sent',
        'Rs ' || to_char(new.amount, 'FM999,999,990') || ' is on its way to your bank.',
        '/client.html?source=app&tab=money', 'payout-' || new.id);
    exception when others then
      raise warning 'NovaX push enqueue failed for payout %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;
drop trigger if exists zz_nv_push_withdrawal on public.withdrawals;
create trigger zz_nv_push_withdrawal after update of status on public.withdrawals
  for each row execute function public.nv_push_withdrawal_trg();

revoke all on function public.nv_push_parcel_trg() from public, anon, authenticated;
revoke all on function public.nv_push_withdrawal_trg() from public, anon, authenticated;

-- Wakes the sender when something waits. Same private token as the email drain.
create or replace function public.nv_push_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  -- Old rows go; a message that could not go out in 30 minutes is no longer news.
  update public.nv_push_queue set state = 'skipped', error = 'too old'
   where state = 'pending' and created_at < now() - interval '30 minutes';
  delete from public.nv_push_queue where created_at < now() - interval '14 days';
  if not exists (select 1 from public.nv_push_queue where state = 'pending' and coalesce(lease_until, '-infinity') < now()) then return; end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'novax_email_drain_token' limit 1;
  if coalesce(length(v_token), 0) < 32 and to_regprocedure('public.nv_api_drain_token()') is not null then
    select public.nv_api_drain_token() into v_token;
  end if;
  if coalesce(length(v_token), 0) < 32 then raise warning 'NovaX push: drain token missing'; return; end if;
  perform net.http_post(url := 'https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/novax-push-drain',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-novax-push-drain', v_token),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;
revoke all on function public.nv_push_tick() from public, anon, authenticated;

-- The sender's two calls (service role only).
create or replace function public.nv_push_claim(p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with c as (
    select q.id from public.nv_push_queue q
     where q.state = 'pending' and coalesce(q.lease_until, '-infinity') < now()
     order by q.id limit greatest(1, least(coalesce(p_limit, 200), 500))
     for update skip locked
  ), u as (
    update public.nv_push_queue q set lease_until = now() + interval '2 minutes', attempts = q.attempts + 1
      from c where q.id = c.id
    returning q.id, q.client_id, q.title, q.body, q.url, q.tag, q.event
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'body', u.body, 'url', u.url, 'tag', u.tag, 'event', u.event,
           'tokens', (select coalesce(jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform)), '[]'::jsonb)
                        from public.nv_push_devices d where d.client_id = u.client_id))), '[]'::jsonb)
    into v from u;
  return v;
end $$;

-- results: [{id, ok, error, gone: [tokens]}]
create or replace function public.nv_push_done(p_results jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r jsonb; t text;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    update public.nv_push_queue
       set state = case when (r->>'ok')::boolean then 'sent'
                        when attempts >= 3 then 'failed' else 'pending' end,
           sent_at = case when (r->>'ok')::boolean then now() end,
           error = left(r->>'error', 300), lease_until = null
     where id = (r->>'id')::bigint;
    for t in select jsonb_array_elements_text(coalesce(r->'gone', '[]'::jsonb)) loop
      delete from public.nv_push_devices where token = t;
    end loop;
  end loop;
end $$;
revoke all on function public.nv_push_claim(int) from public, anon, authenticated;
revoke all on function public.nv_push_done(jsonb) from public, anon, authenticated;
grant execute on function public.nv_push_claim(int) to service_role;
grant execute on function public.nv_push_done(jsonb) to service_role;

-- Every minute, like the email drain.
select cron.unschedule('novax-push') where exists (select 1 from cron.job where jobname = 'novax-push');
select cron.schedule('novax-push', '* * * * *', 'select public.nv_push_tick();');
