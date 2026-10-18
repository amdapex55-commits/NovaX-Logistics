-- Buy flyers audit (18 Oct 2026): the order screen says where the flyers
-- will be brought before the merchant orders. Same choice as
-- client_flyer_order: default pickup point, else the account address.
create or replace function public.client_flyer_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); v_seat text := public.nv_flyer_seat(); cl public.clients; v_addr text; v_city text;
begin
  if v_client is null then raise exception 'Sign in to buy flyers.' using errcode = '42501'; end if;
  select * into cl from public.clients where id = v_client;
  select l.address, l.city into v_addr, v_city from public.client_pickup_locations l
   where l.client_id = v_client order by l.is_default desc, l.created_at limit 1;
  v_addr := coalesce(nullif(btrim(v_addr), ''), cl.address); v_city := coalesce(nullif(btrim(v_city), ''), cl.meta->>'pickupCity', cl.city);
  return jsonb_build_object(
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'label', s.label, 'price', s.price) order by s.sort), '[]'::jsonb)
                from public.nv_flyer_sizes s where s.active),
    'pack', 100,
    'can_order', v_seat in ('owner', 'finance', 'warehouse'),
    'can_use_wallet', v_seat in ('owner', 'finance'),
    'wallet', case when v_seat in ('owner', 'finance') then coalesce(cl.wallet_balance, 0) end,
    'deliver_to', jsonb_build_object('address', nullif(btrim(coalesce(v_addr, '')), ''), 'city', nullif(btrim(coalesce(v_city, '')), '')));
end $$;
revoke all on function public.client_flyer_catalog() from public, anon;
grant execute on function public.client_flyer_catalog() to authenticated;
