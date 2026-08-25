-- =====================================================================
-- NovaX backend -- admin
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 42 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.admin_ai_quota_decide(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare is_admin boolean; req public.nv_ai_quota_requests%rowtype;
begin
  select exists(select 1 from public.profiles p
                 where p.id = auth.uid()
                   and lower(p.role::text) in ('admin','owner')) into is_admin;
  if not is_admin then
    raise exception 'admin access required to decide AI quota requests';
  end if;

  select * into req from public.nv_ai_quota_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if req.status <> 'pending' then
    return jsonb_build_object('ok',false,'reason','already_decided','status',req.status);
  end if;

  update public.nv_ai_quota_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_at = now(), decided_by = auth.uid(),
         admin_note = nullif(btrim(coalesce(p_note,'')),'')
   where id = p_request_id;

  if p_approve then
    update public.nv_ai_usage
       set used = 0, cycle_started = now(),
           last_reset_by = auth.uid(), last_reset_at = now()
     where client_id = req.client_id;
  end if;

  return jsonb_build_object('ok',true,'approved',p_approve,'client_id',req.client_id);
end
$$;

CREATE FUNCTION public.admin_ai_quota_pending() RETURNS TABLE(id uuid, client_id uuid, client_name text, reason text, requested_at timestamp with time zone, used integer, cap integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select r.id, r.client_id, c.name, r.reason, r.requested_at,
         coalesce(u.used,0), coalesce(u.cap,50)
    from public.nv_ai_quota_requests r
    left join public.clients c on c.id = r.client_id
    left join public.nv_ai_usage u on u.client_id = r.client_id
   where r.status = 'pending'
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid()
                    and lower(p.role::text) in ('admin','owner','staff'))
   order by r.requested_at asc;
$$;

CREATE FUNCTION public.admin_book_parcel_for_client(p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text) RETURNS public.parcels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
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
    'source', 'admin_portal',
    'bookedByAdmin', true,
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
  values (v_awb, p_client_id, 'admin_booked',
          jsonb_build_object('cod', coalesce(p_cod,0), 'fee', v_fee, 'city', coalesce(p_city,'')),
          auth.uid(), 'admin');

  return v_row;
end;
$_$;

CREATE FUNCTION public.admin_cancel_invoice(p_invoice_id uuid) RETURNS public.invoices
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_invoice public.invoices;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice is null then
    raise exception 'Invoice not found.';
  end if;
  if v_invoice.status <> 'Generated' then
    raise exception 'Invoice % can only be cancelled while still Generated (not yet pushed to wallet or closed).', v_invoice.code;
  end if;
  update public.parcels set invoice_id = null, invoiced_at = null where invoice_id = p_invoice_id;
  update public.invoices set status = 'Cancelled' where id = p_invoice_id returning * into v_invoice;
  return v_invoice;
end;
$$;

CREATE FUNCTION public.admin_client_due_detail(p_client_id uuid) RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, due_amount numeric, status text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select i.id, coalesce(i.code, ''), coalesce(i.invoice_type, ''),
           coalesce(i.due_to_novax, 0), coalesce(i.status, ''), i.created_at
      from public.invoices i
     where i.client_id = p_client_id
       and coalesce(i.due_to_novax, 0) > 0
       and coalesce(lower(i.status), '') not in ('deleted', 'cancelled', 'canceled')
     order by i.created_at desc;
end;
$$;

CREATE FUNCTION public.admin_client_due_payments(p_client_id uuid) RETURNS TABLE(id uuid, amount numeric, method text, reference text, note text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  return query
    select p.id, p.amount, p.method, p.reference, p.note, p.created_at
      from public.client_due_payments p
     where p.client_id = p_client_id
     order by p.created_at desc;
end;
$$;

CREATE FUNCTION public.admin_generate_invoice(p_client_id uuid, p_awbs text[]) RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, net_payable numeric, due_to_novax numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_base_code text;
  v_cod_id uuid;
  v_due_id uuid;
  v_cod_count int;
  v_due_count int;
  v_cod_total numeric;
  v_cod_fee numeric;
  v_due_fee numeric;
  v_payable numeric;
  v_due numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null then
    raise exception 'Client is required.';
  end if;
  if p_awbs is null or array_length(p_awbs, 1) is null then
    raise exception 'Select at least one delivered parcel to invoice.';
  end if;

  perform 1 from public.parcels
    where client_id = p_client_id and awb = any(p_awbs)
    for update;

  select
    count(*) filter (where coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),
    count(*) filter (where coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'),
    coalesce(sum(p.cod_amount) filter (where coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'), 0),
    coalesce(sum(p.fee) filter (where coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'), 0),
    coalesce(sum(p.fee) filter (where coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'), 0)
  into v_cod_count, v_due_count, v_cod_total, v_cod_fee, v_due_fee
  from public.parcels p
  where p.client_id = p_client_id
    and p.awb = any(p_awbs)
    and p.invoice_id is null
    and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb);

  if coalesce(v_cod_count,0) = 0 and coalesce(v_due_count,0) = 0 then
    raise exception 'None of the selected parcels are delivered and un-invoiced.';
  end if;

  v_payable := greatest(0, v_cod_total - v_cod_fee);
  v_due := v_due_fee;
  v_base_code := 'INV-' || to_char(now(), 'YYMMDD') || substr(replace(gen_random_uuid()::text,'-',''),1,5);

  if v_cod_count > 0 and v_due_count > 0 then
    insert into public.invoices (code, client_id, parcel_refs, cod_total, fee_total, net_payable, due_to_novax, invoice_type, status)
    select v_base_code || '-A', p_client_id, coalesce(jsonb_agg(p.awb), '[]'::jsonb), v_cod_total, v_cod_fee, v_payable, 0, 'COD Settlement', 'Generated'
    from public.parcels p
    where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
      and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
      and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'
    returning id into v_cod_id;

    insert into public.invoices (code, client_id, parcel_refs, cod_total, fee_total, net_payable, due_to_novax, invoice_type, status)
    select v_base_code || '-B', p_client_id, coalesce(jsonb_agg(p.awb), '[]'::jsonb), 0, v_due_fee, 0, v_due, 'Delivery Charges', 'Generated'
    from public.parcels p
    where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
      and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
      and coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'
    returning id into v_due_id;

    update public.parcels p set invoice_id = v_cod_id, invoiced_at = now()
      where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
        and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
        and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid';

    update public.parcels p set invoice_id = v_due_id, invoiced_at = now()
      where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
        and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
        and coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid';

    return query
      select v_cod_id, v_base_code || '-A', 'COD Settlement'::text, v_payable, 0::numeric
      union all
      select v_due_id, v_base_code || '-B', 'Delivery Charges'::text, 0::numeric, v_due;
    return;
  elsif v_due_count > 0 then
    insert into public.invoices (code, client_id, parcel_refs, cod_total, fee_total, net_payable, due_to_novax, invoice_type, status)
    select v_base_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb), 0, v_due_fee, 0, v_due, 'Delivery Charges', 'Generated'
    from public.parcels p
    where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
      and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
    returning id into v_due_id;
    update public.parcels p set invoice_id = v_due_id, invoiced_at = now()
      where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
        and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb);
    return query select v_due_id, v_base_code, 'Delivery Charges'::text, 0::numeric, v_due;
    return;
  else
    insert into public.invoices (code, client_id, parcel_refs, cod_total, fee_total, net_payable, due_to_novax, invoice_type, status)
    select v_base_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb), v_cod_total, v_cod_fee, v_payable, 0, 'COD Settlement', 'Generated'
    from public.parcels p
    where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
      and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb)
    returning id into v_cod_id;
    update public.parcels p set invoice_id = v_cod_id, invoiced_at = now()
      where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
        and (p.status = 'Delivered' or (p.meta->'steps') @> '"COD collected"'::jsonb);
    return query select v_cod_id, v_base_code, 'COD Settlement'::text, v_payable, 0::numeric;
    return;
  end if;
end;
$$;

CREATE FUNCTION public.admin_generate_invoice_v2(p_client_id uuid, p_awbs text[], p_net_returns boolean DEFAULT true) RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, cod_total numeric, fee_total numeric, net_payable numeric, due_to_novax numeric, return_count integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_cod_total  numeric := 0;   -- COD collected on delivered COD parcels
  v_cod_fee    numeric := 0;   -- delivery charges on those
  v_due_fee    numeric := 0;   -- charges owed: prepaid deliveries + returns
  v_ret_fee    numeric := 0;   -- of which, returns
  v_cod_count  int := 0;
  v_ret_count  int := 0;
  v_due_count  int := 0;
  v_payable    numeric := 0;
  v_due        numeric := 0;
  v_code       text;
  v_type       text;
  v_id         uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null or p_awbs is null or array_length(p_awbs,1) is null then
    raise exception 'Select a client and at least one parcel.';
  end if;

  -- Lock the rows so two admins cannot invoice the same parcels at once.
  perform 1 from public.parcels
   where client_id = p_client_id and awb = any(p_awbs) for update;

  select
    count(*) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),
    count(*) filter (where public.is_return_chargeable(p.status)),
    count(*) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'),
    coalesce(sum(p.cod_amount) filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),0),
    coalesce(sum(p.fee)        filter (where not public.is_return_chargeable(p.status)
                       and coalesce(p.meta->>'paymentMode','') !~* 'non\s*cod|prepaid'),0),
    coalesce(sum(p.fee)        filter (where public.is_return_chargeable(p.status)),0),
    coalesce(sum(p.fee)        filter (where public.is_return_chargeable(p.status)
                       or coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid'),0)
    into v_cod_count, v_ret_count, v_due_count,
         v_cod_total, v_cod_fee, v_ret_fee, v_due_fee
    from public.parcels p
   where p.client_id = p_client_id
     and p.awb = any(p_awbs)
     and p.invoice_id is null
     and (
       p.status = 'Delivered'
       or (p.meta->'steps') @> '"COD collected"'::jsonb
       or public.is_return_chargeable(p.status)
     );

  if coalesce(v_cod_count,0) + coalesce(v_ret_count,0) + coalesce(v_due_count,0) = 0 then
    raise exception 'None of the selected parcels are invoice-eligible (or they are already invoiced).';
  end if;

  v_code := 'INV-' || to_char(now(),'YYMMDD') || substr(replace(gen_random_uuid()::text,'-',''),1,5);

  if p_net_returns then
    -- ONE netted invoice: COD minus its own charges minus return/prepaid charges.
    v_payable := greatest(0, v_cod_total - v_cod_fee - v_due_fee);
    -- Whatever the COD could not absorb stays owed, and surfaces in the
    -- Negative Accounts pool rather than being written off silently.
    v_due     := greatest(0, v_due_fee - greatest(0, v_cod_total - v_cod_fee));
    v_type    := case
                   when v_cod_count = 0 then 'Delivery Charges'
                   when v_ret_count > 0 or v_due_count > 0 then 'Mixed'
                   else 'COD Settlement'
                 end;

    insert into public.invoices (
      code, client_id, parcel_refs, cod_total, fee_total,
      net_payable, due_to_novax, invoice_type, status, meta
    )
    select v_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb),
           v_cod_total, v_cod_fee + v_due_fee, v_payable, v_due, v_type, 'Generated',
           jsonb_build_object(
             'returnCount',   v_ret_count,
             'returnCharges', v_ret_fee,
             'prepaidCharges', v_due_fee - v_ret_fee,
             'nettedReturns', true
           )
      from public.parcels p
     where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
       and (p.status = 'Delivered'
            or (p.meta->'steps') @> '"COD collected"'::jsonb
            or public.is_return_chargeable(p.status))
    returning id into v_id;

    update public.parcels p
       set invoice_id = v_id, invoiced_at = now()
     where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
       and (p.status = 'Delivered'
            or (p.meta->'steps') @> '"COD collected"'::jsonb
            or public.is_return_chargeable(p.status));

    return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                        v_payable, v_due, v_ret_count;
    return;
  end if;

  -- Not netting: single Delivery Charges invoice for the returns/prepaid only.
  v_payable := greatest(0, v_cod_total - v_cod_fee);
  v_due     := v_due_fee;
  v_type    := case when v_cod_count = 0 then 'Delivery Charges' else 'Mixed' end;

  insert into public.invoices (
    code, client_id, parcel_refs, cod_total, fee_total,
    net_payable, due_to_novax, invoice_type, status, meta
  )
  select v_code, p_client_id, coalesce(jsonb_agg(p.awb),'[]'::jsonb),
         v_cod_total, v_cod_fee + v_due_fee, v_payable, v_due, v_type, 'Generated',
         jsonb_build_object('returnCount', v_ret_count, 'returnCharges', v_ret_fee,
                            'nettedReturns', false)
    from public.parcels p
   where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
     and (p.status = 'Delivered'
          or (p.meta->'steps') @> '"COD collected"'::jsonb
          or public.is_return_chargeable(p.status))
  returning id into v_id;

  update public.parcels p
     set invoice_id = v_id, invoiced_at = now()
   where p.client_id = p_client_id and p.awb = any(p_awbs) and p.invoice_id is null
     and (p.status = 'Delivered'
          or (p.meta->'steps') @> '"COD collected"'::jsonb
          or public.is_return_chargeable(p.status));

  return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                      v_payable, v_due, v_ret_count;
end;
$$;

CREATE FUNCTION public.admin_generate_shopify_link(p_client_id uuid, p_store_domain text DEFAULT NULL::text) RETURNS TABLE(intake_token text, has_secret boolean, store_url text, disabled boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_intake_token text;
  v_secret text;
  v_store_url text;
  v_disabled boolean;
begin
  if not is_admin() then
    raise exception 'Only admins can configure store integrations.';
  end if;
  if p_client_id is null then
    raise exception 'Client is required.';
  end if;

  select s.intake_token, s.consumer_secret, s.store_url, s.disabled
    into v_intake_token, v_secret, v_store_url, v_disabled
    from public.store_secrets s where s.client_id = p_client_id and s.platform = 'shopify';

  if v_intake_token is null then
    v_intake_token := encode(extensions.gen_random_bytes(24), 'hex');
    v_store_url := coalesce(trim(p_store_domain), '');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (p_client_id, 'shopify', v_store_url, '', '', encode(extensions.gen_random_bytes(32), 'hex'), v_intake_token);
    v_secret := '';
    v_disabled := false;
  elsif p_store_domain is not null and length(trim(p_store_domain)) > 0 then
    update public.store_secrets set store_url = trim(p_store_domain), updated_at = now()
      where client_id = p_client_id and platform = 'shopify';
    v_store_url := trim(p_store_domain);
  end if;

  return query select v_intake_token, (v_secret is not null and length(v_secret) > 0), coalesce(v_store_url, ''), coalesce(v_disabled, false);
end;
$$;

CREATE FUNCTION public.admin_invoiceable_parcels(p_client_id uuid) RETURNS TABLE(awb text, consignee text, city text, status text, cod_amount numeric, fee numeric, kind text, booked_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select p.awb, coalesce(p.consignee,''), coalesce(p.city,''), p.status,
           coalesce(p.cod_amount,0), coalesce(p.fee,0),
           case
             when public.is_return_chargeable(p.status) then 'return'
             when coalesce(p.meta->>'paymentMode','') ~* 'non\s*cod|prepaid' then 'prepaid'
             else 'cod'
           end,
           p.booked_at
      from public.parcels p
     where p.client_id = p_client_id
       and p.invoice_id is null
       and (
         p.status = 'Delivered'
         or (p.meta->'steps') @> '"COD collected"'::jsonb
         or public.is_return_chargeable(p.status)
       )
     order by p.booked_at desc;
end;
$$;

CREATE FUNCTION public.admin_list_client_dues() RETURNS TABLE(client_id uuid, client_name text, due_invoiced numeric, due_paid numeric, outstanding numeric, due_invoice_count integer, oldest_due_at timestamp with time zone, oldest_due_age_days integer, last_payment_at timestamp with time zone, wallet_balance numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select s.client_id, s.client_name, s.due_invoiced, s.due_paid, s.outstanding,
           s.due_invoice_count::int, s.oldest_due_at, s.oldest_due_age_days,
           s.last_payment_at, s.wallet_balance
      from public.client_dues_summary s
     where s.outstanding <> 0
     order by s.outstanding desc, s.oldest_due_at asc nulls last;
end;
$$;

CREATE FUNCTION public.admin_list_error_logs(p_limit integer DEFAULT 200) RETURNS SETOF public.portal_error_logs
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select * from public.portal_error_logs
  where public.is_staff_admin()
  order by created_at desc
  limit greatest(1, coalesce(p_limit, 200));
$$;

CREATE FUNCTION public.admin_list_notifications(p_status text DEFAULT NULL::text, p_channel text DEFAULT NULL::text, p_client_id uuid DEFAULT NULL::uuid, p_awb text DEFAULT NULL::text, p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, client_id uuid, client_name text, awb text, channel text, event_type text, recipient text, status text, payload jsonb, error text, created_at timestamp with time zone, sent_at timestamp with time zone, retry_count integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select n.id, n.client_id, c.name, n.awb, n.channel, n.event_type, n.recipient,
         n.status, n.payload, n.error, n.created_at, n.sent_at, n.retry_count
  from public.notification_events n
  left join public.clients c on c.id = n.client_id
  where public.is_staff_admin()
    and (p_status is null or n.status = p_status)
    and (p_channel is null or n.channel = p_channel)
    and (p_client_id is null or n.client_id = p_client_id)
    and (p_awb is null or n.awb = p_awb)
  order by n.created_at desc
  limit greatest(1, coalesce(p_limit, 200));
$$;

CREATE FUNCTION public.admin_list_reviews() RETURNS TABLE(id uuid, client_id uuid, client_name text, rating integer, comment text, status text, display_name text, created_at timestamp with time zone, reviewed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then raise exception 'Admin access required.'; end if;

  return query
  select r.id, r.client_id, c.name, r.rating, r.comment,
         r.status, r.display_name, r.created_at, r.reviewed_at
  from public.reviews r
  left join public.clients c on c.id = r.client_id
  order by (r.status = 'pending') desc, r.created_at desc;
end; $$;

CREATE FUNCTION public.admin_list_shopify_connections() RETURNS TABLE(client_id uuid, client_name text, store_url text, intake_token text, has_secret boolean, has_admin_token boolean, disabled boolean, last_order_at timestamp with time zone, last_order_awb text, last_signature_fail_at timestamp with time zone, last_error text, last_event text, imported_count integer, connection_status text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not is_admin() then
    raise exception 'Only admins can view store integrations.';
  end if;

  return query
    select s.client_id,
           coalesce(c.name, s.client_id::text),
           coalesce(s.store_url, ''),
           s.intake_token,
           (s.consumer_secret is not null and length(s.consumer_secret) > 0),
           (s.consumer_key is not null and length(s.consumer_key) > 0),
           s.disabled,
           s.last_order_at,
           s.last_order_awb,
           s.last_signature_fail_at,
           s.last_error,
           s.last_event,
           s.imported_count,
           case
             when s.disabled then 'Disabled'
             when s.imported_count > 0 then 'Live'
             when s.last_signature_fail_at is not null then 'Signature failed'
             when s.consumer_secret is not null and length(s.consumer_secret) > 0 then 'Waiting for first order'
             when s.intake_token is not null then 'Secret needed'
             else 'Setup pending'
           end,
           s.created_at
    from public.store_secrets s
    left join public.clients c on c.id = s.client_id
    where s.platform = 'shopify'
    order by s.created_at desc;
end;
$$;

CREATE FUNCTION public.admin_list_wallet_balances() RETURNS TABLE(client_id uuid, client_name text, wallet_balance numeric, pending_payout numeric, lifetime_paid numeric, dues_outstanding numeric, net_position numeric, last_activity_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select c.id,
           c.name,
           coalesce(c.wallet_balance, 0),
           coalesce((select sum(w.net) from public.withdrawals w
                      where w.client_id = c.id and w.status = 'Pending admin payout'), 0),
           coalesce((select sum(w.net) from public.withdrawals w
                      where w.client_id = c.id and w.status = 'Paid'), 0),
           coalesce(s.outstanding, 0),
           coalesce(c.wallet_balance, 0) - coalesce(s.outstanding, 0),
           (select max(l.created_at) from public.wallet_ledger l where l.client_id = c.id)
      from public.clients c
      left join public.client_dues_summary s on s.client_id = c.id
     order by coalesce(c.wallet_balance, 0) desc;
end;
$$;

CREATE FUNCTION public.admin_mark_invoice_paid(p_invoice_id uuid) RETURNS public.invoices
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_invoice public.invoices;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice is null then
    raise exception 'Invoice not found.';
  end if;

  if v_invoice.status in ('Settled', 'Paid to NovaX', 'Cancelled') then
    raise exception 'Invoice % is already closed (%).', v_invoice.code, v_invoice.status;
  end if;

  if coalesce(v_invoice.net_payable, 0) > 0 then
    if v_invoice.status <> 'Pushed to wallet' then
      raise exception 'Invoice % must be pushed to the client wallet before it can be closed as Settled.', v_invoice.code;
    end if;
    update public.invoices set status = 'Settled', settled_at = now() where id = p_invoice_id returning * into v_invoice;
  elsif coalesce(v_invoice.due_to_novax, 0) > 0 then
    if v_invoice.status <> 'Generated' then
      raise exception 'Invoice % is not in a state that can be marked Paid to NovaX.', v_invoice.code;
    end if;
    update public.invoices set status = 'Paid to NovaX', settled_at = now() where id = p_invoice_id returning * into v_invoice;
    insert into public.payment_logs (client_id, type, amount, status, reference)
      values (v_invoice.client_id, 'Delivery charges paid to NovaX', v_invoice.due_to_novax, 'Paid to NovaX', v_invoice.code);
  else
    update public.invoices set status = 'Settled', settled_at = now() where id = p_invoice_id returning * into v_invoice;
  end if;

  return v_invoice;
end;
$$;

CREATE FUNCTION public.admin_mark_notification_sent(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.notification_events
  set status = 'manual', sent_at = now()
  where id = p_id;
end;
$$;

CREATE FUNCTION public.admin_mark_withdrawal_paid(p_withdrawal_id uuid, p_txn_id text, p_paid_by text, p_proof text DEFAULT NULL::text) RETURNS public.withdrawals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.withdrawals;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_txn_id is null or btrim(p_txn_id) = '' then
    raise exception 'Bank transaction/reference ID is required.';
  end if;
  if p_paid_by is null or btrim(p_paid_by) = '' then
    raise exception 'Paid-by staff name is required.';
  end if;

  select * into v_row from public.withdrawals where id = p_withdrawal_id for update;
  if v_row is null then
    raise exception 'Withdrawal not found.';
  end if;
  if v_row.status <> 'Pending admin payout' then
    raise exception 'Withdrawal % is not pending (current status: %) and cannot be marked paid again.', v_row.id, v_row.status;
  end if;

  update public.withdrawals
    set status = 'Paid', paid_at = now(), paid_txn_id = btrim(p_txn_id), paid_by = btrim(p_paid_by), paid_proof = coalesce(btrim(p_proof), '')
    where id = p_withdrawal_id
    returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_row.client_id, 'payout_paid', 0, false, 'Paid', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal paid via bank transfer. Txn ' || v_row.paid_txn_id || ', by ' || v_row.paid_by || '. Closes the payout only -- balance was already reduced when the withdrawal was requested.');

  return v_row;
end;
$$;

CREATE FUNCTION public.admin_parcel_audit(p_awb text) RETURNS TABLE(action text, changes jsonb, actor_role text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  return query
    select a.action, a.changes, a.actor_role, a.created_at
      from public.parcel_admin_audit a
     where a.awb = btrim(p_awb)
     order by a.created_at desc;
end;
$$;

CREATE FUNCTION public.admin_processing_access_debug() RETURNS TABLE(uid uuid, email text, profile_role text, profile_status text, staff_row_id uuid, staff_role text, staff_status text, staff_permissions jsonb, matched_by_auth_user_id boolean, matched_by_email boolean, can_process boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
begin
  return query
  select
    v_uid,
    v_email,
    (select p.role::text from public.profiles p where p.id = v_uid),
    (select p.status::text from public.profiles p where p.id = v_uid),
    su.id,
    su.role,
    su.status,
    su.permissions,
    (su.auth_user_id = v_uid),
    (su.email is not null and lower(su.email) = lower(v_email)),
    public.can_process_orders()
  from public.staff_users su
  where su.auth_user_id = v_uid
     or (su.email is not null and lower(su.email) = lower(v_email))
  union all
  select
    v_uid, v_email,
    (select p.role::text from public.profiles p where p.id = v_uid),
    (select p.status::text from public.profiles p where p.id = v_uid),
    null, null, null, null, false, false,
    public.can_process_orders()
  where not exists (
    select 1 from public.staff_users su2
    where su2.auth_user_id = v_uid
       or (su2.email is not null and lower(su2.email) = lower(v_email))
  );
end;
$$;

CREATE FUNCTION public.admin_processing_lookup(p_awbs text[]) RETURNS TABLE(id uuid, awb text, client_id uuid, consignee text, phone text, address text, city text, status text, cod_amount numeric, fee numeric, rider_id uuid, booked_at timestamp with time zone, updated_at timestamp with time zone, exception text, meta jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
declare
  v_awbs text[];
begin
  if not public.can_process_orders() then
    raise exception 'You do not have order processing access.';
  end if;

  select array_agg(distinct upper(trim(x)))
  into v_awbs
  from unnest(coalesce(p_awbs, array[]::text[])) as x
  where trim(x) <> '';

  -- No AWBs to look up -- return an empty result set, not an error.
  if v_awbs is null or array_length(v_awbs, 1) is null then
    return;
  end if;

  return query
  select
    pa.id, pa.awb, pa.client_id, pa.consignee, pa.phone, pa.address, pa.city,
    pa.status, pa.cod_amount, pa.fee, pa.rider_id, pa.booked_at, pa.updated_at,
    pa.exception, pa.meta
  from public.parcels pa
  where upper(pa.awb) = any (v_awbs);
end;
$$;

CREATE FUNCTION public.admin_processing_update_status(p_awbs text[], p_status text, p_rider_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, awb text, client_id uuid, consignee text, phone text, address text, city text, status text, cod_amount numeric, fee numeric, rider_id uuid, booked_at timestamp with time zone, updated_at timestamp with time zone, exception text, meta jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  -- INDEX ORDER IS LOAD-BEARING: v_stage below is array_position() - 1 and
  -- becomes meta.stage, which every progress bar reads. Append only.
  v_status_list text[] := array[
    'New booked', 'Collected by rider', 'Arrived at warehouse',
    'Parcel now in transit', 'Parcel received at destination',
    'Parcel out for delivery', 'Delivered', 'Refused',
    'Consignee not available', 'Reattempt', 'Reassigned',
    'Out of service area', 'Ready for return', 'Return in transit',
    'Return received at origin', 'Return out for delivery',
    'Return to shipper',
    'Cancelled by client'
  ];
  v_rider_push_statuses text[] := array['Parcel out for delivery', 'Return out for delivery'];
  v_awbs text[];
  v_found_awbs text[];
  v_missing_awbs text[];
  v_processor_email text;
  v_processor_name text;
  v_now timestamptz := now();
  v_stamp text := to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');
  v_time text := to_char(v_now, 'HH24:MI');
  v_stage int;
  r record;
  v_origin text;
  v_branch text;
  v_steps jsonb;
  v_process_history jsonb;
  v_new_meta jsonb;
begin
  if not public.can_process_orders() then
    raise exception 'You do not have order processing access.';
  end if;

  if p_status is null or not (p_status = any (v_status_list)) then
    raise exception 'Status "%" is not a valid NovaX status.', p_status;
  end if;

  if p_status = any (v_rider_push_statuses) and p_rider_id is null then
    raise exception 'Select a rider before pushing parcels out for delivery.';
  end if;

  -- Every table reference below is ALIASED on purpose. This function is
  -- `returns table (id, awb, ..., rider_id, ...)`, and PL/pgSQL puts those
  -- OUT parameters in scope as variables for the whole body -- so a bare
  -- `id` or `awb` or `rider_id` in any query is ambiguous between the
  -- variable and the column, and Postgres refuses it at runtime with
  -- 'column reference "id" is ambiguous'. Do not un-alias these.
  if p_rider_id is not null and not exists (select 1 from public.riders rd where rd.id = p_rider_id) then
    raise exception 'Selected rider was not found.';
  end if;

  select array_agg(distinct upper(trim(x)))
  into v_awbs
  from unnest(coalesce(p_awbs, array[]::text[])) as x
  where trim(x) <> '';

  if v_awbs is null or array_length(v_awbs, 1) is null then
    raise exception 'No AWBs were provided to update.';
  end if;

  perform 1 from public.parcels lk where upper(lk.awb) = any (v_awbs) for update;

  select array_agg(distinct upper(pa.awb))
  into v_found_awbs
  from public.parcels pa
  where upper(pa.awb) = any (v_awbs);

  select array_agg(x)
  into v_missing_awbs
  from unnest(v_awbs) as x
  where not (x = any (coalesce(v_found_awbs, array[]::text[])));

  if v_missing_awbs is not null and array_length(v_missing_awbs, 1) > 0 then
    raise exception 'These AWB(s) were not found: %', array_to_string(v_missing_awbs, ', ');
  end if;

  v_processor_email := coalesce(auth.jwt() ->> 'email', (select pr.email from public.profiles pr where pr.id = auth.uid()), '');
  v_processor_name := coalesce(
    (select su.name from public.staff_users su where lower(su.email) = lower(v_processor_email) limit 1),
    nullif(v_processor_email, ''),
    'Staff'
  );

  v_stage := coalesce(array_position(v_status_list, p_status) - 1, 0);

  for r in
    select pa.* from public.parcels pa where upper(pa.awb) = any (v_awbs)
  loop
    v_origin := coalesce(
      r.meta ->> 'origin',
      r.meta ->> 'pickupCity',
      (select c.city from public.clients c where c.id = r.client_id),
      'Karachi'
    );

    if p_status ~* 'destination|delivery|delivered|refused|consignee|reattempt|reassigned' then
      v_branch := coalesce(r.city, v_origin) || ' Hub';
    elsif p_status ~* 'return received at origin|return out for delivery|return to shipper|returned' then
      v_branch := v_origin || ' Hub';
    elsif p_status ~* 'transit' then
      v_branch := v_origin || ' to ' || coalesce(r.city, v_origin);
    else
      v_branch := v_origin || ' Hub';
    end if;

    v_steps := coalesce(r.meta -> 'steps', '[]'::jsonb);
    if not (v_steps @> to_jsonb(p_status)) then
      v_steps := v_steps || to_jsonb(p_status);
    end if;

    v_process_history := coalesce(r.meta -> 'processHistory', '[]'::jsonb);
    v_process_history := v_process_history || jsonb_build_object(
      'status', p_status,
      'branch', v_branch,
      'time', v_time,
      'processor', v_processor_name,
      'processorEmail', nullif(v_processor_email, ''),
      'processorId', auth.uid(),
      'username', nullif(v_processor_email, ''),
      'at', v_stamp
    );

    v_new_meta := coalesce(r.meta, '{}'::jsonb) || jsonb_build_object(
      'branch', v_branch,
      'stage', v_stage,
      'statusAgeHours', 0,
      'steps', v_steps,
      'processHistory', v_process_history,
      'lastProcessedBy', v_processor_name,
      'lastProcessedAt', v_stamp
    );

    -- Aliased for the same OUT-parameter reason as above. Note the SET
    -- left-hand sides stay UNqualified -- Postgres rejects `set tgt.col = ...`
    -- -- but the right-hand `tgt.rider_id` and the WHERE must be qualified.
    update public.parcels tgt
    set
      status = p_status,
      rider_id = case when p_status = any (v_rider_push_statuses) then p_rider_id else tgt.rider_id end,
      updated_at = v_now,
      meta = v_new_meta
    where tgt.id = r.id;
  end loop;

  return query
  select
    pa.id, pa.awb, pa.client_id, pa.consignee, pa.phone, pa.address, pa.city,
    pa.status, pa.cod_amount, pa.fee, pa.rider_id, pa.booked_at, pa.updated_at,
    pa.exception, pa.meta
  from public.parcels pa
  where upper(pa.awb) = any (v_awbs);
end;
$$;

CREATE FUNCTION public.admin_push_invoice_to_wallet(p_invoice_id uuid) RETURNS public.invoices
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_invoice public.invoices;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice is null then
    raise exception 'Invoice not found.';
  end if;

  if v_invoice.status <> 'Generated' then
    raise exception 'Invoice % is not in a pushable state (current status: %). Push To Client Wallet can only run once, from Generated.', v_invoice.code, v_invoice.status;
  end if;

  if coalesce(v_invoice.net_payable, 0) <= 0 then
    raise exception 'Invoice % has no client-payable amount and cannot be pushed to wallet. Use Mark Paid To NovaX instead.', v_invoice.code;
  end if;

  update public.clients
    set wallet_balance = coalesce(wallet_balance, 0) + v_invoice.net_payable
    where id = v_invoice.client_id;

  update public.invoices
    set status = 'Pushed to wallet', wallet_pushed_at = now()
    where id = p_invoice_id
    returning * into v_invoice;

  insert into public.payment_logs (client_id, type, amount, status, reference)
  values (v_invoice.client_id, 'Invoice pushed to wallet', v_invoice.net_payable, 'Wallet credited', v_invoice.code);

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_invoice.client_id, 'invoice_credit', v_invoice.net_payable, true, 'Credited', 'invoice', v_invoice.id, v_invoice.code,
    'Invoice ' || v_invoice.code || ' credited to wallet. Rs ' || v_invoice.net_payable || ' now available to withdraw.');

  return v_invoice;
end;
$$;

CREATE FUNCTION public.admin_reconcile_wallet_balances() RETURNS TABLE(client_id uuid, old_balance numeric, new_balance numeric, corrected numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  r record;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  for r in
    select c.id as cid, coalesce(c.wallet_balance,0) as old_bal,
      coalesce((select sum(wl.amount) from public.wallet_ledger wl where wl.client_id = c.id and wl.affects_balance), 0) as expected_bal
    from public.clients c
  loop
    if r.old_bal is distinct from r.expected_bal then
      update public.clients set wallet_balance = r.expected_bal where id = r.cid;
      insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, note)
      values (r.cid, 'admin_adjustment', r.expected_bal - r.old_bal, false, 'Reconciliation', 'reconciliation',
        'Automatic reconciliation: corrected clients.wallet_balance from Rs ' || r.old_bal || ' to Rs ' || r.expected_bal || ' to match wallet_ledger.');
      client_id := r.cid; old_balance := r.old_bal; new_balance := r.expected_bal; corrected := r.expected_bal - r.old_bal;
      return next;
    end if;
  end loop;
  return;
end;
$$;

CREATE FUNCTION public.admin_record_due_payment(p_client_id uuid, p_amount numeric, p_method text DEFAULT 'Manual'::text, p_reference text DEFAULT ''::text, p_note text DEFAULT ''::text) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_outstanding numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null then
    raise exception 'Client is required.';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Payment amount must not be zero.';
  end if;

  select s.outstanding into v_outstanding
    from public.client_dues_summary s where s.client_id = p_client_id;

  if v_outstanding is null then
    raise exception 'That client has no dues record.';
  end if;

  -- Guard against over-collection typos (e.g. 50000 instead of 5000). A
  -- deliberate correction can still be entered as a negative amount.
  if p_amount > 0 and p_amount > v_outstanding then
    raise exception 'Payment of % is more than the outstanding balance of %.', p_amount, v_outstanding;
  end if;

  insert into public.client_due_payments (client_id, amount, method, reference, note, recorded_by)
  values (p_client_id, p_amount, coalesce(nullif(btrim(p_method), ''), 'Manual'),
          coalesce(btrim(p_reference), ''), coalesce(btrim(p_note), ''), auth.uid());

  select s.outstanding into v_outstanding
    from public.client_dues_summary s where s.client_id = p_client_id;

  return coalesce(v_outstanding, 0);
end;
$$;

CREATE FUNCTION public.admin_regenerate_shopify_intake(p_client_id uuid) RETURNS TABLE(intake_token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_new_token text;
begin
  if not is_admin() then
    raise exception 'Only admins can configure store integrations.';
  end if;

  v_new_token := encode(extensions.gen_random_bytes(24), 'hex');

  update public.store_secrets
    set intake_token = v_new_token, updated_at = now()
    where client_id = p_client_id and platform = 'shopify';

  if not found then
    raise exception 'This client has no Shopify link yet -- generate one first.';
  end if;

  return query select v_new_token;
end;
$$;

CREATE FUNCTION public.admin_reject_wallet_withdrawal(p_withdrawal_id uuid, p_reason text) RETURNS public.withdrawals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.withdrawals;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to reject/cancel a withdrawal.';
  end if;

  select * into v_row from public.withdrawals where id = p_withdrawal_id for update;
  if v_row is null then
    raise exception 'Withdrawal not found.';
  end if;
  if v_row.status <> 'Pending admin payout' then
    raise exception 'Withdrawal % is not pending (current status: %) and cannot be rejected.', v_row.id, v_row.status;
  end if;

  update public.clients set wallet_balance = coalesce(wallet_balance,0) + v_row.amount where id = v_row.client_id;

  update public.withdrawals
    set status = 'Rejected / Cancelled', rejection_reason = btrim(p_reason), paid_at = now()
    where id = p_withdrawal_id
    returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_row.client_id, 'payout_rejected', v_row.amount, true, 'Rejected / Cancelled', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal rejected/cancelled -- Rs ' || v_row.amount || ' returned to wallet. Reason: ' || btrim(p_reason));

  return v_row;
end;
$$;

CREATE FUNCTION public.admin_request_wallet_withdrawal(p_client_id uuid, p_amount numeric, p_iban text, p_speed text) RETURNS public.withdrawals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_balance numeric;
  v_fee numeric;
  v_net numeric;
  v_rate numeric;
  v_holder_name text;
  v_bank_name text;
  v_row public.withdrawals;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null then
    raise exception 'Client is required.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal amount must be greater than zero.';
  end if;
  if p_iban is null or btrim(p_iban) = '' then
    raise exception 'IBAN / bank account details are required.';
  end if;
  if p_speed not in ('24h','12h','instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  select coalesce(wallet_balance,0),
    btrim(coalesce(meta->'bank'->>'holderName','')),
    btrim(coalesce(meta->'bank'->>'bankName',''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients where id = p_client_id for update;
  if v_balance is null then
    raise exception 'Client wallet not found.';
  end if;
  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients set wallet_balance = v_balance - p_amount where id = p_client_id;

  insert into public.withdrawals (client_id, amount, fee, net, iban, speed, status, balance_before, holder_name, bank_name)
  values (p_client_id, p_amount, v_fee, v_net, btrim(p_iban), p_speed, 'Pending admin payout', v_balance, nullif(v_holder_name,''), nullif(v_bank_name,''))
  returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (p_client_id, 'withdrawal_requested', -p_amount, true, 'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested by admin: Rs ' || p_amount || ' reserved, ' || v_net || ' net after Rs ' || v_fee || ' fee (' || p_speed || ').');
  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (p_client_id, 'payout_fee', -v_fee, false, 'Informational', 'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).');

  return v_row;
end;
$$;

CREATE FUNCTION public.admin_reset_shopify_secret(p_client_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not is_admin() then
    raise exception 'Only admins can configure store integrations.';
  end if;

  update public.store_secrets
    set consumer_secret = '', last_error = null, last_signature_fail_at = null, updated_at = now()
    where client_id = p_client_id and platform = 'shopify';

  if not found then
    raise exception 'This client has no Shopify link yet.';
  end if;
end;
$$;

CREATE FUNCTION public.admin_resolve_error_log(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.portal_error_logs set resolved = true where id = p_id;
end;
$$;

CREATE FUNCTION public.admin_retry_notification(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.notification_events
  set status = 'pending', retry_count = retry_count + 1, error = null
  where id = p_id;
end;
$$;

CREATE FUNCTION public.admin_search_clients(p_query text DEFAULT ''::text) RETURNS TABLE(client_id uuid, client_name text, city text, phone text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_q text;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  v_q := lower(btrim(coalesce(p_query, '')));

  return query
    select c.id, c.name, coalesce(c.city, ''), coalesce(c.phone, '')
      from public.clients c
     where v_q = '' or lower(coalesce(c.name, '')) like '%' || v_q || '%'
     order by c.name asc
     limit 50;
end;
$$;

CREATE FUNCTION public.admin_set_client_pricing_mode(p_client_id uuid, p_mode text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_role text;
begin
  select lower(pr.role::text) into v_role
  from public.profiles pr where pr.id = auth.uid() limit 1;

  if v_role is null or v_role not in ('admin','owner') then
    return json_build_object('ok', false, 'error', 'not_authorised');
  end if;

  if p_mode is null or p_mode not in ('flat','distance') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    return json_build_object('ok', false, 'error', 'no_such_client');
  end if;

  update public.clients
     set pricing_mode        = p_mode,
         pricing_mode_at     = now(),
         pricing_mode_source = 'admin'
   where id = p_client_id;

  return json_build_object('ok', true, 'mode', p_mode);
end
$$;

CREATE FUNCTION public.admin_set_review_status(p_review_id uuid, p_status text, p_display_name text DEFAULT NULL::text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then raise exception 'Admin access required.'; end if;

  if p_status not in ('pending','approved','rejected') then
    raise exception 'Unknown review status: %', p_status;
  end if;

  update public.reviews
  set status = p_status,
      display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
      reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_review_id;

  if not found then raise exception 'Review not found.'; end if;
  return json_build_object('ok', true);
end; $$;

CREATE FUNCTION public.admin_set_shopify_disabled(p_client_id uuid, p_disabled boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not is_admin() then
    raise exception 'Only admins can configure store integrations.';
  end if;

  update public.store_secrets
    set disabled = coalesce(p_disabled, false), updated_at = now()
    where client_id = p_client_id and platform = 'shopify';

  if not found then
    raise exception 'This client has no Shopify link yet.';
  end if;
end;
$$;

CREATE FUNCTION public.admin_set_store_credentials(p_client_id uuid, p_platform text, p_store_url text, p_consumer_key text, p_consumer_secret text) RETURNS TABLE(intake_token text, webhook_secret text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_intake_token text;
  v_webhook_secret text;
begin
  if not is_admin() then
    raise exception 'Only admins can configure store integrations.';
  end if;

  if p_client_id is null or p_store_url is null or p_consumer_key is null or p_consumer_secret is null then
    raise exception 'client, store URL, consumer key, and consumer secret are all required.';
  end if;

  select intake_token, webhook_secret into v_intake_token, v_webhook_secret
    from public.store_secrets where client_id = p_client_id and platform = p_platform;

  if v_intake_token is null then
    v_intake_token := encode(gen_random_bytes(24), 'hex');
    v_webhook_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (p_client_id, p_platform, p_store_url, p_consumer_key, p_consumer_secret, v_webhook_secret, v_intake_token);
  else
    update public.store_secrets
      set store_url = p_store_url, consumer_key = p_consumer_key, consumer_secret = p_consumer_secret, updated_at = now()
      where client_id = p_client_id and platform = p_platform;
  end if;

  if exists (select 1 from public.store_connections where client_id = p_client_id and platform = p_platform) then
    update public.store_connections
      set store_url = p_store_url, connected = true,
          meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('hasCreds', true, 'connectedAt', now()::text)
      where client_id = p_client_id and platform = p_platform;
  else
    insert into public.store_connections (client_id, platform, store_url, connected, meta)
    values (p_client_id, p_platform, p_store_url, true, jsonb_build_object('hasCreds', true, 'connectedAt', now()::text));
  end if;

  return query select v_intake_token, v_webhook_secret;
end;
$$;

CREATE FUNCTION public.admin_settle_client_dues(p_client_id uuid, p_note text DEFAULT 'Settled manually by admin'::text) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_outstanding numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select s.outstanding into v_outstanding
    from public.client_dues_summary s where s.client_id = p_client_id;

  if v_outstanding is null then
    raise exception 'That client has no dues record.';
  end if;
  if v_outstanding = 0 then
    return 0;
  end if;

  insert into public.client_due_payments (client_id, amount, method, reference, note, recorded_by)
  values (p_client_id, v_outstanding, 'Settlement', '',
          coalesce(nullif(btrim(p_note), ''), 'Settled manually by admin'), auth.uid());

  return 0;
end;
$$;

CREATE FUNCTION public.admin_system_health_snapshot() RETURNS TABLE(metric text, value text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select 'latest_shopify_import_at'::text, max(last_order_at)::text from public.store_secrets where public.is_staff_admin()
  union all
  select 'latest_shopify_import_awb'::text, (select last_order_awb from public.store_secrets where last_order_awb is not null order by last_order_at desc nulls last limit 1) where public.is_staff_admin()
  union all
  select 'latest_withdrawal_status'::text, (select status from public.withdrawals order by created_at desc limit 1) where public.is_staff_admin()
  union all
  select 'latest_invoice_status'::text, (select status from public.invoices order by created_at desc limit 1) where public.is_staff_admin();
$$;

CREATE FUNCTION public.admin_update_parcel_details(p_awb text, p_consignee text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_cod numeric DEFAULT NULL::numeric, p_fee numeric DEFAULT NULL::numeric, p_weight text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_payment_mode text DEFAULT NULL::text, p_note text DEFAULT ''::text) RETURNS public.parcels
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row     public.parcels;
  v_changes jsonb := '{}'::jsonb;
  v_meta    jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_row from public.parcels where awb = btrim(p_awb) limit 1;
  if v_row.awb is null then
    raise exception 'That parcel does not exist.';
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice. Cancel or correct the invoice first.';
  end if;
  if v_row.status in ('Delivered', 'Parcel returned to consignee') then
    raise exception 'This parcel has reached an end state (%) and can no longer be edited.', v_row.status;
  end if;

  -- Build the change set so the audit records exactly what moved.
  if p_consignee is not null and btrim(p_consignee) <> '' and btrim(p_consignee) is distinct from v_row.consignee then
    v_changes := v_changes || jsonb_build_object('consignee', jsonb_build_object('from', v_row.consignee, 'to', btrim(p_consignee)));
  end if;
  if p_phone is not null and btrim(p_phone) is distinct from coalesce(v_row.phone,'') then
    v_changes := v_changes || jsonb_build_object('phone', jsonb_build_object('from', v_row.phone, 'to', btrim(p_phone)));
  end if;
  if p_address is not null and btrim(p_address) is distinct from coalesce(v_row.address,'') then
    v_changes := v_changes || jsonb_build_object('address', jsonb_build_object('from', v_row.address, 'to', btrim(p_address)));
  end if;
  if p_city is not null and btrim(p_city) <> '' and btrim(p_city) is distinct from coalesce(v_row.city,'') then
    v_changes := v_changes || jsonb_build_object('city', jsonb_build_object('from', v_row.city, 'to', btrim(p_city)));
  end if;
  if p_cod is not null and p_cod is distinct from coalesce(v_row.cod_amount,0) then
    if p_cod < 0 then raise exception 'COD cannot be negative.'; end if;
    v_changes := v_changes || jsonb_build_object('cod_amount', jsonb_build_object('from', v_row.cod_amount, 'to', p_cod));
  end if;
  if p_fee is not null and p_fee is distinct from coalesce(v_row.fee,0) then
    if p_fee < 0 then raise exception 'Delivery fee cannot be negative.'; end if;
    v_changes := v_changes || jsonb_build_object('fee', jsonb_build_object('from', v_row.fee, 'to', p_fee));
  end if;

  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  if p_weight is not null and btrim(p_weight) <> '' then
    v_changes := v_changes || jsonb_build_object('weight', jsonb_build_object('from', v_meta->>'weight', 'to', btrim(p_weight)));
    v_meta := v_meta || jsonb_build_object('weight', btrim(p_weight));
  end if;
  if p_category is not null and btrim(p_category) <> '' then
    v_meta := v_meta || jsonb_build_object('category', btrim(p_category));
  end if;
  if p_payment_mode is not null and btrim(p_payment_mode) <> '' then
    v_changes := v_changes || jsonb_build_object('paymentMode', jsonb_build_object('from', v_meta->>'paymentMode', 'to', btrim(p_payment_mode)));
    v_meta := v_meta || jsonb_build_object('paymentMode', btrim(p_payment_mode));
  end if;

  if v_changes = '{}'::jsonb and p_category is null then
    return v_row;   -- nothing actually changed
  end if;

  v_meta := v_meta || jsonb_build_object('lastAdminEditAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  update public.parcels p
     set consignee  = coalesce(nullif(btrim(p_consignee), ''), p.consignee),
         phone      = case when p_phone   is null then p.phone   else btrim(p_phone)   end,
         address    = case when p_address is null then p.address else btrim(p_address) end,
         city       = coalesce(nullif(btrim(p_city), ''), p.city),
         cod_amount = coalesce(p_cod, p.cod_amount),
         fee        = coalesce(p_fee, p.fee),
         meta       = v_meta,
         updated_at = now()
   where p.awb = v_row.awb
   returning * into v_row;

  insert into public.parcel_admin_audit (awb, client_id, action, changes, actor_id, actor_role)
  values (v_row.awb, v_row.client_id, 'edited',
          v_changes || jsonb_build_object('note', coalesce(btrim(p_note), '')),
          auth.uid(), 'admin');

  return v_row;
end;
$$;

CREATE FUNCTION public.admin_wallet_adjustment(p_client_id uuid, p_amount numeric, p_note text) RETURNS public.clients
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client public.clients;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_client_id is null then
    raise exception 'Client is required.';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Adjustment amount must be non-zero.';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'A note is required for every wallet adjustment.';
  end if;

  select * into v_client from public.clients where id = p_client_id for update;
  if v_client is null then
    raise exception 'Client not found.';
  end if;

  update public.clients set wallet_balance = coalesce(wallet_balance,0) + p_amount where id = p_client_id returning * into v_client;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, note)
  values (p_client_id, 'admin_adjustment', p_amount, true, 'Adjustment', 'manual', btrim(p_note));

  return v_client;
end;
$$;

CREATE FUNCTION public.admin_wallet_summary() RETURNS TABLE(client_id uuid, client_name text, wallet_balance numeric, pending_withdrawals numeric, paid_withdrawals_total numeric, ledger_expected_balance numeric, mismatch boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select
      c.id,
      c.name,
      coalesce(c.wallet_balance,0),
      coalesce((select sum(w.net) from public.withdrawals w where w.client_id = c.id and w.status = 'Pending admin payout'), 0),
      coalesce((select sum(w.net) from public.withdrawals w where w.client_id = c.id and w.status = 'Paid'), 0),
      coalesce((select sum(wl.amount) from public.wallet_ledger wl where wl.client_id = c.id and wl.affects_balance), 0),
      coalesce(c.wallet_balance,0) <> coalesce((select sum(wl.amount) from public.wallet_ledger wl where wl.client_id = c.id and wl.affects_balance), 0)
    from public.clients c
    order by c.name;
end;
$$;
