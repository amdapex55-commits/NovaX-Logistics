export type EmailKind = 'welcome' | 'first_booking' | 'payout_paid' | 'cnic_verified' | 'cnic_rejected'
  | 'first_parcel_d1' | 'first_parcel_d3' | 'first_parcel_d7'
  | 'back_quiet' | 'back_tried' | 'setup_ready'
  | 'recover_refused' | 'recover_won' | 'recover_launch';
export type EmailPayload = Record<string, unknown>;
const PORTAL = 'https://novaxlogistics.com/client.html';
const WEBSITE = 'https://novaxlogistics.com/';
const SUPPORT = PORTAL + '?tab=support';
const FROM = 'NovaX Logistics <updates@auth.novaxlogistics.com>';
const BOOK = PORTAL + '?tab=newBooking';
const WHATSAPP = 'https://wa.me/923123922558';
const STOP = WEBSITE + 'unsubscribe.html?t=';
const LOGO = 'https://novaxlogistics.com/assets/icon-192.png';
// Word for word from the site and Decisions. Do not reword.
const PRICE = 'Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad or Rawalpindi, plus Rs 85 per additional kg.';
const REMINDERS = ['first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7'];
// One-off emails to merchants who stopped, or set up and never shipped (8 Oct
// 2026). Sent once each, with the same private stop link as the reminders.
const NUDGES = ['back_quiet', 'back_tried', 'setup_ready'];
const HELP = WHATSAPP + '?text=' + encodeURIComponent('Hi NovaX, I got your email and want to talk about my parcels.');
function count(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) throw new Error('invalid_parcel_count');
  return n;
}
function day(value: unknown): string {
  const parsed = new Date(String(value ?? ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_event_date');
  return parsed.toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'long' });
}

/* 4 Oct 2026 redesign. One layout for every NovaX email, built for Gmail
 * (web and app) first: tables and inline styles only, no web fonts, no
 * background images, under 50 KB so Gmail never clips it, and a dark
 * header band that reads the same when Gmail's dark mode recolours the
 * page. Each email leads with a status pill and a headline that says what
 * happened, then the one fact that matters (amount, tracking number, what
 * to fix), one button, and at most three short "what next" lines. */

