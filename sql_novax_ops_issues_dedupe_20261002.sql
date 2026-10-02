-- NovaX: operations issues without the duplicate-insert rollbacks (2 Oct 2026).
-- The admin page loaded only the newest 2,000 issues, could not see older open
-- ones, re-created them on every refresh, and each attempt failed on
-- operations_issues_open_unique -- one rolled-back transaction per issue per
-- refresh. nv_ops_issue_open() adds an issue only if the same one is not
-- already open and returns the id either way, so nothing fails.
-- Stale alerts (whose condition no longer holds) are closed with a reason and
-- meta.autoClosed, so the change can be found and undone:
--   update operations_issues set resolved = false, resolved_by = '', resolution_reason = '', resolved_at = null,
--          meta = meta - 'autoClosed' where meta ? 'autoClosed';

begin;

create or replace function public.nv_ops_issue_open(p_row jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_problem text := coalesce(p_row->>'problem', ''); v_awb text := coalesce(p_row->>'awb', '');
begin
  if not public.is_staff_admin() then raise exception 'Only NovaX staff can do this.' using errcode = '42501'; end if;
  if coalesce((p_row->>'resolved')::boolean, false) then
    insert into public.operations_issues(branch, urgency, problem, awb, resolved, resolved_hours, resolved_by, resolution_reason, resolved_at, meta)
    values (p_row->>'branch', p_row->>'urgency', v_problem, v_awb, true, nullif(p_row->>'resolved_hours', '')::numeric,
            p_row->>'resolved_by', p_row->>'resolution_reason', p_row->>'resolved_at', coalesce(p_row->'meta', '{}'::jsonb))
    returning id into v;
    return v;
  end if;
  insert into public.operations_issues(branch, urgency, problem, awb, resolved, meta)
  values (p_row->>'branch', p_row->>'urgency', v_problem, v_awb, false, coalesce(p_row->'meta', '{}'::jsonb))
  on conflict (problem, awb) where not resolved do nothing
  returning id into v;
  if v is null then
    select o.id into v from public.operations_issues o where o.problem = v_problem and o.awb = v_awb and not o.resolved limit 1;
  end if;
  return v;
end $$;
revoke all on function public.nv_ops_issue_open(jsonb) from public, anon, authenticated;
grant execute on function public.nv_ops_issue_open(jsonb) to authenticated;

-- Close alerts whose condition no longer holds. Kept open: Proof missing on a
-- delivered parcel, tickets on existing parcels, disputes, and every alert
-- whose parcel is still in that state.
with stale as (
  select o.id, coalesce(p.status, '(parcel deleted)') as now_status
    from public.operations_issues o
    left join public.parcels p on p.awb = o.awb
   where not o.resolved
     and case split_part(o.problem, ':', 1)
           when 'Delayed over SLA' then p.id is null or p.status in ('Delivered', 'Return to shipper', 'Cancelled by client')
           when 'Refused' then p.id is null or p.status <> 'Refused'
           when 'Consignee not available' then p.id is null or p.status <> 'Consignee not available'
           when 'Reattempt needed' then p.id is null or p.status <> 'Reattempt'
           when 'Return pending' then p.id is null or p.status not in ('Ready for return', 'Return received at origin', 'Return out for delivery')
           when 'Proof missing' then p.id is null or p.status <> 'Delivered'
           when 'Unresolved ticket linked to AWB' then p.id is null
           else false end
)
update public.operations_issues o
   set resolved = true, resolved_by = 'System cleanup',
       resolution_reason = 'Auto-closed 2 Oct 2026: parcel is now ' || s.now_status || ', so this alert no longer applies.',
       resolved_at = to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
       meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('autoClosed', '2026-10-02'),
       updated_at = now()
  from stale s
 where s.id = o.id;

commit;
