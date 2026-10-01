-- Live figures for the homepage (1 Oct 2026).
-- Aggregates only: no merchant, parcel, customer or amount below network level
-- leaves the database. Callable signed out, like public_reviews().
--   paid_out_total / payouts_paid : money that actually reached sellers' banks
--   delivered_total / delivered_30d : parcels delivered, by delivered_at
--     (updated_at moves on every later edit, so it overstated the 30 days)
begin;

create or replace function public.public_home_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'paid_out_total', coalesce((select round(sum(w.net)) from public.withdrawals w where w.status = 'Paid'), 0),
    'payouts_paid', (select count(*) from public.withdrawals w where w.status = 'Paid'),
    'delivered_total', (select count(*) from public.parcels p where p.status = 'Delivered'),
    'delivered_30d', (select count(*) from public.parcels p where p.status = 'Delivered'
                        and p.delivered_at > now() - interval '30 days'),
    'as_of', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'));
$$;
revoke all on function public.public_home_stats() from public, anon, authenticated, service_role;
grant execute on function public.public_home_stats() to anon, authenticated;

commit;
-- To take the figures off the internet again:
--   drop function public.public_home_stats();
