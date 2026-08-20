-- =====================================================================
-- NovaX AI — tools carried over from the retired autopilot brain.
-- Run after sql_novax_ai_core.sql. Same security model: every query is
-- filtered on nv_ai_my_client().
-- =====================================================================

-- Richer than ai_tool_list_parcels: filters by city, consignee name,
-- recency and staleness, not just status.
create or replace function public.ai_tool_search_parcels(
  p_status      text default null,
  p_city        text default null,
  p_consignee   text default null,
  p_days        integer default null,
  p_stale_hours integer default null,
  p_limit       integer default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; rows jsonb; n integer;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb), count(*) into rows, n
    from (
      select jsonb_build_object(
               'awb', p.awb, 'status', p.status, 'city', p.city,
               'consignee', p.consignee,
               'cod_amount', coalesce(p.cod_amount,0),
               'delivery_fee', coalesce(p.fee,0),
               'booked_at', p.booked_at,
               'hours_since_update',
                 round(extract(epoch from (now() - p.updated_at)) / 3600.0),
               'has_exception', coalesce(btrim(p.exception),'') <> '') as x
        from public.parcels p
       where p.client_id = c
         and (p_status    is null or p.status ilike p_status)
         and (p_city      is null or p.city ilike '%' || p_city || '%')
         and (p_consignee is null or p.consignee ilike '%' || p_consignee || '%')
         and (p_days      is null or p.booked_at >= now() - (p_days || ' days')::interval)
         and (p_stale_hours is null
              or p.updated_at <= now() - (p_stale_hours || ' hours')::interval)
       order by p.booked_at desc
       limit least(greatest(coalesce(p_limit,15),1), 25)
    ) s;

  return jsonb_build_object('count', n, 'parcels', rows);
end
$fn$;

-- Has this consignee refused or gone unreachable before? Checked before
-- advising reattempt vs return.
create or replace function public.ai_tool_consignee_history(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; digits text; rows jsonb; total int; deliv int; ref int; ret int;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  digits := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  if digits = '' then return jsonb_build_object('error','no_phone_given'); end if;

  select count(*),
         count(*) filter (where p.status = 'Delivered'),
         count(*) filter (where p.status = 'Refused'),
         count(*) filter (where p.status in ('Return to shipper',
                                             'Parcel returned to consignee'))
    into total, deliv, ref, ret
    from public.parcels p
   where p.client_id = c and p.phone like '%' || digits;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into rows
    from (
      select jsonb_build_object('awb', p.awb, 'status', p.status,
                                'city', p.city, 'booked_at', p.booked_at) as x
        from public.parcels p
       where p.client_id = c and p.phone like '%' || digits
       order by p.booked_at desc
       limit 8
    ) s;

  return jsonb_build_object(
    'total_parcels', total, 'delivered', deliv,
    'refused', ref, 'returned', ret, 'recent', rows);
end
$fn$;

grant execute on function public.ai_tool_search_parcels(text,text,text,integer,integer,integer) to authenticated;
grant execute on function public.ai_tool_consignee_history(text) to authenticated;
