-- =====================================================================
-- Correct the delivery fee on a parcel that has already been delivered.
--
-- WHY
--   Ops could not fix a wrong delivery charge once a parcel reached
--   Delivered: admin_update_parcel_details rejected the whole edit on
--   status alone. Fees do get disputed and mis-rated after delivery, so
--   the fee stays correctable while the parcel is still un-invoiced.
--
-- WHAT STAYS LOCKED
--   Everything except the fee. Consignee, phone, address, city, COD and
--   weight are facts about a delivery that already happened.
--
--   The invoice guard above the new check is untouched and is the hard
--   stop: once a parcel carries an invoice_id its fee has been netted into
--   that invoice and, since sql_novax_invoice_wallet_truth.sql, into the
--   merchant's wallet. Editing it there would desync settled money, so an
--   invoiced parcel remains completely frozen regardless of status.
--
-- ALSO FIXED
--   The weight branch recorded a 'weight' change on EVERY save, because it
--   never compared the submitted value with the stored one -- unlike every
--   other field in this function. That filled parcel_admin_audit with
--   changes that never happened, and it makes "only the fee moved"
--   impossible to test. It now compares first, like its neighbours.
--
-- Body below is the deployed definition with those changes applied.
-- =====================================================================

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
$function$;
