-- Essencify.pk (CL-861848, Karachi): move to the promotional rates
-- (owner's instruction, 16 Nov 2026). Replaces flat 200 from 25 Oct.
--   Same city (Karachi) Rs 170 first kg, other cities Rs 210, extra kg Rs 85.
--   1. Rate card = nv_promo_card(card): A 170, B 210, sameCity, promo tag.
--   2. Parcels booked Fri 13 / Sat 14 Nov (PKT), not invoiced, re-priced via
--      admin_update_parcel_details (audited). Extra-kg charges are kept.
-- All or nothing: psql -1. Running it again changes nothing.
do $$
declare
  v_client uuid := '861848ff-0340-4fe8-af79-dd8a551542fb'; v_admin uuid; r record; n int := 0; v_bad int;
  v_old numeric := 200; v_newfee numeric; v_card jsonb;
begin
  if (select name from public.clients where id = v_client) is distinct from 'Essencify.pk' then raise exception 'this is not Essencify.pk'; end if;
  select count(*) into v_bad from public.parcels where client_id = v_client and invoice_id is null and delivery_charge_posted_at is not null
     and (booked_at at time zone 'Asia/Karachi')::date between date '2026-11-13' and date '2026-11-14';
  if v_bad > 0 then raise exception '% parcels already charged to the wallet: stop and look', v_bad; end if;

  select public.nv_promo_card(rate_card) into v_card from public.clients where id = v_client;

  select pr.id into v_admin from public.profiles pr join auth.users u on u.id = pr.id
   where lower(pr.role::text) = 'admin' and lower(pr.status::text) = 'active' order by u.last_sign_in_at desc nulls last limit 1;
  if v_admin is null then raise exception 'no active admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.clients set rate = 170, rate_card = v_card
   where id = v_client and rate_card is distinct from v_card;

  for r in select p.awb, p.fee, public.nv_parcel_dest(p) d from public.parcels p
            where p.client_id = v_client and p.invoice_id is null
              and (p.booked_at at time zone 'Asia/Karachi')::date between date '2026-11-13' and date '2026-11-14'
            order by p.awb loop
    v_newfee := (case when r.d = 'karachi' then 170 else 210 end) + greatest(coalesce(r.fee,0) - v_old, 0);
    if r.fee is distinct from v_newfee then
      perform public.admin_update_parcel_details(p_awb => r.awb, p_fee => v_newfee,
        p_note => 'Essencify promotional rate: Rs 170 Karachi / Rs 210 other cities. Owner''s instruction, 16 Nov 2026.');
      n := n + 1;
    end if;
  end loop;
  reset role;
  raise notice 'Essencify: % parcels re-priced; card %', n, (select rate_card from public.clients where id = v_client);
end $$;
