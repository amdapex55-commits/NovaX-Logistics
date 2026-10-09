-- 9 Oct 2026: the customer answers on the tracking page.
--
-- On a tokenised tracking link the customer can tap one of four answers:
--   home_today      "I'll be home today"
--   tomorrow        "Deliver tomorrow"
--   call_first      "Call me first"
--   wrong_address   "Wrong address" + the correct address in their own words
-- The seller sees it in the portal and the rider sees it on the parcel.
--
-- Deliberately NOT written into parcels.meta: every update of a parcel runs a
-- dozen guard triggers (status transitions, frozen money, contact protection),
-- and an anonymous visitor must not be able to reach any of them. An answer is
-- a row in its own closed table; nothing about the parcel changes. A "wrong
-- address" answer is a message to the seller, not an edit.
--
-- Safe to run twice.

create table if not exists public.nv_customer_replies (
  id            uuid primary key default gen_random_uuid(),
  parcel_id     uuid not null references public.parcels(id) on delete cascade,
  client_id     uuid not null,
  awb           text not null,
  choice        text not null check (choice in ('home_today','tomorrow','call_first','wrong_address')),
  note          text check (note is null or char_length(note) between 1 and 200),
  parcel_status text not null,
  created_at    timestamptz not null default now()
);
create index if not exists nv_customer_replies_parcel_idx on public.nv_customer_replies (parcel_id, created_at desc);
create index if not exists nv_customer_replies_client_idx on public.nv_customer_replies (client_id, created_at desc);

-- Closed to the API. Every read and write goes through the functions below.
alter table public.nv_customer_replies enable row level security;
revoke all on table public.nv_customer_replies from public, anon, authenticated;

-- The statuses in which an answer still means something: the parcel is on
-- its way, or a delivery was tried and failed. Not once it is delivered,
-- cancelled, out of area or travelling back to the seller.
create or replace function public.nv_customer_reply_statuses()
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select array['New booked','Collected by rider','Arrived at warehouse','Parcel now in transit',
               'Parcel received at destination','Parcel out for delivery','Reattempt','Reassigned',
               'Consignee not available','Refused']
$$;
revoke all on function public.nv_customer_reply_statuses() from public, anon, authenticated;

-- What the tracking page needs when it opens: may the customer answer, and
-- what did they last say. Nothing about the parcel itself.
create or replace function public.public_track_reply_get(p_token text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'open', p.status = any(public.nv_customer_reply_statuses()),
    'reply', (select jsonb_build_object('choice', r.choice, 'note', r.note, 'at', r.created_at)
                from public.nv_customer_replies r
               where r.parcel_id = p.id
               order by r.created_at desc limit 1))
    from public.parcels p
   where p.tracking_token is not null
     and length(btrim(coalesce(p_token, ''))) >= 20
     and p.tracking_token = btrim(coalesce(p_token, ''))
   limit 1
$$;
revoke all on function public.public_track_reply_get(text) from public;
grant execute on function public.public_track_reply_get(text) to anon, authenticated;

-- The customer's answer. Only someone holding the tokenised link can call it
-- to any effect; a tracking number alone is not enough.
create or replace function public.public_track_reply(p_token text, p_choice text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid; v_client uuid; v_awb text; v_status text;
  v_note text; v_n int; v_at timestamptz;
begin
  if length(btrim(coalesce(p_token, ''))) < 20 then
    return jsonb_build_object('ok', false, 'reason', 'bad_link');
  end if;
  select p.id, p.client_id, p.awb, p.status into v_id, v_client, v_awb, v_status
    from public.parcels p
   where p.tracking_token is not null and p.tracking_token = btrim(p_token)
   limit 1;
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_link');
  end if;
  if p_choice is null or p_choice not in ('home_today','tomorrow','call_first','wrong_address') then
    return jsonb_build_object('ok', false, 'reason', 'bad_choice');
  end if;
  if not (v_status = any(public.nv_customer_reply_statuses())) then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  -- Only the address answer carries the customer's own words, and they are
  -- flattened to one plain line of at most 200 characters.
  v_note := null;
  if p_choice = 'wrong_address' then
    v_note := left(nullif(btrim(regexp_replace(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]]+', ' ', 'g'), '\s+', ' ', 'g')), ''), 200);
    if v_note is null or char_length(v_note) < 8 then
      return jsonb_build_object('ok', false, 'reason', 'need_address');
    end if;
  end if;

  -- One writer at a time for a parcel, so the daily limit cannot be raced.
  perform pg_advisory_xact_lock(hashtext('nv_customer_reply:' || v_id::text));
  select count(*) into v_n
    from public.nv_customer_replies r
   where r.parcel_id = v_id and r.created_at > now() - interval '24 hours';
  if v_n >= 6 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;

  -- clock_timestamp(), not now(): two answers in one transaction must still
  -- sort in the order they were given.
  insert into public.nv_customer_replies (parcel_id, client_id, awb, choice, note, parcel_status, created_at)
  values (v_id, v_client, v_awb, p_choice, v_note, v_status, clock_timestamp())
  returning created_at into v_at;

  return jsonb_build_object('ok', true, 'choice', p_choice, 'note', v_note, 'at', v_at);
end
$$;
revoke all on function public.public_track_reply(text, text, text) from public;
grant execute on function public.public_track_reply(text, text, text) to anon, authenticated;

-- The seller's side: the latest answer on each of their parcels, three weeks back.
create or replace function public.client_customer_replies()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'awb', x.awb, 'choice', x.choice, 'note', x.note, 'at', x.created_at, 'status_then', x.parcel_status)
           order by x.created_at desc), '[]'::jsonb)
    from (
      select distinct on (r.parcel_id) r.*
        from public.nv_customer_replies r
       where public.my_client_id() is not null
         and r.client_id = public.my_client_id()
         and r.created_at > now() - interval '21 days'
       order by r.parcel_id, r.created_at desc
    ) x
$$;
revoke all on function public.client_customer_replies() from public, anon;
grant execute on function public.client_customer_replies() to authenticated;

-- The rider's side: the parcel list already built for the rider app gains one
-- field, the customer's latest answer from the last four days. Patched in
-- place from the live definition so nothing else in it can drift.
do $patch$
declare
  v_def text := pg_get_functiondef('public.rider_station_view()'::regprocedure);
  v_old text := E'        ''meta'', t.meta, ''exception'', t.exception,\n';
  v_new text := E'        ''meta'', t.meta, ''exception'', t.exception,\n'
             || E'        ''customer_reply'', (select jsonb_build_object(''choice'', cr.choice, ''note'', cr.note, ''at'', cr.created_at)\n'
             || E'                             from public.nv_customer_replies cr\n'
             || E'                            where cr.parcel_id = t.id and cr.created_at > now() - interval ''4 days''\n'
             || E'                            order by cr.created_at desc limit 1),\n';
begin
  if position('''customer_reply''' in v_def) > 0 then
    raise notice 'rider_station_view already carries the customer''s answer';
  elsif (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) = 1 then
    execute replace(v_def, v_old, v_new);
    raise notice 'rider_station_view now carries the customer''s answer';
  else
    raise exception 'rider_station_view does not have the line this file expects; nothing was changed';
  end if;
end
$patch$;
