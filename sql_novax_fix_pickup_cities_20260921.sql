-- Correct pickup city for merchants registered in a served city whose pickup
-- was left at Karachi by the old hardcode.
--
-- SCOPE IS DELIBERATELY NARROW. Only clients whose REGISTERED city is one of the
-- four NovaX serves, whose stored pickupCity disagrees with it, and who have
-- booked NO parcels -- so there is no in-flight collection to disturb.
--
-- Deliberately NOT touched:
--   * Novela Organics  - registered Karachi, pickup Lahore, 12 parcels booked.
--     Real history against the Lahore pickup; it may be deliberate, and moving
--     it would redirect a live rider. Needs a human to confirm.
--   * Beauty Dream, Gen.z Gadgets, Reliable choices, Swifter - registered
--     "Other", which is not a city. There is no correct value to write.
--   * admin - blank registered city, internal account.
update public.clients c
   set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('pickupCity', initcap(btrim(c.city)))
 where initcap(btrim(coalesce(c.city,''))) in ('Karachi','Lahore','Islamabad','Rawalpindi')
   and lower(coalesce(c.meta->>'pickupCity','')) <> lower(btrim(coalesce(c.city,'')))
   and coalesce(c.meta->>'pickupCity','') <> ''
   and not exists (select 1 from public.parcels p where p.client_id = c.id);
