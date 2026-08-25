-- =====================================================================
-- NovaX backend -- guards
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 12 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.enforce_parcel_status_transition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.nv_backfill_client_contact() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.nv_freeze_parcel_money() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Admins and any SECURITY DEFINER booking RPC running as the owner are
  -- unaffected; this exists to stop a browser writing to these columns.
  if public.is_admin() then
    return new;
  end if;

  if new.fee is distinct from old.fee then
    raise exception 'Delivery fee cannot be changed from the portal. Contact NovaX support if it is wrong.';
  end if;
  -- COD is editable in exactly one situation: the merchant is fixing their
  -- own booking through client_edit_new_booked_parcel(), which has already
  -- re-checked ownership, status, invoicing and rider assignment, and which
  -- sets this transaction-local flag immediately before its UPDATE.
  --
  -- A browser cannot forge this. set_config(..., true) is scoped to the
  -- transaction, and the only statement that sets it lives inside a
  -- SECURITY DEFINER function the merchant cannot modify. The status
  -- re-check below is deliberately redundant with the one in that function:
  -- if a future caller ever sets the flag without checking, COD still
  -- cannot be rewritten on a parcel that has already moved.
  if new.cod_amount is distinct from old.cod_amount then
    if coalesce(current_setting('novax.parcel_edit', true), '') <> '1'
       or coalesce(old.status, '') <> 'New booked' then
      raise exception 'COD amount cannot be changed after booking. Contact NovaX support if it is wrong.';
    end if;
  end if;
  if new.client_id is distinct from old.client_id then
    raise exception 'A parcel cannot be moved to another merchant.';
  end if;

  return new;
end
$$;

CREATE FUNCTION public.nv_log_parcel_contact() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if coalesce(old.address,'') is distinct from coalesce(new.address,'')
     or coalesce(old.phone,'') is distinct from coalesce(new.phone,'') then
    insert into public.parcel_contact_history
      (awb, changed_by, old_address, new_address, old_phone, new_phone)
    values (new.awb, auth.uid(), old.address, new.address, old.phone, new.phone);
  end if;
  return null;
end
$$;

CREATE FUNCTION public.nv_log_parcel_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if TG_OP = 'INSERT' then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at)
    values (NEW.id, NEW.awb, NEW.client_id, null, NEW.status, coalesce(NEW.booked_at, now()));
    return NEW;
  end if;
  if NEW.status is distinct from OLD.status then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at)
    values (NEW.id, NEW.awb, NEW.client_id, OLD.status, NEW.status, now());
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION public.nv_no_blank_overwrite() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  j_old jsonb := to_jsonb(old);
  j_new jsonb := to_jsonb(new);
  k     text;
  changed boolean := false;
begin
  for k in select jsonb_object_keys(j_new)
  loop
    -- only text-valued keys, only blank-over-non-blank
    if jsonb_typeof(j_new -> k) = 'string'
       and btrim(coalesce(j_new ->> k, '')) = ''
       and jsonb_typeof(j_old -> k) = 'string'
       and btrim(coalesce(j_old ->> k, '')) <> ''
    then
      j_new := jsonb_set(j_new, array[k], j_old -> k);
      changed := true;
    end if;
  end loop;

  if changed then
    new := jsonb_populate_record(new, j_new);
  end if;
  return new;
end
$$;

CREATE FUNCTION public.nv_protect_client_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(btrim(new.phone), '') = '' and coalesce(btrim(old.phone), '') <> '' then
    new.phone := old.phone;
  end if;
  if coalesce(btrim(new.address), '') = '' and coalesce(btrim(old.address), '') <> '' then
    new.address := old.address;
  end if;
  if coalesce(new.rate, 0) = 0 and coalesce(old.rate, 0) <> 0 then
    new.rate := old.rate;
  end if;
  if new.rate_card is null and old.rate_card is not null then
    new.rate_card := old.rate_card;
  end if;
  return new;
end
$$;

CREATE FUNCTION public.nv_protect_parcel_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(btrim(new.address), '') = '' and coalesce(btrim(old.address), '') <> '' then
    new.address := old.address;
  end if;
  if coalesce(btrim(new.phone), '') = '' and coalesce(btrim(old.phone), '') <> '' then
    new.phone := old.phone;
  end if;
  if coalesce(btrim(new.consignee), '') = '' and coalesce(btrim(old.consignee), '') <> '' then
    new.consignee := old.consignee;
  end if;
  return new;
end
$$;

CREATE FUNCTION public.parcels_guard_columns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.parcels_guard_tracking_token() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions'
    AS $$
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
$$;

CREATE FUNCTION public.parcels_set_tracking_token() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions'
    AS $$
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
$$;

CREATE FUNCTION public.trg_post_non_cod_delivery_charge() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;
