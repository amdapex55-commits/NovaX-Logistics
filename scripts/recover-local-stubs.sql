-- The few NovaX things Nova Recover leans on, faked for a throwaway local
-- Postgres (scripts/test-recover-local.sh). Never run this on a real project.
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (id uuid primary key, email text, role text not null default 'client', client_id uuid, status text default 'active');
create table public.clients (id uuid primary key, name text, owner text, phone text, wallet_balance numeric default 0, meta jsonb default '{}');
create table public.parcels (id uuid primary key default gen_random_uuid(), awb text, client_id uuid, consignee text, phone text, city text,
  address text, status text, cod_amount numeric, exception text, meta jsonb default '{}', status_since timestamptz, updated_at timestamptz default now());
create table public.staff_users (id uuid primary key default gen_random_uuid(), client_id uuid, email text, auth_user_id uuid, role text, status text);
create table public.cs_agents (id uuid primary key default gen_random_uuid(), full_name text, auth_user_id uuid unique, status text default 'Active');
create table public.cs_shifts (id bigserial primary key, agent_id uuid, clock_out timestamptz);

create function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
$$;
create function public.my_client_id() returns uuid language sql stable security definer set search_path = '' as $$
  select client_id from public.profiles where id = (select auth.uid())
$$;
create function public.cs_require_admin() returns void language plpgsql stable security definer set search_path = '' as $$
begin if not public.is_admin() then raise exception 'Only NovaX admins can do this.' using errcode = '42501'; end if; end $$;
create function public.cs_require_shift() returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  select s.id into v from public.cs_shifts s join public.cs_agents a on a.id = s.agent_id
   where a.auth_user_id = (select auth.uid()) and a.status = 'Active' and s.clock_out is null;
  if v is null then raise exception 'Clock in to start working.' using errcode = '42501'; end if;
  return v;
end $$;
-- Phase 2 leans on these too.
alter table public.parcels add column fee numeric, add column booked_at timestamptz default now(), add column delivered_at timestamptz;
create table public.riders (id uuid primary key default gen_random_uuid(), name text, cities text[]);
insert into public.riders (name, cities) values ('Khalid', '{lahore}'), ('Naveed', '{islamabad,rawalpindi}'), ('Bilal', '{karachi}');
create table public.nv_parcel_status_log (id bigserial primary key, parcel_id uuid, to_status text, changed_at timestamptz default now());
create table public.operations_issues (id uuid primary key default gen_random_uuid(), branch text, urgency text, problem text, awb text,
  resolved boolean not null default false, meta jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.parcel_admin_audit (id bigserial primary key, awb text, client_id uuid, action text, changes jsonb, actor_id uuid, actor_role text);
create table public.wallet_ledger (id uuid primary key default gen_random_uuid(), client_id uuid, entry_type text
  check (entry_type = any (array['invoice_credit','withdrawal_requested','payout_fee','payout_paid','payout_rejected','admin_adjustment','delivery_charge_due','invoice_due_debit','invoice_due_reversal','due_payment'])),
  amount numeric, affects_balance boolean, status text, reference_type text, reference_id uuid, reference_code text, note text, created_at timestamptz default now());
create function public.cs_current_agent() returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.cs_agents a where a.auth_user_id = (select auth.uid()) and a.status = 'Active'
$$;
-- The live money guard, as it stood on 8 Oct 2026. Phase 2 patches it in place.
create function public.nv_freeze_parcel_money() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if new.fee is distinct from old.fee then
    raise exception 'Delivery fee cannot be changed from the portal. Contact NovaX support if it is wrong.';
  end if;
  if new.cod_amount is distinct from old.cod_amount then
    if coalesce(current_setting('novax.parcel_edit', true), '') <> '1'
       or coalesce(old.status, '') <> 'New booked' then
      raise exception 'COD amount cannot be changed after booking. Contact NovaX support if it is wrong.';
    end if;
  end if;
  if new.client_id is distinct from old.client_id then
    raise exception 'A parcel cannot be moved to another merchant.';
  end if;

  return new;
end $$;
create trigger trg_nv_freeze_parcel_money before update on public.parcels for each row execute function public.nv_freeze_parcel_money();
-- The live booking core's gate and shape, without the rate card.
create function public.nv_book_parcel_core(p_client_id uuid, p_consignee text, p_phone text, p_pickup_city text, p_city text, p_address text,
  p_cod numeric, p_weight text, p_service text, p_category text, p_fragile text, p_payment_mode text, p_order_id text default '',
  p_reference_no text default '', p_source text default 'admin_portal', p_actor_role text default 'admin')
returns public.parcels language plpgsql security definer set search_path = 'public' as $$
declare v_row public.parcels;
begin
  if auth.uid() is not null and not (public.is_admin() or p_client_id = public.my_client_id()) then
    raise exception 'Not authorised to book for this client.' using errcode = '42501';
  end if;
  insert into public.parcels (awb, client_id, consignee, phone, city, address, status, cod_amount, fee, status_since, meta)
  values ('NB' || (select count(*) + 1 from public.parcels), p_client_id, p_consignee, p_phone, p_city, p_address, 'New booked', p_cod, 250, now(),
          jsonb_build_object('source', p_source, 'pickupCity', p_pickup_city, 'weight', p_weight, 'category', p_category, 'paymentMode', p_payment_mode, 'referenceNo', p_reference_no))
  returning * into v_row;
  insert into public.parcel_admin_audit (awb, client_id, action, actor_id, actor_role)
  values (v_row.awb, p_client_id, case when p_actor_role = 'admin' then 'admin_booked' else 'shopify_booked' end, auth.uid(), p_actor_role);
  return v_row;
end $$;
-- Phase 3: the email queue and the merchant's notification choices.
alter table public.clients add column city text;
create table public.nv_email_milestones (event_key text primary key, created_at timestamptz default now());
create table public.nv_email_queue (id uuid primary key default gen_random_uuid(), event_key text unique references public.nv_email_milestones(event_key),
  kind text, recipient text, payload jsonb, state text default 'pending', last_error text,
  constraint nv_email_queue_kind_check check (kind = any (array['welcome'::text, 'first_booking'::text, 'payout_paid'::text])));
create table public.client_notification_prefs (client_id uuid primary key, whatsapp_enabled boolean default true, sms_enabled boolean default false,
  email_enabled boolean default true, events jsonb default '["booked", "delivered", "refused", "returned"]'::jsonb);
create function public.nv_email_owner(p_client uuid) returns text language sql stable security definer set search_path = '' as $$
  select u.email from public.profiles p join auth.users u on u.id = p.id where p.client_id = p_client and p.role = 'client' order by p.id limit 1
$$;
create function public.nv_email_enqueue(p_key text, p_kind text, p_to text, p_payload jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  insert into public.nv_email_milestones(event_key) values (p_key) on conflict do nothing returning event_key into v_key;
  if v_key is null then return; end if;
  insert into public.nv_email_queue(event_key, kind, recipient, payload) values (p_key, p_kind, p_to, p_payload);
end $$;
grant execute on all functions in schema public to anon, authenticated;
create table public.nv_recover_local_test_db ();   -- marks this database as the throwaway one
