begin;

-- NovaX security batch 6, 10 Sep 2026 (night audit): five admin functions
-- checked profiles.role inline and ignored profiles.status.

-- ---------------------------------------------------------------- admin_ai_quota_decide
CREATE OR REPLACE FUNCTION public.admin_ai_quota_decide(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare is_admin boolean; req public.nv_ai_quota_requests%rowtype;
begin
  -- is_admin() respects profiles.status; the role check below does not,
  -- so a blocked admin still passed it.
  if not public.is_admin() then raise exception 'admin access required to decide AI quota requests'; end if;
  select exists(select 1 from public.profiles p
                 where p.id = auth.uid()
                   and lower(p.role::text) in ('admin','owner')) into is_admin;
  if not is_admin then
    raise exception 'admin access required to decide AI quota requests';
  end if;

  select * into req from public.nv_ai_quota_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if req.status <> 'pending' then
    return jsonb_build_object('ok',false,'reason','already_decided','status',req.status);
  end if;

  update public.nv_ai_quota_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_at = now(), decided_by = auth.uid(),
         admin_note = nullif(btrim(coalesce(p_note,'')),'')
   where id = p_request_id;

  if p_approve then
    update public.nv_ai_usage
       set used = 0, cycle_started = now(),
           last_reset_by = auth.uid(), last_reset_at = now()
     where client_id = req.client_id;
  end if;

  return jsonb_build_object('ok',true,'approved',p_approve,'client_id',req.client_id);
end
$function$;

-- ---------------------------------------------------------------- admin_list_reviews
CREATE OR REPLACE FUNCTION public.admin_list_reviews()
 RETURNS TABLE(id uuid, client_id uuid, client_name text, rating integer, comment text, status text, display_name text, created_at timestamp with time zone, reviewed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- is_admin() respects profiles.status; the role check below does not,
  -- so a blocked admin still passed it.
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then raise exception 'Admin access required.'; end if;

  return query
  select r.id, r.client_id, c.name, r.rating, r.comment,
         r.status, r.display_name, r.created_at, r.reviewed_at
  from public.reviews r
  left join public.clients c on c.id = r.client_id
  order by (r.status = 'pending') desc, r.created_at desc;
end; $function$;

-- ---------------------------------------------------------------- admin_set_review_status
CREATE OR REPLACE FUNCTION public.admin_set_review_status(p_review_id uuid, p_status text, p_display_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- is_admin() respects profiles.status; the role check below does not,
  -- so a blocked admin still passed it.
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then raise exception 'Admin access required.'; end if;

  if p_status not in ('pending','approved','rejected') then
    raise exception 'Unknown review status: %', p_status;
  end if;

  update public.reviews
  set status = p_status,
      display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
      reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_review_id;

  if not found then raise exception 'Review not found.'; end if;
  return json_build_object('ok', true);
end; $function$;

-- ---------------------------------------------------------------- admin_set_client_pricing_mode
CREATE OR REPLACE FUNCTION public.admin_set_client_pricing_mode(p_client_id uuid, p_mode text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
begin
  -- is_admin() respects profiles.status; the role check below does not,
  -- so a blocked admin still passed it.
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_authorised'); end if;
  select lower(pr.role::text) into v_role
  from public.profiles pr where pr.id = auth.uid() limit 1;

  if v_role is null or v_role not in ('admin','owner') then
    return json_build_object('ok', false, 'error', 'not_authorised');
  end if;

  if p_mode is null or p_mode not in ('flat','distance') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    return json_build_object('ok', false, 'error', 'no_such_client');
  end if;

  update public.clients
     set pricing_mode        = p_mode,
         pricing_mode_at     = now(),
         pricing_mode_source = 'admin'
   where id = p_client_id;

  return json_build_object('ok', true, 'mode', p_mode);
end
$function$;

-- ---------------------------------------------------------------- admin_ai_quota_pending
CREATE OR REPLACE FUNCTION public.admin_ai_quota_pending()
 RETURNS TABLE(id uuid, client_id uuid, client_name text, reason text, requested_at timestamp with time zone, used integer, cap integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select r.id, r.client_id, c.name, r.reason, r.requested_at,
         coalesce(u.used,0), coalesce(u.cap,50)
    from public.nv_ai_quota_requests r
    left join public.clients c on c.id = r.client_id
    left join public.nv_ai_usage u on u.client_id = r.client_id
   where r.status = 'pending'
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid()
                    and lower(p.role::text) in ('admin','owner','staff'))
     and public.is_admin()  -- the inline role check ignores profiles.status
   order by r.requested_at asc;
$function$;

commit;
