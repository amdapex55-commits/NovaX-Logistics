-- NovaX: clear invented consignee phone/address values on ACTIVE parcels.
--
-- admin.html's state normaliser used to fill blank consignee fields with:
--     address = '<consignee> delivery address, <city>'
--     phone   = '0311' || lpad(row_index, 7, '0')
-- and the parcel sync wrote those inventions back to Supabase. The generator is
-- now removed, and bookParcel() refuses to create a parcel without a real
-- address and phone, so no NEW order can pick this up.
--
-- This script only touches parcels that are still moving. Closed parcels
-- (Delivered / Return to shipper / Cancelled) keep their historical rows --
-- rewriting settled records serves no operational purpose.

-- STEP 1 -- what is still active and carrying invented details.
select awb, client_id, consignee, city, status, booked_at::date,
       address, phone
from public.parcels
where status not in ('Delivered','Return to shipper','Parcel returned to consignee','Cancelled')
  and (address = consignee || ' delivery address, ' || city
       or phone ~ '^0311000[0-9]{4}$')
order by booked_at;

-- STEP 2 -- clear them. Blank reads as "Address pending" / "Not provided" in
-- both portals, which is true; the invented string reads as a real address,
-- which is not. Ops must collect the real details from the merchant before
-- these parcels can be delivered.
update public.parcels
set address = ''
where status not in ('Delivered','Return to shipper','Parcel returned to consignee','Cancelled')
  and address = consignee || ' delivery address, ' || city;

update public.parcels
set phone = ''
where status not in ('Delivered','Return to shipper','Parcel returned to consignee','Cancelled')
  and phone ~ '^0311000[0-9]{4}$';

-- STEP 3 -- confirm. Should return 0.
select count(*) as active_still_fabricated
from public.parcels
where status not in ('Delivered','Return to shipper','Parcel returned to consignee','Cancelled')
  and (address = consignee || ' delivery address, ' || city
       or phone ~ '^0311000[0-9]{4}$');
