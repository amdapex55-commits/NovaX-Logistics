-- NovaX Sales hardening (2 Oct 2026). Fixes from the sales-channel audit:
--  * one phone number = one lead = at most one rep (sheet duplicates, ref/phone
--    clashes, rep phones unique);
--  * reward terms frozen per store when it is credited; first-pickup reward
--    follows the first picked parcel only; removed reps stop earning 30 days
--    after the end date; moving a store moves its unpaid rewards;
--  * Paid only after Approved, to a recorded payout account, with who did it;
--  * rejected claims keep a reason and can be sent again;
--  * admin search no longer matches everything;
--  * Google Sheet: a bad link never replaces a working one, no 2,000-row stop,
--    headings matched by name only (no silent column guessing), cron failures
--    visible; the retired Apps Script key sync is removed.

begin;

-- ── columns ──────────────────────────────────────────────────────────────
alter table public.sales_rewards
  add column if not exists approved_by uuid,
  add column if not exists paid_by uuid,
  add column if not exists paid_to text,
  add column if not exists rejected_by uuid,
  add column if not exists rejected_at timestamptz;

alter table public.sales_reps
  add column if not exists payout_method text check (payout_method is null or payout_method in ('Bank', 'JazzCash', 'Easypaisa')),
  add column if not exists payout_title text,
  add column if not exists payout_account text,
  add column if not exists payout_updated_at timestamptz;
create unique index if not exists sales_reps_phone_key on public.sales_reps(phone) where phone is not null;

alter table public.sales_attributions add column if not exists terms jsonb;

-- The reward terms in force right now; frozen onto a store when it is credited.
create or replace function public.sales_terms_now()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_opened', public.sales_setting_int('reward_account_opened'),
    'first_pickup', public.sales_setting_int('reward_first_pickup'), 'pickup_hold_days', public.sales_setting_int('pickup_hold_days'));
$$;
update public.sales_attributions set terms = public.sales_terms_now() where terms is null;

