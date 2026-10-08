-- Limited staff logins: a rehearsal against the REAL database that changes
-- nothing. It applies sql_novax_staff_limits_20261009.sql inside one
-- transaction, makes an existing support login a limited staff member, tries
-- what each section needs and everything money-related, prints one line per
-- try, and ROLLS BACK. Run from the repo root:
--   psql "<connection>" -X -q -At -v ON_ERROR_STOP=1 -f scripts/rehearse-staff-limits.sql
-- Every "ALLOWED" line must say ok or a count; every "REFUSED" line must be a
-- refusal or 0; no line may start with WRONG.
begin;
set local lock_timeout = '4s'; set local statement_timeout = '60s';
create temp table t_out(n serial, line text); grant all on t_out to authenticated; grant usage on sequence t_out_n_seq to authenticated;
do $$
declare v_uid uuid; v_email text; v_n int;
begin
  select a.auth_user_id, lower(a.email) into v_uid, v_email from public.cs_agents a where a.status = 'Active' and a.auth_user_id is not null limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated','email', v_email)::text, true); execute 'set local role authenticated';
  select count(*) into v_n from public.parcels;
  insert into t_out(line) values ('BEFORE the file: a support login reads ' || v_n || ' parcels');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
end $$;
\i sql_novax_staff_limits_20261009.sql
\i sql_novax_staff_limits_20261009.sql
do $$
declare v_uid uuid; v_email text; v_n int; r jsonb; o public.parcels; c uuid; v_txt text; v_bal numeric; v_owner uuid;
  procedure_note text;
