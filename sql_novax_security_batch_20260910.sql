begin;

-- NovaX security + money batch, 10 Sep 2026.
-- Each change names the finding it closes. Rehearsed inside BEGIN/ROLLBACK
-- against production before apply.

-- ================================================================ helpers
-- Weight: the first number, divided by 1000 when the unit is grams. The
-- inline parse stripped every non-digit, so "500 g" became 500 kg.
create or replace function public.nv_parse_weight_kg(p_weight text)
 returns numeric language plpgsql immutable set search_path to 'public'
as $function$
declare s text; n numeric;
begin
  s := lower(btrim(coalesce(p_weight, '')));
  begin
    n := nullif(substring(s from '([0-9]+(\.[0-9]+)?|\.[0-9]+)'), '')::numeric;
  exception when others then n := null;
  end;
  if n is null or n <= 0 then return 0.8; end if;
  if s ~ '[0-9.]\s*(g|gm|gms|gr|gram|grams)\s*$' then n := n / 1000; end if;
  return n;
end
$function$;

-- AWB counter. The next number used to be max(existing)+1, so deleting the
-- highest booking handed its AWB to the next shipment, and lpad(...,4) cut
-- 10000 down to "1000" -- a permanent duplicate-key failure at suffix 9999.
create table if not exists public.nv_awb_counters (
  prefix     text primary key,
  last_seq   bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.nv_awb_counters enable row level security;
revoke all on public.nv_awb_counters from anon, authenticated;

-- Seeded from live parcels AND the status log, which still holds the AWBs of
-- parcels that were deleted before this counter existed.
insert into public.nv_awb_counters (prefix, last_seq)
select prefix, max(seq) from (
  select substring(awb from 1 for 4) as prefix, substring(awb from 5)::bigint as seq
    from public.parcels where awb ~ '^N[0-9]{3}[0-9]+$'
  union all
  select substring(awb from 1 for 4), substring(awb from 5)::bigint
    from public.nv_parcel_status_log where awb ~ '^N[0-9]{3}[0-9]+$'
) x group by prefix
on conflict (prefix) do update set last_seq = greatest(public.nv_awb_counters.last_seq, excluded.last_seq);

create or replace function public.nv_next_awb(p_client_id uuid)
 returns text language plpgsql security definer set search_path to 'public'
as $function$
declare v_prefix text; v_max bigint; v_seq bigint; v_digits text;
begin
  v_prefix := 'N' || lpad(right(regexp_replace(p_client_id::text, '\D', '', 'g'), 3), 3, '0');
  -- Locked on the PREFIX, not the client: two clients whose ids end in the
  -- same three digits share a series, and a per-client lock let them race.
  perform pg_advisory_xact_lock(hashtext('novax_awb_prefix_' || v_prefix));
  select coalesce(max(substring(pa.awb from length(v_prefix) + 1)::bigint), 0) into v_max
    from public.parcels pa where pa.awb ~ ('^' || v_prefix || '[0-9]+$');
  insert into public.nv_awb_counters as c (prefix, last_seq) values (v_prefix, v_max + 1)
  on conflict (prefix) do update set last_seq = greatest(c.last_seq, v_max) + 1, updated_at = now()
  returning last_seq into v_seq;
  v_digits := v_seq::text;
  return v_prefix || case when length(v_digits) < 4 then lpad(v_digits, 4, '0') else v_digits end;
end
$function$;
revoke execute on function public.nv_next_awb(uuid) from public, anon, authenticated;

-- Webhook destinations. https alone let a merchant point our server at
-- loopback, link-local metadata or private ranges.
create or replace function public.nv_webhook_url_is_safe(p_url text)
 returns boolean language plpgsql immutable set search_path to 'public'
as $function$
declare v_auth text; h text;
begin
  if p_url is null or p_url !~* '^https://' then return false; end if;
  v_auth := split_part(split_part(split_part(substring(p_url from 9), '/', 1), '?', 1), '#', 1);
  if position('@' in v_auth) > 0 then return false; end if;
  if v_auth ~ '^\[' then return false; end if;
  if v_auth ~ ':' and v_auth !~ ':443$' then return false; end if;
  h := lower(regexp_replace(v_auth, ':443$', ''));
  if h = '' or h !~ '\.' then return false; end if;
  if not exists (select 1 from regexp_split_to_table(h, '\.') l where l !~ '^(0x[0-9a-f]+|[0-9]+)$') then
    return false;
  end if;
  if h = 'localhost' or h ~ '\.(localhost|local|internal|lan|home|corp|intranet)$' then return false; end if;
  if h ~ '(^|\.)rhzunbzbdzicajqtohwp\.supabase\.co$' or h ~ '\.pooler\.supabase\.com$' then return false; end if;
  return true;
end
$function$;

-- Idempotent portal booking. A booking that reached the server but whose
-- reply was lost came back as a second parcel when the merchant pressed Book
-- again. Only definer functions touch this table.
create table if not exists public.nv_booking_idempotency (
  client_id  uuid not null references public.clients(id) on delete cascade,
  idem_key   text not null,
  parcel_id  uuid references public.parcels(id) on delete set null,
  awb        text not null,
  created_at timestamptz not null default now(),
  primary key (client_id, idem_key)
);
alter table public.nv_booking_idempotency enable row level security;
revoke all on public.nv_booking_idempotency from anon, authenticated;

-- ---------------------------------------------------------------- handle_new_user
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
    -- NEVER read from raw_user_meta_data: signUp() lets the caller write any
    -- metadata it likes, and this column is what is_admin() trusts. Admins and
    -- riders are promoted afterwards by an admin, through profiles.
    'client'::novax_role
  )
  on conflict (id) do nothing;
  return new;
