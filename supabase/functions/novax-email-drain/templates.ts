export type EmailKind = 'welcome' | 'first_booking' | 'payout_paid';
export type EmailPayload = Record<string, unknown>;
const PORTAL = 'https://novaxlogistics.com/client.html';
const WEBSITE = 'https://novaxlogistics.com/';
const SUPPORT = PORTAL + '?tab=support';
const FROM = 'NovaX Logistics <updates@auth.novaxlogistics.com>';

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
  ] : [
    ['A record you can come back to.', 'Your Money tab keeps your payout history and payment references together.'],
  ];
  const featureRows = features.map(([heading, copy], index) => `<tr><td width="38" style="width:38px;padding:18px 12px 18px 0;vertical-align:top;border-top:1px solid #e3eae6;color:#16804b;font-size:12px;font-weight:700">0${index + 1}</td><td style="padding:18px 0;border-top:1px solid #e3eae6;vertical-align:top"><div style="font-size:15px;line-height:1.45;font-weight:700;color:#20342a">${escape(heading)}</div><div style="margin-top:5px;font-size:13px;line-height:1.7;color:#5c6c63">${escape(copy)}</div></td></tr>`).join('');
  const kicker = kind === 'welcome' ? 'YOUR NEXT CHAPTER STARTS HERE' : kind === 'first_booking' ? 'FIRST BOOKING CONFIRMED' : 'PAYOUT UPDATE';
  const promise = kind === 'welcome' ? 'One portal. More control over your shipping day.' : kind === 'first_booking' ? 'One reference. Every recorded step of the journey.' : 'Your payout details, clearly recorded.';
  const featureTitle = kind === 'welcome' ? 'Built around your working day.' : kind === 'first_booking' ? 'What comes next' : 'Stay on top of your cash flow';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title>
<style>@media only screen and (max-width:480px){.email-pad{padding-left:22px!important;padding-right:22px!important}.email-heading{font-size:29px!important}.email-amount{font-size:30px!important}.email-wrap{padding:16px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#edf2ef;color:#192720;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(promise)} ${escape(subject)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td class="email-wrap" align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;text-align:left;background:#fff">
<tr><td class="email-pad" style="padding:22px 36px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:12px"><a href="${WEBSITE}" style="text-decoration:none"><img src="https://novaxlogistics.com/assets/icon-192.png" width="42" height="42" alt="NovaX" style="display:block;width:42px;height:42px;border:0"></a></td><td><div style="font-size:21px;font-weight:700;line-height:1.3">NovaX <span style="font-weight:400">Logistics</span></div><div style="font-size:10px;color:#66766c;margin-top:3px">BOOKINGS &nbsp; / &nbsp; TRACKING &nbsp; / &nbsp; PAYOUTS</div></td></tr></table></td></tr>
<tr><td class="email-pad" bgcolor="#172c23" style="padding:32px 36px;background-color:#172c23;border-bottom:4px solid #23b373"><div style="font-size:10px;font-weight:700;color:#8bdfb5;letter-spacing:0">${kicker}</div><h1 class="email-heading" style="font-size:34px;line-height:1.2;letter-spacing:0;margin:13px 0 14px;color:#ffffff;overflow-wrap:anywhere">${escape(title)}</h1><p style="font-size:15px;line-height:1.7;margin:0;color:#cfddd5">${escape(promise)}</p></td></tr>
<tr><td class="email-pad" style="padding:28px 36px"><p style="margin:0 0 24px;color:#52645a;overflow-wrap:anywhere">${escape(intro)}</p>
${highlight ? `<div style="background:#f0f7f3;padding:22px;margin:0 0 16px;border-left:3px solid #16804b"><div style="font-size:10px;font-weight:700;color:#526f5e;margin-bottom:8px">${highlightLabel}</div><div class="email-amount" style="font-size:${kind === 'payout_paid' ? '36' : '28'}px;line-height:1.25;font-weight:700;color:#173d2b;overflow-wrap:anywhere;word-break:break-word">${escape(highlight)}</div><div style="margin-top:10px;font-size:12px;font-weight:700;color:#16804b">${escape(status)}</div></div>` : ''}
${rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;font-size:13px;margin-bottom:28px">${rowHtml}</table>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td bgcolor="#16804b" style="background-color:#16804b;border-radius:4px;text-align:center"><a href="${escape(destination)}" style="display:block;padding:15px 16px;color:#fff;text-decoration:none;font-size:14px;font-weight:700;line-height:1.5">${escape(cta)}</a></td></tr></table>
<p style="margin:17px 0 0;color:#62736a;font-size:12px;line-height:1.7">${escape(note)}</p>
</td></tr>
<tr><td class="email-pad" style="padding:0 36px 24px"><h2 style="font-size:19px;line-height:1.4;font-weight:700;margin:0 0 14px;color:#20342a">${featureTitle}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed">${featureRows}</table>
${kind === 'welcome' ? '<p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#20342a">Here\'s to your next delivery, and everything after it.<br><span style="font-weight:700">The NovaX team</span></p>' : ''}
</td></tr>
<tr><td class="email-pad" style="padding:20px 36px;background:#f3f7f4;border-top:1px solid #e0e9e3"><div style="font-size:14px;font-weight:700;color:#20342a">You're not shipping alone.</div><div style="font-size:12px;color:#5c6c63;margin-top:4px">Questions about a booking or payout? <a href="${SUPPORT}" style="color:#16804b;text-decoration:underline;font-weight:700">Contact NovaX support</a></div></td></tr>
</table><p style="font-size:11px;color:#849087;line-height:1.8;margin:18px 0 0">NovaX Logistics | <a href="${WEBSITE}" style="color:#6a7a70;text-decoration:underline">novaxlogistics.com</a><br>Automated account notification. Please do not reply to this email.</p>
</td></tr></table></body></html>`;
  const text = [title, promise, intro, highlight, ...rows.map(([key, value]) => `${key}: ${value}`),
    `${cta}: ${destination}`, note, featureTitle, ...features.map(([heading, copy]) => `${heading}\n${copy}`),
    `NovaX support: ${SUPPORT}`, `NovaX Logistics: ${WEBSITE}`].filter(Boolean).join('\n\n');
  return { from: FROM, to: [recipient], subject, html, text,
    tags: [{ name: 'notification', value: kind }] };
}
