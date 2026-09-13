-- NovaX, 13 Sep 2026: the landing-page agent talks to prospects who have no
-- account, so a conversation can legitimately have no client_id. Merchants
-- still cannot see those rows: nvai_conv_own is (client_id = nv_ai_my_client()),
-- and NULL = <uuid> is NULL, i.e. false. Admin's policy is is_admin(), so the
-- existing conversation log picks them up with no new RPC.
--
-- Rehearsed inline against production first (not by wrapping this file --
-- a file carrying its own BEGIN/COMMIT cannot be wrapped).
begin;

alter table public.nv_ai_conversations alter column client_id drop not null;
alter table public.nv_ai_messages      alter column client_id drop not null;

comment on column public.nv_ai_conversations.client_id is
  'NULL = website visitor via novax-site-agent. Merchant threads always carry a client_id.';
comment on column public.nv_ai_messages.client_id is
  'NULL = website visitor via novax-site-agent.';

commit;
