-- ============================================================================
-- Karachi (Zone A) flat/fallback rate: 100 -> 200
--
-- fee = base + ceil(max(0, min(weight,5) - 1)) * additionalKg
-- Only the BASE changes, so every parcel keeps whatever weight surcharge it
-- already carried. The shift is computed per client from that client's own
-- current Zone A rate, so a merchant on a non-standard rate is handled
-- correctly rather than being blanket +100.
--
-- Run each step separately and read the output before moving on.
-- ============================================================================

-- STEP 1 -- what Zone A rates exist today, and on how many clients.
select coalesce((rate_card->'A'->>'overnight')::numeric,
                (rate_card->>'overnight')::numeric)      as zone_a_now,
       count(*)                                          as clients
from public.clients
group by 1
order by 2 desc;

-- STEP 2 -- which parcels would be re-priced. NOT delivered, NOT invoiced.
select c.name, p.awb, p.city, p.status, p.fee as fee_now,
       coalesce((c.rate_card->'A'->>'overnight')::numeric,
                (c.rate_card->>'overnight')::numeric, 100) as base_now,
       p.fee - coalesce((c.rate_card->'A'->>'overnight')::numeric,
                        (c.rate_card->>'overnight')::numeric, 100) + 200 as fee_after
from public.parcels p
join public.clients c on c.id = p.client_id
where lower(p.city) = 'karachi'
  and p.status = 'New booked'
  and p.invoice_id is null
order by c.name, p.awb;

-- STEP 3 -- set Zone A base to 200 on every client.
-- Handles both the {A:{},B:{}} shape and the older flat shape.
update public.clients
set rate_card = case
      when rate_card ? 'A'
        then jsonb_set(rate_card, '{A,overnight}', '200'::jsonb, true)
      when rate_card ? 'overnight'
        then jsonb_build_object(
               'A', jsonb_set(rate_card, '{overnight}', '200'::jsonb, true),
               'B', rate_card)
      else rate_card
    end,
    rate = 200
where rate_card is not null;

-- STEP 4 -- re-price the open, uninvoiced Karachi parcels.
-- Uses each parcel's CURRENT fee minus the OLD base plus 200, so the weight
-- surcharge survives. Zone A is now 200, so the old base is read from the
-- pre-update value we just wrote -- which is why step 3 and step 4 must be
-- run in this order and only once.
update public.parcels p
set fee = 200 + greatest(0, p.fee - 100)
where lower(p.city) = 'karachi'
  and p.status = 'New booked'
  and p.invoice_id is null
  and p.fee = 100;          -- exactly the flat-rate ones, no surcharge

-- STEP 4b -- any Karachi new-booked parcels that were NOT exactly 100
-- (i.e. they carried a weight surcharge). Review before running.
select awb, city, status, fee
from public.parcels
where lower(city) = 'karachi'
  and status = 'New booked'
  and invoice_id is null
  and fee <> 200
order by fee;

-- STEP 5 -- confirm.
select fee, count(*) as parcels
from public.parcels
where lower(city) = 'karachi' and status = 'New booked' and invoice_id is null
group by fee order by fee;

select coalesce((rate_card->'A'->>'overnight')::numeric,
                (rate_card->>'overnight')::numeric) as zone_a_now,
       count(*) as clients
from public.clients group by 1 order by 2 desc;
