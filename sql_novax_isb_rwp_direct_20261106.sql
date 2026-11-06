-- 6 Nov 2026 (owner): Islamabad and Rawalpindi parcels go straight from
-- Karachi again (KAR-ISL / KAR-RAW sacks); they no longer pass through the
-- Lahore hub. Every other Karachi parcel for a city other than Lahore still
-- goes via Lahore. Parcels already in a KAR-LAH sack or waiting at Lahore are
-- left alone: they are physically on that route and Khalid sends them on.
create or replace function public.nv_hub_city(p_from text, p_to text)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_from,''))) = 'karachi'
               and lower(btrim(coalesce(p_to,''))) not in ('', 'karachi', 'lahore', 'islamabad', 'rawalpindi') then 'lahore' end
$$;
revoke all on function public.nv_hub_city(text, text) from public, anon, authenticated;
