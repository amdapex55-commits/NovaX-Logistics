-- NovaX full-system audit, 24 Sep 2026. Every item below was reproduced
-- against production inside BEGIN/ROLLBACK before this file was written.
--
-- 1. A merchant could INSERT a parcel straight into public.parcels through
--    PostgREST with any status, fee and evidence it liked. Rehearsed as KKM:
--      insert ... status 'Delivered', fee 0, cod_amount 50000,
--      meta.steps ["COD collected"], cashReceived 50000   -> INSERT 0 1
--    Nothing on the insert path guards those columns (the guards are
--    BEFORE UPDATE only), and admin_invoiceable_parcels() picks up any
--    parcel whose steps contain "COD collected". Every booking path is a
--    SECURITY DEFINER RPC owned by postgres (client_book_parcel*,
--    nv_book_parcel_core, nvsh_book_parcel, nv_book_parcel_api_idem,
--    admin_book_parcel_for_client), so none of them needs this policy;
--    client-app.js has not inserted into parcels directly since the
--    booking RPC landed (see its comment at "direct browser insert into
--    parcels is disabled"). Admin keeps parcels_admin_all.
--
-- 2. parcels_guard_columns() now also protects delivered_at and
--    meta.paymentMode from direct merchant writes (see comments inline).
--
-- 3. create_client_workspace() demoted any existing admin/staff/rider
--    profile to role 'client' when that login called it.
--
-- 4. rider_batch_update_status() looks parcels up by upper(awb), twice per
--    AWB, which the plain awb index cannot serve -- a sequential scan of
--    every parcel per scanned AWB, up to 400 per batch.
--
-- 5. Three AFTER UPDATE triggers on parcels (woo-status-push,
--    shopify-status-push, web-status-push) make an HTTP call to an edge
--    function on EVERY update of any column. All 30 calls in the 6-hour
--    net._http_response window returned {"note":"Status unchanged,
--    ignored"}: ten meta/print updates cost thirty edge invocations. They
--    now fire only when status actually changes. The trigger definitions
--    embed a key, so they are rewritten from pg_get_triggerdef in place and
--    the key never appears in this (public) file.

begin;

-- 1 ------------------------------------------------------------------------
drop policy if exists "parcels_client_ins" on public.parcels;

-- 2 ------------------------------------------------------------------------
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
    /* Payment mode decides whether the rider collects at the door. It is
       part of the booking, like cod_amount, and changes only through the
       same edit path. A direct meta write could flip a COD parcel to
       prepaid after booking, so the rider collects Rs 0 and invoicing then
       refuses the parcel as a COD/prepaid conflict. */
    if (new.meta ->> 'paymentMode') is distinct from (old.meta ->> 'paymentMode') then
      new.meta := case
        when old.meta ? 'paymentMode'
          then jsonb_set(coalesce(new.meta, '{}'::jsonb), '{paymentMode}', old.meta -> 'paymentMode')
        else coalesce(new.meta, '{}'::jsonb) - 'paymentMode'
      end;
    end if;
  end if;

  /* Settlement state. invoice_id decides whether a parcel can be invoiced
     again; a merchant clearing it made the same parcel invoiceable twice. */
  new.invoice_id := old.invoice_id;
  new.invoiced_at := old.invoiced_at;
  new.delivery_charge_posted_at := old.delivery_charge_posted_at;

  /* delivered_at is delivery evidence: it dates the delivery on the public
     tracking page and in delivery-time figures. A merchant session could
     write it onto a parcel that was never delivered (rehearsed 24 Sep:
     New booked parcel, delivered_at = now(), accepted). The only
     legitimate non-admin change is novax_stamp_delivered_at() stamping the
     first entry into Delivered, which runs before this trigger. */
  if new.delivered_at is distinct from old.delivered_at
     and not (old.delivered_at is null
              and new.status = 'Delivered'
              and old.status is distinct from 'Delivered') then
    new.delivered_at := old.delivered_at;
  end if;

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
  elsif coalesce(new.status, '') <> 'Delivered' then
    -- Even the carrying rider records cash only on a delivered parcel.
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
  end if;

  return new;
end;
$function$;

-- 3 ------------------------------------------------------------------------
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
  v_existing_role text;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id, role::text into v_existing_client_id, v_existing_role
    from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
  end if;
  /* The upsert below sets role = 'client'. Called from an admin, staff or
     rider session -- any profile that exists and is not a merchant -- it
     silently turned that account into a merchant and cut it off from
     admin.html / rider.html. Only a brand-new login or a merchant profile
     still waiting for its workspace may be provisioned here. */
  if v_existing_role is not null and v_existing_role <> 'client' then
    raise exception 'This login is a % account, not a merchant account. Sign in to the right portal.', v_existing_role
      using errcode = '42501';
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
    225,                                     -- Zone A base; Zone B is 250
    jsonb_build_object(
      'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    ),
    'flat',
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
$function$;

-- 4 ------------------------------------------------------------------------
create index if not exists idx_parcels_awb_upper on public.parcels (upper(awb));

-- 5 ------------------------------------------------------------------------
do $$
declare
  t record;
  v_def text;
begin
  for t in
    select tg.tgname, pg_get_triggerdef(tg.oid) as def
      from pg_trigger tg
     where tg.tgrelid = 'public.parcels'::regclass
       and tg.tgname in ('parcels', 'shopify-status-push', 'web-status-push')
       and not tg.tgisinternal
  loop
    if position(' WHEN ' in t.def) > 0 then
      continue;                                   -- already narrowed
    end if;
    v_def := replace(t.def,
      'AFTER UPDATE ON public.parcels FOR EACH ROW EXECUTE',
      'AFTER UPDATE OF status ON public.parcels FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE');
    if v_def = t.def then
      raise exception 'Trigger % did not match the expected shape; nothing changed.', t.tgname;
    end if;
    execute format('drop trigger %I on public.parcels', t.tgname);
    execute v_def;
  end loop;
end
$$;

commit;
