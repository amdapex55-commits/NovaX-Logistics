-- ============================================================================
-- Shared booking core, so the Shopify app can book without duplicating money
-- logic.
--
-- WHY THIS EXISTS
-- admin_book_parcel_for_client() starts with `if not public.is_admin()`. The
-- Shopify webhook arrives with no user at all -- it is the service role acting
-- on a merchant's behalf -- so that guard can never pass, and it should not:
-- loosening it would let anything holding the service key book parcels as an
-- admin.
--
-- The alternative was copying the AWB sequence, the rate-card lookup and the
-- fee formula into a second function. Two copies of fee logic drift, and the
-- drift shows up as merchants being charged different amounts for the same
-- parcel depending on which door it came through. So instead: one core, two
-- thin guarded callers.
--
-- SAFETY
-- This REPLACES a live function that prices money. The pre-flight below aborts
-- if production has drifted from backend/admin.sql, because in that case this
-- file's copy of the body is stale and running it would silently revert
-- whatever changed. Nothing is modified unless all five checks pass.
--
-- Run sql_novax_shopify_app.sql BEFORE this file.
-- ============================================================================

do $preflight$
declare
  v_def text;
  v_missing text[] := '{}';
  v_needle text;
  v_needles text[] := array[
    'v_awb := v_prefix || lpad((v_max + 1)::text, 4, ''0'')',
    'v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1))',
    'v_fee := v_base + (v_extra_kg * v_addl_rate)',
    '''totalStages'', 16',
    'insert into public.parcel_admin_audit'
  ];
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_book_parcel_for_client';

  if v_def is null then
    raise exception 'PRE-FLIGHT FAILED: admin_book_parcel_for_client does not exist.';
  end if;

  foreach v_needle in array v_needles loop
    if position(v_needle in v_def) = 0 then
      v_missing := v_missing || v_needle;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception E'PRE-FLIGHT FAILED: production has drifted from backend/admin.sql.\nMissing: %\nDo NOT run this file. Re-dump the function first and rebuild the core from the live body.',
      array_to_string(v_missing, ' | ');
  end if;

  raise notice 'pre-flight OK: live function matches the dump on all 5 load-bearing lines';
end;
$preflight$;

-- --------------------------------------------------------------- core -------
-- Body copied verbatim from admin_book_parcel_for_client, with exactly two
-- changes: the is_admin() guard is gone (each caller does its own), and the
-- two values that describe WHO booked are parameters instead of literals.
create or replace function public.nv_book_parcel_core(
  p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text,
  p_city text, p_address text, p_cod numeric, p_weight text, p_service text,
  p_category text, p_fragile text, p_payment_mode text,
  p_order_id text default '', p_reference_no text default '',
  p_source text default 'admin_portal', p_actor_role text default 'admin'
) returns public.parcels
  language plpgsql security definer set search_path to 'public' as $core$
declare
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
begin
  if p_client_id is null then
    raise exception 'Select a client first.';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'That client does not exist.';
  end if;
  if coalesce(btrim(p_consignee), '') = '' then
    raise exception 'Consignee name is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || p_client_id::text));

  v_code   := lpad(right(regexp_replace(p_client_id::text, '\D', '', 'g'), 3), 3, '0');
  v_prefix := 'N' || v_code;

  select coalesce(max(substring(pa.awb from length(v_prefix) + 1)::int), 0)
    into v_max
    from public.parcels pa
   where pa.awb ~ ('^' || v_prefix || '[0-9]+$');

  v_awb := v_prefix || lpad((v_max + 1)::text, 4, '0');

  select c.rate, c.rate_card into v_rate, v_rate_card from public.clients c where c.id = p_client_id;
  v_rate := coalesce(v_rate, 250);
  v_zone := case when lower(coalesce(p_city, '')) = 'karachi' then 'A' else 'B' end;

  if v_rate_card is not null and jsonb_typeof(v_rate_card -> v_zone) = 'object' then
    v_base      := coalesce((v_rate_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_rate_card is not null and (v_rate_card ->> 'overnight') is not null then
    v_base      := coalesce((v_rate_card ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card ->> 'additionalKg')::numeric, 85);
  else
    v_base := v_rate; v_addl_rate := 85;
  end if;

  v_weight_kg := coalesce(nullif(regexp_replace(coalesce(p_weight, ''), '[^0-9.]', '', 'g'), '')::numeric, 0.8);
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;
  v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_fee := v_base + (v_extra_kg * v_addl_rate);

  v_meta := jsonb_build_object(
    'source', p_source,
    'bookedByAdmin', (p_actor_role = 'admin'),
    'pickupCity', coalesce(p_pickup_city, ''),
    'service', coalesce(p_service, ''),
    'category', coalesce(p_category, ''),
    'fragile', coalesce(p_fragile, 'No'),
    'weight', coalesce(p_weight, '0.8 kg'),
    'paymentMode', coalesce(p_payment_mode, 'COD'),
    'orderId', coalesce(p_order_id, ''),
    'referenceNo', coalesce(p_reference_no, ''),
    'branch', coalesce(nullif(btrim(p_pickup_city), ''), 'Karachi') || ' Hub',
    'stage', 0,
    'totalStages', 16,
    'steps', jsonb_build_array('New booked'),
    'statusSince', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.parcels (
    awb, client_id, consignee, phone, address, city, status,
    cod_amount, fee, booked_at, updated_at, meta
  ) values (
    v_awb, p_client_id, btrim(p_consignee), coalesce(p_phone, ''), coalesce(p_address, ''),
    coalesce(p_city, ''), 'New booked', coalesce(p_cod, 0), v_fee, v_now, v_now, v_meta
  )
  returning * into v_row;

  insert into public.parcel_admin_audit (awb, client_id, action, changes, actor_id, actor_role)
  values (v_awb, p_client_id,
          case when p_actor_role = 'admin' then 'admin_booked' else 'shopify_booked' end,
          jsonb_build_object('cod', coalesce(p_cod,0), 'fee', v_fee,
                             'city', coalesce(p_city,''), 'source', p_source),
          auth.uid(), p_actor_role);

  return v_row;
end;
$core$;

revoke all on function public.nv_book_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text)
  from anon, authenticated;

-- ------------------------------------------- caller 1: the admin portal -----
-- Same signature, same guard, same behaviour as before. Only the body moved.
create or replace function public.admin_book_parcel_for_client(
  p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text,
  p_city text, p_address text, p_cod numeric, p_weight text, p_service text,
  p_category text, p_fragile text, p_payment_mode text,
  p_order_id text default '', p_reference_no text default ''
) returns public.parcels
  language plpgsql security definer set search_path to 'public' as $admin$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return public.nv_book_parcel_core(
    p_client_id, p_consignee, p_phone, p_pickup_city, p_city, p_address,
    p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_id, p_reference_no, 'admin_portal', 'admin');
end;
$admin$;

-- ------------------------------------------- caller 2: the Shopify app ------
-- Guarded differently: there is no user, so the guard is that the shop must be
-- installed, active, and linked to a NovaX merchant. An unlinked shop cannot
-- book -- its orders wait in nvsh_order until an admin links it.
create or replace function public.nvsh_book_parcel(
  p_shop text, p_consignee text, p_phone text, p_city text, p_address text,
  p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_id text, p_reference_no text
) returns public.parcels
  language plpgsql security definer set search_path to 'public' as $shop$
declare
  v_client uuid; v_status text; v_pickup text;
begin
  select s.client_id, s.status, coalesce(nullif(btrim(c.city), ''), 'Karachi')
    into v_client, v_status, v_pickup
    from public.nvsh_shop s
    left join public.clients c on c.id = s.client_id
   where s.shop_domain = p_shop;

  if v_client is null then
    raise exception 'shop % is not linked to a NovaX merchant', p_shop;
  end if;
  if v_status <> 'active' then
    raise exception 'shop % is %, not active', p_shop, v_status;
  end if;

  return public.nv_book_parcel_core(
    v_client, p_consignee, p_phone, v_pickup, p_city, p_address,
    p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode,
    p_order_id, p_reference_no, 'shopify_app', 'shopify');
end;
$shop$;

revoke all on function public.nvsh_book_parcel(text,text,text,text,text,numeric,text,text,text,text,text,text,text)
  from anon, authenticated;

select 'booking core installed' as result,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname in
           ('nv_book_parcel_core','admin_book_parcel_for_client','nvsh_book_parcel')) as functions;
