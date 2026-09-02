-- ===========================================================================
-- NovaX public tracking -- the journey, from a bare AWB
--
-- WHAT WAS WRONG
--   tracking.html?awb=... called track_parcel_public(), which returns four
--   columns: awb, status, city, updated_at. So the page showed a status pill,
--   a city, a timestamp, and the line "For the full step-by-step journey,
--   open the tracking link your seller sent you." Every other courier in
--   Pakistan -- TCS, Leopards, M&P, PostEx -- shows the full scan history
--   from a bare tracking number. Ours looked broken by comparison.
--
--   The caution was not misplaced. AWBs are sequential and guessable, so the
--   original decision withheld the journey rather than leak. But the thing
--   being withheld was never the sensitive part. The sensitive fields are the
--   consignee's name, the COD amount and the rider's name -- and those stay
--   behind the tokenised link, exactly as before. A list of status changes
--   with timestamps is what the industry publishes publicly, and it is the
--   one thing a worried customer actually wants.
--
-- WHAT THIS RETURNS THAT track_parcel_public DID NOT
--   origin and destination city, booked_at, a consignee-safe exception
--   sentence, and the timestamped journey from nv_parcel_status_log.
--
-- WHAT IT STILL WILL NOT RETURN
--   consignee name, phone, address, COD amount, rider name, or the raw
--   parcels.exception column -- which ops fills with rider full names and
--   cash-handling notes. Same rule public_track_parcel() already enforces.
-- ===========================================================================

-- The statuses a stranger may see. nv_parcel_status_log only ever records
-- values that passed the parcels status constraint, so this is belt and
-- braces -- but a future internal status must not silently become public.
create or replace function public.nv_public_status(p_status text)
returns boolean language sql immutable as $$
  select p_status in (
    'New booked','Collected by rider','Arrived at warehouse',
    'Parcel now in transit','Parcel received at destination',
    'Parcel out for delivery','Delivered','Refused',
    'Consignee not available','Reattempt','Reassigned','Out of service area',
    'Ready for return','Return in transit','Return received at origin',
    'Return out for delivery','Return to shipper','Cancelled by client');
$$;

-- Consignee-safe wording. The raw exception column is never returned.
create or replace function public.nv_public_status_note(p_status text)
returns text language sql immutable as $$
  select case p_status
    when 'New booked'                     then 'Your seller has booked this parcel with NovaX.'
    when 'Collected by rider'             then 'Picked up from the seller.'
    when 'Arrived at warehouse'           then 'Received and scanned at our facility.'
    when 'Parcel now in transit'          then 'Travelling between cities. Not out for delivery yet.'
    when 'Parcel received at destination' then 'Arrived at the delivery hub in your city.'
    when 'Parcel out for delivery'        then 'With a rider for delivery today.'
    when 'Delivered'                      then 'Delivered. Thank you.'
    when 'Refused'                        then 'The delivery was not completed.'
    when 'Consignee not available'        then 'We could not reach you. We will try again.'
    when 'Reattempt'                      then 'A re-delivery attempt is scheduled.'
    when 'Reassigned'                     then 'Assigned to another rider for delivery.'
    when 'Out of service area'            then 'This address is outside our current delivery area.'
    when 'Ready for return'               then 'Being prepared to return to the seller.'
    when 'Return in transit'              then 'Travelling back between cities. Not out for delivery yet.'
    when 'Return received at origin'      then 'Back at our facility in the seller''s city.'
    when 'Return out for delivery'        then 'Out for delivery back to the seller.'
    when 'Return to shipper'              then 'Returned to the seller.'
    when 'Cancelled by client'            then 'Cancelled by the seller.'
    else null end;
$$;

-- The journey. One row per real status change, oldest first.
--
-- The log trigger was added on 20 Aug 2026, so parcels booked before then
-- have no rows here. That is why the caller must treat an empty journey as
-- "history not available for this parcel" and still render the current
-- status -- never as an error, and never as an empty timeline.
create or replace function public.nv_parcel_journey(p_parcel_id uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(j order by j_at), '[]'::jsonb) from (
    select jsonb_build_object(
             'status', l.to_status,
             'at',     l.changed_at,
             'note',   public.nv_public_status_note(l.to_status)) as j,
           l.changed_at as j_at
      from public.nv_parcel_status_log l
     where l.parcel_id = p_parcel_id
       and public.nv_public_status(l.to_status)
  ) t;
$$;

create or replace function public.public_track_awb(p_awb text)
returns table(
  awb text, status text, status_note text,
  origin_city text, destination_city text,
  booked_at timestamptz, updated_at timestamptz, delivered_at timestamptz,
  journey jsonb, has_history boolean)
language sql stable security definer set search_path to 'public' as $$
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
  limit 1;
$$;

-- The tokenised link keeps everything it had and gains the same timestamped
-- journey, so the two views differ only in the personal fields.
-- The shape gains journey/delivered_at/status_note, and Postgres will not
-- change a function's OUT parameters under CREATE OR REPLACE. Dropped and
-- recreated in one transaction so tracking.html is never left calling a
-- function that does not exist.
drop function if exists public.public_track_parcel(text);
create or replace function public.public_track_parcel(p_token text)
returns table(awb text, status text, origin_city text, destination_city text,
  booked_at timestamptz, updated_at timestamptz, cod_amount numeric,
  consignee_first text, rider_first text, exception_note text, steps jsonb,
  journey jsonb, delivered_at timestamptz, status_note text)
language sql stable security definer set search_path to 'public' as $$
  select
    p.awb, p.status,
    coalesce(p.meta->>'pickupCity', 'Karachi'),
    p.city, p.booked_at, p.updated_at,
    coalesce(p.cod_amount, 0),
    nullif(split_part(btrim(coalesce(p.consignee, '')), ' ', 1), ''),
    case when p.status = 'Parcel out for delivery'
         then nullif(split_part(btrim(coalesce(
                (select rd.name from public.riders rd where rd.id = p.rider_id), '')), ' ', 1), '')
         else null end,
    -- Never the raw p.exception column: ops writes rider full names and cash
    -- policy into it. Same mapping as before, kept verbatim.
    case p.status
      when 'Consignee not available' then 'We could not reach you for delivery. We will try again.'
      when 'Refused'                 then 'The delivery was not completed.'
      when 'Out of service area'     then 'This address is outside our current delivery area.'
      when 'Reattempt'               then 'A re-delivery attempt is scheduled.'
      else null end,
    coalesce((
      select jsonb_agg(e)
        from jsonb_array_elements_text(coalesce(p.meta->'steps', '[]'::jsonb)) e
       where e in ('New booked','Collected by rider','Arrived at warehouse',
                   'Parcel now in transit','Parcel received at destination',
                   'Parcel out for delivery','Delivered')), '[]'::jsonb),
    public.nv_parcel_journey(p.id),
    p.delivered_at,
    public.nv_public_status_note(p.status)
  from public.parcels p
  where p.tracking_token is not null
    and length(btrim(coalesce(p_token, ''))) >= 20
    and p.tracking_token = btrim(coalesce(p_token, ''))
  limit 1;
$$;

grant execute on function public.public_track_awb(text)  to anon, authenticated;
grant execute on function public.public_track_parcel(text) to anon, authenticated;
grant execute on function public.nv_public_status(text)  to anon, authenticated;
grant execute on function public.nv_public_status_note(text) to anon, authenticated;
