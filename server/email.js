'use strict';

const nodemailer = require('nodemailer');
const { fulfillmentConfig } = require('./settings');

const EMAIL_DETAILS = Object.freeze({
  name: 'Nice Workshop',
  address: 'hello@niceworkshop.ca',
  hours: 'Monday–Friday, 9am–7pm (Toronto time)',
  pickupAddress: Object.freeze({ ...fulfillmentConfig.pickup.address }),
});

class MailError extends Error {
  constructor(code, deliveryOutcome, message) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.deliveryOutcome = deliveryOutcome;
  }
}

function invalid(message = 'The email contains invalid fields.') {
  return new MailError('EMAIL_INVALID', 'rejected', message);
}

function singleLine(value, limit = 250) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value);
}

// A single plain address only: no display names, recipient lists or header fields.
function emailAddress(value) {
  if (!singleLine(value, 254) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
    || value.includes('..')) throw invalid('A single valid email address is required.');
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function addressLines(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) throw invalid();
  const parts = [address.address1];
  if (address.address2) parts.push(address.address2);
  if (![address.address1, address.city, address.provinceCode, address.zip].every(value => singleLine(value, 150))
    || (address.address2 && !singleLine(address.address2, 150))) throw invalid();
  parts.push(`${address.city}, ${address.provinceCode} ${address.zip}`);
  return parts;
}

function describeCuts(cutList) {
  if (cutList === undefined) return [];
  if (!Array.isArray(cutList) || cutList.length > 100) throw invalid();
  return cutList.map(cut => {
    if (!cut || !['rectangle', 'circle'].includes(cut.shape)
      || !Number.isSafeInteger(cut.quantity) || cut.quantity < 1 || cut.quantity > 999
      || !Number.isSafeInteger(cut.widthUnits) || cut.widthUnits < 1
      || !Number.isSafeInteger(cut.heightUnits) || cut.heightUnits < 1
      || (cut.shape === 'circle' && cut.widthUnits !== cut.heightUnits)) throw invalid();
    const dimensions = cut.shape === 'circle' ? `${cut.widthUnits / 10000} mm diameter`
      : `${cut.widthUnits / 10000} × ${cut.heightUnits / 10000} mm`;
    return `${cut.quantity} ${cut.shape}${cut.quantity === 1 ? '' : 's'} · ${dimensions}`;
  });
}

