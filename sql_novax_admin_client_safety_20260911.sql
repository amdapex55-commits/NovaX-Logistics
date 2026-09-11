begin;

-- NovaX batch 8, 11 Sep 2026: admin client saves keep bank details; client
-- delete is one transaction.

-- Admin's background save rebuilt clients.meta from the fields it knows,
-- which never included the merchant's saved bank details, so editing a client
-- (pickup city, details, rates) erased them. A merchant saving bank details
-- always sends the key, so that path is unaffected.
create or replace function public.nv_preserve_client_bank()
 returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if old.meta ? 'bank' and not (coalesce(new.meta, '{}'::jsonb) ? 'bank') then
    new.meta := (case when jsonb_typeof(new.meta) = 'object' then new.meta else '{}'::jsonb end)
                || jsonb_build_object('bank', old.meta -> 'bank');
  end if;
  return new;
end
$function$;
drop trigger if exists trg_nv_preserve_client_bank on public.clients;
create trigger trg_nv_preserve_client_bank before update on public.clients
  for each row execute function public.nv_preserve_client_bank();

-- Delete a client in one transaction. The browser used to run four separate
-- deletes; staff_users has no cascade, so a client with a team seat lost its
-- parcels and invoices and then failed on the final step, half-deleted.
-- Clients with any financial history are refused, exactly as before.
create or replace function public.admin_delete_client(p_client_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text; v_bal numeric;
  n_w int; n_pl int; n_l int; n_par int; n_inv int; n_seat int; n_prof int;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  select name, coalesce(wallet_balance, 0) into v_name, v_bal
    from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'That client no longer exists.';
  end if;
  select count(*) into n_w  from public.withdrawals   where client_id = p_client_id;
  select count(*) into n_pl from public.payment_logs  where client_id = p_client_id;
  select count(*) into n_l  from public.wallet_ledger where client_id = p_client_id;
  if n_w > 0 or n_pl > 0 or n_l > 0 or v_bal <> 0 then
    raise exception 'This client has financial history (% payout(s), % payment log(s), % ledger row(s), balance Rs %). Set the account to Inactive instead.',
      n_w, n_pl, n_l, v_bal using errcode = 'P0001';
  end if;
  select count(*) into n_par from public.parcels  where client_id = p_client_id;
  select count(*) into n_inv from public.invoices where client_id = p_client_id;
  delete from public.staff_users where client_id = p_client_id;
  get diagnostics n_seat = row_count;
  update public.profiles set status = 'blocked', client_id = null where client_id = p_client_id;
  get diagnostics n_prof = row_count;
  delete from public.parcels  where client_id = p_client_id;
  delete from public.invoices where client_id = p_client_id;
  delete from public.clients  where id = p_client_id;
  return jsonb_build_object('ok', true, 'name', v_name, 'parcels', n_par, 'invoices', n_inv,
                            'seats', n_seat, 'logins_unlinked', n_prof);
end
$function$;
revoke execute on function public.admin_delete_client(uuid) from public, anon;
grant execute on function public.admin_delete_client(uuid) to authenticated, service_role;

commit;
