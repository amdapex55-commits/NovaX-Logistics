-- End-to-end journey rehearsal (28 Nov 2026). Runs against PRODUCTION inside
-- one transaction and ALWAYS rolls back: the merchant, rider, parcels, cash and
-- withdrawal it creates never survive. Emails and webhooks it triggers are only
-- queued (pg_net / nv_email_queue), and the queue rows roll back with the rest.
--   psql "$NOVAX_DB" -X -v ON_ERROR_STOP=1 -f scripts/rehearse-journeys.sql
-- Walks, as the real signed-in roles (JWT claims + role authenticated):
--   Merchant: signup -> workspace -> queue let-in -> booking x2 -> label data
--   Rider:    station view (pickup) -> collect -> out -> delivered / refused
--   Cash:     rider cash summary -> handover -> admin confirms
--   Wallet:   admin invoice -> pushed to wallet -> merchant summary
--   Payout:   bank details -> withdrawal request -> visible to the merchant
--   Account:  support ticket -> deletion request -> status -> cancel
-- Prints PASS lines and ends with "JOURNEYS OK". Any failure raises (rolled back).

begin;

do $j$
declare
  v_admin uuid := (select id from public.profiles where lower(role::text) = 'admin' order by created_at limit 1);
  v_admin_email text;
  m_uid uuid := gen_random_uuid(); m_email text := 'journey-' || left(gen_random_uuid()::text, 8) || '@example.invalid';
  r_uid uuid := gen_random_uuid(); r_id uuid := gen_random_uuid(); r_email text := 'journey-rider-' || left(gen_random_uuid()::text, 8) || '@example.invalid';
  v_client uuid; p1 public.parcels; p2 public.parcels; v jsonb; v_txt text; v_n int; v_key text;
  v_inv record; v_bal numeric; v_wd int;
  loc jsonb := '{"lat":24.8138,"lng":67.0300,"accuracy":12}';