end $function$;

-- ---------------------------------------------------------------- can_process_orders
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
      -- A merchant's OWN team seats are not NovaX staff. A merchant can create
      -- an Active "Owner" or "Warehouse" seat themselves, and either role name
      -- used to pass here -- skipping every parcel guard for that merchant.
      and lower(coalesce(su.access_side, '')) not in ('client', 'client web portal')
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
$function$;

-- ---------------------------------------------------------------- parcels_guard_columns
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
  new.fee := old.fee;
  new.booked_at := old.booked_at;

  /* Consignee details and COD change in exactly one situation: the merchant
     correcting their own booking through nv_edit_parcel_core(), which re-checks
     ownership, status, invoicing and rider assignment and sets this
     transaction-local flag right before its UPDATE. nv_freeze_parcel_money
     still refuses COD once a parcel has moved. */
  if coalesce(current_setting('novax.parcel_edit', true), '') <> '1' then
    new.consignee := old.consignee;
    new.city := old.city;
    new.address := old.address;
    new.phone := old.phone;
    new.cod_amount := old.cod_amount;
  end if;

  /* Settlement state. invoice_id decides whether a parcel can be invoiced
     again; a merchant clearing it made the same parcel invoiceable twice. */
  new.invoice_id := old.invoice_id;
  new.invoiced_at := old.invoiced_at;
  new.delivery_charge_posted_at := old.delivery_charge_posted_at;

  /* Delivery evidence. "COD collected" in meta.steps makes a parcel
     invoiceable; cashReceived and deliveredBy are what the rider records at
     the door. Only the rider carrying the parcel may add them. */
  if not (old.rider_id is not null and old.rider_id = public.my_rider_id()) then
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
    new.meta := (coalesce(new.meta, '{}'::jsonb) - 'cashReceived' - 'deliveredBy')
                || jsonb_strip_nulls(jsonb_build_object(
                     'cashReceived', old.meta -> 'cashReceived',
                     'deliveredBy',  old.meta -> 'deliveredBy'));
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------- enforce_parcel_status_transition
CREATE OR REPLACE FUNCTION public.enforce_parcel_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_allowed text[];
  v_carrier boolean;
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
  /* Who is asking decides which moves exist. The sequence below is the
     physical journey: only the rider carrying the parcel, or the database
     itself (cron, service role -- no auth.uid()), walks it. A merchant session
     used to be able to walk it too, one legal step at a time, to Delivered. A
     merchant decides only what is theirs: cancel before pickup, and reattempt
     or return after a failed delivery. */
  v_carrier := auth.uid() is null
               or (old.rider_id is not null and old.rider_id = public.my_rider_id());
  if not v_carrier then
    v_allowed := case old.status
      when 'New booked' then array['Cancelled by client']
      when 'Refused' then array['Reattempt','Ready for return']
      when 'Consignee not available' then array['Reattempt','Ready for return']
      when 'Out of service area' then array['Reattempt','Ready for return']
      else array[]::text[]
    end;
    if not (new.status = any(v_allowed)) then
      raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
    end if;
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
$function$;

