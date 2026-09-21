-- NovaX: let Order Processing correct a parcel's weight and have the delivery
-- charge follow automatically.
--
-- A merchant books "1 kg" and the warehouse scale says 1.3 kg. Until now an
-- operator could edit the weight (admin_update_parcel_details takes p_weight)
-- but the fee was a SEPARATE argument, so unless they also worked out the new
-- charge by hand and typed it in, the parcel stayed billed at the 1 kg rate.
-- In practice that means under-billing every re-weighed parcel.
--
-- This does not reimplement pricing or the guards. It asks novax_quote_fee --
-- the same function booking and the merchant API price against, using the
-- client's own negotiated rate card and zone -- and then applies the change
-- through admin_update_parcel_details, which already enforces admin access,
-- refuses to touch an invoiced parcel, and records the before/after audit.

create or replace function public.admin_reprice_parcel_weight(
  p_awb    text,
  p_weight text,
  p_note   text default ''
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row     public.parcels;
  v_quote   jsonb;
  v_kg      numeric;
  v_old_fee numeric;
  v_typed   numeric;
  v_new_fee numeric;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  select * into v_row
    from public.parcels
   where upper(awb) = upper(btrim(coalesce(p_awb, '')));
  if not found then
    raise exception 'That parcel does not exist.';
  end if;

  -- Same absolute rule as admin_update_parcel_details: once a parcel is on an
  -- invoice its fee has been netted into that invoice and into the merchant's
  -- wallet, so it cannot move here.
  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice. Cancel or correct the invoice first.';
  end if;

  -- nv_parse_weight_kg() falls back to 0.8 for ANYTHING it cannot read --
  -- '0 kg', 'abc' and '' all come back as 0.8. Trusting it here would mean a
  -- mistyped weight silently re-rates the parcel at the base rate, which can
  -- quietly LOWER the charge. So the typed value is validated first, and the
  -- parser is only used afterwards to resolve the unit (g vs kg).
  v_typed := nullif((regexp_match(btrim(coalesce(p_weight, '')), '([0-9]*\.?[0-9]+)'))[1], '')::numeric;
  if v_typed is null or v_typed <= 0 then
    raise exception 'Enter a weight greater than 0, like 1.3 kg.';
  end if;

  begin
    v_kg := public.nv_parse_weight_kg(p_weight);
  exception when others then
    v_kg := null;
  end;
  if v_kg is null or v_kg <= 0 then
    raise exception 'Enter a weight greater than 0, like 1.3 kg.';
  end if;
  if v_kg > 100 then
    raise exception 'That weight looks wrong (% kg). Enter the parcel weight, like 1.3 kg.', v_kg;
  end if;

  v_old_fee := coalesce(v_row.fee, 0);

  -- Price it the way this client is actually priced: their rate card, their
  -- zone, and whichever pricing mode this parcel was booked under, so a
  -- distance-priced parcel does not silently fall back to flat.
  v_quote := public.novax_quote_fee(
    v_row.client_id,
    v_row.city,
    btrim(p_weight),
    v_row.origin_area_id,
    v_row.dest_area_id,
    nullif(btrim(coalesce(v_row.pricing_mode, '')), '')
  );
  v_new_fee := round(coalesce((v_quote->>'fee')::numeric, v_old_fee), 2);

  perform public.admin_update_parcel_details(
    p_awb    => v_row.awb,
    p_fee    => v_new_fee,
    p_weight => btrim(p_weight),
    p_note   => coalesce(nullif(btrim(p_note), ''),
                'Re-weighed at processing: ' || coalesce(v_row.meta->>'weight', '(no weight)') ||
                ' -> ' || btrim(p_weight))
  );

  return jsonb_build_object(
    'awb',       v_row.awb,
    'weight',    btrim(p_weight),
    'weight_kg', v_kg,
    'old_fee',   v_old_fee,
    'new_fee',   v_new_fee,
    'delta',     round(v_new_fee - v_old_fee, 2),
    'zone',      v_quote->>'zone',
    'extra_kg',  v_quote->>'extra_kg',
    'capped',    coalesce((v_quote->>'capped')::boolean, false)
  );
end;
$function$;

revoke all on function public.admin_reprice_parcel_weight(text, text, text) from public, anon;
grant execute on function public.admin_reprice_parcel_weight(text, text, text) to authenticated, service_role;