-- ── payout account ───────────────────────────────────────────────────────
create or replace function public.sales_iban_ok(p text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s text := upper(regexp_replace(coalesce(p, ''), '\s', '', 'g')); r text; d text; c text; m int := 0; i int; j int;
begin
  if s !~ '^PK[0-9]{2}[A-Z]{4}[0-9]{16}$' then return false; end if;
  r := substr(s, 5) || substr(s, 1, 4);
  for i in 1 .. length(r) loop
    c := substr(r, i, 1);
    d := case when c ~ '[A-Z]' then (ascii(c) - 55)::text else c end;
    for j in 1 .. length(d) loop m := (m * 10 + substr(d, j, 1)::int) % 97; end loop;
  end loop;
  return m = 1;
end $$;

create or replace function public.sales_set_payout(p_method text, p_title text, p_account text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_current_rep();
  v_title text := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_acc text;
begin
  if v_rep is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  if p_method not in ('Bank', 'JazzCash', 'Easypaisa') then raise exception 'Choose Bank, JazzCash or Easypaisa.' using errcode = '22023'; end if;
  if char_length(v_title) not between 3 and 80 or v_title !~ '^[A-Za-z][A-Za-z .''-]*$' then
    raise exception 'Enter the account title exactly as the bank or wallet shows it, in English letters.' using errcode = '22023'; end if;
  if p_method = 'Bank' then
    v_acc := upper(regexp_replace(coalesce(p_account, ''), '\s', '', 'g'));
    if not public.sales_iban_ok(v_acc) then
      raise exception 'Enter your 24-character IBAN, like PK36SCBL0000001123456702. It is on your cheque book or banking app.' using errcode = '22023'; end if;
  else
    v_acc := public.sales_norm_phone(p_account);
    if coalesce(v_acc, '') !~ '^03[0-9]{9}$' then raise exception 'Enter the % mobile number, like 03001234567.', p_method using errcode = '22023'; end if;
  end if;
  update public.sales_reps set payout_method = p_method, payout_title = v_title, payout_account = v_acc, payout_updated_at = now() where id = v_rep;
  return public.sales_me();
end $$;

create or replace function public.sales_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'rep', (select jsonb_build_object('id', r.id, 'code', r.code, 'full_name', r.full_name, 'status', r.status, 'joined_on', r.joined_on,
              'phone', r.phone, 'cnic', r.cnic, 'address', r.address, 'emergency_name', r.emergency_name, 'emergency_phone', r.emergency_phone,
              'profile_done', r.profile_done_at is not null, 'signed_at', public.sales_docs_signed(r.id),
              'payout', case when r.payout_method is not null then jsonb_build_object('method', r.payout_method, 'title', r.payout_title,
                        'account', r.payout_account, 'updated_at', r.payout_updated_at) end)
            from public.sales_reps r where r.auth_user_id = auth.uid()),
    'docs_version', (select value from public.sales_settings where key = 'docs_version'),
    'rewards', jsonb_build_object('account_opened', public.sales_setting_int('reward_account_opened'),
      'first_pickup', public.sales_setting_int('reward_first_pickup'), 'pickup_hold_days', public.sales_setting_int('pickup_hold_days'),
      'lead_window_days', public.sales_setting_int('lead_window_days'), 'lead_untouched_days', public.sales_setting_int('lead_untouched_days')),
    'email', (select u.email from auth.users u where u.id = auth.uid()));
$$;

-- ── one phone, one rep ───────────────────────────────────────────────────
create or replace function public.sales_admin_invite(p_name text, p_email text, p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := nullif(public.sales_norm_phone(p_phone), ''); v_id uuid;
begin
  perform public.sales_require_admin();
  if char_length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Enter the rep''s full name.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email for the rep.' using errcode = '22023'; end if;
  if v_code !~ '^[A-Z0-9]{3,12}$' then raise exception 'The rep code must be 3 to 12 letters or numbers, like AYESHA or SALES01.' using errcode = '22023'; end if;
  if v_phone is not null and v_phone !~ '^03[0-9]{9}$' then raise exception 'Enter the rep''s mobile like 03001234567, or leave it empty.' using errcode = '22023'; end if;
  if exists (select 1 from public.sales_reps where code = v_code) then raise exception 'That code is already taken.' using errcode = '23505'; end if;
  if exists (select 1 from public.sales_reps where email = v_email) then raise exception 'That email already has a rep.' using errcode = '23505'; end if;
  if v_phone is not null and exists (select 1 from public.sales_reps where phone = v_phone) then raise exception 'That mobile number already belongs to another rep.' using errcode = '23505'; end if;
  insert into public.sales_reps(code, full_name, email, phone) values (v_code, btrim(p_name), v_email, v_phone) returning id into v_id;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

create or replace function public.sales_save_profile(p_name text, p_phone text, p_cnic text, p_address text, p_em_name text, p_em_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_current_rep();
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_phone text := public.sales_norm_phone(p_phone);
  v_cnic text := regexp_replace(coalesce(p_cnic, ''), '[^0-9]', '', 'g');
  v_addr text := regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g');
  v_em_name text := regexp_replace(btrim(coalesce(p_em_name, '')), '\s+', ' ', 'g');
  v_em_phone text := public.sales_norm_phone(p_em_phone);
begin
  if v_rep is null then raise exception 'This page is for NovaX sales reps. Ask NovaX to add you.' using errcode = '42501'; end if;
  if public.sales_docs_signed(v_rep) is not null then
    raise exception 'Your documents are signed, so these details are locked. Ask NovaX to correct them.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 3 and 80 or v_name !~ '^[A-Za-z][A-Za-z .''-]*$' then
    raise exception 'Enter your full name as on your CNIC, in English letters.' using errcode = '22023'; end if;
  if coalesce(v_phone, '') !~ '^03[0-9]{9}$' then raise exception 'Enter your mobile number like 03001234567.' using errcode = '22023'; end if;
  if exists (select 1 from public.sales_reps r where r.phone = v_phone and r.id <> v_rep) then
    raise exception 'This mobile number is already registered with another NovaX rep.' using errcode = '23505'; end if;
  if v_cnic !~ '^[0-9]{13}$' then raise exception 'Enter your 13-digit CNIC number.' using errcode = '22023'; end if;
  if exists (select 1 from public.sales_reps r where r.cnic = v_cnic and r.id <> v_rep) then
    raise exception 'This CNIC is already registered with another NovaX rep.' using errcode = '23505'; end if;
  if char_length(v_addr) < 10 then raise exception 'Enter your full home address (house, street, area, city).' using errcode = '22023'; end if;
  if char_length(v_addr) > 300 then raise exception 'Keep the address under 300 characters.' using errcode = '22023'; end if;
  if char_length(v_em_name) not between 2 and 80 then raise exception 'Enter your emergency contact''s name.' using errcode = '22023'; end if;
  if coalesce(v_em_phone, '') !~ '^03[0-9]{9}$' then raise exception 'Enter your emergency contact''s mobile like 03001234567.' using errcode = '22023'; end if;
  if v_em_phone = v_phone then raise exception 'The emergency number must be someone else''s, not your own.' using errcode = '22023'; end if;
  update public.sales_reps set full_name = v_name, phone = v_phone, cnic = v_cnic, address = v_addr,
         emergency_name = v_em_name, emergency_phone = v_em_phone, profile_done_at = now()
   where id = v_rep;
  update public.profiles set full_name = v_name where id = auth.uid();
  return public.sales_me();
end $$;

-- A phone belongs to one lead. A row whose Lead ID differs from the lead that
-- already owns its phone is skipped (it would otherwise flip that lead, and
-- its rep, between two sheet rows on every import).
create or replace function public.sales_upsert_leads(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; v_phone text; v_ref text; v_name text; v_rep uuid; v_code text; v_existing public.sales_prospects;
  v_ins int := 0; v_upd int := 0; v_skip jsonb := '[]'::jsonb; v_i int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Expected a list of rows.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Send at most 2,000 rows at a time.' using errcode = '22023'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_phone := public.sales_norm_phone(r->>'phone');
    v_ref := nullif(left(btrim(coalesce(r->>'lead_ref', '')), 60), '');
    v_name := nullif(left(btrim(coalesce(r->>'store_name', '')), 120), '');
    v_code := upper(btrim(coalesce(r->>'assign_to', '')));
    if v_name is null then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Store name is empty'); continue; end if;
    if coalesce(v_phone, '') !~ '^03[0-9]{9}$' then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Phone is not a Pakistani mobile number'); continue; end if;
    v_rep := null;
    if v_code <> '' then
      v_rep := (select id from public.sales_reps where code = v_code and status <> 'Removed');
      if v_rep is null then v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'No active rep with code ' || v_code); continue; end if;
    end if;
    v_existing := null;
    select * into v_existing from public.sales_prospects p
     where (v_ref is not null and p.lead_ref = v_ref) or p.phone = v_phone
     order by (p.lead_ref = v_ref) desc nulls last limit 1;
    if v_existing.id is not null and v_ref is not null and v_existing.lead_ref is not null and v_existing.lead_ref <> v_ref
       and v_existing.phone = v_phone and v_existing.lead_ref !~ '^S03[0-9]{9}$' then
      v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'This phone already belongs to lead ' || v_existing.lead_ref);
      continue;
    end if;
    if v_existing.id is null then
      insert into public.sales_prospects(lead_ref, store_name, contact_name, phone, city, category, source, store_link, est_orders, rep_id, assigned_at)
      values (v_ref, v_name, nullif(left(btrim(coalesce(r->>'contact_name', '')), 80), ''), v_phone,
              nullif(left(btrim(coalesce(r->>'city', '')), 40), ''), nullif(left(btrim(coalesce(r->>'category', '')), 60), ''),
              nullif(left(btrim(coalesce(r->>'source', '')), 40), ''), nullif(left(btrim(coalesce(r->>'store_link', '')), 300), ''),
              nullif(left(btrim(coalesce(r->>'est_orders', '')), 30), ''), v_rep, case when v_rep is not null then now() end);
      v_ins := v_ins + 1;
    else
      if v_existing.phone <> v_phone and exists (select 1 from public.sales_prospects where phone = v_phone) then
        v_skip := v_skip || jsonb_build_object('row', v_i, 'lead_ref', v_ref, 'reason', 'Another lead already has this phone'); continue;
      end if;
      update public.sales_prospects set
        lead_ref = coalesce(v_ref, lead_ref), store_name = v_name, phone = v_phone,
        contact_name = coalesce(nullif(left(btrim(coalesce(r->>'contact_name', '')), 80), ''), contact_name),
        city = coalesce(nullif(left(btrim(coalesce(r->>'city', '')), 40), ''), city),
        category = coalesce(nullif(left(btrim(coalesce(r->>'category', '')), 60), ''), category),
        source = coalesce(nullif(left(btrim(coalesce(r->>'source', '')), 40), ''), source),
        store_link = coalesce(nullif(left(btrim(coalesce(r->>'store_link', '')), 300), ''), store_link),
        est_orders = coalesce(nullif(left(btrim(coalesce(r->>'est_orders', '')), 30), ''), est_orders),
        rep_id = case when v_rep is not null and status <> 'Signed up' then v_rep else rep_id end,
        assigned_at = case when v_rep is not null and status <> 'Signed up' and rep_id is distinct from v_rep then now() else assigned_at end,
        updated_at = now()
      where id = v_existing.id;
      v_upd := v_upd + 1;
    end if;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip);
end $$;

-- ── admin lead search: words match words, digits match phones ────────────
create or replace function public.sales_admin_leads(p_rep uuid default null, p_status text default null, p_search text default null, p_pool boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_d text := regexp_replace(coalesce(p_search, ''), '\D', '', 'g');
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'lead_ref', p.lead_ref, 'store_name', p.store_name, 'contact_name', p.contact_name, 'phone', p.phone,
      'city', p.city, 'category', p.category, 'source', p.source, 'status', p.status, 'call_count', p.call_count,
      'last_called_at', p.last_called_at, 'next_followup_on', p.next_followup_on, 'last_note', p.last_note,
      'rep_code', r.code, 'assigned_at', p.assigned_at, 'signed_up_at', p.signed_up_at)
    order by p.updated_at desc), '[]'::jsonb)
  from (select * from public.sales_prospects p
        where (p_rep is null or p.rep_id = p_rep)
          and (not p_pool or p.rep_id is null)
          and (p_status is null or p.status = p_status)
          and (v_q is null
               or p.store_name ilike '%' || v_q || '%' or p.lead_ref ilike '%' || v_q || '%'
               or p.city ilike '%' || v_q || '%' or p.contact_name ilike '%' || v_q || '%'
               or (char_length(v_d) >= 3 and p.phone like '%' || v_d || '%'))
        order by p.updated_at desc limit 500) p
  left join public.sales_reps r on r.id = p.rep_id);
