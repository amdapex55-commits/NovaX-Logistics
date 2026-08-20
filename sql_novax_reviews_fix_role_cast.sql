-- ============================================================================
-- FIX: profiles.role is an enum (novax_role), not text, so lower(p.role)
-- raised "function lower(novax_role) does not exist" and the admin Reviews
-- tab could not load. Casting to text first works for a text column or an
-- enum, so this is safe either way.
--
-- Only the two admin functions were affected. Reviews already submitted are
-- untouched -- submit_client_review never looks at role.
-- ============================================================================

-- STEP 0 -- confirm what your role values actually are, so the list below is
-- right. Run this first and read the output.
select distinct p.role::text as role_value, count(*)
from public.profiles p
group by 1
order by 2 desc;

-- ---------------------------------------------------------------------------
create or replace function public.admin_list_reviews()
returns table (
  id uuid, client_id uuid, client_name text, rating int, comment text,
  status text, display_name text, created_at timestamptz, reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select r.id, r.client_id, c.name, r.rating, r.comment,
         r.status, r.display_name, r.created_at, r.reviewed_at
  from public.reviews r
  left join public.clients c on c.id = r.client_id
  order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

create or replace function public.admin_set_review_status(
  p_review_id    uuid,
  p_status       text,
  p_display_name text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then
    raise exception 'Admin access required.';
  end if;

  if p_status not in ('pending','approved','rejected') then
    raise exception 'Unknown review status: %', p_status;
  end if;

  update public.reviews
  set status       = p_status,
      display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
      reviewed_at  = now(),
      reviewed_by  = auth.uid()
  where id = p_review_id;

  if not found then
    raise exception 'Review not found.';
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.admin_list_reviews()                    to authenticated;
grant execute on function public.admin_set_review_status(uuid, text, text) to authenticated;

-- STEP 2 -- your review is already in the table. Confirm it survived:
select r.id, c.name as merchant, r.rating, r.comment, r.status, r.created_at
from public.reviews r
left join public.clients c on c.id = r.client_id
order by r.created_at desc;
