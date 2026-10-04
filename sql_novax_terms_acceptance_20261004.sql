-- Merchant Agreement acceptance (4 Oct 2026).
-- terms.html is the Merchant Agreement. Every acceptance is one row: who
-- (auth user), which workspace, which version, when, and from which page.
-- Signup ticks "I accept" and stamps terms_version / terms_accepted_at into
-- the new user's metadata, so acceptance is kept even when email
-- verification means there is no session yet; nv_terms_status() turns that
-- stamp into a row on first sign-in. Existing merchants accept from a portal
-- banner through nv_accept_terms().

create table if not exists public.nv_terms_acceptance (
  id          bigserial primary key,
  user_id     uuid not null,
  client_id   uuid references public.clients(id) on delete set null,
  version     text not null,
  accepted_at timestamptz not null default now(),
  source      text not null default 'portal',
  user_agent  text,
  unique (user_id, version)
);
create index if not exists nv_terms_acceptance_client_idx on public.nv_terms_acceptance(client_id);

alter table public.nv_terms_acceptance enable row level security;
revoke all on public.nv_terms_acceptance from public, anon, authenticated;
grant select on public.nv_terms_acceptance to authenticated;
drop policy if exists nv_terms_acceptance_read on public.nv_terms_acceptance;
create policy nv_terms_acceptance_read on public.nv_terms_acceptance for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create or replace function public.nv_terms_current() returns text
language sql immutable set search_path='' as $$ select '1.0'::text $$;

create or replace function public.nv_accept_terms(p_version text, p_source text default 'portal', p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid := auth.uid(); v_row public.nv_terms_acceptance;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_version is distinct from public.nv_terms_current() then
    raise exception 'unknown terms version %', p_version;
  end if;
  insert into public.nv_terms_acceptance(user_id, client_id, version, source, user_agent)
  values (v_uid, public.my_client_id(), p_version,
          case when p_source in ('signup','portal') then p_source else 'portal' end,
          left(p_user_agent, 300))
  on conflict (user_id, version) do nothing;
  select * into v_row from public.nv_terms_acceptance where user_id = v_uid and version = p_version;
  return jsonb_build_object('version', v_row.version, 'accepted_at', v_row.accepted_at);
end $$;

-- Whether the signed-in merchant has accepted the current version. A signup
-- stamp in the user's metadata counts and is recorded here, at its own time.
create or replace function public.nv_terms_status()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid := auth.uid(); v_cur text := public.nv_terms_current();
        v_meta jsonb; v_at timestamptz; v_row public.nv_terms_acceptance;
begin
  if v_uid is null then return jsonb_build_object('current', v_cur, 'accepted', false); end if;
  select * into v_row from public.nv_terms_acceptance where user_id = v_uid and version = v_cur;
  if v_row.id is null then
    select raw_user_meta_data into v_meta from auth.users where id = v_uid;
    if v_meta->>'terms_version' = v_cur then
      begin v_at := (v_meta->>'terms_accepted_at')::timestamptz; exception when others then v_at := null; end;
      insert into public.nv_terms_acceptance(user_id, client_id, version, accepted_at, source)
      values (v_uid, public.my_client_id(), v_cur, coalesce(least(v_at, now()), now()), 'signup')
      on conflict (user_id, version) do nothing;
      select * into v_row from public.nv_terms_acceptance where user_id = v_uid and version = v_cur;
    end if;
  elsif v_row.client_id is null then
    update public.nv_terms_acceptance set client_id = public.my_client_id() where id = v_row.id
      returning * into v_row;
  end if;
  return jsonb_build_object('current', v_cur, 'accepted', v_row.id is not null, 'accepted_at', v_row.accepted_at);
end $$;

revoke all on function public.nv_terms_current() from public, anon;
revoke all on function public.nv_accept_terms(text, text, text) from public, anon;
revoke all on function public.nv_terms_status() from public, anon;
grant execute on function public.nv_terms_current() to authenticated;
grant execute on function public.nv_accept_terms(text, text, text) to authenticated;
grant execute on function public.nv_terms_status() to authenticated;

notify pgrst, 'reload schema';