end $$;

-- ── moving a store moves its unpaid rewards ──────────────────────────────
create or replace function public.sales_move_rewards(p_client uuid, p_rep uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.sales_rewards set rep_id = p_rep,
         status = case when status = 'Approved' then 'Earned'
                       when status = 'Rejected' then 'Waiting' else status end,
         approved_at = case when status = 'Approved' then null else approved_at end,
         approved_by = case when status = 'Approved' then null else approved_by end,
         note = case when status = 'Rejected' then null else note end,
         rejected_at = case when status = 'Rejected' then null else rejected_at end,
         rejected_by = case when status = 'Rejected' then null else rejected_by end
   where client_id = p_client
     and (status in ('Waiting', 'Earned', 'Approved') or (status = 'Rejected' and note = 'Store credit changed by NovaX'));
end $$;

drop function if exists public.sales_admin_decide(uuid, text, uuid);
create or replace function public.sales_admin_decide(p_client uuid, p_status text, p_rep uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_cur public.sales_attributions; v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
begin
  perform public.sales_require_admin();
  if p_status not in ('Approved', 'Rejected') then raise exception 'Approve or reject.' using errcode = '22023'; end if;
  if p_status = 'Rejected' and char_length(coalesce(v_note, '')) < 3 then raise exception 'Say why, so the rep can see it.' using errcode = '22023'; end if;
  if p_rep is not null and not exists (select 1 from public.sales_reps where id = p_rep) then raise exception 'Unknown rep.' using errcode = '22023'; end if;
  select * into v_cur from public.sales_attributions where client_id = p_client for update;
  if v_cur.client_id is null then raise exception 'Nothing to decide for that store.' using errcode = '22023'; end if;
  update public.sales_attributions set status = p_status, rep_id = coalesce(p_rep, rep_id),
         note = case when p_status = 'Rejected' then v_note else note end,
         terms = coalesce(terms, public.sales_terms_now()), decided_at = now(), decided_by = auth.uid()
   where client_id = p_client;
  if p_status = 'Rejected' then
    update public.sales_rewards set status = 'Rejected', note = 'Store credit changed by NovaX', rejected_at = now(), rejected_by = auth.uid()
     where client_id = p_client and status in ('Waiting', 'Earned', 'Approved');
  else
    perform public.sales_move_rewards(p_client, coalesce(p_rep, v_cur.rep_id));
    perform public.sales_refresh();
  end if;
end $$;

create or replace function public.sales_admin_credit(p_client uuid, p_rep uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  if not exists (select 1 from public.sales_reps where id = p_rep) then raise exception 'Unknown rep.' using errcode = '22023'; end if;
  insert into public.sales_attributions(client_id, rep_id, method, status, decided_at, decided_by, terms)
  values (p_client, p_rep, 'admin', 'Approved', now(), auth.uid(), public.sales_terms_now())
  on conflict (client_id) do update set rep_id = excluded.rep_id, method = 'admin', status = 'Approved',
    decided_at = now(), decided_by = auth.uid(), terms = coalesce(public.sales_attributions.terms, excluded.terms);
  perform public.sales_move_rewards(p_client, p_rep);
  perform public.sales_refresh();
end $$;

-- ── claims: a rejected claim keeps its reason and can be sent again ──────
create or replace function public.sales_claim_store(p_phone text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rep uuid := public.sales_require_rep();
  v_phone text := public.sales_norm_phone(p_phone);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_client public.clients;
  v_cur public.sales_attributions;
begin
  if coalesce(v_phone, '') !~ '^03[0-9]{9}$' then raise exception 'Enter the store''s mobile number, like 0300 1234567.' using errcode = '22023'; end if;
  if (select count(*) from public.sales_attributions a where a.rep_id = v_rep and a.method = 'claim' and a.status = 'Pending') >= 20 then
    raise exception 'You have 20 claims waiting for NovaX. Wait for those to be checked.' using errcode = '54000';
  end if;
  select * into v_client from public.clients c
   where public.sales_norm_phone(c.phone) = v_phone and c.created_at > now() - interval '60 days'
   order by c.created_at desc limit 1;
  if v_client.id is null then
    raise exception 'No store with that number has signed up in the last 60 days. Ask them to sign up with your code.' using errcode = '22023';
  end if;
  select * into v_cur from public.sales_attributions where client_id = v_client.id for update;
  if v_cur.client_id is not null and v_cur.status <> 'Rejected' then
    if v_cur.rep_id = v_rep and v_cur.status = 'Pending' then return jsonb_build_object('ok', true, 'message', 'Your claim for this store is already waiting for NovaX.'); end if;
    if v_cur.rep_id = v_rep then return jsonb_build_object('ok', true, 'message', 'This store is already yours.'); end if;
    raise exception 'This store is already credited to another rep. Talk to NovaX if you think that is wrong.' using errcode = '22023';
  end if;
  if v_cur.client_id is not null and v_cur.method = 'claim' and v_cur.rep_id = v_rep and v_note is not distinct from v_cur.note then
    raise exception 'NovaX turned this claim down. Add new details (when and how you reached the store) and send it again.' using errcode = '22023';
  end if;
  insert into public.sales_attributions(client_id, rep_id, method, status, note, terms)
  values (v_client.id, v_rep, 'claim', 'Pending', v_note, public.sales_terms_now())
  on conflict (client_id) do update set rep_id = excluded.rep_id, alt_rep_id = null, method = 'claim', status = 'Pending',
    note = excluded.note, terms = excluded.terms, created_at = now(), decided_at = null, decided_by = null;
  return jsonb_build_object('ok', true, 'message', 'Claim sent. NovaX will check it and you will see it under My stores.', 'store_name', v_client.name);
end $$;

create or replace function public.sales_my_stores()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'client_id', a.client_id, 'store_name', c.name, 'city', c.city,
      'signed_up_at', c.created_at, 'method', a.method, 'status', a.status,
      'note', case when a.status = 'Rejected' then a.note end,
      'milestones', case when a.status <> 'Rejected' then public.sales_store_milestones(a.client_id) end,
      'rewards', (select coalesce(jsonb_object_agg(w.kind, w.status), '{}'::jsonb) from public.sales_rewards w where w.client_id = a.client_id and w.rep_id = a.rep_id),
      'amounts', (select coalesce(jsonb_object_agg(w.kind, w.amount), '{}'::jsonb) from public.sales_rewards w where w.client_id = a.client_id and w.rep_id = a.rep_id))
    order by c.created_at desc), '[]'::jsonb)
  from public.sales_attributions a join public.clients c on c.id = a.client_id
  where a.rep_id = public.sales_require_rep();
$$;

-- ── the engine ───────────────────────────────────────────────────────────
create or replace function public.sales_refresh()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_window int := public.sales_setting_int('lead_window_days');
  v_untouched int := public.sales_setting_int('lead_untouched_days');
  v_new int := 0; v_freed int := 0; v_earned int := 0;
  r record; v_terms jsonb; v_hold int;
  v_code_rep uuid; v_lead_rep uuid; v_lead uuid;
  v_first uuid; v_picked_at timestamptz; v_first_bad boolean;
begin
  -- The cron job runs as the database owner; through the API only an admin may.
  if session_user::text = 'authenticator' and not public.is_admin() then
    raise exception 'Only NovaX admins can do this.' using errcode = '42501';
  end if;

  -- 1. Credit new stores (last 60 days) that nobody has been credited with yet.
  for r in
    select c.id, c.phone, c.created_at,
      (select upper(btrim(u.raw_user_meta_data->>'sales_ref'))
         from public.profiles p join auth.users u on u.id = p.id
        where p.client_id = c.id order by p.created_at limit 1) as ref
    from public.clients c
    where c.created_at > now() - interval '60 days'
      and not exists (select 1 from public.sales_attributions a where a.client_id = c.id)
      and c.name !~* '^\s*(test|testt|test account|test accoiunt|test client|test store|novax merchant)\s*$'
  loop
    v_code_rep := (select s.id from public.sales_reps s where s.code = r.ref and s.status <> 'Removed');
    select s.rep_id, s.id into v_lead_rep, v_lead from public.sales_prospects s
     where s.phone = public.sales_norm_phone(r.phone) and s.rep_id is not null
       and s.assigned_at <= r.created_at + interval '1 day'
       and s.assigned_at >= r.created_at - make_interval(days => v_window)
     limit 1;
    if v_code_rep is not null or v_lead_rep is not null then
      insert into public.sales_attributions(client_id, rep_id, alt_rep_id, method, status, note, terms)
      values (r.id, coalesce(v_code_rep, v_lead_rep),
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then v_lead_rep end,
              case when v_code_rep is not null then 'ref_code' else 'phone_match' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep then 'Pending' else 'Approved' end,
              case when v_code_rep is not null and v_lead_rep is not null and v_code_rep <> v_lead_rep
                   then 'Signed up with one rep''s code but was on another rep''s lead list.' end,
              public.sales_terms_now())
      on conflict (client_id) do nothing;
      v_new := v_new + 1;
    end if;
    update public.sales_prospects s set status = 'Signed up', client_id = r.id, signed_up_at = r.created_at,
           next_followup_on = null, updated_at = now()
     where s.phone = public.sales_norm_phone(r.phone) and s.client_id is null;
    v_lead_rep := null; v_lead := null; v_code_rep := null;
  end loop;

  -- 2. Rewards for credited stores, at the terms frozen when each was credited.
  for r in
    select a.client_id, a.rep_id, coalesce(a.terms, public.sales_terms_now()) as terms, rp.status as rep_status, rp.removed_at,
      exists (select 1 from public.client_kyc k where k.client_id = a.client_id and k.status = 'verified') as verified,
      exists (select 1 from public.parcels p where p.client_id = a.client_id
               and p.status not in ('New booked', 'Cancelled by client')) as picked_any,
      exists (select 1 from public.parcels p where p.client_id = a.client_id and p.status = 'Delivered') as delivered
    from public.sales_attributions a join public.sales_reps rp on rp.id = a.rep_id
    where a.status = 'Approved'
  loop
    -- A removed rep is paid for what is met within 30 days of the end date, nothing after.
    if r.rep_status = 'Removed' and r.removed_at < now() - interval '30 days' then
      update public.sales_rewards set status = 'Rejected', rejected_at = now(),
             note = 'Not met within 30 days after the agreement ended'
       where client_id = r.client_id and rep_id = r.rep_id and status = 'Waiting';
      continue;
    end if;
    v_hold := coalesce((r.terms->>'pickup_hold_days')::int, public.sales_setting_int('pickup_hold_days'));
    insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
    values (r.rep_id, r.client_id, 'account_opened', coalesce((r.terms->>'account_opened')::numeric, public.sales_setting_int('reward_account_opened')), 'Waiting')
    on conflict (client_id, kind) do nothing;
    if r.verified then
      update public.sales_rewards set status = 'Earned', earned_at = now()
       where client_id = r.client_id and rep_id = r.rep_id and kind = 'account_opened' and status = 'Waiting';
      if found then v_earned := v_earned + 1; end if;
    end if;
    if r.picked_any then
      insert into public.sales_rewards(rep_id, client_id, kind, amount, status)
      values (r.rep_id, r.client_id, 'first_pickup', coalesce((r.terms->>'first_pickup')::numeric, public.sales_setting_int('reward_first_pickup')), 'Waiting')
      on conflict (client_id, kind) do nothing;
      -- The first parcel picked up (its first move out of "New booked" that
      -- was not a cancellation), and whether it was ever cancelled, refused or returned.
      v_first := null; v_picked_at := null;
      select l.parcel_id, l.changed_at into v_first, v_picked_at from public.nv_parcel_status_log l
       where l.client_id = r.client_id and l.from_status = 'New booked' and l.to_status <> 'Cancelled by client'
       order by l.changed_at limit 1;
      v_first_bad := v_first is null
        or exists (select 1 from public.nv_parcel_status_log l where l.parcel_id = v_first
                    and l.to_status in ('Refused', 'Return to shipper', 'Cancelled by client'))
        or exists (select 1 from public.parcels p where p.id = v_first
                    and p.status in ('Refused', 'Return to shipper', 'Cancelled by client'));
      -- Paid for the FIRST pickup only: delivered, or held N days without a
      -- refusal or return. Another parcel's delivery never pays for it (2 Oct).
      if v_first is not null and not v_first_bad
         and (exists (select 1 from public.parcels p where p.id = v_first and p.status = 'Delivered')
              or v_picked_at < now() - make_interval(days => v_hold)) then
        update public.sales_rewards set status = 'Earned', earned_at = now()
         where client_id = r.client_id and rep_id = r.rep_id and kind = 'first_pickup' and status = 'Waiting';
        if found then v_earned := v_earned + 1; end if;
      end if;
    end if;
  end loop;

  -- 3. Leads nobody called within the window go back to the pool.
  update public.sales_prospects set rep_id = null, assigned_at = null, updated_at = now()
   where rep_id is not null and call_count = 0 and status = 'Not called'
     and assigned_at < now() - make_interval(days => v_untouched);
  get diagnostics v_freed = row_count;

  return jsonb_build_object('credited', v_new, 'rewards_earned', v_earned, 'leads_freed', v_freed);
end $$;

-- ── payouts: Earned → Approved → Paid, each step recorded ────────────────
create or replace function public.sales_admin_set_rewards(p_ids uuid[], p_status text, p_ref text default null, p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v int; v_missing text;
begin
  perform public.sales_require_admin();
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Select at least one reward.' using errcode = '22023'; end if;
  if p_status = 'Approved' then
    update public.sales_rewards set status = 'Approved', approved_at = now(), approved_by = auth.uid()
     where id = any(p_ids) and status = 'Earned';
  elsif p_status = 'Paid' then
    if char_length(btrim(coalesce(p_ref, ''))) < 3 then raise exception 'Enter the bank or transfer reference.' using errcode = '22023'; end if;
    if exists (select 1 from public.sales_rewards w where w.id = any(p_ids) and w.status <> 'Approved') then
      raise exception 'Only approved rewards can be marked paid. Approve them first.' using errcode = '22023';
    end if;
    select string_agg(distinct r.code, ', ') into v_missing from public.sales_rewards w join public.sales_reps r on r.id = w.rep_id
     where w.id = any(p_ids) and r.payout_account is null;
    if v_missing is not null then
      raise exception 'No payout account yet for %. They add it under Earnings on their sales page.', v_missing using errcode = '22023';
    end if;
    update public.sales_rewards w set status = 'Paid', paid_at = now(), paid_by = auth.uid(), paid_ref = left(btrim(p_ref), 80),
           paid_to = r.payout_method || ' · ' || r.payout_title || ' · ' || r.payout_account
      from public.sales_reps r
     where r.id = w.rep_id and w.id = any(p_ids) and w.status = 'Approved';
  elsif p_status = 'Rejected' then
    if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why, so the rep can see it.' using errcode = '22023'; end if;
    update public.sales_rewards set status = 'Rejected', note = left(btrim(p_note), 200), rejected_at = now(), rejected_by = auth.uid()
     where id = any(p_ids) and status <> 'Paid';
  else
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.sales_admin_rewards(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'rep_code', r.code, 'rep_name', r.full_name, 'store_name', c.name, 'kind', w.kind, 'amount', w.amount,
      'status', w.status, 'earned_at', w.earned_at, 'approved_at', w.approved_at, 'paid_at', w.paid_at, 'paid_ref', w.paid_ref, 'note', w.note,
      'paid_to', w.paid_to, 'rejected_at', w.rejected_at,
      'approved_by', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = w.approved_by),
      'paid_by', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = w.paid_by),
      'rejected_by', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = w.rejected_by),
      'payout', case when r.payout_method is not null then r.payout_method || ' · ' || r.payout_title || ' · ' || r.payout_account end,
      'payout_changed_at', r.payout_updated_at,
      'payout_name_differs', r.payout_title is not null and lower(r.payout_title) <> lower(r.full_name))
    order by coalesce(w.earned_at, w.created_at) desc), '[]'::jsonb)
  from public.sales_rewards w join public.sales_reps r on r.id = w.rep_id join public.clients c on c.id = w.client_id
  where p_status is null or w.status = p_status);
