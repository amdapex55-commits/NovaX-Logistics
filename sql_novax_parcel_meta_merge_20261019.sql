-- 19 Oct 2026: admin saved a parcel's whole meta from the copy it loaded,
-- wiping anything written since (that is how 3 parcels lost their batch tag).
-- Admin now sends only the meta keys it changed; this merges them into the
-- CURRENT meta. SECURITY INVOKER: the caller's own row rules, column guards
-- and triggers apply exactly as for a normal update. Returns rows updated.
create or replace function public.admin_parcel_meta_merge(p_id uuid, p_set jsonb, p_unset text[] default '{}')
returns integer language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if jsonb_typeof(coalesce(p_set, '{}'::jsonb)) <> 'object' then raise exception 'p_set must be an object.'; end if;
  update public.parcels p
     set meta = (coalesce(p.meta, '{}'::jsonb) - coalesce(p_unset, '{}'::text[])) || coalesce(p_set, '{}'::jsonb)
   where p.id = p_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.admin_parcel_meta_merge(uuid, jsonb, text[]) from public, anon;
grant execute on function public.admin_parcel_meta_merge(uuid, jsonb, text[]) to authenticated;
