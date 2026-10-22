-- Essencify.pk special rate (owner's instruction, 22 Oct 2026):
-- Rs 200 to Karachi (zone A) and Rs 225 to every other city (zone B).
-- Extra kg stays Rs 85.
--
--   1. Rate card: A.overnight 200, B.overnight 225 (and the flat `rate` 200),
--      so new bookings are priced right from the next request.
--   2. Every OPEN Essencify parcel (not Delivered / Returned / Cancelled) that
--      is not on an invoice: charge re-priced through
--      admin_update_parcel_details(), which refuses invoiced parcels and writes
--      one parcel_admin_audit row each. Extra-kg charges on a parcel are kept:
--      new fee = new base + (old fee - old base).
--   Delivered parcels are left as booked (the instruction was open orders).
-- All or nothing: run with psql -1. Running it again changes nothing.
do $$
declare
  v_client uuid := '861848ff-0340-4fe8-af79-dd8a551542fb'; v_admin uuid; r record; n int := 0; v_bad int;
  v_oldA numeric; v_oldB numeric; v_newfee numeric;
begin
  if (select name from public.clients where id = v_client) is distinct from 'Essencify.pk' then raise exception 'this is not Essencify.pk'; end if;
  select count(*) into v_bad from public.parcels where client_id = v_client
     and status not in ('Delivered','Return to shipper','Cancelled by client')
     and (invoice_id is not null or delivery_charge_posted_at is not null);
  if v_bad > 0 then raise exception '% open Essencify parcels are invoiced or charged to the wallet: stop and look', v_bad; end if;
  select (rate_card->'A'->>'overnight')::numeric, (rate_card->'B'->>'overnight')::numeric into v_oldA, v_oldB from public.clients where id = v_client;

  select pr.id into v_admin from public.profiles pr join auth.users u on u.id = pr.id
   where lower(pr.role::text) = 'admin' and lower(pr.status::text) = 'active' order by u.last_sign_in_at desc nulls last limit 1;
  if v_admin is null then raise exception 'no active admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.clients
     set rate = 200, rate_card = jsonb_set(jsonb_set(rate_card, '{A,overnight}', '200'), '{B,overnight}', '225')
   where id = v_client and (rate is distinct from 200 or rate_card->'A'->>'overnight' <> '200' or rate_card->'B'->>'overnight' <> '225');

  for r in select p.awb, p.fee, public.nv_parcel_dest(p) d from public.parcels p
            where p.client_id = v_client and p.invoice_id is null
              and p.status not in ('Delivered','Return to shipper','Cancelled by client') order by p.awb loop
    if r.d = 'karachi' then v_newfee := 200 + greatest(coalesce(r.fee,0) - coalesce(v_oldA,200), 0);
    else v_newfee := 225 + greatest(coalesce(r.fee,0) - coalesce(v_oldB,225), 0); end if;
    if r.fee is distinct from v_newfee then
      perform public.admin_update_parcel_details(p_awb => r.awb, p_fee => v_newfee,
        p_note => 'Essencify special rate: Rs 200 to Karachi, Rs 225 to other cities. Owner''s instruction, 22 Oct 2026.');
      n := n + 1;
    end if;
  end loop;
  reset role;
  raise notice 'Essencify: % open parcels re-priced; rate card is Rs % / Rs %', n,
    (select rate_card->'A'->>'overnight' from public.clients where id = v_client), (select rate_card->'B'->>'overnight' from public.clients where id = v_client);
end $$;
