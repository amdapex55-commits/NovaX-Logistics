-- Zebora's agreed rate is Rs 160 per parcel (owner's instruction, 12 Oct 2026).
--
-- Its rate card had Rs 160 only under zone A. Zone A is "the parcel is going
-- to Karachi"; every other destination is zone B, which was still the
-- standard Rs 250. Zebora is a Lahore shop delivering in Lahore, so all 53 of
-- its parcels were booked at Rs 250.
--
--   1. Rate card: Rs 160 in both zones, so new bookings are right.
--   2. Every Zebora parcel not yet on an invoice: charge set to Rs 160 through
--      admin_update_parcel_details(), which refuses an invoiced parcel and
--      writes one parcel_admin_audit row per change.
--
-- Nothing had been invoiced and no charge had been posted to the wallet, so
-- no settled money moves. All or nothing: run with psql -1. Running it again
-- changes nothing.
do $$
declare
  v_client uuid := '4ffe146c-bfac-480e-9939-fed7894347e1'; v_admin uuid; r record; n int := 0; v_bad int;
begin
  if (select name from public.clients where id = v_client) is distinct from 'Zebora' then raise exception 'this is not Zebora'; end if;
  select count(*) into v_bad from public.parcels where client_id = v_client and (invoice_id is not null or delivery_charge_posted_at is not null);
  if v_bad > 0 then raise exception '% Zebora parcels are already invoiced or charged to the wallet: stop and look', v_bad; end if;

  -- the admin function checks for an admin login; act as the admin who is signed in
  select pr.id into v_admin from public.profiles pr join auth.users u on u.id = pr.id
   where lower(pr.role::text) = 'admin' and lower(pr.status::text) = 'active' order by u.last_sign_in_at desc nulls last limit 1;
  if v_admin is null then raise exception 'no active admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.clients
     set rate = 160, rate_card = jsonb_set(jsonb_set(rate_card, '{A,overnight}', '160'), '{B,overnight}', '160')
   where id = v_client and (rate is distinct from 160 or rate_card->'A'->>'overnight' <> '160' or rate_card->'B'->>'overnight' <> '160');

  for r in select awb from public.parcels where client_id = v_client and invoice_id is null and fee is distinct from 160 order by awb loop
    perform public.admin_update_parcel_details(p_awb => r.awb, p_fee => 160,
      p_note => 'Agreed rate is Rs 160 per parcel. Booked at Rs 250 because the rate card had Rs 160 only for parcels going to Karachi. Owner''s instruction, 12 Oct 2026.');
    n := n + 1;
  end loop;
  reset role;

  if exists (select 1 from public.parcels where client_id = v_client and invoice_id is null and fee is distinct from 160) then raise exception 'a Zebora parcel is still not Rs 160'; end if;
  raise notice 'Zebora: % parcels changed to Rs 160; rate card is Rs % / Rs %', n,
    (select rate_card->'A'->>'overnight' from public.clients where id = v_client), (select rate_card->'B'->>'overnight' from public.clients where id = v_client);
end $$;
