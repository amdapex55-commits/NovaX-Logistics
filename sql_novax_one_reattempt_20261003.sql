-- 3 Oct 2026: one reattempt per parcel (Aisha: "only show reattempt button
-- once, don't let repeat on same parcels again and again").

-- 1. A parcel moves to Reattempt once. Riders, staff and the API are
--    refused a second time; an admin can still do it deliberately from
--    Order Processing.
create or replace function public.nv_one_reattempt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (coalesce(old.meta->'steps', '[]'::jsonb) ? 'Reattempt'
      or exists (select 1 from public.nv_parcel_status_log l where l.parcel_id = new.id and l.to_status = 'Reattempt'))
     and not public.is_admin() then
    raise exception 'Parcel % has already had its one reattempt. Mark it Refused or Consignee not available so it goes back.', new.awb
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.nv_one_reattempt() from public, anon, authenticated;

drop trigger if exists trg_nv_one_reattempt on public.parcels;
create trigger trg_nv_one_reattempt
  before update of status on public.parcels
  for each row
  when (new.status = 'Reattempt' and old.status is distinct from 'Reattempt')
  execute function public.nv_one_reattempt();

-- 2. A merchant asks for a reattempt once per parcel, and not at all after
--    the parcel's reattempt has been used. The request is stamped on the
--    parcel (meta.reattemptRequestedAt) so every screen can hide the button.
--    SECURITY DEFINER to write that stamp; ownership is checked here.
create or replace function public.ai_action_request_reattempt(p_awb text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a text := upper(btrim(coalesce(p_awb, ''))); v public.parcels; res jsonb;
begin
  if a = '' then return jsonb_build_object('ok', false, 'reason', 'no_awb'); end if;
  select * into v from public.parcels where upper(awb) = a and client_id = public.my_client_id();
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if nullif(v.meta->>'reattemptRequestedAt', '') is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_requested', 'at', v.meta->>'reattemptRequestedAt');
  end if;
  if (coalesce(v.meta->'steps', '[]'::jsonb) ? 'Reattempt'
      or exists (select 1 from public.nv_parcel_status_log l where l.parcel_id = v.id and l.to_status = 'Reattempt'))
     and v.status <> 'Reattempt' then
    return jsonb_build_object('ok', false, 'reason', 'already_reattempted');
  end if;
  select to_jsonb(public.novax_ticket_open(
    p_subject  := 'Reattempt requested - ' || a,
    p_body     := coalesce(nullif(btrim(p_note), ''), 'Merchant requested a delivery reattempt.'),
    p_awb      := a,
    p_priority := 'High')) into res;
  update public.parcels set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('reattemptRequestedAt', now())
   where id = v.id;
  return jsonb_build_object('ok', true, 'ticket', res);
end $$;
revoke all on function public.ai_action_request_reattempt(text, text) from public, anon;
grant execute on function public.ai_action_request_reattempt(text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
