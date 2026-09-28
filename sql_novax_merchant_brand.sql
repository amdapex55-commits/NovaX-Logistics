-- Branded tracking page (28 Sep 2026).
--
-- A merchant can put their shop name, logo, colour and (optionally) a
-- WhatsApp number on the tracking page their buyers open from the link we
-- send. Owner seat only.
--
-- Privacy: the brand is returned ONLY for the unguessable tracking token
-- (public_track_brand). The ?awb= lookup stays anonymous -- AWBs are
-- sequential, so branding that path would let anyone enumerate which shops
-- ship with NovaX.

create table if not exists public.merchant_brand (
  client_id        uuid primary key references public.clients(id) on delete cascade,
  display_name     text not null check (char_length(btrim(display_name)) between 2 and 40),
  logo_path        text,
  accent_hex       text check (accent_hex is null or accent_hex ~ '^#[0-9a-f]{6}$'),
  support_whatsapp text check (support_whatsapp is null or support_whatsapp ~ '^92[0-9]{10}$'),
  enabled          boolean not null default false,
  updated_at       timestamptz not null default now()
);

revoke all on public.merchant_brand from public, anon, authenticated;
grant select on public.merchant_brand to authenticated;
grant all on public.merchant_brand to service_role;
alter table public.merchant_brand enable row level security;
drop policy if exists "client read own merchant_brand" on public.merchant_brand;
create policy "client read own merchant_brand" on public.merchant_brand
  for select to authenticated using (client_id = (select public.my_client_id()));
drop policy if exists "admin read merchant_brand" on public.merchant_brand;
create policy "admin read merchant_brand" on public.merchant_brand
  for select to authenticated using ((select public.is_admin()));

-- Logos: one public file per merchant at <client_id>/logo, overwritten on
-- upload -- storage has no cascade, so a new name per upload would leave
-- orphans behind. PNG/JPEG/WebP only: SVG can carry script.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('merchant-logos', 'merchant-logos', true, 204800, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 204800,
      allowed_mime_types = array['image/png','image/jpeg','image/webp'];

drop policy if exists merchant_logos_owner_select on storage.objects;
drop policy if exists merchant_logos_owner_insert on storage.objects;
drop policy if exists merchant_logos_owner_update on storage.objects;
drop policy if exists merchant_logos_owner_delete on storage.objects;
create policy merchant_logos_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'merchant-logos' and name = public.my_client_id()::text || '/logo');
create policy merchant_logos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'merchant-logos' and name = public.my_client_id()::text || '/logo'
              and public.is_client_owner_seat());
create policy merchant_logos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'merchant-logos' and name = public.my_client_id()::text || '/logo'
         and public.is_client_owner_seat())
  with check (bucket_id = 'merchant-logos' and name = public.my_client_id()::text || '/logo'
              and public.is_client_owner_seat());
create policy merchant_logos_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'merchant-logos' and name = public.my_client_id()::text || '/logo'
         and public.is_client_owner_seat());

-- Save the brand. Validates everything; the caller cannot choose the row.
create or replace function public.nv_brand_save(
  p_display_name text, p_accent text, p_whatsapp text, p_enabled boolean, p_has_logo boolean)
returns public.merchant_brand
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := public.my_client_id();
  v_name   text := regexp_replace(btrim(coalesce(p_display_name,'')), '\s+', ' ', 'g');
  v_accent text := lower(nullif(btrim(coalesce(p_accent,'')),''));
  v_wa     text := regexp_replace(coalesce(p_whatsapp,''), '[^0-9]', '', 'g');
  v_row    public.merchant_brand;
begin
  if v_client is null then raise exception 'Sign in to a merchant account first.'; end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can change the tracking page.';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'Shop name must be 2 to 40 characters.';
  end if;
  if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then
    raise exception 'Pick a colour from the colour picker.';
  end if;
  if v_wa = '' then v_wa := null;
  elsif v_wa ~ '^03[0-9]{9}$' then v_wa := '92' || substr(v_wa, 2);
  elsif v_wa ~ '^3[0-9]{9}$' then v_wa := '92' || v_wa;
  elsif v_wa ~ '^0092[0-9]{10}$' then v_wa := substr(v_wa, 3);
  end if;
  if v_wa is not null and v_wa !~ '^923[0-9]{9}$' then
    raise exception 'Enter a Pakistani mobile number for WhatsApp, like 0300 1234567.';
  end if;

  insert into public.merchant_brand (client_id, display_name, logo_path, accent_hex, support_whatsapp, enabled, updated_at)
  values (v_client, v_name,
          case when coalesce(p_has_logo,false) then v_client::text || '/logo' end,
          v_accent, v_wa, coalesce(p_enabled,false), now())
  on conflict (client_id) do update
    set display_name = excluded.display_name, logo_path = excluded.logo_path,
        accent_hex = excluded.accent_hex, support_whatsapp = excluded.support_whatsapp,
        enabled = excluded.enabled, updated_at = now()
  returning * into v_row;
  return v_row;
end $$;

-- The brand for a tracking link. Same token rule as public_track_parcel.
create or replace function public.public_track_brand(p_token text)
returns table(display_name text, logo_url text, accent_hex text, support_whatsapp text)
language sql stable security definer set search_path = public as $$
  select b.display_name,
         case when b.logo_path is not null then
           'https://rhzunbzbdzicajqtohwp.supabase.co/storage/v1/object/public/merchant-logos/'
             || b.logo_path || '?v=' || extract(epoch from b.updated_at)::bigint end,
         b.accent_hex,
         b.support_whatsapp
    from public.parcels p
    join public.merchant_brand b on b.client_id = p.client_id and b.enabled
   where p.tracking_token is not null
     and length(btrim(coalesce(p_token, ''))) >= 20
     and p.tracking_token = btrim(coalesce(p_token, ''))
   limit 1
$$;

revoke all on function public.nv_brand_save(text, text, text, boolean, boolean) from public, anon;
grant execute on function public.nv_brand_save(text, text, text, boolean, boolean) to authenticated;
revoke all on function public.public_track_brand(text) from public;
grant execute on function public.public_track_brand(text) to anon, authenticated;
