-- NovaX: clear the consignee phone/address values that admin.html used to invent.
-- The old normaliser filled blank fields with:
--     address = '<consignee> delivery address, <city>'
--     phone   = '0311' || lpad(row_index, 7, '0')
-- and the parcel sync then wrote those inventions back to Supabase. That is why
-- the merchant drawer showed the consignee NAME where the delivery address belongs.
-- The code no longer does this. These statements remove the rows it already poisoned.

-- STEP 1 -- preview. Run this alone first and eyeball the count.
select awb, consignee, city, address, phone
from public.parcels
where address = consignee || ' delivery address, ' || city
   or phone ~ '^0311000[0-9]{4}$'
order by booked_at desc;

-- STEP 2 -- clear the fabricated addresses.
update public.parcels
set address = ''
where address = consignee || ' delivery address, ' || city;

-- STEP 3 -- clear the fabricated phone numbers.
-- Only touches the exact shape the generator produced (0311 + 3 zeros + 4 digits).
update public.parcels
set phone = ''
where phone ~ '^0311000[0-9]{4}$';

-- STEP 4 -- confirm nothing is left.
select count(*) as still_fabricated
from public.parcels
where address = consignee || ' delivery address, ' || city
   or phone ~ '^0311000[0-9]{4}$';
