# NovaX AI — setup

Four pieces are built and committed. Everything works except the last
step, which needs an Anthropic API key.

## 1. Database (2 minutes)

Run **`sql_novax_ai_core.sql`** in the Supabase SQL editor. If the
dashboard mangles a function body, split at the `---- PART n ----`
markers and run each in its own tab.

It creates the conversation/memory/quota tables, the 50-message cap with
admin approval, and the grounded tool RPCs. Every tool filters on
`profiles.client_id = auth.uid()`, so one merchant's AI can never read
another merchant's rows.

Verify:

```sql
select routine_name from information_schema.routines
 where routine_schema='public' and routine_name like 'ai_%'
 order by routine_name;
```

Expect 12 `ai_*` functions.

## 2. Get an API key

console.anthropic.com → **API keys** → create one. Then:

- **Plans & Billing** → add **$5**
- Set a **monthly spend limit of $5** so it cannot exceed that

## 3. Deploy the Edge Function

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
supabase functions deploy novax-ai
```

The key lives only in Supabase. It is never sent to a browser.

## 4. Push the front end

`client.html` and `admin.html` are already committed — a normal push
deploys them.

---

## What it does

**Opens the conversation itself.** When a merchant opens Support, NovaX
AI checks their account first and leads with what needs attention —
not "how can I help you?".

**Answers from live data.** It calls tools (parcel lookup, wallet,
invoices, rates, exceptions) and every claim traces to a tool result.
It cannot invent a delivery status.

**Shows results as cards**, not paragraphs — parcel cards, money cards,
ticket cards.

**Always suggests next steps**, so the merchant never faces a blank box.

**Files tickets** through the existing `novax_ticket_open` RPC when it
can't resolve something. AI inquiries land in the Tickets tab you
already have — not a parallel system.

**Remembers** durable facts between conversations.

**Replies in the merchant's language** — Roman Urdu in, Roman Urdu out.

**Never predicts a delivery date.** It reports status and when a parcel
last moved, and offers a ticket instead of guessing an ETA.

## Limits and controls

| Control | Where | Default |
|---|---|---|
| Messages per merchant | `nv_ai_usage.cap` | **50** |
| Reset | Admin → **NOVAX AI** tab | Approve/deny per request |
| Burst guard | Edge Function | 1 message / 1.5s |
| Tool rounds per message | Edge Function | 6 |
| Cost lever | `EFFORT` in `index.ts` | `medium` |

When a merchant hits 50, the composer is replaced by a **Request more
from admin** button. That request appears in the admin NOVAX AI tab with
a badge. Approving zeroes their counter.

## Tuning cost

`MODEL` and `EFFORT` at the top of
`supabase/functions/novax-ai/index.ts` are the two dials.

- `EFFORT` — `low` / `medium` / `high` / `xhigh` / `max`. Starts at
  `medium`. Sweep down once you see real traffic.
- `MODEL` — `claude-opus-5` by default. `claude-sonnet-5` or
  `claude-haiku-4-5` cost less per message.

Do **not** set `thinking: {type:"disabled"}` on Opus 5. With thinking
off it can emit a tool call as plain text — the call silently never
runs, and every grounded lookup here depends on tool calls firing.
