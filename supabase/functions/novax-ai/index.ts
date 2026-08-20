// =====================================================================
// NovaX AI — Supabase Edge Function
//
// The model never touches the database. It calls tools; the tools are
// Postgres RPCs invoked with the MERCHANT'S OWN JWT, so every row is
// scoped by profiles.client_id = auth.uid(). A prompt-injected model
// still cannot read another merchant's parcels -- the database refuses.
//
// The ANTHROPIC_API_KEY lives only here, as a Supabase secret. It is
// never sent to the browser.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy novax-ai
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// The Messages API is called over plain fetch rather than the SDK: it
// removes an npm version pin from the cold path, and the wire format
// below (x-api-key + anthropic-version) is the documented contract.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- tuning knobs ---------------------------------------------------
// EFFORT is the main cost/latency lever. "medium" is a deliberate
// starting point for a support bot: Opus 5 performs unusually well at
// low/medium, and this is the dial to sweep once real traffic exists.
const MODEL = "claude-opus-5";
const EFFORT = "medium";        // low | medium | high | xhigh | max
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 6;      // hard stop so one message can't loop forever
const MIN_MS_BETWEEN_MESSAGES = 1500;

// NOTE: thinking is intentionally left at its default (adaptive) on
// Opus 5. Disabling it is a known trap -- the model can emit a tool call
// as plain text instead of a tool_use block, which would silently break
// every grounded lookup in this file.

