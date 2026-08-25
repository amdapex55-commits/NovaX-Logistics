-- =====================================================================
-- NovaX backend -- tickets
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 13 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.claim_ticket(p_ticket_id uuid, p_staff_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff public.staff_users;
  v_cur   uuid;
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can claim tickets';
  end if;

  -- Default to the caller's own staff seat, resolved via auth_user_id.
  if p_staff_id is null then
    select * into v_staff from public.staff_users where auth_user_id = auth.uid() limit 1;
    if v_staff is null then
      raise exception 'No staff seat is linked to your login yet, so the ticket cannot be assigned to you';
    end if;
  else
    select * into v_staff from public.staff_users where id = p_staff_id;
    if v_staff is null then raise exception 'Staff user not found'; end if;
  end if;

  select assigned_to into v_cur from public.tickets where id = p_ticket_id;
  if v_cur is not null and v_cur <> v_staff.id then
    raise exception 'Ticket is already claimed by another agent. Release it first.';
  end if;

  update public.tickets
     set assigned_to = v_staff.id,
         assigned_at = now(),
         meta = meta || jsonb_build_object(
                  'assignedToName', v_staff.name, 'assignedToId', v_staff.id),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object('assigned_to', v_staff.id, 'name', v_staff.name);
end $$;

CREATE FUNCTION public.ensure_ticket_from_issue(p_source_key text, p_client_id uuid, p_subject text, p_body text, p_tier text DEFAULT 'medium'::text, p_from text DEFAULT 'System Monitor'::text, p_to text DEFAULT 'Admin Control'::text, p_branch text DEFAULT 'Admin'::text, p_awb text DEFAULT ''::text, p_age_hours numeric DEFAULT 0, p_escalated boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_id        uuid;
  v_escalated boolean;
  v_to        text;
  v_code      text;
  v_limit     numeric;
begin
  if p_source_key is null or p_source_key = '' then
    raise exception 'ensure_ticket_from_issue requires a sourceKey';
  end if;

  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);

  -- Reopen-safe: an already-open ticket for this sourceKey is refreshed,
  -- never duplicated. A resolved one is left alone so closed work does
  -- not silently come back to life.
  select id into v_id
    from public.tickets
   where meta->>'sourceKey' = p_source_key
     and status <> 'Resolved'
   limit 1;

  v_escalated := p_escalated or coalesce(p_age_hours, 0) >= v_limit;
  v_to := case when v_escalated then 'Admin Control' else p_to end;

  if v_id is not null then
    update public.tickets t
       set meta = t.meta
                  || jsonb_build_object(
                       'ageHours', greatest(coalesce((t.meta->>'ageHours')::numeric, 0), coalesce(p_age_hours, 0)),
                       'escalated', coalesce((t.meta->>'escalated')::boolean, false) or v_escalated
                     )
                  || case when v_escalated then jsonb_build_object('to', 'Admin Control') else '{}'::jsonb end,
           escalated_at = coalesce(t.escalated_at, case when v_escalated then now() else null end),
           updated_at = now()
     where t.id = v_id;
    return v_id;
  end if;

  -- Human-readable code in the same TCK-0000 shape the browsers generate.
  v_code := 'TCK-' || lpad(((select count(*) from public.tickets) + 1)::text, 4, '0');

  insert into public.tickets (client_id, subject, body, status, first_response_at, meta)
  values (
    p_client_id, p_subject, p_body, 'Open', null,
    jsonb_build_object(
      'code', v_code, 'sourceKey', p_source_key,
      'tier', case when v_escalated then 'emergency' else coalesce(p_tier, 'medium') end,
      'from', p_from, 'to', v_to, 'branch', p_branch, 'awb', coalesce(p_awb, ''),
      'ageHours', coalesce(p_age_hours, 0), 'escalated', v_escalated,
      'replies', '[]'::jsonb, 'source', 'sla-cron'
    )
  )
  on conflict ((meta->>'sourceKey')) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.tickets where meta->>'sourceKey' = p_source_key limit 1;
  end if;

  if v_escalated and v_id is not null then
    update public.tickets set escalated_at = coalesce(escalated_at, now()) where id = v_id;
  end if;

  return v_id;
end $$;

CREATE FUNCTION public.novax_ticket_client_reply(p_ticket_id uuid, p_body text) RETURNS public.novax_ticket_replies
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_client uuid; v_t public.novax_tickets; v_row public.novax_ticket_replies; v_name text;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet.'; end if;
  if coalesce(btrim(p_body),'') = '' then raise exception 'Reply cannot be empty.'; end if;

  select * into v_t from public.novax_tickets where id = p_ticket_id and client_id = v_client;
  if not found then raise exception 'Ticket not found on your account.'; end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_ticket_replies (ticket_id, body, by_name, by_side)
  values (p_ticket_id, btrim(p_body), coalesce(v_name,''), 'client')
  returning * into v_row;

  -- A client reply reopens a ticket that was waiting on them.
  update public.novax_tickets
     set status = case when status = 'pending_client' then 'open' else status end,
         updated_at = now()
   where id = p_ticket_id;

  return v_row;
end $$;

CREATE FUNCTION public.novax_ticket_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.code is null then
    new.code := 'TKT-' || lpad(nextval('public.novax_ticket_seq')::text, 6, '0');
  end if;
  return new;
end $$;

CREATE FUNCTION public.novax_ticket_open(p_subject text, p_body text DEFAULT ''::text, p_awb text DEFAULT ''::text, p_priority text DEFAULT 'normal'::text) RETURNS public.novax_tickets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_client uuid; v_row public.novax_tickets; v_name text; v_open int;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  if coalesce(btrim(p_subject),'') = '' then
    raise exception 'Please describe the issue in one line.';
  end if;

  -- Cheap abuse guard. Not dedupe -- a merchant may legitimately have
  -- several open tickets; this only stops a runaway loop or a stuck button.
  select count(*) into v_open from public.novax_tickets
   where client_id = v_client and status <> 'resolved';
  if v_open >= 20 then
    raise exception 'You already have 20 open tickets. Please wait for those to be answered first.';
  end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_tickets (client_id, awb, subject, body, priority, opened_by, opened_by_name)
  values (v_client,
          nullif(btrim(p_awb),''),
          btrim(p_subject),
          coalesce(btrim(p_body),''),
          case when p_priority in ('low','normal','high') then p_priority else 'normal' end,
          'client',
          coalesce(v_name,''))
  returning * into v_row;

  return v_row;
end $$;

CREATE FUNCTION public.novax_ticket_stamp_first_response() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.by_side = 'admin' then
    update public.novax_tickets
       set first_response_at = coalesce(first_response_at, new.created_at),
           updated_at = now()
     where id = new.ticket_id;
  end if;
  return new;
end $$;

CREATE FUNCTION public.novax_ticket_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  if new.status = 'resolved' and coalesce(old.status,'') <> 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if new.status <> 'resolved' then
    new.resolved_at := null;
    new.resolved_by := '';
  end if;
  return new;
end $$;

CREATE FUNCTION public.release_ticket(p_ticket_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can release tickets';
  end if;
  update public.tickets
     set assigned_to = null, assigned_at = null,
         meta = (meta - 'assignedToName') - 'assignedToId',
         updated_at = now()
   where id = p_ticket_id;
  return jsonb_build_object('released', true);
end $$;

CREATE FUNCTION public.sla_elapsed_hours(p_from timestamp with time zone, p_to timestamp with time zone DEFAULT now()) RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  cfg      public.support_hours;
  v_hours  numeric := 0;
  v_cursor timestamptz;
  v_local  timestamp;
  v_dow    int;
  v_hour   int;
  v_guard  int := 0;
begin
  if p_from is null then return 0; end if;
  if p_to <= p_from then return 0; end if;

  select * into cfg from public.support_hours where id = 1;
  if cfg is null or cfg.is_24_7 then
    return round(extract(epoch from (p_to - p_from)) / 3600.0, 2);
  end if;

  v_cursor := date_trunc('hour', p_from);
  while v_cursor < p_to and v_guard < 20000 loop
    v_guard := v_guard + 1;
    v_local := v_cursor at time zone cfg.timezone;
    v_dow   := extract(dow from v_local)::int;
    v_hour  := extract(hour from v_local)::int;
    if v_dow = any (cfg.work_days) and v_hour >= cfg.open_hour and v_hour < cfg.close_hour then
      v_hours := v_hours + 1;
    end if;
    v_cursor := v_cursor + interval '1 hour';
  end loop;

  return round(v_hours, 2);
end $$;

CREATE FUNCTION public.sla_enforce_tick() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_limit      numeric;
  v_escalated  int := 0;
  v_created    int := 0;
  r             record;
  v_new        uuid;
begin
  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);

  -- 5a. Escalate any open ticket past the threshold with a REAL update, so
  -- the existing postgres_changes subscription on `tickets` fires in every
  -- open admin and client session. No new channel is created anywhere.
  for r in
    select t.* from public.tickets t
     where t.status <> 'Resolved'
       and coalesce((t.meta->>'escalated')::boolean, false) = false
       and public.sla_elapsed_hours(t.created_at, now()) >= v_limit
  loop
    update public.tickets t
       set meta = t.meta || jsonb_build_object(
                     'escalated', true,
                     'tier', 'emergency',
                     'to', 'Admin Control',
                     'previousTo', coalesce(t.meta->>'to', 'unknown'),
                     'ageHours', public.sla_elapsed_hours(t.created_at, now())
                   ),
           escalated_at = now(),
           updated_at = now()
     where t.id = r.id;
    v_escalated := v_escalated + 1;

    begin
      insert into public.ticket_notifications (text, level, meta)
      values (
        coalesce(r.meta->>'code', r.id::text) || ' escalated to Admin Control after '
          || round(v_limit)::text || 'h. Original owner: '
          || coalesce(nullif(r.meta->>'to',''), 'unknown') || '.',
        'bad',
        jsonb_build_object('ticketId', r.id, 'source', 'sla-cron')
      );
    exception when undefined_table or undefined_column then null;
    end;
  end loop;

  -- 5b. Keep the stored age fresh on every open ticket so a browser that
  -- opens later shows the right clock immediately.
  update public.tickets t
     set meta = t.meta || jsonb_build_object('ageHours', public.sla_elapsed_hours(t.created_at, now()))
   where t.status <> 'Resolved';

  -- 5c. Parcel transit breach: same rule as alertForParcel()=='critical'.
  -- NovaX fix (deploy blocker): parcels has no top-level `branch` column --
  -- the real value lives in meta->>'branch' (confirmed against admin.html's
  -- own row mapper). Referencing p.branch directly threw undefined_column
  -- and rolled back the whole function call, every 5 minutes, forever.
  for r in
    select p.id, p.awb, p.client_id, p.status, p.city,
           coalesce(p.meta->>'branch','') as branch, p.consignee,
           public.sla_elapsed_hours(coalesce(p.updated_at, p.created_at), now()) as age
      from public.parcels p
     where coalesce(p.status,'') not in ('Delivered','Parcel returned to consignee','Cancelled')
       and public.sla_elapsed_hours(coalesce(p.updated_at, p.created_at), now()) >= 72
  loop
    v_new := public.ensure_ticket_from_issue(
      'parcel:' || r.awb || ':critical', r.client_id,
      'Parcel stuck in transit past SLA',
      r.awb || ' is breaching SLA. Current status: ' || coalesce(r.status,'unknown')
        || '. No movement for ' || round(r.age)::text || 'h.',
      'emergency', 'AI Status Clock',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub') || ' Manager',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub'),
      r.awb, r.age, r.age >= v_limit
    );
    if v_new is not null then v_created := v_created + 1; end if;
  end loop;

  -- 5d. Refusal / proof disputes.
  -- NovaX fix (deploy blocker): same p.branch issue as 5c, plus
  -- p.exception_note does not exist -- the real column is just p.exception
  -- (confirmed against admin.html's mapper: exception: r.exception, and the
  -- original parcels schema which defines `exception text`).
  for r in
    select p.id, p.awb, p.client_id, p.status, p.city,
           coalesce(p.meta->>'branch','') as branch, p.consignee,
           coalesce(p.exception, p.meta->>'exception', '') as exc,
           public.sla_elapsed_hours(coalesce(p.updated_at, p.created_at), now()) as age
      from public.parcels p
     where coalesce(p.status,'') || ' ' || coalesce(p.exception, p.meta->>'exception', '')
           ~* '(refus|fake|denies|return proof|proof pending|dispute)'
  loop
    v_new := public.ensure_ticket_from_issue(
      'parcel:' || r.awb || ':proof', r.client_id,
      'Rider proof / refusal review',
      coalesce(nullif(r.consignee,''), r.awb) || ' issue needs proof review. '
        || coalesce(nullif(r.exc,''), 'Check rider attempt data.'),
      case when r.age >= v_limit then 'emergency' else 'medium' end,
      'Customer Support',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub') || ' Manager',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub'),
      r.awb, r.age, false
    );
    if v_new is not null then v_created := v_created + 1; end if;
  end loop;

  -- 5e. Missing CN in demanifest -- leakage risk, always escalated.
  begin
    for r in
      select m.id, m.meta, m.from_hub, m.to_hub, m.created_at,
             jsonb_array_elements_text(coalesce(m.meta->'missingAwbs', '[]'::jsonb)) as awb
        from public.manifest_logs m
       where coalesce(m.meta->'missingAwbs', '[]'::jsonb) <> '[]'::jsonb
    loop
      v_new := public.ensure_ticket_from_issue(
        'manifest:' || r.id::text || ':' || r.awb, null,
        'Missing CN in demanifest',
        r.awb || ' is missing from manifest ' || r.id::text || '. Route '
          || coalesce(r.from_hub,'?') || ' to ' || coalesce(r.to_hub,'?')
          || '. Admin must verify leakage before closing the sack.',
        'emergency', 'Demanifest Scan', 'Admin Control',
        coalesce(r.to_hub, 'Destination Hub'), r.awb,
        public.sla_elapsed_hours(r.created_at, now()), true
      );
      if v_new is not null then v_created := v_created + 1; end if;
    end loop;
  exception when undefined_table or undefined_column then null;
  end;

  return jsonb_build_object(
    'ran_at', now(), 'escalated', v_escalated, 'auto_tickets_touched', v_created
  );