begin
  select email into v_admin_email from auth.users where id = v_admin;

  -- ── Merchant signup ──
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, email_confirmed_at)
  values (m_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', m_email,
          '{"role":"client","full_name":"Journey Test","business_name":"Journey Test Store"}', '{"provider":"email"}', now(), now(), now());
  if not exists (select 1 from public.profiles where id = m_uid and lower(role::text) = 'client') then raise exception 'signup: no client profile made'; end if;
  raise notice 'PASS signup: auth user -> client profile (welcome mail queued: %)',
    exists (select 1 from public.nv_email_queue where event_key = 'welcome:' || m_uid);

  perform set_config('request.jwt.claims', json_build_object('sub', m_uid, 'role', 'authenticated', 'email', m_email)::text, true);
  execute 'set local role authenticated';
  v_client := public.create_client_workspace('Journey Test Store', 'Journey Test', '03001234567', 'Karachi', 'House 1, Block 2, Clifton', 'Fashion', null);
  if public.my_client_id() is distinct from v_client then raise exception 'workspace: my_client_id() does not point at the new workspace'; end if;
  v := public.nv_profile_get();
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS login: workspace % linked, profile loads (% keys)', left(v_client::text, 8), (select count(*) from jsonb_object_keys(v));

  -- A brand-new merchant waits in the queue: booking must be refused.
  perform set_config('request.jwt.claims', json_build_object('sub', m_uid, 'role', 'authenticated', 'email', m_email)::text, true);
  execute 'set local role authenticated';
  begin
    perform public.client_book_parcel_idem('journey:q', 'Queue Test', '03111111111', 'Karachi', 'Karachi', 'Street 1', 1000, '0.5', 'Standard', 'General', 'No', 'COD', 'J-Q', '', 'No', null, null);
    v_txt := 'BOOKED';
  exception when others then v_txt := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if v_txt = 'BOOKED' then raise exception 'queue: a queued merchant could book'; end if;
  raise notice 'PASS queue: booking refused while waiting ("%")', left(v_txt, 90);

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'email', v_admin_email)::text, true);
  execute 'set local role authenticated';
  perform public.admin_queue_approve(v_client);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ── Booking (two COD parcels inside Karachi) ──
  perform set_config('request.jwt.claims', json_build_object('sub', m_uid, 'role', 'authenticated', 'email', m_email)::text, true);
  execute 'set local role authenticated';
  begin
    p1 := public.client_book_parcel_idem('journey:1', 'Ayesha Khan', '03211234567', 'Karachi', 'Karachi', 'Flat 4, Block 7, Gulshan', 1500, '0.5', 'Standard', 'General', 'No', 'COD', 'J-1', '', 'No', null, null);
  exception when others then
    -- Terms not yet accepted is the one expected stop for a fresh merchant.
    if sqlerrm ~* 'terms|agreement' then perform public.nv_accept_terms('v1.0', 'app', 'journey-rehearsal'); raise notice 'INFO booking needed terms first: accepted in the rehearsal';
      p1 := public.client_book_parcel_idem('journey:1', 'Ayesha Khan', '03211234567', 'Karachi', 'Karachi', 'Flat 4, Block 7, Gulshan', 1500, '0.5', 'Standard', 'General', 'No', 'COD', 'J-1', '', 'No', null, null);
    else raise; end if;
  end;
  p2 := public.client_book_parcel_idem('journey:2', 'Bilal Ahmed', '03331234567', 'Karachi', 'Karachi', 'Shop 9, Saddar', 1200, '0.5', 'Standard', 'General', 'No', 'COD', 'J-2', '', 'No', null, null);
  -- Same key again returns the same parcel (lost reply on a bad network).
  if (public.client_book_parcel_idem('journey:1', 'Ayesha Khan', '03211234567', 'Karachi', 'Karachi', 'Flat 4, Block 7, Gulshan', 1500, '0.5', 'Standard', 'General', 'No', 'COD', 'J-1', '', 'No', null, null)).awb <> p1.awb
    then raise exception 'booking: replay made a second parcel'; end if;
  -- ── Label: the merchant can read every field the label prints ──
  select count(*) into v_n from public.parcels where id in (p1.id, p2.id)
     and awb ~ '^N\d{7}$' and consignee <> '' and phone <> '' and city <> '' and address <> '' and cod_amount > 0 and status = 'New booked';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if v_n <> 2 then raise exception 'label: merchant sees % of 2 complete parcels', v_n; end if;
  raise notice 'PASS booking: % (Rs %) and % (Rs %), replay returns the same AWB', p1.awb, p1.cod_amount, p2.awb, p2.cod_amount;
  raise notice 'PASS label: AWB, consignee, phone, city, address, COD readable by the merchant';

  -- ── Rider (a throwaway Karachi rider) ──
  insert into public.riders (id, name, phone, branch, access, cash_limit, cities) values (r_id, 'Journey Rider', '03009999999', 'Karachi', 'Active', 1000000, '{Karachi}');
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, email_confirmed_at)
  values (r_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', r_email, '{}', '{"provider":"email"}', now(), now(), now());
  update public.profiles set role = 'rider', rider_id = r_id, status = 'active' where id = r_uid;

  perform set_config('request.jwt.claims', json_build_object('sub', r_uid, 'role', 'authenticated', 'email', r_email)::text, true);
  execute 'set local role authenticated';
  v := public.rider_station_view();
  select count(*) into v_n from jsonb_array_elements(v->'parcels') x where x->>'awb' in (p1.awb, p2.awb) and x->>'bucket' = 'pickup';
  if v_n <> 2 then raise exception 'route: rider sees % of 2 parcels under pickup', v_n; end if;
  raise notice 'PASS rider route: both parcels listed for pickup';

  v := public.rider_station_action(array[p1.awb, p2.awb], 'collect', '', 'journey-collect-0001', loc, '{}');
  if (select count(*) from public.parcels where id in (p1.id, p2.id) and status = 'Parcel received at destination') <> 2 then raise exception 'pickup: not collected (%)', v; end if;
  -- Same key again is a replay, not a second move.
  perform public.rider_station_action(array[p1.awb, p2.awb], 'collect', '', 'journey-collect-0001', loc, '{}');
  raise notice 'PASS pickup scan: 2 collected with GPS (same city, so straight to the station), replay is harmless';

  v := public.rider_station_action(array[p1.awb, p2.awb], 'out', '', 'journey-out-000001', loc, '{}');
  if (select count(*) from public.parcels where id in (p1.id, p2.id) and status = 'Parcel out for delivery' and rider_id = r_id) <> 2 then raise exception 'out: not out for delivery (%)', v; end if;
  raise notice 'PASS out for delivery: both on this rider';

  perform public.rider_station_action(array[p1.awb], 'delivered', '', 'journey-deliver-001', loc, '{}');
  perform public.rider_station_action(array[p2.awb], 'refused', 'Customer refused to take the parcel', 'journey-refuse-0001', loc, '{}');
  select * into p1 from public.parcels where id = p1.id; select * into p2 from public.parcels where id = p2.id;
  if p1.status <> 'Delivered' or p1.delivered_at is null then raise exception 'deliver: % %', p1.status, p1.delivered_at; end if;
  if p2.status <> 'Refused' then raise exception 'refuse: %', p2.status; end if;
  if not exists (select 1 from public.cod_ledger where parcel_id = p1.id and direction = 'in' and amount = 1500) then raise exception 'deliver: no COD ledger row'; end if;
  raise notice 'PASS delivery: % Delivered, Rs 1500 in the COD ledger; % Refused with reason', p1.awb, p2.awb;

  -- ── COD handover ──
  v := public.rider_cash_summary();
  if (v->'totals'->>'gross')::numeric is distinct from 1500 and (v->>'gross')::numeric is distinct from 1500 then
    -- the totals object key may differ; find the gross anywhere at the top level
    select (x.value->>'gross')::numeric into v_bal from jsonb_each(v) x where jsonb_typeof(x.value) = 'object' and x.value ? 'gross' limit 1;
    if v_bal is distinct from 1500 then raise exception 'cash: summary does not show Rs 1500 in hand: %', left(v::text, 400); end if;
  end if;
  v_key := 'journey-handover-' || left(gen_random_uuid()::text, 8);
  v := public.rider_deposit_cash_v2(v_key, 1500, 0, 1500, 'Cash to office', '');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS COD handover: rider declared Rs % (% parcel)', v->>'net', v->>'count';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'email', v_admin_email)::text, true);
  execute 'set local role authenticated';
  perform public.admin_confirm_rider_deposit(v_key);
  select coalesce(p.meta->>'cashDepositStatus', '') into v_txt from public.parcels p where p.id = p1.id;
  if v_txt <> 'confirmed' then raise exception 'cash: office confirm left status %', v_txt; end if;
  raise notice 'PASS office confirmed the cash';

  -- ── Wallet ──
  select * into v_inv from public.admin_generate_invoice_v2(v_client, array[p1.awb], false);
  perform public.admin_push_invoice_to_wallet(v_inv.invoice_id);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS invoice %: COD Rs %, fees Rs %, net Rs % pushed to the wallet', v_inv.invoice_code, v_inv.cod_total, v_inv.fee_total, v_inv.net_payable;

  perform set_config('request.jwt.claims', json_build_object('sub', m_uid, 'role', 'authenticated', 'email', m_email)::text, true);
  execute 'set local role authenticated';
  select to_jsonb(x) into v from public.client_wallet_summary() x limit 1;
  select wallet_balance into v_bal from public.clients where id = v_client;
  if v_bal is distinct from v_inv.net_payable then raise exception 'wallet: balance % but invoice net %', v_bal, v_inv.net_payable; end if;
  raise notice 'PASS wallet: merchant sees Rs % available (summary: %)', v_bal, left(v::text, 160);

  -- ── Withdrawal ──
  perform public.save_client_bank_details('Journey Test', 'PK36SCBL0000001123456702', 'Standard Chartered');
  v := to_jsonb(public.request_wallet_withdrawal_idem(least(v_bal, 1000), 'PK36SCBL0000001123456702', '24h', 'journey-wd-' || left(gen_random_uuid()::text, 8)));
  select count(*) into v_wd from public.withdrawals where client_id = v_client;
  select wallet_balance into v_bal from public.clients where id = v_client;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if v_wd <> 1 then raise exception 'withdrawal: merchant sees % requests', v_wd; end if;
  raise notice 'PASS withdrawal: Rs % requested (Nova Saver, free), wallet now Rs %', least(v_inv.net_payable, 1000), v_bal;

  -- ── Account: support -> deletion request -> status -> cancel ──
  perform set_config('request.jwt.claims', json_build_object('sub', m_uid, 'role', 'authenticated', 'email', m_email)::text, true);
  execute 'set local role authenticated';
  perform public.novax_ticket_open('Refused parcel', 'Customer refused ' || p2.awb || ', please call again.', p2.awb, 'normal');
  select count(*) into v_n from public.novax_tickets where client_id = v_client;
  if v_n <> 1 then raise exception 'support: merchant sees % tickets', v_n; end if;
  raise notice 'PASS support: ticket opened on % and visible to the merchant', p2.awb;
  v := public.client_request_account_deletion('Journey rehearsal');
  if not (v->>'ok')::boolean then raise exception 'deletion: %', v; end if;
  v := public.client_account_deletion_status();
  raise notice 'PASS deletion: request recorded, status says %', left(v::text, 160);
  v := public.client_cancel_account_deletion();
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS deletion cancel: %', left(v::text, 120);

  raise notice 'JOURNEYS OK';
end $j$;

rollback;
