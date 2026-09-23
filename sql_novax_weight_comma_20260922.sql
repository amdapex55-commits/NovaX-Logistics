-- NovaX: read "1,5" as 1.5 kg instead of 1 kg.
--
-- Every weight regex on both sides stopped at the comma, so "1,5" matched
-- "1". The parcel was billed as 1 kg instead of 1.5 kg and nobody saw an
-- error -- not the merchant, not us. On a Zone B parcel that is Rs 250
-- charged where Rs 335 was owed, silently, on every such booking.
--
-- A comma followed by ONE OR TWO digits is unambiguously a decimal point and
-- is rewritten. Three or more digits ("1,500") could be a thousands separator,
-- and a bill must not be decided by a guess, so it is left alone: it then
-- parses as 1 and the >70 sanity checks and the portal's own validator catch
-- it. The browser's parseWeightKg()/nvWeightProblem() normalise identically.
--
-- Checked before changing: zero rows in parcels currently have a comma in
-- meta.weight, so this corrects no historical billing -- it closes the hole
-- before someone types into it.

create or replace function public.nv_parse_weight_kg(p_weight text)
returns numeric
language plpgsql
immutable
set search_path to 'public'
as $function$
declare s text; n numeric;
begin
  s := lower(btrim(coalesce(p_weight, '')));
  -- comma-as-decimal, one or two fractional digits only
  s := regexp_replace(s, '([0-9]),([0-9]{1,2})(?![0-9])', '\1.\2', 'g');
  begin
    n := nullif(substring(s from '([0-9]+(\.[0-9]+)?|\.[0-9]+)'), '')::numeric;
  exception when others then n := null;
  end;
  if n is null or n <= 0 then return 0.8; end if;
  if s ~ '[0-9.]\s*(g|gm|gms|gr|gram|grams)\s*$' then n := n / 1000; end if;
  return n;
end
$function$;

-- admin_reprice_parcel_weight validates the TYPED number itself before
-- trusting the parser, and that check had the same comma blindness.
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
  v_norm    text;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  select * into v_row from public.parcels
   where upper(awb) = upper(btrim(coalesce(p_awb, '')));
  if not found then
    raise exception 'That parcel does not exist.';
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice. Cancel or correct the invoice first.';
  end if;

  -- Same comma normalisation as nv_parse_weight_kg, applied before the typed
  -- number is read, so "1,5" is validated as 1.5 rather than as 1.
  v_norm := regexp_replace(btrim(coalesce(p_weight, '')), '([0-9]),([0-9]{1,2})(?![0-9])', '\1.\2', 'g');

  v_typed := nullif((regexp_match(v_norm, '([0-9]*\.?[0-9]+)'))[1], '')::numeric;
  if v_typed is null or v_typed <= 0 then
    raise exception 'Enter a weight greater than 0, like 1.3 kg.';
  end if;

  begin
    v_kg := public.nv_parse_weight_kg(v_norm);
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

  v_quote := public.novax_quote_fee(
    v_row.client_id, v_row.city, v_norm,
    v_row.origin_area_id, v_row.dest_area_id,
    nullif(btrim(coalesce(v_row.pricing_mode, '')), '')
  );
  v_new_fee := round(coalesce((v_quote->>'fee')::numeric, v_old_fee), 2);

  perform public.admin_update_parcel_details(
    p_awb    => v_row.awb,
    p_fee    => v_new_fee,
    p_weight => v_norm,
    p_note   => coalesce(nullif(btrim(p_note), ''),
                'Re-weighed at processing: ' || coalesce(v_row.meta->>'weight', '(no weight)') ||
                ' -> ' || v_norm)
  );

  return jsonb_build_object(
    'awb', v_row.awb, 'weight', v_norm, 'weight_kg', v_kg,
    'old_fee', v_old_fee, 'new_fee', v_new_fee,
    'delta', round(v_new_fee - v_old_fee, 2),
    'zone', v_quote->>'zone', 'extra_kg', v_quote->>'extra_kg',
    'capped', coalesce((v_quote->>'capped')::boolean, false)
  );
end;
$function$;

revoke all on function public.admin_reprice_parcel_weight(text, text, text) from public, anon;
grant execute on function public.admin_reprice_parcel_weight(text, text, text) to authenticated, service_role;