// Brand: site green on near-black, with a darker green for text on white.
const C = {
  page: '#eef3f0', card: '#ffffff', ink: '#10201b', body: '#3d5047', muted: '#6b7c74', line: '#e3ebe6',
  band: '#04100b', bandInk: '#ffffff', bandMuted: '#9fc3b2', green: '#14c77b', greenInk: '#0b7a4e', soft: '#edf8f2',
};
type Tone = 'good' | 'info' | 'warn';
const TONES: Record<Tone, [string, string]> = {
  good: ['#e3f6ec', '#0b6b44'], info: ['#e7f0fb', '#1b4f86'], warn: ['#fdf1dc', '#8a5300'],
};

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
function label(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160);
}
function currency(value: unknown): string {
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error('invalid_payout_amount');
  }
  return 'PKR ' + Number(value).toLocaleString('en-PK', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function date(value: unknown): string {
  const parsed = new Date(String(value ?? ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_event_date');
  return parsed.toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }) + ' PKT';
}

type Spec = {
  subject: string; preheader: string; pill: string; tone: Tone; title: string; intro: string;
  fact?: { label: string; value: string; caption?: string; size?: number };
  rows?: Array<[string, string]>; cta: string; destination: string; extraLink?: [string, string];
  stepsTitle: string; steps: Array<[string, string]>; note: string; signoff?: boolean;
};

function spec(kind: EmailKind, data: EmailPayload): Spec {
  const business = label(data.business);
  const name = label(data.name);
  const hi = name ? `Hi ${name}, ` : 'Hi there, ';
  const forBiz = business ? ' for ' + business : '';
  if (kind === 'welcome') {
    return {
      subject: 'Welcome to NovaX Logistics',
      preheader: 'Your account is created. Book a parcel, print its label and a rider collects it.',
      pill: 'Account created', tone: 'good',
      title: name ? `Welcome to NovaX, ${name}.` : 'Welcome to NovaX.',
      intro: `Your account${forBiz} is created. From your first parcel to your next payout, your whole shipping day lives in one portal.`,
      cta: 'Open your portal', destination: PORTAL,
      stepsTitle: 'What you can do from day one',
      steps: [
        ['Book one, or book in bulk.', 'Create single parcels, upload bulk bookings and print your AWB labels.'],
        ['Follow the whole journey.', 'See parcel statuses from booking through pickup, delivery or return.'],
        ['Keep your money in view.', 'Check your NovaX Wallet, request payouts and see every payment record.'],
        ['Bring your store along.', 'Connect Shopify or WooCommerce and book your store orders from the same place.'],
      ],
      note: 'If you received a separate verification email, verify your email address before signing in.',
      signoff: true,
    };
  }
  if (kind === 'first_booking') {
    const awb = label(data.awb);
    if (!awb) throw new Error('missing_awb');
    return {
      subject: `Your first NovaX parcel is booked: ${awb}`,
      preheader: `Tracking number ${awb}. Print the label and request a pickup.`,
      pill: 'First parcel booked', tone: 'good',
      title: 'Your first parcel is booked.',
      intro: `Your first booking${forBiz} is recorded. This tracking number connects its label, every status update and its delivery.`,
      fact: { label: 'TRACKING NUMBER', value: awb, caption: 'Booked ' + date(data.booked_at), size: 28 },
      cta: 'Print the label', destination: PORTAL + '?tab=awbLabel&awb=' + encodeURIComponent(awb),
      stepsTitle: 'What happens next',
      steps: [
        ['Print the label.', 'Open the booking, check the details and print its AWB label.'],
        ['Request a pickup.', 'Pick the parcels and a time in your portal, and a rider collects them from your door.'],
        ['Share the tracking link.', 'Your customer can follow the parcel to their door.'],
      ],
      note: 'Every status change is recorded in your portal as the parcel moves.',
    };
  }
  if (kind === 'payout_paid') {
    const net = currency(data.net), gross = currency(data.amount), fee = currency(data.fee);
    if (Math.abs(Number(data.amount) - Number(data.fee) - Number(data.net)) > 0.011) {
      throw new Error('payout_totals_mismatch');
    }
    const ref = label(data.reference);
    if (!ref) throw new Error('missing_payment_reference');
    return {
      subject: `Your ${net} payout is marked paid`,
      preheader: `${net} is marked paid. Reference ${ref}.`,
      pill: 'Marked paid', tone: 'good',
      title: 'Your payout is marked paid.',
      intro: `NovaX has marked your payout${forBiz} as paid. Keep the payment reference below for your records.`,
      fact: { label: 'NET PAYOUT', value: net, caption: 'Reference ' + ref, size: 34 },
      rows: [['Payout amount', gross], ['Payout fee', fee], ['Net paid amount', net],
        ['Payment reference', ref], ['Marked paid on', date(data.paid_at)]],
      cta: 'View your NovaX Wallet', destination: PORTAL + '?tab=money',
      stepsTitle: 'Good to know',
      steps: [
        ['Bank timing varies.', 'Your bank may take a little time to show the credit after NovaX marks it paid.'],
        ['Every payout, on record.', 'Your NovaX Wallet keeps your payout history and payment references together.'],
      ],
      note: 'This confirms the payout is marked paid in NovaX. If it has not reached your account, contact support with the reference above.',
    };
  }
  if (kind === 'cnic_verified') {
    return {
      subject: 'Your CNIC is verified',
      preheader: 'Your account owner is confirmed. Nothing else to do.',
      pill: 'Verified', tone: 'good',
      title: 'Your CNIC is verified.',
      intro: `Thank you. NovaX has checked the CNIC${forBiz}. There is nothing else you need to do.`,
      cta: 'Open your profile', destination: PORTAL + '?tab=profile',
      stepsTitle: 'Your CNIC, kept private',
      steps: [
        ['Only NovaX can see it.', 'Riders, customers and the other people on your account never see your CNIC photos.'],
        ['Locked once verified.', 'To change the CNIC on your account, contact NovaX support.'],
      ],
      note: 'Your CNIC photos stay private. Only you and NovaX staff can see them.',
    };
  }
  if (kind === 'cnic_rejected') {
    const reason = label(data.reason);
    if (!reason) throw new Error('missing_reason');
    return {
      subject: 'Please send a new photo of your CNIC',
      preheader: 'One quick step to finish checking your account: ' + reason,
      pill: 'New photo needed', tone: 'warn',
      title: 'We need a clearer CNIC photo.',
      intro: `We could not verify the CNIC${forBiz} from the photos we received. Please add new photos of the front and the back.`,
      fact: { label: 'WHAT TO FIX', value: reason, size: 19 },
      cta: 'Add new photos', destination: PORTAL + '?tab=profile',
      stepsTitle: 'Getting a clear photo',
      steps: [
        ['The whole card in the frame.', 'Put the card on a plain, dark surface and keep all four corners in the photo.'],
        ['No glare, no blur.', 'Use daylight or a bright room, hold the phone steady and keep the flash off.'],
      ],
      note: 'Your photos stay private: only you and NovaX staff can see them.',
    };
  }
  if (kind === 'first_parcel_d1') {
    return {
      subject: 'Your first NovaX parcel, in three steps',
      preheader: 'Book it, print the label, and a rider collects it from your door.',
      pill: 'Your first parcel', tone: 'info',
      title: "Let's book your first parcel.",
      intro: `${hi}your NovaX account${forBiz} is ready and nothing is booked yet. Here is everything it takes to send your first parcel.`,
      cta: 'Book your first parcel', destination: BOOK,
      stepsTitle: 'Three steps, start to finish',
      steps: [
        ['Book it.', "Enter your customer's name, phone, city, address and COD amount. Got the order on WhatsApp or Instagram? Tap Paste order and the form fills in for you."],
        ['Print the label.', 'Print the AWB label from the AWB label tab and stick it on the parcel.'],
        ['Request pickup.', 'In the same tab, choose the parcels, confirm your pickup address and pick a time. Riders collect between 11 am and 9 pm on working days.'],
      ],
      note: `Pickup is free in Karachi, Lahore, Islamabad and Rawalpindi. Price: ${PRICE}`,
    };
  }
  if (kind === 'first_parcel_d3') {
    return {
      subject: 'Try NovaX with one parcel',
      preheader: 'You don’t have to move all your orders at once. Start with one.',
      pill: 'One parcel is enough', tone: 'info',
      title: 'Start with one parcel.',
      intro: `${hi}you don't have to move all your orders at once. Send one parcel with NovaX and follow it from pickup to your wallet.`,
      cta: 'Book one parcel', destination: BOOK,
      stepsTitle: 'What your first parcel shows you',
      steps: [
        ['COD in your wallet the day it lands.', 'Every rupee shows in your NovaX Wallet, and you can withdraw it to your bank from there.'],
        ['Every step, tracked.', "Follow the parcel from pickup to your customer's door, and share its tracking link with your customer."],
        ['Refused? You decide.', 'If a customer refuses the parcel, you choose what happens next: try again or bring it back.'],
      ],
      note: 'Lots of orders already? Upload them together in Bulk booking, or connect your Shopify or WooCommerce store in your portal.',
    };
  }
  if (kind === 'first_parcel_d7') {
    return {
      subject: 'Can we help with your first parcel?',
      preheader: 'Message us on WhatsApp. A person on our team will reply.',
      pill: "We're here to help", tone: 'info',
      title: "Something in the way? Let's sort it out.",
      intro: `${hi}it's been a week since you opened your NovaX account${forBiz} and nothing is booked yet. If a question is holding you back, about prices, pickup in your area or how COD works, ask us on WhatsApp.`,
      fact: { label: 'NOVAX ON WHATSAPP', value: '0312 3922558', caption: 'We answer within an hour during support hours', size: 28 },
      cta: 'Message us on WhatsApp',
      destination: WHATSAPP + '?text=' + encodeURIComponent('Hi NovaX, I need help booking my first parcel.'),
      extraLink: ['Or book it yourself in your portal', BOOK],
      stepsTitle: 'The quick answers',
      steps: [
        ['Price', `${PRICE} Pickup is free in all four cities.`],
        ['Delivery', 'Karachi same day or next day. Lahore, Islamabad and Rawalpindi in 2–3 working days.'],
        ['COD', 'COD in your wallet the day it lands. Withdraw it to your bank from your NovaX Wallet.'],
      ],
      note: "This is our last reminder. Your account stays open, so you can book whenever you're ready.",
    };
  }
  if (kind === 'back_quiet' || kind === 'back_tried') {
    const n = count(data.parcels);
    const sent = n === 1 ? 'one parcel' : `${n} parcels`;
    const wallet = Number(data.wallet);
    const quiet = kind === 'back_quiet';
    return {
      subject: quiet ? 'Did something go wrong with your last parcels?' : 'How was your first NovaX delivery?',
      preheader: 'Tell us on WhatsApp. A person on our team will reply.',
      pill: quiet ? "We haven't seen you" : 'Your first delivery', tone: 'info',
      title: quiet ? 'Did something go wrong?' : 'How did it go?',
      intro: quiet
        ? `${hi}you sent ${sent} with NovaX${forBiz ? ' from ' + business : ''}, the last on ${day(data.last)}, and none since. If something went wrong with a parcel, a payout or a pickup, tell us. A person on our team will read it and sort it out.`
        : `${hi}you sent ${sent} with NovaX, the last on ${day(data.last)}, and none since. Was anything not right? Tell us, and a person on our team will read it and sort it out.`,
      ...(Number.isFinite(wallet) && wallet >= 1
        ? { fact: { label: 'STILL IN YOUR NOVAX WALLET', value: 'Rs ' + Math.floor(wallet).toLocaleString('en-PK'),
            caption: 'Withdraw it to your bank from your portal', size: 28 } }
        : {}),
      cta: 'Message us on WhatsApp', destination: HELP,
      extraLink: ['Or book a parcel in your portal', BOOK],
      stepsTitle: 'When you are ready to send again',
      steps: [
        ['Price', `${PRICE} Pickup is free in all four cities.`],
        ['Delivery', 'Karachi same day or next day. Lahore, Islamabad and Rawalpindi in 2–3 working days.'],
        ['COD', 'COD in your wallet the day it lands. Withdraw it to your bank from your NovaX Wallet.'],
      ],
      note: "We won't send this again. Your account stays open, so you can book whenever you're ready.",
    };
  }
  if (kind === 'setup_ready') {
    return {
      subject: 'Your NovaX account is ready. Send your first parcel',
      preheader: 'The setup is done. The only step left is your first booking.',
      pill: 'Ready to send', tone: 'info',
      title: 'The setup is done. Send your first parcel.',
      intro: `${hi}you have already set up your NovaX account${forBiz}. The only step left is your first booking, and it takes about a minute.`,
      cta: 'Book your first parcel', destination: BOOK,
      extraLink: ['Stuck on something? Message us on WhatsApp', HELP],
      stepsTitle: 'Three steps, start to finish',
      steps: [
        ['Book it.', "Enter your customer's name, phone, city, address and COD amount. Got the order on WhatsApp or Instagram? Tap Paste order and the form fills in for you."],
        ['Print the label.', 'Print the AWB label from the AWB label tab and stick it on the parcel.'],
        ['Request pickup.', 'In the same tab, choose the parcels, confirm your pickup address and pick a time. Riders collect between 11 am and 9 pm on working days.'],
      ],
      note: `Pickup is free in Karachi, Lahore, Islamabad and Rawalpindi. Price: ${PRICE}`,
    };
  }
  // Nova Recover (8 Oct 2026). A parcel was refused and NovaX no longer calls
  // every refusal for free: the merchant decides. At most one a day.
  if (kind === 'recover_refused') {
    const awb = label(data.awb), customer = label(data.customer) || 'Your customer', city = label(data.city);
    if (!awb) throw new Error('missing_awb');
    const cod = currency(data.cod), fee = currency(data.fee);
    const reason = label(data.reason);
    return {
      subject: `A customer refused parcel ${awb}`,
      preheader: `${customer}${city ? ' in ' + city : ''} refused ${cod}. Choose what happens next.`,
      pill: 'Parcel refused', tone: 'warn',
      title: 'A customer refused your parcel.',
      intro: `${customer}${city ? ' in ' + city : ''} refused this parcel${forBiz}. It is at our station, waiting for your decision.`,
      fact: { label: 'COD ON THIS ORDER', value: cod, caption: 'Tracking number ' + awb, size: 30 },
      rows: reason ? [['What the rider wrote', reason]] : undefined,
      cta: 'Choose what to do', destination: PORTAL + '?tab=recover',
      stepsTitle: 'Your three choices',
      steps: [
        ['Recover it.', `A NovaX agent phones the customer and sells the order again. ${fee} only if it works, nothing if it does not.`],
        ['Try again.', 'We send the same parcel out once more.'],
        ['Return to me.', 'We bring the parcel back to you.'],
      ],
      note: 'If more parcels are refused today they join the same list in your portal. This email comes at most once a day.',
    };
  }
  // Sent once, by an admin, to a merchant who has the Nova Recover tab,
  // has parcels that came back, and has not started.
  if (kind === 'recover_launch') {
    // 9 Oct 2026: the email shows how many parcels, never their COD value.
    const n = count(data.count), recent = Number(data.recent);
    const free = !(Number(data.fee) > 0), fee = free ? '' : currency(data.fee);
    const fresh = Number.isFinite(recent) && recent > 0
      ? (recent >= n ? (n === 1 ? 'It came back in the last 30 days' : 'All of them came back in the last 30 days')
                     : `${Math.round(recent)} of them came back in the last 30 days`)
      : undefined;
    return {
      subject: n === 1 ? 'An order came back. We can sell it again' : `${n} orders came back. We can sell them again`,
      preheader: `${n === 1 ? 'One order came back. A NovaX agent can phone the customer and sell it again.' : n + ' orders came back. A NovaX agent can phone each customer and sell them again.'}`,
      pill: 'New: Nova Recover', tone: 'info',
      title: 'Let us sell your returned orders again.',
      intro: `${n === 1 ? 'One order' : n + ' orders'}${forBiz} came back from customers who refused them. With Nova Recover, a NovaX agent phones each customer and sells the order again.`,
      fact: { label: n === 1 ? 'ORDER YOU CAN SEND US' : 'ORDERS YOU CAN SEND US', value: n === 1 ? '1 order' : n + ' orders', caption: fresh, size: 30 },
      cta: 'Choose the orders', destination: PORTAL + '?tab=recover',
      stepsTitle: 'How it works',
      steps: [
        ['You choose.', 'Open Nova Recover in your portal and pick the parcels. Start with the recent ones: they do best.'],
        ['We call.', 'A NovaX agent phones the customer within one working day.'],
        [free ? 'No fee for now.' : `${fee} only when it works.`, free ? 'A recovered order is delivered at your normal rate.' : 'For each order we recover. Nothing if we cannot. A recovered order is delivered at your normal rate.'],
      ],
      note: free ? 'You will be told, and asked to agree, before any fee is added.'
                 : 'The fee comes from your NovaX Wallet, and it stays if the customer agrees on the call and then refuses again at the door.',
    };
  }
  if (kind === 'recover_won') {
    const awb = label(data.awb), was = label(data.was_awb), customer = label(data.customer) || 'Your customer', city = label(data.city);
    if (!awb) throw new Error('missing_awb');
    const cod = currency(data.cod), fee = currency(data.fee);
    const rebook = data.mode === 'rebook';
    const off = Number(data.was_cod) - Number(data.cod);
    const rows: Array<[string, string]> = [['Customer', customer + (city ? ', ' + city : '')], ['Delivery day', day(data.deliver_on)], ['Tracking number', awb]];
    if (rebook && was) rows.push(['Earlier tracking number', was]);
    if (Number.isFinite(off) && off > 0) rows.push(['Taken off to save the sale', currency(off)]);
    rows.push(['Nova Recover fee', Number(data.fee) > 0 ? fee : 'None']);
    return {
      subject: `We recovered an order for you: ${awb}`,
      preheader: `${customer} agreed to take the order. COD ${cod}.`,
      pill: 'Order recovered', tone: 'good',
      title: 'NovaX recovered an order for you.',
      intro: `${customer} had refused this order${forBiz}. A NovaX agent called, and they agreed to take it.`,
      fact: { label: 'COD TO COLLECT', value: cod, caption: 'Tracking number ' + awb, size: 30 },
      rows,
      cta: rebook ? 'Print the new label' : 'See it in your portal',
      destination: rebook ? PORTAL + '?tab=awbLabel&awb=' + encodeURIComponent(awb) : PORTAL + '?tab=recover',
      stepsTitle: 'What happens next',
      steps: rebook
        ? [['Pack the order again.', 'It is booked under a new tracking number, so it needs the new label.'],
           ['Hand it over at your next pickup.', 'It then travels like any other parcel.']]
        : [['Nothing for you to do.', 'The same parcel goes out again on the delivery day above.']],
      note: Number(data.fee) > 0
        ? 'The fee comes from your NovaX Wallet. If the wallet is empty, it comes out of your next COD before you withdraw.'
        : 'There is no fee for this one.',
    };
  }
  throw new Error('unknown_email_kind');
}

function button(text: string, href: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%"><tr><td align="center" bgcolor="${C.green}" style="background-color:${C.green};border-radius:10px"><a href="${escape(href)}" style="display:block;padding:15px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:1.3;color:${C.band};text-decoration:none;border-radius:10px">${escape(text)} &rarr;</a></td></tr></table>`;
}

export function buildEmail(kind: EmailKind, recipient: string, data: EmailPayload) {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) {
    throw new Error('invalid_recipient');
  }
  // First-parcel reminders carry a private link that switches them off.
  const reminder = REMINDERS.includes(kind);
  const nudge = NUDGES.includes(kind);
  let stopUrl = '';
  if (reminder || nudge) {
    const token = String(data.token ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      throw new Error('missing_token');
    }
    stopUrl = STOP + token.toLowerCase();
  }
  const s = spec(kind, data);
  const [pillBg, pillInk] = TONES[s.tone];
  const font = 'font-family:Arial,Helvetica,sans-serif';

  const fact = s.fact ? `<tr><td class="pad" style="padding:0 32px 8px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:${C.soft};border-radius:12px"><tr><td style="padding:18px 20px;${font}">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:${C.muted}">${escape(s.fact.label)}</div>` +
    `<div class="fact" style="margin-top:6px;font-size:${s.fact.size ?? 26}px;line-height:1.25;font-weight:700;color:${C.ink};overflow-wrap:anywhere;word-break:break-word">${escape(s.fact.value)}</div>` +
    (s.fact.caption ? `<div style="margin-top:6px;font-size:13px;color:${C.greenInk};font-weight:700">${escape(s.fact.caption)}</div>` : '') +
    `</td></tr></table></td></tr>` : '';

  const rows = s.rows && s.rows.length ? `<tr><td class="pad" style="padding:8px 32px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;${font};font-size:14px">` +
    s.rows.map(([k, v]) => `<tr><td style="padding:11px 0;border-bottom:1px solid ${C.line};color:${C.muted};width:44%;vertical-align:top">${escape(k)}</td><td style="padding:11px 0 11px 12px;border-bottom:1px solid ${C.line};text-align:right;color:${C.ink};font-weight:${k === 'Net paid amount' ? '700' : '400'};overflow-wrap:anywhere;word-break:break-word">${escape(v)}</td></tr>`).join('') +
    `</table></td></tr>` : '';

  const steps = s.steps.map(([h, c], i) => `<tr><td width="34" valign="top" style="width:34px;padding:12px 10px 12px 0"><div style="width:26px;height:26px;border-radius:13px;background:${C.soft};color:${C.greenInk};${font};font-size:13px;font-weight:700;line-height:26px;text-align:center">${i + 1}</div></td>` +
    `<td valign="top" style="padding:12px 0;${font}"><div style="font-size:15px;line-height:1.4;font-weight:700;color:${C.ink}">${escape(h)}</div><div style="margin-top:3px;font-size:14px;line-height:1.6;color:${C.body}">${escape(c)}</div></td></tr>`).join('');

  const footerWhy = reminder
    ? `You're getting this because you opened a NovaX account and haven't booked a parcel yet. We send three of these at most, and they stop once you book. <a href="${escape(stopUrl)}" style="color:${C.muted};text-decoration:underline">Stop these reminders</a>. Please do not reply to this email.`
    : nudge
    ? `You're getting this because you have a NovaX account. We send this email once. <a href="${escape(stopUrl)}" style="color:${C.muted};text-decoration:underline">Stop emails like this</a>. Please do not reply to this email; message us on WhatsApp instead.`
    : 'Automated account notification. Please do not reply to this email.';

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(s.subject)}</title>
<style>@media only screen and (max-width:480px){.pad{padding-left:20px!important;padding-right:20px!important}.h1{font-size:25px!important}.fact{font-size:24px!important}.wrap{padding:12px 6px!important}}</style></head>
<body style="margin:0;padding:0;background:${C.page};${font};color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page}">${escape(s.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:${C.page}"><tr><td class="wrap" align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:580px">
<tr><td bgcolor="${C.band}" style="background-color:${C.band};border-radius:16px 16px 0 0;padding:18px 32px" class="pad"><table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td style="padding-right:10px"><a href="${WEBSITE}" style="text-decoration:none"><img src="${LOGO}" width="34" height="34" alt="NovaX" style="display:block;width:34px;height:34px;border:0;border-radius:8px"></a></td>
<td style="${font};font-size:17px;font-weight:700;color:${C.bandInk};line-height:1.2">NovaX <span style="font-weight:400;color:${C.bandMuted}">Logistics</span></td></tr></table></td></tr>
<tr><td bgcolor="${C.card}" style="background-color:${C.card};border-radius:0 0 16px 16px;padding:0">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%">
<tr><td class="pad" style="padding:28px 32px 6px;${font}"><span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${pillBg};color:${pillInk};font-size:12px;font-weight:700;line-height:1.3">${escape(s.pill)}</span>
<h1 class="h1" style="margin:14px 0 10px;font-size:28px;line-height:1.22;font-weight:700;color:${C.ink};overflow-wrap:anywhere">${escape(s.title)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:${C.body};overflow-wrap:anywhere">${escape(s.intro)}</p></td></tr>
${fact}${rows}
<tr><td class="pad" style="padding:16px 32px 4px">${button(s.cta, s.destination)}
${s.extraLink ? `<p style="margin:12px 0 0;text-align:center;${font};font-size:14px"><a href="${escape(s.extraLink[1])}" style="color:${C.greenInk};text-decoration:underline;font-weight:700">${escape(s.extraLink[0])}</a></p>` : ''}</td></tr>
<tr><td class="pad" style="padding:22px 32px 6px"><div style="${font};font-size:13px;font-weight:700;letter-spacing:1px;color:${C.muted};text-transform:uppercase">${escape(s.stepsTitle)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-top:4px">${steps}</table></td></tr>
<tr><td class="pad" style="padding:6px 32px 24px;${font}"><p style="margin:0;font-size:13px;line-height:1.65;color:${C.muted}">${escape(s.note)}</p>
${s.signoff ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:${C.ink}">Here's to your next delivery, and everything after it.<br><b>The NovaX team</b></p>` : ''}</td></tr>
<tr><td class="pad" style="padding:16px 32px 20px;border-top:1px solid ${C.line};${font}"><div style="font-size:14px;font-weight:700;color:${C.ink}">Need a hand?</div>
<div style="margin-top:3px;font-size:13px;line-height:1.6;color:${C.body}"><a href="${SUPPORT}" style="color:${C.greenInk};text-decoration:underline;font-weight:700">Contact NovaX support</a> from your portal, or WhatsApp <b style="color:${C.ink}">0312&nbsp;3922558</b>.</div></td></tr>
</table></td></tr>
<tr><td align="center" style="padding:18px 16px 4px;${font};font-size:12px;line-height:1.7;color:${C.muted}"><b style="color:${C.body}">NovaX Logistics</b> &middot; COD courier for Karachi, Lahore, Islamabad and Rawalpindi &middot; <a href="${WEBSITE}" style="color:${C.muted};text-decoration:underline">novaxlogistics.com</a><br>${footerWhy}</td></tr>
</table></td></tr></table></body></html>`;
  // Keep "Rs 250" on one line in the reminders' prices.
  const html = (reminder || nudge) ? page.replace(/Rs (\d)/g, 'Rs&nbsp;$1') : page;
  const text = [s.title, s.intro, s.fact ? `${s.fact.label}: ${s.fact.value}${s.fact.caption ? ' (' + s.fact.caption + ')' : ''}` : '',
    ...(s.rows ?? []).map(([key, value]) => `${key}: ${value}`),
    `${s.cta}: ${s.destination}`, s.extraLink ? `${s.extraLink[0]}: ${s.extraLink[1]}` : '',
    s.stepsTitle, ...s.steps.map(([heading, copy]) => `${heading}\n${copy}`), s.note,
    s.signoff ? "Here's to your next delivery, and everything after it.\nThe NovaX team" : '',
    `Need a hand? NovaX support: ${SUPPORT} · WhatsApp 0312 3922558`, `NovaX Logistics: ${WEBSITE}`,
    reminder ? `We send three of these reminders at most, and they stop once you book. Stop them: ${stopUrl}` : '',
    nudge ? `We send this email once. Stop emails like this: ${stopUrl}` : '',
  ].filter(Boolean).join('\n\n');
  return { from: FROM, to: [recipient], subject: s.subject, html, text,
    tags: [{ name: 'notification', value: kind }],
    ...((reminder || nudge) ? { headers: { 'List-Unsubscribe': `<${stopUrl}>` } } : {}) };
}
