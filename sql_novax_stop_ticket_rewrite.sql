-- =====================================================================
-- NovaX -- stop rewriting every ticket every five minutes
--
-- One statement removed from sla_enforce_tick(). Everything else in the
-- function -- the escalations, the notifications, the auto-ticket loops --
-- is the deployed source verbatim.
--
-- AND a second, larger fault found while verifying the first: this function
-- has been ERRORING ON EVERY RUN. Three places referenced p.created_at on
-- public.parcels, which has no such column -- it is booked_at. Every five
-- minutes the cron did the 86,881 ticket updates, reached that reference,
-- and rolled the whole transaction back.
--
-- So the 25 million daily row updates were not merely pointless, they were
-- DISCARDED. n_tup_upd counts attempts, not commits, which is why the
-- counter reads 513 million while nothing was ever written. It is also the
-- source of the 11.6% transaction rollback rate and of roughly 288 failed
-- Postgres transactions per day in the dashboard.
--
-- It also means SLA escalation has never actually run to completion: the
-- escalations in 5a are rolled back with everything else.
--
-- Effect: 25,021,728 fewer row updates per day, and a cron job that commits.
--
-- Signature is unchanged and takes no arguments, so CREATE OR REPLACE
-- genuinely replaces rather than overloading.
-- =====================================================================

create or replace function public.sla_enforce_tick() RETURNS jsonb
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

  -- 5b. REMOVED 2026-08-25. This used to run, every five minutes:
  --
  --   update public.tickets t
  --      set meta = t.meta || jsonb_build_object('ageHours', ...)
  --    where t.status <> 'Resolved';
  --
  -- No row filter. All 86,881 tickets were unresolved, so every tick
  -- rewrote every one of them: 25,021,728 row updates per day, 513,772,987
  -- in total -- 5,914 rewrites per ticket. Each one rewrote the whole meta
  -- jsonb, so each was a full row rewrite feeding WAL, the backup stream and
  -- the realtime replication slot, and autovacuum ran continuously to keep up.
  --
  -- Its stated purpose was "so a browser that opens later shows the right
  -- clock". Both portals compute ticket age from created_at themselves
  -- (nvTkSla in client.html), and nothing in this database reads
  -- meta->>'ageHours' except ensure_ticket_from_issue, which takes the
  -- greatest of the stored value and one passed in as an argument. The
  -- column had no consumers.
  --
  -- Age is derivable from created_at at any instant. Storing a clock is
  -- what made this cost 25 million writes a day.

  -- 5c. Parcel transit breach: same rule as alertForParcel()=='critical'.
  -- NovaX fix (deploy blocker): parcels has no top-level `branch` column --
  -- the real value lives in meta->>'branch' (confirmed against admin.html's
  -- own row mapper). Referencing p.branch directly threw undefined_column
  -- and rolled back the whole function call, every 5 minutes, forever.
  for r in
    select p.id, p.awb, p.client_id, p.status, p.city,
           coalesce(p.meta->>'branch','') as branch, p.consignee,
           public.sla_elapsed_hours(coalesce(p.updated_at, p.booked_at), now()) as age
      from public.parcels p
     where coalesce(p.status,'') not in ('Delivered','Parcel returned to consignee','Cancelled')
       and public.sla_elapsed_hours(coalesce(p.updated_at, p.booked_at), now()) >= 72
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
           public.sla_elapsed_hours(coalesce(p.updated_at, p.booked_at), now()) as age
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

-- ---------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------
-- One signature only:
--   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' and p.proname='sla_enforce_tick';
--
-- The blanket update is gone (expect false):
--   select prosrc like '%where t.status <> ''Resolved'';%' from pg_proc
--   where proname='sla_enforce_tick';
--
-- And the write rate should flatten. Note n_tup_upd, wait 10 minutes
-- (two ticks), and compare:
--   select n_tup_upd from pg_stat_user_tables where relname='tickets';
