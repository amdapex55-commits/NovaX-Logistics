-- NovaX: make rider batch status updates atomic, and retry-safe.
--
-- Before, one "batch" was many independent writes from the phone:
--   * chunks of 12 parcel UPDATEs fired through Promise.all
--   * then a separate scans INSERT
--   * then a separate cod_ledger SELECT + INSERT
-- Any of them could fail on its own, so a parcel could be marked Delivered
-- while its audit scan and its COD accounting never recorded. The rider was
-- told "Saved, but the audit scan did not record. Tell the office." -- which
-- is an honest message about a state that should not have been reachable.
--
-- After: one call, one transaction. Every AWB is validated FIRST; if any one
-- of them is not eligible, nothing at all is written and the rider is told
-- exactly which ones to fix. That is what "all succeed or all fail" has to
-- mean in the field -- a rider must never be left guessing which half landed.
--
-- Retry safety: a dropped response on a phone with bad signal is the normal
-- case, not the exception. The batch key makes a replay return the original
-- result instead of applying the batch twice.

create table if not exists public.rider_batches (
  batch_key  text primary key,
  rider_id   uuid not null references public.riders(id) on delete cascade,
  created_at timestamptz not null default now(),
  result     jsonb not null
);

create index if not exists idx_rider_batches_rider on public.rider_batches (rider_id, created_at desc);

alter table public.rider_batches enable row level security;

drop policy if exists rider_batches_own on public.rider_batches;
create policy rider_batches_own on public.rider_batches
  for select using (rider_id = public.my_rider_id() or public.is_admin());

