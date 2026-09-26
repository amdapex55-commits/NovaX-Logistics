-- ---------------------------------------------------------------------------
-- A01 -- PUBLIC could execute the Shopify RPCs. Confirmed exploitable live on
-- 26 Sep 2026 with nothing but the anon key, which is published inside
-- client.html on novaxlogistics.com:
--
--   POST /rest/v1/rpc/nvsh_admin_link {"p_shop":"<any installed store>",
--                                      "p_client_id":"<any client uuid>"}
--   -> 0   (succeeded: the store is now bound to that client)
--
-- That is a store takeover: every order from a victim's Shopify store would
-- book onto the attacker's NovaX account. nvsh_wallet_summary, nvsh_shop_state
-- and nvsh_recent_orders were readable the same way for any shop domain.
--
-- Cause: the migrations wrote `revoke all ... from public, anon, authenticated`
-- for the functions added later, but the four oldest ones were never revoked,
-- and PostgreSQL grants EXECUTE to PUBLIC by default. anon inherits PUBLIC, and
-- PostgREST exposes every function in the public schema.
--
-- Two layers, because one is not enough: take the grant away, AND make
-- nvsh_admin_link refuse a caller who is not an admin even if it is reachable.
-- ---------------------------------------------------------------------------

begin;

revoke execute on function public.nvsh_admin_link(text,uuid)       from public, anon, authenticated;
revoke execute on function public.nvsh_admin_pending()             from public, anon, authenticated;
revoke execute on function public.nvsh_gc()                        from public, anon, authenticated;
revoke execute on function public.nvsh_wallet_summary(text)        from public, anon, authenticated;
revoke execute on function public.nvsh_shop_state(text)            from public, anon, authenticated;
revoke execute on function public.nvsh_recent_orders(text,integer) from public, anon, authenticated;

-- These two are called by the merchant's own portal session and must stay.
-- Both derive the client from my_client_id(); neither takes someone else's id.
grant execute on function public.nvsh_link_code_issue() to authenticated;
grant execute on function public.nvsh_my_stores()       to authenticated;

-- Defence in depth: an admin check inside the function, so a future migration
-- that re-grants by accident does not hand the store-rebinding back out.
create or replace function public.nvsh_admin_link(p_shop text, p_client_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_released integer;
begin
  -- auth.uid() is null for the service role and for cron, which is how the
  -- edge function and internal jobs still reach this.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only a NovaX admin can link a store to a merchant.';
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'no such client: %', p_client_id;
  end if;

  update public.nvsh_shop
     set client_id = p_client_id, status = 'active',
         linked_at = now(), updated_at = now()
   where shop_domain = p_shop;
  if not found then
    raise exception 'no such shop: %', p_shop;
  end if;

  update public.nvsh_order
     set status = 'received', client_id = p_client_id, updated_at = now()
   where shop_domain = p_shop and status = 'pending_link';
  get diagnostics v_released = row_count;
  return v_released;
end;
$function$;

revoke all on function public.nvsh_admin_link(text,uuid) from public, anon, authenticated;

commit;

select p.proname, coalesce(array_to_string(p.proacl,' | '),'<DEFAULT PUBLIC>') as acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'nvsh%' order by 1;
