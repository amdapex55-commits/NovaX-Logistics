-- Stuck-parcel alerts (4 Oct 2026).
-- A parcel out for delivery, or waiting on a reattempt, for more than 48
-- hours is raised to Ops alerts as "Delayed over SLA: <AWB>" -- the same
-- problem key admin.html's exception queue uses, so the two never duplicate
-- each other (admin dedupes on `problem`). Until now these were only raised
-- while an admin tab happened to be open; the old sla_enforce_tick cron is
-- switched off (it once flooded tickets) and stays off.
-- One open alert per parcel; nv_ops_issues_autoclose() already closes
-- "Delayed over SLA" once the parcel is Delivered, returned or cancelled,
-- and this function closes its own alerts when the parcel moves on.

create or replace function public.nv_stuck_parcel_alerts()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_new int; v_closed int;
begin
  insert into public.operations_issues(branch, urgency, problem, awb, resolved, meta)
  select coalesce(nullif(p.meta->>'branch',''), coalesce(nullif(p.city,''),'Destination') || ' Hub'),
         'super urgent',
         'Delayed over SLA: ' || p.awb,
         p.awb, false,
         jsonb_build_object('exceptionType','Delayed over SLA','source','stuck-48h','statusAtAlert',p.status,
                            'openedHours', round(extract(epoch from now() - coalesce(p.status_since, p.updated_at))/3600))
    from public.parcels p
   where p.status in ('Parcel out for delivery','Reattempt')
     and coalesce(p.status_since, p.updated_at) < now() - interval '48 hours'
     and not exists (select 1 from public.operations_issues o
                      where o.resolved = false and o.problem = 'Delayed over SLA: ' || p.awb);
  get diagnostics v_new = row_count;

  update public.operations_issues o
     set resolved = true, resolved_at = to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
         resolved_by = 'Auto (condition cleared)',
         resolution_reason = 'Closed automatically: parcel is now ' || coalesce(p.status, 'gone'),
         meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('autoClosed', true, 'autoClosedAt', now()),
         updated_at = now()
    from public.parcels p
   where o.resolved = false and o.meta->>'source' = 'stuck-48h'
     and upper(p.awb) = upper(o.awb)
     and (p.status not in ('Parcel out for delivery','Reattempt')
          or coalesce(p.status_since, p.updated_at) >= now() - interval '48 hours');
  get diagnostics v_closed = row_count;
  return jsonb_build_object('raised', v_new, 'closed', v_closed);
end $$;

revoke all on function public.nv_stuck_parcel_alerts() from public, anon, authenticated;

select cron.unschedule('novax-stuck-parcels') where exists (select 1 from cron.job where jobname = 'novax-stuck-parcels');
select cron.schedule('novax-stuck-parcels', '37 * * * *', 'select public.nv_stuck_parcel_alerts();');
