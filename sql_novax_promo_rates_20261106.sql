-- 6 Nov 2026 (owner): promotional rates. Rs 170 for the first kg in the same
-- city, Rs 210 to any other city, no hidden or extra charges; each extra kg
-- stays Rs 85. New sign-ups get them automatically; existing merchants on the
-- standard card (225 / 250) get them only when they tap "Opt in now" in the
-- portal. Special-rate merchants are not touched.
--
-- "Same city" means the parcel is delivered in the merchant's pickup city
-- (clients.meta.pickupCity, else clients.city). A card carries this with
-- "sameCity": true; every other card keeps the old rule (zone A = to Karachi).
begin;

create or replace function public.nv_rate_zone(p_card jsonb, p_client uuid, p_dest text)
returns text language sql stable set search_path = '' as $$
  select case
    when coalesce(p_card->>'sameCity','') = 'true' then
      case when lower(btrim(coalesce(p_dest,''))) <> ''
            and lower(btrim(coalesce(p_dest,''))) = (
                  select lower(btrim(coalesce(nullif(c.meta->>'pickupCity',''), nullif(c.city,''), 'Karachi')))
                    from public.clients c where c.id = p_client)
           then 'A' else 'B' end
    when lower(btrim(coalesce(p_dest,''))) = 'karachi' then 'A'
    else 'B' end
$$;
revoke all on function public.nv_rate_zone(jsonb, uuid, text) from public, anon, authenticated;

-- The promotional card, built on whatever card the merchant has (keeps the
-- extra-kg and other fields as they are).
create or replace function public.nv_promo_card(p_card jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(p_card,'{}'::jsonb)
    || jsonb_build_object(
         'A', coalesce(p_card->'A', jsonb_build_object('additionalKg',85,'detainBase',540,'detainAdditionalKg',125,'overlandBase',900,'overlandAdditionalKg',45)) || jsonb_build_object('overnight',170),
         'B', coalesce(p_card->'B', jsonb_build_object('additionalKg',85,'detainBase',540,'detainAdditionalKg',125,'overlandBase',900,'overlandAdditionalKg',45)) || jsonb_build_object('overnight',210),
         'sameCity', true,
         'promo', 'promo-2026-11')
$$;
revoke all on function public.nv_promo_card(jsonb) from public, anon, authenticated;

-- Point the four pricing functions at nv_rate_zone. Each must change exactly once.
do $$
declare r record; d text; n text;
begin
  for r in select * from (values
    ('public.novax_quote_fee(uuid,text,text,uuid,uuid,text)', 'v_zone := case when lower(coalesce(p_dest_city, '''')) = ''karachi'' then ''A'' else ''B'' end;', 'v_zone := public.nv_rate_zone(v_rate_card, p_client_id, p_dest_city);'),
    ('public.nv_book_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text)', 'v_zone := case when lower(coalesce(p_city, '''')) = ''karachi'' then ''A'' else ''B'' end;', 'v_zone := public.nv_rate_zone(v_rate_card, p_client_id, p_city);'),
    ('public.client_book_parcel(text,text,text,text,text,numeric,text,text,text,text,text,text,text,text)', 'v_zone := case when lower(coalesce(p_city, '''')) = ''karachi'' then ''A'' else ''B'' end;', 'v_zone := public.nv_rate_zone(v_rate_card, v_client_id, p_city);'),
    ('public.nv_swap_fee(uuid,text,text)', 'v_zone := case when lower(coalesce(p_city,'''')) = ''karachi'' then ''A'' else ''B'' end;', 'v_zone := public.nv_rate_zone(v_card, p_client, p_city);')
  ) t(fn, old, new) loop
    d := pg_get_functiondef(r.fn::regprocedure);
    if (length(d) - length(replace(d, r.old, ''))) / length(r.old) <> 1 then
      raise exception 'zone line not found exactly once in %', r.fn;
    end if;
    n := replace(d, r.old, r.new);
    execute n;
  end loop;
end $$;

-- New sign-ups start on the promotional card.
do $$
declare d text; o1 text; o2 text;
begin
  d := pg_get_functiondef('public.create_client_workspace(text,text,text,text,text,text,text)'::regprocedure);
  o1 := $x$    225,                                     -- Zone A base; Zone B is 250
    jsonb_build_object(
      'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    ),$x$;
  o2 := $x$    170,                                     -- 6 Nov 2026: promotional card, Rs 170 same city / Rs 210 other cities
    public.nv_promo_card(jsonb_build_object(
      'A', jsonb_build_object('additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    )),$x$;
  if position(o1 in d) = 0 then raise exception 'create_client_workspace rate block not found'; end if;
  execute replace(d, o1, o2);
end $$;

-- Who opted in, and what card they had before (to undo one if ever needed).
create table if not exists public.nv_promo_optins (
  client_id uuid primary key references public.clients(id) on delete cascade,
  opted_at timestamptz not null default now(),
  opted_by uuid,
  old_rate numeric,
  old_card jsonb
);
alter table public.nv_promo_optins enable row level security;
revoke all on public.nv_promo_optins from anon, authenticated;

-- "Opt in now". Only a merchant on the standard card (225 / 250, Rs 85 extra
-- kg, not already same-city) can switch; anything else is refused unchanged.
create or replace function public.nv_promo_opt_in()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); v_rate numeric; v_card jsonb;
begin
  if v_client is null then raise exception 'Sign in to your merchant account first.'; end if;
  select c.rate, c.rate_card into v_rate, v_card from public.clients c where c.id = v_client for update;
  if coalesce(v_card->>'sameCity','') = 'true' then
    return jsonb_build_object('ok', true, 'already', true, 'rate_card', v_card);
  end if;
  if not (coalesce((v_card->'A'->>'overnight')::numeric,0) = 225 and coalesce((v_card->'B'->>'overnight')::numeric,0) = 250
          and coalesce((v_card->'A'->>'additionalKg')::numeric,85) = 85 and coalesce((v_card->'B'->>'additionalKg')::numeric,85) = 85) then
    raise exception 'This offer is for the standard rate card. Your account has its own rates; contact NovaX.';
  end if;
  insert into public.nv_promo_optins (client_id, opted_by, old_rate, old_card)
  values (v_client, auth.uid(), v_rate, v_card) on conflict (client_id) do nothing;
  update public.clients set rate = 170, rate_card = public.nv_promo_card(v_card) where id = v_client
  returning rate_card into v_card;
  return jsonb_build_object('ok', true, 'already', false, 'rate_card', v_card);
end $$;
revoke all on function public.nv_promo_opt_in() from public, anon;
grant execute on function public.nv_promo_opt_in() to authenticated;

commit;
