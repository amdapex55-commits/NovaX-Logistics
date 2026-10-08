-- Nova Recover: the saved answer NovaX AI gives about it.
-- Run this ONLY when the merchant tab is on for everyone (Settings > Merchant
-- tab > Everyone). Before that, most merchants have no Nova Recover in their
-- menu and this answer would point them at something they cannot see.
-- Safe to run twice.
insert into public.nv_ai_answers (topic, phrases, answer_en, answer_ur, scope, enabled)
select 'Nova Recover',
  array['nova recover','recover','recover order','recover parcel','refused parcel','refused order','customer refused','returned order',
        'sell again','resell','dobara bech','wapas aaya','wapas aye','refuse kar diya','refused ka kya','recover fee','recover charges','recover kya hai'],
  'Nova Recover is for orders a customer refused or that came back to you. Open Nova Recover in your portal menu, pick the parcels, and a NovaX agent phones each customer and sells the order again. You pay Rs 100 only for each order we recover, nothing if we cannot. A recovered order is delivered at your normal rate. The Rs 100 comes from your NovaX Wallet, and it stays if the customer agrees on the call and then refuses again at the door.',
  'Nova Recover un orders ke liye hai jo customer ne refuse kar diye ya wapas aa gaye. Portal ke menu mein Nova Recover kholein, parcels chunein, aur NovaX ka agent customer ko phone kar ke order dobara bechta hai. Sirf Rs 100 har us order ka jo hum recover karein, warna kuch nahi. Recover hua order aap ke normal rate par deliver hota hai. Rs 100 aap ke NovaX Wallet se liya jata hai, aur agar customer phone par haan keh kar darwaze par dobara refuse kar de to bhi yeh fee rehti hai.',
  (select a.scope from public.nv_ai_answers a where a.scope is not null limit 1), true
where not exists (select 1 from public.nv_ai_answers a where a.topic = 'Nova Recover');
