begin;

-- NovaX security batch 2, 10 Sep 2026. Rehearsed in BEGIN/ROLLBACK against
-- production (with batch 1's regression checks) before apply.

-- ---------------------------------------------------------------- is_admin
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- A blocked admin is not an admin. Every RLS policy and admin RPC trusts
    -- this function, and it used to ignore profiles.status entirely.
    select exists(select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
                  and coalesce(p.status::text, 'active') <> 'blocked');
$function$;

-- ---------------------------------------------------------------- is_staff_admin
CREATE OR REPLACE FUNCTION public.is_staff_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role::text in ('admin','ops')
      and coalesce(status::text, 'active') <> 'blocked'
  );
$function$;

-- ================================================================ money permissions
-- Mirrors the portal, where withdrawals and bank details are Owner-only
-- (nvGuardWalletRender). The server let any team seat do both. A login with no
-- seat row is the workspace owner, and legacy primary logins carry role
-- "Client"; Finance, Warehouse, Support and revoked seats are refused.
create or replace function public.nv_client_money_allowed()
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select public.my_client_id() is not null and not exists (
    select 1 from public.staff_users su
     where su.client_id = public.my_client_id()
       and (su.auth_user_id = auth.uid()
            or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
       and (lower(coalesce(su.status, 'Active')) = 'revoked'
            or lower(coalesce(su.role, '')) in ('finance', 'warehouse', 'support'))
  );
$function$;
revoke execute on function public.nv_client_money_allowed() from public, anon;
grant execute on function public.nv_client_money_allowed() to authenticated, service_role;

-- ---------------------------------------------------------------- request_wallet_withdrawal
CREATE OR REPLACE FUNCTION public.request_wallet_withdrawal(p_amount numeric, p_iban text, p_speed text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_balance numeric;
  v_fee numeric;
  v_net numeric;
  v_rate numeric;
  v_iban text;
  v_holder_name text;
  v_bank_name text;
  v_row public.withdrawals;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_money_allowed() then
    raise exception 'Only the workspace Owner can request a withdrawal.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal amount must be greater than zero.';
  end if;

  -- NovaX fix (withdrawal UX v3): saved bank details are only a
  -- convenience/default now, never a hard lock -- p_iban is always what
  -- actually gets paid, whether it matches a saved account or is a brand
  -- new one the client typed/pasted for this withdrawal. It still gets the
  -- same normalization + validation as save_client_bank_details.
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN / bank account details are required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;
  if p_speed not in ('24h','12h','instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  -- Prevent duplicate rapid submissions (double-click / retry storms):
  -- one still-pending request per client per 15-second window.
  if exists (
    select 1 from public.withdrawals
    where client_id = v_client_id and status = 'Pending admin payout'
      and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'A withdrawal request was already submitted. Please wait a moment before trying again.';
  end if;

  -- holder_name/bank_name are read only to snapshot onto the withdrawal row
  -- for admin visibility if the client has saved them -- never required and
  -- never compared against p_iban.
  select coalesce(wallet_balance,0),
    btrim(coalesce(meta->'bank'->>'holderName','')),
    btrim(coalesce(meta->'bank'->>'bankName',''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients where id = v_client_id for update;
  if v_balance is null then
    raise exception 'Client wallet not found.';
  end if;
  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients set wallet_balance = v_balance - p_amount where id = v_client_id;

  insert into public.withdrawals (client_id, amount, fee, net, iban, speed, status, balance_before, holder_name, bank_name)
  values (v_client_id, p_amount, v_fee, v_net, v_iban, p_speed, 'Pending admin payout', v_balance, nullif(v_holder_name,''), nullif(v_bank_name,''))
  returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'withdrawal_requested', -p_amount, true, 'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested: Rs ' || p_amount || ' reserved, ' || v_net || ' net after Rs ' || v_fee || ' fee (' || p_speed || ').');
  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'payout_fee', -v_fee, false, 'Informational', 'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).');

  return v_row;
end;
$function$;

-- ---------------------------------------------------------------- save_client_bank_details
CREATE OR REPLACE FUNCTION public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text DEFAULT ''::text)
 RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
  v_holder text;
  v_iban text;
  v_bank text;
  v_now timestamptz;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if not public.nv_client_money_allowed() then
    raise exception 'Only the workspace Owner can change bank details.' using errcode = '42501';
  end if;

  v_holder := btrim(coalesce(p_holder_name, ''));
  if v_holder = '' then
    raise exception 'Account holder name is required.';
  end if;

  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN is required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;

  v_bank := btrim(coalesce(p_bank_name, ''));
  v_now := now();

  update public.clients
    set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{bank}', jsonb_build_object(
      'holderName', v_holder, 'iban', v_iban, 'bankName', v_bank, 'updatedAt', v_now
    ), true)
    where id = v_client_id;

  holder_name := v_holder; iban := v_iban; bank_name := v_bank; updated_at := v_now;
  return next;
end;
$function$;

-- ---------------------------------------------------------------- nv_api_resolve_key_v2
CREATE OR REPLACE FUNCTION public.nv_api_resolve_key_v2(p_key text, p_is_booking boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_hash text; v_row public.nv_api_key; v_name text; v_now timestamptz := now();
begin
  v_hash := encode(extensions.digest(coalesce(p_key,''), 'sha256'), 'hex');
  -- FOR UPDATE: concurrent requests on one key used to read the same count,
  -- all pass the limit, and each write back count+1 -- admitting extra
  -- bookings and undercounting them. They now queue on the key row.
  select * into v_row from public.nv_api_key where key_hash = v_hash and not revoked for update;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_key'); end if;
  -- A deactivated merchant's keys pause with the account. Deactivation only
  -- flipped clients.status, so booking, reading, editing and cancelling all
  -- carried on through the API.
  if exists (select 1 from public.clients c
              where c.id = v_row.client_id
                and lower(coalesce(c.status, 'Active')) in ('inactive','suspended','blocked','deactivated','disabled','closed')) then
    return jsonb_build_object('ok', false, 'error', 'account_inactive');
  end if;

  -- rolling hourly windows
  if v_row.rate_window_start is null or v_row.rate_window_start < v_now - interval '1 hour' then
    v_row.rate_window_start := v_now; v_row.rate_window_count := 0;
  end if;
  if v_row.book_window_start is null or v_row.book_window_start < v_now - interval '1 hour' then
    v_row.book_window_start := v_now; v_row.book_window_count := 0;
  end if;

  if v_row.rate_window_count >= v_row.rate_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'rate_limited',
      'limit', v_row.rate_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.rate_window_start + interval '1 hour' - v_now)))::int));
  end if;
  if p_is_booking and v_row.book_window_count >= v_row.book_limit_per_hour then
    return jsonb_build_object('ok', false, 'error', 'booking_rate_limited',
      'limit', v_row.book_limit_per_hour, 'window', 'hour',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_row.book_window_start + interval '1 hour' - v_now)))::int));
  end if;

  update public.nv_api_key
     set last_used_at = v_now,
         request_count = request_count + 1,
         rate_window_start = v_row.rate_window_start,
         rate_window_count = v_row.rate_window_count + 1,
         book_window_start = v_row.book_window_start,
         book_window_count = v_row.book_window_count + (case when p_is_booking then 1 else 0 end)
   where id = v_row.id;

  select name into v_name from public.clients where id = v_row.client_id;
  return jsonb_build_object('ok', true, 'client_id', v_row.client_id, 'client_name', v_name,
    'webhook_url', v_row.webhook_url, 'key_id', v_row.id);
