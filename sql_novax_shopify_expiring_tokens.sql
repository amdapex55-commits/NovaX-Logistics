-- Public Shopify apps cannot call the Admin API with non-expiring offline tokens.
alter table public.nvsh_shop
  add column if not exists refresh_token text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists refresh_lease_until timestamptz;

create or replace function public.nvsh_claim_token_refresh(p_shop text, p_refresh_token text)
returns boolean language sql security definer set search_path = public as $$
  with claimed as (
    update public.nvsh_shop
       set refresh_lease_until = now() + interval '30 seconds'
     where shop_domain = p_shop
       and refresh_token = p_refresh_token
       and status in ('active', 'pending_link')
       and (refresh_lease_until is null or refresh_lease_until < now())
    returning 1
  ) select exists(select 1 from claimed);
$$;

revoke all on function public.nvsh_claim_token_refresh(text, text) from public, anon, authenticated;
grant execute on function public.nvsh_claim_token_refresh(text, text) to service_role;