-- ---------------------------------------------------------------- admin_generate_invoice_v2
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
    -- Everything charged, minus everything collected. The old form only
    -- carried return/prepaid charges into what is owed, so a COD parcel whose
    -- own charge exceeded its COD (Rs 100 collected, Rs 220 charge) produced
    -- Rs 0 due and the Rs 120 shortfall vanished.
    v_due     := greatest(0, (v_cod_fee + v_due_fee) - v_cod_total);
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
  -- Same shortfall rule when returns are not netted.
  v_due     := v_due_fee + greatest(0, v_cod_fee - v_cod_total);
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
$function$;

-- ---------------------------------------------------------------- admin_generate_invoice
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
  -- A COD parcel whose charge exceeds its COD leaves the difference owed.
  v_due := v_due_fee + greatest(0, v_cod_fee - v_cod_total);
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
$function$;

-- ---------------------------------------------------------------- client_book_parcel
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

  -- 'Infinity' and 'NaN' are valid numerics in Postgres; neither is a COD.
  if p_cod is not null and (p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric) then
    raise exception 'COD amount must be a number, zero or more.' using errcode = 'P0001';
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

  v_awb := public.nv_next_awb(v_client_id);

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

  v_weight_kg := public.nv_parse_weight_kg(p_weight);
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
$function$;

-- ---------------------------------------------------------------- nv_book_parcel_core
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

  -- 'Infinity' and 'NaN' are valid numerics in Postgres; neither is a COD.
  if p_cod is not null and (p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric) then
    raise exception 'COD amount must be a number, zero or more.' using errcode = 'P0001';
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

  v_awb := public.nv_next_awb(p_client_id);

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

  v_weight_kg := public.nv_parse_weight_kg(p_weight);
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
$function$;

