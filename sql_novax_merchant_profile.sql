-- Merchant profile (29 Sep 2026).
--
-- One screen for everything a merchant can say about their business:
-- name, logo, colour, phone, WhatsApp, email, website, type, address, and
-- whether their brand shows on the tracking link.
--
-- Decisions (Aisha, 29 Sep):
--   * ONE name. clients.name is the only business name: labels, invoices,
--     portal, emails, Shopify, admin AND the tracking page all read it.
--     merchant_brand.display_name is kept in step but nothing reads it now.
--   * The logo shows only in the merchant's own portal and on the tracking
--     link -- never on labels or invoices.
--   * Changes apply instantly; every change is logged and admin sees them.
--   * Pickup city is admin-only (it changes pricing) -- not editable here.
--
-- Owner seat only, enforced here. Staff seats can read, not save.

-- ---------------------------------------------------------------- history
create table if not exists public.client_profile_changes (
  id          bigserial primary key,
  client_id   uuid not null references public.clients(id) on delete cascade,
  changed_by  uuid,
  field       text not null,
  old_value   text,
  new_value   text,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz,
  seen_by     uuid
);
create index if not exists client_profile_changes_client on public.client_profile_changes (client_id, created_at desc);
create index if not exists client_profile_changes_unseen on public.client_profile_changes (created_at desc) where seen_at is null;

revoke all on public.client_profile_changes from public, anon, authenticated;
grant select on public.client_profile_changes to authenticated;
grant all on public.client_profile_changes to service_role;
alter table public.client_profile_changes enable row level security;
drop policy if exists "client read own profile changes" on public.client_profile_changes;
create policy "client read own profile changes" on public.client_profile_changes
  for select to authenticated using (client_id = (select public.my_client_id()));
drop policy if exists "admin read profile changes" on public.client_profile_changes;
create policy "admin read profile changes" on public.client_profile_changes
  for select to authenticated using ((select public.is_admin()));

-- The tracking-page name is now clients.name, which can be up to 80.
alter table public.merchant_brand drop constraint if exists merchant_brand_display_name_check;
alter table public.merchant_brand add constraint merchant_brand_display_name_check
  check (char_length(btrim(display_name)) between 2 and 80);

-- ------------------------------------------------------------------- read
create or replace function public.nv_profile_get()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'client_id',     c.id,
    'name',          c.name,
    'phone',         c.phone,
    'email',         coalesce(nullif(c.meta->>'contactEmail',''), c.meta->>'email'),
    'website',       c.website,
    'business_type', c.business_type,
    'address',       c.address,
    'pickup_city',   initcap(coalesce(nullif(btrim(c.meta->>'pickupCity'),''), 'Karachi')),
    'member_since',  c.created_at,
    'is_owner',      public.is_client_owner_seat(),
    'logo_url',      case when b.logo_path is not null then
                       'https://rhzunbzbdzicajqtohwp.supabase.co/storage/v1/object/public/merchant-logos/'
                       || b.logo_path || '?v=' || extract(epoch from b.updated_at)::bigint end,
    'accent',        b.accent_hex,
    'whatsapp',      case when b.support_whatsapp is not null then '0' || substr(b.support_whatsapp, 3) end,
    'tracking_on',   coalesce(b.enabled, false)
  )
  from public.clients c
  left join public.merchant_brand b on b.client_id = c.id
  where c.id = public.my_client_id()
$$;

