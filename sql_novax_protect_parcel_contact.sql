-- =====================================================================
-- NovaX: make it structurally impossible to erase a parcel address.
-- Run in Supabase SQL Editor. Safe on live traffic. Run tab by tab if
-- the dashboard mangles it (it has done before -- hence $fn$ quoting).
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. A blank UPDATE can never clear a stored contact field again.
--    This binds ANY writer: the portal, a script, psql, future code.
-- ---------------------------------------------------------------
create or replace function public.nv_protect_parcel_contact()
returns trigger
language plpgsql
as $fn$
begin
  if coalesce(btrim(new.address), '') = '' and coalesce(btrim(old.address), '') <> '' then
    new.address := old.address;
  end if;
  if coalesce(btrim(new.phone), '') = '' and coalesce(btrim(old.phone), '') <> '' then
    new.phone := old.phone;
  end if;
  if coalesce(btrim(new.consignee), '') = '' and coalesce(btrim(old.consignee), '') <> '' then
    new.consignee := old.consignee;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_nv_protect_parcel_contact on public.parcels;
create trigger trg_nv_protect_parcel_contact
  before update on public.parcels
  for each row execute function public.nv_protect_parcel_contact();

-- ---------------------------------------------------------------
-- 2. Every real change to a contact field is recorded with its OLD
--    value. If anything ever alters an address again, the previous
--    value is recoverable from here -- no backup restore needed.
-- ---------------------------------------------------------------
create table if not exists public.parcel_contact_history (
  id           bigserial primary key,
  awb          text        not null,
  changed_at   timestamptz not null default now(),
  changed_by   uuid,
  old_address  text,
  new_address  text,
  old_phone    text,
  new_phone    text
);

create index if not exists idx_pch_awb on public.parcel_contact_history(awb);
create index if not exists idx_pch_at  on public.parcel_contact_history(changed_at desc);

alter table public.parcel_contact_history enable row level security;

drop policy if exists pch_admin_read on public.parcel_contact_history;
create policy pch_admin_read on public.parcel_contact_history
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','staff')
  ));

create or replace function public.nv_log_parcel_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(old.address,'') is distinct from coalesce(new.address,'')
     or coalesce(old.phone,'') is distinct from coalesce(new.phone,'') then
    insert into public.parcel_contact_history
      (awb, changed_by, old_address, new_address, old_phone, new_phone)
    values (new.awb, auth.uid(), old.address, new.address, old.phone, new.phone);
  end if;
  return null;
end
$fn$;

drop trigger if exists trg_nv_log_parcel_contact on public.parcels;
create trigger trg_nv_log_parcel_contact
  after update on public.parcels
  for each row execute function public.nv_log_parcel_contact();

-- ---------------------------------------------------------------
-- 3. Same guard for clients. The admin portal full-row UPDATEs the
--    clients table too, so a blank in browser memory could erase a
--    merchant's phone/address, or reset a negotiated rate/rate_card.
-- ---------------------------------------------------------------
create or replace function public.nv_protect_client_contact()
returns trigger
language plpgsql
as $fn$
begin
  if coalesce(btrim(new.phone), '') = '' and coalesce(btrim(old.phone), '') <> '' then
    new.phone := old.phone;
  end if;
  if coalesce(btrim(new.address), '') = '' and coalesce(btrim(old.address), '') <> '' then
    new.address := old.address;
  end if;
  if coalesce(new.rate, 0) = 0 and coalesce(old.rate, 0) <> 0 then
    new.rate := old.rate;
  end if;
  if new.rate_card is null and old.rate_card is not null then
    new.rate_card := old.rate_card;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_nv_protect_client_contact on public.clients;
create trigger trg_nv_protect_client_contact
  before update on public.clients
  for each row execute function public.nv_protect_client_contact();
