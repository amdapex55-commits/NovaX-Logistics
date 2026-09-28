-- Saved pickup addresses (28 Sep 2026).
--
-- A merchant retyped (or pasted) the warehouse address on every pickup
-- request; five merchants already alternate between 2-4 addresses by hand.
-- This stores them once, with a label.
--
-- v1 rule: an address is always in the merchant's own pickup city
-- (clients.meta->>'pickupCity'). Pricing is origin-aware, so an address in
-- another city would silently change fees. The city is set HERE, from the
-- account, never from the request.
--
-- Writes go only through the functions below. The table grants SELECT to
-- authenticated (own rows via RLS) and nothing to anon.

create table if not exists public.pickup_addresses (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  label       text not null check (char_length(btrim(label)) between 1 and 40),
  address     text not null check (char_length(btrim(address)) between 8 and 300),
  city        text not null,
  phone       text check (phone is null or char_length(phone) <= 20),
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists pickup_addresses_one_default
  on public.pickup_addresses (client_id) where is_default and archived_at is null;
create unique index if not exists pickup_addresses_label_unique
  on public.pickup_addresses (client_id, lower(btrim(label))) where archived_at is null;
create index if not exists pickup_addresses_client on public.pickup_addresses (client_id);

-- Supabase pre-grants every new table to anon/authenticated. Revoke first.
revoke all on public.pickup_addresses from public, anon, authenticated;
grant select on public.pickup_addresses to authenticated;
grant all on public.pickup_addresses to service_role;

alter table public.pickup_addresses enable row level security;
drop policy if exists "client read own pickup_addresses" on public.pickup_addresses;
create policy "client read own pickup_addresses" on public.pickup_addresses
  for select to authenticated using (client_id = (select public.my_client_id()));
drop policy if exists "admin read pickup_addresses" on public.pickup_addresses;
create policy "admin read pickup_addresses" on public.pickup_addresses
  for select to authenticated using ((select public.is_admin()));

-- Which saved address a request used. The text copy on the request stays the
-- record: renaming or archiving an address never rewrites history.
alter table public.pickup_requests
  add column if not exists pickup_address_id uuid references public.pickup_addresses(id) on delete set null;

-- The merchant's pickup city, the same default the booking path uses.
create or replace function public.nv_my_pickup_city()
returns text language sql stable security definer set search_path = public as $$
  select initcap(coalesce(nullif(btrim(c.meta->>'pickupCity'),''), 'Karachi'))
    from public.clients c where c.id = public.my_client_id()
$$;

-- Create (p_id null) or edit an address. Returns the saved row.
create or replace function public.nv_pickup_address_save(
  p_id uuid, p_label text, p_address text, p_phone text, p_make_default boolean default false)
returns public.pickup_addresses
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := public.my_client_id();
  v_city   text;
  v_label  text := btrim(coalesce(p_label,''));
  v_addr   text := regexp_replace(btrim(coalesce(p_address,'')), '\s+', ' ', 'g');
  v_phone  text := nullif(regexp_replace(coalesce(p_phone,''), '[^0-9+]', '', 'g'), '');
  v_row    public.pickup_addresses;
  v_count  int;
begin
  if v_client is null then raise exception 'Sign in to a merchant account first.'; end if;
  if char_length(v_label) < 1 or char_length(v_label) > 40 then
    raise exception 'Give the address a short name (up to 40 characters), like "Clifton shop".';
  end if;
  if char_length(v_addr) < 8 then raise exception 'Enter the full pickup address.'; end if;
  if char_length(v_addr) > 300 then raise exception 'That address is too long (300 characters at most).'; end if;
  if v_phone is not null and char_length(v_phone) > 20 then raise exception 'That phone number is too long.'; end if;
  v_city := public.nv_my_pickup_city();

  if exists (select 1 from public.pickup_addresses
              where client_id = v_client and archived_at is null
                and lower(btrim(label)) = lower(v_label)
                and (p_id is null or id <> p_id)) then
    raise exception 'You already have an address called "%".', v_label;
  end if;

  if p_id is null then
    select count(*) into v_count from public.pickup_addresses
     where client_id = v_client and archived_at is null;
    if v_count >= 20 then raise exception 'You can save up to 20 pickup addresses.'; end if;
    insert into public.pickup_addresses (client_id, label, address, city, phone, is_default)
    values (v_client, v_label, v_addr, v_city, v_phone, false)
    returning * into v_row;
    -- The first address is the default without anyone having to say so.
    if v_count = 0 then p_make_default := true; end if;
  else
    update public.pickup_addresses
       set label = v_label, address = v_addr, phone = v_phone, updated_at = now()
     where id = p_id and client_id = v_client and archived_at is null
    returning * into v_row;
    if v_row.id is null then raise exception 'That address no longer exists.'; end if;
  end if;

  if coalesce(p_make_default,false) then
    update public.pickup_addresses set is_default = false, updated_at = now()
     where client_id = v_client and is_default and id <> v_row.id;
    update public.pickup_addresses set is_default = true, updated_at = now()
     where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end $$;

create or replace function public.nv_pickup_address_set_default(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_client uuid := public.my_client_id();
begin
  if v_client is null then raise exception 'Sign in to a merchant account first.'; end if;
  if not exists (select 1 from public.pickup_addresses
                  where id = p_id and client_id = v_client and archived_at is null) then
    raise exception 'That address no longer exists.';
  end if;
  update public.pickup_addresses set is_default = false, updated_at = now()
   where client_id = v_client and is_default and id <> p_id;
  update public.pickup_addresses set is_default = true, updated_at = now() where id = p_id;
  return true;
end $$;

-- Archive, never delete: old pickup requests still point at it.
create or replace function public.nv_pickup_address_archive(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_client uuid := public.my_client_id();
begin
  if v_client is null then raise exception 'Sign in to a merchant account first.'; end if;
  update public.pickup_addresses
     set archived_at = now(), updated_at = now(), is_default = false
   where id = p_id and client_id = v_client and archived_at is null;
  if not found then raise exception 'That address no longer exists.'; end if;
  -- Keep a default whenever any address is left.
  if not exists (select 1 from public.pickup_addresses
                  where client_id = v_client and archived_at is null and is_default) then
    update public.pickup_addresses set is_default = true, updated_at = now()
     where id = (select id from public.pickup_addresses
                  where client_id = v_client and archived_at is null
                  order by created_at limit 1);
  end if;
  return true;
end $$;

-- A pickup request may name a saved address only if it is the caller's own.
create or replace function public.nv_pickup_request_address_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.pickup_address_id is not null and not exists (
       select 1 from public.pickup_addresses a
        where a.id = new.pickup_address_id and a.client_id = new.client_id) then
    raise exception 'That pickup address does not belong to this account.';
  end if;
  return new;
end $$;
drop trigger if exists trg_pickup_request_address_guard on public.pickup_requests;
create trigger trg_pickup_request_address_guard
  before insert or update of pickup_address_id, client_id on public.pickup_requests
  for each row execute function public.nv_pickup_request_address_guard();

revoke all on function public.nv_my_pickup_city() from public, anon;
revoke all on function public.nv_pickup_address_save(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.nv_pickup_address_set_default(uuid) from public, anon;
revoke all on function public.nv_pickup_address_archive(uuid) from public, anon;
revoke all on function public.nv_pickup_request_address_guard() from public, anon, authenticated;
grant execute on function public.nv_my_pickup_city() to authenticated;
grant execute on function public.nv_pickup_address_save(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.nv_pickup_address_set_default(uuid) to authenticated;
grant execute on function public.nv_pickup_address_archive(uuid) to authenticated;