function userTextForTrack(b: { message?: string }): string {
  const m = String(b.message ?? "").trim();
  return m || "[The customer just opened the tracking page. Tell them where their parcel is right now, in one or two sentences.]";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---- the tool surface ----------------------------------------------
// `present` is the terminal tool: the model delivers its final answer
// through it, which is how structured suggestions and result cards come
// back without a second API call.
type ToolUse = { type: string; id: string; name: string; input?: Record<string, unknown> };
type Block = { type: string; text?: string; [k: string]: unknown };

const TOOLS = [
  {
    name: "get_parcel",
    description:
      "Look up ONE parcel by its AWB number and return its live status, consignee, city, COD amount, and how many hours since it last moved. Accepts loose input — '1900021', 'n1900021' and 'AWB N1900021' all resolve. Call this whenever the merchant mentions a specific parcel or tracking number.",
    input_schema: {
      type: "object",
      properties: { awb: { type: "string", description: "The AWB / tracking number." } },
      required: ["awb"],
    },
  },
  {
    name: "list_parcels",
    description:
      "List this merchant's parcels, newest first, optionally filtered to one exact status (e.g. 'In transit', 'Delivered', 'New booked'). Returns the total matching count plus up to 50 rows. Use for 'show my parcels', 'how many delivered', 'what's in transit'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact status to filter by. Omit for all." },
        limit: { type: "integer", description: "Rows to return, 1-50. Default 20." },
      },
    },
  },
  {
    name: "check_exceptions",
    description:
      "Return every open parcel that carries an exception or has not moved in over 72 hours, with hours-stuck for each. Call this when the merchant asks about delays, stuck parcels, or problems — and when opening a conversation, to see if anything needs attention.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "wallet_summary",
    description:
      "Get this merchant's live wallet: balance, pending payouts, and what is available to withdraw. Use for any money, payout, COD-settlement or withdrawal question.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_invoices",
    description:
      "List this merchant's invoices, newest first, with their amounts and payment status. Use for billing, statement and 'what do I owe' questions.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "1-25. Default 10." } },
    },
  },
  {
    name: "rate_card",
    description:
      "Get this merchant's negotiated shipping rates — base rate and the per-zone rate card. Use for pricing, tariff and 'how much to ship' questions. Never quote a price without calling this first.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_parcels",
    description:
      "Search this merchant's parcels by any combination of status, destination city, consignee name, how recently they were booked, and how long they have sat without a status update. Prefer this over list_parcels whenever the merchant narrows by anything other than status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact status, e.g. 'In transit'." },
        city: { type: "string", description: "Destination city; partial match is fine." },
        consignee: { type: "string", description: "Customer name; partial match is fine." },
        days: { type: "integer", description: "Only parcels booked in the last N days." },
        stale_hours: { type: "integer", description: "Only parcels with no update for at least N hours." },
        limit: { type: "integer", description: "Rows to return, 1-25. Default 15." },
      },
    },
  },
  {
    name: "consignee_history",
    description:
      "How this customer's past parcels went — delivered, refused, or returned — looked up by phone number. Check this BEFORE advising whether to reattempt a delivery or send it back: a customer who has refused twice before is a different decision from a first-timer.",
    input_schema: {
      type: "object",
      properties: { phone: { type: "string", description: "The consignee's phone number." } },
      required: ["phone"],
    },
  },
  {
    name: "propose_booking",
    description:
      "Prefill the booking form from an order the merchant describes or pastes (WhatsApp order text works well). This does NOT create a parcel — it opens the normal booking form with the fields filled so the merchant reviews and submits it themselves. Always tell them to check the details before submitting.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Consignee name." },
        phone: { type: "string" },
        city: { type: "string" },
        address: { type: "string" },
        cod: { type: "string", description: "COD amount in PKR, digits only." },
        product: { type: "string" },
      },
    },
  },
  {
    name: "raise_ticket",
    description:
      "File a support ticket into the NovaX ticketing system for the operations team. Call this when you cannot resolve something from the data, when the merchant asks for a human, when a parcel needs physical investigation, or when the merchant is clearly frustrated. Always tell the merchant you have done it and give them the ticket reference.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short, specific subject line." },
        body: {
          type: "string",
          description:
            "Full context for the ops team: what the merchant asked, what you already checked, and what you could not resolve.",
        },
        awb: { type: "string", description: "Related AWB, if any." },
        priority: { type: "string", description: "Low | Normal | High | Urgent" },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "remember",
    description:
      "Store one durable fact about this merchant for future conversations (e.g. 'ships mostly to Lahore', 'prefers WhatsApp updates', 'runs a clothing brand'). Only store things that will still be useful next week. Never store a parcel status or anything that changes.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "One durable fact, written as a short sentence." },
      },
      required: ["fact"],
    },
  },
  {
    name: "propose_fix_address",
    description:
      "Offer to fill in a missing delivery address or phone on one parcel. This does NOT change anything — it shows the merchant a confirm button, and only their tap writes it. Use when a parcel has no address or phone and the merchant tells you what it should be. It can only fill blanks; it can never overwrite an address that already exists.",
    input_schema: {
      type: "object",
      properties: {
        awb: { type: "string" },
        address: { type: "string", description: "The full delivery address to write." },
        phone: { type: "string", description: "The consignee phone to write." },
      },
      required: ["awb"],
    },
  },
  {
    name: "propose_reattempt",
    description:
      "Offer to ask operations to reattempt a delivery. Shows the merchant a confirm button; only their tap files it. Use when a parcel was refused, the consignee was unavailable, or the merchant asks for another attempt. Check consignee_history first — if this customer has refused repeatedly, say so before offering.",
    input_schema: {
      type: "object",
      properties: {
        awb: { type: "string" },
        note: { type: "string", description: "Why a reattempt is being asked for." },
      },
      required: ["awb"],
    },
  },
  {
    name: "present",
    description:
      "Deliver your final answer to the merchant. You MUST end every turn by calling this exactly once — it is the only thing the merchant actually sees. Everything else is internal.",
    input_schema: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description:
            "What you are telling the merchant. Lead with the outcome. Plain sentences, no markdown headers, no bullet walls. Match their language — reply in Roman Urdu if they wrote Roman Urdu.",
        },
        cards: {
          type: "array",
          description:
            "Structured results to render as cards — parcels, money figures, tickets. Use these instead of listing data in the answer text.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "parcel | money | ticket | stat" },
              title: { type: "string" },
              subtitle: { type: "string" },
              status: { type: "string" },
              lines: {
                type: "array",
                description: "Label/value pairs, e.g. ['COD','Rs 2,500'].",
                items: { type: "array", items: { type: "string" } },
              },
            },
            required: ["kind", "title"],
          },
        },
        suggestions: {
          type: "array",
          description:
            "2-3 short next things this merchant would plausibly want, phrased as the merchant would say them ('Chase the stuck ones', 'When do I get paid?'). Always offer some.",
          items: { type: "string" },
        },
        resolved: {
          type: "boolean",
          description: "True if the merchant's question is fully answered and needs no follow-up.",
        },
      },
      required: ["answer"],
    },
  },
];

