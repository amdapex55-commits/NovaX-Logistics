-- nv_edit_parcel_core — the edit path, callable by BOTH the portal (session)
-- and the Merchant API (api key), because the client id is a parameter rather
-- than something read from the JWT.
--
-- Why this exists: client_edit_new_booked_parcel resolves the merchant from
-- nv_ai_my_client(), so it raises "You are not signed in as a merchant" when
-- the Merchant API calls it. The API has a client id but no session.
--
-- Why the API cannot simply PATCH the parcels table instead: changing
-- cod_amount trips trg_nv_freeze_parcel_money unless the transaction sets
-- novax.parcel_edit, which only a function like this one can do.
--
-- client_edit_new_booked_parcel is rewritten to delegate here, so the guards,
-- the money-freeze handshake and the audit trail have exactly one definition.

create or replace function public.nv_edit_parcel_core(
  p_client_id    uuid,
  p_awb          text,
  p_consignee    text,
  p_phone        text,
  p_address      text,
  p_city         text,
  p_cod          numeric,
  p_weight       text,
  p_category     text,
  p_fragile      text,
  p_service      text,
  p_payment_mode text,
  p_allow_open   text,
  p_order_id     text,
  p_comments     text default null,
  p_actor        text default 'portal'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row  public.parcels%rowtype;
  v_meta jsonb;
  v_hist jsonb;
  v_len  int;
begin
  if p_client_id is null then
    raise exception 'You are not signed in as a merchant.' using errcode = '28000';
  end if;

  select * into v_row
    from public.parcels
   where awb = btrim(p_awb)
     and client_id = p_client_id
   for update;

  if not found then
    raise exception 'That parcel is not on your account.' using errcode = 'P0002';
  end if;

  if coalesce(v_row.status, '') <> 'New booked' then
    raise exception
      'This parcel is already "%", so it can no longer be edited. Open a support ticket and our team will change it for you.',
      v_row.status using errcode = 'P0001';
  end if;
  if v_row.invoice_id is not null then
    raise exception 'This parcel has already been invoiced, so it can no longer be edited.' using errcode = 'P0001';
  end if;
  if coalesce(v_row.rider_id::text, '') <> '' then
    raise exception 'A rider is already assigned to collect this parcel, so it can no longer be edited.' using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_consignee, '')) = '' then
    raise exception 'Consignee name cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_phone, '')) = '' then
    raise exception 'Consignee phone cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_address, '')) = '' then
    raise exception 'Delivery address cannot be empty.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_city, '')) = '' then
    raise exception 'Destination city cannot be empty.' using errcode = 'P0001';
  end if;
  if p_cod is null or p_cod < 0 then
    raise exception 'COD amount must be zero or more.' using errcode = 'P0001';
  end if;

  -- Prepaid is only ever a thing when nothing is being collected at the door.
  if p_cod > 0 and lower(btrim(coalesce(p_payment_mode, ''))) in ('prepaid','non cod','noncod','non-cod') then
    raise exception
      'A prepaid parcel cannot have a COD amount. Set cod to 0 for prepaid, or leave the payment mode as COD.'
      using errcode = 'P0001';
  end if;

  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  v_hist := coalesce(v_meta -> 'editHistory', '[]'::jsonb);
  v_hist := v_hist || jsonb_build_array(jsonb_build_object(
    'at',   to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'by',   coalesce(auth.uid()::text, p_actor),
    'via',  p_actor,
    'from', jsonb_build_object('consignee', v_row.consignee, 'phone', v_row.phone,
                               'address', v_row.address, 'city', v_row.city,
                               'cod', v_row.cod_amount, 'weight', v_meta ->> 'weight'),
    'to',   jsonb_build_object('consignee', btrim(p_consignee), 'phone', btrim(p_phone),
                               'address', btrim(p_address), 'city', btrim(p_city),
                               'cod', p_cod, 'weight', btrim(coalesce(p_weight, '')))
  ));
  v_len := jsonb_array_length(v_hist);
  if v_len > 20 then
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_hist
      from jsonb_array_elements(v_hist) with ordinality as t(e, i)
     where i > v_len - 20;
  end if;

  v_meta := v_meta || jsonb_build_object(
    'weight',       btrim(coalesce(p_weight, '')),
    'category',     btrim(coalesce(p_category, '')),
    'fragile',      case when btrim(coalesce(p_fragile, '')) = 'Yes' then 'Yes' else 'No' end,
    'service',      nullif(btrim(coalesce(p_service, '')), ''),
    'paymentMode',  case when p_cod > 0 then 'COD' else 'Non COD' end,
    'allowOpen',    case when btrim(coalesce(p_allow_open, '')) = 'Yes' then 'Yes' else 'No' end,
    'orderId',      btrim(coalesce(p_order_id, '')),
    'editHistory',  v_hist,
    'lastEditedAt', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI')
  );

  -- p_comments null means "not supplied, leave whatever is there".
  -- An empty string means "clear it", which is a thing a merchant may want.
  if p_comments is not null then
    v_meta := v_meta || jsonb_build_object('comments', btrim(p_comments));
  end if;

  perform set_config('novax.parcel_edit', '1', true);

  update public.parcels
     set consignee  = btrim(p_consignee),
         phone      = btrim(p_phone),
         address    = btrim(p_address),
         city       = btrim(p_city),
         cod_amount = p_cod,
         meta       = v_meta,
         updated_at = now()
   where id = v_row.id;
  -- fee is NOT in this list, and must never be added to it.

  return jsonb_build_object('ok', true, 'awb', v_row.awb);
