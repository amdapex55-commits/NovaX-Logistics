-- ===========================================================================
-- NovaX -- "Ask the merchant" WhatsApp nudge
--
-- WHAT THIS IS FOR
--   87 parcels are sitting in an exception state right now (64 Return to
--   shipper, 21 Refused, 2 Reattempt) across ~30 merchants. Every one of them
--   is waiting on a decision only the merchant can make, and nothing in the
--   product asks them for it. This puts a one-tap wa.me link on the exception
--   row that opens WhatsApp with the merchant's number and the question
--   already typed.
--
--   Note the direction. admin.html already had messageCustomer(), which
--   messages the CONSIGNEE ("your parcel is out for delivery"). This is the
--   opposite conversation: it messages the SHIPPER and asks them to choose.
--
-- ONCE ONLY -- AND WHY IT LIVES HERE
--   A disabled button is a UI state. A refresh, a second admin, or another
--   device walks straight past it. The `unique (parcel_id)` below is the
--   actual enforcement: two people pressing in the same second means one
--   insert wins and the other is told who got there first.
--
--   The claim is recorded BEFORE WhatsApp opens, because handing off to
--   wa.me tells us nothing about whether the message was ever sent. That
--   makes an accidental tap final, so admin_wa_nudge_unlock() exists to
--   release exactly one parcel, on the record, with a reason. Once stays
--   once in practice; it just isn't a dead end.
-- ===========================================================================

-- The live claim. One row per parcel, forever, unless an admin releases it.
create table if not exists public.nv_wa_nudge (
  parcel_id      uuid primary key references public.parcels(id) on delete cascade,
  client_id      uuid not null references public.clients(id) on delete cascade,
  awb            text not null,
  status_at_send text not null,
  template       text not null,
  message        text not null,
  phone_e164     text not null,
  sent_by        uuid,
  sent_by_label  text,
  sent_at        timestamptz not null default now()
);
create index if not exists nv_wa_nudge_client_idx on public.nv_wa_nudge(client_id, sent_at desc);
alter table public.nv_wa_nudge enable row level security;

-- Append-only history. The table above can lose a row to an unlock; this one
-- never loses anything, so "who chased this parcel, and when" stays answerable.
create table if not exists public.nv_wa_nudge_log (
  id         uuid primary key default gen_random_uuid(),
  parcel_id  uuid,
  awb        text,
  client_id  uuid,
  action     text not null check (action in ('claim','unlock','blocked')),
  detail     text,
  actor      uuid,
  actor_label text,
  created_at timestamptz not null default now()
);
create index if not exists nv_wa_nudge_log_awb_idx on public.nv_wa_nudge_log(awb, created_at desc);
alter table public.nv_wa_nudge_log enable row level security;

-- ------------------------------------------------------------ phone --------
-- Mirrors waPhoneDigits() in admin.html. All 214 merchants with a number are
-- stored as 03XXXXXXXXX, so the common path is one rule; the rest are here so
-- a hand-edited number still resolves instead of silently failing.
create or replace function public.nv_wa_phone(p_phone text)
returns text language plpgsql immutable as $$
declare d text;
begin
  d := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if    d ~ '^03[0-9]{9}$'  then d := '92' || substr(d, 2);
  elsif d ~ '^3[0-9]{9}$'   then d := '92' || d;
  elsif d ~ '^92[0-9]{10}$' then d := d;
  elsif d ~ '^00923[0-9]{9}$' then d := substr(d, 3);
  else  return null;
  end if;
  return case when d ~ '^923[0-9]{9}$' then d else null end;
end $$;

