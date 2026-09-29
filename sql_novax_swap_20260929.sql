-- ═══ Nova Swap (29 Sep 2026) ═══════════════════════════════════════════════
-- An exchange in one visit: the rider delivers the replacement and brings the
-- old item back. Behind one swap code are two ordinary parcels:
--   out  merchant -> customer   (the replacement; normal booking, prepaid)
--   back customer -> merchant   (the old item; booked now, collected at the door)
-- Both are priced by the normal rate card, by destination, exactly as
-- client_book_parcel prices any parcel. Both are prepaid (no COD), so they are
-- charged on the next invoice like any prepaid parcel. The back leg is only
-- invoiced if it was actually collected: until then it sits at "New booked"
-- with no rider, and "New booked" is never invoice-eligible.
--
-- The back leg is never assigned as a pickup. It gets its rider at the door, in
-- rider_swap_complete, in the same transaction that delivers the replacement --
-- two separate taps could save one half and lose the other.

create sequence if not exists public.nv_swap_seq;

create table if not exists public.nv_swaps (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  client_id       uuid not null references public.clients(id) on delete cascade,
  idem_key        text,
  original_awb    text not null,
  out_parcel_id   uuid not null references public.parcels(id),
  back_parcel_id  uuid not null references public.parcels(id),
  out_awb         text not null,
  back_awb        text not null,
  sending         text not null default '',
  coming_back     text not null default '',
  customer_name   text not null default '',
  customer_phone  text not null default '',
  customer_city   text not null default '',
  fee_out         numeric not null default 0,
  fee_back        numeric not null default 0,
  status          text not null default 'Requested',
  note            text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, idem_key)
);
create index if not exists nv_swaps_client_idx on public.nv_swaps (client_id, created_at desc);
create index if not exists nv_swaps_original_idx on public.nv_swaps (client_id, original_awb);

alter table public.nv_swaps enable row level security;
drop policy if exists nv_swaps_client_read on public.nv_swaps;
create policy nv_swaps_client_read on public.nv_swaps for select to authenticated
  using (client_id = public.my_client_id() or public.is_admin());
revoke all on public.nv_swaps from anon, public;
revoke insert, update, delete on public.nv_swaps from authenticated;
grant select on public.nv_swaps to authenticated;

