-- =====================================================================
-- NovaX — remove distance pricing entirely
--
-- Four layers, because switching the config flag off is NOT enough.
--
--   1. novax_pricing_config.distance_enabled = false
--        Stops novax_parcel_autoprice, which bails out on this flag.
--
--   2. drop the novax_parcel_autoprice trigger
--        So distance pricing cannot come back if the flag is ever flipped
--        on again by a stray update or a future admin screen.
--
--   3. novax_quote_fee stops honouring p_force_mode = 'distance'
--        THIS IS THE ONE THAT IS NOT OBVIOUS. Read the current source:
--
--          v_mode := coalesce(
--            nullif(lower(coalesce(p_force_mode, '')), ''),
--            case when coalesce(v_cfg.distance_enabled, false)
--                 then 'distance' else 'flat' end);
--
--        p_force_mode is checked FIRST. Any caller passing 'distance'
--        gets distance pricing no matter what the config flag says, and
--        novax_parcel_autoprice already calls it exactly that way. Turning
--        the flag off without this leaves a live bypass in place.
--
--   4. any client still marked pricing_mode = 'distance' moves to 'flat'
--
-- WHAT IS NOT CHANGED, DELIBERATELY
--   * The weight surcharge. Every parcel over 1kg still adds Rs 85 per
--     extra kilo (capped at 5kg), in flat mode as much as distance mode.
--     That is a separate decision you have not made yet.
--   * The `coalesce(v_rate, 250)` fallback: a client with no stored rate
--     is still priced at 250. Also separate -- see sql_novax_flat_200.sql.
--   * Parcels already priced by distance keep their history. Nothing
--     retroactively repriced.
--
-- NOTHING IS DELETED. No table, column, parcel, invoice or client row is
-- removed. There is no DELETE, TRUNCATE, DROP TABLE or ALTER anywhere.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 0 — before state (read-only)
-- ---------------------------------------------------------------------
select public.novax_pricing_config_get() as config_before;

select count(*) filter (where pricing_mode like 'distance%') as parcels_priced_by_distance,
       count(*) filter (where pricing_mode = 'flat' or pricing_mode is null) as parcels_priced_flat
from public.parcels;

select coalesce(pricing_mode, '(null)') as client_pricing_mode, count(*) as clients
from public.clients group by 1 order by 2 desc;


-- ---------------------------------------------------------------------
-- PART 1 — the master switch
-- ---------------------------------------------------------------------
update public.novax_pricing_config set distance_enabled = false;


-- ---------------------------------------------------------------------
-- PART 2 — the auto-pricing trigger
--
-- The FUNCTION is left in place, so this is reversible with one statement:
--   create trigger novax_parcel_autoprice_trg before insert on public.parcels
--     for each row execute function public.novax_parcel_autoprice();
-- ---------------------------------------------------------------------
drop trigger if exists novax_parcel_autoprice_trg on public.parcels;


-- ---------------------------------------------------------------------
-- PART 3 — close the p_force_mode bypass
--
-- The signature is reproduced BYTE FOR BYTE: same six parameters, same
-- names, same types, same defaults, same return type. This matters more
-- than anything else in this file -- CREATE OR REPLACE with even one
-- changed argument creates a SECOND function rather than replacing the
-- first, and PostgREST then picks whichever it likes. That is precisely
-- what took bookings down on 2026-08-22.
--
-- p_force_mode is KEPT as a parameter because callers still pass it. It is
-- simply no longer able to select distance.
--
-- The returned jsonb keeps every key it had, with the same values this
-- function already produces whenever distance is off, so no caller sees a
-- shape it has not seen before.
-- ---------------------------------------------------------------------
create or replace function public.novax_quote_fee(
  p_client_id uuid,
  p_dest_city text,
  p_weight text default '0.8 kg'::text,
  p_origin_area_id uuid default null::uuid,
  p_dest_area_id uuid default null::uuid,
  p_force_mode text default null::text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
    v_weight_kg := coalesce(
      nullif(regexp_replace(coalesce(p_weight, ''), '[^0-9.]', '', 'g'), '')::numeric, 0.8);
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


-- ---------------------------------------------------------------------
-- PART 4 — no client is left marked as a distance client
-- ---------------------------------------------------------------------
update public.clients
   set pricing_mode = 'flat'
 where coalesce(pricing_mode, '') <> 'flat';


-- ---------------------------------------------------------------------
-- PART 5 — verify (read-only)
--
-- AND THEN BOOK ONE REAL PARCEL. This is not optional.
--
-- novax_parcel_autoprice is the only thing in this file that WRITES a fee,
-- and dropping its trigger means client_book_parcel is now solely
-- responsible for pricing a Karachi parcel. The evidence says it already
-- is: parcels outside Karachi have fees and autoprice never touches them,
-- and two of KKM's three Karachi parcels were priced 200 rather than by
-- distance. But client_book_parcel's source is not in the repo and I have
-- not read it.
--
-- So after running this, book ONE test parcel to Karachi through the
-- portal and confirm the fee is 200 and not 0 or blank. If it comes back
-- empty, put the trigger back immediately:
--
--   create trigger novax_parcel_autoprice_trg before insert on public.parcels
--     for each row execute function public.novax_parcel_autoprice();
--
-- and send me client_book_parcel's body.
-- ---------------------------------------------------------------------
-- Exactly ONE novax_quote_fee must exist. Two rows here means an overload
-- was created instead of a replacement -- stop and drop the stale one.
select p.oid::regprocedure as signature
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'novax_quote_fee';

-- The autoprice trigger must be gone (expect 0):
select count(*) as autoprice_trigger_present
from pg_trigger where tgrelid = 'public.parcels'::regclass
  and tgname = 'novax_parcel_autoprice_trg';

-- distance_enabled must be false:
select public.novax_pricing_config_get() as config_after;

-- Every client on flat:
select coalesce(pricing_mode, '(null)') as client_pricing_mode, count(*) from public.clients group by 1;

-- And a live quote must come back mode = flat even when distance is forced:
-- (swap in a real client id)
--   select public.novax_quote_fee(
--     '<a real client uuid>', 'Karachi', '3 kg', null, null, 'distance');
--   -> mode must be 'flat'