end $$;

-- ── Google Sheet ─────────────────────────────────────────────────────────
drop function if exists public.sales_admin_sheet_key();
drop function if exists public.sales_sheet_sync(text, jsonb);
delete from public.sales_settings where key = 'sheet_token_hash';

-- Reads a sheet (the linked one, or p_id to test a new link) and imports it.
-- Headings are matched by name; a sheet without "Store name" and "Phone"
-- headings is refused rather than guessed. Rows beyond 10,000 are reported.
drop function if exists public.sales_sheet_pull();
create or replace function public.sales_sheet_pull(p_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := coalesce(p_id, (select value from public.sales_settings where key = 'sheet_id'));
  v_tab text := coalesce((select value from public.sales_settings where key = 'sheet_tab'), 'Leads');
  v_resp record; v_body text; v_json jsonb; v_cols jsonb; v_idx jsonb := '{}'::jsonb; v_rows jsonb := '[]'::jsonb; v_sheetrow int[] := '{}';
  v_row jsonb; v_cells jsonb; v_out jsonb; v_code text; v_ref text; v_phone text; v_res jsonb; v_part jsonb;
  v_notes jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb; v_seen jsonb := '{}'::jsonb; v_ignored text[] := '{}';
  v_i int; v_n int := 0; v_label text; v_key text; v_ins int := 0; v_upd int := 0; v_total int := 0; v_k int; v_off int;
  v_map jsonb := '{"lead id":"lead_ref","id":"lead_ref","lead":"lead_ref",
                   "store name":"store_name","store":"store_name","business":"store_name","business name":"store_name","shop":"store_name","shop name":"store_name","name":"store_name",
                   "contact person":"contact_name","contact":"contact_name","owner":"contact_name","owner name":"contact_name",
                   "phone":"phone","mobile":"phone","phone number":"phone","mobile number":"phone","number":"phone","whatsapp":"phone","contact number":"phone",
                   "city":"city","category":"category","niche":"category","what they sell":"category",
                   "where found":"source","source":"source","store link":"store_link","link":"store_link","website":"store_link","instagram":"store_link","url":"store_link",
                   "orders per month":"est_orders","orders":"est_orders","assign to":"assign_to","rep":"assign_to","rep code":"assign_to"}';
