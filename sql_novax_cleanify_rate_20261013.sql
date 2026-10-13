-- Cleanify Cleaning Solutions (CL-D7C148): agreed rate, owner's instruction, 13 Oct 2026.
--   Rs 225 per parcel in both zones (the standard card is Rs 225 Karachi-bound / Rs 250 elsewhere)
--   Rs 75 for each additional kg (standard Rs 85)
-- The card is read at the moment a parcel is priced, so the portal and the
-- Merchant API quote the new prices from the next request. Parcels already
-- booked keep the fee they were booked at; the one parcel on file is already
-- on an invoice and is not touched. Detain and overland lines are unchanged.
-- Running it again changes nothing.
do $$
declare v_client uuid := 'd7c148a1-d3ee-4ff5-8dde-60bb98e567b5'; v_admin uuid; v_card jsonb;
begin
  if (select name from public.clients where id = v_client) is distinct from 'Cleanify Cleaning Solutions' then raise exception 'this is not Cleanify Cleaning Solutions'; end if;
  select rate_card into v_card from public.clients where id = v_client;
  if jsonb_typeof(v_card->'A') <> 'object' or jsonb_typeof(v_card->'B') <> 'object' then raise exception 'unexpected rate card shape: stop and look'; end if;
  v_card := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_card, '{A,overnight}', '225'), '{B,overnight}', '225'), '{A,additionalKg}', '75'), '{B,additionalKg}', '75');

  select pr.id into v_admin from public.profiles pr join auth.users u on u.id = pr.id
   where lower(pr.role::text) = 'admin' and lower(pr.status::text) = 'active' order by u.last_sign_in_at desc nulls last limit 1;
  if v_admin is null then raise exception 'no active admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.clients set rate = 225, rate_card = v_card where id = v_client and (rate is distinct from 225 or rate_card is distinct from v_card);
  reset role;

  if (select rate_card from public.clients where id = v_client) is distinct from v_card then raise exception 'the rate card did not save'; end if;
  raise notice 'Cleanify: zone A Rs % + Rs %/kg, zone B Rs % + Rs %/kg', v_card->'A'->>'overnight', v_card->'A'->>'additionalKg', v_card->'B'->>'overnight', v_card->'B'->>'additionalKg';
end $$;
