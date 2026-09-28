-- AI answer bank (28 Sep 2026).
--
-- Approved answers the chat gives WITHOUT calling a model: free, instant, and
-- exactly the words an admin approved. The homepage chat and the portal
-- Autopilot check here first; only questions nothing here matches go on to
-- Claude. Admin edits answers in Admin -> NovaX AI -> Answer Bank.
--
-- Matching is deliberately dumb and predictable: a question matches an answer
-- when it contains one of that answer's phrases as whole words. The longest
-- matching phrase wins. If two different answers match about equally well
-- (a question about two things), NOTHING is returned and the model answers,
-- so a two-part question never gets a one-part reply.

create table if not exists public.nv_ai_answers (
  id           uuid primary key default gen_random_uuid(),
  topic        text not null check (char_length(btrim(topic)) between 2 and 80),
  phrases      text[] not null default '{}',
  answer_en    text not null check (char_length(btrim(answer_en)) between 5 and 1200),
  answer_ur    text check (answer_ur is null or char_length(answer_ur) <= 1200),
  suggest_en   text[] not null default '{}',
  suggest_ur   text[] not null default '{}',
  scope        text not null default 'all' check (scope in ('all','site','portal')),
  enabled      boolean not null default true,
  hits         integer not null default 0,
  last_hit_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists nv_ai_answers_topic_unique on public.nv_ai_answers (lower(btrim(topic)));

revoke all on public.nv_ai_answers from public, anon, authenticated;
grant select on public.nv_ai_answers to authenticated;
grant all on public.nv_ai_answers to service_role;
alter table public.nv_ai_answers enable row level security;
drop policy if exists "admin read nv_ai_answers" on public.nv_ai_answers;
create policy "admin read nv_ai_answers" on public.nv_ai_answers
  for select to authenticated using ((select public.is_admin()));

-- Lowercase, letters/digits only, single spaces, padded -- so phrase matching
-- is whole-word: "rate" never matches inside "separate".
create or replace function public.nv_ai_norm(p text)
returns text language sql immutable set search_path = public as $$
  select ' ' || btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g')) || ' '
$$;

-- Roman Urdu or English? A handful of very common Roman Urdu words decide it.
create or replace function public.nv_ai_is_roman_urdu(p text)
returns boolean language sql immutable set search_path = public as $$
  select count(*) >= 2
    from regexp_split_to_table(btrim(public.nv_ai_norm(p)), ' ') w
   where w in ('hai','hay','hey','hain','hein','kya','kia','keya','kitne','kitna','kitny','kitni',
               'ka','ki','ke','mein','mai','main','se','sy','ho','hota','kr','kar','krwa','karwa',
               'acha','achha','batao','bata','btao','nahi','nahin','nai','tu','kab','kahan','kaha',
               'koi','aur','yeh','ye','raha','rahi','lagta','lagti','milta','milti','milega','chahiye',
               'chahye','agar','wala','wali','apka','apki','aap','ap','hum','mujhe','mera','meri')
$$;

-- The lookup the chats call. Returns 0 or 1 row. Counts the hit unless
-- p_count is false (the admin "test a question" box).
create or replace function public.nv_ai_answer_lookup(p_q text, p_scope text default 'site', p_count boolean default true)
returns table(id uuid, topic text, answer text, suggestions text[], matched text)
language plpgsql security definer set search_path = public as $$
declare
  v_q     text := public.nv_ai_norm(left(coalesce(p_q,''), 600));
  v_ur    boolean := public.nv_ai_is_roman_urdu(p_q);
  v_scope text := case when p_scope in ('site','portal') then p_scope else 'site' end;
  v_best  record;
  v_next  int;
begin
  -- Urdu script, empty, or long multi-part questions go to the model.
  if coalesce(p_q,'') ~ '[؀-ۿ]' or char_length(btrim(v_q)) < 2 or char_length(v_q) > 220 then
    return;
  end if;

  with m as (
    select a.id, a.topic, a.answer_en, a.answer_ur, a.suggest_en, a.suggest_ur,
           max(char_length(btrim(public.nv_ai_norm(ph)))) as score,
           (array_agg(ph order by char_length(ph) desc))[1] as phrase
      from public.nv_ai_answers a, unnest(a.phrases) ph
     where a.enabled
       and a.scope in ('all', v_scope)
       and char_length(btrim(public.nv_ai_norm(ph))) >= 2
       and position(public.nv_ai_norm(ph) in v_q) > 0
     group by a.id
  )
  select * into v_best from m order by score desc limit 1;
  if v_best.id is null then return; end if;

  -- A second topic that matches nearly as well means a two-part question.
  select max(score) into v_next from (
    select a.id, max(char_length(btrim(public.nv_ai_norm(ph)))) as score
      from public.nv_ai_answers a, unnest(a.phrases) ph
     where a.enabled and a.scope in ('all', v_scope) and a.id <> v_best.id
       and char_length(btrim(public.nv_ai_norm(ph))) >= 2
       and position(public.nv_ai_norm(ph) in v_q) > 0
     group by a.id) s;
  if v_next is not null and v_best.score < v_next + 8 then return; end if;

  if coalesce(p_count, true) then
    update public.nv_ai_answers set hits = hits + 1, last_hit_at = now() where nv_ai_answers.id = v_best.id;
  end if;

  return query select v_best.id, v_best.topic,
    case when v_ur and nullif(btrim(v_best.answer_ur),'') is not null then v_best.answer_ur else v_best.answer_en end,
    case when v_ur and cardinality(v_best.suggest_ur) > 0 then v_best.suggest_ur else v_best.suggest_en end,
    v_best.phrase;
end $$;

-- Admin: create (p_id null) or edit an answer.
create or replace function public.nv_ai_answer_save(
  p_id uuid, p_topic text, p_phrases text[], p_answer_en text, p_answer_ur text,
  p_suggest_en text[], p_suggest_ur text[], p_scope text, p_enabled boolean)
returns public.nv_ai_answers
language plpgsql security definer set search_path = public as $$
declare
  v_row public.nv_ai_answers;
  v_ph  text[];
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_ph
    from unnest(coalesce(p_phrases,'{}')) x where char_length(btrim(x)) >= 2;
  if cardinality(v_ph) = 0 then raise exception 'Add at least one phrase that should trigger this answer.'; end if;
  if char_length(btrim(coalesce(p_topic,''))) < 2 then raise exception 'Give the answer a short topic name.'; end if;
  if char_length(btrim(coalesce(p_answer_en,''))) < 5 then raise exception 'Write the English answer.'; end if;
  if p_scope not in ('all','site','portal') then raise exception 'Pick where this answer is used.'; end if;

  if p_id is null then
    insert into public.nv_ai_answers (topic, phrases, answer_en, answer_ur, suggest_en, suggest_ur, scope, enabled)
    values (btrim(p_topic), v_ph, btrim(p_answer_en), nullif(btrim(coalesce(p_answer_ur,'')),''),
            coalesce(p_suggest_en,'{}'), coalesce(p_suggest_ur,'{}'), p_scope, coalesce(p_enabled,true))
    returning * into v_row;
  else
    update public.nv_ai_answers
       set topic = btrim(p_topic), phrases = v_ph, answer_en = btrim(p_answer_en),
           answer_ur = nullif(btrim(coalesce(p_answer_ur,'')),''),
           suggest_en = coalesce(p_suggest_en,'{}'), suggest_ur = coalesce(p_suggest_ur,'{}'),
           scope = p_scope, enabled = coalesce(p_enabled,true), updated_at = now()
     where id = p_id
    returning * into v_row;
    if v_row.id is null then raise exception 'That answer no longer exists.'; end if;
  end if;
  return v_row;
exception when unique_violation then
  raise exception 'Another answer already uses the topic "%".', btrim(p_topic);
end $$;

create or replace function public.nv_ai_answer_delete(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  delete from public.nv_ai_answers where id = p_id;
  return found;
end $$;

-- Admin "test a question": same matcher, never counts a hit.
create or replace function public.nv_ai_answer_test(p_q text, p_scope text default 'site')
returns table(id uuid, topic text, answer text, suggestions text[], matched text)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query select * from public.nv_ai_answer_lookup(p_q, p_scope, false);
end $$;

revoke all on function public.nv_ai_norm(text) from public;
revoke all on function public.nv_ai_is_roman_urdu(text) from public;
revoke all on function public.nv_ai_answer_lookup(text, text, boolean) from public, anon, authenticated;
revoke all on function public.nv_ai_answer_save(uuid, text, text[], text, text, text[], text[], text, boolean) from public, anon;
revoke all on function public.nv_ai_answer_delete(uuid) from public, anon;
revoke all on function public.nv_ai_answer_test(text, text) from public, anon;
grant execute on function public.nv_ai_norm(text) to anon, authenticated, service_role;
grant execute on function public.nv_ai_is_roman_urdu(text) to anon, authenticated, service_role;
-- The lookup: the portal (signed in) and the site agent (service role). Anon
-- does not need it -- the homepage goes through the edge function.
grant execute on function public.nv_ai_answer_lookup(text, text, boolean) to authenticated, service_role;
grant execute on function public.nv_ai_answer_save(uuid, text, text[], text, text, text[], text[], text, boolean) to authenticated;
grant execute on function public.nv_ai_answer_delete(uuid) to authenticated;
grant execute on function public.nv_ai_answer_test(text, text) to authenticated;

-- ---- seed: every fact below is from the site agent's knowledge base ----
insert into public.nv_ai_answers (topic, phrases, answer_en, answer_ur, suggest_en, suggest_ur, scope) values
('Rates',
 array['rate','rates','price','prices','pricing','charges','charge','cost','costs','delivery charges','shipping charges','delivery charge','rate card','zone rates','zone rate','per kg','kg price','half kg','1 kg','1kg','same city rate','same city rates','kitne ka','kitna charge','kitne charges','charges kya','rate kya','charges bata do','rates bata do','kitne paise'],
 'Within Karachi it is Rs 225 for the first kg (anything up to 1 kg). To Lahore, Islamabad or Rawalpindi it is Rs 250 for the first kg. Every extra kg is Rs 85 in any city, so 2 kg is Rs 310 in Karachi and Rs 335 upcountry. No GST, no COD withholding tax, no hidden charges, and pickup is free.',
 'Karachi ke andar pehle kg (1 kg tak) ka Rs 225 hai. Lahore, Islamabad ya Rawalpindi ke liye pehle kg ka Rs 250. Har extra kg Rs 85, kisi bhi city mein, yani 2 kg Karachi mein Rs 310 aur upcountry Rs 335. Koi GST nahi, koi COD withholding tax nahi, koi hidden charge nahi, aur pickup free hai.',
 array['How fast do I get my COD?','Which cities do you deliver to?','How do I open an account?'],
 array['COD ke paise kab milte hain?','Kin cities mein deliver karte ho?','Account kaise kholein?'],
 'site'),
('Cities we deliver to',
 array['which cities','what cities','cities','city list','coverage','deliver to','deliver in','do you deliver','other cities','all pakistan','whole pakistan','nationwide','kin cities','konsi city','konsi cities','kaunse shehar','kahan deliver','kahan tak','gujrat','gujranwala','faisalabad','multan','peshawar','hyderabad','sialkot','quetta','sukkur','bahawalpur','sargodha','abbottabad','mardan','larkana','nawabshah','rahim yar khan','rahimyarkhan','mandi bahauddin','mandi bahudin','jhelum','sheikhupura','okara','sahiwal','dera ghazi khan','mirpur','muzaffarabad'],
 'We deliver in Karachi, Lahore, Islamabad and Rawalpindi, and we pick up from Karachi. We do not deliver to other cities yet.',
 'Hum Karachi, Lahore, Islamabad aur Rawalpindi mein deliver karte hain, aur pickup Karachi se hoti hai. Baaqi cities mein abhi delivery nahi hai.',
 array['What are your rates?','How long does delivery take?','Is pickup really free?'],
 array['Rates kya hain?','Delivery mein kitne din lagte hain?','Kya pickup free hai?'],
 'all'),
('Delivery time',
 array['how long','how many days','how fast','delivery time','transit time','same day','next day','kitne din','kitny din','kitna time','kitne time','kab tak','kab pohanch','kab puhanch','kab pahunch','kab milega','days to deliver','delivery days'],
 'Karachi deliveries arrive the same day or the next day. Lahore, Islamabad and Rawalpindi take 2-3 working days. For one particular parcel, its tracking page shows exactly where it is.',
 'Karachi mein delivery usi din ya agle din ho jati hai. Lahore, Islamabad aur Rawalpindi mein 2-3 working days lagte hain. Kisi ek parcel ka exact status uske tracking page par hota hai.',
 array['What are your rates?','How fast do I get my COD?','Which cities do you deliver to?'],
 array['Rates kya hain?','COD ke paise kab milte hain?','Kin cities mein deliver karte ho?'],
 'all'),
('When COD reaches me',
 array['cod','cod money','cod payment','cod payments','get paid','when do i get paid','how fast do i get my cod','how fast do i get paid','when do i get my cod','cod kab','cod kab milega','cod kitne din','paisay kab','paise kab','paisa kab','payment kab','payment kab milegi','cod ke paise'],
 'The COD your customer pays is credited to your NovaX wallet within 15 minutes of delivery. Moving it to your bank is a withdrawal you request: 24 hours (0.1% fee), 12 hours (0.3% fee) or instant, 2-3 hours (0.7% fee).',
 'Customer jo COD deta hai woh delivery ke 15 minute ke andar aapke NovaX wallet mein aa jata hai. Bank mein bhejna ek withdrawal hai jo aap khud request karte hain: 24 ghante (0.1% fee), 12 ghante (0.3% fee) ya instant, 2-3 ghante (0.7% fee).',
 array['How is the withdrawal fee worked out?','What are your rates?','Is there any tax on COD?'],
 array['Withdrawal fee ka hisab kya hai?','Rates kya hain?','COD par koi tax hai?'],
 'all'),
('Withdrawal fee',
 array['withdraw','withdrawal','withdrawals','withdrawal fee','withdraw fee','withdrawal charges','withdrawal charge','payout fee','transfer fee','bank transfer','withdrawal fee ka hisab','withdraw kaise'],
 'Withdrawing your wallet to your bank has three speeds: 24 hours at 0.1%, 12 hours at 0.3%, or instant (2-3 hours) at 0.7%. On Rs 10,000 that is Rs 10, Rs 30 or Rs 70. Shipping itself has no hidden charges; this is the only fee on your money.',
 'Wallet se bank mein paise bhejne ki teen speeds hain: 24 ghante par 0.1%, 12 ghante par 0.3%, ya instant (2-3 ghante) par 0.7%. Rs 10,000 par yeh Rs 10, Rs 30 ya Rs 70 banta hai. Shipping mein koi hidden charge nahi; aapke paison par sirf yahi fee hai.',
 array['How fast do I get my COD?','Is there any tax on COD?','What are your rates?'],
 array['COD ke paise kab milte hain?','COD par koi tax hai?','Rates kya hain?'],
 'all'),
('Tax and hidden charges',
 array['tax','taxes','gst','withholding','withholding tax','4 tax','tax lagta','tax lagta hai','tax lagta hey','cod per tax','cod par tax','hidden charges','hidden charge','extra charges','extra charge','koi extra','any other charges'],
 'No. There is no GST and no COD withholding tax on NovaX shipping, and no hidden charges; the rate quoted is the rate you pay. The only other fee is the small one if you withdraw your wallet to a bank (0.1% to 0.7%, depending on speed).',
 'Nahi. NovaX shipping par koi GST nahi, koi COD withholding tax nahi, aur koi hidden charge nahi; jo rate bataya woh hi lagta hai. Sirf ek choti fee hai jab aap wallet se bank mein paise nikalte hain (speed ke hisab se 0.1% se 0.7%).',
 array['How is the withdrawal fee worked out?','What are your rates?','How fast do I get my COD?'],
 array['Withdrawal fee ka hisab kya hai?','Rates kya hain?','COD ke paise kab milte hain?'],
 'all'),
('Free pickup',
 array['pickup','pick up','pickup free','free pickup','is pickup free','pickup really free','pickup charges','pickup kab','pickup kaise','book a pickup','request pickup','pickup request'],
 'Pickup is free from your shop or warehouse in Karachi, every working day. Request it from your seller dashboard and a rider collects your parcels. For the pickup time in your area, WhatsApp the team: 0312 3922558, 0325 8743409 or 0321 1551245.',
 'Karachi mein aapki shop ya warehouse se pickup free hai, har working day. Seller dashboard se request karein aur rider parcels le jayega. Apne area ka pickup time jaan-ne ke liye team ko WhatsApp karein: 0312 3922558, 0325 8743409 ya 0321 1551245.',
 array['What are your rates?','How fast do I get my COD?','How do I open an account?'],
 array['Rates kya hain?','COD ke paise kab milte hain?','Account kaise kholein?'],
 'all'),
('Open an account',
 array['open an account','open account','open a account','sign up','signup','register','registration','create account','create an account','how do i start','get started','how to start','join novax','account kaise','account khol','account kholna','account banana'],
 'Opening an account is free. Sign up at https://novaxlogistics.com/#signup with your name, phone and roughly how many parcels you send a month, and the team activates your account.',
 'Account kholna free hai. https://novaxlogistics.com/#signup par apna naam, phone aur mahine ke andazan parcels likhein, team aapka account activate kar degi.',
 array['What are your rates?','Is pickup really free?','Do you integrate with Shopify?'],
 array['Rates kya hain?','Kya pickup free hai?','Kya Shopify ke saath connect hota hai?'],
 'site'),
('Shopify, WooCommerce and API',
 array['shopify','woocommerce','woo commerce','integrate','integration','integrations','api','plugin','bulk booking','csv','connect my store','connect store'],
 'Yes. NovaX connects to Shopify and WooCommerce, has a merchant API, and takes bulk bookings by CSV. Once your account is active, connect your store from the Integrations tab in your dashboard.',
 'Jee haan. NovaX Shopify aur WooCommerce ke saath connect hota hai, merchant API bhi hai, aur CSV se bulk booking bhi hoti hai. Account active hone ke baad dashboard ke Integrations tab se store connect karein.',
 array['How do I open an account?','What are your rates?','How fast do I get my COD?'],
 array['Account kaise kholein?','Rates kya hain?','COD ke paise kab milte hain?'],
 'all'),
('Office and contact',
 array['office','your office','office kahan','office address','where are you located','where is your office','located','contact','contact number','your number','helpline','customer care','support number','whatsapp number'],
 'Our office is at Zahra Square, Memon Masjid, opposite shop 27, Karachi. The team answers fast on WhatsApp: 0312 3922558, 0325 8743409 or 0321 1551245.',
 'Hamara office Zahra Square, Memon Masjid, shop 27 ke samne, Karachi mein hai. Team WhatsApp par jaldi jawab deti hai: 0312 3922558, 0325 8743409 ya 0321 1551245.',
 array['What are your rates?','Is pickup really free?','How do I open an account?'],
 array['Rates kya hain?','Kya pickup free hai?','Account kaise kholein?'],
 'all'),
('Track a parcel',
 array['track','tracking','track my parcel','track parcel','where is my parcel','parcel kahan'],
 'Track any parcel at https://novaxlogistics.com/tracking.html with its tracking number. It shows every scan, live.',
 'Koi bhi parcel https://novaxlogistics.com/tracking.html par uske tracking number se track karein. Har scan live nazar aata hai.',
 array['How long does delivery take?','Which cities do you deliver to?','What are your rates?'],
 array['Delivery mein kitne din lagte hain?','Kin cities mein deliver karte ho?','Rates kya hain?'],
 'site')
on conflict do nothing;
