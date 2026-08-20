-- ============================================================================
-- NovaX daily operations report -> Google Sheet
--
-- Part 1  a status-change log written by a TRIGGER, not the browser
-- Part 2  the read-only report function the Sheet calls
--
-- Nothing here touches the portal. Run it once, top to bottom.
-- ============================================================================

-- ─────────────────────────── PART 1: THE STATUS LOG ─────────────────────────
-- 205 of 310 recently-touched parcels had no processHistory entry for their
-- current status, because the Order Processing scan desk goes through
-- admin_processing_update_status and replaces the row from the server rather
-- than calling setParcelStatus(). A trigger cannot be bypassed by any code
-- path -- admin, rider app, an RPC, or a manual UPDATE.

create table if not exists public.nv_parcel_status_log (
  id          bigserial primary key,
  parcel_id   uuid,
  awb         text,
  client_id   uuid,
  from_status text,
  to_status   text not null,
  changed_at  timestamptz not null default now()
);

create index if not exists idx_status_log_changed  on public.nv_parcel_status_log (changed_at desc);
create index if not exists idx_status_log_to       on public.nv_parcel_status_log (to_status, changed_at desc);
create index if not exists idx_status_log_parcel   on public.nv_parcel_status_log (parcel_id);

alter table public.nv_parcel_status_log enable row level security;
-- No policy: RLS on with none = denied to anon/authenticated. The report
-- function is SECURITY DEFINER and reads it regardless.

create or replace function public.nv_log_parcel_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at)
    values (NEW.id, NEW.awb, NEW.client_id, null, NEW.status, coalesce(NEW.booked_at, now()));
    return NEW;
  end if;
  if NEW.status is distinct from OLD.status then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at)
    values (NEW.id, NEW.awb, NEW.client_id, OLD.status, NEW.status, now());
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_parcel_status_log on public.parcels;
create trigger trg_parcel_status_log
  after insert or update of status on public.parcels
  for each row execute function public.nv_log_parcel_status();

-- ─────────────────────────── config + access token ──────────────────────────
create table if not exists public.nv_ops_report_config (
  id    int primary key default 1,
  token text not null,
  constraint nv_ops_report_single check (id = 1)
);
alter table public.nv_ops_report_config enable row level security;

-- CHANGE THIS STRING before running, and paste the same value into Apps Script.
insert into public.nv_ops_report_config (id, token)
values (1, 'CHANGE-ME-TO-A-LONG-RANDOM-STRING')
on conflict (id) do nothing;

-- ─────────────────────── PART 2: THE REPORT FUNCTION ────────────────────────
-- Aggregates only. No consignee names, phones or addresses -- even if the
-- sheet is shared onward there is no customer data in it.
--
-- Rules, exactly as specified:
--   picked    = the day a parcel was marked 'Arrived at warehouse', once
--   delivered = the day it was marked 'Delivered'
--   returned  = the day it was marked 'Return to shipper'
--   revenue   = parcels.fee, recognised at Delivered OR Return to shipper
--   cod       = parcels.cod_amount, from Delivered only
--   expenses  = NOT returned; Adnan types those into the sheet himself
-- All dates are Pakistan time (Asia/Karachi), not UTC.

create or replace function public.ops_daily_report(p_token text, p_days int default 60)
returns table (
  day               date,
  picked            int,
  delivered         int,
  returned          int,
  same_day          int,
  cod_collected     numeric,
  revenue_earned    numeric,
  parcels_in_hand   int,
  is_closed         boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  select exists(select 1 from public.nv_ops_report_config c
                where c.id = 1 and c.token = p_token) into v_ok;
  if not v_ok then raise exception 'Invalid report token.'; end if;

  return query
  with ev as (
    select l.parcel_id,
           l.to_status,
           (l.changed_at at time zone 'Asia/Karachi')::date as d
    from public.nv_parcel_status_log l
    where l.changed_at > now() - (p_days || ' days')::interval
  ),
  -- first time each parcel reached each milestone, so nothing counts twice
  firsts as (
    select parcel_id, to_status, min(d) as d
    from ev
    where to_status in ('Arrived at warehouse','Delivered','Return to shipper')
    group by 1,2
  ),
  days as (
    select generate_series(v_today - (p_days - 1), v_today, interval '1 day')::date as day
  ),
  picked as   (select d, count(*) n from firsts where to_status='Arrived at warehouse' group by 1),
  delivered as(select d, count(*) n from firsts where to_status='Delivered'            group by 1),
  returned as (select d, count(*) n from firsts where to_status='Return to shipper'    group by 1),
  sameday as (
    select p.d, count(*) n
    from firsts p
    join firsts dl on dl.parcel_id = p.parcel_id and dl.to_status='Delivered' and dl.d = p.d
    where p.to_status='Arrived at warehouse'
    group by 1
  ),
  money as (
    select f.d,
           sum(case when f.to_status='Delivered' then coalesce(pr.cod_amount,0) else 0 end) as cod,
           sum(coalesce(pr.fee,0))                                                          as fee
    from firsts f
    join public.parcels pr on pr.id = f.parcel_id
    where f.to_status in ('Delivered','Return to shipper')
    group by 1
  ),
  in_hand as (
    select count(*)::int n
    from public.parcels
    where status in ('Arrived at warehouse','Parcel now in transit',
                     'Parcel received at destination','Parcel out for delivery',
                     'Reattempt','Consignee not available','Refused',
                     'Ready for return','Return in transit','Return out for delivery')
  )
  select d.day,
         coalesce(p.n,0)::int,
         coalesce(dl.n,0)::int,
         coalesce(r.n,0)::int,
         coalesce(sd.n,0)::int,
         coalesce(m.cod,0),
         coalesce(m.fee,0),
         (select n from in_hand),
         (d.day < v_today)
  from days d
  left join picked p     on p.d  = d.day
  left join delivered dl on dl.d = d.day
  left join returned r   on r.d  = d.day
  left join sameday sd   on sd.d = d.day
  left join money m      on m.d  = d.day
  order by d.day desc;
end;
$$;

revoke all on function public.ops_daily_report(text, int) from public;
grant execute on function public.ops_daily_report(text, int) to anon, authenticated;

-- ─────────────────────────── verify ─────────────────────────────────────────
select * from public.ops_daily_report('CHANGE-ME-TO-A-LONG-RANDOM-STRING', 7);
