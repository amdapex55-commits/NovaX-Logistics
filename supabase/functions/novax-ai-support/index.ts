// Supabase Edge Function: novax-ai-support
// "NovaX Autopilot" support layer — deterministic, DB-driven, never fabricated.
//
// Deploy as a Supabase Edge Function named exactly "novax-ai-support", with
// --no-verify-jwt (see notes below). Caller identity is verified INSIDE this
// function by resolving the caller's own session JWT via admin.auth.getUser().
//
// v3: adds "Client Autopilot Memory" (a per-seller context snapshot pulled
// fresh from the DB on every request — active/delayed/return parcels,
// wallet balance, latest invoice, open tickets, issue rate, health score),
// smart follow-up action buttons on every reply, auto ticket-department
// classification, a customer-reply generator, and best-effort WhatsApp
// booking-text extraction. Nothing here is cached across requests — Deno
// edge functions are stateless, so "memory" means "fresh DB read every
// time", not an in-memory session.
//
// Abuse controls (unchanged from v2):
//   - Origin/Referer allowlist so only the real NovaX site can call this.
//   - Per-identity (client id, else IP) request rate limit.
//   - Separate, stricter per-identity ticket-creation rate limit.
//   - Public (unauthenticated) tracking/reply replies never include internal
//     exception notes — only status/city/last-updated.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://novaxlogistics.com",
  "https://www.novaxlogistics.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function matchedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  const referer = req.headers.get("referer");
  if (referer) {
    const hit = ALLOWED_ORIGINS.find((o) => referer.startsWith(o));
    if (hit) return hit;
  }
  return null;
}

function isAllowedCaller(req: Request): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) return true; // non-browser/server test callers
  return matchedOrigin(req) !== null;
}

