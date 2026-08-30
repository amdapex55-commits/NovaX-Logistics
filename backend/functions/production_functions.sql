-- ===========================================================================
-- NovaX production function definitions -- snapshot from the live database
--
-- WHY THIS FILE EXISTS
--   183 functions live in the public schema. 83 had their definition in a repo
--   .sql file; the other 106 existed ONLY inside the deployed database --
--   including admin_mark_withdrawal_paid, admin_push_invoice_to_wallet,
--   admin_settle_client_dues and admin_reconcile_wallet_balances, all of which
--   move money. They could not be read, reviewed, diffed or restored from
--   source. That was the single largest blind spot in this codebase.
--
--   This is a SNAPSHOT for review and disaster recovery, not the authority.
--   The database remains the authority until each of these is migrated into a
--   real migration file. Regenerate with scripts/dump-db-functions.sh.
--
--   Scanned for secrets before committing: no JWTs, no service_role strings,
--   no bearer tokens or API keys appear in any of these bodies.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.admin_client_due_detail(p_client_id uuid)
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, due_amount numeric, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_client_due_payments(p_client_id uuid)
 RETURNS TABLE(id uuid, amount numeric, method text, reference text, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_generate_invoice(p_client_id uuid, p_awbs text[])
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, net_payable numeric, due_to_novax numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_generate_invoice_v2(p_client_id uuid, p_awbs text[], p_net_returns boolean DEFAULT true)
 RETURNS TABLE(invoice_id uuid, invoice_code text, invoice_type text, cod_total numeric, fee_total numeric, net_payable numeric, due_to_novax numeric, return_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
;

CREATE OR REPLACE FUNCTION public.admin_generate_shopify_link(p_client_id uuid, p_store_domain text DEFAULT NULL::text)
 RETURNS TABLE(intake_token text, has_secret boolean, store_url text, disabled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_client_dues()
 RETURNS TABLE(client_id uuid, client_name text, due_invoiced numeric, due_paid numeric, outstanding numeric, due_invoice_count integer, oldest_due_at timestamp with time zone, oldest_due_age_days integer, last_payment_at timestamp with time zone, wallet_balance numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_error_logs(p_limit integer DEFAULT 200)
 RETURNS SETOF portal_error_logs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.portal_error_logs
  where public.is_staff_admin()
  order by created_at desc
  limit greatest(1, coalesce(p_limit, 200));
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_notifications(p_status text DEFAULT NULL::text, p_channel text DEFAULT NULL::text, p_client_id uuid DEFAULT NULL::uuid, p_awb text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS TABLE(id uuid, client_id uuid, client_name text, awb text, channel text, event_type text, recipient text, status text, payload jsonb, error text, created_at timestamp with time zone, sent_at timestamp with time zone, retry_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_shopify_connections()
 RETURNS TABLE(client_id uuid, client_name text, store_url text, intake_token text, has_secret boolean, has_admin_token boolean, disabled boolean, last_order_at timestamp with time zone, last_order_awb text, last_signature_fail_at timestamp with time zone, last_error text, last_event text, imported_count integer, connection_status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_wallet_balances()
 RETURNS TABLE(client_id uuid, client_name text, wallet_balance numeric, pending_payout numeric, lifetime_paid numeric, dues_outstanding numeric, net_position numeric, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_mark_invoice_paid(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_mark_notification_sent(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.notification_events
  set status = 'manual', sent_at = now()
  where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_mark_withdrawal_paid(p_withdrawal_id uuid, p_txn_id text, p_paid_by text, p_proof text DEFAULT NULL::text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_parcel_audit(p_awb text)
 RETURNS TABLE(action text, changes jsonb, actor_role text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_processing_access_debug()
 RETURNS TABLE(uid uuid, email text, profile_role text, profile_status text, staff_row_id uuid, staff_role text, staff_status text, staff_permissions jsonb, matched_by_auth_user_id boolean, matched_by_email boolean, can_process boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_processing_lookup(p_awbs text[])
 RETURNS TABLE(id uuid, awb text, client_id uuid, consignee text, phone text, address text, city text, status text, cod_amount numeric, fee numeric, rider_id uuid, booked_at timestamp with time zone, updated_at timestamp with time zone, exception text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_processing_update_status(p_awbs text[], p_status text, p_rider_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, awb text, client_id uuid, consignee text, phone text, address text, city text, status text, cod_amount numeric, fee numeric, rider_id uuid, booked_at timestamp with time zone, updated_at timestamp with time zone, exception text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_push_invoice_to_wallet(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reconcile_wallet_balances()
 RETURNS TABLE(client_id uuid, old_balance numeric, new_balance numeric, corrected numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_record_due_payment(p_client_id uuid, p_amount numeric, p_method text DEFAULT 'Manual'::text, p_reference text DEFAULT ''::text, p_note text DEFAULT ''::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_regenerate_shopify_intake(p_client_id uuid)
 RETURNS TABLE(intake_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reject_wallet_withdrawal(p_withdrawal_id uuid, p_reason text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_request_wallet_withdrawal(p_client_id uuid, p_amount numeric, p_iban text, p_speed text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reset_shopify_secret(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_resolve_error_log(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.portal_error_logs set resolved = true where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_retry_notification(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.notification_events
  set status = 'pending', retry_count = retry_count + 1, error = null
  where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_search_clients(p_query text DEFAULT ''::text)
 RETURNS TABLE(client_id uuid, client_name text, city text, phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_set_shopify_disabled(p_client_id uuid, p_disabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_set_store_credentials(p_client_id uuid, p_platform text, p_store_url text, p_consumer_key text, p_consumer_secret text)
 RETURNS TABLE(intake_token text, webhook_secret text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_settle_client_dues(p_client_id uuid, p_note text DEFAULT 'Settled manually by admin'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_system_health_snapshot()
 RETURNS TABLE(metric text, value text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select 'latest_shopify_import_at'::text, max(last_order_at)::text from public.store_secrets where public.is_staff_admin()
  union all
  select 'latest_shopify_import_awb'::text, (select last_order_awb from public.store_secrets where last_order_awb is not null order by last_order_at desc nulls last limit 1) where public.is_staff_admin()
  union all
  select 'latest_withdrawal_status'::text, (select status from public.withdrawals order by created_at desc limit 1) where public.is_staff_admin()
  union all
  select 'latest_invoice_status'::text, (select status from public.invoices order by created_at desc limit 1) where public.is_staff_admin();
$function$
;

CREATE OR REPLACE FUNCTION public.admin_update_parcel_details(p_awb text, p_consignee text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_cod numeric DEFAULT NULL::numeric, p_fee numeric DEFAULT NULL::numeric, p_weight text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_payment_mode text DEFAULT NULL::text, p_note text DEFAULT ''::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row       public.parcels;
  v_changes   jsonb := '{}'::jsonb;
  v_meta      jsonb;
  v_end_state boolean := false;
  v_other     int;
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
  -- END STATE: the delivery fee stays correctable, everything else does not.
  -- A parcel that has been delivered still gets its charge disputed or
  -- mis-rated, and ops had no way to correct it without cancelling an invoice
  -- that does not exist yet. Consignee, phone, address, city, COD and weight
  -- are facts about a delivery that already happened, so those stay frozen.
  -- The invoice check above is untouched and still absolute: once a parcel is
  -- invoiced its fee has been netted into that invoice and, since
  -- sql_novax_invoice_wallet_truth.sql, into the merchant's wallet -- moving
  -- it there would desync money that has already been settled.
  v_end_state := v_row.status in ('Delivered', 'Parcel returned to consignee');

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
  if p_weight is not null and btrim(p_weight) <> ''
     and btrim(p_weight) is distinct from coalesce(v_meta->>'weight','') then
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

  -- Enforced on the real change set, not on what was submitted: the form
  -- posts every field every time, so "they only touched the fee" can only be
  -- decided after each value has been compared with what is already stored.
  if v_end_state then
    select count(*) into v_other from jsonb_object_keys(v_changes) k where k <> 'fee';
    if v_other > 0 or p_category is not null or p_payment_mode is not null then
      raise exception
        'This parcel is % -- only the delivery fee can be corrected now. Attempted: %',
        v_row.status, (select string_agg(k, ', ') from jsonb_object_keys(v_changes) k);
    end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_wallet_summary()
 RETURNS TABLE(client_id uuid, client_name text, wallet_balance numeric, pending_withdrawals numeric, paid_withdrawals_total numeric, ledger_expected_balance numeric, mismatch boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.build_weekly_digests()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_week_start date := (date_trunc('week', now()) - interval '1 week')::date;
  v_week_end   date := date_trunc('week', now())::date;
  v_count      integer := 0;
begin
  insert into public.client_digests (
    client_id, week_start, delivered_count, cod_collected, fees_paid,
    best_city, worst_city, headline
  )
  select
    c.id,
    v_week_start,
    coalesce(d.delivered_count, 0),
    coalesce(d.cod_collected, 0),
    coalesce(f.fees_paid, 0),
    d.best_city,
    d.worst_city,
    case
      when coalesce(d.delivered_count, 0) = 0
        then 'No deliveries completed last week.'
      else coalesce(d.delivered_count, 0) || ' parcels delivered, '
           || to_char(coalesce(d.cod_collected, 0), 'FM999,999,999') || ' PKR collected.'
    end
  from public.clients c
  left join lateral (
    select
      count(*) filter (where p.status = 'Delivered')::int as delivered_count,
      coalesce(sum(p.cod_amount) filter (where p.status = 'Delivered'), 0) as cod_collected,
      (select p2.city from public.parcels p2
        where p2.client_id = c.id
          and p2.status = 'Delivered'
          and p2.updated_at >= v_week_start
          and p2.updated_at <  v_week_end
        group by p2.city order by count(*) desc limit 1) as best_city,
      (select p3.city from public.parcels p3
        where p3.client_id = c.id
          and p3.status in ('Refused', 'Consignee not available')
          and p3.updated_at >= v_week_start
          and p3.updated_at <  v_week_end
        group by p3.city order by count(*) desc limit 1) as worst_city
    from public.parcels p
    where p.client_id = c.id
      and p.updated_at >= v_week_start
      and p.updated_at <  v_week_end
  ) d on true
  left join lateral (
    select coalesce(sum(w.fee), 0) as fees_paid
      from public.withdrawals w
     where w.client_id = c.id
       and w.created_at >= v_week_start
       and w.created_at <  v_week_end
  ) f on true
  -- AUDIT FIX (medium): without this, every dormant merchant got a
  -- "Your week in review" card telling them they did nothing, and the
  -- table grew by one row per client per week forever.
  where exists (
    select 1 from public.parcels p2
     where p2.client_id = c.id
       and p2.updated_at >= v_week_start
       and p2.updated_at <  v_week_end
  )
  on conflict (client_id, week_start) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.can_process_orders()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    public.is_admin()
    or public.is_staff_admin()
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.status::text, 'active')) = 'active'
        and lower(coalesce(p.role::text, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
    )
    or exists (
      select 1
      from public.staff_users su
      where (
        su.auth_user_id = auth.uid()
        or (su.email is not null and lower(su.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      )
      and lower(coalesce(su.status, 'Active')) = 'active'
      and (
        lower(coalesce(su.role, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
        or lower(coalesce(su.staff_role, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
        or su.permissions @> '"orders-processing"'::jsonb
        or su.permissions @> '["orders-processing"]'::jsonb
      )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.claim_ticket(p_ticket_id uuid, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff public.staff_users;
  v_cur   uuid;
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can claim tickets';
  end if;

  -- Default to the caller's own staff seat, resolved via auth_user_id.
  if p_staff_id is null then
    select * into v_staff from public.staff_users where auth_user_id = auth.uid() limit 1;
    if v_staff is null then
      raise exception 'No staff seat is linked to your login yet, so the ticket cannot be assigned to you';
    end if;
  else
    select * into v_staff from public.staff_users where id = p_staff_id;
    if v_staff is null then raise exception 'Staff user not found'; end if;
  end if;

  select assigned_to into v_cur from public.tickets where id = p_ticket_id;
  if v_cur is not null and v_cur <> v_staff.id then
    raise exception 'Ticket is already claimed by another agent. Release it first.';
  end if;

  update public.tickets
     set assigned_to = v_staff.id,
         assigned_at = now(),
         meta = meta || jsonb_build_object(
                  'assignedToName', v_staff.name, 'assignedToId', v_staff.id),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object('assigned_to', v_staff.id, 'name', v_staff.name);
end $function$
;

CREATE OR REPLACE FUNCTION public.client_bank_details()
 RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_bank jsonb;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  select meta->'bank' into v_bank from public.clients where id = v_client_id;
  if v_bank is null or v_bank = 'null'::jsonb then
    return;
  end if;

  holder_name := v_bank->>'holderName';
  iban := v_bank->>'iban';
  bank_name := v_bank->>'bankName';
  updated_at := nullif(v_bank->>'updatedAt','')::timestamptz;
  return next;
end;
$function$
;

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
;

CREATE OR REPLACE FUNCTION public.client_book_parcel_geo(p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_allow_open text DEFAULT 'No'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row    public.parcels;
  v_client uuid;
  v_origin uuid;
  v_quote  jsonb;
  v_cfg    public.novax_pricing_config;
begin
  -- 1. Book exactly as today. AWB series, advisory lock, flat fee, meta --
  --    all produced by the untouched original function.
  v_row := public.client_book_parcel(
    p_consignee, p_phone, p_pickup_city, p_city, p_address, p_cod, p_weight,
    p_service, p_category, p_fragile, p_payment_mode, p_order_id,
    p_reference_no, p_allow_open);

  v_client := v_row.client_id;
  select * into v_cfg from public.novax_pricing_config where id;

  -- 2. Resolve the origin: explicit, else the merchant's default pickup.
  v_origin := p_origin_area_id;
  if v_origin is null then
    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = v_client and l.is_default
     limit 1;
  end if;

  -- 3. Price by distance ONLY when it is switched on and fully resolvable.
  if coalesce(v_cfg.distance_enabled, false)
     and v_origin is not null and p_dest_area_id is not null
     and lower(coalesce(p_city, '')) = 'karachi' then

    v_quote := public.novax_quote_fee(
      v_client, p_city, p_weight, v_origin, p_dest_area_id, 'distance');

    if (v_quote ->> 'mode') = 'distance' then
      update public.parcels
         set fee            = (v_quote ->> 'fee')::numeric,
             quoted_fee     = (v_quote ->> 'fee')::numeric,
             distance_km    = nullif(v_quote ->> 'distance_km', '')::numeric,
             origin_area_id = v_origin,
             dest_area_id   = p_dest_area_id,
             pricing_mode   = 'distance',
             rate_version   = v_quote ->> 'rate_version',
             meta           = coalesce(meta, '{}'::jsonb) || jsonb_build_object('quote', v_quote)
       where id = v_row.id
      returning * into v_row;
      return v_row;
    end if;
  end if;

  -- 4. Not priced by distance. Record the areas and -- when they are known
  --    -- what distance pricing WOULD have charged. This is the shadow
  --    data that answers "is the new curve viable" before switching it on.
  --    The fee itself is not touched.
  if v_origin is not null and p_dest_area_id is not null
     and lower(coalesce(p_city, '')) = 'karachi' then
    v_quote := public.novax_quote_fee(
      v_client, p_city, p_weight, v_origin, p_dest_area_id, 'distance');
  else
    v_quote := null;
  end if;

  update public.parcels
     set origin_area_id = v_origin,
         dest_area_id   = p_dest_area_id,
         distance_km    = nullif(v_quote ->> 'distance_km', '')::numeric,
         pricing_mode   = case when v_quote is null then 'flat' else 'shadow' end,
         quoted_fee     = nullif(v_quote ->> 'fee', '')::numeric,
         rate_version   = coalesce(v_quote ->> 'rate_version', v_cfg.rate_version),
         meta           = case when v_quote is null then meta
                               else coalesce(meta, '{}'::jsonb) || jsonb_build_object('shadowQuote', v_quote) end
   where id = v_row.id
  returning * into v_row;

  return v_row;
end
$function$
;

CREATE OR REPLACE FUNCTION public.client_cancel_booking(p_awb text, p_reason text DEFAULT ''::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_row  public.parcels;
  v_now  timestamptz := now();
  v_note text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;

  if coalesce(btrim(p_awb), '') = '' then
    raise exception 'A tracking number is required to cancel a booking.';
  end if;

  -- Lock the row so two taps cannot both pass the status check.
  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = v_client_id
   for update;

  if not found then
    raise exception 'No booking with tracking number % was found on your account.', btrim(p_awb);
  end if;

  if v_row.status = 'Cancelled by client' then
    return v_row;                      -- already cancelled; idempotent
  end if;

  if v_row.status is distinct from 'New booked' then
    raise exception
      'This parcel can no longer be cancelled here - it is already "%". Once a rider has collected it, please contact NovaX support.',
      v_row.status;
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice, so it cannot be cancelled. Please contact NovaX support.';
  end if;

  -- Manifests store their contents as meta.parcels = ["AWB", "AWB", ...]
  -- (admin.html writes `parcels: parcels.map(p => p.awb)`). Belt-and-braces:
  -- manifesting also flips the status to "Parcel now in transit", so the
  -- status guard above would normally have caught it already.
  if exists (
        select 1 from public.manifest_logs m
         where jsonb_typeof(m.meta -> 'parcels') = 'array'
           and m.meta -> 'parcels' @> to_jsonb(array[v_row.awb::text])
      ) then
    raise exception 'This parcel is already on a manifest, so it cannot be cancelled here.';
  end if;

  v_note := nullif(btrim(p_reason), '');

  update public.parcels
     set status = 'Cancelled by client',
         meta = jsonb_set(
                  jsonb_set(
                    coalesce(meta, '{}'::jsonb),
                    '{steps}',
                    coalesce(meta->'steps', '[]'::jsonb) || to_jsonb('Cancelled by client'::text)
                  ),
                  '{cancelledByClient}',
                  jsonb_build_object(
                    'at',     to_char(v_now at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
                    'reason', coalesce(v_note, '')
                  )
                ),
         updated_at = v_now
   where id = v_row.id
   returning * into v_row;

  return v_row;
end
$function$
;

CREATE OR REPLACE FUNCTION public.client_fee_insights()
 RETURNS TABLE(payout_fees_month numeric, delivery_fees_month numeric, total_fees_month numeric, withdrawn_month numeric, cost_if_all_standard numeric, cost_if_all_instant numeric, potential_saving numeric, best_speed text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Payout fees actually charged this calendar month.
  -- AUDIT FIX (medium): this had no status filter, so REJECTED withdrawals
  -- counted as fees charged -- but admin_reject_wallet_withdrawal() refunds
  -- the full amount INCLUDING the fee back to wallet_balance. Pending ones
  -- have not been paid at all. Overstating fees to a paying merchant is
  -- exactly the trust failure this card exists to prevent, and it also
  -- inflated the "you would have saved Rs X" nudge. Paid only.
  select coalesce(sum(w.fee), 0), coalesce(sum(w.amount), 0)
    into payout_fees_month, withdrawn_month
    from public.withdrawals w
   where w.client_id = v_client_id
     and w.status = 'Paid'
     and date_trunc('month', w.created_at) = date_trunc('month', now());

  -- Delivery charges booked against this merchant this month.
  select coalesce(sum(p.fee), 0)
    into delivery_fees_month
    from public.parcels p
   where p.client_id = v_client_id
     and p.delivery_charge_posted_at is not null
     and date_trunc('month', p.delivery_charge_posted_at) = date_trunc('month', now());

  total_fees_month := coalesce(payout_fees_month, 0) + coalesce(delivery_fees_month, 0);

  -- What the SAME withdrawal volume would have cost at each speed.
  cost_if_all_standard := round(coalesce(withdrawn_month, 0) * 0.001);
  cost_if_all_instant  := round(coalesce(withdrawn_month, 0) * 0.007);

  potential_saving := greatest(coalesce(payout_fees_month, 0) - coalesce(cost_if_all_standard, 0), 0);

  best_speed := case
    when coalesce(withdrawn_month, 0) = 0 then null
    when payout_fees_month <= cost_if_all_standard then 'already_optimal'
    else 'standard'
  end;

  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_generate_shopify_link(p_store_domain text DEFAULT NULL::text)
 RETURNS TABLE(intake_token text, has_secret boolean, store_url text, disabled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_intake_token text;
  v_secret text;
  v_store_url text;
  v_disabled boolean;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  select s.intake_token, s.consumer_secret, s.store_url, s.disabled
    into v_intake_token, v_secret, v_store_url, v_disabled
    from public.store_secrets s where s.client_id = v_client_id and s.platform = 'shopify';

  if v_intake_token is null then
    v_intake_token := encode(extensions.gen_random_bytes(24), 'hex');
    v_store_url := coalesce(trim(p_store_domain), '');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (v_client_id, 'shopify', v_store_url, '', '', encode(extensions.gen_random_bytes(32), 'hex'), v_intake_token);
    v_secret := '';
    v_disabled := false;
  elsif p_store_domain is not null and length(trim(p_store_domain)) > 0 then
    update public.store_secrets set store_url = trim(p_store_domain), updated_at = now()
      where client_id = v_client_id and platform = 'shopify';
    v_store_url := trim(p_store_domain);
  end if;

  return query select v_intake_token, (v_secret is not null and length(v_secret) > 0), coalesce(v_store_url, ''), coalesce(v_disabled, false);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_get_notification_prefs()
 RETURNS client_notification_prefs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_row public.client_notification_prefs;
begin
  select client_id into v_client_id from public.profiles where id = auth.uid();
  if v_client_id is null then
    raise exception 'No client account linked to this login.';
  end if;
  insert into public.client_notification_prefs (client_id)
  values (v_client_id)
  on conflict (client_id) do nothing;
  select * into v_row from public.client_notification_prefs where client_id = v_client_id;
  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_pickup_location_save(p_id uuid DEFAULT NULL::uuid, p_label text DEFAULT 'Main pickup'::text, p_address text DEFAULT ''::text, p_city text DEFAULT 'Karachi'::text, p_area_id uuid DEFAULT NULL::uuid, p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric, p_default boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_id uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'Not signed in.'; end if;
  if p_area_id is not null and not exists (select 1 from public.novax_areas a where a.id = p_area_id) then
    raise exception 'That pickup area is not recognised.';
  end if;

  if p_id is not null then
    update public.client_pickup_locations
       set label = coalesce(nullif(btrim(p_label), ''), label),
           address = coalesce(p_address, address),
           city = coalesce(nullif(btrim(p_city), ''), city),
           area_id = p_area_id,
           lat = p_lat, lng = p_lng,
           verified_at = case when p_lat is not null then now() else verified_at end,
           updated_at = now()
     where id = p_id and client_id = v_client
     returning id into v_id;
    if v_id is null then raise exception 'Pickup location not found on your account.'; end if;
  else
    insert into public.client_pickup_locations (client_id, label, address, city, area_id, lat, lng, verified_at)
    values (v_client, coalesce(nullif(btrim(p_label), ''), 'Main pickup'), coalesce(p_address, ''),
            coalesce(nullif(btrim(p_city), ''), 'Karachi'), p_area_id, p_lat, p_lng,
            case when p_lat is not null then now() else null end)
    returning id into v_id;
  end if;

  -- Exactly one default, enforced here as well as by the unique index.
  if coalesce(p_default, false) then
    update public.client_pickup_locations set is_default = false
     where client_id = v_client and id <> v_id and is_default;
    update public.client_pickup_locations set is_default = true where id = v_id;
  end if;

  return v_id;
end
$function$
;

CREATE OR REPLACE FUNCTION public.client_pickup_locations_list()
 RETURNS TABLE(id uuid, label text, address text, city text, area_id uuid, area_name text, lat numeric, lng numeric, is_default boolean, verified_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then return; end if;
  return query
    select l.id, l.label, l.address, l.city, l.area_id, a.name, l.lat, l.lng, l.is_default, l.verified_at
      from public.client_pickup_locations l
      left join public.novax_areas a on a.id = l.area_id
     where l.client_id = v_client
     order by l.is_default desc, l.created_at;
end
$function$
;

CREATE OR REPLACE FUNCTION public.client_set_notification_prefs(p_whatsapp boolean, p_sms boolean, p_email boolean, p_events jsonb)
 RETURNS client_notification_prefs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_row public.client_notification_prefs;
begin
  select client_id into v_client_id from public.profiles where id = auth.uid();
  if v_client_id is null then
    raise exception 'No client account linked to this login.';
  end if;
  insert into public.client_notification_prefs (client_id, whatsapp_enabled, sms_enabled, email_enabled, events, updated_at)
  values (v_client_id, coalesce(p_whatsapp, true), coalesce(p_sms, false), coalesce(p_email, true), coalesce(p_events, '[]'::jsonb), now())
  on conflict (client_id) do update set
    whatsapp_enabled = coalesce(p_whatsapp, public.client_notification_prefs.whatsapp_enabled),
    sms_enabled = coalesce(p_sms, public.client_notification_prefs.sms_enabled),
    email_enabled = coalesce(p_email, public.client_notification_prefs.email_enabled),
    events = coalesce(p_events, public.client_notification_prefs.events),
    updated_at = now();
  select * into v_row from public.client_notification_prefs where client_id = v_client_id;
  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_set_shopify_admin_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  update public.store_secrets
    set consumer_key = coalesce(trim(p_token), ''), updated_at = now()
    where client_id = v_client_id and platform = 'shopify';

  if not found then
    raise exception 'Generate the Shopify link first.';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_set_shopify_secret(p_secret text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'Paste the Shopify signing secret first.';
  end if;

  update public.store_secrets
    set consumer_secret = trim(p_secret), last_error = null, updated_at = now()
    where client_id = v_client_id and platform = 'shopify';

  if not found then
    raise exception 'Generate the Shopify link first.';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_set_store_credentials(p_platform text, p_store_url text, p_consumer_key text, p_consumer_secret text)
 RETURNS TABLE(intake_token text, webhook_secret text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_intake_token text;
  v_webhook_secret text;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  if p_platform is null or p_store_url is null or p_consumer_key is null or p_consumer_secret is null then
    raise exception 'Store URL, consumer key, and consumer secret are all required.';
  end if;

  select intake_token, webhook_secret into v_intake_token, v_webhook_secret
    from public.store_secrets where client_id = v_client_id and platform = p_platform;

  if v_intake_token is null then
    v_intake_token := encode(gen_random_bytes(24), 'hex');
    v_webhook_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.store_secrets (client_id, platform, store_url, consumer_key, consumer_secret, webhook_secret, intake_token)
    values (v_client_id, p_platform, p_store_url, p_consumer_key, p_consumer_secret, v_webhook_secret, v_intake_token);
  else
    update public.store_secrets
      set store_url = p_store_url, consumer_key = p_consumer_key, consumer_secret = p_consumer_secret, updated_at = now()
      where client_id = v_client_id and platform = p_platform;
  end if;

  if exists (select 1 from public.store_connections where client_id = v_client_id and platform = p_platform) then
    update public.store_connections
      set store_url = p_store_url, connected = true,
          meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('hasCreds', true, 'connectedAt', now()::text)
      where client_id = v_client_id and platform = p_platform;
  else
    insert into public.store_connections (client_id, platform, store_url, connected, meta)
    values (v_client_id, p_platform, p_store_url, true, jsonb_build_object('hasCreds', true, 'connectedAt', now()::text));
  end if;

  return query select v_intake_token, v_webhook_secret;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_shopify_status()
 RETURNS TABLE(intake_token text, has_secret boolean, has_admin_token boolean, store_url text, disabled boolean, last_order_at timestamp with time zone, last_order_awb text, last_signature_fail_at timestamp with time zone, last_error text, last_event text, imported_count integer, connection_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := my_client_id();
  if v_client_id is null then
    raise exception 'No client account found for this login.';
  end if;

  return query
    select s.intake_token,
           (s.consumer_secret is not null and length(s.consumer_secret) > 0),
           (s.consumer_key is not null and length(s.consumer_key) > 0),
           coalesce(s.store_url, ''),
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
           end
    from public.store_secrets s
    where s.client_id = v_client_id and s.platform = 'shopify';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_smart_insights()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_out       jsonb := '[]'::jsonb;
  v_stuck     jsonb;
  r           record;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- ---- Insight 1: destination cities where failure rate has spiked. -----
  -- Requires at least 8 parcels in the recent window and 12 in the
  -- baseline, so a merchant with 3 parcels never gets a scary "300%
  -- increase" alert off statistical noise.
  for r in
    select city,
           recent_fail, recent_total, base_fail, base_total,
           round((recent_fail::numeric / nullif(recent_total, 0)) * 100) as recent_pct,
           round((base_fail::numeric   / nullif(base_total, 0))   * 100) as base_pct
      from (
        select p.city,
               count(*) filter (
                 where p.booked_at >= now() - interval '7 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as recent_fail,
               count(*) filter (where p.booked_at >= now() - interval '7 days') as recent_total,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
                   and p.status in ('Refused', 'Consignee not available', 'Out of service area')
               ) as base_fail,
               count(*) filter (
                 where p.booked_at <  now() - interval '7 days'
                   and p.booked_at >= now() - interval '35 days'
               ) as base_total
          from public.parcels p
         where p.client_id = v_client_id
           and p.booked_at >= now() - interval '35 days'
           and coalesce(p.city, '') <> ''
         group by p.city
      ) s
     where recent_total >= 8
       and base_total   >= 12
       and (recent_fail::numeric / nullif(recent_total, 0))
           > (base_fail::numeric / nullif(base_total, 0)) * 1.5
       and (recent_fail::numeric / nullif(recent_total, 0)) >= 0.15
     order by recent_fail desc
     limit 3
  loop
    v_out := v_out || jsonb_build_object(
      'kind',     'anomaly_city',
      'severity', case when r.recent_pct >= 30 then 'high' else 'medium' end,
      'title',    r.city || ': failed deliveries are up',
      'body',     'Failed or refused deliveries in ' || r.city || ' are running at '
                  || r.recent_pct || '% this week, against ' || r.base_pct
                  || '% over the previous four weeks (' || r.recent_fail
                  || ' of ' || r.recent_total || ' parcels).',
      'action',   'open_ticket'
    );
  end loop;

  -- ---- Insight 2: parcels that have not moved in over 72 hours. --------
  select jsonb_build_object(
           'kind',     'stuck_parcels',
           'severity', case when count(*) >= 5 then 'high' else 'medium' end,
           'title',    count(*) || ' parcel(s) have not moved in 3 days',
           'body',     'These parcels have had no status change for over 72 hours: '
                       || string_agg(t.awb, ', ' order by t.updated_at asc),
           'action',   'open_ticket'
         )
    into v_stuck
    from (
      select p.awb, p.updated_at
        from public.parcels p
       where p.client_id = v_client_id
         and p.status not in (
           'Delivered', 'Parcel returned to consignee', 'Ready for return',
           'Return received at origin'
         )
         and p.updated_at < now() - interval '72 hours'
       order by p.updated_at asc
       limit 10
    ) t
   having count(*) > 0;

  if v_stuck is not null then
    v_out := v_out || v_stuck;
  end if;

  return v_out;
exception
  -- An insight panel must never be able to take the dashboard down.
  -- AUDIT FIX (low): but silently swallowing everything meant future
  -- schema drift here would be undetectable -- the panel would just stop
  -- appearing forever. Log it, then still fail safe.
  when others then
    raise warning 'client_smart_insights failed: %', sqlerrm;
    return '[]'::jsonb;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_wallet_summary()
 RETURNS TABLE(available_balance numeric, pending_payout numeric, paid_this_month numeric, lifetime_withdrawn numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  select coalesce(c.wallet_balance,0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Pending admin payout'), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'
      and date_trunc('month', coalesce(w.paid_at, w.created_at)) = date_trunc('month', now())), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'), 0)
  into available_balance, pending_payout, paid_this_month, lifetime_withdrawn
  from public.clients c where c.id = v_client_id;

  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.consignee_history(p_phone text)
 RETURNS TABLE(total_parcels integer, delivered_count integer, refused_count integer, last_status text, last_city text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_phone     text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Normalise to digits so 0300-1234567 / +923001234567 / 03001234567 all
  -- match the same customer.
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_phone) < 7 then
    return;  -- too short to be a real number; stay silent
  end if;
  v_phone := right(v_phone, 10);

  select count(*)::int,
         count(*) filter (where p.status = 'Delivered')::int,
         count(*) filter (where p.status in ('Refused', 'Parcel returned to consignee'))::int
    into total_parcels, delivered_count, refused_count
    from public.parcels p
   where p.client_id = v_client_id
     and right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_phone;

  if coalesce(total_parcels, 0) = 0 then
    return;
  end if;

  select p.status, p.city
    into last_status, last_city
    from public.parcels p
   where p.client_id = v_client_id
     and right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_phone
   order by p.booked_at desc nulls last
   limit 1;

  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_existing_client_id uuid;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id into v_existing_client_id from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.clients (
    name, owner, meta, phone, business_type, address, city, website,
    status, wallet_balance, rate, rate_card, pricing_mode, risk_score
  )
  values (
    coalesce(nullif(btrim(p_name), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    coalesce(nullif(btrim(p_owner), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    jsonb_build_object('email', coalesce(v_email, '')),
    coalesce(p_phone, ''), coalesce(p_business_type, ''), coalesce(p_address, ''), coalesce(p_city, ''), coalesce(p_website, ''),
    'Active', 0,
    200,                                     -- was 250
    jsonb_build_object(                      -- was absent, so v_base fell to rate
      'A', jsonb_build_object('overnight', 200, 'additionalKg', 85),
      'B', jsonb_build_object('overnight', 200, 'additionalKg', 85)
    ),
    'flat',                                  -- never ask, never per-km
    0
  )
  returning id into v_client_id;

  insert into public.profiles (id, email, role, status, client_id)
  values (v_uid, v_email, 'client', 'active', v_client_id)
  on conflict (id) do update
    set email = coalesce(public.profiles.email, excluded.email),
        role = 'client',
        status = 'active',
        client_id = excluded.client_id;

  return v_client_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_new_booked_parcel(p_awb text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row       public.parcels;
  v_client_id uuid;
  v_is_admin  boolean;
begin
  v_is_admin  := public.is_admin();
  v_client_id := public.my_client_id();

  select * into v_row from public.parcels where awb = btrim(p_awb) limit 1;
  if v_row.awb is null then
    raise exception 'That parcel no longer exists.';
  end if;

  if not v_is_admin then
    if v_client_id is null or v_row.client_id is distinct from v_client_id then
      raise exception 'You can only delete parcels booked on your own account.';
    end if;
  end if;

  if v_row.status <> 'New booked' then
    raise exception 'Only a parcel still in "New booked" can be deleted. This one is "%" -- raise a ticket instead.', v_row.status;
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice and cannot be deleted.';
  end if;

  insert into public.parcel_admin_audit (awb, client_id, action, snapshot, actor_id, actor_role)
  values (v_row.awb, v_row.client_id, 'deleted', to_jsonb(v_row), auth.uid(),
          case when v_is_admin then 'admin' else 'client' end);

  delete from public.parcels where awb = v_row.awb;
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_parcel_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_allowed text[];
begin
  -- Admins AND any authorized order-processing staff keep full flexibility
  -- to correct/override status -- this is exactly what admin_processing_
  -- update_status relies on to move a parcel through every stage.
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;
  -- No status change on this update -- nothing to validate.
  if new.status is not distinct from old.status then
    return new;
  end if;
  v_allowed := case old.status
    when 'New booked' then array['Collected by rider','Cancelled by client']
    when 'Collected by rider' then array['Arrived at warehouse']
    when 'Arrived at warehouse' then array['Parcel now in transit']
    when 'Parcel now in transit' then array['Parcel received at destination']
    when 'Parcel received at destination' then array['Parcel out for delivery']
    when 'Parcel out for delivery' then array['Delivered','Refused','Consignee not available']
    when 'Refused' then array['Reattempt','Ready for return']
    when 'Consignee not available' then array['Reattempt','Ready for return']
    when 'Reattempt' then array['Parcel out for delivery','Ready for return']
    when 'Reassigned' then array['Parcel out for delivery']
    when 'Out of service area' then array['Reattempt','Ready for return']
    when 'Ready for return' then array['Return in transit']
    when 'Return in transit' then array['Return received at origin']
    when 'Return received at origin' then array['Return out for delivery']
    when 'Return out for delivery' then array['Return to shipper','Consignee not available']
    else array[]::text[]
  end;
  if not (new.status = any(v_allowed)) then
    raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_ticket_from_issue(p_source_key text, p_client_id uuid, p_subject text, p_body text, p_tier text DEFAULT 'medium'::text, p_from text DEFAULT 'System Monitor'::text, p_to text DEFAULT 'Admin Control'::text, p_branch text DEFAULT 'Admin'::text, p_awb text DEFAULT ''::text, p_age_hours numeric DEFAULT 0, p_escalated boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id        uuid;
  v_escalated boolean;
  v_to        text;
  v_code      text;
  v_limit     numeric;
begin
  if p_source_key is null or p_source_key = '' then
    raise exception 'ensure_ticket_from_issue requires a sourceKey';
  end if;

  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);

  -- Reopen-safe: an already-open ticket for this sourceKey is refreshed,
  -- never duplicated. A resolved one is left alone so closed work does
  -- not silently come back to life.
  select id into v_id
    from public.tickets
   where meta->>'sourceKey' = p_source_key
     and status <> 'Resolved'
   limit 1;

  v_escalated := p_escalated or coalesce(p_age_hours, 0) >= v_limit;
  v_to := case when v_escalated then 'Admin Control' else p_to end;

  if v_id is not null then
    update public.tickets t
       set meta = t.meta
                  || jsonb_build_object(
                       'ageHours', greatest(coalesce((t.meta->>'ageHours')::numeric, 0), coalesce(p_age_hours, 0)),
                       'escalated', coalesce((t.meta->>'escalated')::boolean, false) or v_escalated
                     )
                  || case when v_escalated then jsonb_build_object('to', 'Admin Control') else '{}'::jsonb end,
           escalated_at = coalesce(t.escalated_at, case when v_escalated then now() else null end),
           updated_at = now()
     where t.id = v_id;
    return v_id;
  end if;

  -- Human-readable code in the same TCK-0000 shape the browsers generate.
  v_code := 'TCK-' || lpad(((select count(*) from public.tickets) + 1)::text, 4, '0');

  insert into public.tickets (client_id, subject, body, status, first_response_at, meta)
  values (
    p_client_id, p_subject, p_body, 'Open', null,
    jsonb_build_object(
      'code', v_code, 'sourceKey', p_source_key,
      'tier', case when v_escalated then 'emergency' else coalesce(p_tier, 'medium') end,
      'from', p_from, 'to', v_to, 'branch', p_branch, 'awb', coalesce(p_awb, ''),
      'ageHours', coalesce(p_age_hours, 0), 'escalated', v_escalated,
      'replies', '[]'::jsonb, 'source', 'sla-cron'
    )
  )
  on conflict ((meta->>'sourceKey')) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.tickets where meta->>'sourceKey' = p_source_key limit 1;
  end if;

  if v_escalated and v_id is not null then
    update public.tickets set escalated_at = coalesce(escalated_at, now()) where id = v_id;
  end if;

  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.generate_channel_awb(p_client_id uuid, p_prefix text DEFAULT 'WOO'::text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  v_awb text;
  v_exists boolean;
begin
  loop
    v_awb := p_prefix || upper(substr(replace(p_client_id::text,'-',''),1,4)) || to_char(now(),'YYMMDDHH24MISS') || lpad(floor(random()*100)::text,2,'0');
    select exists(select 1 from public.parcels where awb = v_awb) into v_exists;
    exit when not v_exists;
  end loop;
  return v_awb;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::novax_role, 'client')
  )
  on conflict (id) do nothing;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.invite_internal_staff_user(p_name text, p_email text, p_role text)
 RETURNS TABLE(id uuid, name text, email text, role text, status text, last_active_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role   text;
  v_email  text;
  v_name   text;
  v_new_id uuid;
begin
  if not public.is_staff_admin() then
    raise exception 'Only NovaX admin/ops accounts can invite internal staff.' using errcode = '42501';
  end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_role  := initcap(btrim(coalesce(p_role, '')));

  if v_name is null then
    raise exception 'A name is required for the new team member.' using errcode = '22023';
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if v_role not in ('Owner', 'Admin', 'Ops', 'Finance', 'Warehouse', 'Support') then
    raise exception 'Role must be Owner, Admin, Ops, Finance, Warehouse or Support.' using errcode = '22023';
  end if;

  -- Same cross-tenant protection as invite_staff_user(): one seat per email,
  -- whether that seat is internal or belongs to a merchant's own team.
  if exists (select 1 from public.staff_users su where lower(su.email) = v_email) then
    raise exception 'That email already has an account on NovaX.' using errcode = '23505';
  end if;

  insert into public.staff_users (
    name, email, role, access_side, client_id, permissions, status,
    invited_by, invited_at, created_at, updated_at
  ) values (
    v_name, v_email, v_role, 'staff', null, '[]'::jsonb, 'Pending',
    auth.uid(), now(), now(), now()
  )
  returning staff_users.id into v_new_id;

  return query
    select su.id, su.name, su.email, su.role, su.status, su.last_active_at
    from public.staff_users su
    where su.id = v_new_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.invite_staff_user(p_name text, p_email text, p_role text)
 RETURNS TABLE(id uuid, name text, email text, role text, status text, last_active_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_role      text;
  v_email     text;
  v_name      text;
  v_new_id    uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can invite team members.' using errcode = '42501';
  end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_role  := initcap(btrim(coalesce(p_role, '')));

  if v_name is null then
    raise exception 'A name is required for the new team member.' using errcode = '22023';
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if v_role not in ('Owner', 'Finance', 'Warehouse', 'Support') then
    raise exception 'Role must be Owner, Finance, Warehouse or Support.' using errcode = '22023';
  end if;

  -- Never let an invite land on an email that already has a seat anywhere,
  -- and never let one workspace attach a seat that belongs to another.
  if exists (select 1 from public.staff_users su where lower(su.email) = v_email) then
    raise exception 'That email already has an account on NovaX.' using errcode = '23505';
  end if;

  insert into public.staff_users (
    name, email, role, access_side, client_id, permissions, status,
    invited_by, invited_at, created_at, updated_at
  ) values (
    v_name, v_email, v_role, 'client', v_client_id, '[]'::jsonb, 'Pending',
    auth.uid(), now(), now(), now()
  )
  returning staff_users.id into v_new_id;

  return query
    select su.id, su.name, su.email, su.role, su.status, su.last_active_at
    from public.staff_users su
    where su.id = v_new_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select exists(select 1 from profiles p where p.id = auth.uid() and p.role = 'admin');
$function$
;

CREATE OR REPLACE FUNCTION public.is_client_owner_seat()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.my_client_id() is not null
     and (
       -- No seat row yet => the account that owns the workspace is the owner.
       not exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
       )
       or exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
           and lower(coalesce(su.role, '')) = 'owner'
           and coalesce(su.status, 'Active') <> 'Revoked'
       )
     );
$function$
;

CREATE OR REPLACE FUNCTION public.is_return_chargeable(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(p_status,'') in (
    'Refused',
    'Ready for return',
    'Return in transit',
    'Return received at origin',
    'Return to shipper',            -- current name, written since the v1 rename
    'Parcel returned to consignee', -- legacy name, kept so pre-rename rows still bill
    'Out of service area'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_staff_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role::text in ('admin','ops')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.log_portal_error(p_source text, p_rpc_name text DEFAULT NULL::text, p_page text DEFAULT NULL::text, p_message text DEFAULT ''::text, p_severity text DEFAULT 'warning'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_email text;
  v_recent_count int;
  v_source text;
  v_rpc_name text;
  v_page text;
  v_message text;
  v_severity text;
begin
  v_email := coalesce(auth.jwt() ->> 'email', null);
  select client_id into v_client_id from public.profiles where id = auth.uid();

  -- Basic anonymous spam mitigation: if this is an unauthenticated caller,
  -- and the exact same source+rpc+message has already been logged in the
  -- last 60 seconds, skip the insert instead of flooding the table.
  if auth.uid() is null then
    select count(*) into v_recent_count
    from public.portal_error_logs
    where client_id is null
      and source = case when p_source in ('client','admin','rider') then p_source else 'client' end
      and coalesce(rpc_name,'') = coalesce(p_rpc_name,'')
      and message = coalesce(nullif(trim(p_message), ''), 'Unknown error')
      and created_at > now() - interval '60 seconds';
    if v_recent_count > 0 then
      return;
    end if;
  end if;

  -- Truncate all free-text fields defensively -- callers are untrusted input.
  v_source := case when p_source in ('client','admin','rider') then p_source else 'client' end;
  v_rpc_name := left(coalesce(p_rpc_name,''), 120);
  v_page := left(coalesce(p_page,''), 200);
  v_message := left(coalesce(nullif(trim(p_message), ''), 'Unknown error'), 500);
  v_severity := case when p_severity in ('info','warning','critical') then p_severity else 'warning' end;

  insert into public.portal_error_logs (source, rpc_name, page, client_id, user_email, message, severity)
  values (v_source, v_rpc_name, v_page, v_client_id, v_email, v_message, v_severity);
exception when others then
  -- Error logging must never itself throw and break the caller's page.
  null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_digest_read(p_digest_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    return false;
  end if;
  update public.client_digests
     set read_at = now()
   where id = p_digest_id
     and client_id = v_client_id
     and read_at is null;
  return found;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.my_client_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select client_id from profiles where id = auth.uid();
$function$
;

CREATE OR REPLACE FUNCTION public.my_rider_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select rider_id from profiles where id = auth.uid();
$function$
;

CREATE OR REPLACE FUNCTION public.novax_area_distance_km(p_from uuid, p_to uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_km numeric; v_factor numeric; v_a record; v_b record;
begin
  if p_from is null or p_to is null then return null; end if;

  select o.km into v_km
    from public.novax_area_distance_overrides o
   where (o.from_area_id = p_from and o.to_area_id = p_to)
      or (o.from_area_id = p_to   and o.to_area_id = p_from)
   limit 1;
  if v_km is not null then return v_km; end if;

  select ar.lat, ar.lng into v_a from public.novax_areas ar where ar.id = p_from;
  select ar.lat, ar.lng into v_b from public.novax_areas ar where ar.id = p_to;
  if v_a is null or v_b is null then return null; end if;

  select pc.road_factor into v_factor from public.novax_pricing_config pc where pc.id;
  v_factor := coalesce(v_factor, 1.35);

  v_km := public.novax_haversine_km(v_a.lat, v_a.lng, v_b.lat, v_b.lng) * v_factor;
  -- Floor of 1.5 km: an intra-area drop is still a real trip, and a
  -- near-zero distance would price below the cost of making it.
  return round(greatest(coalesce(v_km, 0), 1.5), 2);
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_areas_list(p_city text DEFAULT 'Karachi'::text)
 RETURNS TABLE(id uuid, city text, name text, aliases text[], lat numeric, lng numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select a.id, a.city, a.name, a.aliases, a.lat, a.lng
    from public.novax_areas a
   where a.active
     and (p_city is null or lower(a.city) = lower(p_city))
   order by a.sort, a.name;
$function$
;

CREATE OR REPLACE FUNCTION public.novax_client_default_pickup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_area uuid;
begin
  if lower(coalesce(new.city, '')) <> 'karachi' then return new; end if;
  if exists (select 1 from public.client_pickup_locations l where l.client_id = new.id) then return new; end if;

  begin
    v_area := public.novax_resolve_area('Karachi', new.address);
  exception when others then
    v_area := null;
  end;

  if v_area is null then return new; end if;

  begin
    insert into public.client_pickup_locations (client_id, label, address, city, area_id, is_default)
    values (new.id, 'Main pickup', coalesce(new.address, ''), 'Karachi', v_area, true);
  exception when others then
    -- Signup must never fail because of pricing setup.
    raise notice 'NovaX: could not create default pickup for client % (%)', new.id, sqlerrm;
  end;
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_cod_reset_get()
 RETURNS TABLE(reset_at timestamp with time zone, reset_by text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (public.is_admin() or public.can_process_orders()) then
    raise exception 'Admin or order-processing access required.';
  end if;
  return query
    select rs.reset_at, rs.reset_by
      from public.novax_cod_day_resets rs
     order by rs.reset_at desc
     limit 1;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_cod_reset_set(p_note text DEFAULT ''::text)
 RETURNS TABLE(reset_at timestamp with time zone, reset_by text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text;
  v_name  text;
  v_row   public.novax_cod_day_resets;
begin
  if not (public.is_admin() or public.can_process_orders()) then
    raise exception 'Admin or order-processing access required.';
  end if;

  v_email := coalesce(auth.jwt() ->> 'email',
                      (select pr.email from public.profiles pr where pr.id = auth.uid()), '');
  v_name  := coalesce(
    (select su.name from public.staff_users su where lower(su.email) = lower(v_email) limit 1),
    nullif(v_email, ''), 'Staff');

  insert into public.novax_cod_day_resets (reset_by, note)
  values (v_name, coalesce(p_note, ''))
  returning * into v_row;

  return query select v_row.reset_at, v_row.reset_by;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_haversine_km(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  r  constant double precision := 6371.0088;   -- mean Earth radius, km
  a1 double precision; a2 double precision;
  dlat double precision; dlng double precision; h double precision;
begin
  if p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then
    return null;
  end if;
  a1   := radians(p_lat1::double precision);
  a2   := radians(p_lat2::double precision);
  dlat := radians((p_lat2 - p_lat1)::double precision);
  dlng := radians((p_lng2 - p_lng1)::double precision);
  h := sin(dlat / 2) ^ 2 + cos(a1) * cos(a2) * sin(dlng / 2) ^ 2;
  return round((2 * r * asin(least(1, sqrt(h))))::numeric, 3);
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_parcel_autoprice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cfg    public.novax_pricing_config;
  v_origin uuid;
  v_dest   uuid;
  v_quote  jsonb;
begin
  if new.pricing_mode is not null then return new; end if;
  if lower(coalesce(new.city, '')) <> 'karachi' then return new; end if;

  begin
    select * into v_cfg from public.novax_pricing_config where id;
    if not coalesce(v_cfg.distance_enabled, false) then return new; end if;

    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = new.client_id and l.is_default
     limit 1;
    if v_origin is null then return new; end if;

    v_dest := public.novax_resolve_area('Karachi', new.address);
    if v_dest is null then return new; end if;

    v_quote := public.novax_quote_fee(
      new.client_id, new.city,
      coalesce(new.meta ->> 'weight', '0.8 kg'),
      v_origin, v_dest, 'distance');

    if (v_quote ->> 'mode') = 'distance' then
      new.fee            := (v_quote ->> 'fee')::numeric;
      new.quoted_fee     := (v_quote ->> 'fee')::numeric;
      new.distance_km    := nullif(v_quote ->> 'distance_km', '')::numeric;
      new.origin_area_id := v_origin;
      new.dest_area_id   := v_dest;
      new.pricing_mode   := 'distance-auto';   -- distinguishable from a merchant's explicit pick
      new.rate_version   := v_quote ->> 'rate_version';
      new.meta           := coalesce(new.meta, '{}'::jsonb) || jsonb_build_object('quote', v_quote, 'areaSource', 'address');
    end if;
  exception when others then
    -- Pricing must never block a booking.
    raise notice 'NovaX autoprice skipped for %: %', new.awb, sqlerrm;
  end;
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_pricing_config_get()
 RETURNS novax_pricing_config
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select * from public.novax_pricing_config where id; $function$
;

CREATE OR REPLACE FUNCTION public.novax_pricing_config_set(p_enabled boolean DEFAULT NULL::boolean, p_base numeric DEFAULT NULL::numeric, p_included_km numeric DEFAULT NULL::numeric, p_per_km numeric DEFAULT NULL::numeric, p_max_fee numeric DEFAULT NULL::numeric, p_road_factor numeric DEFAULT NULL::numeric, p_rate_version text DEFAULT NULL::text)
 RETURNS novax_pricing_config
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.novax_pricing_config; v_who text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  v_who := coalesce(auth.jwt() ->> 'email', '');
  update public.novax_pricing_config
     set distance_enabled = coalesce(p_enabled, distance_enabled),
         base_fee         = coalesce(p_base, base_fee),
         included_km      = coalesce(p_included_km, included_km),
         per_km           = coalesce(p_per_km, per_km),
         max_fee          = coalesce(p_max_fee, max_fee),
         road_factor      = coalesce(p_road_factor, road_factor),
         rate_version     = coalesce(nullif(btrim(p_rate_version), ''), rate_version),
         updated_at = now(), updated_by = v_who
   where id
  returning * into v_row;
  return v_row;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_pricing_coverage()
 RETURNS TABLE(client_id uuid, client_name text, city text, address text, pickup_area text, on_distance boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
    select c.id, c.name, c.city, c.address, a.name,
           (a.id is not null and lower(coalesce(c.city,'')) = 'karachi')
      from public.clients c
      left join public.client_pickup_locations l on l.client_id = c.id and l.is_default
      left join public.novax_areas a on a.id = l.area_id
     order by (a.id is not null), c.name;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_pricing_shadow_report(p_days integer DEFAULT 30)
 RETURNS TABLE(parcels bigint, charged_total numeric, distance_total numeric, delta_total numeric, delta_pct numeric, avg_km numeric, cheaper_count bigint, dearer_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return query
  with s as (
    select p.fee::numeric as charged, p.quoted_fee::numeric as quoted, p.distance_km
      from public.parcels p
     where p.quoted_fee is not null
       and p.distance_km is not null
       and p.booked_at >= now() - make_interval(days => greatest(1, coalesce(p_days, 30))))
  select count(*)::bigint,
         round(coalesce(sum(charged), 0), 2),
         round(coalesce(sum(quoted), 0), 2),
         round(coalesce(sum(quoted) - sum(charged), 0), 2),
         case when coalesce(sum(charged), 0) = 0 then null
              else round(((sum(quoted) - sum(charged)) / sum(charged)) * 100, 1) end,
         round(coalesce(avg(distance_km), 0), 2),
         count(*) filter (where quoted < charged)::bigint,
         count(*) filter (where quoted > charged)::bigint
    from s;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_quote_booking(p_dest_city text, p_weight text DEFAULT '0.8 kg'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_origin uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  -- Default the origin to the merchant's default pickup point.
  v_origin := p_origin_area_id;
  if v_origin is null then
    select l.area_id into v_origin
      from public.client_pickup_locations l
     where l.client_id = v_client and l.is_default
     limit 1;
  end if;
  return public.novax_quote_fee(v_client, p_dest_city, p_weight, v_origin, p_dest_area_id, null);
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_resolve_area(p_city text, p_address text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select a.id
    from public.novax_areas a
   where a.active
     and a.auto_match
     and lower(a.city) = lower(coalesce(nullif(btrim(p_city), ''), 'Karachi'))
     and coalesce(p_address, '') <> ''
     and (
       p_address ~* ('(^|[^[:alnum:]])' || a.name || '([^[:alnum:]]|$)')
       or exists (
         select 1 from unnest(a.aliases) al
          -- Aliases shorter than 5 characters are too collision-prone for
          -- free-text matching ("nn", "site"). They still work in the
          -- merchant-facing picker; they just cannot auto-assign an origin.
          where length(al) >= 5
            and p_address ~* ('(^|[^[:alnum:]])' || al || '([^[:alnum:]]|$)')
       )
     )
   order by length(a.name) desc
   limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.novax_stamp_delivered_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Only on the FIRST transition into Delivered, and never overwritten.
  -- A parcel that somehow leaves and re-enters Delivered keeps its original
  -- timestamp: the cash was collected the first time.
  if new.status = 'Delivered'
     and coalesce(old.status, '') is distinct from 'Delivered'
     and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.novax_ticket_client_reply(p_ticket_id uuid, p_body text)
 RETURNS novax_ticket_replies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_t public.novax_tickets; v_row public.novax_ticket_replies; v_name text;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet.'; end if;
  if coalesce(btrim(p_body),'') = '' then raise exception 'Reply cannot be empty.'; end if;

  select * into v_t from public.novax_tickets where id = p_ticket_id and client_id = v_client;
  if not found then raise exception 'Ticket not found on your account.'; end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_ticket_replies (ticket_id, body, by_name, by_side)
  values (p_ticket_id, btrim(p_body), coalesce(v_name,''), 'client')
  returning * into v_row;

  -- A client reply reopens a ticket that was waiting on them.
  update public.novax_tickets
     set status = case when status = 'pending_client' then 'open' else status end,
         updated_at = now()
   where id = p_ticket_id;

  return v_row;
end $function$
;

CREATE OR REPLACE FUNCTION public.novax_ticket_code()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.code is null then
    new.code := 'TKT-' || lpad(nextval('public.novax_ticket_seq')::text, 6, '0');
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.novax_ticket_open(p_subject text, p_body text DEFAULT ''::text, p_awb text DEFAULT ''::text, p_priority text DEFAULT 'normal'::text)
 RETURNS novax_tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_row public.novax_tickets; v_name text; v_open int;
begin
  v_client := public.my_client_id();
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet.';
  end if;
  if coalesce(btrim(p_subject),'') = '' then
    raise exception 'Please describe the issue in one line.';
  end if;

  -- Cheap abuse guard. Not dedupe -- a merchant may legitimately have
  -- several open tickets; this only stops a runaway loop or a stuck button.
  select count(*) into v_open from public.novax_tickets
   where client_id = v_client and status <> 'resolved';
  if v_open >= 20 then
    raise exception 'You already have 20 open tickets. Please wait for those to be answered first.';
  end if;

  select name into v_name from public.clients where id = v_client;

  insert into public.novax_tickets (client_id, awb, subject, body, priority, opened_by, opened_by_name)
  values (v_client,
          nullif(btrim(p_awb),''),
          btrim(p_subject),
          coalesce(btrim(p_body),''),
          case when p_priority in ('low','normal','high') then p_priority else 'normal' end,
          'client',
          coalesce(v_name,''))
  returning * into v_row;

  return v_row;
end $function$
;

CREATE OR REPLACE FUNCTION public.novax_ticket_stamp_first_response()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.by_side = 'admin' then
    update public.novax_tickets
       set first_response_at = coalesce(first_response_at, new.created_at),
           updated_at = now()
     where id = new.ticket_id;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.novax_ticket_touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  if new.status = 'resolved' and coalesce(old.status,'') <> 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if new.status <> 'resolved' then
    new.resolved_at := null;
    new.resolved_by := '';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.nv_backfill_client_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m jsonb; ph text; ad text;
begin
  if new.client_id is null then return new; end if;

  select raw_user_meta_data into m from auth.users where id = new.id;
  if m is null then return new; end if;

  -- signup forms have used a few key spellings over time
  ph := nullif(btrim(coalesce(m->>'phone',   m->>'phone_number',
                              m->>'phoneNumber', m->>'contact', '')), '');
  ad := nullif(btrim(coalesce(m->>'address', m->>'pickup_address',
                              m->>'pickupAddress', m->>'street', '')), '');

  if ph is null and ad is null then return new; end if;

  update public.clients c
     set phone   = case when coalesce(btrim(c.phone),'')   = '' then coalesce(ph, c.phone)   else c.phone   end,
         address = case when coalesce(btrim(c.address),'') = '' then coalesce(ad, c.address) else c.address end
   where c.id = new.client_id;

  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.nv_enforce_pricing_mode()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_mode text;
begin
  if new.client_id is null then
    return new;
  end if;

  select pricing_mode into v_mode
  from public.clients where id = new.client_id;

  if v_mode is null then
    return new;
  end if;

  if v_mode = 'flat' then
    if new.pricing_mode is not null and new.pricing_mode like 'distance%' then
      raise exception
        'Client % is on flat pricing but this parcel was priced by distance. Booking refused rather than silently charging a rate the merchant did not choose.',
        new.client_id;
    end if;
    new.pricing_mode := 'flat';
    new.distance_km  := null;
  end if;

  if v_mode = 'distance'
     and lower(coalesce(new.city, '')) = 'karachi'
     and coalesce(new.pricing_mode, '') not like 'distance%' then
    raise exception
      'Client % chose per-kilometre pricing but this Karachi parcel was priced flat. Booking refused rather than charging a rate the merchant declined.',
      new.client_id;
  end if;

  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.parcels_guard_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;

  new.awb := old.awb;
  new.client_id := old.client_id;
  new.rider_id := old.rider_id;
  new.consignee := old.consignee;
  new.city := old.city;
  new.address := old.address;
  new.phone := old.phone;
  new.cod_amount := old.cod_amount;
  new.fee := old.fee;
  new.booked_at := old.booked_at;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.parcels_guard_tracking_token()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  -- AUDIT FIX (medium): gate on auth.uid() as well as is_admin(). Without
  -- this, a plain SQL / migration / backend session (no JWT, so is_admin()
  -- is false) was silently blocked from ever rotating or repairing a
  -- token -- which also made this file's own maintenance UPDATEs silent
  -- no-ops on a second run, breaking the "idempotent" promise at the top.
  if public.is_admin() or auth.uid() is null then
    return new;
  end if;
  -- A token, once issued, is permanent for non-admins. Prevents a merchant
  -- (or a compromised merchant session) rotating or clearing a tracking
  -- link, and prevents token guessing via forced writes.
  if old.tracking_token is not null then
    new.tracking_token := old.tracking_token;
  else
    -- AUDIT FIX: previously a null old-value let a merchant-supplied value
    -- through verbatim. Always regenerate instead.
    new.tracking_token := replace(replace(replace(
      encode(extensions.gen_random_bytes(16), 'base64'), '/', '_'), '+', '-'), '=', '');
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.parcels_set_tracking_token()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  -- AUDIT FIX (medium): generation used to be opt-out -- any actor able to
  -- INSERT a parcel could supply tracking_token='1' and defeat the whole
  -- "unguessable secret" property the two-tier tracking design rests on.
  -- Non-admins now ALWAYS get a server-generated token; only an admin may
  -- supply an explicit one (needed for data migration/repair).
  if not public.is_admin()
     or new.tracking_token is null
     or btrim(new.tracking_token) = '' then
    new.tracking_token := replace(replace(replace(
      encode(extensions.gen_random_bytes(16), 'base64'), '/', '_'), '+', '-'), '=', '');
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.queue_notification_event(p_client_id uuid, p_awb text, p_event_type text, p_recipient text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prefs public.client_notification_prefs;
begin
  if p_client_id is null or p_event_type is null then
    return;
  end if;

  -- Security: only staff/admin may queue a notification for an arbitrary
  -- client. A non-admin caller may only queue notifications for their own
  -- linked client -- otherwise any logged-in account could spam another
  -- client's WhatsApp/SMS/Email.
  if not public.is_staff_admin() and p_client_id is distinct from public.my_client_id() then
    return;
  end if;

  select * into v_prefs from public.client_notification_prefs where client_id = p_client_id;
  if v_prefs is null then
    return; -- client never set preferences yet; nothing to send
  end if;
  if not (v_prefs.events @> to_jsonb(p_event_type::text)) then
    return; -- client opted out of this event type
  end if;
  if v_prefs.whatsapp_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'whatsapp', p_event_type, p_recipient, p_payload);
  end if;
  if v_prefs.sms_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'sms', p_event_type, p_recipient, p_payload);
  end if;
  if v_prefs.email_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'email', p_event_type, p_recipient, p_payload);
  end if;
exception when others then
  -- Never let a notification-queue failure break the calling action.
  null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.release_ticket(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can release tickets';
  end if;
  update public.tickets
     set assigned_to = null, assigned_at = null,
         meta = (meta - 'assignedToName') - 'assignedToId',
         updated_at = now()
   where id = p_ticket_id;
  return jsonb_build_object('released', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_wallet_withdrawal(p_amount numeric, p_iban text, p_speed text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_balance numeric;
  v_fee numeric;
  v_net numeric;
  v_rate numeric;
  v_iban text;
  v_holder_name text;
  v_bank_name text;
  v_row public.withdrawals;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal amount must be greater than zero.';
  end if;

  -- NovaX fix (withdrawal UX v3): saved bank details are only a
  -- convenience/default now, never a hard lock -- p_iban is always what
  -- actually gets paid, whether it matches a saved account or is a brand
  -- new one the client typed/pasted for this withdrawal. It still gets the
  -- same normalization + validation as save_client_bank_details.
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN / bank account details are required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;
  if p_speed not in ('24h','12h','instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  -- Prevent duplicate rapid submissions (double-click / retry storms):
  -- one still-pending request per client per 15-second window.
  if exists (
    select 1 from public.withdrawals
    where client_id = v_client_id and status = 'Pending admin payout'
      and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'A withdrawal request was already submitted. Please wait a moment before trying again.';
  end if;

  -- holder_name/bank_name are read only to snapshot onto the withdrawal row
  -- for admin visibility if the client has saved them -- never required and
  -- never compared against p_iban.
  select coalesce(wallet_balance,0),
    btrim(coalesce(meta->'bank'->>'holderName','')),
    btrim(coalesce(meta->'bank'->>'bankName',''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients where id = v_client_id for update;
  if v_balance is null then
    raise exception 'Client wallet not found.';
  end if;
  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients set wallet_balance = v_balance - p_amount where id = v_client_id;

  insert into public.withdrawals (client_id, amount, fee, net, iban, speed, status, balance_before, holder_name, bank_name)
  values (v_client_id, p_amount, v_fee, v_net, v_iban, p_speed, 'Pending admin payout', v_balance, nullif(v_holder_name,''), nullif(v_bank_name,''))
  returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'withdrawal_requested', -p_amount, true, 'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested: Rs ' || p_amount || ' reserved, ' || v_net || ' net after Rs ' || v_fee || ' fee (' || p_speed || ').');
  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'payout_fee', -v_fee, false, 'Informational', 'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).');

  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.revoke_staff_user(p_staff_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_role      text;
  v_owners    int;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can revoke access.' using errcode = '42501';
  end if;

  select lower(coalesce(su.role, '')) into v_role
  from public.staff_users su
  where su.id = p_staff_id and su.client_id = v_client_id;

  if v_role is null then
    raise exception 'That team member was not found in your workspace.' using errcode = 'P0002';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owners
    from public.staff_users su
    where su.client_id = v_client_id
      and lower(coalesce(su.role, '')) = 'owner'
      and coalesce(su.status, 'Active') <> 'Revoked';
    if v_owners <= 1 then
      raise exception 'You cannot revoke the last Owner of the workspace.' using errcode = '42501';
    end if;
  end if;

  update public.staff_users
     set status = 'Revoked',
         permissions = '[]'::jsonb,
         updated_at = now()
   where id = p_staff_id
     and client_id = v_client_id;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text DEFAULT ''::text)
 RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_holder text;
  v_iban text;
  v_bank text;
  v_now timestamptz;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  v_holder := btrim(coalesce(p_holder_name, ''));
  if v_holder = '' then
    raise exception 'Account holder name is required.';
  end if;

  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN is required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;

  v_bank := btrim(coalesce(p_bank_name, ''));
  v_now := now();

  update public.clients
    set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{bank}', jsonb_build_object(
      'holderName', v_holder, 'iban', v_iban, 'bankName', v_bank, 'updatedAt', v_now
    ), true)
    where id = v_client_id;

  holder_name := v_holder; iban := v_iban; bank_name := v_bank; updated_at := v_now;
  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sla_elapsed_hours(p_from timestamp with time zone, p_to timestamp with time zone DEFAULT now())
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  cfg      public.support_hours;
  v_hours  numeric := 0;
  v_cursor timestamptz;
  v_local  timestamp;
  v_dow    int;
  v_hour   int;
  v_guard  int := 0;
begin
  if p_from is null then return 0; end if;
  if p_to <= p_from then return 0; end if;

  select * into cfg from public.support_hours where id = 1;
  if cfg is null or cfg.is_24_7 then
    return round(extract(epoch from (p_to - p_from)) / 3600.0, 2);
  end if;

  v_cursor := date_trunc('hour', p_from);
  while v_cursor < p_to and v_guard < 20000 loop
    v_guard := v_guard + 1;
    v_local := v_cursor at time zone cfg.timezone;
    v_dow   := extract(dow from v_local)::int;
    v_hour  := extract(hour from v_local)::int;
    if v_dow = any (cfg.work_days) and v_hour >= cfg.open_hour and v_hour < cfg.close_hour then
      v_hours := v_hours + 1;
    end if;
    v_cursor := v_cursor + interval '1 hour';
  end loop;

  return round(v_hours, 2);
end $function$
;

CREATE OR REPLACE FUNCTION public.submit_ticket_csat(p_ticket_id uuid, p_score smallint, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t         public.tickets;
  v_client  uuid;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'No client workspace resolved for your login'; end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select * into t from public.tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket not found'; end if;
  if t.client_id is distinct from v_client then
    raise exception 'That ticket does not belong to your workspace';
  end if;
  if t.status <> 'Resolved' then
    raise exception 'You can rate a ticket once it has been resolved';
  end if;
  if t.csat_score is not null then
    raise exception 'This ticket has already been rated';
  end if;

  update public.tickets
     set csat_score = p_score,
         csat_comment = nullif(trim(coalesce(p_comment,'')), ''),
         csat_at = now(),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object('ok', true, 'score', p_score);
end $function$
;

CREATE OR REPLACE FUNCTION public.ticket_effective_tier(p_ticket tickets)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_limit numeric;
  v_age   numeric;
begin
  if p_ticket.status = 'Resolved' then return 'resolved'; end if;
  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);
  v_age := public.sla_elapsed_hours(p_ticket.created_at, now());
  if coalesce((p_ticket.meta->>'escalated')::boolean, false) or v_age >= v_limit then
    return 'emergency';
  end if;
  return coalesce(nullif(p_ticket.meta->>'tier',''), 'medium');
end $function$
;

CREATE OR REPLACE FUNCTION public.ticket_mark_first_response(p_ticket_id uuid, p_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t public.tickets;
begin
  if not public.is_staff_admin() then
    raise exception 'Only support staff can record a first response';
  end if;

  select * into t from public.tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket not found'; end if;

  if t.first_response_at is not null then
    return jsonb_build_object(
      'already_set', true, 'first_response_at', t.first_response_at,
      'first_response_hours', public.sla_elapsed_hours(t.created_at, t.first_response_at)
    );
  end if;

  update public.tickets
     set first_response_at = now(),
         first_response_by = coalesce(p_by, 'admin'),
         meta = meta || jsonb_build_object(
                  'firstResponseHours', public.sla_elapsed_hours(t.created_at, now())),
         updated_at = now()
   where id = p_ticket_id;

  return jsonb_build_object(
    'already_set', false, 'first_response_at', now(),
    'first_response_hours', public.sla_elapsed_hours(t.created_at, now())
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.track_parcel_public(p_awb text)
 RETURNS TABLE(awb text, status text, city text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.awb, p.status, p.city, p.updated_at
  from public.parcels p
  where p.awb = upper(trim(p_awb))
  limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_post_non_cod_delivery_charge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_non_cod boolean;
begin
  v_is_non_cod := coalesce(NEW.meta->>'paymentMode', '') ~* 'non\s*cod|prepaid';

  if NEW.status = 'Delivered'
     and NEW.delivery_charge_posted_at is null
     and v_is_non_cod
     and coalesce(NEW.fee, 0) > 0
     and NEW.client_id is not null
  then
    NEW.delivery_charge_posted_at := now();

    update public.clients
      set wallet_balance = coalesce(wallet_balance, 0) - NEW.fee
      where id = NEW.client_id;

    insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
    values (NEW.client_id, 'delivery_charge_due', -NEW.fee, true, 'Delivery charge', 'parcel', NEW.id, NEW.awb,
      'Delivery charge for non-COD parcel ' || coalesce(NEW.awb, '') || ' collected from wallet balance.');
  end if;

  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.visitor_ping(p_session_id text, p_portal text, p_activity text, p_path text, p_referrer text, p_user_agent text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session_id text;
  v_portal text;
  v_activity text;
  v_path text;
  v_referrer text;
  v_user_agent text;
begin
  v_session_id := btrim(coalesce(p_session_id, ''));
  if v_session_id = '' then
    raise exception 'session_id is required.';
  end if;
  v_session_id := left(v_session_id, 100);

  v_portal := lower(btrim(coalesce(p_portal, '')));
  if v_portal not in ('index', 'client', 'admin', 'rider', 'tracking', 'reset', 'landing') then
    v_portal := 'index';
  end if;

  v_activity := left(coalesce(p_activity, ''), 200);
  v_path := left(coalesce(p_path, ''), 300);
  v_referrer := left(coalesce(p_referrer, ''), 300);
  v_user_agent := left(coalesce(p_user_agent, ''), 400);

  insert into public.visitor_sessions (session_id, portal, activity, path, referrer, user_agent, first_seen, last_seen)
  values (v_session_id, v_portal, v_activity, v_path, v_referrer, v_user_agent, now(), now())
  on conflict (session_id) do update
    set portal = excluded.portal,
        activity = excluded.activity,
        path = excluded.path,
        referrer = excluded.referrer,
        user_agent = excluded.user_agent,
        last_seen = now();
end;
$function$
;
