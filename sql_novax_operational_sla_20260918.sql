-- NovaX operational SLA, 18 Sep 2026.
-- parcels.status_since is the only parcel SLA clock.
begin;

CREATE OR REPLACE FUNCTION public.sla_enforce_tick() RETURNS jsonb
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

  -- 5c. Operational parcel SLA. status_since is the only clock: unrelated
  -- parcel writes must never postpone a breach. No clock runs before warehouse
  -- arrival; warehouse/destination/OFD get 24h and intercity transit gets 72h.
  for r in
    select p.id, p.awb, p.client_id, p.status, p.city,
           coalesce(p.meta->>'branch','') as branch, p.consignee,
           public.sla_elapsed_hours(coalesce(p.status_since, p.booked_at), now()) as age,
           case when p.status = 'Parcel now in transit' then 72 else 24 end as stage_limit
      from public.parcels p
     where p.status in ('Arrived at warehouse','Parcel now in transit',
                        'Parcel received at destination','Parcel out for delivery')
       and public.sla_elapsed_hours(coalesce(p.status_since, p.booked_at), now()) >=
           case when p.status = 'Parcel now in transit' then 72 else 24 end
  loop
    v_new := public.ensure_ticket_from_issue(
      'parcel:' || r.awb || ':operational-sla', r.client_id,
      'Parcel stage SLA breached',
      r.awb || ' is breaching the ' || r.stage_limit::text || 'h SLA in '
        || coalesce(r.status,'unknown') || '. Current stage age: ' || round(r.age)::text || 'h.',
      'emergency', 'AI Status Clock',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub') || ' Manager',
      coalesce(nullif(r.branch,''), coalesce(r.city,'Destination') || ' Hub'),
      r.awb, r.age, true
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
           public.sla_elapsed_hours(coalesce(p.status_since, p.booked_at), now()) as age
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

commit;