-- ------------------------------------------------------------------- save
-- p: { name, phone, email, website, business_type, address, accent,
--      whatsapp, tracking_on, has_logo }. Every key is required, so a
-- partial or stale form can never blank a field by omission.
create or replace function public.nv_profile_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := public.my_client_id();
  v_uid    uuid := auth.uid();
  c        public.clients;
  b        public.merchant_brand;
  v_name   text := regexp_replace(btrim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_phone  text := regexp_replace(coalesce(p->>'phone',''), '[^0-9]', '', 'g');
  v_email  text := lower(btrim(coalesce(p->>'email','')));
  v_web    text := btrim(coalesce(p->>'website',''));
  v_type   text := regexp_replace(btrim(coalesce(p->>'business_type','')), '\s+', ' ', 'g');
  v_addr   text := regexp_replace(btrim(coalesce(p->>'address','')), '\s+', ' ', 'g');
  v_accent text := lower(nullif(btrim(coalesce(p->>'accent','')),''));
  v_wa     text := regexp_replace(coalesce(p->>'whatsapp',''), '[^0-9]', '', 'g');
  v_on     boolean := coalesce((p->>'tracking_on')::boolean, false);
  v_logo   boolean := coalesce((p->>'has_logo')::boolean, false);
  k        text;
begin
  if v_client is null then raise exception 'Sign in to a merchant account first.'; end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can change the business profile.';
  end if;
  foreach k in array array['name','phone','email','website','business_type','address','accent','whatsapp','tracking_on','has_logo'] loop
    if not (p ? k) then raise exception 'The form was incomplete (%). Refresh and try again.', k; end if;
  end loop;

  select * into c from public.clients where id = v_client for update;
  select * into b from public.merchant_brand where client_id = v_client for update;

  -- name
  if char_length(v_name) < 2 then raise exception 'Enter your business name.'; end if;
  if char_length(v_name) > 80 then raise exception 'Business name can be 80 characters at most.'; end if;
  -- only a NEW name is checked, so an account already called "Novax ..." can still save its profile
  if v_name ~* 'nova\s*x' and v_name is distinct from c.name then raise exception 'Your business name cannot include "NovaX".'; end if;
  if v_name ~ '[<>{}\\]' then raise exception 'Business name cannot contain < > { } or \.'; end if;
  -- phone (required, Pakistani mobile or landline)
  if v_phone ~ '^92' and char_length(v_phone) = 12 then v_phone := '0' || substr(v_phone, 3); end if;
  if v_phone ~ '^3[0-9]{9}$' then v_phone := '0' || v_phone; end if;
  if v_phone !~ '^0[0-9]{9,10}$' then raise exception 'Enter a Pakistani phone number, like 0300 1234567.'; end if;
  -- email (optional)
  if v_email = '' then v_email := null;
  elsif v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or char_length(v_email) > 120 then
    raise exception 'That email address does not look right.';
  end if;
  -- website (optional)
  if v_web = '' then v_web := null;
  else
    if v_web !~* '^https?://' then v_web := 'https://' || v_web; end if;
    if v_web !~* '^https?://[a-z0-9-]+(\.[a-z0-9-]+)+(/[^\s<>"]*)?$' or char_length(v_web) > 200 then
      raise exception 'That website address does not look right.';
    end if;
  end if;
  if char_length(v_type) > 60 then raise exception 'Keep "what you sell" under 60 characters.'; end if;
  if v_type = '' then v_type := null; end if;
  if v_addr = '' then v_addr := null;
  elsif char_length(v_addr) < 8 then raise exception 'Enter the full business address.';
  elsif char_length(v_addr) > 300 then raise exception 'That address is too long (300 characters at most).';
  end if;
  if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then raise exception 'Pick a colour from the colour picker.'; end if;
  if v_wa = '' then v_wa := null;
  elsif v_wa ~ '^03[0-9]{9}$' then v_wa := '92' || substr(v_wa, 2);
  elsif v_wa ~ '^3[0-9]{9}$' then v_wa := '92' || v_wa;
  elsif v_wa ~ '^0092[0-9]{10}$' then v_wa := substr(v_wa, 3);
  end if;
  if v_wa is not null and v_wa !~ '^923[0-9]{9}$' then
    raise exception 'Enter a Pakistani mobile number for WhatsApp, like 0300 1234567.';
  end if;

  -- history: one row per field that actually changed
  insert into public.client_profile_changes (client_id, changed_by, field, old_value, new_value)
  select v_client, v_uid, f, o, n from (values
    ('Business name', c.name, v_name),
    ('Phone', c.phone, v_phone),
    ('Email', coalesce(nullif(c.meta->>'contactEmail',''), c.meta->>'email'), v_email),
    ('Website', c.website, v_web),
    ('What you sell', c.business_type, v_type),
    ('Business address', c.address, v_addr),
    ('Brand colour', b.accent_hex, v_accent),
    ('WhatsApp for customers', b.support_whatsapp, v_wa),
    ('Brand on tracking link', case when coalesce(b.enabled,false) then 'On' else 'Off' end, case when v_on then 'On' else 'Off' end),
    ('Logo', case when b.logo_path is not null then 'Set' else 'None' end, case when v_logo then 'Set' else 'None' end)
  ) x(f, o, n)
  where o is distinct from n
    -- a re-uploaded logo keeps the same path; log it as a change too
    or (f = 'Logo' and v_logo and coalesce((p->>'logo_replaced')::boolean, false));

  update public.clients
     set name = v_name, phone = v_phone, website = v_web, business_type = v_type, address = v_addr,
         meta = case when v_email is null then coalesce(meta,'{}'::jsonb) - 'contactEmail'
                     else jsonb_set(coalesce(meta,'{}'::jsonb), '{contactEmail}', to_jsonb(v_email), true) end
   where id = v_client;

  insert into public.merchant_brand (client_id, display_name, logo_path, accent_hex, support_whatsapp, enabled, updated_at)
  values (v_client, v_name, case when v_logo then v_client::text || '/logo' end, v_accent, v_wa, v_on, now())
  on conflict (client_id) do update
    set display_name = excluded.display_name, logo_path = excluded.logo_path,
        accent_hex = excluded.accent_hex, support_whatsapp = excluded.support_whatsapp,
        enabled = excluded.enabled, updated_at = now();

  return public.nv_profile_get();
end $$;

-- The old one-field save stays for anything still calling it, but it now
-- follows the same rules: owner only, same name checks, same history.
create or replace function public.client_set_business_name(p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := public.my_client_id();
  v_new    text := regexp_replace(btrim(coalesce(p_name,'')), '\s+', ' ', 'g');
  v_old    text;
begin
  if v_client is null then raise exception 'No client account linked to this session.'; end if;
  if not public.is_client_owner_seat() then raise exception 'Only the account owner can change the business name.'; end if;
  if char_length(v_new) < 2 then raise exception 'Business name is too short.'; end if;
  if char_length(v_new) > 80 then raise exception 'Business name cannot be longer than 80 characters.'; end if;
  select name into v_old from public.clients where id = v_client;
  if v_new ~* 'nova\s*x' and v_new is distinct from v_old then raise exception 'Your business name cannot include "NovaX".'; end if;
  if v_old is not distinct from v_new then return v_new; end if;
  update public.clients set name = v_new where id = v_client;
  update public.merchant_brand set display_name = v_new, updated_at = now() where client_id = v_client;
  insert into public.client_profile_changes (client_id, changed_by, field, old_value, new_value)
  values (v_client, auth.uid(), 'Business name', v_old, v_new);
  return v_new;
end $$;

-- ONE name: the tracking link shows clients.name, not a second copy.
create or replace function public.public_track_brand(p_token text)
returns table(display_name text, logo_url text, accent_hex text, support_whatsapp text)
language sql stable security definer set search_path = public as $$
  select c.name,
         case when b.logo_path is not null then
           'https://rhzunbzbdzicajqtohwp.supabase.co/storage/v1/object/public/merchant-logos/'
             || b.logo_path || '?v=' || extract(epoch from b.updated_at)::bigint end,
         b.accent_hex,
         b.support_whatsapp
    from public.parcels p
    join public.merchant_brand b on b.client_id = p.client_id and b.enabled
    join public.clients c on c.id = p.client_id
   where p.tracking_token is not null
     and length(btrim(coalesce(p_token, ''))) >= 20
     and p.tracking_token = btrim(coalesce(p_token, ''))
   limit 1
$$;

-- ------------------------------------------------------------------ admin
create or replace function public.admin_profile_changes(p_limit int default 200)
returns table(id bigint, client_id uuid, client_name text, field text, old_value text, new_value text,
              created_at timestamptz, seen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query
    select h.id, h.client_id, c.name, h.field, h.old_value, h.new_value, h.created_at, h.seen_at
      from public.client_profile_changes h join public.clients c on c.id = h.client_id
     order by h.created_at desc limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;

create or replace function public.admin_profile_changes_seen(p_ids bigint[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.client_profile_changes set seen_at = now(), seen_by = auth.uid()
   where seen_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.nv_profile_get() from public, anon;
revoke all on function public.nv_profile_save(jsonb) from public, anon;
revoke all on function public.client_set_business_name(text) from public, anon;
revoke all on function public.admin_profile_changes(int) from public, anon;
revoke all on function public.admin_profile_changes_seen(bigint[]) from public, anon;
revoke all on function public.public_track_brand(text) from public;
grant execute on function public.nv_profile_get() to authenticated;
grant execute on function public.nv_profile_save(jsonb) to authenticated;
grant execute on function public.client_set_business_name(text) to authenticated;
grant execute on function public.admin_profile_changes(int) to authenticated;
grant execute on function public.admin_profile_changes_seen(bigint[]) to authenticated;
grant execute on function public.public_track_brand(text) to anon, authenticated;
