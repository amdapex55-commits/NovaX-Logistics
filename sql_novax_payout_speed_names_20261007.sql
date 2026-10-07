-- 7 Oct 2026: the three payout speeds were renamed and slowed; fees unchanged.
--   Express  within 12 hours   0.7%   (was "instant, 2-3 hours")
--   Standard 12-24 hours       0.3%   (was "12 hours")
--   Saver    24-48 hours       0.1%   (was "24 hours")
-- The portal, admin and public pages changed in commit 6f50f5c. This updates
-- the two saved assistant answers that quote the speeds. Safe to run twice.
-- The "within 15 minutes" COD-to-wallet sentence is left exactly as it was.

update public.nv_ai_answers set
  answer_en = 'The COD your customer pays is credited to your NovaX wallet within 15 minutes of delivery. Moving it to your bank is a withdrawal you request: Saver, 24-48 hours (0.1% fee); Standard, 12-24 hours (0.3% fee); or Express, within 12 hours (0.7% fee).',
  answer_ur = 'Customer jo COD deta hai woh delivery ke 15 minute ke andar aapke NovaX wallet mein aa jata hai. Bank mein bhejna ek withdrawal hai jo aap khud request karte hain: Saver, 24-48 ghante (0.1% fee); Standard, 12-24 ghante (0.3% fee); ya Express, 12 ghante ke andar (0.7% fee).'
where id = '9385f9bf-e32d-4bea-8e94-1866394d987d';

update public.nv_ai_answers set
  answer_en = 'Withdrawing your wallet to your bank has three speeds: Saver (24-48 hours) at 0.1%, Standard (12-24 hours) at 0.3%, or Express (within 12 hours) at 0.7%. On Rs 10,000 that is Rs 10, Rs 30 or Rs 70. Shipping itself has no hidden charges; this is the only fee on your money.',
  answer_ur = 'Wallet se bank mein paise bhejne ki teen speeds hain: Saver (24-48 ghante) par 0.1%, Standard (12-24 ghante) par 0.3%, ya Express (12 ghante ke andar) par 0.7%. Rs 10,000 par yeh Rs 10, Rs 30 ya Rs 70 banta hai. Shipping mein koi hidden charge nahi; aapke paison par sirf yahi fee hai.'
where id = '069539ec-cacc-4309-9527-d92d5b9a442b';
