-- ===========================================================================
-- Public tracking rate limit -- 30 Aug 2026
--
-- Measured before this: 20 rapid unauthenticated calls to public_track_awb all
-- returned 200, and AWBs are sequential -- N3630045 and N3630046 both resolve,
-- N9999999 does not. So the whole AWB space can be walked, harvesting every
-- parcel's route, city pair and delivery timestamps: volume, corridors and
-- performance, readable by a competitor.
--
-- No personal data is exposed (verified: no consignee, phone, address or COD),
-- so this is a bulk-harvesting control, not a leak fix.
--
-- Deliberately generous. A real customer refreshes a tracking page a handful
-- of times; a scraper walks thousands. 40 lookups per IP per 10 minutes leaves
-- the honest case untouched and makes enumeration impractically slow. Failing
-- OPEN is the point: if the counter table is unavailable for any reason, real
-- customers must still be able to track their parcels.
-- ===========================================================================

create table if not exists public.nv_track_hits (
  bucket_key text primary key,
  hits       int not null default 0,
  window_at  timestamptz not null default now()
);
alter table public.nv_track_hits enable row level security;   -- no policy: service/definer only

create or replace function public.nv_track_rate_ok(p_key text, p_limit int default 40, p_window interval default interval '10 minutes')
returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare v_row public.nv_track_hits; v_now timestamptz := now();
begin
  if coalesce(btrim(p_key),'') = '' then return true; end if;   -- unknown caller: do not punish
  select * into v_row from public.nv_track_hits where bucket_key = p_key for update;
  if v_row.bucket_key is null then
    insert into public.nv_track_hits(bucket_key, hits, window_at) values (p_key, 1, v_now)
    on conflict (bucket_key) do update set hits = public.nv_track_hits.hits + 1;
    return true;
  end if;
  if v_row.window_at < v_now - p_window then
    update public.nv_track_hits set hits = 1, window_at = v_now where bucket_key = p_key;
    return true;
  end if;
  if v_row.hits >= p_limit then return false; end if;
  update public.nv_track_hits set hits = hits + 1 where bucket_key = p_key;
  return true;
exception when others then
  return true;   -- fail OPEN: never block a real customer because of this
end $$;

-- Opportunistic cleanup so the table cannot grow without bound.
create or replace function public.nv_track_hits_trim()
returns void language sql security definer set search_path to 'public' as $$
  delete from public.nv_track_hits where window_at < now() - interval '1 day';
$$;

revoke all on function public.nv_track_rate_ok(text,int,interval) from public, anon, authenticated;
revoke all on function public.nv_track_hits_trim() from public, anon, authenticated;
