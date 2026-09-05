-- ═══════════════════════════════════════════════════════════════════════════
-- NovaX — close the COD/prepaid hole at both ends (Codex P0-001 + P0-002)
--
-- What this is for: a parcel marked prepaid that also carries a COD amount.
-- Every layer resolved that silently in favour of prepaid, so the money simply
-- disappeared from the screen and from the invoice. On 2026-09-02 that cost
-- Hayat Scents Rs 3,049 on N7810028: delivered, no cod_ledger row, swept into
-- invoice INV-260902fe245 with cod_total = 0, and the merchant debited Rs 400
-- in delivery charges instead. Settled, and only found by going looking.
--
-- The rule, already enforced in the browser (nv-payment.js) and the API
-- (_shared/payment.ts): such a parcel is neither prepaid nor COD. It is a
-- CONFLICT, and nothing downstream may resolve it silently.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. one definition of "prepaid", instead of a third regex ───────────────
-- The SQL in admin_generate_invoice* used 'non\s*cod|prepaid', which does NOT
-- match "non-cod" (hyphen) or a bare "paid" -- both of which the browser and
-- the API do match. Three spellings of the same rule is how they drift.
-- KEEP IN SYNC: nv-payment.js PREPAID_RE, _shared/payment.ts PREPAID_RE.
create or replace function public.nv_is_prepaid_mode(p_mode text)
returns boolean language sql immutable parallel safe as
$$ select coalesce(p_mode, '') ~* 'non\s*-?\s*cod|prepaid|^paid$' $$;

create or replace function public.nv_is_payment_conflict(p_mode text, p_cod numeric)
returns boolean language sql immutable parallel safe as
$$ select public.nv_is_prepaid_mode(p_mode) and coalesce(p_cod, 0) > 0 $$;

comment on function public.nv_is_payment_conflict(text, numeric) is
  'True when a parcel says prepaid but carries a COD amount. Such a parcel must not be invoiced or booked until a human resolves it.';

revoke all on function public.nv_is_prepaid_mode(text) from public;
revoke all on function public.nv_is_payment_conflict(text, numeric) from public;
grant execute on function public.nv_is_prepaid_mode(text) to authenticated, service_role;
grant execute on function public.nv_is_payment_conflict(text, numeric) to authenticated, service_role;

