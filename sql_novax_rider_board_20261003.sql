-- 3 Oct 2026: data and actions for the rebuilt admin rider screens
-- (Stations, Rider On Route, Rider Report, Rider Summary).
-- Cash handovers had no confirm step on the server: the old "Collect Cash"
-- button changed parcels in the browser and relied on a background save,
-- and Naveed's 22-23 Sep handovers were never confirmed.

alter table public.rider_cash_deposits
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid;

-- The same rule the admin page applies: blocked while undeposited
-- delivered COD (plus any cash held) is over the rider's limit.
create or replace function public.nv_rider_refresh_access(p_rider uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  update public.riders r
     set access = case when coalesce((r.meta->>'cashHeld')::numeric, 0)
                        + coalesce((select sum(p.cod_amount) from public.parcels p
                                     where p.rider_id = r.id and p.status = 'Delivered' and coalesce(p.cod_amount, 0) > 0
                                       and coalesce(p.meta->>'cashReceived', 'false') <> 'true'), 0)
                        > coalesce(r.cash_limit, 0) then 'Blocked' else 'Active' end
   where r.id = p_rider
  returning access into v;
  return v;
end $$;
revoke all on function public.nv_rider_refresh_access(uuid) from public, anon, authenticated;

create or replace function public.admin_rider_board(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days int := least(greatest(coalesce(p_days, 7), 1), 90);
  v_today timestamptz := (date_trunc('day', now() at time zone 'Asia/Karachi')) at time zone 'Asia/Karachi';
  v_from timestamptz;
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  v_from := v_today - make_interval(days => v_days - 1);
  return jsonb_build_object(
    'days', v_days, 'today_from', v_today, 'period_from', v_from,
    'riders', coalesce((
      select jsonb_agg(x order by x->>'name', x->>'branch') from (
        select jsonb_build_object(
          'id', r.id, 'name', r.name, 'branch', r.branch, 'phone', r.phone, 'cities', coalesce(to_jsonb(r.cities), '[]'::jsonb),
          'access', r.access, 'cash_limit', coalesce(r.cash_limit, 0),
          'cash_held', coalesce((r.meta->>'cashHeld')::numeric, 0),
          'login', (select pr.email from public.profiles pr where pr.rider_id = r.id order by pr.email limit 1),
          'out_now', coalesce((select jsonb_agg(jsonb_build_object('awb', p.awb, 'consignee', p.consignee, 'city', p.city,
                         'address', p.address, 'cod', p.cod_amount, 'status', p.status, 'since', p.status_since) order by p.status_since)
                       from public.parcels p where p.rider_id = r.id and p.status in ('Parcel out for delivery', 'Return out for delivery')), '[]'::jsonb),
          'today', (select jsonb_build_object(
                       'delivered', count(*) filter (where l.to_status = 'Delivered'),
                       'failed', count(*) filter (where l.to_status in ('Refused', 'Consignee not available', 'Reattempt')),
                       'cod', coalesce(sum(p.cod_amount) filter (where l.to_status = 'Delivered'), 0))
                     from public.nv_parcel_status_log l join public.parcels p on p.id = l.parcel_id
                    where p.rider_id = r.id and l.changed_at >= v_today),
          'period', (select jsonb_build_object(
                       'delivered', count(distinct l.parcel_id) filter (where l.to_status = 'Delivered'),
                       'failed', count(*) filter (where l.to_status in ('Refused', 'Consignee not available', 'Reattempt')),
                       'returned', count(distinct l.parcel_id) filter (where l.to_status = 'Return to shipper'),
                       'picked', count(distinct l.parcel_id) filter (where l.to_status = 'Collected by rider'),
                       'cod', coalesce(sum(p.cod_amount) filter (where l.to_status = 'Delivered'), 0))
                     from public.nv_parcel_status_log l join public.parcels p on p.id = l.parcel_id
                    where p.rider_id = r.id and l.changed_at >= v_from),
          'cash', jsonb_build_object(
            'holding', coalesce((select sum(p.cod_amount) from public.parcels p where p.rider_id = r.id and p.status = 'Delivered'
                          and coalesce(p.cod_amount, 0) > 0 and coalesce(p.meta->>'cashReceived', 'false') <> 'true'
                          and coalesce(p.meta->>'cashDepositStatus', '') <> 'pending_confirmation'), 0),
            'holding_n', (select count(*) from public.parcels p where p.rider_id = r.id and p.status = 'Delivered'
                          and coalesce(p.cod_amount, 0) > 0 and coalesce(p.meta->>'cashReceived', 'false') <> 'true'
                          and coalesce(p.meta->>'cashDepositStatus', '') <> 'pending_confirmation'),
            'oldest', (select min(p.delivered_at) from public.parcels p where p.rider_id = r.id and p.status = 'Delivered'
                          and coalesce(p.cod_amount, 0) > 0 and coalesce(p.meta->>'cashReceived', 'false') <> 'true'),
            'pending', coalesce((select jsonb_agg(jsonb_build_object('batch', d.batch_key, 'net', d.net, 'gross', d.gross,
                           'expenses', d.expenses, 'method', d.method, 'reference', d.reference, 'at', d.created_at,
                           'parcels', cardinality(d.parcel_ids)) order by d.created_at)
                         from public.rider_cash_deposits d
                        where d.rider_id = r.id and d.confirmed_at is null
                          and exists (select 1 from public.parcels p where p.id = any(d.parcel_ids)
                                       and p.meta->>'cashDepositStatus' = 'pending_confirmation'
                                       and coalesce(p.meta->>'cashReceived', 'false') <> 'true')), '[]'::jsonb),
            'confirmed_period', coalesce((select sum(d.net) from public.rider_cash_deposits d
                                          where d.rider_id = r.id and d.confirmed_at >= v_from), 0)),
          'last_scan', (select max(l.changed_at) from public.nv_parcel_status_log l join public.parcels p on p.id = l.parcel_id
                         where p.rider_id = r.id and l.changed_at > now() - interval '30 days'),
          'last_gps', (select jsonb_build_object('lat', p.meta->'deliveryLocation'->'lat', 'lng', p.meta->'deliveryLocation'->'lng',
                              'at', p.meta->'deliveryLocation'->>'at', 'awb', p.awb)
                         from public.parcels p
                        where p.rider_id = r.id and jsonb_typeof(p.meta->'deliveryLocation'->'lat') = 'number'
                          and p.delivered_at > now() - interval '14 days'
                        order by p.meta->'deliveryLocation'->>'at' desc nulls last limit 1)
        ) as x
        from public.riders r
      ) t), '[]'::jsonb));
end $$;
revoke all on function public.admin_rider_board(int) from public, anon;
grant execute on function public.admin_rider_board(int) to authenticated, service_role;

-- Confirm a handover the rider declared in the app, once the money is in.
create or replace function public.admin_confirm_rider_deposit(p_batch_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.rider_cash_deposits; v_n int; v_email text;
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  select * into d from public.rider_cash_deposits where batch_key = p_batch_key for update;
  if not found then raise exception 'That handover does not exist.'; end if;
  if d.confirmed_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'net', d.net, 'confirmed_at', d.confirmed_at);
  end if;
  select email into v_email from auth.users where id = auth.uid();
  update public.parcels p
     set meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object('cashReceived', true, 'cashDepositStatus', 'confirmed',
                  'cashConfirmedAt', now(), 'cashConfirmedBy', coalesce(v_email, 'admin'))
   where p.id = any(d.parcel_ids) and coalesce(p.meta->>'cashReceived', 'false') <> 'true';
  get diagnostics v_n = row_count;
  update public.rider_cash_deposits set confirmed_at = now(), confirmed_by = auth.uid() where batch_key = d.batch_key;
  return jsonb_build_object('ok', true, 'parcels', v_n, 'net', d.net, 'access', public.nv_rider_refresh_access(d.rider_id));
end $$;
revoke all on function public.admin_confirm_rider_deposit(text) from public, anon;
grant execute on function public.admin_confirm_rider_deposit(text) to authenticated, service_role;

-- Cash a rider hands in at the office without declaring it in the app.
create or replace function public.admin_collect_rider_cash(p_rider uuid, p_method text, p_reference text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; v_gross numeric; v_key text; v_email text; v_ref text := left(btrim(coalesce(p_reference, '')), 80);
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('Cash to office', 'Bank transfer', 'Easypaisa', 'JazzCash') then
    raise exception 'Choose how the cash was received.';
  end if;
  if p_method <> 'Cash to office' and length(v_ref) < 4 then
    raise exception 'Enter the transaction ID from the bank or wallet receipt.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:' || p_rider::text, 0));
  select array_agg(p.id order by p.id), coalesce(sum(p.cod_amount), 0) into ids, v_gross
    from public.parcels p
   where p.rider_id = p_rider and p.status = 'Delivered' and coalesce(p.cod_amount, 0) > 0
     and coalesce(p.meta->>'cashReceived', 'false') <> 'true'
     and coalesce(p.meta->>'cashDepositStatus', '') <> 'pending_confirmation';
  if ids is null then raise exception 'This rider is not holding any undeclared cash.'; end if;
  select email into v_email from auth.users where id = auth.uid();
  v_key := 'OFFICE-' || left(p_rider::text, 8) || '-' || (extract(epoch from clock_timestamp()) * 1000)::bigint;
  insert into public.rider_cash_deposits (batch_key, rider_id, gross, expenses, net, parcel_ids, method, reference, confirmed_at, confirmed_by)
  values (v_key, p_rider, v_gross, 0, v_gross, ids, p_method, nullif(v_ref, ''), now(), auth.uid());
  update public.parcels p
     set meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object('cashReceived', true, 'cashDepositStatus', 'confirmed',
                  'cashDepositBatchId', v_key, 'cashConfirmedAt', now(), 'cashConfirmedBy', coalesce(v_email, 'admin'))
   where p.id = any(ids);
  return jsonb_build_object('ok', true, 'batch', v_key, 'parcels', cardinality(ids), 'net', v_gross,
                            'access', public.nv_rider_refresh_access(p_rider));
end $$;
revoke all on function public.admin_collect_rider_cash(uuid, text, text) from public, anon;
grant execute on function public.admin_collect_rider_cash(uuid, text, text) to authenticated, service_role;

create or replace function public.admin_set_rider_limit(p_rider uuid, p_limit numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1000 or p_limit > 2000000 then raise exception 'Enter a cash limit between Rs 1,000 and Rs 20,00,000.'; end if;
  update public.riders set cash_limit = round(p_limit) where id = p_rider;
  if not found then raise exception 'That rider does not exist.'; end if;
  return jsonb_build_object('ok', true, 'access', public.nv_rider_refresh_access(p_rider));
end $$;
revoke all on function public.admin_set_rider_limit(uuid, numeric) from public, anon;
grant execute on function public.admin_set_rider_limit(uuid, numeric) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Add a rider to the roster from the admin page (their login is then made
-- in Users -> Create Users and linked to this row).
create or replace function public.admin_add_rider(p_name text, p_branch text, p_cities text[], p_phone text default '', p_limit numeric default 75000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_cities text[];
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if length(v_name) < 2 then raise exception 'Enter the rider''s name.'; end if;
  if coalesce(p_branch, '') not in ('Karachi Hub', 'Lahore Hub', 'Islamabad Hub', 'Rawalpindi Hub') then raise exception 'Choose the rider''s hub.'; end if;
  select coalesce(array_agg(distinct initcap(btrim(c))), '{}') into v_cities from unnest(coalesce(p_cities, '{}')) c
   where lower(btrim(c)) in ('karachi', 'lahore', 'islamabad', 'rawalpindi');
  if cardinality(v_cities) = 0 then raise exception 'Tick at least one city the rider covers.'; end if;
  if p_limit is null or p_limit < 1000 or p_limit > 2000000 then raise exception 'Enter a cash limit between Rs 1,000 and Rs 20,00,000.'; end if;
  insert into public.riders (name, phone, branch, access, cash_limit, cities, meta)
  values (v_name, btrim(coalesce(p_phone, '')), p_branch, 'Active', round(p_limit), v_cities,
          jsonb_build_object('manager', p_branch || ' Manager', 'cashHeld', 0))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.admin_add_rider(text, text, text[], text, numeric) from public, anon;
grant execute on function public.admin_add_rider(text, text, text[], text, numeric) to authenticated, service_role;
notify pgrst, 'reload schema';
