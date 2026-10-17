-- NovaX new stations, 17 Oct 2026: the AI answer bank.
-- The "Cities we deliver to" answer was triggered by "faisalabad", "multan",
-- "okara" and "sahiwal" and replied that NovaX does not deliver there; the
-- Rates and Delivery time answers listed only Lahore/Islamabad/Rawalpindi as
-- Zone B. Each replace() below is asserted to change exactly one row.
\set ON_ERROR_STOP 1
begin;

update public.nv_ai_answers set
  answer_en = 'We deliver in Karachi, Lahore, Islamabad and Rawalpindi, and since 17 October to eight new stations: Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala and Adda Gamber (Rs 250 for the first kg, 2-3 working days). We pick up in Karachi, Lahore, Islamabad and Rawalpindi. We do not deliver to other cities yet.',
  answer_ur = 'Hum Karachi, Lahore, Islamabad aur Rawalpindi mein deliver karte hain, aur 17 October se 8 naye stations par bhi: Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala aur Adda Gamber (pehla kg Rs 250, 2-3 working days). Pickup Karachi, Lahore, Islamabad aur Rawalpindi mein hoti hai. Baaqi cities mein abhi delivery nahi hai.',
  phrases = phrases || array['chichawatni','harappa','harrapa','yousuf wala','yousaf wala','adda gamber','gamber','new stations','new station','naye stations'],
  updated_at = now()
where id = '56675feb-ca4a-4bfd-9071-32cdf7766064'
  and answer_en = 'We deliver in Karachi, Lahore, Islamabad and Rawalpindi, and we pick up in all four cities. We do not deliver to other cities yet.';

update public.nv_ai_answers set
  answer_en = replace(answer_en, 'to Lahore, Islamabad or Rawalpindi it is Rs 250', 'to Lahore, Islamabad, Rawalpindi or one of our new stations (Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala, Adda Gamber) it is Rs 250'),
  answer_ur = replace(answer_ur, 'Lahore, Islamabad ya Rawalpindi ke liye', 'Lahore, Islamabad, Rawalpindi ya kisi naye station (Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala, Adda Gamber) ke liye'),
  updated_at = now()
where id = 'ccd9d164-b076-43ad-ac3a-2f40390db631'
  and answer_en like '%to Lahore, Islamabad or Rawalpindi it is Rs 250%'
  and answer_ur like '%Lahore, Islamabad ya Rawalpindi ke liye%';

update public.nv_ai_answers set
  answer_en = replace(answer_en, 'to Lahore, Islamabad or Rawalpindi, and between cities', 'to Lahore, Islamabad, Rawalpindi or one of the new stations, and between cities'),
  answer_ur = replace(answer_ur, 'Lahore, Islamabad ya Rawalpindi,', 'Lahore, Islamabad, Rawalpindi ya naye stations,'),
  updated_at = now()
where id = 'c8fb486a-af34-40eb-a828-563f7233fe8d'
  and answer_en like '%to Lahore, Islamabad or Rawalpindi, and between cities%'
  and answer_ur like '%Lahore, Islamabad ya Rawalpindi,%';

do $$ begin
  if (select count(*) from public.nv_ai_answers where id in ('56675feb-ca4a-4bfd-9071-32cdf7766064','ccd9d164-b076-43ad-ac3a-2f40390db631','c8fb486a-af34-40eb-a828-563f7233fe8d')
        and answer_en ilike '%new station%') <> 3 then
    raise exception 'expected 3 answers updated';
  end if;
end $$;

commit;
