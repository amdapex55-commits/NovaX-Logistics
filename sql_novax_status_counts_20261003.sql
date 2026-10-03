-- 3 Oct 2026: the admin Status Control Queue counts only parcels the page
-- loads (booked in the last 120 days). This returns the counts for parcels
-- booked BEFORE that window, so the page can add them and show all-time
-- totals. Old parcels rarely change status; recent ones stay live.
create or replace function public.admin_status_counts_before(p_before timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_object_agg(st, n) from (
      select case when status = 'Parcel returned to consignee' then 'Return to shipper' else status end as st, count(*) as n
        from public.parcels where booked_at < p_before group by 1
    ) x), '{}'::jsonb);
end $$;
revoke all on function public.admin_status_counts_before(timestamptz) from public, anon;
grant execute on function public.admin_status_counts_before(timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