begin
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No sheet linked yet.'); end if;
  if not pg_try_advisory_xact_lock(hashtext('novax-sales-sheet-pull')) then
    return jsonb_build_object('ok', false, 'error', 'An import is already running. Try again in a minute.');
  end if;
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '25');
    select * into v_resp from extensions.http_get(
      'https://docs.google.com/spreadsheets/d/' || v_id || '/gviz/tq?tqx=out:json&headers=1&sheet=' || replace(v_tab, ' ', '%20'));
    if v_resp.status <> 200 then
      raise exception 'Google answered %. Check the link and that sharing is "Anyone with the link".', v_resp.status;
    end if;
    v_body := v_resp.content;
    if v_body !~ 'setResponse\(' then
      raise exception 'The sheet is private. Set Share → General access → Anyone with the link → Viewer.';
    end if;
    v_body := substring(v_body from position('setResponse(' in v_body) + 12);
    v_body := left(v_body, length(v_body) - position(')' in reverse(v_body)));
    v_body := regexp_replace(v_body, 'new Date\([^)]*\)', 'null', 'g');
    v_json := v_body::jsonb;
    if v_json->>'status' = 'error' then
      raise exception 'Google could not read the sheet: %', coalesce(v_json->'errors'->0->>'detailed_message', v_json->'errors'->0->>'message', 'unknown error');
    end if;
    v_cols := v_json->'table'->'cols';
    for v_i in 0 .. coalesce(jsonb_array_length(v_cols), 0) - 1 loop
      v_label := lower(regexp_replace(btrim(coalesce(v_cols->v_i->>'label', '')), '\s+', ' ', 'g'));
      v_key := v_map->>v_label;
      if v_key is not null and not v_idx ? v_key then v_idx := v_idx || jsonb_build_object(v_key, v_i);
      elsif v_label <> '' and v_key is null then v_ignored := v_ignored || (v_cols->v_i->>'label'); end if;
    end loop;
    if not (v_idx ? 'store_name' and v_idx ? 'phone') then
      raise exception 'Row 1 of the sheet needs the headings "Store name" and "Phone" (found: %). Copy the headings from this page.',
        coalesce(nullif((select string_agg(nullif(btrim(c->>'label'), ''), ', ') from jsonb_array_elements(v_cols) c), ''), 'none');
    end if;
    v_i := 0;
    for v_row in select value from jsonb_array_elements(coalesce(v_json->'table'->'rows', '[]'::jsonb)) loop
      v_i := v_i + 1;
      v_cells := v_row->'c'; v_out := '{}'::jsonb;
      for v_key in select jsonb_object_keys(v_idx) loop
        v_out := v_out || jsonb_build_object(v_key, btrim(coalesce(v_cells->((v_idx->>v_key)::int)->>'f', v_cells->((v_idx->>v_key)::int)->>'v', '')));
      end loop;
      if coalesce(v_out->>'store_name', '') = '' and coalesce(v_out->>'phone', '') = '' then continue; end if;
      v_total := v_total + 1;
      if v_total > 10000 then continue; end if;
      v_phone := public.sales_norm_phone(v_out->>'phone');
      v_ref := nullif(left(btrim(coalesce(v_out->>'lead_ref', '')), 60), '');
      -- The same phone twice in the sheet: the first row wins.
      if v_phone ~ '^03[0-9]{9}$' and v_seen ? v_phone then
        v_skip := v_skip || jsonb_build_object('row', v_i + 1, 'lead_ref', v_ref, 'reason', 'Same phone as row ' || (v_seen->>v_phone));
        continue;
      end if;
      if v_phone ~ '^03[0-9]{9}$' then v_seen := v_seen || jsonb_build_object(v_phone, v_i + 1); end if;
      if v_ref is null and v_phone ~ '^03[0-9]{9}$' then v_ref := 'S' || v_phone; v_out := v_out || jsonb_build_object('lead_ref', v_ref); end if;
      v_code := upper(btrim(coalesce(v_out->>'assign_to', '')));
      if v_code <> '' then
        if not exists (select 1 from public.sales_reps where code = v_code and status <> 'Removed') then
          v_notes := v_notes || jsonb_build_object('row', v_i + 1, 'lead_ref', v_ref, 'reason', 'No active rep with code ' || v_code || ', imported unassigned');
          v_out := v_out - 'assign_to';
        elsif exists (select 1 from public.sales_prospects p where ((v_ref is not null and p.lead_ref = v_ref) or p.phone = v_phone) and p.rep_id is not null) then
          v_out := v_out - 'assign_to';
        end if;
      else
        v_out := v_out - 'assign_to';
      end if;
      v_rows := v_rows || v_out; v_sheetrow := v_sheetrow || (v_i + 1);
    end loop;
    if v_total > 10000 then
      v_notes := v_notes || jsonb_build_object('row', 10002, 'lead_ref', null, 'reason', (v_total - 10000) || ' rows after the first 10,000 were not read. Split the sheet.');
    end if;
    -- 2,000 rows per call to the importer; sheet row numbers in every reason.
    v_off := 0;
    while v_off < jsonb_array_length(v_rows) loop
      v_part := public.sales_upsert_leads((select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality t(e, o) where o > v_off and o <= v_off + 2000));
      v_ins := v_ins + (v_part->>'inserted')::int; v_upd := v_upd + (v_part->>'updated')::int;
      for v_k in 0 .. jsonb_array_length(v_part->'skipped') - 1 loop
        v_skip := v_skip || ((v_part->'skipped'->v_k) || jsonb_build_object('row', v_sheetrow[v_off + ((v_part->'skipped'->v_k->>'row')::int)]));
      end loop;
      v_off := v_off + 2000;
    end loop;
    v_res := jsonb_build_object('ok', true, 'at', now(), 'rows', jsonb_array_length(v_rows), 'inserted', v_ins, 'updated', v_upd,
      'skipped', coalesce((select jsonb_agg(s order by (s->>'row')::int) from jsonb_array_elements(v_skip) s), '[]'::jsonb),
      'notes', v_notes, 'ignored_columns', to_jsonb(v_ignored));
  exception when others then
    v_res := jsonb_build_object('ok', false, 'at', now(), 'error', sqlerrm);
  end;
  if p_id is null then
    insert into public.sales_settings(key, value) values ('sheet_last', v_res::text)
    on conflict (key) do update set value = excluded.value;
  end if;
  return v_res;