-- ---------------------------------------------------------------- novax_quote_fee
CREATE OR REPLACE FUNCTION public.novax_quote_fee(p_client_id uuid, p_dest_city text, p_weight text DEFAULT '0.8 kg'::text, p_origin_area_id uuid DEFAULT NULL::uuid, p_dest_area_id uuid DEFAULT NULL::uuid, p_force_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric;
  v_weight_charge numeric; v_fee numeric; v_flat_fee numeric;
  v_cfg public.novax_pricing_config;
  v_mode text; v_km numeric; v_billable_km numeric;
  v_distance_component numeric := 0; v_capped boolean := false;
  v_is_karachi boolean;
begin
  /* AUTHORIZATION. This is SECURITY DEFINER, granted to authenticated, and it
     reads clients.rate and clients.rate_card for whatever p_client_id the
     caller passes -- with no check that the caller owns it. Any logged-in
     merchant could read another merchant's negotiated rate and full rate card
     by supplying their UUID.

     A merchant may only quote for themselves. Admins and service-role callers
     (my_client_id() is null for both) keep the existing behaviour, which is
     what novax_quote_booking, client_book_parcel_geo, novax_parcel_autoprice
     and the merchant API all depend on.

     Raises rather than returning a wrong number: a quote silently computed
     against the wrong rate card is worse than a refusal. */
  if public.my_client_id() is not null
     and p_client_id is not null
     and p_client_id <> public.my_client_id()
     and not public.is_admin() then
    raise exception 'Not authorised to quote for another account.';
  end if;
  select * into v_cfg from public.novax_pricing_config where id;

  ---------------------------------------------------------------------
  -- FLAT: unchanged, byte for byte.
  ---------------------------------------------------------------------
  select c.rate, c.rate_card into v_rate, v_rate_card
    from public.clients c where c.id = p_client_id;
  v_rate := coalesce(v_rate, 250);

  v_zone := case when lower(coalesce(p_dest_city, '')) = 'karachi' then 'A' else 'B' end;

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

  begin
    v_weight_kg := public.nv_parse_weight_kg(p_weight);
  exception when others then
    v_weight_kg := 0.8;
  end;
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;

  v_extra_kg      := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_weight_charge := v_extra_kg * v_addl_rate;
  v_flat_fee      := v_base + v_weight_charge;

  ---------------------------------------------------------------------
  -- MODE: there is only one now.
  --
  -- This used to read p_force_mode first, then fall back to
  -- v_cfg.distance_enabled. Both routes to 'distance' are gone. The
  -- parameter is still accepted so existing callers -- including
  -- client_book_parcel_geo, which passes 'distance' -- keep working; it
  -- simply no longer changes the answer.
  ---------------------------------------------------------------------
  v_is_karachi := lower(coalesce(p_dest_city, '')) = 'karachi';
  v_mode := 'flat';
  v_fee  := v_flat_fee;

  return jsonb_build_object(
    'mode',             v_mode,
    'fee',              round(v_fee, 2),
    'flat_fee',         round(v_flat_fee, 2),
    'zone',             v_zone,
    'base',             round(coalesce(v_base, 0), 2),
    'weight_kg',        v_weight_kg,
    'extra_kg',         v_extra_kg,
    'weight_charge',    round(v_weight_charge, 2),
    'distance_km',      v_km,
    'billable_km',      v_billable_km,
    'per_km',           null,
    'included_km',      null,
    'distance_charge',  round(v_distance_component, 2),
    'capped',           v_capped,
    'rate_version',     coalesce(v_cfg.rate_version, 'flat-v1')
  );
end
$function$;

-- ---------------------------------------------------------------- nv_api_resolve_key_v2
CREATE OR REPLACE FUNCTION public.nv_api_resolve_key_v2(p_key text, p_is_booking boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_hash text; v_row public.nv_api_key; v_name text; v_now timestamptz := now();
begin
  v_hash := encode(extensions.digest(coalesce(p_key,''), 'sha256'), 'hex');
  -- FOR UPDATE: concurrent requests on one key used to read the same count,
  -- all pass the limit, and each write back count+1 -- admitting extra
  -- bookings and undercounting them. They now queue on the key row.
  select * into v_row from public.nv_api_key where key_hash = v_hash and not revoked for update;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_key'); end if;

  -- rolling hourly windows
  if v_row.rate_window_start is null or v_row.rate_window_start < v_now - interval '1 hour' then
    v_row.rate_window_start := v_now; v_row.rate_window_count := 0;
  end if;
  if v_row.book_window_start is null or v_row.book_window_start < v_now - interval '1 hour' then
    v_row.book_window_start := v_now; v_row.book_window_count := 0;
  end if;

  if v_row.rate_window_count >= v_row.rate_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'rate_limited',
      'limit', v_row.rate_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.rate_window_start + interval '1 hour' - v_now)))::int));
  end if;
  if p_is_booking and v_row.book_window_count >= v_row.book_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'booking_rate_limited',
      'limit', v_row.book_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.book_window_start + interval '1 hour' - v_now)))::int));
  end if;

  update public.nv_api_key
     set last_used_at = v_now,
         request_count = request_count + 1,
         rate_window_start = v_row.rate_window_start,
         rate_window_count = v_row.rate_window_count + 1,
         book_window_start = v_row.book_window_start,
         book_window_count = v_row.book_window_count + (case when p_is_booking then 1 else 0 end)
   where id = v_row.id;

  select name into v_name from public.clients where id = v_row.client_id;
  return jsonb_build_object('ok', true, 'client_id', v_row.client_id, 'client_name', v_name,
    'webhook_url', v_row.webhook_url, 'key_id', v_row.id);
end $function$;

-- ---------------------------------------------------------------- nv_edit_parcel_core
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
  v_expected text;
  v_exp  jsonb;
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

  /* Optimistic concurrency. A caller that says what it read -- the portal's
     edit form, the API's PATCH -- is refused if those fields changed since.
     Otherwise the second of two saves put back the old phone or address still
     sitting in its form, and both reported success. */
  v_expected := nullif(current_setting('novax.edit_expected', true), '');
  if v_expected is not null then
    v_exp := v_expected::jsonb;
    if (v_exp ? 'consignee' and btrim(coalesce(v_exp->>'consignee','')) is distinct from btrim(coalesce(v_row.consignee,'')))
       or (v_exp ? 'phone' and btrim(coalesce(v_exp->>'phone','')) is distinct from btrim(coalesce(v_row.phone,'')))
       or (v_exp ? 'address' and btrim(coalesce(v_exp->>'address','')) is distinct from btrim(coalesce(v_row.address,'')))
       or (v_exp ? 'city' and btrim(coalesce(v_exp->>'city','')) is distinct from btrim(coalesce(v_row.city,'')))
       or (v_exp ? 'cod' and nullif(v_exp->>'cod','')::numeric is distinct from coalesce(v_row.cod_amount, 0)) then
      raise exception 'This parcel was changed by someone else while you were editing it, so nothing was saved. Reload it and make your change again.' using errcode = 'P0001';
    end if;
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
  if p_cod is null or p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric then
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
$function$;