// ---- who NovaX AI is ------------------------------------------------
function systemPrompt(digest: Record<string, unknown>): string {
  return `You are NovaX AI, the operations intelligence built into NovaX Logistics — a courier and fulfilment company in Pakistan. You speak directly to the merchant whose account you are looking at.

You are not a support script. You have live read access to this merchant's real parcels, wallet, invoices and rates, and you are expected to look things up and give a straight answer rather than ask them to check the portal themselves.

## How you work

Look before you answer. Every factual claim you make — a status, an amount, a date, a rate — must come from a tool call you made in this turn. If you did not look it up, do not assert it.

Never predict a delivery date or promise when something will arrive. Riders carry these parcels; a guess from you becomes a promise the merchant makes to their own customer. Report the current status and when it last moved. If they push for an ETA, say plainly that you report status rather than predict arrival, and offer to raise a ticket so ops can chase it.

Answer in the language the merchant writes in. Roman Urdu in, Roman Urdu out — "aap ka parcel abhi Lahore hub mein hai" — not a translated-English reply. Urdu script in, Urdu script out. Mixed is fine; follow their lead.

When you cannot resolve something — the data does not explain it, it needs someone to physically check, or they ask for a human — raise a ticket and tell them you did, with the reference. Never end a conversation with "please contact support". You are what they contacted.

## Style

Lead with the answer. First sentence is the outcome — what happened, what you found, what it means for them. Detail after.

Keep it short. Two or three sentences of text, with the data itself in cards rather than written out. Never restate a card's contents in the answer.

Put facts and figures in \`cards\`, not prose. Parcel lookups become parcel cards; money becomes money cards; a filed ticket becomes a ticket card.

Always offer suggestions — two or three things this merchant would plausibly want next, phrased the way they would say them.

Be direct and warm without being chirpy. No "Certainly!", no "I'd be happy to help", no exclamation marks. They are running a business and want the answer.

## This merchant, right now

${JSON.stringify(digest, null, 2)}

Facts under "remembered_facts" are things you learned in earlier conversations — use them naturally, and use the \`remember\` tool when you learn something new that will still matter next week.

End every turn by calling \`present\` exactly once. It is the only thing the merchant sees.`;
}

