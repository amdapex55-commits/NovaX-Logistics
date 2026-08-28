-- ===========================================================================
-- NovaX Merchant API — one key, one base URL, everything a shipper needs.
--
-- WHY THIS REPLACES THE OLD INTAKE
--   The previous integration asked a merchant for three things before they
--   could send a single order: a status-update URL (before they had anything
--   to receive), a token buried in the URL path, and -- because
--   web-order-intake ships with verify_jwt on -- a second Supabase key in a
--   header. Two credentials and a chicken-and-egg step to book one parcel.
--
--   This is one key in one header. The webhook is optional and set later.
--
-- SECURITY
--   Keys are stored as SHA-256 hashes, never in plaintext: a database dump
--   cannot be replayed against the API. The plaintext is returned exactly
--   once, at creation. Every table here is RLS-on with no permissive policy,
--   so anon and authenticated cannot read it; the edge function reaches it
--   with the service role, and the merchant sees only what the API returns.
-- ===========================================================================

create table if not exists public.nv_api_key (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  key_hash     text not null unique,          -- sha256 of the plaintext key
  key_prefix   text not null,                 -- first 12 chars, for display
  label        text not null default 'Website integration',
  webhook_url  text,                          -- optional; where we POST status
  webhook_secret text,                        -- HMAC secret for that POST
  revoked      boolean not null default false,
  last_used_at timestamptz,
  request_count bigint not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists nv_api_key_client_idx on public.nv_api_key(client_id);
alter table public.nv_api_key enable row level security;

-- Delivery log for outbound status webhooks, so "we sent it" is checkable.
create table if not exists public.nv_api_webhook_log (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  awb         text,
  event       text,
  status_code int,
  ok          boolean,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists nv_api_webhook_log_client_idx
  on public.nv_api_webhook_log(client_id, created_at desc);
alter table public.nv_api_webhook_log enable row level security;

-- ---------------------------------------------------------------- issue -----
-- Admin issues a key for a merchant. Returns the plaintext ONCE.
create or replace function public.admin_api_key_issue(p_client_id uuid, p_label text default 'Website integration')
returns table(api_key text, key_prefix text, client_name text)
language plpgsql security definer set search_path to 'public' as $$
declare v_raw text; v_prefix text; v_name text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'That client does not exist.';
  end if;
  -- nvx_live_ + 40 hex. Prefixed so a leaked key is greppable and obviously ours.
  v_raw    := 'nvx_live_' || encode(extensions.gen_random_bytes(20), 'hex');
  v_prefix := left(v_raw, 12);
  insert into public.nv_api_key (client_id, key_hash, key_prefix, label)
  values (p_client_id, encode(extensions.digest(v_raw, 'sha256'), 'hex'), v_prefix, coalesce(nullif(btrim(p_label),''),'Website integration'));
  select name into v_name from public.clients where id = p_client_id;
  api_key := v_raw; key_prefix := v_prefix; client_name := v_name;
  return next;
end $$;

-- --------------------------------------------------------------- resolve ----
-- The edge function calls this with the key it was handed. Returns the client
-- or nothing. Counts the call so usage is visible without a separate log.
create or replace function public.nv_api_resolve_key(p_key text)
returns table(client_id uuid, client_name text, webhook_url text, key_id uuid)
language plpgsql security definer set search_path to 'public' as $$
declare v_hash text; v_row public.nv_api_key;
begin
  v_hash := encode(extensions.digest(coalesce(p_key,''), 'sha256'), 'hex');
  select * into v_row from public.nv_api_key where key_hash = v_hash and not revoked;
  if v_row.id is null then return; end if;
  update public.nv_api_key
     set last_used_at = now(), request_count = request_count + 1
   where id = v_row.id;
  client_id := v_row.client_id;
  select name into client_name from public.clients where id = v_row.client_id;
  webhook_url := v_row.webhook_url;
  key_id := v_row.id;
  return next;
end $$;

-- --------------------------------------------------------------- webhook ----
create or replace function public.nv_api_set_webhook(p_key_id uuid, p_url text)
returns boolean
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_url is not null and p_url <> '' and p_url !~ '^https://' then
    raise exception 'Webhook URL must start with https://';
  end if;
  update public.nv_api_key
     set webhook_url = nullif(btrim(p_url), ''),
         webhook_secret = coalesce(webhook_secret, encode(extensions.gen_random_bytes(24),'hex'))
   where id = p_key_id and not revoked;
  return found;
end $$;

revoke all on function public.admin_api_key_issue(uuid,text) from public, anon;
grant execute on function public.admin_api_key_issue(uuid,text) to authenticated;
revoke all on function public.nv_api_resolve_key(text) from public, anon, authenticated;
revoke all on function public.nv_api_set_webhook(uuid,text) from public, anon, authenticated;