-- ---------------------------------------------------------- message --------
-- One place the wording lives, so the message cannot drift between the button
-- and the log. Addressed to clients.name, which is the brand ("Gen Zee
-- Creation") rather than the owner's personal name.
create or replace function public.nv_wa_nudge_message(
  p_brand text, p_awb text, p_status text, p_consignee text, p_city text, p_cod numeric)
returns table(template text, message text)
language plpgsql immutable as $$
declare v_who text; v_ask text;
begin
  v_who := coalesce(nullif(btrim(p_consignee),''), 'the consignee')
           || case when coalesce(nullif(btrim(p_city),''),'') <> '' then ' in ' || btrim(p_city) else '' end;

  if p_status = 'Refused' then
    template := 'refused';
    v_ask := 'Parcel ' || p_awb || ' for ' || v_who || ' was refused at delivery.'
          || E'\n\nWould you like us to reattempt tomorrow, or return it to you?'
          || E'\nReply 1 for reattempt, 2 for return.';
  elsif p_status = 'Consignee not available' then
    template := 'not_available';
    v_ask := 'We could not reach ' || v_who || ' for parcel ' || p_awb || ' after our attempts today.'
          || E'\n\nDo you have an alternate number for them, or should we reattempt tomorrow?'
          || E'\nReply with a number, or 1 to reattempt.';
  elsif p_status = 'Out of service area' then
    template := 'out_of_area';
    v_ask := 'Parcel ' || p_awb || ' is addressed to ' || v_who || ', which is outside our delivery area.'
          || E'\n\nWould you like to give us a different address, or should we return it to you?'
          || E'\nReply with an address, or 2 to return.';
  elsif p_status = 'Reattempt' then
    template := 'reattempt';
    v_ask := 'Parcel ' || p_awb || ' for ' || v_who || ' is queued for another delivery attempt.'
          || E'\n\nIf anything about the address or number has changed, reply here and we will use it on the next attempt.';
  elsif p_status in ('Ready for return','Return in transit','Return received at origin',
                     'Return out for delivery','Return to shipper') then
    template := 'return';
    v_ask := 'Parcel ' || p_awb || ' (' || v_who || ') is on its way back to you.'
          || E'\n\nPlease confirm the pickup address and a time that suits you, and we will bring it on the next run.';
  else
    template := 'generic';
    v_ask := 'Parcel ' || p_awb || ' for ' || v_who || ' needs a decision from you -- its current status is "'
          || p_status || '".' || E'\n\nPlease reply here and we will action it.';
  end if;

  if coalesce(p_cod,0) > 0 then
    v_ask := v_ask || E'\n\nCOD on this parcel: Rs ' || trim(to_char(p_cod, 'FM999,999,990'));
  end if;

  message := 'Assalam-o-Alaikum ' || coalesce(nullif(btrim(p_brand),''), 'there') || E' --\n\n'
          || v_ask
          || E'\n\nTrack it: https://novaxlogistics.com/tracking.html?awb=' || p_awb
          || E'\n\n-- NovaX Logistics';
  return next;
end $$;

-- ------------------------------------------------------------- claim -------
-- Returns everything the button needs, and takes the slot in the same call so
-- there is no window between "we said yes" and "it is recorded".
create or replace function public.admin_wa_nudge_claim(p_awb text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_p parcels; v_c clients; v_phone text; v_t text; v_m text;
  v_prev nv_wa_nudge; v_actor uuid; v_label text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  v_actor := auth.uid();
  select email into v_label from auth.users where id = v_actor;

  select * into v_p from parcels where awb = p_awb;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'parcel_not_found'); end if;

  -- Already claimed? Say who and when rather than a bare refusal.
  select * into v_prev from nv_wa_nudge where parcel_id = v_p.id;
  if v_prev.parcel_id is not null then
    insert into nv_wa_nudge_log(parcel_id, awb, client_id, action, detail, actor, actor_label)
    values (v_p.id, p_awb, v_p.client_id, 'blocked',
            'already sent ' || to_char(v_prev.sent_at, 'DD Mon HH24:MI') ||
            ' by ' || coalesce(v_prev.sent_by_label,'unknown'), v_actor, v_label);
    return jsonb_build_object('ok', false, 'error', 'already_sent',
      'sent_at', v_prev.sent_at, 'sent_by', v_prev.sent_by_label,
      'status_at_send', v_prev.status_at_send);
  end if;

  select * into v_c from clients where id = v_p.client_id;
  if v_c.id is null then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;

  v_phone := public.nv_wa_phone(v_c.phone);
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'no_usable_phone',
      'stored_phone', coalesce(nullif(btrim(v_c.phone),''), null), 'brand', v_c.name);
  end if;

  select template, message into v_t, v_m
    from public.nv_wa_nudge_message(v_c.name, v_p.awb, v_p.status, v_p.consignee, v_p.city, v_p.cod_amount);

  -- The unique primary key is the real guard; ON CONFLICT keeps a race from
  -- raising in the loser's face.
  insert into nv_wa_nudge(parcel_id, client_id, awb, status_at_send, template, message, phone_e164, sent_by, sent_by_label)
  values (v_p.id, v_p.client_id, v_p.awb, v_p.status, v_t, v_m, v_phone, v_actor, v_label)
  on conflict (parcel_id) do nothing;

  if not found then
    select * into v_prev from nv_wa_nudge where parcel_id = v_p.id;
    return jsonb_build_object('ok', false, 'error', 'already_sent',
      'sent_at', v_prev.sent_at, 'sent_by', v_prev.sent_by_label);
  end if;

  insert into nv_wa_nudge_log(parcel_id, awb, client_id, action, detail, actor, actor_label)
  values (v_p.id, p_awb, v_p.client_id, 'claim', v_t || ' -> ' || v_phone, v_actor, v_label);

  -- The wa.me URL is assembled by the caller with encodeURIComponent. Building
  -- it here would mean hand-rolling percent-encoding in SQL, which is exactly
  -- the kind of thing that works until someone's brand name has an ampersand.
  return jsonb_build_object('ok', true, 'phone', v_phone, 'message', v_m,
    'brand', v_c.name, 'template', v_t, 'status', v_p.status);
end $$;

-- ------------------------------------------------------------ unlock -------
create or replace function public.admin_wa_nudge_unlock(p_awb text, p_reason text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_p parcels; v_actor uuid; v_label text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if coalesce(btrim(p_reason),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  v_actor := auth.uid();
  select email into v_label from auth.users where id = v_actor;
  select * into v_p from parcels where awb = p_awb;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'parcel_not_found'); end if;

  delete from nv_wa_nudge where parcel_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_claimed'); end if;

  insert into nv_wa_nudge_log(parcel_id, awb, client_id, action, detail, actor, actor_label)
  values (v_p.id, p_awb, v_p.client_id, 'unlock', btrim(p_reason), v_actor, v_label);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------- read --------
-- Which of the open exceptions have been chased, so the queue can show it
-- without a request per row.
create or replace function public.admin_wa_nudge_map()
returns table(awb text, sent_at timestamptz, sent_by_label text, status_at_send text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query select n.awb, n.sent_at, n.sent_by_label, n.status_at_send from nv_wa_nudge n;
end $$;

revoke all on function public.admin_wa_nudge_claim(text)        from public, anon;
revoke all on function public.admin_wa_nudge_unlock(text,text)  from public, anon;
revoke all on function public.admin_wa_nudge_map()              from public, anon;
grant execute on function public.admin_wa_nudge_claim(text)       to authenticated;
grant execute on function public.admin_wa_nudge_unlock(text,text) to authenticated;
grant execute on function public.admin_wa_nudge_map()             to authenticated;
