-- 6 Nov 2026: the waiting list keeps up with the ad campaigns.
-- 1. nv_queue_let_in: the one place a merchant is let in (status, email,
--    audit). admin_queue_approve now calls it.
-- 2. admin_queue_approve_all: "Let in all" in admin.
-- 3. Verifying a merchant's CNIC also lets them in, if they are waiting.
begin;

create or replace function public.nv_queue_let_in(p_client uuid, p_by uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.nv_client_queue; v_email text; v_name text; v_biz text;
begin
  update public.nv_client_queue
     set status = 'approved', approved_at = now(), approved_by = p_by
   where client_id = p_client and status = 'waiting'
  returning * into v_row;
  if v_row.client_id is null then
    if exists (select 1 from public.nv_client_queue where client_id = p_client) then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    return null;   -- not in the queue at all
  end if;
  v_email := public.nv_email_owner(p_client);
  select c.name, coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), c.owner, '')
    into v_biz, v_name
    from public.clients c left join auth.users u on lower(u.email) = lower(v_email)
   where c.id = p_client;
  if v_email is not null then
    begin
      perform public.nv_email_enqueue('portal_open:' || p_client, 'portal_open', v_email,
        jsonb_build_object('name', coalesce(v_name, ''), 'business', coalesce(v_biz, ''), 'number', v_row.number));
    exception when others then raise warning 'NovaX email enqueue failed (portal_open), SQLSTATE %', SQLSTATE;
    end;
  end if;
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (p_by, 'queue_approved', 'client', p_client, jsonb_build_object('number', v_row.number, 'via', p_via));
  return jsonb_build_object('ok', true, 'emailed', v_email is not null);
end $$;
revoke all on function public.nv_queue_let_in(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.admin_queue_approve(p_client uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  v := public.nv_queue_let_in(p_client, auth.uid(), 'admin');
  if v is null then raise exception 'That merchant is not in the queue.'; end if;
  return v;
end $$;

create or replace function public.admin_queue_approve_all()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; no_email int := 0; v jsonb;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  for r in select client_id from public.nv_client_queue where status = 'waiting' order by joined_at loop
    v := public.nv_queue_let_in(r.client_id, auth.uid(), 'admin_all');
    if v is not null and coalesce((v->>'already')::boolean, false) is not true then
      n := n + 1;
      if coalesce((v->>'emailed')::boolean, true) is not true then no_email := no_email + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'let_in', n, 'no_email', no_email);
end $$;
revoke all on function public.admin_queue_approve_all() from public, anon;
grant execute on function public.admin_queue_approve_all() to authenticated;

do $$
declare d text; o text := $x$  return jsonb_build_object('ok', true, 'status', p_decision, 'emailed', v_to is not null);$x$;
begin
  d := pg_get_functiondef('public.admin_kyc_review(uuid,text,text,text,text,text)'::regprocedure);
  if position(o in d) = 0 then raise exception 'admin_kyc_review return not found'; end if;
  execute replace(d, o, $x$  -- 6 Nov 2026: a verified CNIC also lets a waiting merchant in.
  if p_decision = 'verified' then perform public.nv_queue_let_in(p_client, auth.uid(), 'cnic_verified'); end if;
$x$ || o);
end $$;
commit;
