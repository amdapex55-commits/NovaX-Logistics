-- Revoke Access in the admin's Edit Users sets profiles.status = 'blocked'
-- and says the person is locked out of every portal. The Support Desk only
-- looked at its own team list, so a revoked login that was also a desk agent
-- could still open care.html: refused-parcel calls, customer phone numbers,
-- Nova Recover. Staff logins made since 9 Oct 2026 can be both, so the gap
-- matters now. A blocked or disabled profile is no longer a desk agent.
-- Safe to run twice.
create or replace function public.cs_current_agent() returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id from public.cs_agents a
   where a.auth_user_id = auth.uid() and a.status = 'Active'
     and not exists (select 1 from public.profiles p
                      where p.id = a.auth_user_id
                        and lower(coalesce(p.status::text, 'active')) in ('blocked', 'disabled'));
$$;
revoke all on function public.cs_current_agent() from public, anon;

-- Two desk functions looked at the team list themselves. Patched in place,
-- and only if they still have the shape this was written against.
do $$
declare d text; n int;
  v_blocked constant text := ' and not exists (select 1 from public.profiles p where p.id = auth.uid() and lower(coalesce(p.status::text, ''active'')) in (''blocked'', ''disabled''))';
begin
  -- cs_me: who am I on the desk
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'cs_me' and p.pronamespace = 'public'::regnamespace;
  if d is null then raise exception 'cs_me not found'; end if;
  if position('p.status::text, ''active'')) in (''blocked''' in d) = 0 then
    n := regexp_count(d, 'select \* into v_agent from public\.cs_agents where auth_user_id = auth\.uid\(\);');
    if n <> 1 then raise exception 'cs_me has changed shape (% matches); not patched', n; end if;
    d := regexp_replace(d, 'select \* into v_agent from public\.cs_agents where auth_user_id = auth\.uid\(\);',
                        'select * into v_agent from public.cs_agents where auth_user_id = auth.uid()' || v_blocked || ';');
    execute d;
  end if;
  -- cs_recover_peek: does this login see the Recover tab
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'cs_recover_peek' and p.pronamespace = 'public'::regnamespace;
  if d is null then raise exception 'cs_recover_peek not found'; end if;
  if position('p.status::text, ''active'')) in (''blocked''' in d) = 0 then
    n := regexp_count(d, 'a\.auth_user_id = auth\.uid\(\) and a\.status = ''Active''\)');
    if n <> 1 then raise exception 'cs_recover_peek has changed shape (% matches); not patched', n; end if;
    d := regexp_replace(d, 'a\.auth_user_id = auth\.uid\(\) and a\.status = ''Active''\)',
                        'a.auth_user_id = auth.uid() and a.status = ''Active''' || v_blocked || ')');
    execute d;
  end if;
end $$;
