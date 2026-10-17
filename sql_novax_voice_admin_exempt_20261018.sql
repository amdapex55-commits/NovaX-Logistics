-- NovaX rider voice notes: admins are exempt (18 Oct 2026, Aisha).
-- The voice note is a rider's job. A Refused / not-available mark made from
-- admin (or by support, a merchant or the system) is not a missing note.
-- nv_parcel_status_log now records who made each change, and the
-- missing-note report counts only marks made by a rider login.
-- Run once:  psql "<connection>" -X -1 -v ON_ERROR_STOP=1 -f <this file>

alter table public.nv_parcel_status_log add column if not exists actor uuid;
alter table public.nv_parcel_status_log add column if not exists actor_role text;

create or replace function public.nv_log_parcel_status()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_uid uuid := auth.uid(); v_role text;
begin
  -- Who made the change: admin first (an admin may also hold other links),
  -- then rider, support agent, merchant seat; no login at all is the system.
  v_role := case
    when v_uid is null then 'system'
    when public.is_admin() then 'admin'
    when public.my_rider_id() is not null then 'rider'
    when public.cs_current_agent() is not null then 'support'
    when public.my_client_id() is not null then 'client'
    else 'other' end;
  if TG_OP = 'INSERT' then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at, actor, actor_role)
    values (NEW.id, NEW.awb, NEW.client_id, null, NEW.status, coalesce(NEW.booked_at, now()), v_uid, v_role);
    return NEW;
  end if;
  if NEW.status is distinct from OLD.status then
    insert into public.nv_parcel_status_log (parcel_id, awb, client_id, from_status, to_status, changed_at, actor, actor_role)
    values (NEW.id, NEW.awb, NEW.client_id, OLD.status, NEW.status, now(), v_uid, v_role);
  end if;
  return NEW;
end;
$function$;

-- Missing-note report: rider marks only. Marks logged before this change
-- have no actor; the recorder did not exist then, so they are left out too.
create or replace function public.admin_voice_missing(p_days integer default 7)
returns table (awb text, status text, marked_at timestamptz, rider text, client text,
               has_note boolean, skipped text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_admin() or public.nv_staff_can('riders') or public.cs_current_agent() is not null) then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  return query
    select l.awb, l.to_status, l.changed_at, coalesce(rd.name, ''), coalesce(c.name, ''),
           exists (select 1 from public.nv_parcel_voice v where v.parcel_id = l.parcel_id
                    and v.created_at between l.changed_at - interval '5 minutes' and l.changed_at + interval '72 hours'),
           (select s.why from public.nv_parcel_voice_skip s where s.parcel_id = l.parcel_id
              and s.created_at between l.changed_at - interval '5 minutes' and l.changed_at + interval '72 hours'
            order by s.created_at desc limit 1)
      from public.nv_parcel_status_log l
      join public.parcels p on p.id = l.parcel_id
      left join public.profiles pr on pr.id = l.actor
      left join public.riders rd on rd.id = coalesce(pr.rider_id, p.rider_id)
      left join public.clients c on c.id = l.client_id
     where l.to_status in ('Refused', 'Consignee not available')
       and l.actor_role = 'rider'
       and l.changed_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
     order by l.changed_at desc;
end $$;
revoke all on function public.admin_voice_missing(integer) from public, anon;
grant execute on function public.admin_voice_missing(integer) to authenticated;