begin
  select a.auth_user_id, lower(a.email) into v_uid, v_email from public.cs_agents a where a.status = 'Active' and a.auth_user_id is not null limit 1;
  select * into o from public.parcels where status = 'Parcel out for delivery' limit 1;
  select id into c from public.clients where name = 'Hayat Scents';
  insert into public.staff_users (code, name, email, role, access_side, branch, status, permissions, auth_user_id)
  values ('USR-REH', 'Rehearsal Staff', v_email, 'Client Support', 'Admin Portal', 'Karachi Hub', 'Active',
          '["dashboard","orders-view","orders-book","orders-processing","manifest","demanifest","pickups","support-tickets","clients","riders"]'::jsonb, v_uid);

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated','email', v_email)::text, true); execute 'set local role authenticated';
  insert into t_out(line) values ('me: ' || public.nv_staff_me()::text);
  insert into t_out(line) values ('is_admin=' || public.is_admin() || ' can_process_orders=' || public.can_process_orders());
  -- what the sections need
  select count(*) into v_n from public.parcels;          insert into t_out(line) values ('ALLOWED reads parcels: ' || v_n);
  select count(*) into v_n from public.clients;          insert into t_out(line) values ('ALLOWED reads merchants: ' || v_n);
  select count(*) into v_n from public.riders;           insert into t_out(line) values ('ALLOWED reads riders: ' || v_n);
  select count(*) into v_n from public.pickup_requests;  insert into t_out(line) values ('ALLOWED reads pickup requests: ' || v_n);
  select count(*) into v_n from public.novax_tickets;    insert into t_out(line) values ('ALLOWED reads support tickets: ' || v_n);
  select count(*) into v_n from public.manifest_logs;    insert into t_out(line) values ('ALLOWED reads manifests: ' || v_n);
  begin r := to_jsonb(public.admin_book_parcel_for_client(c, 'Rehearsal Customer', '03001234567', 'Karachi', 'Karachi', 'House 1, Test Street', 1500, '1 kg', 'COD Standard', 'test', 'No', 'COD'));
        insert into t_out(line) values ('ALLOWED create booking: ' || (r->>'awb') || ' fee ' || (r->>'fee'));
  exception when others then insert into t_out(line) values ('create booking FAILED: ' || sqlerrm); end;
  begin update public.parcels set status = 'Refused' where id = o.id; get diagnostics v_n = row_count;
        insert into t_out(line) values ('ALLOWED order processing, status change: ' || v_n || ' row');
  exception when others then insert into t_out(line) values ('status change FAILED: ' || sqlerrm); end;
  begin r := to_jsonb(public.admin_processing_lookup(array[o.awb])); insert into t_out(line) values ('ALLOWED processing lookup: ok');
  exception when others then insert into t_out(line) values ('processing lookup FAILED: ' || sqlerrm); end;
  begin r := public.admin_rider_board(7); insert into t_out(line) values ('ALLOWED riders board: ok');
  exception when others then insert into t_out(line) values ('riders board FAILED: ' || sqlerrm); end;
  begin perform public.admin_kyc_list(); insert into t_out(line) values ('ALLOWED CNIC review list: ok');
  exception when others then insert into t_out(line) values ('CNIC list FAILED: ' || sqlerrm); end;
  begin perform public.admin_search_clients('hayat'); insert into t_out(line) values ('ALLOWED merchant search: ok');
  exception when others then insert into t_out(line) values ('merchant search FAILED: ' || sqlerrm); end;
  -- money and control: every one of these must be refused or empty
  select count(*) into v_n from public.wallet_ledger;  insert into t_out(line) values ('REFUSED wallet ledger rows visible: ' || v_n);
  select count(*) into v_n from public.withdrawals;    insert into t_out(line) values ('REFUSED withdrawals visible: ' || v_n);
  select count(*) into v_n from public.invoices;       insert into t_out(line) values ('REFUSED invoices visible: ' || v_n);
  select count(*) into v_n from public.expenses;       insert into t_out(line) values ('REFUSED expenses visible: ' || v_n);
  select count(*) into v_n from public.payment_logs;   insert into t_out(line) values ('REFUSED payment logs visible: ' || v_n);
  select count(*) into v_n from public.staff_users;    insert into t_out(line) values ('staff rows visible (own only): ' || v_n);
  select count(*) into v_n from public.profiles;       insert into t_out(line) values ('profiles visible (self only): ' || v_n);
  begin perform public.admin_wallet_adjustment(c, 1000, 'rehearsal'); insert into t_out(line) values ('WRONG: wallet adjustment went through');
  exception when others then insert into t_out(line) values ('REFUSED wallet adjustment: ' || sqlerrm); end;
  begin perform public.admin_list_wallet_balances(); insert into t_out(line) values ('WRONG: wallet balances list went through');
  exception when others then insert into t_out(line) values ('REFUSED wallet balances list: ' || left(sqlerrm, 60)); end;
  begin perform public.cs_recover_config_set('{"fee":1}'); insert into t_out(line) values ('WRONG: Nova Recover settings changed');
  exception when others then insert into t_out(line) values ('REFUSED Nova Recover settings: ' || sqlerrm); end;
  update public.clients set wallet_balance = 999999 where id = c; get diagnostics v_n = row_count;
  insert into t_out(line) values ('REFUSED edit a merchant''s wallet directly: ' || v_n || ' rows changed');
  begin update public.parcels set cod_amount = cod_amount + 500 where id = o.id; insert into t_out(line) values ('WRONG: COD changed');
  exception when others then insert into t_out(line) values ('REFUSED change a COD: ' || left(sqlerrm, 70)); end;
  begin update public.parcels set fee = 1 where id = o.id; insert into t_out(line) values ('fee after edit attempt: ' || (select fee::text from public.parcels where id = o.id) || ' (was ' || o.fee || ')');
  exception when others then insert into t_out(line) values ('REFUSED change a delivery fee: ' || left(sqlerrm, 70)); end;
  begin perform public.admin_set_rider_limit((select id from public.riders limit 1), 1); insert into t_out(line) values ('WRONG: rider cash limit changed');
  exception when others then insert into t_out(line) values ('REFUSED rider cash limit: ' || left(sqlerrm, 60)); end;
  delete from public.parcels where id = o.id; get diagnostics v_n = row_count;
  insert into t_out(line) values ('REFUSED delete a parcel: ' || v_n || ' rows deleted');
  begin
    insert into public.staff_users (code, name, email, role, access_side, status, permissions) values ('X', 'x', 'x@x.invalid', 'Admin', 'Admin Portal', 'Active', '[]');
    insert into t_out(line) values ('WRONG: created a staff row');
  exception when others then insert into t_out(line) values ('REFUSED create another staff login: ' || left(sqlerrm, 70)); end;
  begin
    update public.staff_users set permissions = '["users","finance-invoices"]' where code = 'USR-REH'; get diagnostics v_n = row_count;
    insert into t_out(line) values ('REFUSED give itself more permissions: ' || v_n || ' rows changed');
  exception when others then insert into t_out(line) values ('REFUSED give itself more permissions: ' || left(sqlerrm, 60)); end;
  begin
    update public.profiles set role = 'admin' where id = v_uid; get diagnostics v_n = row_count;
    insert into t_out(line) values ('make itself admin: ' || v_n || ' rows changed, role now ' || (select role::text from public.profiles where id = v_uid));
  exception when others then insert into t_out(line) values ('REFUSED make itself admin: ' || left(sqlerrm, 60)); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
