-- NovaX rider voice notes: Phase 1 (database + storage), 18 Oct 2026.
--
-- When a rider marks a parcel Refused or Consignee not available, the rider
-- app (Phase 2) records a voice note of up to 60 seconds and uploads it here.
-- Every login on the merchant's account can play it in the portal (Phase 3),
-- as can admins and support agents. Decided by Aisha on 18 Oct 2026:
-- mandatory (skip only when the phone blocks the microphone), 60 s max,
-- every merchant seat can hear it, portal only, and gone once the parcel is
-- returned to the shipper.
--
-- Storage: private bucket parcel-voice, audio only, 1 MB max per file.
-- Object path: <client_id>/<awb>/<rider_id>-<epoch_ms>-<8 hex>.<ext>
--
-- Removal: Supabase blocks deleting storage rows from SQL, and no server key
-- is in the vault, so when a parcel reaches Return to shipper (or Delivered)
-- its notes are LOCKED here at once: expired_at is set, and from then on the
-- storage rules and every function refuse to show them to anyone. A Phase 3
-- clean-up function deletes the locked files through the Storage API and sets
-- purged_at.
--
-- Run in one transaction:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>

-- ── table ─────────────────────────────────────────────────────────────────
create table if not exists public.nv_parcel_voice (
  id            uuid primary key default gen_random_uuid(),
  parcel_id     uuid not null references public.parcels(id) on delete cascade,
  awb           text not null,
  client_id     uuid not null,
  rider_id      uuid not null references public.riders(id),
  status        text not null check (status in ('Refused', 'Consignee not available')),
  reason        text check (char_length(reason) <= 200),
  storage_path  text not null unique check (char_length(storage_path) < 300),
  mime          text not null check (mime in ('audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg')),
  bytes         integer not null check (bytes > 0 and bytes <= 1048576),
  duration_ms   integer not null check (duration_ms between 3000 and 61000),
  lat           double precision check (lat between -90 and 90),
  lng           double precision check (lng between -180 and 180),
  accuracy_m    real check (accuracy_m >= 0),
  recorded_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  first_played_at timestamptz,
  first_played_by uuid,
  expired_at    timestamptz,
  purged_at     timestamptz
);
create index if not exists nv_parcel_voice_parcel on public.nv_parcel_voice (parcel_id);
create index if not exists nv_parcel_voice_client_live on public.nv_parcel_voice (client_id, created_at desc) where expired_at is null;
create index if not exists nv_parcel_voice_to_purge on public.nv_parcel_voice (expired_at) where expired_at is not null and purged_at is null;

-- The rider could not record (phone blocked the microphone). Shows on the
-- missing-note report so a skip is never silent.
create table if not exists public.nv_parcel_voice_skip (
  id          uuid primary key default gen_random_uuid(),
  parcel_id   uuid not null references public.parcels(id) on delete cascade,
  awb         text not null,
  client_id   uuid not null,
  rider_id    uuid not null references public.riders(id),
  status      text not null check (status in ('Refused', 'Consignee not available')),
  why         text not null check (why in ('no_mic', 'mic_error')),
  created_at  timestamptz not null default now()
);
create index if not exists nv_parcel_voice_skip_parcel on public.nv_parcel_voice_skip (parcel_id);

alter table public.nv_parcel_voice enable row level security;
alter table public.nv_parcel_voice_skip enable row level security;
revoke all on public.nv_parcel_voice, public.nv_parcel_voice_skip from anon, public;
revoke insert, update, delete, truncate on public.nv_parcel_voice, public.nv_parcel_voice_skip from authenticated;
grant select on public.nv_parcel_voice to authenticated;

-- Admins and support agents. cs_current_agent() is not executable by
-- ordinary logins, so row rules ask through this definer helper instead.
create or replace function public.nv_voice_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or public.cs_current_agent() is not null;
$$;

-- Read-only row rules (writes go through the functions below). The merchant's
-- rows also let Phase 3 subscribe to new notes in real time.
drop policy if exists nv_parcel_voice_read on public.nv_parcel_voice;
create policy nv_parcel_voice_read on public.nv_parcel_voice for select to authenticated
  using (expired_at is null and (
    client_id = public.my_client_id()
    or public.nv_voice_staff()
    or rider_id = public.my_rider_id()));