/** Render only. The caller decides when an order is actually ready and may send. */
function renderReadyEmail({ kind, orderName, cutList, deliveryAddress, test = false } = {}) {
  if (!['pickup', 'delivery', 'dropoff'].includes(kind) || !singleLine(orderName, 100)
    || typeof test !== 'boolean') throw invalid();
  const pickup = kind === 'pickup';
  const title = pickup ? 'Your order is ready for pickup' : 'Your order is ready for drop-off';
  const subject = `${test ? '[TEST] ' : ''}${EMAIL_DETAILS.name} ${orderName}: ${pickup ? 'ready for pickup' : 'ready for drop-off'}`;
  const introduction = pickup ? 'Your cuts are ready in the pickup box in our driveway.'
    : 'Your cuts are ready. We’ll email you to confirm your drop-off time.';
  const instructions = pickup ? 'Bring your order confirmation or order number so you can find your order.'
    : `We deliver ${EMAIL_DETAILS.hours}.`;
  const location = pickup ? addressLines(EMAIL_DETAILS.pickupAddress)
    : deliveryAddress ? addressLines(deliveryAddress) : [];
  const cuts = describeCuts(cutList);
  const testNotice = 'TEST PREVIEW — this is a sample email, not an order ready for collection or delivery.';
  const text = [test ? testNotice : null, EMAIL_DETAILS.name, title, `Order ${orderName}`,
    introduction, location.length ? `${pickup ? 'Pickup address' : 'Drop-off address'}:\n${location.join('\n')}` : null,
    pickup ? `Pickup hours: ${EMAIL_DETAILS.hours}.` : null, instructions,
    cuts.length ? `Your cuts:\n${cuts.map(line => `• ${line}`).join('\n')}` : null,
    `Questions? Reply to this email or contact ${EMAIL_DETAILS.address}.`].filter(Boolean).join('\n\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:28px 12px;background:#f5f3e9;color:#283d32;font-family:Arial,Helvetica,sans-serif;line-height:1.6;">
<table role="presentation" style="width:100%;max-width:600px;margin:0 auto;border-collapse:collapse;"><tr><td style="padding:18px 24px;background:#28533e;color:#fff;font-size:22px;font-weight:bold;letter-spacing:-0.5px;">Nice Workshop<span style="display:block;font-size:11px;font-weight:normal;letter-spacing:1.5px;color:#e0eadf;">CUT TO YOUR SIZE.</span></td></tr>
<tr><td style="padding:28px 24px;background:#fffdf7;border:1px solid #e3e5d9;border-top:0;">
${test ? `<p style="padding:10px 14px;background:#fff0c9;border:1px solid #e4d199;font-size:13px;">${escapeHtml(testNotice)}</p>` : ''}
<p style="margin:0 0 8px;font-size:13px;color:#647568;">ORDER ${escapeHtml(orderName)}</p>
<h1 style="margin:0 0 20px;font-size:27px;line-height:1.25;font-weight:600;">${escapeHtml(title)}</h1>
<p>${escapeHtml(introduction)}</p>
${location.length ? `<div style="margin:22px 0;padding:17px 20px;background:#eef3e9;border-left:3px solid #608568;"><strong>${pickup ? 'Pickup address' : 'Drop-off address'}</strong><br>${location.map(escapeHtml).join('<br>')}${pickup ? `<br><span style="display:block;margin-top:8px;">${escapeHtml(EMAIL_DETAILS.hours)}</span>` : ''}</div>` : ''}
<p>${escapeHtml(instructions)}</p>
${cuts.length ? `<h2 style="margin:26px 0 10px;font-size:16px;">Your cuts</h2><ul style="margin:0;padding-left:20px;">${cuts.map(line => `<li style="margin:6px 0;">${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e3e5d9;font-size:14px;">Questions? Reply to this email or contact <a style="color:#28533e;" href="mailto:${EMAIL_DETAILS.address}">${EMAIL_DETAILS.address}</a>.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

function deliveryOutcome(error) {
  // A negative SMTP reply is a definite refusal, including the final DATA reply.
  // Network loss/timeouts after DATA may hide an acceptance: never call those a rejection.
  if (Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599) return 'rejected';
  if (['EAUTH', 'ENOAUTH', 'EOAUTH2', 'EDNS', 'ETLS', 'ECONFIG', 'EENVELOPE', 'EMAXRECIPIENTS',
    'EFILEACCESS', 'EURLACCESS'].includes(error?.code)) return 'rejected';
  if (error?.code === 'ETIMEDOUT' && ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'].includes(error.timeoutType)) return 'rejected';
  return 'unknown';
}

/** SMTP acceptance is not proof of inbox delivery. This sender never retries. */
function createMailSender(env = {}, { createTransport = nodemailer.createTransport } = {}) {
  if (env.EMAIL_ENABLED !== 'true' || !env.SMTP_PASSWORD) return null;
  const from = emailAddress(env.EMAIL_FROM || EMAIL_DETAILS.address);
  const replyTo = emailAddress(env.EMAIL_REPLY_TO || EMAIL_DETAILS.address);
  const host = env.SMTP_HOST || 'smtp.protonmail.ch';
  const port = env.SMTP_PORT === undefined ? 587 : Number(env.SMTP_PORT);
  if (!singleLine(host, 253) || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$/.test(host)
    || host.includes('..') || ![587, 2525].includes(port)
    || !singleLine(env.SMTP_USERNAME, 320) || typeof env.SMTP_PASSWORD !== 'string') {
    throw new MailError('EMAIL_CONFIGURATION_REQUIRED', 'rejected', 'Configure the SMTP host, submission port and dedicated credentials.');
  }
  // https://nodemailer.com/smtp — enforce STARTTLS and validate its certificate.
  const transport = createTransport({
    host, port, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host },
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    pool: false, logger: false, debug: false, transactionLog: false,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000, dnsTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    async send({ to, subject, text, html, messageId } = {}) {
      emailAddress(to);
      if (!singleLine(subject, 250) || typeof text !== 'string' || !text || text.length > 1000000
        || typeof html !== 'string' || !html || html.length > 1000000
        || !singleLine(messageId, 254) || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) throw invalid();
      let result;
      try {
        result = await transport.sendMail({ from: { name: EMAIL_DETAILS.name, address: from }, replyTo,
          to, subject, text, html, messageId, envelope: { from, to: [to] },
          disableFileAccess: true, disableUrlAccess: true });
      } catch (error) {
        const outcome = deliveryOutcome(error);
        // Do not propagate server replies, credentials, message bodies or recipient data into logs.
        throw new MailError(outcome === 'rejected' ? 'EMAIL_REJECTED' : 'EMAIL_DELIVERY_UNKNOWN', outcome,
          outcome === 'rejected' ? 'The email was not accepted by the mail server.' : 'The email delivery outcome is unknown. Check before sending again.');
      }
      const accepted = result?.accepted || [];
      if (!accepted.some(address => typeof address === 'string' && address.toLowerCase() === to.toLowerCase())) {
        const rejected = result?.rejected?.some(address => typeof address === 'string' && address.toLowerCase() === to.toLowerCase());
        throw new MailError(rejected ? 'EMAIL_REJECTED' : 'EMAIL_DELIVERY_UNKNOWN', rejected ? 'rejected' : 'unknown',
          rejected ? 'The email was not accepted by the mail server.' : 'The email delivery outcome is unknown. Check before sending again.');
      }
      return { messageId, accepted: [to] };
    },
  };
}

module.exports = { createMailSender, renderReadyEmail, MailError, EMAIL_DETAILS };
