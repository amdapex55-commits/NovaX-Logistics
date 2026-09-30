# NovaX transactional emails

Activated on 2026-09-27 in project `rhzunbzbdzicajqtohwp`. This worker handles:

| Event | Recipient | Frequency |
| --- | --- | --- |
| Public merchant auth account created | Signup email | Once per auth user |
| First parcel inserted, from portal/API/Shopify/admin | Workspace owner login | Once per workspace |
| Withdrawal status changes to `Paid` | Workspace owner login | Once per withdrawal |
| No parcel booked yet, 1, 3 and 7 days after signup | Workspace owner login | At most three, 44 h apart |

First-parcel reminders (`sql_novax_first_parcel_reminders_20260930.sql`) are queued by the
hourly job `novax-first-parcel-reminders`, Monday to Saturday 10 am to 8 pm PKT, and only
while fewer than 80 emails went out in the last 24 hours (Resend's free plan allows 100).
They stop when the merchant books, uses the "Stop these reminders" link
(`unsubscribe.html` → `nv_email_reminders_stop`), turned email off, or the account is not
active. Switch the job on or off with
`cron.alter_job((select jobid from cron.job where jobname = 'novax-first-parcel-reminders'), active := true|false)`.

Sender: `NovaX Logistics <updates@auth.novaxlogistics.com>` on the already verified
Resend domain. This address does not create a receiving mailbox. OTP, verification
and password reset emails continue through the separately configured Supabase SMTP.
Welcome does not claim verification or workspace provisioning has completed.

Production verification: three triggers installed, cron job 16 active, no historical
emails queued, private worker invocation HTTP 200 with an empty queue, unauthenticated
POST HTTP 403. The approved existing scheduler token is reused; its digest matched
the Edge secret without exposing it. No production payout was fabricated or changed.
Actual inbox delivery remains to be checked on a real new event or consenting test.
Email buttons target Money, the booked AWB, or Support. The client portal preserves
these known destinations through sign-in in the same tab for up to 15 minutes.

## Activation Order

1. Privately add `RESEND_API_KEY` to this project's Supabase Edge Function secrets.
   Use sending access restricted to `auth.novaxlogistics.com`. The SMTP password is
   not automatically available to Edge Functions. Never put this key in frontend
   JavaScript, a committed file or chat. Rotate any key exposed in screenshots/logs.
2. Privately generate a random token of at least 32 characters. Store the same value
   as Edge secret `NOVAX_EMAIL_DRAIN_TOKEN` and Vault secret `novax_email_drain_token`.
   Keep it separate from the Resend key. Supabase supplies `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` to the function.
   Alternatively, with owner approval, the worker can reuse the existing Edge
   `DRAIN_TOKEN` and database `nv_api_drain_token()` credential. Check that its
   SHA-256 digest matches the Edge secret before activation, without displaying
   the token. A dedicated token remains preferable for independent rotation.
3. Apply `sql_novax_email_notifications_20260927.sql` in the NovaX project. This
   installs the queue and triggers, but sends nothing itself. It briefly locks
   parcels and withdrawals while recording historical milestones; run off-peak.
4. Deploy only this function, with platform JWT verification disabled because the
   endpoint enforces its own private token:

   ```sh
   supabase functions deploy novax-email-drain --project-ref rhzunbzbdzicajqtohwp --no-verify-jwt
   ```

5. Test with a consenting test merchant: create an account, book one parcel, then
   another. Expect one welcome and one first-booking email, not two booking emails.
   Test a payout transition only with an authorised fixture in staging, not by
   inventing a paid production withdrawal. Invoke the worker privately with a POST
   and `x-novax-email-drain` header. Inspect the queue and Resend delivery record.
6. Apply `sql_novax_email_schedule_20260927.sql` to enable a one-minute cron drain.
   This is deliberately separate so deployment/setup cannot accidentally start
   sending before credentials and templates are approved.

The schedule is specific to the NovaX production project. For staging, replace its
Edge URL before applying it. Verify Vault, pg_net and pg_cron are enabled and that
the existing project does not grant browser roles access to Vault decrypted secrets.

## Reliability And Operations

- Committed database events enqueue within the same transaction. Rollbacks send
  nothing. No email network failure blocks signup, booking or payout; unexpected
  enqueue errors emit a SQLSTATE-only database warning and need operator follow-up.
- New triggers do not send old welcome/payout/booking notifications. Existing
  parcels and paid withdrawals are seeded as milestones without messages.
- Owner recipients come from `auth.users` linked to client profiles, not customer
  addresses. Invited staff, revoked owners and finance-only seats are excluded.
  Missing recipients go to `review`, not a fallback arbitrary email address.
- Net payout, gross and fee must reconcile before sending. No IBAN, bank proof,
  consignee address, password, OTP or service key is included.
- Queue keys, exclusive leases, frozen request bodies and Resend idempotency keys
  prevent repeat sends in the automatic retry window. Automatic retries stop
  after eight attempts or 23 hours from first send preparation, whichever comes
  first. Do not clear a milestone or blindly resend an uncertain old job: Resend
  only retains keys for 24 hours. Inspect provider logs before any manual recovery.
- `accepted` means the Resend API accepted the message, not inbox delivery. Check
  Resend for delivered/bounced events. Delivery webhooks are not implemented here.
- Up to five messages per cron invocation, paced between requests. Watch backlog,
  auth abuse and provider quotas. A public signup welcome can be abused, so retain
  Supabase signup CAPTCHA/rate limits and ensure verified sending-domain limits.
- Missing configuration fails closed. The worker never accepts `to`, message body,
  template choice or other sending instructions from its HTTP caller.

Operator-only queue summary:

```sql
select kind, state, count(*), min(created_at) as oldest
from public.nv_email_queue group by kind, state order by kind, state;

select id, kind, last_error, attempts, created_at
from public.nv_email_queue where state = 'review' order by created_at;
```

Pause sending without touching business flows:

```sql
select cron.unschedule('novax-transactional-email');
```

Pending messages and immutable milestone keys remain for inspection. Plan a
retention policy for recipient/snapshot/message data before long-term operation;
do not delete milestone keys, which protect against repeat notifications.

## Local Checks

```sh
node scripts/test-email-notifications.mjs --previews /Users/aisha/Desktop/NovaX-Email-Previews
node scripts/test-email-notifications-sql.mjs
node scripts/test-email-return-links.mjs
```

The SQL suite starts an isolated local PostgreSQL database with fake data and
stops it afterward. It never contacts the live Supabase project. Use `PG_BIN` to
override the default Homebrew PostgreSQL 17 binary directory.

References: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions).