create or replace function public.rider_batch_update_status(
  p_awbs         text[],
  p_to           text,
  p_reason       text    default '',
  p_batch_key    text    default null,
  p_delivery_loc jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rider   uuid;
  v_key     text := nullif(btrim(coalesce(p_batch_key, '')), '');
  v_result  jsonb;
  v_awb     text;
  v_clean   text;
  v_p       public.parcels;
  v_meta    jsonb;
  v_hist    jsonb;
  v_steps   jsonb;
  v_now     timestamptz := now();
  v_bad     jsonb := '[]'::jsonb;
  v_ids     uuid[] := '{}';
  v_moved   text[] := '{}';
  v_count   int := 0;
begin
  v_rider := public.my_rider_id();
  if v_rider is null then
    raise exception 'Not signed in as a rider.' using errcode = '42501';
  end if;

  if p_to is null or btrim(p_to) = '' then
    raise exception 'A status is required.';
  end if;

  if v_key is not null and (length(v_key) < 16 or length(v_key) > 200 or v_key ~ '[[:cntrl:]]') then
    raise exception 'Batch key is invalid.';
  end if;

  if p_awbs is null or array_length(p_awbs, 1) is null then
    raise exception 'No parcels were sent.';
  end if;

  if array_length(p_awbs, 1) > 200 then
    raise exception 'Too many parcels in one batch (limit 200).';
  end if;

  -- Replay of a batch this rider already ran: hand back exactly what it
  -- returned the first time. Never apply it again.
  if v_key is not null then
    select b.result into v_result
      from public.rider_batches b
     where b.batch_key = v_key and b.rider_id = v_rider;
    if found then
      return v_result;
    end if;
  end if;

  -- ---- PASS 1: validate everything, write nothing ----------------------
  -- FOR UPDATE here also holds the rows for the duration of the transaction,
  -- so nothing can move underneath us between validation and the writes.
  foreach v_awb in array p_awbs loop
    v_clean := upper(btrim(coalesce(v_awb, '')));
    if v_clean = '' then
      continue;
    end if;

    select * into v_p
      from public.parcels
     where upper(awb) = v_clean
     for update;

    if not found then
      v_bad := v_bad || jsonb_build_object('awb', v_clean, 'reason', 'not found');
    elsif v_p.rider_id is distinct from v_rider then
      v_bad := v_bad || jsonb_build_object('awb', v_clean, 'reason', 'not assigned to you');
    elsif v_p.status = p_to then
      -- Already in the target state. Not an error and not a second write:
      -- a rider re-scanning a parcel they already moved is normal.
      v_ids := v_ids || v_p.id;
    else
      v_ids := v_ids || v_p.id;
    end if;
  end loop;

  if jsonb_array_length(v_bad) > 0 then
    raise exception 'Some parcels could not be updated: %',
      (select string_agg(e->>'awb' || ' (' || (e->>'reason') || ')', ', ')
         from jsonb_array_elements(v_bad) e)
      using errcode = 'P0001';
  end if;

  -- ---- PASS 2: apply, all inside this one transaction -------------------
  foreach v_awb in array p_awbs loop
    v_clean := upper(btrim(coalesce(v_awb, '')));
    if v_clean = '' then continue; end if;

    select * into v_p from public.parcels where upper(awb) = v_clean;
    if v_p.status = p_to then
      continue;                                   -- already there, nothing to do
    end if;

    v_meta  := coalesce(v_p.meta, '{}'::jsonb);
    v_hist  := coalesce(v_meta->'processHistory', '[]'::jsonb);
    v_steps := coalesce(v_meta->'steps', '[]'::jsonb);

    v_hist := v_hist || jsonb_build_object(
      'at', to_char(v_now at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
      'by', 'Rider',
      'to', p_to
    );
    -- Keep the last 30 only. This array used to grow forever inside the row.
    if jsonb_array_length(v_hist) > 30 then
      v_hist := (
        select jsonb_agg(e)
          from (
            select e from jsonb_array_elements(v_hist) with ordinality t(e, i)
             order by i offset greatest(jsonb_array_length(v_hist) - 30, 0)
          ) s
      );
    end if;

    if not (v_steps @> to_jsonb(p_to)) then
      v_steps := v_steps || to_jsonb(p_to);
    end if;

    v_meta := v_meta
      || jsonb_build_object('processHistory', v_hist)
      || jsonb_build_object('steps', v_steps);

    if p_to = 'Parcel received at destination'
       and coalesce(v_meta->>'destinationArrivedAt', '') = '' then
      v_meta := v_meta || jsonb_build_object(
        'destinationArrivedAt',
        to_char(v_now at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'));
    end if;

    if p_to = 'Delivered' then
      v_meta := v_meta || jsonb_build_object(
        'deliveredBy',       v_rider,
        'cashReceived',      false,
        'cashDepositStatus', 'not_deposited');
      if p_delivery_loc is not null then
        v_meta := v_meta || jsonb_build_object('deliveryLocation', p_delivery_loc);
      end if;
    end if;

    -- enforce_parcel_status_transition, nv_stamp_status_since and
    -- nv_log_parcel_status all fire here, exactly as they did for the
    -- per-row UPDATE this replaces. Their rules are unchanged.
    update public.parcels
       set status     = p_to,
           exception  = case when p_to in ('Refused', 'Consignee not available')
                             then coalesce(p_reason, '') else '' end,
           meta       = v_meta,
           updated_at = v_now
     where id = v_p.id
       and rider_id = v_rider;

    insert into public.scans (parcel_id, rider_id, type, status, lat, lng, note)
    values (
      v_p.id, v_rider, 'status', p_to,
      nullif(p_delivery_loc->>'lat', '')::numeric,
      nullif(p_delivery_loc->>'lng', '')::numeric,
      coalesce(p_reason, '')
    );

    -- COD is recorded in the SAME transaction as the delivery that created
    -- it. Previously the delivery could commit and this could fail, which is
    -- how "Delivered, but COD accounting did not record" happened.
    if p_to = 'Delivered' and coalesce(v_p.cod_amount, 0) > 0 then
      insert into public.cod_ledger (parcel_id, client_id, rider_id, direction, amount, reference)
      select v_p.id, v_p.client_id, v_rider, 'in', v_p.cod_amount, v_p.awb
       where not exists (
         select 1 from public.cod_ledger l
          where l.parcel_id = v_p.id and l.direction = 'in'
       );
    end if;

    v_moved := v_moved || v_p.awb;
    v_count := v_count + 1;
  end loop;

  v_result := jsonb_build_object(
    'count', v_count,
    'moved', to_jsonb(v_moved),
    'status', p_to
  );

  if v_key is not null then
    insert into public.rider_batches (batch_key, rider_id, result)
    values (v_key, v_rider, v_result)
    on conflict (batch_key) do nothing;
  end if;

  return v_result;
end;
$function$;

revoke all on function public.rider_batch_update_status(text[], text, text, text, jsonb) from public, anon;
grant execute on function public.rider_batch_update_status(text[], text, text, text, jsonb) to authenticated, service_role;
