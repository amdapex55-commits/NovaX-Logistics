-- NovaX outreach attribution.
--
-- On 26 Aug 2026, 212 merchants were WhatsApped about the Claude Opus 5
-- assistant -- 166 who had signed up and never booked, 46 already active.
--
-- WHAT THIS CAN AND CANNOT SEE. There is no analytics on the site and no
-- Search Console, so opens, clicks and portal visits are invisible. This
-- reports OUTCOMES only: did someone book for the first time, did someone
-- start using the AI. That is a floor, not a ceiling -- a merchant who read
-- the message, visited, and did neither is counted as nothing.
--
-- The baseline matters more than the raw count. Across 1-24 Aug the business
-- produced roughly 0.75 first-time bookers a day, never more than 3. A day
-- with 1 proves nothing. A run of days at 4+ is the campaign working.

create or replace function public.nv_outreach_report(p_since date default '2026-08-26')
returns table(metric text, value text, note text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_base_days int;
  v_base_first int;
  v_base_rate numeric;
begin
  -- baseline: first-time bookers per day BEFORE the campaign
  select count(distinct (first_ever at time zone 'Asia/Karachi')::date),
         count(*)
    into v_base_days, v_base_first
  from (select client_id, min(booked_at) as first_ever
        from parcels where client_id is not null group by 1) f
  where (f.first_ever at time zone 'Asia/Karachi')::date < p_since
    and (f.first_ever at time zone 'Asia/Karachi')::date >= p_since - 30;

  v_base_rate := case when v_base_days > 0
                 then round(v_base_first::numeric / greatest(1,(p_since - (p_since - 30))), 2)
                 else 0 end;

  return query select 'campaign start'::text, p_since::text,
    'baseline was ' || v_base_rate || ' first-time bookers/day over the prior 30 days';

  -- THE number: merchants whose FIRST EVER parcel came after the campaign
  return query
  select 'first-ever bookings since'::text,
         count(*)::text,
         case when count(*) = 0 then 'nothing yet — too early, or the message did not land'
              when count(*)::numeric / greatest(1, (current_date - p_since) + 1) > v_base_rate * 2
                then 'ABOVE BASELINE — the campaign is doing something'
              else 'within normal range so far' end
  from (select client_id, min(booked_at) as first_ever
        from parcels where client_id is not null group by 1) f
  where (f.first_ever at time zone 'Asia/Karachi')::date >= p_since;

  -- who they are, so she can call them
  return query
  select 'activated merchant'::text,
         c.name,
         'first parcel ' || to_char(f.first_ever at time zone 'Asia/Karachi','DD Mon HH24:MI')
         || ' · signed up ' || to_char(c.created_at,'DD Mon')
  from (select client_id, min(booked_at) as first_ever
        from parcels where client_id is not null group by 1) f
  join clients c on c.id = f.client_id
  where (f.first_ever at time zone 'Asia/Karachi')::date >= p_since
  order by f.first_ever;

  -- AI adoption: the thing the message was actually about
  return query select 'merchants who have ever used the AI'::text,
    count(*)::text, 'was 6 on 26 Aug — anything above that is new'
  from nv_ai_usage;

  return query select 'AI messages since campaign'::text,
    count(*)::text, 'user messages only'
  from nv_ai_messages
  where role = 'user' and (created_at at time zone 'Asia/Karachi')::date >= p_since;

  -- volume, for context
  return query select 'parcels booked since'::text,
    count(*)::text, count(distinct client_id)::text || ' distinct merchants'
  from parcels where (booked_at at time zone 'Asia/Karachi')::date >= p_since;

  -- the cohort that was targeted hardest
  return query select 'never-booked cohort remaining'::text,
    count(*)::text, 'was 170 before the campaign'
  from clients c
  where c.id not in (select client_id from parcels where client_id is not null);

  -- and the honest health check: the AI must actually be answering
  return query select 'AI answering?'::text,
    case when max(created_at) > now() - interval '12 hours' then 'yes' else 'NO — CHECK CREDIT' end,
    'last assistant reply ' || coalesce(to_char(max(created_at) at time zone 'Asia/Karachi','DD Mon HH24:MI'),'never')
  from nv_ai_messages where role = 'assistant';
end;
$$;

revoke all on function public.nv_outreach_report(date) from public, anon;
grant execute on function public.nv_outreach_report(date) to authenticated;
