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
    intro = `${name ? 'Hi ' + name + ', your' : 'Your'} NovaX account has been created${business ? ' for ' + business : ''}. We're glad you're here.`;
    note = 'Received a verification email? Please verify your email address before signing in. Your NovaX portal is your home for bookings, tracking and payouts.';
    cta = 'Open your portal';
    status = 'Account created';
  } else if (kind === 'first_booking') {
    if (!label(data.awb)) throw new Error('missing_awb');
    subject = 'Your first NovaX parcel is booked'; title = 'Your first parcel is booked.';
    intro = `Your first booking${business ? ' for ' + business : ''} has been created. This is the start of your parcel's journey with NovaX.`;
    highlight = label(data.awb);
    highlightLabel = 'YOUR BOOKING REFERENCE'; status = 'Booking created';
    rows = [['Booking reference', label(data.awb)], ['Booked on', date(data.booked_at)]];
    note = 'Your booking is recorded. Open your portal to check pickup arrangements and follow its status through collection and delivery.';
    cta = 'View your bookings';
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
    cta = 'Open your payout records';
    destination = PORTAL + '?tab=money';
  } else {
    throw new Error('unknown_email_kind');
  }
  const rowHtml = rows.map(([key, value]) => `<tr><td style="padding:13px 0;border-bottom:1px solid #e8ecea;color:#69736e;width:43%;vertical-align:top">${escape(key)}</td><td style="padding:13px 0 13px 12px;border-bottom:1px solid #e8ecea;text-align:right;font-weight:${key === 'Net paid amount' ? '700' : '500'};overflow-wrap:anywhere;word-break:break-word">${escape(value)}</td></tr>`).join('');
  const welcomeSteps = kind === 'welcome' ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border-top:1px solid #e8ecea;border-bottom:1px solid #e8ecea;margin:26px 0"><tr>${[['01','Book a parcel'],['02','Follow its journey'],['03','Manage payouts']].map(([number, text]) => `<td style="padding:20px 6px 20px 0;vertical-align:top"><div style="color:#16804b;font-size:12px;font-weight:700;margin-bottom:8px">${number}</div><div style="font-size:13px;font-weight:700;line-height:1.5">${text}</div></td>`).join('')}</tr></table>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title>
<style>@media only screen and (max-width:480px){.email-pad{padding-left:22px!important;padding-right:22px!important}.email-heading{font-size:28px!important}.email-amount{font-size:30px!important}.email-wrap{padding:16px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#edf1ef;color:#192720;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(subject)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td class="email-wrap" align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;text-align:left;background:#fff;border-top:5px solid #16804b">
<tr><td class="email-pad" style="padding:24px 36px;border-bottom:1px solid #e8ecea"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:13px"><a href="${WEBSITE}" style="text-decoration:none"><img src="https://novaxlogistics.com/assets/icon-192.png" width="46" height="46" alt="NovaX" style="display:block;width:46px;height:46px;border:0"></a></td><td><div style="font-size:23px;font-weight:700;line-height:1.3">NovaX <span style="font-weight:400">Logistics</span></div><div style="font-size:11px;color:#77827c;margin-top:3px">MERCHANT SERVICES</div></td></tr></table></td></tr>
<tr><td class="email-pad" style="padding:30px 36px 28px"><div style="font-size:11px;font-weight:700;color:#16804b;letter-spacing:0">${kind === 'payout_paid' ? 'PAYOUT CONFIRMATION' : kind === 'first_booking' ? 'YOUR FIRST BOOKING' : 'WELCOME TO NOVAX'}</div>
<h1 class="email-heading" style="font-size:32px;line-height:1.2;letter-spacing:0;margin:13px 0 18px;overflow-wrap:anywhere">${escape(title)}</h1><p style="margin:0 0 26px;color:#5e6a63;overflow-wrap:anywhere">${escape(intro)}</p>
${highlight ? `<div style="background:${kind === 'payout_paid' ? '#f0f7f2' : '#f5f6f4'};padding:23px 22px;margin:0 0 20px;border-left:3px solid ${kind === 'payout_paid' ? '#16804b' : '#bc8c38'}"><div style="font-size:10px;font-weight:700;color:#657369;margin-bottom:8px">${highlightLabel}</div><div class="email-amount" style="font-size:${kind === 'payout_paid' ? '36' : '28'}px;line-height:1.25;font-weight:700;overflow-wrap:anywhere;word-break:break-word">${escape(highlight)}</div><div style="margin-top:11px;font-size:12px;font-weight:700;color:${kind === 'payout_paid' ? '#16804b' : '#89601d'}">${escape(status)}</div></div>` : ''}
${welcomeSteps}
${rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;font-size:13px;margin-bottom:28px">${rowHtml}</table>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%"><tr><td bgcolor="#16804b" style="background-color:#16804b;border-radius:4px;text-align:center"><a href="${escape(destination)}" style="display:block;padding:15px 16px;color:#fff;text-decoration:none;font-size:14px;font-weight:700;line-height:1.5">${escape(cta)}</a></td></tr></table>
<p style="margin:22px 0 0;color:#7a847e;font-size:12px;line-height:1.7">${escape(note)}</p>
${kind === 'welcome' ? '<p style="margin:24px 0 0;font-size:14px;font-weight:700">Here\'s to your next delivery.<br><span style="font-weight:400;color:#69736e">The NovaX team</span></p>' : ''}
</td></tr>
<tr><td class="email-pad" style="padding:18px 36px;background:#f8faf9;border-top:1px solid #e8ecea"><div style="font-size:12px;font-weight:700">Need a hand?</div><div style="font-size:12px;color:#7a847e;margin-top:3px">We're here to help. <a href="${SUPPORT}" style="color:#16804b;text-decoration:underline;font-weight:700">Contact NovaX support</a></div></td></tr>
</table><p style="font-size:11px;color:#849087;line-height:1.8;margin:18px 0 0">NovaX Logistics | <a href="${WEBSITE}" style="color:#6a7a70;text-decoration:underline">novaxlogistics.com</a><br>Automated account notification. Please do not reply to this email.</p>
</td></tr></table></body></html>`;
  const text = [title, intro, highlight, ...rows.map(([key, value]) => `${key}: ${value}`),
    `${cta}: ${destination}`, note, `NovaX support: ${SUPPORT}`, `NovaX Logistics: ${WEBSITE}`].filter(Boolean).join('\n\n');
  return { from: FROM, to: [recipient], subject, html, text,
    tags: [{ name: 'notification', value: kind }] };
}
