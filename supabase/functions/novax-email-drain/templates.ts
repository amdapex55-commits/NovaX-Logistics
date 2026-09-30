export type EmailKind = 'welcome' | 'first_booking' | 'payout_paid' | 'cnic_verified' | 'cnic_rejected'
  | 'first_parcel_d1' | 'first_parcel_d3' | 'first_parcel_d7';
export type EmailPayload = Record<string, unknown>;
const PORTAL = 'https://novaxlogistics.com/client.html';
const WEBSITE = 'https://novaxlogistics.com/';
const SUPPORT = PORTAL + '?tab=support';
const FROM = 'NovaX Logistics <updates@auth.novaxlogistics.com>';
const BOOK = PORTAL + '?tab=newBooking';
const WHATSAPP = 'https://wa.me/923123922558';
const STOP = WEBSITE + 'unsubscribe.html?t=';
// Word for word from the site and Decisions. Do not reword.
const PRICE = 'Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad or Rawalpindi, plus Rs 85 per additional kg.';
const REMINDERS = ['first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7'];

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

export function buildEmail(kind: EmailKind, recipient: string, data: EmailPayload) {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) {
    throw new Error('invalid_recipient');
  }
  const business = label(data.business);
  let subject: string, title: string, intro: string, note: string, cta: string;
  let destination = PORTAL;
  let highlight = '', highlightLabel = '', status = '', rows: Array<[string, string]> = [];
  // First-parcel reminders carry a private link that switches them off.
  const reminder = REMINDERS.includes(kind);
  let stopUrl = '', extraLink: [string, string] | null = null;
  if (reminder) {
    const token = String(data.token ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      throw new Error('missing_token');
    }
    stopUrl = STOP + token.toLowerCase();
  }
  const hi = label(data.name) ? `Hi ${label(data.name)}, ` : 'Hi there, ';
  if (kind === 'welcome') {
    subject = 'Welcome to NovaX Logistics'; title = 'Welcome to NovaX.';
    const name = label(data.name);
    intro = `${name ? 'Hi ' + name + ', welcome aboard.' : 'Welcome aboard.'} Your account${business ? ' for ' + business : ''} is created. From your first parcel to your next payout, keep your shipping day in one place.`;
    note = 'If you received a separate verification email, verify your email address before signing in. Then open your portal to create your first booking.';
    cta = 'Start your NovaX journey';
    status = 'Account created';
  } else if (kind === 'first_booking') {
    if (!label(data.awb)) throw new Error('missing_awb');
    subject = 'Your first NovaX parcel is booked'; title = 'Your first parcel is booked.';
    intro = `Your first booking${business ? ' for ' + business : ''} is recorded. Keep the reference below handy: it connects your label, parcel updates and delivery journey in your NovaX portal.`;
    highlight = label(data.awb);
    highlightLabel = 'YOUR BOOKING REFERENCE'; status = 'Booking created';
    rows = [['Booking reference', label(data.awb)], ['Booked on', date(data.booked_at)]];
    note = 'Your booking is recorded. Open your portal to check pickup arrangements and follow its status through collection and delivery.';
    cta = 'View this booking';
    destination = PORTAL + '?tab=awbLabel&awb=' + encodeURIComponent(label(data.awb));
  } else if (kind === 'payout_paid') {
    const net = currency(data.net), gross = currency(data.amount), fee = currency(data.fee);
    if (Math.abs(Number(data.amount) - Number(data.fee) - Number(data.net)) > 0.011) {
      throw new Error('payout_totals_mismatch');
    }
    if (!label(data.reference)) throw new Error('missing_payment_reference');
    subject = `Your ${net} payout is marked paid`; title = 'Your payout is marked paid.';
    intro = `Your payout${business ? ' for ' + business : ''} has now been marked paid by NovaX.`;
    highlight = net;
    highlightLabel = 'NET PAYOUT AMOUNT'; status = 'Marked paid';
    rows = [['Payout amount', gross], ['Payout fee', fee], ['Net paid amount', net],
      ['Payment reference', label(data.reference)], ['Marked paid on', date(data.paid_at)]];
    note = 'This confirms the payout is marked paid in NovaX. Bank crediting times may vary. Keep the payment reference above for your records.';
    cta = 'View your payout records';
    destination = PORTAL + '?tab=money';
  } else if (kind === 'cnic_verified') {
    subject = 'Your CNIC is verified'; title = 'Your CNIC is verified.';
    intro = `Thank you. NovaX has checked the CNIC${business ? ' for ' + business : ''}. There is nothing else you need to do.`;
    note = 'Your CNIC photos stay private. Only you and NovaX staff can see them.';
    cta = 'Open your profile';
    destination = PORTAL + '?tab=profile';
  } else if (kind === 'cnic_rejected') {
    const reason = label(data.reason);
    if (!reason) throw new Error('missing_reason');
    subject = 'Please send a new photo of your CNIC'; title = 'We need a clearer CNIC photo.';
    intro = `We could not verify the CNIC${business ? ' for ' + business : ''} from the photos we received. Please add new photos of the front and the back.`;
    highlight = reason; highlightLabel = 'WHAT TO FIX'; status = 'New photo needed';
    note = 'Take the photo in good light, with the whole card inside the frame and no glare. Your photos stay private: only you and NovaX staff can see them.';
    cta = 'Add new photos';
    destination = PORTAL + '?tab=profile';
  } else if (kind === 'first_parcel_d1') {
    subject = 'Your first NovaX parcel, in three steps'; title = "Let's book your first parcel.";
    intro = `${hi}your NovaX account${business ? ' for ' + business : ''} is ready and nothing is booked yet. Here is everything it takes to send your first parcel.`;
    note = `Pickup is free in Karachi, Lahore, Islamabad and Rawalpindi. Price: ${PRICE}`;
    cta = 'Book your first parcel';
    destination = BOOK;
  } else if (kind === 'first_parcel_d3') {
    subject = 'Try NovaX with one parcel'; title = 'Start with one parcel.';
    intro = `${hi}you don't have to move all your orders at once. Send one parcel with NovaX and follow it from pickup to your wallet.`;
    note = 'Lots of orders already? Upload them together in Bulk Booking, or connect your Shopify or WooCommerce store in your portal.';
    cta = 'Book one parcel';
    destination = BOOK;
  } else if (kind === 'first_parcel_d7') {
    subject = 'Can we help with your first parcel?'; title = "Something in the way? Let's sort it out.";
    intro = `${hi}it's been a week since you opened your NovaX account${business ? ' for ' + business : ''} and nothing is booked yet. If a question is holding you back, about prices, pickup in your area or how COD works, ask us on WhatsApp.`;
    highlight = '0312 3922558'; highlightLabel = 'NOVAX ON WHATSAPP';
    status = 'We answer within an hour during support hours';
    note = "This is our last reminder. Your account stays open, so you can book whenever you're ready.";
    cta = 'Message us on WhatsApp';
    destination = WHATSAPP + '?text=' + encodeURIComponent('Hi NovaX, I need help booking my first parcel.');
    extraLink = ['Or book it yourself in your portal', BOOK];
  } else {
    throw new Error('unknown_email_kind');
  }
  const rowHtml = rows.map(([key, value]) => `<tr><td style="padding:13px 0;border-bottom:1px solid #e8ecea;color:#69736e;width:43%;vertical-align:top">${escape(key)}</td><td style="padding:13px 0 13px 12px;border-bottom:1px solid #e8ecea;text-align:right;font-weight:${key === 'Net paid amount' ? '700' : '500'};overflow-wrap:anywhere;word-break:break-word">${escape(value)}</td></tr>`).join('');
  const features: Array<[string, string]> = kind === 'welcome' ? [
    ['Book one. Or book in bulk.', 'Create individual parcels, upload bulk bookings and print your AWB labels.'],
    ['Follow the whole journey.', 'See parcel statuses from booking through collection, delivery or return.'],
    ['Keep your money in view.', 'Review your wallet, request payouts and check payment records in the Money tab.'],
    ['Bring your store along.', 'Connect Shopify and manage your store bookings alongside your other shipments.'],
  ] : kind === 'first_booking' ? [
    ['Your label, ready to review.', 'Open this booking to check the parcel details and print its AWB label.'],
    ['Your next update, in your portal.', 'Check pickup arrangements and follow each recorded status as the parcel moves.'],
  ] : kind === 'cnic_verified' ? [
    ['Only NovaX can see it.', 'Riders, customers and the other people on your account never see your CNIC photos.'],
    ['Locked once verified.', 'To change the CNIC on your account, contact NovaX support.'],
  ] : kind === 'cnic_rejected' ? [
    ['The whole card in the frame.', 'Put the card on a plain, dark surface and keep all four corners in the photo.'],
    ['No glare, no blur.', 'Use daylight or a bright room, hold the phone steady and keep the flash off.'],
  ] : kind === 'first_parcel_d1' ? [
    ['Book it.', "Enter your customer's name, phone, city, address and COD amount. Got the order on WhatsApp or Instagram? Tap Paste order and the form fills in for you."],
    ['Print the label.', 'Print the AWB label from the AWB Label tab and stick it on the parcel.'],
    ['Request pickup.', 'In the same tab, choose the parcels, confirm your pickup address and pick a time. Riders collect between 11 am and 9 pm on working days.'],
  ] : kind === 'first_parcel_d3' ? [
    ['COD in your wallet the day it lands.', 'Every rupee shows in your Money tab, and you can withdraw it to your bank from there.'],
    ['Every step, tracked.', "Follow the parcel from pickup to your customer's door, and share its tracking link with your customer."],
    ['Refused? You decide.', 'If a customer refuses the parcel, you choose what happens next: try again or bring it back.'],
  ] : kind === 'first_parcel_d7' ? [
    ['Price', `${PRICE} Pickup is free in all four cities.`],
    ['Delivery', 'Karachi same day or next day. Lahore, Islamabad and Rawalpindi in 2–3 working days.'],
    ['COD', 'COD in your wallet the day it lands. Withdraw it to your bank from the Money tab.'],
  ] : [
    ['A record you can come back to.', 'Your Money tab keeps your payout history and payment references together.'],
  ];
  const featureRows = features.map(([heading, copy], index) => `<tr><td width="38" style="width:38px;padding:18px 12px 18px 0;vertical-align:top;border-top:1px solid #e3eae6;color:#16804b;font-size:12px;font-weight:700">0${index + 1}</td><td style="padding:18px 0;border-top:1px solid #e3eae6;vertical-align:top"><div style="font-size:15px;line-height:1.45;font-weight:700;color:#20342a">${escape(heading)}</div><div style="margin-top:5px;font-size:13px;line-height:1.7;color:#5c6c63">${escape(copy)}</div></td></tr>`).join('');
  const kicker = kind === 'welcome' ? 'YOUR NEXT CHAPTER STARTS HERE' : kind === 'first_booking' ? 'FIRST BOOKING CONFIRMED'
    : kind === 'cnic_verified' ? 'ACCOUNT CHECK COMPLETE' : kind === 'cnic_rejected' ? 'ACCOUNT CHECK'
    : kind === 'first_parcel_d1' ? 'YOUR FIRST PARCEL' : kind === 'first_parcel_d3' ? 'ONE PARCEL IS ENOUGH'
    : kind === 'first_parcel_d7' ? "WE'RE HERE TO HELP" : 'PAYOUT UPDATE';
  const promise = kind === 'welcome' ? 'One portal. More control over your shipping day.' : kind === 'first_booking' ? 'One reference. Every recorded step of the journey.'
    : kind === 'cnic_verified' ? 'Your account owner is confirmed.' : kind === 'cnic_rejected' ? 'One quick step to finish checking your account.'
    : kind === 'first_parcel_d1' ? 'Book it, print the label, and a rider collects it from your door.'
    : kind === 'first_parcel_d3' ? 'Follow it from pickup to your wallet.'
    : kind === 'first_parcel_d7' ? 'Message us on WhatsApp. A person on our team will reply.' : 'Your payout details, clearly recorded.';
  const featureTitle = kind === 'welcome' ? 'Built around your working day.' : kind === 'first_booking' ? 'What comes next'
    : kind === 'cnic_verified' ? 'Your CNIC, kept private' : kind === 'cnic_rejected' ? 'Getting a clear photo'
    : kind === 'first_parcel_d1' ? 'Three steps, start to finish' : kind === 'first_parcel_d3' ? 'What your first parcel shows you'
    : kind === 'first_parcel_d7' ? 'The quick answers' : 'Stay on top of your cash flow';
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title>
<style>@media only screen and (max-width:480px){.email-pad{padding-left:22px!important;padding-right:22px!important}.email-heading{font-size:29px!important}.email-amount{font-size:30px!important}.email-wrap{padding:16px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#edf2ef;color:#192720;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(promise)} ${escape(subject)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td class="email-wrap" align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;text-align:left;background:#fff">
<tr><td class="email-pad" style="padding:22px 36px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:12px"><a href="${WEBSITE}" style="text-decoration:none"><img src="https://novaxlogistics.com/assets/icon-192.png" width="42" height="42" alt="NovaX" style="display:block;width:42px;height:42px;border:0"></a></td><td><div style="font-size:21px;font-weight:700;line-height:1.3">NovaX <span style="font-weight:400">Logistics</span></div><div style="font-size:10px;color:#66766c;margin-top:3px">BOOKINGS &nbsp; / &nbsp; TRACKING &nbsp; / &nbsp; PAYOUTS</div></td></tr></table></td></tr>
<tr><td class="email-pad" bgcolor="#172c23" style="padding:32px 36px;background-color:#172c23;border-bottom:4px solid #23b373"><div style="font-size:10px;font-weight:700;color:#8bdfb5;letter-spacing:0">${kicker}</div><h1 class="email-heading" style="font-size:34px;line-height:1.2;letter-spacing:0;margin:13px 0 14px;color:#ffffff;overflow-wrap:anywhere">${escape(title)}</h1><p style="font-size:15px;line-height:1.7;margin:0;color:#cfddd5">${escape(promise)}</p></td></tr>
<tr><td class="email-pad" style="padding:28px 36px"><p style="margin:0 0 24px;color:#52645a;overflow-wrap:anywhere">${escape(intro)}</p>
${highlight ? `<div style="background:#f0f7f3;padding:22px;margin:0 0 16px;border-left:3px solid #16804b"><div style="font-size:10px;font-weight:700;color:#526f5e;margin-bottom:8px">${highlightLabel}</div><div class="${kind === 'cnic_rejected' ? 'email-reason' : 'email-amount'}" style="font-size:${kind === 'payout_paid' ? '36' : kind === 'cnic_rejected' ? '20' : '28'}px;line-height:1.25;font-weight:700;color:#173d2b;overflow-wrap:anywhere;word-break:break-word">${escape(highlight)}</div><div style="margin-top:10px;font-size:12px;font-weight:700;color:#16804b">${escape(status)}</div></div>` : ''}
${rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;font-size:13px;margin-bottom:28px">${rowHtml}</table>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td bgcolor="#16804b" style="background-color:#16804b;border-radius:4px;text-align:center"><a href="${escape(destination)}" style="display:block;padding:15px 16px;color:#fff;text-decoration:none;font-size:14px;font-weight:700;line-height:1.5">${escape(cta)}</a></td></tr></table>
${extraLink ? `<p style="margin:14px 0 0;text-align:center;font-size:13px;line-height:1.6"><a href="${escape(extraLink[1])}" style="color:#16804b;text-decoration:underline;font-weight:700">${escape(extraLink[0])}</a></p>` : ''}
<p style="margin:17px 0 0;color:#62736a;font-size:12px;line-height:1.7">${escape(note)}</p>
</td></tr>
<tr><td class="email-pad" style="padding:0 36px 24px"><h2 style="font-size:19px;line-height:1.4;font-weight:700;margin:0 0 14px;color:#20342a">${featureTitle}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed">${featureRows}</table>
${kind === 'welcome' ? '<p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#20342a">Here\'s to your next delivery, and everything after it.<br><span style="font-weight:700">The NovaX team</span></p>' : ''}
</td></tr>
<tr><td class="email-pad" style="padding:20px 36px;background:#f3f7f4;border-top:1px solid #e0e9e3"><div style="font-size:14px;font-weight:700;color:#20342a">You're not shipping alone.</div><div style="font-size:12px;color:#5c6c63;margin-top:4px">Questions about a booking or payout? <a href="${SUPPORT}" style="color:#16804b;text-decoration:underline;font-weight:700">Contact NovaX support</a></div></td></tr>
</table><p style="font-size:11px;color:#849087;line-height:1.8;margin:18px 0 0">NovaX Logistics | <a href="${WEBSITE}" style="color:#6a7a70;text-decoration:underline">novaxlogistics.com</a><br>${reminder ? `You're getting this because you opened a NovaX account and haven't booked a parcel yet. We send three of these at most, and they stop once you book. <a href="${escape(stopUrl)}" style="color:#6a7a70;text-decoration:underline">Stop these reminders</a>. Please do not reply to this email.` : 'Automated account notification. Please do not reply to this email.'}</p>
</td></tr></table></body></html>`;
  // Keep "Rs 250" on one line in the reminders' prices.
  const html = reminder ? page.replace(/Rs (\d)/g, 'Rs&nbsp;$1') : page;
  const text = [title, promise, intro, highlight, ...rows.map(([key, value]) => `${key}: ${value}`),
    `${cta}: ${destination}`, extraLink ? `${extraLink[0]}: ${extraLink[1]}` : '', note, featureTitle,
    ...features.map(([heading, copy]) => `${heading}\n${copy}`),
    `NovaX support: ${SUPPORT}`, `NovaX Logistics: ${WEBSITE}`,
    reminder ? `We send three of these reminders at most, and they stop once you book. Stop them: ${stopUrl}` : '',
  ].filter(Boolean).join('\n\n');
  return { from: FROM, to: [recipient], subject, html, text,
    tags: [{ name: 'notification', value: kind }],
    ...(reminder ? { headers: { 'List-Unsubscribe': `<${stopUrl}>` } } : {}) };
}