function corsHeaders(req: Request): Record<string, string> {
  const allow = matchedOrigin(req) || ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

// Requires at least one letter so it never collides with bare phone numbers
// (this app's real AWBs look like "N0010001" — letter prefix + digits).
function extractAwb(message: string): string | null {
  if (!message) return null;
  const up = String(message).toUpperCase();
  const strict = up.match(/\bN\d{6,8}\b/);
  if (strict) return strict[0];
  const loose = up.match(/\b[A-Z]{1,4}\d{5,}\b/);
  return loose ? loose[0].trim() : null;
}

const PK_PHONE_RE = /(?:\+92|0)\s?3\d{2}[\s-]?\d{7}\b|\b3\d{9}\b/;

type Intent =
  | "track"
  | "return"
  | "cod"
  | "human"
  | "greeting"
  | "attention"
  | "health"
  | "briefing"
  | "reply"
  | "whatsapp"
  | "client_summary"
  | "print_awb"
  | "book_now"
  | "unknown";

function detectIntent(message: string, hasAwb: boolean): Intent {
  const t = String(message || "").toLowerCase().trim();
  if (!t && !hasAwb) return "greeting";
  if (/\b(open a|raise a|file a|need a)\s*ticket\b|\bcomplaint\b|\bescalate\b/.test(t)) return "human";
  // Account-level count/summary questions must always answer from real data —
  // never fall through to a generic "unclear request" ticket.
  if (/how many parcels?|\bmy summary\b|\baccount summary\b|kitne parcels?|kitna parcel|total parcels?|today('s)? status|overall status|parcels? (on|in) my account|summary of my account/.test(t)) return "client_summary";
  if (/\bprint\b[^.]{0,15}\bawbs?\b|print label|print my awb/.test(t)) return "print_awb";
  if (/\bbook\b[^.]{0,15}(parcel|order|shipment)|\bnew booking\b|\bcreate (a )?booking\b|\bbook now\b/.test(t)) return "book_now";
  if (/what needs (my )?attention|needs my attention|\burgent\b|\bpriority\b|anything (urgent|pending)/.test(t)) return "attention";
  if (/health score|delivery health|how (am|are) (i|we) doing|\bscore\b/.test(t)) return "health";
  if (/good morning|daily briefing|\bbriefing\b|start my day|morning briefing/.test(t)) return "briefing";
  if (/customer (says|is angry|complain)|angry customer|what (do|should) i (say|reply)|reply to (the )?customer|whatsapp reply|draft a reply/.test(t)) return "reply";
  if (/\breturn\b|\brefund\b|\bdamage\b|\bcomplain/.test(t)) return "return";
  // "paisay"/"paisa" (Roman Urdu for money) covers COD/payout questions like
  // "paisay kab ayenge" that don't use the English words cod/wallet/payout.
  if (/\bcod\b|\bwallet\b|\bpayout\b|\bbalance\b|\bwithdraw|why is my cod|cod less|paisay|\bpaisa\b|rupay kab/.test(t)) return "cod";
  if (/\bagent\b|\bhuman\b|\btalk to (someone|support)\b|\bcall me\b/.test(t)) return "human";
  // \bparcels?\b / \bawbs?\b so plural forms ("parcels", "AWBs") still match.
  if (hasAwb || /\btrack\b|\bstatus\b|\bawbs?\b|\bwhere is\b|\bparcels?\b/.test(t)) return "track";
  if (PK_PHONE_RE.test(t) && t.length > 25) return "whatsapp"; // pasted WhatsApp-style customer message
  return "unknown";
}

// ---- Human handoff rules: these always win, regardless of what intent the
// wording otherwise looks like. Detected independently of detectIntent() so
// an angry/legal/dispute message never gets a routine automated answer. ----
type HandoffReason =
  | "angry customer"
  | "legal/threat language"
  | "lost parcel"
  | "COD dispute"
  | "repeated failed delivery"
  | "damaged item"
  | "payment mismatch";

function detectHandoff(message: string): HandoffReason | null {
  const t = String(message || "").toLowerCase();
  if (!t) return null;
  if (/\b(lawyer|legal action|\bsue\b|court|\bfir\b|police|thana|threat)\b/.test(t)) return "legal/threat language";
  if (/\b(scam|fraud|useless|worst service|very angry|furious|unacceptable|horrible service|disgusting|angry|naraz|ghussa|pareshan)\b/.test(t)) return "angry customer";
  if (/\blost\b[^.]{0,25}\bparcel\b|\bparcel\b[^.]{0,25}\blost\b|missing parcel|parcel is missing/.test(t)) return "lost parcel";
  if (/cod (mismatch|wrong|short|dispute)|wrong (cod )?amount|amount (is )?wrong|cod (galat|kam)/.test(t)) return "COD dispute";
  if (/(again and again|multiple times|every time|kai baar|har baar|repeated)[^.]{0,25}(fail|not delivered|no call|nahi ki|nahi hua)/.test(t)) return "repeated failed delivery";
  if (/\b(damaged|damage|broken|toota|torn|smashed|kharab item)\b/.test(t)) return "damaged item";
  if (/payment (mismatch|wrong|doesn't match|does not match)|amount (doesn't|does not) match|invoice (wrong|mismatch)/.test(t)) return "payment mismatch";
  return null;
}

const SAFE_STATUS_NOTE: Record<string, string> = {
  "Delivered": "delivered",
  "Parcel out for delivery": "currently out for delivery",
  "Refused": "marked refused by the consignee",
  "Consignee not available": "attempted, but the consignee was not available",
  "Reattempt": "scheduled for a reattempt",
  "Reassigned": "reassigned to another rider",
  "Out of service area": "flagged out of service area",
  "Ready for return": "marked ready for return",
  "Return in transit": "on its way back to origin",
  "Return received at origin": "received back at origin",
  "Return out for delivery": "out for return delivery to you",
  "Parcel returned to consignee": "returned to the consignee",
};

const TERMINAL_STATUSES = new Set(["Delivered", "Parcel returned to consignee"]);
const RETURN_STATUSES = new Set([
  "Refused",
  "Consignee not available",
  "Ready for return",
  "Return in transit",
  "Return received at origin",
  "Return out for delivery",
  "Parcel returned to consignee",
]);
const DAY_MS = 24 * 60 * 60 * 1000;

type ParcelRow = {
  id: string;
  awb: string;
  status: string;
  city: string | null;
  updated_at: string | null;
  exception: string | null;
  cod_amount: number | null;
  client_id: string | null;
};

// ---- Client Autopilot Memory: one fresh, DB-grounded context snapshot ----
async function loadClientContext(admin: ReturnType<typeof createClient>, clientId: string) {
  const [{ data: parcels }, { data: clientRow }, { data: invoices }, { data: tickets }] = await Promise.all([
    admin
      .from("parcels")
      .select("id, awb, status, city, updated_at, exception, cod_amount, client_id")
      .eq("client_id", clientId)
      .order("updated_at", { ascending: false })
      .limit(500),
    admin.from("clients").select("wallet_balance").eq("id", clientId).maybeSingle(),
    admin
      .from("invoices")
      .select("id, code, net_payable, status, meta, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("tickets")
      .select("id, subject, status, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const list: ParcelRow[] = parcels || [];
  const active = list.filter((p) => !TERMINAL_STATUSES.has(p.status));
  const nowMs = Date.now();
  const delayed = active.filter((p) => p.updated_at && nowMs - new Date(p.updated_at).getTime() > DAY_MS);
  const returned = list.filter((p) => RETURN_STATUSES.has(p.status));
  const problemParcels = list.filter((p) => p.exception || RETURN_STATUSES.has(p.status));
  const issueRate = list.length ? problemParcels.length / list.length : 0;
  const delayRate = active.length ? delayed.length / active.length : 0;
  const returnRate = list.length ? returned.length / list.length : 0;
  const health = Math.max(0, Math.min(100, Math.round(100 - issueRate * 40 - delayRate * 30 - returnRate * 30)));

  const cityCounts: Record<string, number> = {};
  problemParcels.forEach((p) => {
    if (p.city) cityCounts[p.city] = (cityCounts[p.city] || 0) + 1;
  });
  let mainIssueCity: string | null = null;
  let mainIssueCount = 0;
  for (const [c, n] of Object.entries(cityCounts)) {
    if (n > mainIssueCount) {
      mainIssueCity = c;
      mainIssueCount = n;
    }
  }
  const mainIssue = mainIssueCity
    ? `${mainIssueCount} of your current open issue(s) are concentrated in ${mainIssueCity}.`
    : problemParcels.length
      ? "Issues are spread across a few areas — no single hotspot right now."
      : "No active delivery issues right now.";

  const allTickets = tickets || [];
  const openTickets = allTickets.filter((t) => t.status === "Open");
  const recentTickets = allTickets.slice(0, 3);
  const outForDelivery = active.filter((p) => p.status === "Parcel out for delivery").length;
  const refused = list.filter((p) => p.status === "Refused").length;
  const newBooked = list.filter((p) => p.status === "New booked").length;

  return {
    parcels: list,
    active,
    delayed,
    returned,
    outForDelivery,
    refused,
    newBooked,
    walletBalance: Number(clientRow?.wallet_balance || 0),
    latestInvoice: (invoices || [])[0] || null,
    openTickets,
    recentTickets,
    issueRate,
    health,
    mainIssue,
  };
}

type ClientContext = Awaited<ReturnType<typeof loadClientContext>>;

function buildBriefing(ctx: ClientContext, cname: string | null): string {
  const parts: string[] = [];
  parts.push(`Good day${cname ? ", " + cname : ""}.`);
  let line = `${ctx.active.length} active parcel${ctx.active.length === 1 ? "" : "s"}`;
  if (ctx.outForDelivery) line += `, ${ctx.outForDelivery} out for delivery`;
  if (ctx.refused) line += `, ${ctx.refused} refused`;
  parts.push(line + ".");
  parts.push(`Wallet balance: Rs ${ctx.walletBalance.toLocaleString()}.`);
  if (ctx.delayed.length) parts.push(`${ctx.delayed.length} parcel(s) have gone 24h+ without an update.`);
  if (ctx.openTickets.length) parts.push(`You have ${ctx.openTickets.length} open support ticket(s).`);
  return parts.join(" ");
}

function buildAttention(ctx: ClientContext): string {
  const parts: string[] = [];
  if (ctx.delayed.length) {
    parts.push(
      `${ctx.delayed.length} parcel(s) aging over 24h without an update${ctx.delayed[0] ? ` (e.g. ${ctx.delayed[0].awb})` : ""}`,
    );
  }
  const refusedList = ctx.parcels.filter((p) => p.status === "Refused");
  if (refusedList.length) {
    parts.push(`${refusedList.length} refused parcel(s) needing review${refusedList[0] ? ` (e.g. ${refusedList[0].awb})` : ""}`);
  }
  const otherReturns = ctx.returned.filter((p) => p.status !== "Refused");
  if (otherReturns.length) parts.push(`${otherReturns.length} parcel(s) in the return flow`);
  if (ctx.newBooked > 0) parts.push(`${ctx.newBooked} AWB(s) not printed yet`);
  if (ctx.openTickets.length) parts.push(`${ctx.openTickets.length} open support ticket(s) awaiting a reply`);
  if (ctx.walletBalance > 0) parts.push(`Rs ${ctx.walletBalance.toLocaleString()} ready to withdraw from your wallet`);
  if (!parts.length) return "Nothing urgent right now — all your parcels look on track. \u2705";
  return "Here's what needs your attention: " + parts.join("; ") + ".";
}

function buildHealth(ctx: ClientContext): string {
  return `Delivery health: ${ctx.health}%. ${ctx.mainIssue}`;
}

// ---- Real account summary (client_summary intent): total/new/out-for-
// delivery/delivered/delayed/refused counts, wallet balance, open tickets,
// and one concrete next action — every number pulled fresh from ctx. ----
function buildSummary(ctx: ClientContext): string {
  const total = ctx.parcels.length;
  if (total === 0) {
    return "Your account has 0 parcels yet. Next step: create your first booking.";
  }
  const delivered = ctx.parcels.filter((p) => p.status === "Delivered").length;
  const refusedList = ctx.parcels.filter((p) => p.status === "Refused");

  const breakdown: string[] = [];
  if (delivered) breakdown.push(`${delivered} delivered`);
  if (ctx.newBooked) breakdown.push(`${ctx.newBooked} new booked`);
  if (ctx.outForDelivery) breakdown.push(`${ctx.outForDelivery} out for delivery`);
  if (ctx.delayed.length) breakdown.push(`${ctx.delayed.length} delayed`);
  if (ctx.returned.length) breakdown.push(`${ctx.returned.length} refused/return`);

  const parts: string[] = [];
  parts.push(`Your account has ${total} parcel${total === 1 ? "" : "s"}${breakdown.length ? ": " + breakdown.join(", ") : ""}.`);
  parts.push(`Payable balance is Rs ${ctx.walletBalance.toLocaleString()}.`);
  if (ctx.openTickets.length) parts.push(`${ctx.openTickets.length} open ticket${ctx.openTickets.length === 1 ? "" : "s"}.`);

  let nextAction: string;
  if (ctx.newBooked > 0) {
    const nb = ctx.parcels.find((p) => p.status === "New booked");
    nextAction = `Next step: print AWB ${nb?.awb} before pickup.`;
  } else if (ctx.delayed.length) {
    nextAction = `Next step: review ${ctx.delayed[0].awb} — it hasn't updated in over 24h.`;
  } else if (refusedList.length) {
    nextAction = `Next step: review refused parcel ${refusedList[0].awb}.`;
  } else if (ctx.walletBalance > 0) {
    nextAction = `Next step: withdraw Rs ${ctx.walletBalance.toLocaleString()} from your wallet.`;
  } else {
    nextAction = "Next step: everything looks on track — no action needed right now.";
  }
  parts.push(nextAction);
  return parts.join(" ");
}

// ---- "Dashboard Brain" first-open greeting: short Roman-Urdu-flavoured
// version of the same real numbers, used only for the very first message. ----
function buildDashboardBrainGreeting(ctx: ClientContext, cname: string | null): string {
  const total = ctx.parcels.length;
  if (total === 0) {
    return `Assalam o Alaikum${cname ? ", " + cname : ""}. Aaj ka summary: no parcels yet. Best next step: create your first booking.`;
  }
  const delivered = ctx.parcels.filter((p) => p.status === "Delivered").length;
  const bits: string[] = [`${total} parcel${total === 1 ? "" : "s"}`];
  if (delivered) bits.push(`${delivered} delivered`);
  if (ctx.newBooked) bits.push(`${ctx.newBooked} new booked`);
  if (ctx.delayed.length) bits.push(`${ctx.delayed.length} delayed`);

  let nextAction: string;
  if (ctx.newBooked > 0) nextAction = "print your new AWB";
  else if (ctx.delayed.length) nextAction = "review your delayed parcels";
  else if (ctx.walletBalance > 0) nextAction = `withdraw Rs ${ctx.walletBalance.toLocaleString()} from your wallet`;
  else nextAction = "keep an eye on today's deliveries";

  return `Aaj ka summary: ${bits.join(", ")}, Rs ${ctx.walletBalance.toLocaleString()} payable. Best next step: ${nextAction}.`;
}

function explainCod(ctx: ClientContext): string {
  const inv = ctx.latestInvoice as any;
  if (!inv) {
    return "You don't have an invoice yet — invoices are generated once parcels are delivered, and that's when COD minus delivery charges gets pushed to your wallet.";
  }
  const meta = inv.meta || {};
  const cod = meta.cod ?? meta.codAmount ?? null;
  const charges = meta.charges ?? meta.deliveryCharges ?? null;
  let reply = `Your latest invoice ${inv.code || inv.id} is ${inv.status}, net payable Rs ${Number(inv.net_payable || 0).toLocaleString()}.`;
  if (cod != null && charges != null) {
    reply += ` That's COD collected Rs ${Number(cod).toLocaleString()} minus delivery charges Rs ${Number(charges).toLocaleString()}.`;
  } else {
    reply += " I don't have an itemized COD/charges breakdown on hand for this invoice, but the net payable above is already after delivery charges are deducted.";
  }
  reply += ` Current wallet balance: Rs ${ctx.walletBalance.toLocaleString()}.`;
  return reply;
}

const PK_CITIES = [
  "Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan",
  "Peshawar", "Quetta", "Sialkot", "Gujranwala", "Hyderabad", "Sukkur",
  "Bahawalpur", "Sargodha", "Sahiwal",
];

function extractBookingDraft(text: string) {
  const t = String(text || "");
  const phoneMatch = t.match(PK_PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0].replace(/[\s-]/g, "") : null;
  const codMatch = t.match(/\b(?:rs\.?|pkr)\s?([\d,]{3,7})\b/i) || t.match(/\b([\d,]{3,7})\s?(?:rs|pkr)\b/i);
  const cod = codMatch ? Number(codMatch[1].replace(/,/g, "")) : null;
  const cityHit = PK_CITIES.find((c) => new RegExp("\\b" + c + "\\b", "i").test(t));
  const nameMatch = t.match(/name\s*[:\-]\s*([^\n,]+)/i);
  const addressMatch = t.match(/address\s*[:\-]\s*([^\n]+)/i) || t.match(/\b(?:house|street|block|sector|road|colony|town)\b[^\n]{0,80}/i);
  const productMatch = t.match(/(?:product|item)\s*[:\-]\s*([^\n,]+)/i);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    phone,
    city: cityHit || null,
    cod,
    address: addressMatch ? (addressMatch[1] ? addressMatch[1].trim() : addressMatch[0].trim()) : null,
    product: productMatch ? productMatch[1].trim() : null,
  };
}

function buildCustomerReply(parcel: ParcelRow | null, showException: boolean): string {
  if (!parcel) {
    return "Share the AWB so I can pull the real status before drafting a reply — I don't want to guess at what happened.";
  }
  const when = parcel.updated_at ? new Date(parcel.updated_at).toLocaleString() : "recently";
  let situation = `AWB ${parcel.awb} is currently marked "${parcel.status}"`;
  if (parcel.city) situation += ` in ${parcel.city}`;
  situation += `, last updated ${when}.`;
  if (showException && parcel.exception) situation += ` Note on file: ${parcel.exception}.`;
  situation += " (I only use what's actually on file — no call logs or timestamps are tracked in this system, so I won't invent those.)";
  const suggested = `Hi, sorry for the trouble — your order (${parcel.awb}) is currently "${parcel.status}"${parcel.city ? ` in ${parcel.city}` : ""}. We're on it and will update you as soon as it moves. Thanks for your patience!`;
  return `${situation}\n\nSuggested reply to send your customer:\n"${suggested}"`;
}

function classifyDepartment(text: string, awb?: string | null): string {
  const t = String(text || "").toLowerCase();
  if (/wallet|payout|withdraw|\bcod\b|invoice|payment|charge/.test(t)) return "Finance";
  if (/warehouse|packing|damaged|missing item|weight|\bbox\b/.test(t)) return "Warehouse";
  if (/karachi/.test(t)) return "Karachi Ops";
  if (/lahore/.test(t)) return "Lahore Ops";
  if (/return|refuse|refund/.test(t)) return "Return Desk";
  if (/pricing|rate card|\bplan\b|onboarding|integration|store|shopify|woocommerce|\bapi\b/.test(t)) return "Sales";
  return "General";
}

// ---- Abuse controls: identity + rate limiting via autopilot_events table ----
const MESSAGE_WINDOW_MS = 60_000;
const MESSAGE_MAX = 8;
const TICKET_WINDOW_MS = 10 * 60_000;
const TICKET_MAX = 3;

function identityFor(req: Request, callerClientId: string | null): string {
  if (callerClientId) return "client:" + callerClientId;
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = (fwd.split(",")[0] || "").trim() || req.headers.get("cf-connecting-ip") || "unknown";
  return "ip:" + ip;
}

async function countEvents(
  admin: ReturnType<typeof createClient>,
  identity: string,
  kind: "message" | "ticket",
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count } = await admin
    .from("autopilot_events")
    .select("id", { count: "exact", head: true })
    .eq("identity", identity)
    .eq("kind", kind)
    .gte("created_at", since);
  return count || 0;
}

async function logEvent(admin: ReturnType<typeof createClient>, identity: string, kind: "message" | "ticket") {
  try {
    await admin.from("autopilot_events").insert({ identity, kind });
  } catch {
    // Never let logging failures break a reply.
  }
}

function ticketCode(): string {
  return "AP-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function createTicket(
  admin: ReturnType<typeof createClient>,
  opts: {
    clientId: string | null;
    subject: string;
    body: string;
    awb: string | null;
    phone: string | null;
    portal: string;
    userId: string | null;
    intent?: string;
    handoffReason?: string | null;
  },
): Promise<{ ok: boolean; id?: string; code?: string; department?: string; priority?: string; error?: string }> {
  const code = ticketCode();
  const department = classifyDepartment(opts.subject + " " + opts.body, opts.awb);
  // Priority: any detected handoff rule (angry/legal/lost/COD dispute/repeated
  // failure/damaged/payment mismatch) always escalates to High. Otherwise
  // Medium, matching the tier this app's admin ticket queue already expects.
  const priority = opts.handoffReason ? "High" : "Medium";
  const tier = opts.handoffReason ? "emergency" : "medium";
  const { data, error } = await admin
    .from("tickets")
    .insert({
      client_id: opts.clientId || null,
      subject: opts.subject,
      body: opts.body,
      status: "Open",
      meta: {
        source: "novax-autopilot",
        code,
        tier,
        priority,
        intent: opts.intent || null,
        handoffReason: opts.handoffReason || null,
        from: opts.portal === "client" ? "Seller (Autopilot)" : "Public visitor (Autopilot)",
        to: "Admin Control",
        branch: "Admin",
        department,
        suggestedTeam: department,
        sourceKey: "autopilot:" + opts.portal + ":" + Date.now(),
        replies: [],
        awb: opts.awb || null,
        phone: opts.phone || null,
        portal: opts.portal,
        sessionUser: opts.userId || null,
      },
    })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id, code, department, priority };
}

type Action = { label: string; kind: "send" | "local"; message?: string; type?: string; awb?: string | null; draft?: Record<string, unknown> };

// ---- Lightweight feedback logging (Helpful / Not Helpful / Talk to Human
// buttons shown after every Autopilot reply on the client). Fire-and-forget,
// no normal reply processing — just records the signal so it can be reviewed
// later; never blocks or errors out the widget. ----
async function handleFeedback(req: Request, admin: ReturnType<typeof createClient>, payload: any): Promise<Response> {
  const value = String(payload?.feedback || "").slice(0, 20);
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = (fwd.split(",")[0] || "").trim() || req.headers.get("cf-connecting-ip") || "unknown";
  try {
    await admin.from("autopilot_events").insert({ identity: "ip:" + ip, kind: "feedback:" + value });
  } catch {
    // Never let logging failures surface to the user.
  }
  return json(req, { ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  if (!isAllowedCaller(req)) return json(req, { error: "Origin not allowed" }, 403);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON body" }, 400);
  }

  const message = String(payload?.message || "").slice(0, 1000);
  const awbInput = (String(payload?.awb || "").trim().toUpperCase() || extractAwb(message)) || null;
  const phone = payload?.phone ? String(payload.phone).slice(0, 40) : null;
  const portal = payload?.portal === "client" ? "client" : "public";

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (payload?.feedback) return handleFeedback(req, admin, payload);

  let callerUserId: string | null = null;
  let callerClientId: string | null = null;
  let callerName: string | null = null;
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (jwt && jwt.split(".").length === 3) {
    try {
      const { data: userRes } = await admin.auth.getUser(jwt);
      if (userRes?.user?.id) {
        callerUserId = userRes.user.id;
        const { data: profile } = await admin
          .from("profiles")
          .select("role, client_id, status, email")
          .eq("id", callerUserId)
          .maybeSingle();
        if (profile && profile.role === "client" && profile.status !== "blocked" && profile.client_id) {
          callerClientId = profile.client_id;
          callerName = (profile.email || "").split("@")[0] || null;
        }
      }
    } catch {
      // Invalid/expired token — treat as anonymous.
    }
  }

  const isAuthenticatedClient = portal === "client" && !!callerClientId;
  const identity = identityFor(req, callerClientId);

  const recentMessages = await countEvents(admin, identity, "message", MESSAGE_WINDOW_MS);
  if (recentMessages >= MESSAGE_MAX) {
    return json(req, {
      reply: "You're sending messages a bit too quickly — please wait a moment and try again.",
      intent: "rate_limited",
    }, 429);
  }
  await logEvent(admin, identity, "message");

  let intent = detectIntent(message, !!awbInput);
  // Human handoff rules always win over whatever the wording otherwise looks
  // like (e.g. an angry message about a delayed parcel still hands off,
  // rather than getting a routine tracking answer).
  const handoffReason = detectHandoff(message);
  if (handoffReason) intent = "human";

  // Client Autopilot Memory: pull one fresh context snapshot for any intent
  // that benefits from real account data. Skipped entirely for anonymous
  // callers (no client_id to scope it to).
  const needsContext = isAuthenticatedClient && ["greeting", "attention", "health", "briefing", "cod", "client_summary"].includes(intent);
  const ctx = needsContext ? await loadClientContext(admin, callerClientId as string) : null;

  if (intent === "greeting") {
    if (ctx) {
      return json(req, {
        reply: buildDashboardBrainGreeting(ctx, callerName),
        intent: "briefing",
        actions: [
          { label: "Print AWBs", kind: "local", type: "go_awb_label" } as Action,
          { label: "Review Delays", kind: "local", type: "go_dashboard" } as Action,
          { label: "Go to Wallet", kind: "local", type: "go_wallet" } as Action,
          { label: "Book New Parcel", kind: "local", type: "go_booking" } as Action,
        ],
      });
    }
    return json(req, {
      reply: "Hi, I'm NovaX Autopilot. Ask me to track an AWB, check your account summary, COD/wallet, or ask for a human.",
      intent: "greeting",
    });
  }

  if (intent === "client_summary") {
    if (!isAuthenticatedClient) {
      return json(req, {
        reply: "Log in to your seller account and I'll pull your real account summary — total parcels, delivered, delayed, wallet balance, and the next best step.",
        intent: "client_summary",
        requireLogin: true,
      });
    }
    const c = ctx as ClientContext;
    return json(req, {
      reply: buildSummary(c),
      intent: "client_summary",
      actions: [
        { label: "Print AWBs", kind: "local", type: "go_awb_label" } as Action,
        { label: "Review Delays", kind: "local", type: "go_dashboard" } as Action,
        { label: "Go to Wallet", kind: "local", type: "go_wallet" } as Action,
        { label: "Book New Parcel", kind: "local", type: "go_booking" } as Action,
      ],
    });
  }

  if (intent === "print_awb") {
    return json(req, {
      reply: "Opening your AWB Label tab — print any pending labels before pickup.",
      intent: "print_awb",
      actions: [{ label: "Print AWBs", kind: "local", type: "go_awb_label" } as Action],
    });
  }

  if (intent === "book_now") {
    return json(req, {
      reply: "Opening a new booking for you — fill in the consignee, city, COD, product, and address, then submit.",
      intent: "book_now",
      actions: [{ label: "Book New Parcel", kind: "local", type: "go_booking" } as Action],
    });
  }

  if (intent === "briefing") {
    if (!isAuthenticatedClient) {
      return json(req, { reply: "Log in to your seller account and I can give you a real daily briefing from your data.", intent: "briefing", requireLogin: true });
    }
    return json(req, {
      reply: buildBriefing(ctx as ClientContext, callerName),
      intent: "briefing",
      actions: [{ label: "What needs my attention?", kind: "send", message: "What needs my attention?" } as Action],
    });
  }

  if (intent === "attention") {
    if (!isAuthenticatedClient) {
      return json(req, { reply: "Log in to your seller account and I'll pull up exactly what needs your attention.", intent: "attention", requireLogin: true });
    }
    const c = ctx as ClientContext;
    // Client Risk Alerts: fixed 4-button set the seller can act on immediately.
    const actions: Action[] = [
      { label: "Review Delays", kind: "local", type: "go_dashboard" },
      { label: "Print AWBs", kind: "local", type: "go_awb_label" },
      { label: "Withdraw Wallet", kind: "local", type: "go_wallet" },
      { label: "Create Ticket", kind: "send", message: "Please open a support ticket for me." },
    ];
    return json(req, { reply: buildAttention(c), intent: "attention", actions });
  }

  if (intent === "health") {
    if (!isAuthenticatedClient) {
      return json(req, { reply: "Log in to your seller account and I'll calculate your real delivery health score.", intent: "health", requireLogin: true });
    }
    return json(req, { reply: buildHealth(ctx as ClientContext), intent: "health" });
  }

  // ---- Track / parcel status intent ----
  if (intent === "track") {
    if (!awbInput) {
      return json(req, { reply: "Share the AWB/tracking number and I'll look it up for you.", intent: "track", needAwb: true });
    }

    const { data: parcel } = await admin
      .from("parcels")
      .select("id, awb, status, city, updated_at, exception, client_id")
      .eq("awb", awbInput)
      .maybeSingle();

    if (!parcel) {
      return json(req, {
        reply: `I couldn't find a parcel with AWB ${awbInput}. Double-check the number, or I can open a support ticket for you.`,
        intent: "track",
        found: false,
        suggestTicket: true,
        actions: [{ label: "Open Ticket", kind: "send", message: `I couldn't find AWB ${awbInput} — please open a ticket to check.` } as Action],
      });
    }

    const isOwnerVerified = portal === "client" && isAuthenticatedClient && parcel.client_id === callerClientId;
    if (portal === "client" && !isOwnerVerified) {
      return json(req, {
        reply: `I couldn't find AWB ${awbInput} on your account. If this should be one of your parcels, I can open a support ticket.`,
        intent: "track",
        found: false,
        suggestTicket: true,
        actions: [{ label: "Open Ticket", kind: "send", message: `AWB ${awbInput} isn't showing on my account — please open a ticket to check.` } as Action],
      });
    }

    const note = SAFE_STATUS_NOTE[parcel.status as string];
    let reply = `AWB ${parcel.awb} is currently: ${parcel.status}${note ? ` (${note})` : ""}.`;
    if (parcel.city) reply += ` Last known location: ${parcel.city}.`;
    if (isOwnerVerified && parcel.exception) reply += ` Note on file: ${parcel.exception}.`;
    if (parcel.updated_at) reply += ` Last updated ${new Date(parcel.updated_at as string).toLocaleString()}.`;

    const actions: Action[] = [
      { label: "Open Ticket", kind: "send", message: `I need help with AWB ${parcel.awb} — please open a ticket.` },
      { label: "Request Reattempt", kind: "send", message: `Please arrange a reattempt for AWB ${parcel.awb}.` },
      { label: "Show Journey", kind: "local", type: "show_journey", awb: parcel.awb },
    ];

    return json(req, {
      reply,
      intent: "track",
      found: true,
      status: parcel.status,
      city: parcel.city,
      updatedAt: parcel.updated_at,
      actions,
    });
  }

  // ---- COD / wallet intent ----
  if (intent === "cod") {
    if (!isAuthenticatedClient) {
      return json(req, {
        reply: "COD and wallet details are only available once you're logged in to your seller account. Please log in and ask again, or I can open a support ticket.",
        intent: "cod",
        requireLogin: true,
        suggestTicket: true,
        actions: [{ label: "Create finance ticket", kind: "send", message: "I have a finance/payout question, please open a ticket." } as Action],
      });
    }

    const c = ctx as ClientContext;
    let reply = explainCod(c);

    if (awbInput) {
      const { data: parcel } = await admin
        .from("parcels")
        .select("awb, cod_amount, client_id, status")
        .eq("awb", awbInput)
        .maybeSingle();
      if (parcel && parcel.client_id === callerClientId) {
        reply += ` AWB ${parcel.awb} has a COD amount of Rs ${Number(parcel.cod_amount || 0).toLocaleString()}, status: ${parcel.status}.`;
      } else {
        reply += ` I couldn't match AWB ${awbInput} to your account for COD details.`;
      }
    }

    return json(req, {
      reply,
      intent: "cod",
      requireLogin: false,
      suggestTicket: true,
      actions: [
        { label: "Go to Wallet", kind: "local", type: "go_wallet" } as Action,
        { label: "Ask payout question", kind: "send", message: "Why is my COD less than expected?" } as Action,
        { label: "Create finance ticket", kind: "send", message: "I have a finance/payout question, please open a ticket." } as Action,
      ],
    });
  }

  // ---- Customer reply generator ----
  if (intent === "reply") {
    let parcel: ParcelRow | null = null;
    let showException = false;
    if (awbInput) {
      const { data } = await admin
        .from("parcels")
        .select("id, awb, status, city, updated_at, exception, cod_amount, client_id")
        .eq("awb", awbInput)
        .maybeSingle();
      if (data) {
        parcel = data as ParcelRow;
        showException = portal === "client" && isAuthenticatedClient && parcel.client_id === callerClientId;
        if (portal === "client" && !showException) parcel = null; // don't leak someone else's parcel
      }
    }
    return json(req, {
      reply: buildCustomerReply(parcel, showException),
      intent: "reply",
      needAwb: !parcel,
    });
  }

  // ---- Book from WhatsApp message (best-effort extraction, never auto-books) ----
  if (intent === "whatsapp") {
    const draft = extractBookingDraft(message);
    const gotAny = draft.name || draft.phone || draft.city || draft.cod || draft.address;
    if (!gotAny) {
      return json(req, {
        reply: "I couldn't pick out booking details from that. Paste the customer's message with their name, phone, city, COD amount, and address and I'll extract what I can.",
        intent: "whatsapp",
      });
    }
    const lines = [
      draft.name ? `Name: ${draft.name}` : null,
      draft.phone ? `Phone: ${draft.phone}` : null,
      draft.city ? `City: ${draft.city}` : null,
      draft.cod != null ? `COD: Rs ${draft.cod.toLocaleString()}` : null,
      draft.product ? `Product: ${draft.product}` : null,
      draft.address ? `Address: ${draft.address}` : null,
    ].filter(Boolean);
    let reply = "Here's what I could pull from that message — please double-check before booking:\n" + lines.join("\n");
    const actions: Action[] = [];
    if (portal === "client") {
      reply += "\n\nTap below to prefill the booking form with these details (you'll still need to fill in pickup city, service type, weight, etc.).";
      actions.push({ label: "Prefill Booking Form", kind: "local", type: "prefill_booking", draft: draft as Record<string, unknown> });
    } else {
      reply += "\n\nLog in to your seller account to prefill the booking form with these details.";
    }
    return json(req, { reply, intent: "whatsapp", draft, actions });
  }

  // ---- Unclear requests: ask a short clarifying question instead of ----
  // ---- immediately opening a ticket. Only real complaint/human/return/ ----
  // ---- handoff intents below actually create a ticket. ----
  if (intent === "unknown") {
    if (!message.trim()) {
      return json(req, {
        reply: "Ask me to track an AWB, get your account summary, check COD/wallet, or ask for a human.",
        intent: "unknown",
      });
    }
    return json(req, {
      reply: "I want to make sure I get this right — are you asking about a parcel's status, your account summary, COD/wallet, a return, or do you need our team directly?",
      intent: "unknown",
      actions: [
        { label: "Account Summary", kind: "send", message: "my summary" } as Action,
        { label: "Track a Parcel", kind: "send", message: "Track my parcel" } as Action,
        { label: "Talk to Human", kind: "send", message: "Please connect me with a human agent." } as Action,
      ],
    });
  }

  // ---- Ticket-creating intents (return / human) share a stricter rate limit ----
  if (intent === "return" || intent === "human") {
    const recentTickets = await countEvents(admin, identity, "ticket", TICKET_WINDOW_MS);
    if (recentTickets >= TICKET_MAX) {
      return json(req, {
        reply: "You already have a few open requests with our team — they'll follow up soon. No need to send more right now.",
        intent,
        ticketId: null,
        rateLimited: true,
      });
    }

    const subjectByIntent: Record<string, string> = {
      return: `Return/support request${awbInput ? ` — ${awbInput}` : ""}`,
      human: `Support request${awbInput ? ` — ${awbInput}` : ""}`,
    };
    const bodyByIntent: Record<string, string> = {
      return: message || "Return/support request via NovaX Autopilot.",
      human: message || "Requested a human agent via NovaX Autopilot.",
    };
    const replyByIntent: Record<string, string> = {
      return: `I've opened a return/support ticket for you${awbInput ? ` for AWB ${awbInput}` : ""}. Our team will follow up shortly.`,
      human: "Got it — I've created a support ticket and a team member will reach out to you directly.",
    };

    const ticket = await createTicket(admin, {
      clientId: callerClientId,
      subject: handoffReason ? `${subjectByIntent[intent]} — ${handoffReason}` : subjectByIntent[intent],
      body: bodyByIntent[intent],
      awb: awbInput,
      phone,
      portal,
      userId: callerUserId,
      intent,
      handoffReason,
    });
    if (ticket.ok) await logEvent(admin, identity, "ticket");

    const actions: Action[] = [];
    if (ticket.ok) {
      if (intent === "return") actions.push({ label: "Attach Proof", kind: "local", type: "attach_proof" });
      if (intent !== "human") actions.push({ label: "Talk to Human", kind: "send", message: "Please connect me with a human agent." });
      if (awbInput) actions.push({ label: "Show Journey", kind: "local", type: "show_journey", awb: awbInput });
    }

    return json(req, {
      reply: ticket.ok
        ? (handoffReason ? `${replyByIntent[intent]} (Flagged as ${handoffReason} — a human will prioritize this.)` : replyByIntent[intent])
        : "I couldn't open a ticket automatically — please try again in a moment.",
      intent,
      ticketId: ticket.id || null,
      ticketCode: ticket.code || null,
      department: ticket.department || null,
      priority: ticket.priority || null,
      handoffReason: handoffReason || null,
      actions,
    });
  }

  return json(req, {
    reply: "Ask me to track an AWB, get your account summary, check COD/wallet, or ask for a human.",
    intent: "unknown",
  });
});