end $$;

-- Cron: a failed import fails the job, so it shows in the job history.
create or replace function public.sales_sheet_pull_cron()
returns void language plpgsql security definer set search_path = '' as $$
declare v_res jsonb;
begin
  if not exists (select 1 from public.sales_settings where key = 'sheet_id') then return; end if;
  v_res := public.sales_sheet_pull();
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'Sheet import failed: %', v_res->>'error';
  end if;
end $$;

-- A new link is tried first; it replaces the linked sheet only if it imports.
create or replace function public.sales_admin_set_sheet(p_url text, p_tab text default 'Leads')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := coalesce(substring(coalesce(p_url, '') from '/spreadsheets/d/([A-Za-z0-9_-]{20,})'), substring(btrim(coalesce(p_url, '')) from '^([A-Za-z0-9_-]{20,})$'));
  v_res jsonb;
begin
  perform public.sales_require_admin();
  if v_id is null then raise exception 'Paste the full Google Sheet link (it starts with https://docs.google.com/spreadsheets/d/).' using errcode = '22023'; end if;
  v_res := public.sales_sheet_pull(v_id);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception '%', coalesce(v_res->>'error', 'The sheet could not be read.') || ' Your linked sheet was not changed.' using errcode = '22023';
  end if;
  insert into public.sales_settings(key, value) values ('sheet_id', v_id), ('sheet_tab', 'Leads'), ('sheet_last', v_res::text)
  on conflict (key) do update set value = excluded.value;
  return v_res;
