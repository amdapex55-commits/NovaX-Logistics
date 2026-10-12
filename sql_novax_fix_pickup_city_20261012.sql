-- One merchant, one parcel. On 8 Oct 2026 a shop signed up with pickup city
-- "Lahore" and an address in Korangi Crossing, Karachi, then booked a parcel
-- to another Korangi address. The pickup city decides which rider sees the
-- pickup, so the parcel sat in the Lahore rider's Pickup list for three days
-- and nobody in Karachi was shown it.
--
-- Narrow on purpose: the row is matched on the wrong values as well as its id,
-- so running this twice, or after someone has already corrected it, does
-- nothing. The fee is not touched. To undo, set the three values back to
-- 'Lahore'.
do $$
declare v_client uuid := 'ed1a94eb-14e7-4faf-a88e-507a5c5d021e'; n int;
begin
  update public.clients
     set city = 'Karachi', meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('pickupCity','Karachi')
   where id = v_client and city = 'Lahore' and meta->>'pickupCity' = 'Lahore' and address ilike 'Korangi%';
  get diagnostics n = row_count;
  if n = 0 then raise notice 'merchant already corrected: nothing to do'; return; end if;
  update public.parcels
     set meta = meta || jsonb_build_object('pickupCity','Karachi')
   where client_id = v_client and status = 'New booked' and meta->>'pickupCity' = 'Lahore';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'expected 1 waiting parcel for this merchant, found %', n; end if;
end $$;
