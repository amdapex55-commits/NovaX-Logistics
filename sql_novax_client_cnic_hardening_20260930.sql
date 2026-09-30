-- ═══ CNIC photos: hardening (30 Sep 2026) ═══════════════════════════════════
-- Follows sql_novax_client_cnic_20260930.sql. Eight review findings, each
-- checked against the code first; the database side of the fixes is here.
--
--  1  Verify / ask-for-new-photo now name the exact photos the admin looked
--     at. If the merchant replaced them in between, the decision is refused.
--  2  Owners may delete their own uploads that were never submitted, so a
--     failed or abandoned send cleans up after itself. Nothing that was ever
--     submitted can be deleted by a merchant.
--  3  The lifetime 40-file cap could lock a merchant out forever. It is now a
--     rolling 20 uploads per 24 hours, with a clear message.
--  4  The server refuses a front and back that are the same file (same
--     checksum), and files that are not a finished JPEG upload.
--  6  File names may carry a random suffix (the new client adds one).
--  7  admin_kyc_orphans lists leftovers -- uploads never submitted and older
--     than a day, and every file of a deleted account -- for the admin page
--     to remove. Storage files can only be removed through the Storage API.
-- (5 and 8 -- extreme shapes and HEIC -- are photo checks in nv-cnic.js.)

-- ---- names: <client_id>/cnic-<front|back>-<ms>[-<8 hex>].jpg ---------------
create or replace function public.nv_kyc_name_ok(p_name text, p_client uuid default null, p_side text default null)
returns boolean language sql immutable set search_path to 'public' as $$
  select coalesce(p_side, 'any') in ('front', 'back', 'any')
     and coalesce(p_name, '') ~ ('^'
        || coalesce(p_client::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
        || '/cnic-' || case when p_side in ('front', 'back') then p_side else '(front|back)' end
        || '-[0-9]{10,16}(-[0-9a-f]{8})?\.jpg$');
$$;

-- ---- what stops the signed-in merchant uploading right now (null = nothing)
create or replace function public.nv_kyc_upload_block()
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare c uuid := public.my_client_id(); n int;
begin
  if c is null then return 'Sign in to a NovaX merchant account first.'; end if;
  if not public.is_client_owner_seat() then return 'Only the account owner can add the CNIC.'; end if;
  if exists (select 1 from public.client_kyc k where k.client_id = c and k.status = 'verified') then
    return 'Your CNIC is already verified. Contact NovaX to change it.';
  end if;
  select count(*) into n from storage.objects o
   where o.bucket_id = 'client-kyc' and o.name like c::text || '/%'
     and o.created_at > now() - interval '24 hours';
  if n >= 20 then
    return 'Too many photo uploads today. Try again tomorrow, or send the photos to NovaX support on WhatsApp.';
  end if;
  return null;
end $$;

create or replace function public.nv_kyc_upload_open()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.nv_kyc_upload_block() is null;
$$;

create or replace function public.client_kyc_upload_check()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('ok', s.b is null, 'message', s.b) from (select public.nv_kyc_upload_block() as b) s;
$$;

-- ---- was this file ever submitted (current photos or any past event)? ------
create or replace function public.nv_kyc_path_used(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.client_kyc k where k.front_path = p_name or k.back_path = p_name)
      or exists (select 1 from public.client_kyc_events e
                  where e.detail->>'front' = p_name or e.detail->>'back' = p_name);
$$;

-- ---- is this a finished JPEG upload? (null = yes) ---------------------------
create or replace function public.nv_kyc_file_problem(p_name text)
returns text language sql stable security definer set search_path to 'public' as $$
  select case
    when o.name is null then 'The CNIC photos did not finish uploading. Please add them again.'
    when coalesce(o.metadata->>'mimetype', '') <> 'image/jpeg'
      or (case when coalesce(o.metadata->>'size', '') ~ '^[0-9]{1,12}$' then (o.metadata->>'size')::bigint else 0 end) < 5000
      then 'A CNIC photo did not upload properly. Please add it again.'
    else null end
  from (select 1) x
  left join storage.objects o on o.bucket_id = 'client-kyc' and o.name = p_name;
$$;

create or replace function public.nv_kyc_same_file(p_a text, p_b text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select nullif(o.metadata->>'eTag', '') from storage.objects o where o.bucket_id = 'client-kyc' and o.name = p_a)
               = (select nullif(o.metadata->>'eTag', '') from storage.objects o where o.bucket_id = 'client-kyc' and o.name = p_b), false);
$$;

-- ---- storage policies --------------------------------------------------------
drop policy if exists client_kyc_insert on storage.objects;
create policy client_kyc_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'client-kyc'
  and public.nv_kyc_name_ok(name)
  and ( public.is_admin()
        or (split_part(name, '/', 1) = public.my_client_id()::text and public.nv_kyc_upload_open()) )
);
-- Only uploads that were never submitted; the record of what was sent stays.
drop policy if exists client_kyc_owner_delete_unused on storage.objects;
create policy client_kyc_owner_delete_unused on storage.objects for delete to authenticated
using (
  bucket_id = 'client-kyc'
  and split_part(name, '/', 1) = public.my_client_id()::text
  and public.is_client_owner_seat()
  and not public.nv_kyc_path_used(name)
);