-- ---------------------------------------------------------------- nv_api_set_webhook_v2
CREATE OR REPLACE FUNCTION public.nv_api_set_webhook_v2(p_key_id uuid, p_url text, p_rotate boolean DEFAULT false)
 RETURNS TABLE(url text, secret text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_url is not null and p_url <> '' and p_url !~ '^https://' then
    raise exception 'Webhook URL must start with https://';
  end if;
  if nullif(btrim(p_url), '') is not null and not public.nv_webhook_url_is_safe(btrim(p_url)) then
    raise exception 'Webhook URL must be a public https address on port 443. Private, local and IP-address destinations are not allowed.';
  end if;
  update public.nv_api_key k
     set webhook_url = nullif(btrim(p_url), ''),
         webhook_secret = case
           when p_rotate then encode(extensions.gen_random_bytes(24),'hex')
           else coalesce(k.webhook_secret, encode(extensions.gen_random_bytes(24),'hex'))
         end
   where k.id = p_key_id and not k.revoked
   returning k.webhook_url, k.webhook_secret into url, secret;
  if not found then return; end if;
  return next;
end $function$;

-- ---------------------------------------------------------------- nv_api_set_webhook
CREATE OR REPLACE FUNCTION public.nv_api_set_webhook(p_key_id uuid, p_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_url is not null and p_url <> '' and p_url !~ '^https://' then
    raise exception 'Webhook URL must start with https://';
  end if;
  if nullif(btrim(p_url), '') is not null and not public.nv_webhook_url_is_safe(btrim(p_url)) then
    raise exception 'Webhook URL must be a public https address on port 443. Private, local and IP-address destinations are not allowed.';
  end if;
  update public.nv_api_key
     set webhook_url = nullif(btrim(p_url), ''),
         webhook_secret = coalesce(webhook_secret, encode(extensions.gen_random_bytes(24),'hex'))
   where id = p_key_id and not revoked;
  return found;
end $function$;

-- ---------------------------------------------------------------- admin_record_due_payment
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

  /* One payment per client at a time. Two submissions used to read the same
     outstanding balance, both pass, and both insert. */
  perform pg_advisory_xact_lock(hashtext('novax_due_' || p_client_id::text));

  if nullif(btrim(coalesce(p_reference, '')), '') is not null and exists (
       select 1 from public.client_due_payments d
        where d.client_id = p_client_id
          and lower(btrim(d.reference)) = lower(btrim(p_reference))) then
    raise exception 'A payment with reference "%" is already recorded for this client. Nothing was recorded twice.', btrim(p_reference);
  end if;
  if nullif(btrim(coalesce(p_reference, '')), '') is null and exists (
       select 1 from public.client_due_payments d
        where d.client_id = p_client_id and d.amount = p_amount
          and coalesce(d.reference, '') = '' and d.created_at > now() - interval '2 minutes') then
    raise exception 'The same amount was recorded for this client moments ago. If this really is a second payment, add its reference and record it again.';
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
$function$;

-- ---------------------------------------------------------------- admin_settle_client_dues
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

  -- Same lock as admin_record_due_payment: a double settle used to insert the
  -- full outstanding amount twice.
  perform pg_advisory_xact_lock(hashtext('novax_due_' || p_client_id::text));

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
$function$;

-- ---------------------------------------------------------------- admin_reconcile_wallet_balances
CREATE OR REPLACE FUNCTION public.admin_reconcile_wallet_balances()
 RETURNS TABLE(client_id uuid, old_balance numeric, new_balance numeric, corrected numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_old numeric;
  v_expected numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  /* Balance and ledger are read per client AFTER locking that client's row.
     They used to be read for every client up front and written back later, so
     a withdrawal or credit committed in between was overwritten with the
     stale figure. Withdrawals and credits update clients.wallet_balance in the
     same transaction as their ledger row, so they queue on this lock. */
  for r in select c.id as cid from public.clients c order by c.id
  loop
    select coalesce(c.wallet_balance, 0) into v_old
      from public.clients c where c.id = r.cid for update;
    select coalesce(sum(wl.amount), 0) into v_expected
      from public.wallet_ledger wl where wl.client_id = r.cid and wl.affects_balance;
    if v_old is distinct from v_expected then
      update public.clients set wallet_balance = v_expected where id = r.cid;
      insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, note)
      values (r.cid, 'admin_adjustment', v_expected - v_old, false, 'Reconciliation', 'reconciliation',
        'Automatic reconciliation: corrected clients.wallet_balance from Rs ' || v_old || ' to Rs ' || v_expected || ' to match wallet_ledger.');
      client_id := r.cid; old_balance := v_old; new_balance := v_expected; corrected := v_expected - v_old;
      return next;
    end if;
  end loop;
  return;
end;
$function$;

-- ================================================================ wrappers
create or replace function public.client_book_parcel_idem(
  p_idem_key text, p_consignee text, p_phone text, p_pickup_city text, p_city text,
  p_address text, p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_id text default ''::text,
  p_reference_no text default ''::text, p_allow_open text default 'No'::text,
  p_origin_area_id uuid default null, p_dest_area_id uuid default null)
 returns parcels language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_client uuid := public.my_client_id();
  v_key    text := left(btrim(coalesce(p_idem_key, '')), 200);
  v_hit    public.nv_booking_idempotency;
  v_row    public.parcels;
begin
  if v_client is null then
    raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.';
  end if;

  if v_key <> '' then
    perform pg_advisory_xact_lock(hashtext('novax_idem_' || v_client::text || ':' || v_key));
    select * into v_hit from public.nv_booking_idempotency
     where client_id = v_client and idem_key = v_key;
    -- An order ID is a lasting identity; a form fingerprint only covers the
    -- minutes in which a lost reply gets retried. A cancelled parcel does not
    -- block booking it again.
    if found and v_hit.created_at > now() - (case when v_key like 'order:%' then interval '24 hours' else interval '15 minutes' end) then
      select * into v_row from public.parcels
       where id = v_hit.parcel_id and client_id = v_client;
      if found and v_row.status is distinct from 'Cancelled by client' then
        return v_row;
      end if;
    end if;
  end if;

  if p_dest_area_id is not null then
    v_row := public.client_book_parcel_geo(p_consignee, p_phone, p_pickup_city, p_city, p_address,
      p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open, p_origin_area_id, p_dest_area_id);
  else
    v_row := public.client_book_parcel(p_consignee, p_phone, p_pickup_city, p_city, p_address,
      p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id,
      p_reference_no, p_allow_open);
  end if;

  if v_key <> '' then
    insert into public.nv_booking_idempotency (client_id, idem_key, parcel_id, awb)
    values (v_client, v_key, v_row.id, v_row.awb)
    on conflict (client_id, idem_key) do update
      set parcel_id = excluded.parcel_id, awb = excluded.awb, created_at = now();
  end if;
  return v_row;
end
$function$;
revoke execute on function public.client_book_parcel_idem(text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,uuid,uuid) from public, anon;
grant execute on function public.client_book_parcel_idem(text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,uuid,uuid) to authenticated, service_role;

create or replace function public.client_edit_new_booked_parcel_v2(
  p_awb text, p_consignee text, p_phone text, p_address text, p_city text, p_cod numeric,
  p_weight text, p_category text, p_fragile text, p_service text, p_payment_mode text,
  p_allow_open text, p_order_id text, p_expected jsonb default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if p_expected is not null then
    perform set_config('novax.edit_expected', p_expected::text, true);
  end if;
  return public.client_edit_new_booked_parcel(p_awb, p_consignee, p_phone, p_address, p_city,
    p_cod, p_weight, p_category, p_fragile, p_service, p_payment_mode, p_allow_open, p_order_id);
end
$function$;
revoke execute on function public.client_edit_new_booked_parcel_v2(text,text,text,text,text,numeric,text,text,text,text,text,text,text,jsonb) from public, anon;
grant execute on function public.client_edit_new_booked_parcel_v2(text,text,text,text,text,numeric,text,text,text,text,text,text,text,jsonb) to authenticated, service_role;

create or replace function public.nv_edit_parcel_core_v2(
  p_client_id uuid, p_awb text, p_consignee text, p_phone text, p_address text, p_city text,
  p_cod numeric, p_weight text, p_category text, p_fragile text, p_service text,
  p_payment_mode text, p_allow_open text, p_order_id text, p_comments text default null,
  p_actor text default 'portal'::text, p_expected jsonb default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if p_expected is not null then
    perform set_config('novax.edit_expected', p_expected::text, true);
  end if;
  return public.nv_edit_parcel_core(p_client_id, p_awb, p_consignee, p_phone, p_address, p_city,
    p_cod, p_weight, p_category, p_fragile, p_service, p_payment_mode, p_allow_open, p_order_id,
    p_comments, p_actor);
end
$function$;
revoke execute on function public.nv_edit_parcel_core_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.nv_edit_parcel_core_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text,jsonb) to service_role;

commit;
