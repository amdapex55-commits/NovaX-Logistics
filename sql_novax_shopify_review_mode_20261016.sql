-- Shopify review mode (16 Oct 2026).
--
-- Shopify's reviewers rejected the app because they could not see an order
-- they placed get fulfilled. On 13 Oct their store sent 14 orders: 13 were
-- skipped as test orders (reviewers can only pay with Shopify's test gateway)
-- and the one booked parcel sat at "New booked" for three days, because NovaX
-- marks an order fulfilled when a rider collects the parcel, and no rider was
-- ever going to collect a reviewer's parcel.
--
-- A NovaX account with clients.meta.shopify_review_mode = true (the reviewers'
-- account, and NovaX's own test account) now has its Shopify test orders
-- booked (edge function, allowTest) and its Shopify parcels marked "Collected
-- by rider" a minute after booking. The existing handover trigger then marks
-- the order ready, and the minute fulfillment job pushes the AWB to Shopify as
-- tracking. Real merchants are untouched: nothing here runs for an account
-- without the flag. Safe to run twice.

create or replace function public.nvsh_review_autocollect() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with due as (
    select p.id
      from public.parcels p
      join public.clients c on c.id = p.client_id and c.meta->>'shopify_review_mode' = 'true'
     where p.status = 'New booked'
       and coalesce(p.booked_at, p.updated_at) < now() - interval '60 seconds'
       and exists (select 1 from public.nvsh_order o
                     join public.nvsh_shop s on s.shop_domain = o.shop_domain and s.status = 'active'
                    where o.client_id = p.client_id and o.status = 'booked'
                      and (o.awb = p.awb or p.awb = any(o.extra_awbs)))
     limit 50
  )
  update public.parcels p set status = 'Collected by rider', updated_at = now()
    from due where p.id = due.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.nvsh_review_autocollect() from public, anon, authenticated;

-- Every minute, like the fulfillment job it feeds.
select cron.unschedule(jobid) from cron.job where jobname = 'novax-shopify-review-collect';
select cron.schedule('novax-shopify-review-collect', '* * * * *', 'select public.nvsh_review_autocollect();');

-- The two accounts in review mode.
update public.clients set meta = coalesce(meta, '{}'::jsonb) || '{"shopify_review_mode": true}'::jsonb
 where id in ('c385ed15-c33c-4ba4-b5c2-4754751ac82b',   -- Shopify Review Store (the reviewers)
              '7f74fc8c-0542-49dd-9bf5-0a9c344b6b57');  -- ark (NovaX's own test store, nova-test-sblskclr)
