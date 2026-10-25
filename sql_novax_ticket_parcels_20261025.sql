-- Admin Support → Tickets (25 Oct 2026): one compact parcel line under each
-- ticket that names an AWB -- status and since when, where it is (station or
-- the rider holding it), route, attempts, last rider note, next try, the
-- customer's latest answer on the tracking page, COD. Admin-only.
create or replace function public.admin_ticket_parcels(p_awbs text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(x.awb, x.info), '{}'::jsonb) from (
    select p.awb, jsonb_build_object(
      'status', p.status,
      'since', coalesce(p.status_since, p.updated_at),
      'origin', initcap(public.nv_parcel_origin(p)),
      'dest', initcap(public.nv_parcel_dest(p)),
      'rider', r.name, 'rider_phone', r.phone,
      'cod', p.cod_amount, 'fee', p.fee,
      'consignee', p.consignee, 'phone', p.phone,
      'attempts', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = 'Parcel out for delivery'),
      'note', coalesce(nullif(btrim(p.exception), ''), nullif(btrim(p.meta->>'lastAttemptReason'), '')),
      'next', p.meta->>'nextAttempt',
      'reply', (select jsonb_build_object('choice', c.choice, 'note', c.note, 'at', c.created_at)
                  from public.nv_customer_replies c where c.parcel_id = p.id order by c.created_at desc limit 1),
      'delivered_at', p.delivered_at) info
      from public.parcels p
      left join public.riders r on r.id = p.rider_id
     where public.is_staff_admin()
       and upper(p.awb) = any (select upper(btrim(a)) from unnest(coalesce(p_awbs, '{}')) a)
     limit 200) x;
$$;
revoke all on function public.admin_ticket_parcels(text[]) from public, anon;
grant execute on function public.admin_ticket_parcels(text[]) to authenticated;