-- ---- merchant side -----------------------------------------------------------
create or replace function public.client_kyc_status()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); v_owner boolean; k public.client_kyc; v_block text;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.' using errcode = '42501';
  end if;
  v_owner := public.is_client_owner_seat();
  if v_owner then v_block := public.nv_kyc_upload_block(); end if;
  select * into k from public.client_kyc where client_id = v_client;
  if not found then
    return jsonb_build_object('status', 'missing', 'is_owner', v_owner,
                              'can_upload', v_owner and v_block is null, 'upload_block', v_block);
  end if;
  return jsonb_build_object(
    'status',       k.status,
    'is_owner',     v_owner,
    'can_upload',   v_owner and v_block is null,
    'upload_block', case when k.status <> 'verified' then v_block end,
    'reason',       case when k.status = 'rejected' then k.reject_reason end,
    'submitted_at', k.submitted_at,
    'reviewed_at',  k.reviewed_at,
    'front_path',   case when v_owner then k.front_path end,
    'back_path',    case when v_owner then k.back_path end);
end $$;

create or replace function public.client_kyc_submit(p_front text, p_back text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); v_status text; v_problem text;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.' using errcode = '42501';
  end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only the account owner can add the CNIC.' using errcode = '42501';
  end if;
  if not public.nv_kyc_name_ok(p_front, v_client, 'front') or not public.nv_kyc_name_ok(p_back, v_client, 'back') then
    raise exception 'Add a photo of the front and the back of the CNIC.';
  end if;
  v_problem := coalesce(public.nv_kyc_file_problem(p_front), public.nv_kyc_file_problem(p_back));
  if v_problem is not null then raise exception '%', v_problem; end if;
  if public.nv_kyc_same_file(p_front, p_back) then
    raise exception 'The front and the back are the same photo. Add a photo of each side of the card.';
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

-- ---- admin side --------------------------------------------------------------
create or replace function public.admin_kyc_attach(p_client uuid, p_front text, p_back text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_email text; v_problem text;
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if not exists (select 1 from public.clients where id = p_client) then
    raise exception 'That client no longer exists.';
  end if;
  if not public.nv_kyc_name_ok(p_front, p_client, 'front') or not public.nv_kyc_name_ok(p_back, p_client, 'back') then
    raise exception 'Add a photo of the front and the back of the CNIC.';
  end if;
  v_problem := coalesce(public.nv_kyc_file_problem(p_front), public.nv_kyc_file_problem(p_back));
  if v_problem is not null then raise exception '%', v_problem; end if;
  if public.nv_kyc_same_file(p_front, p_back) then
    raise exception 'The front and the back are the same photo. Add a photo of each side of the card.';
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

-- The decision names the photos it is about (the ones on the admin's screen).
drop function if exists public.admin_kyc_review(uuid, text, text, text);
create or replace function public.admin_kyc_review(p_client uuid, p_decision text, p_reason text default null,
  p_name text default null, p_front text default null, p_back text default null)
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
  if p_front is null or p_back is null then
    raise exception 'Reload this page, then open the CNIC again.';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'Say what is wrong with the photo, so the merchant knows what to fix.';
  end if;
  if length(coalesce(v_reason, '')) > 200 then raise exception 'Keep the reason under 200 characters.'; end if;
  if length(coalesce(v_name, '')) > 80 then raise exception 'The name is too long (80 characters at most).'; end if;
  perform pg_advisory_xact_lock(hashtext('client_kyc:' || p_client::text));
  select * into k from public.client_kyc where client_id = p_client;
  if not found then raise exception 'This client has not added a CNIC yet.'; end if;
  if k.front_path is distinct from p_front or k.back_path is distinct from p_back then
    raise exception 'The merchant sent new photos while you were looking. Check the new ones, then decide.';
  end if;
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
          jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'name', v_name, 'was', k.status,
                                               'front', k.front_path, 'back', k.back_path)),
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

-- Files nothing points at: every file of a deleted account, and uploads that
-- were never submitted and are over a day old. The admin page removes them
-- through the Storage API (a SQL delete would leave the file itself behind).
create or replace function public.admin_kyc_orphans(p_client uuid default null, p_limit integer default 200)
returns table(name text) language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return query
    select o.name from storage.objects o
     where o.bucket_id = 'client-kyc'
       and (p_client is null or o.name like p_client::text || '/%')
       and ( not exists (select 1 from public.clients c where c.id::text = split_part(o.name, '/', 1))
             or (o.created_at < now() - interval '1 day' and not public.nv_kyc_path_used(o.name)) )
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;

-- ---- grants ------------------------------------------------------------------
-- Called by the storage policies, so the signed-in role needs them.
do $$
declare f text;
begin
  foreach f in array array[
    'public.nv_kyc_name_ok(text,uuid,text)',
    'public.nv_kyc_upload_open()',
    'public.nv_kyc_path_used(text)',
    'public.client_kyc_upload_check()',
    'public.client_kyc_status()',
    'public.client_kyc_submit(text,text)',
    'public.admin_kyc_attach(uuid,text,text)',
    'public.admin_kyc_review(uuid,text,text,text,text,text)',
    'public.admin_kyc_orphans(uuid,integer)'
  ] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
  -- internal helpers: only ever called from the functions above
  foreach f in array array[
    'public.nv_kyc_upload_block()',
    'public.nv_kyc_file_problem(text)',
    'public.nv_kyc_same_file(text,text)'
  ] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
end $$;