end $$;
do $$
declare v_uid uuid; v_email text; v_n int; o public.parcels; c uuid;
begin
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select a.auth_user_id, lower(a.email) into v_uid, v_email from public.cs_agents a where a.status = 'Active' and a.auth_user_id is not null limit 1;
  select * into o from public.parcels where status = 'Parcel out for delivery' limit 1; select id into c from public.clients where name = 'Hayat Scents';
  -- only "view all orders" ticked
  update public.staff_users set permissions = '["orders-view"]' where code = 'USR-REH';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated','email', v_email)::text, true); execute 'set local role authenticated';
  select count(*) into v_n from public.parcels; insert into t_out(line) values ('VIEW-ONLY reads parcels: ' || v_n);
  update public.parcels set status = 'Refused' where id = o.id; get diagnostics v_n = row_count; insert into t_out(line) values ('VIEW-ONLY status change: ' || v_n || ' rows');
  begin perform public.admin_book_parcel_for_client(c, 'X', '03001234567', 'Karachi', 'Karachi', 'House 1, Test Street', 1, '1 kg', 'COD Standard', 't', 'No', 'COD'); insert into t_out(line) values ('WRONG: view-only booked a parcel');
  exception when others then insert into t_out(line) values ('VIEW-ONLY create booking refused: ' || left(sqlerrm, 60)); end;
  select count(*) into v_n from public.novax_tickets; insert into t_out(line) values ('VIEW-ONLY reads tickets: ' || v_n);
  execute 'reset role';
  -- switched off by an admin
  update public.staff_users set status = 'Disabled', permissions = '["orders-view","orders-processing"]' where code = 'USR-REH';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated','email', v_email)::text, true); execute 'set local role authenticated';
  select count(*) into v_n from public.parcels; insert into t_out(line) values ('DISABLED login reads parcels: ' || v_n);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  -- a merchant is untouched
  select p.id into v_uid from public.profiles p where p.client_id = c and p.role::text = 'client' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated')::text, true); execute 'set local role authenticated';
  insert into t_out(line) values ('MERCHANT staff perms: ' || coalesce(public.nv_staff_perms()::text, 'none') || ', reads only own parcels: ' || (select (count(*) = count(*) filter (where client_id = c))::text from public.parcels) || ', other merchants visible: ' || (select count(*) - 1 from public.clients));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
end $$;
select line from t_out order by n;
select 'callable signed out: ' || coalesce(string_agg(p.proname, ', '), 'none') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'nv_staff%' and has_function_privilege('anon', p.oid, 'execute');
rollback;
select 'left behind: ' || (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'nv_staff%') || ' functions, ' || (select count(*) from pg_policies where policyname like 'nv_staff%') || ' policies, booking core patched=' || (position('nv_staff_' in pg_get_functiondef('public.nv_book_parcel_core'::regproc)) > 0);
