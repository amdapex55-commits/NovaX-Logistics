-- Essencify.pk (CL-861848): flat Rs 200 for the first kg in BOTH zones
-- (owner's instruction, 25 Oct 2026). Replaces 200 / 225 from 22 Oct.
-- Extra kg stays Rs 85.
--   1. Rate card A.overnight = B.overnight = 200 (and rate = 200).
--   2. Every Essencify parcel NOT on an invoice (any status) re-priced via
--      admin_update_parcel_details (audited, refuses invoiced parcels).
--      Extra-kg charges are kept: new fee = 200 + (old fee - old base).
--   Invoiced parcels are left as billed.
-- All or nothing: psql -1. Running it again changes nothing.
do $$
declare
  v_client uuid := '861848ff-0340-4fe8-af79-dd8a551542fb'; v_admin uuid; r record; n int := 0; v_bad int;
  v_oldA numeric; v_oldB numeric; v_newfee numeric;
begin
  if (select name from public.clients where id = v_client) is distinct from 'Essencify.pk' then raise exception 'this is not Essencify.pk'; end if;
  select count(*) into v_bad from public.parcels where client_id = v_client and invoice_id is null and delivery_charge_posted_at is not null;
  if v_bad > 0 then raise exception '% uninvoiced Essencify parcels already charged to the wallet: stop and look', v_bad; end if;
  select (rate_card->'A'->>'overnight')::numeric, (rate_card->'B'->>'overnight')::numeric into v_oldA, v_oldB from public.clients where id = v_client;

  select pr.id into v_admin from public.profiles pr join auth.users u on u.id = pr.id
   where lower(pr.role::text) = 'admin' and lower(pr.status::text) = 'active' order by u.last_sign_in_at desc nulls last limit 1;
  if v_admin is null then raise exception 'no active admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.clients
     set rate = 200, rate_card = jsonb_set(jsonb_set(rate_card, '{A,overnight}', '200'), '{B,overnight}', '200')
   where id = v_client and (rate is distinct from 200 or rate_card->'A'->>'overnight' <> '200' or rate_card->'B'->>'overnight' <> '200');

  for r in select p.awb, p.fee, public.nv_parcel_dest(p) d from public.parcels p
            where p.client_id = v_client and p.invoice_id is null order by p.awb loop
    v_newfee := 200 + greatest(coalesce(r.fee,0) - case when r.d = 'karachi' then coalesce(v_oldA,200) else coalesce(v_oldB,225) end, 0);
    if r.fee is distinct from v_newfee then
      perform public.admin_update_parcel_details(p_awb => r.awb, p_fee => v_newfee,
        p_note => 'Essencify flat rate: Rs 200 first kg in both zones. Owner''s instruction, 25 Oct 2026.');
      n := n + 1;
    end if;
  end loop;
  reset role;
  raise notice 'Essencify: % parcels re-priced; rate card Rs % / Rs %', n,
    (select rate_card->'A'->>'overnight' from public.clients where id = v_client), (select rate_card->'B'->>'overnight' from public.clients where id = v_client);
end $$;
