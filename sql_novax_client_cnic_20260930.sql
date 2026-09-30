-- ═══ CNIC on signup (30 Sep 2026) ══════════════════════════════════════════
-- Merchants add a photo of the front and the back of the account owner's CNIC
-- at signup, or later from Profile, and NovaX checks them in admin. Signup
-- itself is unchanged: the workspace never waits for this, and a photo that
-- fails to upload cannot fail a signup (the portal asks again).
--
-- Where things live
--   storage bucket client-kyc (private)  <client_id>/cnic-front-<ms>.jpg and cnic-back-<ms>.jpg
--   public.client_kyc                    one row per merchant: current photos + status
--   public.client_kyc_events             every submit and review, kept for the record
--
-- Who can do what (enforced here, not in the page)
--   upload  : the account Owner, own folder only, until Verified; admins, any client
--   view    : the Owner (own folder) and admins. Other seats and riders get nothing
--   replace : a new photo is a new file; nobody overwrites or deletes from the portal
--   delete  : admins only (used when a client is deleted)
--
-- Not built yet, on purpose (decisions 1-4 in the vault plan): holding
-- withdrawals until verified, the 13-digit number, bank-name matching, and a
-- retention period after an account closes.

-- ---- bucket ----------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-kyc', 'client-kyc', false, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---- tables ----------------------------------------------------------------
create table if not exists public.client_kyc (
  client_id         uuid primary key references public.clients(id) on delete cascade,
  status            text not null default 'submitted' check (status in ('submitted','verified','rejected')),
  front_path        text not null,
  back_path         text not null,
  reject_reason     text,
  name_on_card      text,
  submitted_by      uuid,
  submitted_at      timestamptz not null default now(),
  reviewed_by       uuid,
  reviewed_by_email text,
  reviewed_at       timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists client_kyc_status_idx on public.client_kyc (status, submitted_at);
alter table public.client_kyc enable row level security;
revoke all on public.client_kyc from public, anon, authenticated;

create table if not exists public.client_kyc_events (
  id          bigserial primary key,
  client_id   uuid not null references public.clients(id) on delete cascade,
  event       text not null check (event in ('submitted','verified','rejected','admin_attached')),
  detail      jsonb not null default '{}'::jsonb,
  actor       uuid,
  actor_email text,
  at          timestamptz not null default now()
);
create index if not exists client_kyc_events_client_idx on public.client_kyc_events (client_id, at desc);
alter table public.client_kyc_events enable row level security;
revoke all on public.client_kyc_events from public, anon, authenticated;
revoke all on sequence public.client_kyc_events_id_seq from public, anon, authenticated;

-- ---- who may upload right now ----------------------------------------------
-- Owner seat, a CNIC that is not yet Verified, and a cap on files per client
-- so one account cannot fill the free storage.
create or replace function public.nv_kyc_upload_open()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select s.c is not null
     and public.is_client_owner_seat()
     and not exists (select 1 from public.client_kyc k where k.client_id = s.c and k.status = 'verified')
     and (select count(*) from storage.objects o
           where o.bucket_id = 'client-kyc' and o.name like s.c::text || '/%') < 40
  from (select public.my_client_id() as c) s;
$$;
revoke all on function public.nv_kyc_upload_open() from public, anon;
grant execute on function public.nv_kyc_upload_open() to authenticated;

-- ---- storage policies (only ever match this bucket) ------------------------
drop policy if exists client_kyc_insert on storage.objects;
create policy client_kyc_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'client-kyc'
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cnic-(front|back)-[0-9]{10,16}\.jpg$'
  and ( public.is_admin()
        or (split_part(name, '/', 1) = public.my_client_id()::text and public.nv_kyc_upload_open()) )
);
drop policy if exists client_kyc_select on storage.objects;
create policy client_kyc_select on storage.objects for select to authenticated
using (
  bucket_id = 'client-kyc'
  and ( public.is_admin()
        or (split_part(name, '/', 1) = public.my_client_id()::text and public.is_client_owner_seat()) )
);
drop policy if exists client_kyc_admin_delete on storage.objects;
create policy client_kyc_admin_delete on storage.objects for delete to authenticated
using (bucket_id = 'client-kyc' and public.is_admin());

