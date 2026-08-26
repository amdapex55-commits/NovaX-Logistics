# Restore drill — NovaX Logistics

Everything automated watches WAL *shipping*. Nothing proves a restore *lands*.
This is the only step that does, and it is the only step that cannot be
automated from here: creating a restored project is a Supabase dashboard
action on Aisha's account.

Run it once now, then once a quarter.

## Why the canary exists

`nv_backup_canary` writes one row an hour carrying a fingerprint of the counts
that matter. Without it, checking a restore means eyeballing whether parcels
look missing. With it, you compare two numbers.

As of 26 Aug 2026 01:07 there are **19 beats**, hourly, oldest 25 Aug 07:35 —
enough history to pick a restore point and have something to compare against.

## Before you start — the current fingerprint

Run this on **production** and keep the output:

```sql
select beat_at, fingerprint
from public.nv_backup_canary
order by id desc
limit 5;
```

Latest at time of writing:

```
clients 216 · parcels 385 · invoices 123
ledger_rows 345 · ledger_sum 12674
wal_lsn DE/E5002838 · newest_parcel 2026-08-25T00:00:00+00:00
```

## The drill

1. **Supabase dashboard → Database → Backups → Restore.**
   Choose **restore to a new project**, never in place. Pick a point in time
   roughly **one hour ago** — recent enough that a canary beat exists near it,
   old enough that the answer is not trivially "now".

2. **Write down the exact timestamp you asked for.** The whole test is whether
   the restore lands where the UI claims.

3. When the restored project is up, connect to it and run:

   ```sql
   select beat_at, fingerprint
   from public.nv_backup_canary
   order by id desc
   limit 3;
   ```

4. **Check the landing point.** The newest `beat_at` should be at or just
   before the timestamp you chose — within one hour, since beats are hourly.
   Much older means the restore did **not** land where the UI said, and PITR
   is not doing what you think.

5. **Check the data matches that moment.** Compare the restored fingerprint
   against the production beat closest to your chosen time. They should be
   identical. If the restored one is thinner, the restore is short.

6. **Spot-check money.** On the restored project:

   ```sql
   with led as (
     select client_id, sum(amount) bal
     from wallet_ledger where affects_balance group by client_id)
   select count(*) as wallets_disagreeing_with_their_ledger
   from clients c left join led l on l.client_id = c.id
   where abs(coalesce(c.wallet_balance,0) - coalesce(l.bal,0)) > 0.01;
   ```

   Must be **0**, same as production. A restore that resurrects the KKM SWEETS
   class of bug is not a usable restore.

7. **Delete the restored project.** It bills separately.

## What "pass" means

- Newest canary beat within an hour of the point you asked for
- Fingerprint matches the production beat from that same time
- Zero wallet/ledger disagreements

Anything else: stop and treat the backup as unproven until it is understood.

## What this does not cover

Edge Function code, Edge Function secrets (`ANTHROPIC_API_KEY`), storage
buckets, and Auth users are **not** part of a Postgres PITR restore. If the
project were lost entirely, those are separate recoveries. Worth knowing
before you need to know it.
