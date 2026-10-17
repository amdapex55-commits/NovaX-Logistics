-- NovaX rider voice notes: Phase 3 database part, 18 Oct 2026.
-- The merchant portal hears about a new voice note the moment it is attached
-- (Supabase Realtime). Row rules still apply: a merchant's socket only
-- receives rows nv_parcel_voice_read lets it see (its own client_id).
-- Run once:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                  and schemaname = 'public' and tablename = 'nv_parcel_voice') then
    alter publication supabase_realtime add table public.nv_parcel_voice;
  end if;
end $$;

-- Clean-up bookkeeping for the parcel-voice-purge function: the locked notes
-- whose files are still in storage, oldest first. Service role only.
create or replace function public.nv_voice_purge_due(p_limit integer default 100)
returns table (id uuid, storage_path text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.storage_path from public.nv_parcel_voice v
   where v.expired_at is not null and v.purged_at is null
   order by v.expired_at limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
create or replace function public.nv_voice_purge_done(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.nv_parcel_voice set purged_at = now() where id = any(p_ids) and expired_at is not null and purged_at is null;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.nv_voice_purge_due(integer), public.nv_voice_purge_done(uuid[]) from public, anon, authenticated;
grant execute on function public.nv_voice_purge_due(integer), public.nv_voice_purge_done(uuid[]) to service_role;

-- Hourly: poke parcel-voice-purge when a locked note still has its file.
create or replace function public.nv_voice_purge_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.nv_parcel_voice where expired_at is not null and purged_at is null) then return; end if;
  perform net.http_post(
    url := 'https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/parcel-voice-purge',
    body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 30000);
end $$;
revoke all on function public.nv_voice_purge_tick() from public, anon, authenticated;
select cron.schedule('novax-voice-purge', '23 * * * *', 'select public.nv_voice_purge_tick();')
 where not exists (select 1 from cron.job where jobname = 'novax-voice-purge');
