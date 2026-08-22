-- =====================================================================
-- NovaX AI v3 — public tracking lookups + human-confirmed write actions
-- Run after sql_novax_ai_core.sql and sql_novax_ai_tools_v2.sql.
-- =====================================================================

---- PART 1: public, token-scoped parcel lookup ----------------------
-- For the consignee on tracking.html. NOT client-scoped -- scoped by the
-- tracking token itself, which only the person holding the link has.
-- Deliberately narrow: the consignee sees where their parcel is and what
-- they owe. They do NOT see the merchant's phone, the delivery fee, or
-- internal exception notes.
-- SECURITY: the lookup below matches on the tracking token ONLY.
--
-- It used to also accept a bare AWB:  or upper(p.awb) = upper(tok)
--
-- That defeated the entire point of an unguessable token. This function is
-- granted to anon and returns consignee name, COD amount and merchant name,
-- and NovaX AWBs are sequential -- 'N' + a 3-digit client code + a 4-digit
-- counter, so roughly a 10 million keyspace that a script can walk in an
-- afternoon. Anyone could therefore harvest the consignee and COD of every
-- parcel in the system without logging in.
--
-- Real tracking links always carry the token, so nothing legitimate breaks.
-- What stops working is bare-AWB lookup, which is exactly the hole.
create or replace function public.ai_public_parcel(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare r jsonb; tok text;
begin
  tok := btrim(coalesce(p_token,''));
  if tok = '' then return jsonb_build_object('error','no_token'); end if;

  select jsonb_build_object(
           'awb', p.awb,
           'status', p.status,
           'city', p.city,
           'consignee', p.consignee,
           'cod_amount', coalesce(p.cod_amount,0),
           'booked_at', p.booked_at,
           'last_update', p.updated_at,
           'hours_since_update',
             round(extract(epoch from (now() - p.updated_at)) / 3600.0, 1),
           'merchant', c.name)
    into r
    from public.parcels p
    left join public.clients c on c.id = p.client_id
   where p.meta->>'trackingToken' = tok
   limit 1;

  if r is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'parcel', r);
end
$fn$;

---- PART 2: write actions -------------------------------------------
-- These are the ONLY functions in NovaX AI that write. The model never
-- calls them: it proposes an action, the merchant presses a confirm
-- button, and the browser calls these directly. That keeps a human
-- between the model and any change to a live parcel.

-- Fill in a missing delivery address / phone. Fills blanks only -- it
-- can never overwrite an address that is already there, which is the
-- failure that blanked 298 parcels earlier.
create or replace function public.ai_action_fix_address(
  p_awb text, p_address text default null, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid; cur record; new_addr text; new_phone text;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;

  select awb, address, phone into cur from public.parcels
   where client_id = c and upper(awb) = upper(btrim(coalesce(p_awb,'')))
   for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_your_parcel'); end if;

  new_addr  := nullif(btrim(coalesce(p_address,'')),'');
  new_phone := nullif(btrim(coalesce(p_phone,'')),'');

  update public.parcels
     set address = case when coalesce(btrim(address),'') = '' and new_addr is not null
                        then new_addr else address end,
         phone   = case when coalesce(btrim(phone),'') = '' and new_phone is not null
                        then new_phone else phone end,
         updated_at = now()
   where client_id = c and upper(awb) = upper(btrim(p_awb));

  return jsonb_build_object('ok',true,'awb',cur.awb,
    'address_written', coalesce(btrim(cur.address),'') = '' and new_addr is not null,
    'phone_written',   coalesce(btrim(cur.phone),'')   = '' and new_phone is not null);
end
$fn$;

-- Ask operations to reattempt a delivery. Files a ticket rather than
-- touching parcel status directly -- rescheduling is a rider decision,
-- not something a merchant or a model should set unilaterally.
create or replace function public.ai_action_request_reattempt(
  p_awb text, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
declare res jsonb; a text;
begin
  a := upper(btrim(coalesce(p_awb,'')));
  if a = '' then return jsonb_build_object('ok',false,'reason','no_awb'); end if;
  select to_jsonb(public.novax_ticket_open(
    p_subject := 'Reattempt requested - ' || a,
    p_body    := coalesce(nullif(btrim(p_note),''),
                          'Merchant requested a delivery reattempt via NovaX AI.'),
    p_awb     := a,
    p_priority:= 'High')) into res;
  return jsonb_build_object('ok',true,'ticket',res);
end
$fn$;

grant execute on function public.ai_public_parcel(text)                        to anon, authenticated;
grant execute on function public.ai_action_fix_address(text, text, text)       to authenticated;
grant execute on function public.ai_action_request_reattempt(text, text)       to authenticated;