-- ── 2. P0-002: no booking path may create a conflict ──────────────────────
CREATE OR REPLACE FUNCTION public.nv_book_parcel_core(p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_source text DEFAULT 'admin_portal'::text, p_actor_role text DEFAULT 'admin'::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- P0-002. Every booking path lands here: the client portal, admin
  -- "Book For Client", the Shopify intake and the merchant API. The API
  -- already rejects this with a 422 and the portal derives the mode from the
  -- COD amount, but admin booking had no guard at all -- so the one route
  -- operated by NovaX itself was the one that could still create the parcel
  -- that loses money later. Refuse it here, where nothing can bypass it.
  if public.nv_is_payment_conflict(p_payment_mode, p_cod) then
    raise exception
      'This parcel is marked "%" but carries a COD amount of Rs %. A prepaid parcel collects nothing at the door. Set COD to 0, or change the payment mode to COD.',
      btrim(p_payment_mode), trim(to_char(p_cod, 'FM999,999,999'))
      using errcode = 'P0001';
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
$function$



-- ── 3. P0-001: no invoice run may silently resolve one ────────────────────
CREATE OR REPLACE FUNCTION public.admin_generate_invoice_v2(p_client_id uuid, p_awbs text[], p_net_returns boolean DEFAULT true)
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, cod_total numeric, fee_total numeric, net_payable numeric, due_to_novax numeric, return_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_conflict_awbs text;
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

  -- P0-001. A parcel that says prepaid AND carries a COD amount was counted in
  -- the prepaid bucket, so its COD never reached cod_total and the merchant was
  -- never credited: exactly how Rs 3,049 vanished on N7810028. Refuse the whole
  -- run and name the parcels, rather than silently choosing one reading of a
  -- contradiction. Blocking is the point -- an invoice, once settled, is not
  -- something a merchant can un-ring.
  select string_agg(p.awb || ' (COD Rs ' || trim(to_char(p.cod_amount,'FM999,999,999'))
                    || ' but marked "' || coalesce(p.meta->>'paymentMode','') || '")', ', ' order by p.awb)
    into v_conflict_awbs
    from public.parcels p
   where p.client_id = p_client_id
     and p.awb = any(p_awbs)
     and p.invoice_id is null
     and public.nv_is_payment_conflict(p.meta->>'paymentMode', p.cod_amount);

  if v_conflict_awbs is not null then
    raise exception
      'Cannot invoice. These parcels carry a COD amount but are marked prepaid: %. Resolve the payment mode or zero the COD first, or the merchant will not be credited for money the rider collects.',
      v_conflict_awbs
      using errcode = 'P0001';
  end if;

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


    -- ---- SCENARIO 2 + 3: the invoice moves the wallet, here, once. --------
    -- v_payable and v_due are mutually exclusive by construction above: if
    -- the COD covered the charges v_due is 0, and if it did not v_payable is
    -- 0. So this is one signed movement, not two competing ones.
    --
    -- The debit is what makes the invoice the only source of truth. Before
    -- this, a negative invoice moved nothing: the wallet stayed where it was
    -- and the debt lived only in the Negative Accounts list, which is why a
    -- merchant could hold Rs 10,083 and owe Rs 477 at the same time and
    -- withdraw all of it.
    --
    -- Two behaviours come free once the money actually lands in the wallet,
    -- and neither needs its own code:
    --   * a merchant who already withdrew goes negative, and
    --     request_wallet_withdrawal's `amount > balance` check then blocks
    --     any further payout on its own;
    --   * the next COD invoice pushed to that wallet nets against it by
    --     ordinary arithmetic (-1000 + 8000 = 7000).
    if v_due > 0 then
      update public.clients
         set wallet_balance = coalesce(wallet_balance, 0) - v_due
       where id = p_client_id;

      -- clients.wallet_balance must always equal the sum of that client's
      -- affects_balance ledger rows. It does today for all 216 clients, and
      -- computeWalletReconciliation() BLOCKS payouts for anyone it does not
      -- hold for -- so the balance move and this row are one transaction.
      insert into public.wallet_ledger
        (client_id, entry_type, amount, affects_balance, status,
         reference_type, reference_id, reference_code, note)
      values
        (p_client_id, 'invoice_due_debit', -v_due, true, 'Delivery charge',
         'invoice', v_id, v_code,
         'Invoice ' || v_code || ' - delivery charges owed on prepaid and returned parcels, taken from wallet.');
    end if;

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


  -- ---- SCENARIO 2 + 3: the invoice moves the wallet, here, once. --------
  -- v_payable and v_due are mutually exclusive by construction above: if
  -- the COD covered the charges v_due is 0, and if it did not v_payable is
  -- 0. So this is one signed movement, not two competing ones.
  --
  -- The debit is what makes the invoice the only source of truth. Before
  -- this, a negative invoice moved nothing: the wallet stayed where it was
  -- and the debt lived only in the Negative Accounts list, which is why a
  -- merchant could hold Rs 10,083 and owe Rs 477 at the same time and
  -- withdraw all of it.
  --
  -- Two behaviours come free once the money actually lands in the wallet,
  -- and neither needs its own code:
  --   * a merchant who already withdrew goes negative, and
  --     request_wallet_withdrawal's `amount > balance` check then blocks
  --     any further payout on its own;
  --   * the next COD invoice pushed to that wallet nets against it by
  --     ordinary arithmetic (-1000 + 8000 = 7000).
  if v_due > 0 then
    update public.clients
       set wallet_balance = coalesce(wallet_balance, 0) - v_due
     where id = p_client_id;

    -- clients.wallet_balance must always equal the sum of that client's
    -- affects_balance ledger rows. It does today for all 216 clients, and
    -- computeWalletReconciliation() BLOCKS payouts for anyone it does not
    -- hold for -- so the balance move and this row are one transaction.
    insert into public.wallet_ledger
      (client_id, entry_type, amount, affects_balance, status,
       reference_type, reference_id, reference_code, note)
    values
      (p_client_id, 'invoice_due_debit', -v_due, true, 'Delivery charge',
       'invoice', v_id, v_code,
       'Invoice ' || v_code || ' - delivery charges owed on prepaid and returned parcels, taken from wallet.');
  end if;

  return query select v_id, v_code, v_type, v_cod_total, v_cod_fee + v_due_fee,
                      v_payable, v_due, v_ret_count;
end;
$function$



CREATE OR REPLACE FUNCTION public.admin_generate_invoice(p_client_id uuid, p_awbs text[])
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, net_payable numeric, due_to_novax numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_conflict_awbs text;
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

  -- P0-001. A parcel that says prepaid AND carries a COD amount was counted in
  -- the prepaid bucket, so its COD never reached cod_total and the merchant was
  -- never credited: exactly how Rs 3,049 vanished on N7810028. Refuse the whole
  -- run and name the parcels, rather than silently choosing one reading of a
  -- contradiction. Blocking is the point -- an invoice, once settled, is not
  -- something a merchant can un-ring.
  select string_agg(p.awb || ' (COD Rs ' || trim(to_char(p.cod_amount,'FM999,999,999'))
                    || ' but marked "' || coalesce(p.meta->>'paymentMode','') || '")', ', ' order by p.awb)
    into v_conflict_awbs
    from public.parcels p
   where p.client_id = p_client_id
     and p.awb = any(p_awbs)
     and p.invoice_id is null
     and public.nv_is_payment_conflict(p.meta->>'paymentMode', p.cod_amount);

  if v_conflict_awbs is not null then
    raise exception
      'Cannot invoice. These parcels carry a COD amount but are marked prepaid: %. Resolve the payment mode or zero the COD first, or the merchant will not be credited for money the rider collects.',
      v_conflict_awbs
      using errcode = 'P0001';
  end if;

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
$function$



-- ── 4. the portal path: client_book_parcel is its OWN implementation ──────
--    It does not delegate to nv_book_parcel_core, so guarding the core left
--    the portal open. client_book_parcel_geo delegates here, so it is covered.
CREATE OR REPLACE FUNCTION public.client_book_parcel(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
  v_allow text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;
  if coalesce(btrim(p_consignee), '') = '' then
    raise exception 'Consignee name is required.';
  end if;

  -- Same guard as nv_book_parcel_core. This function does NOT delegate to the
  -- core -- it is its own implementation -- so guarding only the core left the
  -- portal path open. And the booking form deriving the payment mode from the
  -- COD amount is not a guard: client_book_parcel is SECURITY DEFINER and any
  -- authenticated merchant can call the RPC directly with whatever it likes.
  -- client_book_parcel_geo delegates here, so it is covered by this.
  if public.nv_is_payment_conflict(p_payment_mode, p_cod) then
    raise exception
      'This parcel is marked "%" but carries a COD amount of Rs %. A prepaid parcel collects nothing at the door. Set COD to 0, or change the payment mode to COD.',
      btrim(p_payment_mode), trim(to_char(p_cod, 'FM999,999,999'))
      using errcode = 'P0001';
  end if;

  -- Only ever 'Yes' or 'No' — never free text on a rider-facing instruction.
  v_allow := case when lower(coalesce(btrim(p_allow_open), 'no')) in ('yes','true','y','1')
                  then 'Yes' else 'No' end;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || v_client_id::text));

  v_code   := lpad(right(regexp_replace(v_client_id::text, '\D', '', 'g'), 3), 3, '0');
  v_prefix := 'N' || v_code;
  select coalesce(max(substring(pa.awb from length(v_prefix) + 1)::int), 0)
    into v_max
    from public.parcels pa
   where pa.awb ~ ('^' || v_prefix || '[0-9]+$');
  v_awb := v_prefix || lpad((v_max + 1)::text, 4, '0');

  select c.rate, c.rate_card into v_rate, v_rate_card
    from public.clients c where c.id = v_client_id;
  v_rate := coalesce(v_rate, 250);

  v_zone := case when lower(coalesce(p_city, '')) = 'karachi' then 'A' else 'B' end;
  if v_rate_card is not null and jsonb_typeof(v_rate_card -> v_zone) = 'object' then
    v_base      := coalesce((v_rate_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_rate_card is not null and (v_rate_card ->> 'overnight') is not null then
    v_base      := coalesce((v_rate_card ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card ->> 'additionalKg')::numeric, 85);
  else
    v_base      := v_rate;
    v_addl_rate := 85;
  end if;

  v_weight_kg := coalesce(nullif(regexp_replace(coalesce(p_weight, ''), '[^0-9.]', '', 'g'), '')::numeric, 0.8);
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;
  v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_fee      := v_base + (v_extra_kg * v_addl_rate);

  v_meta := jsonb_build_object(
    'source',      'client_portal',
    'pickupCity',  coalesce(p_pickup_city, ''),
    'service',     coalesce(p_service, ''),
    'category',    coalesce(p_category, ''),
    'fragile',     coalesce(p_fragile, 'No'),
    'weight',      coalesce(p_weight, '0.8 kg'),
    'paymentMode', coalesce(p_payment_mode, 'COD'),
    'orderId',     coalesce(p_order_id, ''),
    'referenceNo', coalesce(p_reference_no, ''),
    'allowOpen',   v_allow,                       -- NEW
    'branch',      coalesce(nullif(btrim(p_pickup_city), ''), 'Karachi') || ' Hub',
    'stage',       0,
    'totalStages', 16,
    'steps',       jsonb_build_array('New booked'),
    'statusSince', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.parcels (
    awb, client_id, consignee, phone, address, city, status,
    cod_amount, fee, booked_at, updated_at, meta
  ) values (
    v_awb, v_client_id, btrim(p_consignee), coalesce(p_phone, ''),
    coalesce(p_address, ''), coalesce(p_city, ''), 'New booked',
    coalesce(p_cod, 0), v_fee, v_now, v_now, v_meta
  )
  returning * into v_row;

  return v_row;
end;
$function$



-- ── 5. the admin invoiceable list called a conflict 'prepaid' ─────────────
CREATE OR REPLACE FUNCTION public.admin_invoiceable_parcels(p_client_id uuid)
 RETURNS TABLE(awb text, consignee text, city text, status text, cod_amount numeric, fee numeric, kind text, booked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return query
    select p.awb, coalesce(p.consignee,''), coalesce(p.city,''), p.status,
           coalesce(p.cod_amount,0), coalesce(p.fee,0),
           case
             when public.is_return_chargeable(p.status) then 'return'
             -- A parcel carrying a COD amount AND a prepaid marking was labelled
             -- 'prepaid' here, so the admin pick-list described the exact
             -- contradiction that loses money as if it were settled. It is now
             -- named for what it is; admin_generate_invoice* refuse it anyway,
             -- but the list should not tell the admin something untrue first.
             -- Uses the canonical predicate, not a fourth copy of the regex.
             when public.nv_is_payment_conflict(p.meta->>'paymentMode', p.cod_amount) then 'conflict'
             when public.nv_is_prepaid_mode(p.meta->>'paymentMode') then 'prepaid'
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
$function$



-- ── 6. the edit path: the guard missed the only value the UI can send ─────
CREATE OR REPLACE FUNCTION public.nv_edit_parcel_core(p_client_id uuid, p_awb text, p_consignee text, p_phone text, p_address text, p_city text, p_cod numeric, p_weight text, p_category text, p_fragile text, p_service text, p_payment_mode text, p_allow_open text, p_order_id text, p_comments text DEFAULT NULL::text, p_actor text DEFAULT 'portal'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row  public.parcels%rowtype;
  v_meta jsonb;
  v_hist jsonb;
  v_len  int;
begin
  if p_client_id is null then
    raise exception 'You are not signed in as a merchant.' using errcode = '28000';
  end if;

  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = p_client_id
   for update;

  if not found then
    raise exception 'That parcel is not on your account.' using errcode = 'P0002';
  end if;

  if coalesce(v_row.status, '') <> 'New booked' then
    raise exception
      'This parcel is already "%", so it can no longer be edited. Open a support ticket and our team will change it for you.',
      v_row.status using errcode = 'P0001';
  end if;
  if v_row.invoice_id is not null then
    raise exception 'This parcel has already been invoiced, so it can no longer be edited.' using errcode = 'P0001';
  end if;
  if coalesce(v_row.rider_id::text, '') <> '' then
    raise exception 'A rider is already assigned to collect this parcel, so it can no longer be edited.' using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_consignee, '')) = '' then
    raise exception 'Consignee name cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_phone, '')) = '' then
    raise exception 'Consignee phone cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_address, '')) = '' then
    raise exception 'Delivery address cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_city, '')) = '' then
    raise exception 'Destination city cannot be empty.' using errcode = 'P0001';
  end if;
  if p_cod is null or p_cod < 0 then
    raise exception 'COD amount must be zero or more.' using errcode = 'P0001';
  end if;

  -- Prepaid is only ever a thing when nothing is being collected at the door.
  -- This was a hand-written list: ('prepaid','non cod','noncod','non-cod').
  -- The edit form's dropdown sends 'Non COD Prepaid', which is the one value
  -- that list does NOT contain -- so the single option a merchant can actually
  -- pick fell straight through the guard, raised nothing, and was then thrown
  -- away by the paymentMode derivation below. Hayat Scents reported it as
  -- "I set it to Prepaid, save, and it still shows COD."
  -- Fifth copy of the rule, now the canonical one.
  if p_cod > 0 and public.nv_is_prepaid_mode(p_payment_mode) then
    raise exception
      'A prepaid parcel cannot have a COD amount. Set cod to 0 for prepaid, or leave the payment mode as COD.'
      using errcode = 'P0001';
  end if;

  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  v_hist := coalesce(v_meta -> 'editHistory', '[]'::jsonb);
  v_hist := v_hist || jsonb_build_array(jsonb_build_object(
    'at',   to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'by',   coalesce(auth.uid()::text, p_actor),
    'via',  p_actor,
    'from', jsonb_build_object('consignee', v_row.consignee, 'phone', v_row.phone,
                               'address', v_row.address, 'city', v_row.city,
                               'cod', v_row.cod_amount, 'weight', v_meta ->> 'weight'),
    'to',   jsonb_build_object('consignee', btrim(p_consignee), 'phone', btrim(p_phone),
                               'address', btrim(p_address), 'city', btrim(p_city),
                               'cod', p_cod, 'weight', btrim(coalesce(p_weight, '')))
  ));
  v_len := jsonb_array_length(v_hist);
  if v_len > 20 then
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_hist
      from jsonb_array_elements(v_hist) with ordinality as t(e, i)
     where i > v_len - 20;
  end if;

  v_meta := v_meta || jsonb_build_object(
    'weight',       btrim(coalesce(p_weight, '')),
    'category',     btrim(coalesce(p_category, '')),
    'fragile',      case when btrim(coalesce(p_fragile, '')) = 'Yes' then 'Yes' else 'No' end,
    'service',      nullif(btrim(coalesce(p_service, '')), ''),
    -- Derived, not taken from the form, and deliberately so: prepaid is only
    -- ever true when nothing is collected at the door. The guard above now
    -- rejects the contradiction loudly instead of letting this line silently
    -- overwrite what the merchant chose. Kept as a derivation so no caller,
    -- present or future, can store a mode that disagrees with the amount.
    'paymentMode',  case when p_cod > 0 then 'COD' else 'Non COD' end,
    'allowOpen',    case when btrim(coalesce(p_allow_open, '')) = 'Yes' then 'Yes' else 'No' end,
    'orderId',      btrim(coalesce(p_order_id, '')),
    'editHistory',  v_hist,
    'lastEditedAt', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI')
  );

  -- p_comments null means "not supplied, leave whatever is there".
  -- An empty string means "clear it", which is a thing a merchant may want.
  if p_comments is not null then
    v_meta := v_meta || jsonb_build_object('comments', btrim(p_comments));
  end if;

  perform set_config('novax.parcel_edit', '1', true);

  update public.parcels
     set consignee  = btrim(p_consignee),
         phone      = btrim(p_phone),
         address    = btrim(p_address),
         city       = btrim(p_city),
         cod_amount = p_cod,
         meta       = v_meta,
         updated_at = now()
   where id = v_row.id;
  -- fee is NOT in this list, and must never be added to it.

  return jsonb_build_object('ok', true, 'awb', v_row.awb);
end
$function$