-- ---- merchant side ---------------------------------------------------------
create or replace function public.client_kyc_status()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); v_owner boolean; k public.client_kyc;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.' using errcode = '42501';
  end if;
  v_owner := public.is_client_owner_seat();
  select * into k from public.client_kyc where client_id = v_client;
  if not found then
    return jsonb_build_object('status', 'missing', 'is_owner', v_owner, 'can_upload', v_owner);
  end if;
  return jsonb_build_object(
    'status',       k.status,
    'is_owner',     v_owner,
    'can_upload',   v_owner and k.status <> 'verified',
    'reason',       case when k.status = 'rejected' then k.reject_reason end,
    'submitted_at', k.submitted_at,
    'reviewed_at',  k.reviewed_at,
    'front_path',   case when v_owner then k.front_path end,
    'back_path',    case when v_owner then k.back_path end);
end $$;

create or replace function public.client_kyc_submit(p_front text, p_back text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); v_status text;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.' using errcode = '42501';
  end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can add the CNIC.' using errcode = '42501';
  end if;
  if coalesce(p_front, '') !~ ('^' || v_client::text || '/cnic-front-[0-9]{10,16}\.jpg$')
     or coalesce(p_back, '') !~ ('^' || v_client::text || '/cnic-back-[0-9]{10,16}\.jpg$') then
    raise exception 'Add a photo of the front and the back of the CNIC.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'client-kyc' and name = p_front)
     or not exists (select 1 from storage.objects where bucket_id = 'client-kyc' and name = p_back) then
    raise exception 'The CNIC photos did not finish uploading. Please add them again.';
  end if;
  perform pg_advisory_xact_lock(hashtext('client_kyc:' || v_client::text));
  select status into v_status from public.client_kyc where client_id = v_client;
  if v_status = 'verified' then
    raise exception 'Your CNIC is already verified. Contact NovaX to change it.';
  end if;
  insert into public.client_kyc (client_id, status, front_path, back_path, submitted_by, submitted_at, updated_at)
  values (v_client, 'submitted', p_front, p_back, auth.uid(), now(), now())
  on conflict (client_id) do update
    set status = 'submitted', front_path = excluded.front_path, back_path = excluded.back_path,
        reject_reason = null, submitted_by = excluded.submitted_by, submitted_at = now(),
        reviewed_by = null, reviewed_by_email = null, reviewed_at = null, updated_at = now();
  insert into public.client_kyc_events (client_id, event, detail, actor)
  values (v_client, 'submitted', jsonb_build_object('front', p_front, 'back', p_back), auth.uid());
  return jsonb_build_object('status', 'submitted', 'is_owner', true, 'can_upload', true,
                            'submitted_at', now(), 'front_path', p_front, 'back_path', p_back);
end $$;

