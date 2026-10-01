-- The answer bank told visitors the team "activates" new accounts. Signup
-- creates the workspace on the spot (email confirmation is off) and asks for
-- the owner's CNIC. Answer now matches the form.
begin;
update public.nv_ai_answers set
  answer_en = 'Opening an account is free and takes about five minutes. Sign up at https://novaxlogistics.com/#signup with your store name, pickup city, phone, pickup address, an email and password, and a photo of the front and back of your CNIC (only NovaX staff can see it). Your workspace opens the moment you finish, so you can book your first parcel straight away. Prefer a call first? Tap "Talk to sales" and the team calls you back the same day.',
  answer_ur = 'Account kholna free hai aur takreeban paanch minute lagte hain. https://novaxlogistics.com/#signup par apne store ka naam, pickup city, phone, pickup address, email aur password, aur apne CNIC ke aage aur peeche ki photo den (sirf NovaX staff dekh sakta hai). Signup khatam hote hi aapka workspace khul jata hai aur aap usi waqt pehla parcel book kar sakte hain. Pehle baat karni hai? "Talk to sales" dabayein, team usi din call karegi.',
  updated_at = now()
where id = '5d7986fc-3d5f-4a42-b62c-141b1b848d20';
commit;
