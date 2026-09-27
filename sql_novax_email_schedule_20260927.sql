-- Apply ONLY after deploying the worker and configuring its matching Vault secret.
begin;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.nv_email_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets
    where name = 'novax_email_drain_token' limit 1;
  -- Approved alternative: reuse the existing, private webhook scheduler credential.
  if coalesce(length(v_token), 0) < 32
     and to_regprocedure('public.nv_api_drain_token()') is not null then
    select public.nv_api_drain_token() into v_token;
  end if;
  if coalesce(length(v_token), 0) < 32 then
    raise warning 'NovaX email scheduler disabled: private drain token missing';
    return;
  end if;
  if exists (select 1 from public.nv_email_queue where state = 'pending'
      and next_attempt_at <= now() and coalesce(lease_until, '-infinity') < now()) then
    perform net.http_post(
      url := 'https://rhzunbzbdzicajqtohwp.supabase.co/functions/v1/novax-email-drain',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-novax-email-drain', v_token),
      body := '{}'::jsonb, timeout_milliseconds := 120000);
  end if;
end;
$$;
revoke all on function public.nv_email_tick() from public, anon, authenticated, service_role;
select cron.schedule('novax-transactional-email', '* * * * *', 'select public.nv_email_tick();');
commit;
