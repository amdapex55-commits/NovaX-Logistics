-- ===========================================================================
-- public_track_awb -- rate limit  (30 Aug 2026)
--
-- Measured before: 20 rapid unauthenticated calls all returned 200, and AWBs
-- are sequential (N3630045 and N3630046 both resolve, N9999999 does not), so
-- the whole space could be walked to harvest every parcel's route, city pair
-- and timestamps. No personal data is exposed -- this is a bulk-harvesting
-- control, not a leak fix.
--
-- Marked VOLATILE rather than STABLE: it now records a hit, and a STABLE
-- function that writes is incorrect and can fail under parallel query.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.public_track_awb(p_awb text)
 RETURNS TABLE(awb text, status text, status_note text, origin_city text, destination_city text, booked_at timestamp with time zone, updated_at timestamp with time zone, delivered_at timestamp with time zone, journey jsonb, has_history boolean)
 LANGUAGE sql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.awb,
    p.status,
    public.nv_public_status_note(p.status),
    coalesce(p.meta->>'pickupCity', 'Karachi'),
    p.city,
    p.booked_at,
    p.updated_at,
    p.delivered_at,
    public.nv_parcel_journey(p.id),
    jsonb_array_length(public.nv_parcel_journey(p.id)) > 0
  from public.parcels p
  where p.awb = upper(btrim(coalesce(p_awb, '')))
    and length(btrim(coalesce(p_awb, ''))) >= 6
    -- Rate limit, keyed on the caller's IP as seen by PostgREST. Returns no
    -- rows once a single address exceeds 40 lookups in 10 minutes, which a
    -- real customer refreshing a tracking page never reaches and a scraper
    -- walking sequential AWBs hits almost immediately. nv_track_rate_ok fails
    -- OPEN, so a problem with the counter can never stop a customer tracking
    -- their own parcel.
    and public.nv_track_rate_ok(
          coalesce(
            split_part(nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip', ',', 1),
            split_part(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ',', 1),
            ''))
  limit 1;
$function$


