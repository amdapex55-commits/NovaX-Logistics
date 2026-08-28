-- ===========================================================================
-- Let a merchant correct their own business name.
--
-- WHY
--   clients.name is what prints under CLIENT / SHIPPER on every AWB label.
--   A sign-in recovery path used to fall back to the person's full_name when
--   a signup carried no business_name, so 48 merchants had their personal
--   name printed on every parcel they shipped. The code path is fixed, but
--   those merchants had no way to correct it themselves -- the only route was
--   messaging support, which is how the first case surfaced at all.
--
-- SAFETY
--   SECURITY DEFINER and scoped to my_client_id(), so a merchant can only
--   ever rename their own workspace. Nothing else on clients is writable
--   here: name only. The old name is kept in meta.nameHistory so a support
--   question later has an answer, and so a bad edit is recoverable.
-- ===========================================================================

create or replace function public.client_set_business_name(p_name text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client_id uuid;
  v_old       text;
  v_new       text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  v_new := btrim(coalesce(p_name, ''));
  if v_new = '' then
    raise exception 'Business name cannot be empty.';
  end if;
  if length(v_new) < 2 then
    raise exception 'Business name is too short.';
  end if;
  if length(v_new) > 80 then
    raise exception 'Business name cannot be longer than 80 characters.';
  end if;

  select name into v_old from public.clients where id = v_client_id;
  if v_old is not distinct from v_new then
    return v_new;                       -- nothing to do
  end if;

  update public.clients
     set name = v_new,
         meta = jsonb_set(
                  coalesce(meta, '{}'::jsonb),
                  '{nameHistory}',
                  coalesce(meta->'nameHistory', '[]'::jsonb) ||
                    jsonb_build_object('from', v_old, 'to', v_new,
                                       'at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                       'by', 'merchant'),
                  true)
   where id = v_client_id;

  return v_new;
end;
$$;

revoke all on function public.client_set_business_name(text) from public, anon;
grant execute on function public.client_set_business_name(text) to authenticated;
