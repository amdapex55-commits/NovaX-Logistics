-- 6 Nov 2026 (owner): for the promotional "same city" rate, Islamabad and
-- Rawalpindi are one city. An Islamabad merchant delivering in Rawalpindi
-- (or the other way) pays the same-city Rs 170. Cards without "sameCity"
-- keep the old rule unchanged.
create or replace function public.nv_city_key(p text)
returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p,''))) when 'rawalpindi' then 'islamabad' else lower(btrim(coalesce(p,''))) end
$$;
revoke all on function public.nv_city_key(text) from public, anon, authenticated;

create or replace function public.nv_rate_zone(p_card jsonb, p_client uuid, p_dest text)
returns text language sql stable set search_path = '' as $$
  select case
    when coalesce(p_card->>'sameCity','') = 'true' then
      case when public.nv_city_key(p_dest) <> ''
            and public.nv_city_key(p_dest) = (
                  select public.nv_city_key(coalesce(nullif(c.meta->>'pickupCity',''), nullif(c.city,''), 'Karachi'))
                    from public.clients c where c.id = p_client)
           then 'A' else 'B' end
    when lower(btrim(coalesce(p_dest,''))) = 'karachi' then 'A'
    else 'B' end
$$;
revoke all on function public.nv_rate_zone(jsonb, uuid, text) from public, anon, authenticated;