// ---- handler --------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "NovaX AI is not configured yet." }, 503);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in." }, 401);

  // The merchant's own JWT — never the service-role key. This is what
  // keeps one merchant's tools from reaching another's rows.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  let body: { conv_id?: string; message?: string; mode?: string; token?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request body." }, 400); }

  // ── Public tracking mode ────────────────────────────────────────────
  // Called from tracking.html by a consignee with no account. Scoped by
  // the tracking token in the link, not by client_id, and deliberately
  // narrow: one parcel, one tool, no history, no quota, no writes. The
  // merchant's own data is unreachable from here.
  if (body.mode === "track") {
    const token = String((body as Record<string, unknown>).token ?? "").trim();
    if (!token) return json({ error: "No tracking reference." }, 400);

    const { data: lookup } = await sb.rpc("ai_public_parcel", { p_token: token });
    if (!lookup || (lookup as Record<string, unknown>).found !== true) {
      return json({
        answer: "I could not find a parcel for that tracking link. Double-check the link, or ask the shop you ordered from.",
        suggestions: [],
      });
    }

    const publicSystem = `You are NovaX AI, answering for NovaX Logistics — a Pakistani courier — on a public tracking page. You are speaking to the person WAITING for this parcel, not the shop that sent it.

You can see exactly one parcel, shown below. That is everything you know.

${JSON.stringify(lookup, null, 2)}

Answer only about this parcel. If they ask about anything else — another order, their account, the shop's business — say you can only see this one parcel from this link.

Never predict a delivery date. Riders carry these parcels and a guess from you becomes a broken promise. Say where it is and when it last moved. If they need it faster or want to change the address, tell them to contact the shop they ordered from, because the shop is who instructs us.

Answer in the language they write in — Roman Urdu in, Roman Urdu out.

Be brief and warm. Two or three sentences. End by calling present exactly once.`;

    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          output_config: { effort: "low" },
          system: publicSystem,
          tools: TOOLS.filter((t) => t.name === "present"),
          tool_choice: { type: "tool", name: "present" },
          messages: [{ role: "user", content: userTextForTrack(body) }],
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json() as { content: Block[] };
      const block = data.content.find((b) => b.type === "tool_use") as unknown as ToolUse | undefined;
      const out = (block?.input ?? {}) as Record<string, unknown>;
      return json({
        answer: String(out.answer ?? "Here is where your parcel is."),
        cards: out.cards ?? [],
        suggestions: out.suggestions ?? [],
        parcel: (lookup as Record<string, unknown>).parcel,
      });
    } catch (e) {
      console.error("NovaX AI public track failed:", e);
      const p = (lookup as Record<string, Record<string, unknown>>).parcel;
      return json({
        answer: `Your parcel ${p?.awb} is currently "${p?.status}"${p?.city ? " in " + p.city : ""}.`,
        cards: [],
        suggestions: [],
        parcel: p,
      });
    }
  }

  const mode = body.mode === "open" ? "open" : "chat";
  const userText = (body.message ?? "").trim();
  if (mode === "chat" && !userText) return json({ error: "Empty message." }, 400);

  // ---- burst guard: one message per 1.5s per merchant ---------------
  if (mode === "chat" && body.conv_id) {
    const { data: recent } = await sb
      .from("nv_ai_messages")
      .select("created_at")
      .eq("conv_id", body.conv_id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1);
    const last = recent?.[0]?.created_at ? Date.parse(recent[0].created_at) : 0;
    if (last && Date.now() - last < MIN_MS_BETWEEN_MESSAGES) {
      return json({ error: "rate_limited", answer: "One moment — still working on the last one." }, 429);
    }
  }

  // ---- the 50-message cap -------------------------------------------
  if (mode === "chat") {
    const { data: q } = await sb.rpc("ai_quota_consume");
    if (!q?.ok) {
      const status = (await sb.rpc("ai_quota_status")).data ?? {};
      return json({
        capped: true,
        quota: status,
        answer:
          "You've used all 50 NovaX AI messages on this account. I've kept everything we discussed — request more and an admin can top you back up.",
      }, 200);
    }
  }

  // ---- context ------------------------------------------------------
  const { data: digest, error: digestErr } = await sb.rpc("ai_context_digest");
  if (digestErr || !digest || (digest as Record<string, unknown>).error) {
    return json({ error: "Could not read your account. Try again in a moment." }, 500);
  }

  let convId = body.conv_id ?? null;
  if (!convId) {
    const { data: newConv } = await sb.rpc("ai_conv_start", { p_title: null });
    convId = newConv ?? null;
  }

  const history: Array<{ role: string; content: string }> =
    convId && mode === "chat" ? ((await sb.rpc("ai_history", { p_conv: convId, p_limit: 16 })).data ?? []) : [];

  const messages: Array<{ role: string; content: unknown }> = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  messages.push({
    role: "user",
    content: mode === "open"
      ? "[The merchant just opened NovaX AI. Check whether anything needs their attention right now, then greet them by opening with the single most useful thing you found — not a generic hello. Keep it to one or two sentences and offer suggestions.]"
      : userText,
  });

  if (mode === "chat" && convId) {
    await sb.rpc("ai_msg_log", { p_conv: convId, p_role: "user", p_content: userText });
  }

  // ---- tool dispatch ------------------------------------------------
  // Every branch is a Postgres RPC executed as the merchant. Wallet and
  // insights reuse the EXISTING client_* RPCs rather than reimplementing
  // money logic here.
  const runTool = async (name: string, input: Record<string, unknown>) => {
    try {
      switch (name) {
        case "get_parcel":
          return (await sb.rpc("ai_tool_get_parcel", { p_awb: String(input.awb ?? "") })).data;
        case "list_parcels":
          return (await sb.rpc("ai_tool_list_parcels", {
            p_status: input.status ? String(input.status) : null,
            p_limit: Number(input.limit ?? 20),
          })).data;
        case "check_exceptions":
          return (await sb.rpc("ai_tool_exceptions")).data;
        case "wallet_summary":
          return (await sb.rpc("client_wallet_summary")).data;
        case "list_invoices":
          return (await sb.rpc("ai_tool_list_invoices", { p_limit: Number(input.limit ?? 10) })).data;
        case "rate_card":
          return (await sb.rpc("ai_tool_rate_card")).data;
        case "search_parcels":
          return (await sb.rpc("ai_tool_search_parcels", {
            p_status: input.status ? String(input.status) : null,
            p_city: input.city ? String(input.city) : null,
            p_consignee: input.consignee ? String(input.consignee) : null,
            p_days: input.days ? Number(input.days) : null,
            p_stale_hours: input.stale_hours ? Number(input.stale_hours) : null,
            p_limit: Number(input.limit ?? 15),
          })).data;
        case "consignee_history":
          return (await sb.rpc("ai_tool_consignee_history", { p_phone: String(input.phone ?? "") })).data;
        case "propose_booking":
          // Writes nothing. The draft is handed to the widget, which opens
          // the merchant's normal booking form pre-filled.
          bookingDraft = {
            name: String(input.name ?? ""), phone: String(input.phone ?? ""),
            city: String(input.city ?? ""), address: String(input.address ?? ""),
            cod: String(input.cod ?? ""), product: String(input.product ?? ""),
          };
          return {
            proposed: true,
            note: "The booking form will open pre-filled. Nothing is created until the merchant reviews the fields and submits it themselves — tell them that.",
          };
        case "propose_fix_address":
          pendingAction = {
            type: "fix_address",
            awb: String(input.awb ?? "").toUpperCase(),
            address: String(input.address ?? ""),
            phone: String(input.phone ?? ""),
            label: "Save this address",
          };
          return { proposed: true, note: "A confirm button is now showing. Nothing is written until the merchant taps it — tell them to check the address first." };
        case "propose_reattempt":
          pendingAction = {
            type: "reattempt",
            awb: String(input.awb ?? "").toUpperCase(),
            note: String(input.note ?? ""),
            label: "Request reattempt",
          };
          return { proposed: true, note: "A confirm button is now showing. Nothing is filed until the merchant taps it." };
        case "raise_ticket":
          return (await sb.rpc("ai_tool_raise_ticket", {
            p_subject: String(input.subject ?? ""),
            p_body: String(input.body ?? ""),
            p_awb: String(input.awb ?? ""),
            p_priority: String(input.priority ?? "Normal"),
          })).data;
        case "remember":
          return (await sb.rpc("ai_tool_remember", { p_fact: String(input.fact ?? "") })).data;
        default:
          return { error: `unknown tool ${name}` };
      }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  };

  // ---- the loop -----------------------------------------------------
  const toolsUsed: string[] = [];
  let bookingDraft: Record<string, string> | null = null;
  let pendingAction: Record<string, string> | null = null;
  let presented: Record<string, unknown> | null = null;

  const askClaude = async (msgs: Array<{ role: string; content: unknown }>) => {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        system: systemPrompt(digest as Record<string, unknown>),
        tools: TOOLS,
        messages: msgs,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`anthropic ${r.status}: ${detail.slice(0, 300)}`);
    }
    return await r.json() as {
      content: Block[];
      stop_reason: string;
    };
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && !presented; round++) {
      const response = await askClaude(messages);

      if (response.stop_reason === "refusal") {
        presented = {
          answer:
            "I can't help with that one. If it's about your parcels, payouts or rates, ask me again and I'll look it up.",
          suggestions: ["Show my stuck parcels", "What's my wallet balance?"],
        };
        break;
      }

      // Echo the full assistant turn back — thinking blocks included.
      // Stripping them breaks the next turn on a thinking model.
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Block & ToolUse => b.type === "tool_use",
      ) as unknown as ToolUse[];

      // The model delivering its answer ends the loop.
      const finalBlock = toolUses.find((t) => t.name === "present");
      if (finalBlock) {
        presented = finalBlock.input as Record<string, unknown>;
        break;
      }

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        // It answered in plain text without calling present. Salvage it
        // rather than showing the merchant nothing.
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n")
          .trim();
        presented = { answer: text || "I couldn't put that together. Ask me again?" };
        break;
      }

      const results: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        toolsUsed.push(tu.name);
        const out = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out ?? { error: "no data" }),
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error("NovaX AI model call failed:", e);
    return json({
      error: "model_failed",
      answer: "I couldn't reach my reasoning service just now. Try again in a moment.",
    }, 502);
  }

  if (!presented) {
    presented = {
      answer:
        "That one took more digging than I could finish. I can raise it with the operations team if you'd like.",
      suggestions: ["Raise a ticket for this", "Show my stuck parcels"],
    };
  }

  const answer = String(presented.answer ?? "").trim();
  if (convId) {
    await sb.rpc("ai_msg_log", {
      p_conv: convId,
      p_role: "assistant",
      p_content: answer,
      p_tools: toolsUsed.length ? toolsUsed : null,
    });
  }

  const { data: quota } = await sb.rpc("ai_quota_status");

  // Two shapes from one call: answer/cards/suggestions drive the NovaX AI
  // console; reply/actions are the shape the floating widget understands.
  const suggestions = Array.isArray(presented.suggestions) ? presented.suggestions : [];
  const actions: Array<Record<string, unknown>> = [];
  if (bookingDraft) {
    actions.push({ label: "Review & Book", kind: "local", type: "prefill_booking", draft: bookingDraft });
  }
  if (pendingAction) {
    actions.push({ label: pendingAction.label, kind: "local", type: "confirm_action", action: pendingAction });
  }
  for (const sug of suggestions.slice(0, 3)) {
    if (sug) actions.push({ label: String(sug), kind: "send", message: String(sug) });
  }

  return json({
    conv_id: convId,
    answer,
    reply: answer,
    cards: presented.cards ?? [],
    suggestions,
    actions,
    draft: bookingDraft,
    pending_action: pendingAction,
    resolved: presented.resolved ?? false,
    intent: "brain",
    source: "brain:anthropic",
    toolsUsed,
    tools_used: toolsUsed,
    quota: quota ?? null,
  });
});
