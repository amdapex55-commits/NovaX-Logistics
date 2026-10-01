-- NovaX sales reps: mandatory joining form + signed joining documents (2 Oct 2026).
-- After a rep links their login, sales.html shows a one-time form (name, phone,
-- CNIC, address, emergency contact), then the offer letter and commission
-- agreement to sign on screen. Every rep RPC refuses until both are done, so
-- the page cannot be skipped by calling the API directly.

begin;

alter table public.sales_reps
  add column if not exists address text check (address is null or char_length(address) between 10 and 300),
  add column if not exists cnic text check (cnic is null or cnic ~ '^[0-9]{13}$'),
  add column if not exists emergency_name text check (emergency_name is null or char_length(emergency_name) between 2 and 80),
  add column if not exists emergency_phone text check (emergency_phone is null or emergency_phone ~ '^03[0-9]{9}$'),
  add column if not exists profile_done_at timestamptz;
create unique index if not exists sales_reps_cnic_key on public.sales_reps(cnic) where cnic is not null;

create table if not exists public.sales_rep_signatures (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references public.sales_reps(id),
  doc_version text not null,
  docs_sha256 text not null check (docs_sha256 ~ '^[0-9a-f]{64}$'),
  signed_name text not null,
  signature_png text not null check (signature_png like 'data:image/png;base64,%' and char_length(signature_png) between 200 and 300000),
  user_agent text,
  ip text,
  signed_at timestamptz not null default now(),
  unique (rep_id, doc_version)
);
alter table public.sales_rep_signatures enable row level security;
revoke all on public.sales_rep_signatures from public, anon, authenticated;

insert into public.sales_settings(key, value) values ('docs_version', '2026-10-02')
on conflict (key) do nothing;

create or replace function public.sales_docs_signed(p_rep uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select s.signed_at from public.sales_rep_signatures s
  where s.rep_id = p_rep and s.doc_version = (select value from public.sales_settings where key = 'docs_version');
$$;

-- Leads, stores, earnings: only for a rep who finished the form and signed.
create or replace function public.sales_require_rep()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.sales_current_rep();
begin
  if v is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  if not exists (select 1 from public.sales_reps r where r.id = v and r.profile_done_at is not null)
     or public.sales_docs_signed(v) is null then
    raise exception 'Finish your joining form and sign your documents first.' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function public.sales_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'rep', (select jsonb_build_object('id', r.id, 'code', r.code, 'full_name', r.full_name, 'status', r.status, 'joined_on', r.joined_on,
              'phone', r.phone, 'cnic', r.cnic, 'address', r.address, 'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone,
              'profile_done', r.profile_done_at is not null, 'signed_at', public.sales_docs_signed(r.id))
            from public.sales_reps r where r.auth_user_id = auth.uid()),
    'docs_version', (select value from public.sales_settings where key = 'docs_version'),
    'rewards', jsonb_build_object('account_opened', public.sales_setting_int('reward_account_opened'),
      'first_pickup', public.sales_setting_int('reward_first_pickup'), 'pickup_hold_days', public.sales_setting_int('pickup_hold_days'),
      'lead_window_days', public.sales_setting_int('lead_window_days'), 'lead_untouched_days', public.sales_setting_int('lead_untouched_days')),
    'email', (select u.email from auth.users u where u.id = auth.uid()));
$$;

