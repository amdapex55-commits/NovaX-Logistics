-- Signed documents keep the reward terms in force when the rep signed, so a
-- later change to sales_settings never rewrites what they agreed to.
begin;
alter table public.sales_rep_signatures add column if not exists terms jsonb;

create or replace function public.sales_sign_documents(p_version text, p_sha256 text, p_signed_name text, p_png text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_current_rep();
  v_r public.sales_reps;
  v_hdr jsonb;
begin
  if v_rep is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  select * into v_r from public.sales_reps where id = v_rep;
  if v_r.profile_done_at is null then raise exception 'Fill in your joining form first.' using errcode = '42501'; end if;
  if p_version is distinct from (select value from public.sales_settings where key = 'docs_version') then
    raise exception 'The documents were updated. Refresh the page and read them again.' using errcode = '22023'; end if;
  if lower(regexp_replace(btrim(coalesce(p_signed_name, '')), '\s+', ' ', 'g')) <> lower(v_r.full_name) then
    raise exception 'Type your name exactly as on the form: %', v_r.full_name using errcode = '22023'; end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Could not read the documents. Refresh and try again.' using errcode = '22023'; end if;
  if coalesce(p_png, '') not like 'data:image/png;base64,%' or char_length(p_png) not between 200 and 300000 then
    raise exception 'Draw your signature in the box first.' using errcode = '22023'; end if;
  begin v_hdr := current_setting('request.headers', true)::jsonb; exception when others then v_hdr := null; end;
  insert into public.sales_rep_signatures(rep_id, doc_version, docs_sha256, signed_name, signature_png, user_agent, ip, terms)
  values (v_rep, p_version, p_sha256, v_r.full_name, p_png, left(v_hdr->>'user-agent', 300),
          left(coalesce(v_hdr->>'cf-connecting-ip', split_part(v_hdr->>'x-forwarded-for', ',', 1)), 64),
          jsonb_build_object('account_opened', public.sales_setting_int('reward_account_opened'),
            'first_pickup', public.sales_setting_int('reward_first_pickup'), 'pickup_hold_days', public.sales_setting_int('pickup_hold_days'),
            'lead_window_days', public.sales_setting_int('lead_window_days'), 'lead_untouched_days', public.sales_setting_int('lead_untouched_days')))
  on conflict (rep_id, doc_version) do nothing;
  return public.sales_me();
end $$;

create or replace function public.sales_my_documents()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('signature_png', s.signature_png, 'signed_name', s.signed_name, 'signed_at', s.signed_at,
                            'doc_version', s.doc_version, 'docs_sha256', s.docs_sha256, 'terms', s.terms)
  from public.sales_rep_signatures s
  where s.rep_id = public.sales_current_rep()
  order by s.signed_at desc limit 1;
$$;

create or replace function public.sales_admin_rep_file(p_rep uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select jsonb_build_object(
      'rep', jsonb_build_object('id', r.id, 'code', r.code, 'full_name', r.full_name, 'email', r.email, 'status', r.status,
        'joined_on', r.joined_on, 'phone', r.phone, 'cnic', r.cnic, 'address', r.address,
        'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone, 'profile_done', r.profile_done_at is not null),
      'signature', (select jsonb_build_object('signature_png', s.signature_png, 'signed_name', s.signed_name, 'signed_at', s.signed_at,
                      'doc_version', s.doc_version, 'docs_sha256', s.docs_sha256, 'ip', s.ip, 'user_agent', s.user_agent, 'terms', s.terms)
                    from public.sales_rep_signatures s where s.rep_id = r.id order by s.signed_at desc limit 1))
    from public.sales_reps r where r.id = p_rep);
end $$;

revoke all on function public.sales_sign_documents(text,text,text,text), public.sales_my_documents(), public.sales_admin_rep_file(uuid) from public, anon, authenticated;
grant execute on function public.sales_sign_documents(text,text,text,text), public.sales_my_documents(), public.sales_admin_rep_file(uuid) to authenticated;
commit;