end
$function$;

revoke all on function public.nv_edit_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.nv_edit_parcel_core(uuid,text,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text) to service_role;

-- The portal keeps its own entry point; it now delegates so there is one
-- implementation of the guards and the money-freeze handshake.
create or replace function public.client_edit_new_booked_parcel(
  p_awb text, p_consignee text, p_phone text, p_address text, p_city text,
  p_cod numeric, p_weight text, p_category text, p_fragile text, p_service text,
  p_payment_mode text, p_allow_open text, p_order_id text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_client uuid := public.nv_ai_my_client();
begin
  if v_client is null then
    raise exception 'You are not signed in as a merchant.' using errcode = '28000';
  end if;
  return public.nv_edit_parcel_core(
    v_client, p_awb, p_consignee, p_phone, p_address, p_city, p_cod, p_weight,
    p_category, p_fragile, p_service, p_payment_mode, p_allow_open, p_order_id,
    null, 'portal');
end
$function$;

-- nv_set_parcel_extras_core — attaches the two fields the booking core has no
-- parameter for (packing comments, allow-to-open) immediately after an API
-- booking. Deliberately tiny: it touches meta and nothing else, so it cannot
-- trip the money-freeze or contact-protection triggers, and it does not write
-- an editHistory entry — this is part of creating the parcel, not editing it.
create or replace function public.nv_set_parcel_extras_core(
  p_client_id  uuid,
  p_awb        text,
  p_comments   text default null,
  p_allow_open text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.parcels%rowtype; v_meta jsonb;
begin
  if p_client_id is null then
    raise exception 'Merchant not resolved.' using errcode = '28000';
  end if;
  select * into v_row from public.parcels
   where awb = btrim(p_awb) and client_id = p_client_id for update;
  if not found then
    raise exception 'That parcel is not on your account.' using errcode = 'P0002';
  end if;

  v_meta := coalesce(v_row.meta, '{}'::jsonb);
  if p_comments is not null then
    v_meta := v_meta || jsonb_build_object('comments', btrim(p_comments));
  end if;
  if p_allow_open is not null then
    v_meta := v_meta || jsonb_build_object(
      'allowOpen', case when btrim(p_allow_open) = 'Yes' then 'Yes' else 'No' end);
  end if;

  update public.parcels set meta = v_meta where id = v_row.id;
  return jsonb_build_object('ok', true, 'awb', v_row.awb);
end
$function$;

revoke all on function public.nv_set_parcel_extras_core(uuid,text,text,text) from public, anon;
grant execute on function public.nv_set_parcel_extras_core(uuid,text,text,text) to service_role;
