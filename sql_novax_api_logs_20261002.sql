-- NovaX merchant API logs (2 Oct 2026).
-- nv_api_request_log took one row per call (~13,800 a day, almost all one
-- merchant polling). Errors stay as full rows (30 days, as before). Successful
-- calls stay as full rows for 24 hours -- admin_api_health and debugging read
-- that window -- then fold into hourly totals per key/route/method/status.
-- Also the index admin_api_health actually uses (key_id + time).

create index concurrently if not exists nv_api_request_log_key_time_idx
  on public.nv_api_request_log (key_id, created_at desc);

begin;

create table if not exists public.nv_api_request_hourly (
  hour timestamptz not null,
  key_id uuid,
  client_id uuid,
  route text not null,
  method text not null,
  status_code int not null,
  calls int not null,
  ms_sum bigint not null,
  ms_max int not null
);
create unique index if not exists nv_api_request_hourly_key
  on public.nv_api_request_hourly (hour, coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid), route, method, status_code);
alter table public.nv_api_request_hourly enable row level security;
revoke all on public.nv_api_request_hourly from public, anon, authenticated;

create or replace function public.nv_api_logs_rollup()
returns int language plpgsql security definer set search_path = '' as $$
declare v_cut timestamptz := date_trunc('hour', now() - interval '24 hours'); v int;
begin
  with moved as (
    delete from public.nv_api_request_log
     where created_at < v_cut and status_code < 400
    returning key_id, client_id, route, method, status_code, ms, created_at
  ), agg as (
    select date_trunc('hour', created_at) as hour, key_id, max(client_id::text)::uuid as client_id,
           regexp_replace(route, '^/orders/[^/]+(/cancel)?$', '/orders/:awb\1') as route, method, status_code,
           count(*)::int as calls, coalesce(sum(ms), 0)::bigint as ms_sum, coalesce(max(ms), 0)::int as ms_max
      from moved group by 1, 2, 4, 5, 6
  )
  insert into public.nv_api_request_hourly as h (hour, key_id, client_id, route, method, status_code, calls, ms_sum, ms_max)
  select hour, key_id, client_id, route, method, status_code, calls, ms_sum, ms_max from agg
  on conflict (hour, coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid), route, method, status_code)
  do update set calls = h.calls + excluded.calls, ms_sum = h.ms_sum + excluded.ms_sum, ms_max = greatest(h.ms_max, excluded.ms_max);
  get diagnostics v = row_count;
  delete from public.nv_api_request_hourly where hour < now() - interval '400 days';
  return v;
end $$;
revoke all on function public.nv_api_logs_rollup() from public, anon, authenticated;

commit;

select cron.schedule('novax-api-logs-rollup', '17 * * * *', 'select public.nv_api_logs_rollup()')
where not exists (select 1 from cron.job where jobname = 'novax-api-logs-rollup');