-- ---- the rider may take the back leg, and only from inside rider_swap_complete
CREATE OR REPLACE FUNCTION public.parcels_guard_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;

  new.awb := old.awb;
  new.client_id := old.client_id;
  /* Nova Swap: the back leg is assigned to the rider standing at the door,
     inside rider_swap_complete(), which sets this transaction-local flag. */
  if coalesce(current_setting('novax.swap_assign', true), '') <> '1' then
    new.rider_id := old.rider_id;
  end if;
  new.fee := old.fee;
  new.booked_at := old.booked_at;

  /* Consignee details and COD change in exactly one situation: the merchant
     correcting their own booking through nv_edit_parcel_core(), which re-checks
     ownership, status, invoicing and rider assignment and sets this
     transaction-local flag right before its UPDATE. nv_freeze_parcel_money
     still refuses COD once a parcel has moved. */
  if coalesce(current_setting('novax.parcel_edit', true), '') <> '1' then
    new.consignee := old.consignee;
    new.city := old.city;
    new.address := old.address;
    new.phone := old.phone;
    new.cod_amount := old.cod_amount;
    /* Payment mode decides whether the rider collects at the door. It is
       part of the booking, like cod_amount, and changes only through the
       same edit path. A direct meta write could flip a COD parcel to
       prepaid after booking, so the rider collects Rs 0 and invoicing then
       refuses the parcel as a COD/prepaid conflict. */
    if (new.meta ->> 'paymentMode') is distinct from (old.meta ->> 'paymentMode') then
      new.meta := case
        when old.meta ? 'paymentMode'
          then jsonb_set(coalesce(new.meta, '{}'::jsonb), '{paymentMode}', old.meta -> 'paymentMode')
        else coalesce(new.meta, '{}'::jsonb) - 'paymentMode'
      end;
    end if;
  end if;

  /* Settlement state. invoice_id decides whether a parcel can be invoiced
     again; a merchant clearing it made the same parcel invoiceable twice. */
  new.invoice_id := old.invoice_id;
  new.invoiced_at := old.invoiced_at;
  new.delivery_charge_posted_at := old.delivery_charge_posted_at;

  /* delivered_at is delivery evidence: it dates the delivery on the public
     tracking page and in delivery-time figures. A merchant session could
     write it onto a parcel that was never delivered (rehearsed 24 Sep:
     New booked parcel, delivered_at = now(), accepted). The only
     legitimate non-admin change is novax_stamp_delivered_at() stamping the
     first entry into Delivered, which runs before this trigger. */
  if new.delivered_at is distinct from old.delivered_at
     and not (old.delivered_at is null
              and new.status = 'Delivered'
              and old.status is distinct from 'Delivered')
     -- novax_stamp_delivered_at() clearing it as the parcel leaves Delivered
     and not (new.delivered_at is null
              and old.status = 'Delivered'
              and new.status is distinct from 'Delivered') then
    new.delivered_at := old.delivered_at;
  end if;

  /* Delivery evidence. "COD collected" in meta.steps makes a parcel
     invoiceable; cashReceived and deliveredBy are what the rider records at
     the door. Only the rider carrying the parcel may add them. */
  if not (old.rider_id is not null and old.rider_id = public.my_rider_id()) then
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
    new.meta := (coalesce(new.meta, '{}'::jsonb) - 'cashReceived' - 'deliveredBy')
                || jsonb_strip_nulls(jsonb_build_object(
                     'cashReceived', old.meta -> 'cashReceived',
                     'deliveredBy',  old.meta -> 'deliveredBy'));
  elsif coalesce(new.status, '') <> 'Delivered' then
    -- Even the carrying rider records cash only on a delivered parcel.
    if coalesce(new.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb
       and not coalesce(old.meta -> 'steps', '[]'::jsonb) @> '"COD collected"'::jsonb then
      new.meta := jsonb_set(coalesce(new.meta, '{}'::jsonb), '{steps}', coalesce(old.meta -> 'steps', '[]'::jsonb));
    end if;
  end if;

  return new;
end;
$function$;


-- ---- price, same arithmetic as client_book_parcel -------------------------
create or replace function public.nv_swap_fee(p_client uuid, p_city text, p_weight text)
returns numeric language plpgsql stable security definer set search_path to 'public' as $$
declare v_rate numeric; v_card jsonb; v_zone text; v_base numeric; v_addl numeric; v_kg numeric;
begin
  select c.rate, c.rate_card into v_rate, v_card from public.clients c where c.id = p_client;
  v_rate := coalesce(v_rate, 250);
  v_zone := case when lower(coalesce(p_city,'')) = 'karachi' then 'A' else 'B' end;
  if v_card is not null and jsonb_typeof(v_card -> v_zone) = 'object' then
    v_base := coalesce((v_card -> v_zone ->> 'overnight')::numeric, v_rate);
    v_addl := coalesce((v_card -> v_zone ->> 'additionalKg')::numeric, 85);
  elsif v_card is not null and (v_card ->> 'overnight') is not null then
    v_base := coalesce((v_card ->> 'overnight')::numeric, v_rate);
    v_addl := coalesce((v_card ->> 'additionalKg')::numeric, 85);
  else
    v_base := v_rate; v_addl := 85;
  end if;
  v_kg := public.nv_parse_weight_kg(p_weight);
  if v_kg <= 0 then v_kg := 0.8; end if;
  return v_base + ceil(greatest(0, least(v_kg, 5) - 1)) * v_addl;
end $$;

create or replace function public.client_swap_quote(p_original_awb text, p_weight text default '0.8 kg', p_back_weight text default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); o public.parcels; c public.clients; v_home text; f_out numeric; f_back numeric;
begin
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.'; end if;
  select * into o from public.parcels where client_id = v_client and upper(awb) = upper(btrim(coalesce(p_original_awb,'')));
  if o.id is null then raise exception 'That AWB is not on your account.'; end if;
  select * into c from public.clients where id = v_client;
  v_home := coalesce(nullif(btrim(c.meta->>'pickupCity'),''), 'Karachi');
  f_out  := public.nv_swap_fee(v_client, o.city, coalesce(nullif(btrim(p_weight),''),'0.8 kg'));
  f_back := public.nv_swap_fee(v_client, v_home, coalesce(nullif(btrim(p_back_weight),''), nullif(btrim(p_weight),''), '0.8 kg'));
  return jsonb_build_object('fee_out', f_out, 'fee_back', f_back, 'total', f_out + f_back,
    'customer', o.consignee, 'city', o.city, 'home_city', v_home, 'status', o.status);
end $$;

-- ---- create ----------------------------------------------------------------
create or replace function public.client_create_swap(
  p_original_awb text, p_sending text, p_returning text,
  p_weight text default '0.8 kg', p_back_weight text default null,
  p_note text default '', p_key text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_client uuid := public.my_client_id(); o public.parcels; c public.clients; s public.nv_swaps;
  v_home text; v_code text; v_out public.parcels; v_back public.parcels; v_key text; v_w text; v_bw text;
begin
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet. Refresh or sign in again.'; end if;
  v_key := nullif(left(btrim(coalesce(p_key,'')),200),'');
  if v_key is not null and v_key ~ '[[:cntrl:]]' then raise exception 'Request key is invalid.'; end if;
  perform pg_advisory_xact_lock(hashtext('nv_swap_' || v_client::text));
  if v_key is not null then
    select * into s from public.nv_swaps where client_id = v_client and idem_key = v_key;
    if s.id is not null then
      return jsonb_build_object('id',s.id,'code',s.code,'out_awb',s.out_awb,'back_awb',s.back_awb,
        'fee_out',s.fee_out,'fee_back',s.fee_back,'total',s.fee_out+s.fee_back,'replayed',true);
    end if;
  end if;

  if coalesce(btrim(p_sending),'') = '' then raise exception 'Say what you are sending to the customer.'; end if;
  if length(p_sending) > 140 or length(coalesce(p_returning,'')) > 140 then raise exception 'Keep each item description within 140 characters.'; end if;
  if length(coalesce(p_note,'')) > 180 then raise exception 'Keep the note within 180 characters.'; end if;

  select * into o from public.parcels where client_id = v_client and upper(awb) = upper(btrim(coalesce(p_original_awb,''))) for update;
  if o.id is null then raise exception 'That AWB is not on your account.'; end if;
  if o.status <> 'Delivered' then raise exception 'Nova Swap works on a delivered order. % is "%".', o.awb, o.status; end if;
  if coalesce(o.meta->>'swapLeg','') <> '' then raise exception '% is itself part of a Nova Swap. Pick the customer''s original order.', o.awb; end if;
  if coalesce(btrim(o.phone),'') = '' or coalesce(btrim(o.address),'') = '' then
    raise exception '% has no customer phone or address on record, so the rider cannot find them.', o.awb;
  end if;
  select * into s from public.nv_swaps where client_id = v_client and original_awb = o.awb and status not in ('Cancelled') limit 1;
  if s.id is not null then raise exception 'This order already has Nova Swap %.', s.code; end if;

  select * into c from public.clients where id = v_client;
  v_home := coalesce(nullif(btrim(c.meta->>'pickupCity'),''), 'Karachi');
  if coalesce(btrim(c.address),'') = '' or coalesce(btrim(c.phone),'') = '' then
    raise exception 'Add your pickup address and phone in Profile first, so the old item can be brought back to you.';
  end if;

  v_w  := coalesce(nullif(btrim(p_weight),''), '0.8 kg');
  v_bw := coalesce(nullif(btrim(p_back_weight),''), v_w);
  v_code := 'SW-' || lpad(nextval('public.nv_swap_seq')::text, 4, '0');

  v_out := public.client_book_parcel(o.consignee, o.phone, v_home, o.city, o.address, 0, v_w,
             'Nova Swap', btrim(p_sending), 'No', 'Non COD Prepaid', '', v_code, 'No');
  v_back := public.client_book_parcel(coalesce(nullif(btrim(c.name),''),'Merchant'), c.phone, o.city, v_home, c.address, 0, v_bw,
             'Nova Swap return', coalesce(nullif(btrim(p_returning),''),'Old item'), 'No', 'Non COD Prepaid', '', v_code, 'No');

  update public.parcels set meta = meta || jsonb_build_object(
      'swapId', v_code, 'swapLeg', 'out', 'swapPairAwb', v_back.awb, 'swapOriginalAwb', o.awb,
      'swapNote', coalesce(p_note,''), 'comments', 'NOVA SWAP: collect the old item (return AWB ' || v_back.awb || ')')
   where id = v_out.id;
  update public.parcels set meta = meta || jsonb_build_object(
      'swapId', v_code, 'swapLeg', 'back', 'swapPairAwb', v_out.awb, 'swapOriginalAwb', o.awb,
      'pickupContact', jsonb_build_object('name', o.consignee, 'phone', o.phone, 'address', o.address, 'city', o.city),
      'comments', 'NOVA SWAP RETURN: old item collected from ' || o.consignee || ' at the exchange')
   where id = v_back.id;

  insert into public.nv_swaps (code, client_id, idem_key, original_awb, out_parcel_id, back_parcel_id, out_awb, back_awb,
      sending, coming_back, customer_name, customer_phone, customer_city, fee_out, fee_back, note)
  values (v_code, v_client, v_key, o.awb, v_out.id, v_back.id, v_out.awb, v_back.awb,
      btrim(p_sending), coalesce(nullif(btrim(p_returning),''),'Old item'), o.consignee, o.phone, o.city,
      v_out.fee, v_back.fee, coalesce(p_note,''))
  returning * into s;

  return jsonb_build_object('id',s.id,'code',s.code,'out_awb',s.out_awb,'back_awb',s.back_awb,
    'fee_out',s.fee_out,'fee_back',s.fee_back,'total',s.fee_out+s.fee_back,'replayed',false);
end $$;

-- ---- cancel before the replacement is collected -----------------------------
create or replace function public.client_swap_cancel(p_code text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_client uuid := public.my_client_id(); s public.nv_swaps; o text; b text;
begin
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet.'; end if;
  select * into s from public.nv_swaps where client_id = v_client and code = upper(btrim(coalesce(p_code,''))) for update;
  if s.id is null then raise exception 'No Nova Swap with that code on your account.'; end if;
  if s.status = 'Cancelled' then return jsonb_build_object('code',s.code,'status','Cancelled'); end if;
  select status into o from public.parcels where id = s.out_parcel_id for update;
  select status into b from public.parcels where id = s.back_parcel_id for update;
  if o <> 'New booked' or b <> 'New booked' then
    raise exception 'The replacement has already been collected, so this swap can no longer be cancelled. Contact NovaX support.';
  end if;
  update public.parcels set status = 'Cancelled by client', updated_at = now() where id in (s.out_parcel_id, s.back_parcel_id);
  update public.nv_swaps set status = 'Cancelled', updated_at = now() where id = s.id;
  return jsonb_build_object('code',s.code,'status','Cancelled');
end $$;

-- ---- the doorstep: one action, both halves ---------------------------------
create or replace function public.rider_swap_complete(p_out_awb text, p_outcome text, p_reason text default '',
  p_key text default null, p_loc jsonb default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); res jsonb; o public.parcels; b public.parcels; s public.nv_swaps;
begin
  if p_key is null or length(p_key) < 16 or length(p_key) > 190 or p_key ~ '[[:cntrl:]]' then raise exception 'Swap reference is invalid.'; end if;
  if p_outcome not in ('exchanged','failed') then raise exception 'Unknown swap outcome.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select x.result into res from public.rider_batches x where x.batch_key = p_key and x.rider_id = r;
  if found then return res; end if;

  select * into o from public.parcels where upper(awb) = upper(btrim(coalesce(p_out_awb,''))) for update;
  if o.id is null or o.rider_id is distinct from r then raise exception '%: not assigned to you.', p_out_awb; end if;
  if coalesce(o.meta->>'swapLeg','') <> 'out' then raise exception '%: not a Nova Swap delivery.', o.awb; end if;
  select * into s from public.nv_swaps where out_parcel_id = o.id for update;
  if s.id is null then raise exception '%: swap record missing. Contact the office.', o.awb; end if;
  select * into b from public.parcels where id = s.back_parcel_id for update;
  if o.status <> 'Parcel out for delivery' then raise exception '%: take it out for delivery first (now "%").', o.awb, o.status; end if;

  if p_outcome = 'exchanged' then
    if b.status <> 'New booked' then raise exception 'Return AWB % is already "%". Contact the office.', b.awb, b.status; end if;
    perform set_config('novax.swap_assign', '1', true);
    update public.parcels set rider_id = r, updated_at = now() where id = b.id;
    perform set_config('novax.swap_assign', '', true);
    perform public.rider_batch_update_status(array[o.awb], 'Delivered', '', p_key || ':out', p_loc);
    perform public.rider_batch_update_status(array[b.awb], 'Collected by rider', 'Nova Swap: collected from the customer', p_key || ':back', null);
  else
    perform public.rider_batch_update_status(array[o.awb], 'Refused',
      coalesce(nullif(btrim(p_reason),''), 'Nova Swap: customer did not hand over the old item'), p_key || ':out', null);
  end if;

  res := jsonb_build_object('outcome', p_outcome, 'code', s.code, 'out_awb', o.awb, 'back_awb', b.awb,
                            'moved', to_jsonb(case when p_outcome='exchanged' then array[o.awb, b.awb] else array[o.awb] end));
  insert into public.rider_batches(batch_key, rider_id, result) values (p_key, r, res);
  return res;
end $$;

-- ---- keep the swap's own status in step with its two parcels ---------------
create or replace function public.nv_swap_sync()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare s public.nv_swaps; o text; b text; v text;
begin
  select * into s from public.nv_swaps where out_parcel_id = new.id or back_parcel_id = new.id;
  if s.id is null then return new; end if;
  select status into o from public.parcels where id = s.out_parcel_id;
  select status into b from public.parcels where id = s.back_parcel_id;
  /* The replacement is going back to the merchant: the back leg will never be
     collected, so close it -- uncollected, it is never invoiced. */
  if new.id = s.out_parcel_id and new.status in ('Ready for return','Return in transit','Return received at origin','Return out for delivery','Return to shipper')
     and b = 'New booked' then
    update public.parcels set status = 'Cancelled by client', exception = 'Nova Swap did not happen', updated_at = now()
     where id = s.back_parcel_id and status = 'New booked';
    b := 'Cancelled by client';
  end if;
  /* Cancelling either half from the ordinary parcel screen cancels the swap:
     a replacement with no return booked, or a return with nothing going out,
     is not an exchange. Only while both are still waiting for pickup. */
  if new.status = 'Cancelled by client' then
    if new.id = s.out_parcel_id and b = 'New booked' then
      update public.parcels set status = 'Cancelled by client', updated_at = now() where id = s.back_parcel_id and status = 'New booked';
      b := 'Cancelled by client';
    elsif new.id = s.back_parcel_id and o = 'New booked' then
      update public.parcels set status = 'Cancelled by client', updated_at = now() where id = s.out_parcel_id and status = 'New booked';
      o := 'Cancelled by client';
    end if;
  end if;
  v := case
    when o = 'Cancelled by client' then 'Cancelled'
    when b = 'Delivered' then 'Old item back'
    when o = 'Delivered' then 'Exchanged'
    when o in ('Refused','Consignee not available','Out of service area','Ready for return','Return in transit',
               'Return received at origin','Return out for delivery','Return to shipper') then 'Could not exchange'
    when o = 'New booked' then 'Requested'
    else 'On the way' end;
  if v is distinct from s.status then
    update public.nv_swaps set status = v, updated_at = now() where id = s.id;
  end if;
  return new;
end $$;

drop trigger if exists zz_nv_swap_sync on public.parcels;
create trigger zz_nv_swap_sync after update of status on public.parcels
  for each row when (old.status is distinct from new.status and new.meta ? 'swapId')
  execute function public.nv_swap_sync();

revoke all on function public.nv_swap_fee(uuid,text,text) from public, anon, authenticated;
revoke all on function public.client_swap_quote(text,text,text) from public, anon;
revoke all on function public.client_create_swap(text,text,text,text,text,text,text) from public, anon;
revoke all on function public.client_swap_cancel(text) from public, anon;
revoke all on function public.rider_swap_complete(text,text,text,text,jsonb) from public, anon;
revoke all on function public.nv_swap_sync() from public, anon, authenticated;
grant execute on function public.client_swap_quote(text,text,text) to authenticated;
grant execute on function public.client_create_swap(text,text,text,text,text,text,text) to authenticated;
grant execute on function public.client_swap_cancel(text) to authenticated;
grant execute on function public.rider_swap_complete(text,text,text,text,jsonb) to authenticated;
