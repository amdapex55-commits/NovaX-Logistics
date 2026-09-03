-- ═══════════════════════════════════════════════════════════════════════════
-- NovaX — support desk repair, 3 Sep 2026
--   1. stop one action creating four identical tickets
--   2. support hours are 12:00–22:00 Asia/Karachi, and something finally reads them
--   3. one RPC so the portal can tell a merchant when they will get an answer
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. dedup at the source ────────────────────────────────────────────────
-- On 3 Sep a single re-attempt on N5640003 produced FOUR identical open
-- tickets for GenZee Creation at 20:14, none answered. The existing guard only
-- caps a merchant at 20 open tickets, which is an abuse limit, not deduping.
-- A merchant may legitimately open several tickets -- but not the same one, on
-- the same parcel, four times in one minute.
create or replace function public.novax_ticket_open(
  p_subject text, p_body text default ''::text,
  p_awb text default ''::text, p_priority text default 'normal'::text)
returns public.novax_tickets
language plpgsql security definer set search_path to 'public' as $function$
declare v_client uuid; v_row public.novax_tickets; v_name text; v_open int;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  if coalesce(btrim(p_subject),'') = '' then
    raise exception 'Please describe the issue in one line.';
  end if;

  -- Return the existing ticket rather than making another one. Deliberately
  -- silent: the merchant asked for help once and gets one ticket, which is
  -- what they expected. An error here would just look like a broken button.
  select * into v_row
    from public.novax_tickets
   where client_id = v_client
     and status <> 'resolved'
     and lower(btrim(subject)) = lower(btrim(p_subject))
     and coalesce(nullif(btrim(awb),''),'') = coalesce(nullif(btrim(p_awb),''),'')
     and created_at > now() - interval '10 minutes'
   order by created_at desc
   limit 1;
  if found then
    return v_row;
  end if;

  select count(*) into v_open from public.novax_tickets
   where client_id = v_client and status <> 'resolved';
  if v_open >= 20 then
    raise exception 'You already have 20 open tickets. Please wait for those to be answered first.';
  end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_tickets (client_id, awb, subject, body, priority, opened_by, opened_by_name)
  values (v_client, nullif(btrim(p_awb),''), btrim(p_subject),
          coalesce(btrim(p_body),''),
          case when p_priority in ('low','normal','high') then p_priority else 'normal' end,
          'client', coalesce(v_name,''))
  returning * into v_row;

  return v_row;
end $function$;

-- ── 2. the real hours: 12:00 to 22:00, Asia/Karachi ───────────────────────
update public.support_hours
   set is_24_7 = false, open_hour = 12, close_hour = 22,
       timezone = 'Asia/Karachi', work_days = '{1,2,3,4,5,6,7}',
       updated_at = now()
 where id = 1;

-- ── 3. one RPC the portal can ask "when will I get an answer?" ────────────
-- support_hours has existed since 27 Jul and NOTHING read it. The response
-- time is computed from real replies, not promised: a merchant told "about 15
-- minutes" and answered in 15 minutes trusts the next number they are given.
create or replace function public.nv_support_desk_meta()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_h public.support_hours%rowtype;
  v_now timestamptz := now();
  v_local timestamp;
  v_open boolean;
  v_median numeric;
  v_answered int;
begin
  select * into v_h from public.support_hours where id = 1;
  if not found then
    v_h.is_24_7 := true; v_h.open_hour := 0; v_h.close_hour := 24;
    v_h.timezone := 'Asia/Karachi'; v_h.work_days := '{1,2,3,4,5,6,7}';
  end if;

  v_local := v_now at time zone coalesce(v_h.timezone,'Asia/Karachi');
  v_open := coalesce(v_h.is_24_7,false)
            or ( extract(isodow from v_local)::int = any(coalesce(v_h.work_days,'{1,2,3,4,5,6,7}'))
                 and extract(hour from v_local)::int >= coalesce(v_h.open_hour,0)
                 and extract(hour from v_local)::int <  coalesce(v_h.close_hour,24) );

  select count(*),
         percentile_cont(0.5) within group (
           order by extract(epoch from (fr.first_reply - t.created_at))/60.0)
    into v_answered, v_median
    from public.novax_tickets t
    join lateral (select min(created_at) as first_reply
                    from public.novax_ticket_replies r where r.ticket_id = t.id) fr on true
   where fr.first_reply is not null
     and t.created_at > now() - interval '90 days';

  return jsonb_build_object(
    'open_now',        v_open,
    'is_24_7',         coalesce(v_h.is_24_7,false),
    'open_hour',       coalesce(v_h.open_hour,0),
    'close_hour',      coalesce(v_h.close_hour,24),
    'timezone',        coalesce(v_h.timezone,'Asia/Karachi'),
    'answered_count',  coalesce(v_answered,0),
    'median_minutes',  case when coalesce(v_answered,0) >= 5
                            then round(coalesce(v_median,0))::int else null end
  );
end $$;

revoke all on function public.nv_support_desk_meta() from public;
grant execute on function public.nv_support_desk_meta() to authenticated, service_role;
