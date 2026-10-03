-- 3 Oct 2026: operations alerts close themselves when their condition has
-- cleared. Alerts were only ever opened (by the admin page's exception
-- queue) and never closed when the parcel moved on: 995 of 1,170 open
-- alerts were on parcels already delivered.
-- Every row closed here carries meta.autoClosedBatch, so a batch can be
-- reopened:  update operations_issues set resolved=false, resolved_at=null,
--   resolved_by='', resolution_reason='' where meta->>'autoClosedBatch'='<id>';

create or replace function public.nv_ops_issues_autoclose()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch text := 'auto-' || to_char(now() at time zone 'Asia/Karachi', 'YYYYMMDD-HH24MI'); v_n int;
begin
  with c as (
    select o.id, p.status as st,
      case
        when p.id is null then 'the parcel no longer exists'
        when split_part(o.problem, ':', 1) = 'Unresolved ticket linked to AWB'
             and not exists (select 1 from public.novax_tickets t where upper(t.awb) = upper(o.awb) and t.status not in ('resolved', 'closed'))
          then 'no open ticket for this parcel'
        when split_part(o.problem, ':', 1) = 'Delayed over SLA' and p.status in ('Delivered', 'Return to shipper', 'Cancelled by client') then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Refused' and p.status <> 'Refused' then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Consignee not available' and p.status <> 'Consignee not available' then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Reattempt needed' and p.status <> 'Reattempt' then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Return pending'
             and p.status not in ('Ready for return', 'Return received at origin', 'Return out for delivery') then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Return in transit' and p.status <> 'Return in transit' then 'parcel is now ' || p.status
        when split_part(o.problem, ':', 1) = 'Proof missing'
             and (p.status <> 'Delivered'
                  or coalesce(p.meta->>'proofPhoto', '') <> '' or coalesce(p.meta->>'signature', '') <> ''
                  or jsonb_typeof(p.meta->'deliveryLocation') = 'object'
                  or coalesce(p.delivered_at, p.status_since, p.updated_at) < now() - interval '72 hours')
          then case when p.status <> 'Delivered' then 'parcel is now ' || p.status else 'delivered more than 72 hours ago or proof on file' end
        when split_part(o.problem, ':', 1) in ('Fake attempt / proof dispute', 'Rider cash holding', 'Client decision needed')
             and p.status in ('Delivered', 'Return to shipper', 'Cancelled by client') then 'parcel is now ' || p.status
      end as why
    from public.operations_issues o
    left join public.parcels p on upper(p.awb) = upper(o.awb)
    where o.resolved = false
  )
  update public.operations_issues o
     set resolved = true, resolved_at = to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
         resolved_by = 'Auto (condition cleared)', resolution_reason = 'Closed automatically: ' || c.why,
         meta = coalesce(o.meta, '{}'::jsonb) || jsonb_build_object('autoClosed', true, 'autoClosedBatch', v_batch, 'autoClosedAt', now()),
         updated_at = now()
    from c
   where c.id = o.id and c.why is not null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('closed', v_n, 'batch', v_batch);
end $$;
revoke all on function public.nv_ops_issues_autoclose() from public, anon, authenticated;
grant execute on function public.nv_ops_issues_autoclose() to service_role;

select cron.unschedule('novax-ops-autoclose') where exists (select 1 from cron.job where jobname = 'novax-ops-autoclose');
select cron.schedule('novax-ops-autoclose', '*/30 * * * *', 'select public.nv_ops_issues_autoclose();');