end $$;

create or replace function public.sales_admin_sheet_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id text := (select value from public.sales_settings where key = 'sheet_id'); v_cron jsonb;
begin
  perform public.sales_require_admin();
  begin
    select jsonb_build_object('status', d.status, 'at', d.start_time, 'message', left(d.return_message, 300)) into v_cron
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
     where j.jobname = 'novax-sales-sheet-pull' order by d.start_time desc limit 1;
  exception when others then v_cron := null;
  end;
  return jsonb_build_object('sheet_id', v_id,
    'sheet_url', case when v_id is not null then 'https://docs.google.com/spreadsheets/d/' || v_id || '/edit' end,
    'tab', 'Leads',
    'last', (select value::jsonb from public.sales_settings where key = 'sheet_last'),
    'cron', v_cron);
end $$;

-- ── grants ───────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['sales_terms_now()', 'sales_iban_ok(text)', 'sales_set_payout(text,text,text)', 'sales_me()',
    'sales_admin_invite(text,text,text,text)', 'sales_save_profile(text,text,text,text,text,text)', 'sales_upsert_leads(jsonb)',
    'sales_admin_leads(uuid,text,text,boolean)', 'sales_move_rewards(uuid,uuid)', 'sales_admin_decide(uuid,text,uuid,text)',
    'sales_admin_credit(uuid,uuid)', 'sales_claim_store(text,text)', 'sales_my_stores()', 'sales_refresh()',
    'sales_admin_set_rewards(uuid[],text,text,text)', 'sales_admin_rewards(text)', 'sales_sheet_pull(text)', 'sales_sheet_pull_cron()',
    'sales_admin_set_sheet(text,text)', 'sales_admin_sheet_status()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['sales_set_payout(text,text,text)', 'sales_me()', 'sales_admin_invite(text,text,text,text)',
    'sales_save_profile(text,text,text,text,text,text)', 'sales_admin_leads(uuid,text,text,boolean)', 'sales_admin_decide(uuid,text,uuid,text)',
    'sales_admin_credit(uuid,uuid)', 'sales_claim_store(text,text)', 'sales_my_stores()', 'sales_refresh()',
    'sales_admin_set_rewards(uuid[],text,text,text)', 'sales_admin_rewards(text)', 'sales_admin_set_sheet(text,text)', 'sales_admin_sheet_status()']
  loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;

-- The 15-minute import now fails visibly when the sheet cannot be read.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'novax-sales-sheet-pull';
    perform cron.schedule('novax-sales-sheet-pull', '*/15 * * * *', 'select public.sales_sheet_pull_cron()');
  end if;
end $$;
