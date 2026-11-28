-- 28 Nov 2026 (owner): the November promotional rates (Rs 170 same city /
-- Rs 210 other cities, sql_novax_promo_rates_20261106.sql) are over.
--   1. Merchants who tapped "Opt in now" get back the exact card they had
--      (logged in nv_promo_optins: all 30 were 225 / 250 / Rs 85).
--   2. Essencify.pk goes back to its own flat Rs 200 (25 Oct card).
--   3. Everyone else on the promotional card (signed up 6-28 Nov) moves to
--      the standard card: Rs 225 to Karachi, Rs 250 elsewhere, Rs 85 extra kg.
--   4. New sign-ups start on the standard card again; "Opt in now" refuses.
-- Parcels already booked keep the fee they were booked at (owner's choice):
-- nothing in parcels is touched. Only cards still carrying the promo tag are
-- changed, so a card an admin has edited since is left alone.
-- All or nothing: psql -1. Running it again changes nothing.
do $$
declare
  v_std jsonb := jsonb_build_object(
    'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
    'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45));
  v_ess uuid := '861848ff-0340-4fe8-af79-dd8a551542fb';
  n1 int; n2 int; n3 int; d text; o1 text; o2 text;
begin
  -- 1. Opted in: their own old card back.
  update public.clients c set rate = o.old_rate, rate_card = o.old_card
    from public.nv_promo_optins o
   where o.client_id = c.id and c.rate_card->>'promo' = 'promo-2026-11' and o.old_card is not null;
  get diagnostics n1 = row_count;

  -- 2. Essencify.pk: flat Rs 200 in both zones, extra kg Rs 85.
  update public.clients set rate = 200,
         rate_card = (rate_card - 'sameCity' - 'promo')
                     || jsonb_build_object('A', (rate_card->'A') || '{"overnight":200}'::jsonb,
                                           'B', (rate_card->'B') || '{"overnight":200}'::jsonb)
   where id = v_ess and rate_card->>'promo' = 'promo-2026-11';
  get diagnostics n2 = row_count;

  -- 3. Everyone else still on the promotional card: standard card.
  update public.clients set rate = 225, rate_card = (rate_card - 'sameCity' - 'promo' - 'A' - 'B') || v_std
   where rate_card->>'promo' = 'promo-2026-11';
  get diagnostics n3 = row_count;

  if exists (select 1 from public.clients where rate_card->>'sameCity' = 'true') then
    raise exception 'a same-city card is still left';
  end if;

  -- 4a. New sign-ups: back to the standard card.
  d := pg_get_functiondef('public.create_client_workspace(text,text,text,text,text,text,text)'::regprocedure);
  o2 := $x$    170,                                     -- 6 Nov 2026: promotional card, Rs 170 same city / Rs 210 other cities
    public.nv_promo_card(jsonb_build_object(
      'A', jsonb_build_object('additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    )),$x$;
  o1 := $x$    225,                                     -- Zone A base; Zone B is 250 (promo ended 28 Nov 2026)
    jsonb_build_object(
      'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    ),$x$;
  if position(o2 in d) > 0 then
    execute replace(d, o2, o1);
  elsif position(o1 in d) = 0 then
    raise exception 'create_client_workspace rate block not found';
  end if;

  raise notice 'promo ended: % opted-in restored, % Essencify, % moved to standard', n1, n2, n3;
end $$;

-- 4b. "Opt in now" is over.
create or replace function public.nv_promo_opt_in()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'This offer has ended.';
end $$;
revoke all on function public.nv_promo_opt_in() from public, anon;
grant execute on function public.nv_promo_opt_in() to authenticated;