-- ── who may upload which file ─────────────────────────────────────────────
-- True when the signed-in rider may store this object: the path is well
-- formed, names their own rider id, and the AWB is a parcel of that client
-- that went Refused or Consignee not available in the last 72 hours (the
-- note may arrive late from a phone that was offline), delivered by them or
-- in one of their cities.
create or replace function public.nv_voice_can_upload(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  r uuid := public.my_rider_id();
  m text[];
  p public.parcels;
begin
  if r is null then return false; end if;
  m := regexp_match(coalesce(p_name, ''),
    '^([0-9a-f-]{36})/([A-Za-z0-9-]{4,40})/([0-9a-f-]{36})-([0-9]{12,14})-([0-9a-f]{8})\.(webm|ogg|m4a|mp4|aac|mp3)$');
  if m is null or m[3] <> r::text then return false; end if;
  select * into p from public.parcels x where x.awb = m[2] limit 1;
  if p.id is null or p.client_id::text <> m[1] then return false; end if;
  if not exists (select 1 from public.nv_parcel_status_log l
                  where l.awb = p.awb and l.to_status in ('Refused', 'Consignee not available')
                    and l.changed_at > now() - interval '72 hours') then
    return false;
  end if;
  return p.rider_id = r or public.nv_parcel_dest(p) = any(public.nv_rider_cities());
end $$;

-- True when the caller may play this object: admins and support agents
-- always, the merchant's own seats for their parcels; never once locked.
create or replace function public.nv_voice_can_read(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.nv_parcel_voice v
     where v.storage_path = p_name and v.expired_at is null
       and (public.nv_voice_staff()
            or v.client_id = public.my_client_id() or v.rider_id = public.my_rider_id()));
$$;

-- ── bucket and storage rules ──────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('parcel-voice', 'parcel-voice', false, 1048576,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576,
  allowed_mime_types = array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'];

drop policy if exists parcel_voice_rider_insert on storage.objects;
create policy parcel_voice_rider_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'parcel-voice' and public.nv_voice_can_upload(name));

drop policy if exists parcel_voice_read on storage.objects;
create policy parcel_voice_read on storage.objects for select to authenticated
  using (bucket_id = 'parcel-voice' and public.nv_voice_can_read(name));
-- No update policy: a note is never replaced. No delete policy: removal is
-- the Phase 3 clean-up, through the Storage API.

-- ── rider: attach an uploaded note, or record why there is none ────────────
create or replace function public.rider_voice_attach(
  p_awb text, p_path text, p_duration_ms integer, p_mime text, p_bytes integer,
  p_reason text default null, p_lat double precision default null, p_lng double precision default null,
  p_accuracy real default null, p_recorded_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r uuid := public.nv_require_rider();
  p public.parcels;
  v_status text;
  v_id uuid;
begin
  select id into v_id from public.nv_parcel_voice where storage_path = p_path;
  if v_id is not null then return jsonb_build_object('ok', true, 'id', v_id, 'repeat', true); end if;
  if not public.nv_voice_can_upload(p_path) then
    raise exception 'This voice note does not belong to a parcel you marked refused or not available.' using errcode = '42501';
  end if;
  select * into p from public.parcels x where x.awb = btrim(p_awb) limit 1;
  if p.id is null or split_part(p_path, '/', 2) <> p.awb then raise exception 'Parcel not found.'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'parcel-voice' and o.name = p_path) then
    raise exception 'Upload the recording before attaching it.';
  end if;
  -- The status the note explains: the latest Refused / not-available mark.
  select l.to_status into v_status from public.nv_parcel_status_log l
   where l.awb = p.awb and l.to_status in ('Refused', 'Consignee not available')
   order by l.changed_at desc limit 1;
  insert into public.nv_parcel_voice (parcel_id, awb, client_id, rider_id, status, reason, storage_path,
      mime, bytes, duration_ms, lat, lng, accuracy_m, recorded_at)
  values (p.id, p.awb, p.client_id, r, v_status, nullif(left(btrim(coalesce(p_reason, '')), 200), ''), p_path,
      p_mime, p_bytes, p_duration_ms, p_lat, p_lng, p_accuracy, least(coalesce(p_recorded_at, now()), now()))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.rider_voice_skip(p_awb text, p_why text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r uuid := public.nv_require_rider();
  p public.parcels;
  v_status text;
begin
  if p_why not in ('no_mic', 'mic_error') then raise exception 'A voice note can only be skipped when the microphone is blocked.'; end if;
  select * into p from public.parcels x where x.awb = btrim(p_awb) limit 1;
  if p.id is null then raise exception 'Parcel not found.'; end if;
  select l.to_status into v_status from public.nv_parcel_status_log l
   where l.awb = p.awb and l.to_status in ('Refused', 'Consignee not available')
     and l.changed_at > now() - interval '72 hours'
   order by l.changed_at desc limit 1;
  if v_status is null or not (p.rider_id = r or public.nv_parcel_dest(p) = any(public.nv_rider_cities())) then
    raise exception 'This parcel was not marked refused or not available by you.' using errcode = '42501';
  end if;
  insert into public.nv_parcel_voice_skip (parcel_id, awb, client_id, rider_id, status, why)
  values (p.id, p.awb, p.client_id, r, v_status, p_why);
  return jsonb_build_object('ok', true);
end $$;

-- ── everyone who may listen: the notes on these parcels ───────────────────
-- Merchant seats get their own parcels, admins and support agents any.
-- Locked (returned) notes are never listed.
create or replace function public.voice_notes_for(p_awbs text[])
returns table (id uuid, awb text, status text, reason text, duration_ms integer, rider text,
               recorded_at timestamptz, storage_path text, mime text, first_played_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id();
  v_staff boolean := public.nv_voice_staff();
begin
  if not v_staff and v_client is null then raise exception 'Sign in to hear voice notes.' using errcode = '42501'; end if;
  return query
    select v.id, v.awb, v.status, v.reason, v.duration_ms,
           split_part(btrim(coalesce(rd.name, 'Rider')), ' ', 1),
           v.recorded_at, v.storage_path, v.mime, v.first_played_at
      from public.nv_parcel_voice v
      left join public.riders rd on rd.id = v.rider_id
     where v.awb = any(coalesce(p_awbs, '{}'::text[])) and v.expired_at is null
       and (v_staff or v.client_id = v_client)
     order by v.recorded_at desc
     limit 200;
end $$;

-- A merchant seat played the note (first play only is kept).
create or replace function public.voice_note_played(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id();
begin
  if v_client is null then return false; end if;
  update public.nv_parcel_voice set first_played_at = now(), first_played_by = auth.uid()
   where id = p_id and client_id = v_client and first_played_at is null and expired_at is null;
  return found;
end $$;

-- ── lock on return ────────────────────────────────────────────────────────
create or replace function public.nv_parcel_voice_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('Return to shipper', 'Delivered') and new.status is distinct from old.status then
    update public.nv_parcel_voice set expired_at = now() where parcel_id = new.id and expired_at is null;
  end if;
  return new;
end $$;
drop trigger if exists zz_nv_parcel_voice_lock on public.parcels;
create trigger zz_nv_parcel_voice_lock after update of status on public.parcels
  for each row execute function public.nv_parcel_voice_lock();

-- ── missing-note report (admin, support) ──────────────────────────────────
-- Every Refused / not-available mark in the window, with whether a note or a
-- skip followed it within 72 hours.
create or replace function public.admin_voice_missing(p_days integer default 7)
returns table (awb text, status text, marked_at timestamptz, rider text, client text,
               has_note boolean, skipped text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_admin() or public.nv_staff_can('riders') or public.cs_current_agent() is not null) then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  return query
    select l.awb, l.to_status, l.changed_at, coalesce(rd.name, ''), coalesce(c.name, ''),
           exists (select 1 from public.nv_parcel_voice v where v.parcel_id = l.parcel_id
                    and v.created_at between l.changed_at - interval '5 minutes' and l.changed_at + interval '72 hours'),
           (select s.why from public.nv_parcel_voice_skip s where s.parcel_id = l.parcel_id
              and s.created_at between l.changed_at - interval '5 minutes' and l.changed_at + interval '72 hours'
            order by s.created_at desc limit 1)
      from public.nv_parcel_status_log l
      join public.parcels p on p.id = l.parcel_id
      left join public.riders rd on rd.id = p.rider_id
      left join public.clients c on c.id = l.client_id
     where l.to_status in ('Refused', 'Consignee not available')
       and l.changed_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
     order by l.changed_at desc;
end $$;

-- ── grants: authenticated only, never anon ────────────────────────────────
revoke all on function public.nv_voice_staff(), public.nv_voice_can_upload(text), public.nv_voice_can_read(text),
  public.rider_voice_attach(text, text, integer, text, integer, text, double precision, double precision, real, timestamptz),
  public.rider_voice_skip(text, text), public.voice_notes_for(text[]), public.voice_note_played(uuid),
  public.nv_parcel_voice_lock(), public.admin_voice_missing(integer)
  from public, anon;
grant execute on function public.nv_voice_staff(), public.nv_voice_can_upload(text), public.nv_voice_can_read(text),
  public.rider_voice_attach(text, text, integer, text, integer, text, double precision, double precision, real, timestamptz),
  public.rider_voice_skip(text, text), public.voice_notes_for(text[]), public.voice_note_played(uuid),
  public.admin_voice_missing(integer)
  to authenticated;