end $$;

CREATE FUNCTION public.submit_ticket_csat(p_ticket_id uuid, p_score smallint, p_comment text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  t         public.tickets;
  v_client  uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'No client workspace resolved for your login'; end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select * into t from public.tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket not found'; end if;
  if t.client_id is distinct from v_client then
    raise exception 'That ticket does not belong to your workspace';
  end if;
  if t.status <> 'Resolved' then
    raise exception 'You can rate a ticket once it has been resolved';
  end if;
  if t.csat_score is not null then
    raise exception 'This ticket has already been rated';
  end if;

  update public.tickets
     set csat_score = p_score,
         csat_comment = nullif(trim(coalesce(p_comment,'')), ''),
         csat_at = now(),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object('ok', true, 'score', p_score);
end $$;

CREATE FUNCTION public.ticket_effective_tier(p_ticket public.tickets) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  v_limit numeric;
  v_age   numeric;
begin
  if p_ticket.status = 'Resolved' then return 'resolved'; end if;
  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);
  v_age := public.sla_elapsed_hours(p_ticket.created_at, now());
  if coalesce((p_ticket.meta->>'escalated')::boolean, false) or v_age >= v_limit then
    return 'emergency';
  end if;
  return coalesce(nullif(p_ticket.meta->>'tier',''), 'medium');
end $$;

CREATE FUNCTION public.ticket_mark_first_response(p_ticket_id uuid, p_by text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  t public.tickets;
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can record a first response';
  end if;

  select * into t from public.tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket not found'; end if;

  if t.first_response_at is not null then
    return jsonb_build_object(
      'already_set', true, 'first_response_at', t.first_response_at,
      'first_response_hours', public.sla_elapsed_hours(t.created_at, t.first_response_at)
    );
  end if;

  update public.tickets
     set first_response_at = now(),
         first_response_by = coalesce(p_by, 'admin'),
         meta = meta || jsonb_build_object(
                  'firstResponseHours', public.sla_elapsed_hours(t.created_at, now())),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object(
    'already_set', false, 'first_response_at', now(),
    'first_response_hours', public.sla_elapsed_hours(t.created_at, now())
  );
end $$;