end $function$;

-- ---------------------------------------------------------------- ensure_ticket_from_issue
CREATE OR REPLACE FUNCTION public.ensure_ticket_from_issue(p_source_key text, p_client_id uuid, p_subject text, p_body text, p_tier text DEFAULT 'medium'::text, p_from text DEFAULT 'System Monitor'::text, p_to text DEFAULT 'Admin Control'::text, p_branch text DEFAULT 'Admin'::text, p_awb text DEFAULT ''::text, p_age_hours numeric DEFAULT 0, p_escalated boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id        uuid;
  v_escalated boolean;
  v_to        text;
  v_code      text;
  v_limit     numeric;
begin
  -- Internal only: the SLA cron (no signed-in user) and NovaX staff. Anonymous
  -- visitors could call this and file "System Monitor" tickets or force an
  -- emergency escalation.
  if auth.uid() is not null and not (public.is_admin() or public.is_staff_admin()) then
    raise exception 'Not authorised to create system tickets.' using errcode = '42501';
  end if;
  if p_source_key is null or p_source_key = '' then
    raise exception 'ensure_ticket_from_issue requires a sourceKey';
  end if;

  select escalate_after_hours into v_limit from public.support_hours where id = 1;
  v_limit := coalesce(v_limit, 24);

  -- Reopen-safe: an already-open ticket for this sourceKey is refreshed,
  -- never duplicated. A resolved one is left alone so closed work does
  -- not silently come back to life.
  select id into v_id
    from public.tickets
   where meta->>'sourceKey' = p_source_key
     and status <> 'Resolved'
   limit 1;

  v_escalated := p_escalated or coalesce(p_age_hours, 0) >= v_limit;
  v_to := case when v_escalated then 'Admin Control' else p_to end;

  if v_id is not null then
    update public.tickets t
       set meta = t.meta
                  || jsonb_build_object(
                       'ageHours', greatest(coalesce((t.meta->>'ageHours')::numeric, 0), coalesce(p_age_hours, 0)),
                       'escalated', coalesce((t.meta->>'escalated')::boolean, false) or v_escalated
                     )
                  || case when v_escalated then jsonb_build_object('to', 'Admin Control') else '{}'::jsonb end,
           escalated_at = coalesce(t.escalated_at, case when v_escalated then now() else null end),
           updated_at = now()
     where t.id = v_id;
    return v_id;
  end if;

  -- Human-readable code in the same TCK-0000 shape the browsers generate.
  v_code := 'TCK-' || lpad(((select count(*) from public.tickets) + 1)::text, 4, '0');

  insert into public.tickets (client_id, subject, body, status, first_response_at, meta)
  values (
    p_client_id, p_subject, p_body, 'Open', null,
    jsonb_build_object(
      'code', v_code, 'sourceKey', p_source_key,
      'tier', case when v_escalated then 'emergency' else coalesce(p_tier, 'medium') end,
      'from', p_from, 'to', v_to, 'branch', p_branch, 'awb', coalesce(p_awb, ''),
      'ageHours', coalesce(p_age_hours, 0), 'escalated', v_escalated,
      'replies', '[]'::jsonb, 'source', 'sla-cron'
    )
  )
  -- The unique index is partial (WHERE sourceKey IS NOT NULL). Without the
  -- same predicate here Postgres cannot use it, so every new ticket raised
  -- "no unique or exclusion constraint matching the ON CONFLICT" and the SLA
  -- cron created nothing.
  on conflict ((meta->>'sourceKey')) where (meta->>'sourceKey') is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.tickets where meta->>'sourceKey' = p_source_key limit 1;
  end if;

  if v_escalated and v_id is not null then
    update public.tickets set escalated_at = coalesce(escalated_at, now()) where id = v_id;
  end if;

  return v_id;
end $function$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('ensure_ticket_from_issue','claim_ticket','release_ticket',
              'ticket_mark_first_response','submit_ticket_csat','novax_ticket_client_reply','novax_ticket_open')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;
revoke insert, update, delete on public.tickets, public.novax_tickets, public.payment_logs,
  public.cod_ledger, public.operations_issues from anon;

-- ================================================================ signup leads
-- The anon UPDATE policy let anyone rewrite every pending lead -- contact
-- details, status, linked user id. Leads are now written through two narrow
-- functions: create one, and move one forward within two hours of creating it.
drop policy if exists "anon update pending signup_leads" on public.signup_leads;
revoke update, delete on public.signup_leads from anon;

create or replace function public.nv_signup_lead_create(
  p_name text, p_phone text, p_email text, p_city text, p_address text,
  p_business_type text, p_website text, p_auth_user_id uuid default null)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  insert into public.signup_leads (name, phone, email, city, address, business_type, website, auth_user_id, status)
  values (left(coalesce(p_name, ''), 200), left(coalesce(p_phone, ''), 40), left(lower(coalesce(p_email, '')), 200),
          left(coalesce(p_city, ''), 80), left(coalesce(p_address, ''), 500), left(coalesce(p_business_type, ''), 200),
          left(coalesce(p_website, ''), 300),
          -- only a user id that exists AND belongs to this email is linked
          (select u.id from auth.users u where u.id = p_auth_user_id and lower(u.email) = lower(coalesce(p_email, ''))),
          'pending_workspace')
  returning id into v_id;
  return v_id;
end
$function$;
create or replace function public.nv_signup_lead_mark(p_lead_id uuid, p_status text, p_error text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if p_status not in ('awaiting_verification', 'failed', 'workspace_created') then
    raise exception 'Unknown lead status.';
  end if;
  update public.signup_leads
     set status = p_status,
         error_message = case when p_status = 'failed' then left(coalesce(p_error, ''), 300) else error_message end
   where id = p_lead_id
     and status in ('pending_workspace', 'awaiting_verification')
     and created_at > now() - interval '2 hours';
end
$function$;
revoke execute on function public.nv_signup_lead_create(text,text,text,text,text,text,text,uuid) from public;
grant execute on function public.nv_signup_lead_create(text,text,text,text,text,text,text,uuid) to anon, authenticated, service_role;
revoke execute on function public.nv_signup_lead_mark(uuid,text,text) from public;
grant execute on function public.nv_signup_lead_mark(uuid,text,text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- parcels_guard_columns
CREATE OR REPLACE FUNCTION public.parcels_guard_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;

  new.awb := old.awb;
  new.client_id := old.client_id;
  new.rider_id := old.rider_id;
  new.fee := old.fee;
  new.booked_at := old.booked_at;

  /* Consignee details and COD change in exactly one situation: the merchant
     correcting their own booking through nv_edit_parcel_core(), which re-checks
     ownership, status, invoicing and rider assignment and sets this
     transaction-local flag right before its UPDATE. nv_freeze_parcel_money
     still refuses COD once a parcel has moved. */
  if coalesce(current_setting('novax.parcel_edit', true), '') <> '1' then
    new.consignee := old.consignee;
    new.city := old.city;
    new.address := old.address;
    new.phone := old.phone;
    new.cod_amount := old.cod_amount;
  end if;

  /* Settlement state. invoice_id decides whether a parcel can be invoiced
     again; a merchant clearing it made the same parcel invoiceable twice. */
  new.invoice_id := old.invoice_id;
  new.invoiced_at := old.invoiced_at;
  new.delivery_charge_posted_at := old.delivery_charge_posted_at;

  /* Delivery evidence. "COD collected" in meta.steps makes a parcel
     invoiceable; cashReceived and deliveredBy are what the rider records at
     the door. Only the rider carrying the parcel may add them. */
  if not (old.rider_id is not null and old.rider_id = public.my_rider_id()) then
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
    new.meta := (coalesce(new.meta, '{}'::jsonb) - 'cashReceived' - 'deliveredBy')
                || jsonb_strip_nulls(jsonb_build_object(
                     'cashReceived', old.meta -> 'cashReceived',
                     'deliveredBy',  old.meta -> 'deliveredBy'));
  elsif coalesce(new.status, '') <> 'Delivered' then
    -- Even the carrying rider records cash only on a delivered parcel.
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
  end if;

  return new;
end;
$function$;

-- ================================================================ rider evidence
-- RLS only checked that the row named the rider themselves. Nothing checked
-- the parcel was theirs, the amount was its COD, the client was its owner, or
-- that it had been delivered.
create or replace function public.nv_guard_rider_cod_ledger()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_p public.parcels;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  select * into v_p from public.parcels where id = new.parcel_id;
  if not found or v_p.rider_id is null or v_p.rider_id is distinct from public.my_rider_id() then
    raise exception 'This parcel is not assigned to you, so its cash cannot be recorded.' using errcode = '42501';
  end if;
  if coalesce(new.direction, '') <> 'in' then
    raise exception 'Riders can only record cash collected.' using errcode = '42501';
  end if;
  if coalesce(v_p.status, '') <> 'Delivered' then
    raise exception 'Cash can only be recorded once the parcel is Delivered (it is "%").', v_p.status using errcode = 'P0001';
  end if;
  new.rider_id  := v_p.rider_id;
  new.client_id := v_p.client_id;
  new.amount    := coalesce(v_p.cod_amount, 0);
  new.reference := v_p.awb;
  return new;
end
$function$;
drop trigger if exists trg_nv_guard_rider_cod_ledger on public.cod_ledger;
create trigger trg_nv_guard_rider_cod_ledger before insert on public.cod_ledger
  for each row execute function public.nv_guard_rider_cod_ledger();

create or replace function public.nv_guard_rider_scans()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_p public.parcels;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  select * into v_p from public.parcels where id = new.parcel_id;
  if not found or v_p.rider_id is null or v_p.rider_id is distinct from public.my_rider_id() then
    raise exception 'This parcel is not assigned to you.' using errcode = '42501';
  end if;
  new.rider_id := v_p.rider_id;
  -- A scan must record a state the parcel is in, or has really been in.
  if coalesce(new.status, '') <> '' and new.status is distinct from v_p.status
     and not exists (select 1 from public.nv_parcel_status_log l
                      where l.parcel_id = v_p.id and l.to_status = new.status) then
    raise exception 'A scan must match a status this parcel has actually had.' using errcode = 'P0001';
  end if;
  return new;
end
$function$;
drop trigger if exists trg_nv_guard_rider_scans on public.scans;
create trigger trg_nv_guard_rider_scans before insert on public.scans
  for each row execute function public.nv_guard_rider_scans();

-- ================================================================ payment history
-- Merchants could insert any payment_logs row for their own client -- any
-- type, amount and status -- and finance reads this history. The portal only
-- ever writes two kinds; both are now checked against the real record.
create or replace function public.nv_guard_payment_logs()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_p public.parcels; v_w public.withdrawals;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  new.client_id := public.my_client_id();
  if new.client_id is null then
    raise exception 'Not signed in as a merchant.' using errcode = '42501';
  end if;
  if new.type = 'COD expected' then
    select * into v_p from public.parcels where client_id = new.client_id and awb = new.reference;
    if not found then
      raise exception 'Payment history can only reference your own parcels.' using errcode = '42501';
    end if;
    new.amount := coalesce(v_p.cod_amount, 0);
    new.status := 'Awaiting delivery';
    return new;
  elsif new.type = 'Wallet withdrawal requested' then
    select * into v_w from public.withdrawals
     where client_id = new.client_id and amount = new.amount and created_at > now() - interval '1 hour'
     order by created_at desc limit 1;
    if not found then
      raise exception 'No matching withdrawal request.' using errcode = '42501';
    end if;
    new.status := v_w.status;
    return new;
  end if;
  raise exception 'Payment history is recorded by NovaX, not from the portal.' using errcode = '42501';
end
$function$;
drop trigger if exists trg_nv_guard_payment_logs on public.payment_logs;
create trigger trg_nv_guard_payment_logs before insert on public.payment_logs
  for each row execute function public.nv_guard_payment_logs();

-- ---------------------------------------------------------------- nv_book_parcel_core
CREATE OR REPLACE FUNCTION public.nv_book_parcel_core(p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text DEFAULT ''::text, p_reference_no text DEFAULT ''::text, p_source text DEFAULT 'admin_portal'::text, p_actor_role text DEFAULT 'admin'::text)
 RETURNS parcels
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_code text; v_prefix text; v_max int; v_awb text;
  v_now timestamptz := now();
  v_rate numeric; v_rate_card jsonb; v_zone text;
  v_base numeric; v_addl_rate numeric;
  v_weight_kg numeric; v_extra_kg numeric; v_fee numeric;
  v_meta jsonb; v_row public.parcels;
begin
  if p_client_id is null then
    raise exception 'Select a client first.';
  end if;
  -- Books against whatever client id it is handed, and PUBLIC could execute
  -- it. NovaX itself (service role: the API, Shopify intake), admins, and a
  -- merchant booking for their own account only.
  if auth.uid() is not null
     and not (public.is_admin() or public.is_staff_admin() or p_client_id = public.my_client_id()) then
    raise exception 'Not authorised to book for this client.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'That client does not exist.';
  end if;
  if coalesce(btrim(p_consignee), '') = '' then
    raise exception 'Consignee name is required.';
  end if;

  -- 'Infinity' and 'NaN' are valid numerics in Postgres; neither is a COD.
  if p_cod is not null and (p_cod < 0 or p_cod = 'Infinity'::numeric or p_cod = 'NaN'::numeric) then
    raise exception 'COD amount must be a number, zero or more.' using errcode = 'P0001';
  end if;

  -- P0-002. Every booking path lands here: the client portal, admin
  -- "Book For Client", the Shopify intake and the merchant API. The API
  -- already rejects this with a 422 and the portal derives the mode from the
  -- COD amount, but admin booking had no guard at all -- so the one route
  -- operated by NovaX itself was the one that could still create the parcel
  -- that loses money later. Refuse it here, where nothing can bypass it.
  if public.nv_is_payment_conflict(p_payment_mode, p_cod) then
    raise exception
      'This parcel is marked "%" but carries a COD amount of Rs %. A prepaid parcel collects nothing at the door. Set COD to 0, or change the payment mode to COD.',
      btrim(p_payment_mode), trim(to_char(p_cod, 'FM999,999,999'))
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('novax_awb_' || p_client_id::text));

  v_awb := public.nv_next_awb(p_client_id);

  select c.rate, c.rate_card into v_rate, v_rate_card from public.clients c where c.id = p_client_id;
  v_rate := coalesce(v_rate, 250);
  v_zone := case when lower(coalesce(p_city, '')) = 'karachi' then 'A' else 'B' end;

  if v_rate_card is not null and jsonb_typeof(v_rate_card -> v_zone) = 'object' then
    v_base      := coalesce((v_rate_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_rate_card is not null and (v_rate_card ->> 'overnight') is not null then
    v_base      := coalesce((v_rate_card ->> 'overnight')::numeric, v_rate);
    v_addl_rate := coalesce((v_rate_card ->> 'additionalKg')::numeric, 85);
  else
    v_base := v_rate; v_addl_rate := 85;
  end if;

  v_weight_kg := public.nv_parse_weight_kg(p_weight);
  if v_weight_kg <= 0 then v_weight_kg := 0.8; end if;
  v_extra_kg := ceil(greatest(0, least(v_weight_kg, 5) - 1));
  v_fee := v_base + (v_extra_kg * v_addl_rate);

  v_meta := jsonb_build_object(
    'source', p_source,
    'bookedByAdmin', (p_actor_role = 'admin'),
    'pickupCity', coalesce(p_pickup_city, ''),
    'service', coalesce(p_service, ''),
    'category', coalesce(p_category, ''),
    'fragile', coalesce(p_fragile, 'No'),
    'weight', coalesce(p_weight, '0.8 kg'),
    'paymentMode', coalesce(p_payment_mode, 'COD'),
    'orderId', coalesce(p_order_id, ''),
    'referenceNo', coalesce(p_reference_no, ''),
    'branch', coalesce(nullif(btrim(p_pickup_city), ''), 'Karachi') || ' Hub',
    'stage', 0,
    'totalStages', 16,
    'steps', jsonb_build_array('New booked'),
    'statusSince', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.parcels (
    awb, client_id, consignee, phone, address, city, status,
    cod_amount, fee, booked_at, updated_at, meta
  ) values (
    v_awb, p_client_id, btrim(p_consignee), coalesce(p_phone, ''), coalesce(p_address, ''),
    coalesce(p_city, ''), 'New booked', coalesce(p_cod, 0), v_fee, v_now, v_now, v_meta
  )
  returning * into v_row;

  insert into public.parcel_admin_audit (awb, client_id, action, changes, actor_id, actor_role)
  values (v_awb, p_client_id,
          case when p_actor_role = 'admin' then 'admin_booked' else 'shopify_booked' end,
          jsonb_build_object('cod', coalesce(p_cod,0), 'fee', v_fee,
                             'city', coalesce(p_city,''), 'source', p_source),
          auth.uid(), p_actor_role);

  return v_row;
end;
$function$;

revoke execute on function public.nv_book_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.nv_book_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) to authenticated, service_role;

-- ================================================================ API idempotency
create or replace function public.nv_book_parcel_api_idem(
  p_client_id uuid, p_idem_key text, p_consignee text, p_phone text, p_pickup_city text,
  p_city text, p_address text, p_cod numeric, p_weight text, p_service text, p_category text,
  p_fragile text, p_payment_mode text, p_order_id text default ''::text,
  p_reference_no text default ''::text, p_source text default 'merchant_api'::text,
  p_actor_role text default 'api'::text)
 returns parcels language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_key text := left(btrim(coalesce(p_idem_key, '')), 200);
  v_hit public.nv_booking_idempotency;
  v_row public.parcels;
begin
  if p_client_id is null then raise exception 'Select a client first.'; end if;
  if v_key <> '' then
    perform pg_advisory_xact_lock(hashtext('novax_idem_' || p_client_id::text || ':' || v_key));
    select * into v_hit from public.nv_booking_idempotency where client_id = p_client_id and idem_key = v_key;
    if found and v_hit.created_at > now() - interval '24 hours' then
      select * into v_row from public.parcels where id = v_hit.parcel_id and client_id = p_client_id;
      if found and v_row.status is distinct from 'Cancelled by client' then
        return v_row;
      end if;
    end if;
  end if;
  v_row := public.nv_book_parcel_core(p_client_id, p_consignee, p_phone, p_pickup_city, p_city, p_address,
    p_cod, p_weight, p_service, p_category, p_fragile, p_payment_mode, p_order_id, p_reference_no,
    p_source, p_actor_role);
  if v_key <> '' then
    insert into public.nv_booking_idempotency (client_id, idem_key, parcel_id, awb)
    values (p_client_id, v_key, v_row.id, v_row.awb)
    on conflict (client_id, idem_key) do update
      set parcel_id = excluded.parcel_id, awb = excluded.awb, created_at = now();
  end if;
  return v_row;
end
$function$;
revoke execute on function public.nv_book_parcel_api_idem(uuid,text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.nv_book_parcel_api_idem(uuid,text,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) to service_role;

commit;