-- ---- admin side ------------------------------------------------------------
create or replace function public.admin_kyc_list()
returns table(client_id uuid, status text, front_path text, back_path text, reject_reason text,
              name_on_card text, submitted_at timestamptz, reviewed_at timestamptz, reviewed_by_email text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return query
    select k.client_id, k.status, k.front_path, k.back_path, k.reject_reason, k.name_on_card,
           k.submitted_at, k.reviewed_at, k.reviewed_by_email
      from public.client_kyc k
     order by k.submitted_at;
end $$;

create or replace function public.admin_kyc_events(p_client uuid)
returns table(event text, detail jsonb, actor_email text, at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return query
    select e.event, e.detail, coalesce(e.actor_email, u.email), e.at
      from public.client_kyc_events e
      left join auth.users u on u.id = e.actor
     where e.client_id = p_client
     order by e.at desc
     limit 30;
end $$;

-- Photos a merchant sent another way (WhatsApp, email): admin uploads them.
create or replace function public.admin_kyc_attach(p_client uuid, p_front text, p_back text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_email text;
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if not exists (select 1 from public.clients where id = p_client) then
    raise exception 'That client no longer exists.';
  end if;
  if coalesce(p_front, '') !~ ('^' || p_client::text || '/cnic-front-[0-9]{10,16}\.jpg$')
     or coalesce(p_back, '') !~ ('^' || p_client::text || '/cnic-back-[0-9]{10,16}\.jpg$') then
    raise exception 'Add a photo of the front and the back of the CNIC.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'client-kyc' and name = p_front)
     or not exists (select 1 from storage.objects where bucket_id = 'client-kyc' and name = p_back) then
    raise exception 'The CNIC photos did not finish uploading. Please add them again.';
  end if;
  perform pg_advisory_xact_lock(hashtext('client_kyc:' || p_client::text));
  select email into v_email from auth.users where id = auth.uid();
  insert into public.client_kyc (client_id, status, front_path, back_path, submitted_by, submitted_at, updated_at)
  values (p_client, 'submitted', p_front, p_back, auth.uid(), now(), now())
  on conflict (client_id) do update
    set status = 'submitted', front_path = excluded.front_path, back_path = excluded.back_path,
        reject_reason = null, submitted_by = excluded.submitted_by, submitted_at = now(),
        reviewed_by = null, reviewed_by_email = null, reviewed_at = null, updated_at = now();
  insert into public.client_kyc_events (client_id, event, detail, actor, actor_email)
  values (p_client, 'admin_attached', jsonb_build_object('front', p_front, 'back', p_back), auth.uid(), v_email);
  insert into public.admin_audit_log (actor_auth_id, actor_email, action, target_client_id, allowed, detail)
  values (auth.uid(), v_email, 'cnic_attached', p_client, true, 'Admin uploaded CNIC photos');
  return jsonb_build_object('ok', true, 'status', 'submitted');
end $$;

create or replace function public.admin_kyc_review(p_client uuid, p_decision text, p_reason text default null, p_name text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  k public.client_kyc; v_email text; v_to text; v_business text;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_name   text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), '');
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('verified', 'rejected') then
    raise exception 'Choose Verify or Ask for a new photo.';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'Say what is wrong with the photo, so the merchant knows what to fix.';
  end if;
  if length(coalesce(v_reason, '')) > 200 then raise exception 'Keep the reason under 200 characters.'; end if;
  if length(coalesce(v_name, '')) > 80 then raise exception 'The name is too long (80 characters at most).'; end if;
  perform pg_advisory_xact_lock(hashtext('client_kyc:' || p_client::text));
  select * into k from public.client_kyc where client_id = p_client;
  if not found then raise exception 'This client has not added a CNIC yet.'; end if;
  -- Pressing Verify twice changes nothing and sends no second email.
  if k.status = p_decision and (p_decision = 'verified' or k.reject_reason is not distinct from v_reason) then
    return jsonb_build_object('ok', true, 'status', k.status, 'unchanged', true);
  end if;
  select email into v_email from auth.users where id = auth.uid();
  update public.client_kyc
     set status = p_decision,
         reject_reason = case when p_decision = 'rejected' then v_reason end,
         name_on_card = case when p_decision = 'verified' then coalesce(v_name, name_on_card) else name_on_card end,
         reviewed_by = auth.uid(), reviewed_by_email = v_email, reviewed_at = now(), updated_at = now()
   where client_id = p_client;
  insert into public.client_kyc_events (client_id, event, detail, actor, actor_email)
  values (p_client, p_decision,
          jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'name', v_name, 'was', k.status)),
          auth.uid(), v_email);
  insert into public.admin_audit_log (actor_auth_id, actor_email, action, target_client_id, allowed, detail)
  values (auth.uid(), v_email, 'cnic_' || p_decision, p_client, true, coalesce(v_reason, v_name, ''));
  select name into v_business from public.clients where id = p_client;
  v_to := public.nv_email_owner(p_client);
  perform public.nv_email_enqueue(
    'cnic:' || p_client::text || ':' || p_decision || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
    'cnic_' || p_decision, v_to,
    jsonb_strip_nulls(jsonb_build_object('business', v_business,
      'reason', case when p_decision = 'rejected' then v_reason end)));
  return jsonb_build_object('ok', true, 'status', p_decision, 'emailed', v_to is not null);
end $$;

-- ---- emails: two new kinds -------------------------------------------------
alter table public.nv_email_queue drop constraint if exists nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check
  check (kind in ('welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected'));

-- ---- grants: signed-in users only, never anon ------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.client_kyc_status()',
    'public.client_kyc_submit(text,text)',
    'public.admin_kyc_list()',
    'public.admin_kyc_events(uuid)',
    'public.admin_kyc_attach(uuid,text,text)',
    'public.admin_kyc_review(uuid,text,text,text)'
  ] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;