-- The joining form. Editable until the documents are signed (they carry the
-- name and CNIC), then locked; NovaX can correct it on request.
create or replace function public.sales_save_profile(p_name text, p_phone text, p_cnic text, p_address text, p_em_name text, p_em_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_current_rep();
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_phone text := public.sales_norm_phone(p_phone);
  v_cnic text := regexp_replace(coalesce(p_cnic, ''), '[^0-9]', '', 'g');
  v_addr text := regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g');
  v_em_name text := regexp_replace(btrim(coalesce(p_em_name, '')), '\s+', ' ', 'g');
  v_em_phone text := public.sales_norm_phone(p_em_phone);
begin
  if v_rep is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  if public.sales_docs_signed(v_rep) is not null then
    raise exception 'Your documents are signed, so these details are locked. Ask NovaX to correct them.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 3 and 80 or v_name !~ '^[A-Za-z][A-Za-z .''-]*$' then
    raise exception 'Enter your full name as on your CNIC, in English letters.' using errcode = '22023'; end if;
  if coalesce(v_phone, '') !~ '^03[0-9]{9}$' then raise exception 'Enter your mobile number like 03001234567.' using errcode = '22023'; end if;
  if v_cnic !~ '^[0-9]{13}$' then raise exception 'Enter your 13-digit CNIC number.' using errcode = '22023'; end if;
  if exists (select 1 from public.sales_reps r where r.cnic = v_cnic and r.id <> v_rep) then
    raise exception 'This CNIC is already registered with another NovaX rep.' using errcode = '23505'; end if;
  if char_length(v_addr) < 10 then raise exception 'Enter your full home address (house, street, area, city).' using errcode = '22023'; end if;
  if char_length(v_addr) > 300 then raise exception 'Keep the address under 300 characters.' using errcode = '22023'; end if;
  if char_length(v_em_name) not between 2 and 80 then raise exception 'Enter your emergency contact''s name.' using errcode = '22023'; end if;
  if coalesce(v_em_phone, '') !~ '^03[0-9]{9}$' then raise exception 'Enter your emergency contact''s mobile like 03001234567.' using errcode = '22023'; end if;
  if v_em_phone = v_phone then raise exception 'The emergency number must be someone else''s, not your own.' using errcode = '22023'; end if;
  update public.sales_reps set full_name = v_name, phone = v_phone, cnic = v_cnic, address = v_addr,
         emergency_name = v_em_name, emergency_phone = v_em_phone, profile_done_at = now()
   where id = v_rep;
  update public.profiles set full_name = v_name where id = auth.uid();
  return public.sales_me();
end $$;

create or replace function public.sales_sign_documents(p_version text, p_sha256 text, p_signed_name text, p_png text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_current_rep();
  v_r public.sales_reps;
  v_hdr jsonb;
begin
  if v_rep is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  select * into v_r from public.sales_reps where id = v_rep;
  if v_r.profile_done_at is null then raise exception 'Fill in your joining form first.' using errcode = '42501'; end if;
  if p_version is distinct from (select value from public.sales_settings where key = 'docs_version') then
    raise exception 'The documents were updated. Refresh the page and read them again.' using errcode = '22023'; end if;
  if lower(regexp_replace(btrim(coalesce(p_signed_name, '')), '\s+', ' ', 'g')) <> lower(v_r.full_name) then
    raise exception 'Type your name exactly as on the form: %', v_r.full_name using errcode = '22023'; end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Could not read the documents. Refresh and try again.' using errcode = '22023'; end if;
  if coalesce(p_png, '') not like 'data:image/png;base64,%' or char_length(p_png) not between 200 and 300000 then
    raise exception 'Draw your signature in the box first.' using errcode = '22023'; end if;
  begin v_hdr := current_setting('request.headers', true)::jsonb; exception when others then v_hdr := null; end;
  insert into public.sales_rep_signatures(rep_id, doc_version, docs_sha256, signed_name, signature_png, user_agent, ip)
  values (v_rep, p_version, p_sha256, v_r.full_name, p_png, left(v_hdr->>'user-agent', 300),
          left(coalesce(v_hdr->>'cf-connecting-ip', split_part(v_hdr->>'x-forwarded-for', ',', 1)), 64))
  on conflict (rep_id, doc_version) do nothing;
  return public.sales_me();
end $$;

-- The rep's own signed copy (for re-printing later).
create or replace function public.sales_my_documents()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('signature_png', s.signature_png, 'signed_name', s.signed_name, 'signed_at', s.signed_at,
                            'doc_version', s.doc_version, 'docs_sha256', s.docs_sha256)
  from public.sales_rep_signatures s
  where s.rep_id = public.sales_current_rep()
  order by s.signed_at desc limit 1;
$$;

create or replace function public.sales_admin_rep_files()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_object_agg(r.id, jsonb_build_object('profile_done', r.profile_done_at is not null,
            'signed_at', public.sales_docs_signed(r.id))), '{}'::jsonb) from public.sales_reps r);
end $$;

create or replace function public.sales_admin_rep_file(p_rep uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select jsonb_build_object(
      'rep', jsonb_build_object('id', r.id, 'code', r.code, 'full_name', r.full_name, 'email', r.email, 'status', r.status,
        'joined_on', r.joined_on, 'phone', r.phone, 'cnic', r.cnic, 'address', r.address,
        'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone, 'profile_done', r.profile_done_at is not null),
      'signature', (select jsonb_build_object('signature_png', s.signature_png, 'signed_name', s.signed_name, 'signed_at', s.signed_at,
                      'doc_version', s.doc_version, 'docs_sha256', s.docs_sha256, 'ip', s.ip, 'user_agent', s.user_agent)
                    from public.sales_rep_signatures s where s.rep_id = r.id order by s.signed_at desc limit 1))
    from public.sales_reps r where r.id = p_rep);
end $$;

do $$
declare f text;
begin
  foreach f in array array['sales_docs_signed(uuid)', 'sales_save_profile(text,text,text,text,text,text)',
    'sales_sign_documents(text,text,text,text)', 'sales_my_documents()', 'sales_admin_rep_files()', 'sales_admin_rep_file(uuid)',
    'sales_require_rep()', 'sales_me()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['sales_save_profile(text,text,text,text,text,text)', 'sales_sign_documents(text,text,text,text)',
    'sales_my_documents()', 'sales_admin_rep_files()', 'sales_admin_rep_file(uuid)', 'sales_me()']
  loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
