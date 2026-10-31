'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailSender, renderReadyEmail, EMAIL_DETAILS } = require('../server/email');

const enabled = { EMAIL_ENABLED: 'true', SMTP_USERNAME: 'hello@niceworkshop.ca', SMTP_PASSWORD: 'test-secret-never-log' };
const message = () => ({ to: 'hello@niceworkshop.ca', messageId: '<ready-test@niceworkshop.ca>',
  ...renderReadyEmail({ kind: 'pickup', orderName: '#TEST-1001' }) });
function setup(sendMail) {
  let options, calls = [];
  const sender = createMailSender(enabled, { createTransport(configuration) {
    options = configuration;
    return { async sendMail(mail) { calls.push(mail); return sendMail(mail); } };
  } });
  return { sender, options, calls };
}

test('SMTP stays disabled unless explicitly enabled with a password', () => {
  const createTransport = () => { throw new Error('Transport must not be constructed'); };
  for (const env of [{}, { ...enabled, EMAIL_ENABLED: undefined }, { ...enabled, EMAIL_ENABLED: 'false' },
    { ...enabled, SMTP_PASSWORD: undefined }, { ...enabled, SMTP_PASSWORD: '' }]) {
    assert.equal(createMailSender(env, { createTransport }), null);
  }
});

test('SMTP requires verified TLS, finite timeouts, no logging and no pooled retries', async () => {
  const { sender, options, calls } = setup(mail => ({ accepted: [mail.to] }));
  assert.equal(options.host, 'smtp.protonmail.ch');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.ignoreTLS, false);
  assert.equal(options.opportunisticTLS, false);
  assert.deepEqual(options.tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.protonmail.ch' });
  assert.equal(options.pool, false);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.ok(options.connectionTimeout <= 30000 && options.socketTimeout <= 30000 && options.greetingTimeout <= 30000);
  const outgoing = message();
  assert.deepEqual(await sender.send({ ...outgoing, from: 'attacker@example.com', bcc: 'attacker@example.com',
    attachments: [{ path: '/private/not-readable' }] }), { messageId: outgoing.messageId, accepted: [outgoing.to] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].from, { name: 'Nice Workshop', address: EMAIL_DETAILS.address });
  assert.deepEqual(calls[0].envelope, { from: EMAIL_DETAILS.address, to: [outgoing.to] });
  assert.equal(calls[0].replyTo, EMAIL_DETAILS.address);
  assert.equal(calls[0].messageId, outgoing.messageId);
  assert.equal(calls[0].disableFileAccess, true);
  assert.equal(calls[0].disableUrlAccess, true);
  assert.equal(calls[0].bcc, undefined);
  assert.equal(calls[0].attachments, undefined);
});

test('invalid configuration fails before creating a connection and omits credentials in errors', () => {
  for (const extra of [{ SMTP_USERNAME: '' }, { SMTP_HOST: 'smtp.example.com\r\nsecret' },
    { SMTP_HOST: 'smtp://smtp.example.com' }, { SMTP_PORT: '25' }, { SMTP_PORT: '465' },
    { EMAIL_FROM: 'Nice Workshop <hello@niceworkshop.ca>' }, { EMAIL_REPLY_TO: 'hello@niceworkshop.ca\r\nBcc:other@example.com' }]) {
    assert.throws(() => createMailSender({ ...enabled, ...extra }, { createTransport() { throw new Error('Unexpected connection'); } }), error => {
      assert.equal(error.deliveryOutcome, 'rejected');
      assert.doesNotMatch(error.message, /test-secret-never-log/);
      return true;
    });
  }
});

test('one recipient and safe headers are enforced before SMTP', async () => {
  const { sender, calls } = setup(() => { throw new Error('Must not reach SMTP'); });
  for (const extra of [{ to: 'hello@niceworkshop.ca,other@example.com' }, { to: ['hello@niceworkshop.ca'] },
    { to: 'hello@niceworkshop.ca\nBcc:other@example.com' }, { subject: 'Ready\r\nBcc:other@example.com' },
    { messageId: '<id@niceworkshop.ca>\nHeader:value' }, { messageId: undefined }, { html: { path: '/private/file' } }]) {
    await assert.rejects(sender.send({ ...message(), ...extra }), { code: 'EMAIL_INVALID', deliveryOutcome: 'rejected' });
  }
  assert.equal(calls.length, 0);
});

test('explicit refusal is distinguished from ambiguous SMTP failure without retrying or leaking server replies', async () => {
  const cases = [
    [{ code: 'EAUTH', responseCode: 535 }, 'rejected'],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'rejected'],
    [{ code: 'EMESSAGE', responseCode: 451, command: 'DATA' }, 'rejected'],
    [{ code: 'EDNS' }, 'rejected'],
    [{ code: 'ETLS' }, 'rejected'],
    [{ code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' }, 'rejected'],
    [{ code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT', command: 'DATA' }, 'unknown'],
    [{ code: 'ESOCKET', command: 'DATA' }, 'unknown'],
    [{ code: 'ECONNECTION' }, 'unknown'],
    [{ code: 'EPROTOCOL', responseCode: 250 }, 'unknown'],
  ];
  for (const [fields, outcome] of cases) {
    const { sender, calls } = setup(() => { throw Object.assign(new Error('server reply test-secret-never-log recipient@example.com'), fields); });
    await assert.rejects(sender.send(message()), error => {
      assert.equal(error.deliveryOutcome, outcome);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /test-secret-never-log|recipient@example.com/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('a resolved SMTP call must explicitly accept the intended recipient', async () => {
  for (const [result, outcome] of [[{ accepted: [], rejected: ['hello@niceworkshop.ca'] }, 'rejected'],
    [{ accepted: ['someone@example.com'] }, 'unknown'], [{ accepted: [] }, 'unknown'], [undefined, 'unknown']]) {
    const { sender } = setup(() => result);
    await assert.rejects(sender.send(message()), { deliveryOutcome: outcome });
  }
});

test('pickup tells customers the correct location, hours and order identification', () => {
  const email = renderReadyEmail({ kind: 'pickup', orderName: '#1001', cutList: [
    { shape: 'rectangle', quantity: 3, widthUnits: 3048000, heightUnits: 6096000 },
    { shape: 'circle', quantity: 1, widthUnits: 1270000, heightUnits: 1270000 },
  ] });
  assert.equal(email.subject, 'Nice Workshop #1001: ready for pickup');
  assert.match(email.text, /pickup box in our driveway/);
  assert.match(email.text, /1019 Castleford Road\nRenfrew, ON K7V 3Z8/);
  assert.match(email.text, /Monday–Friday, 9am–7pm \(Toronto time\)/);
  assert.match(email.text, /order confirmation or order number/);
  assert.match(email.text, /3 rectangles · 304.8 × 609.6 mm/);
  assert.match(email.text, /1 circle · 127 mm diameter/);
  assert.doesNotMatch(email.text, /photo ID|government|already picked up|already delivered/i);
});

test('drop-off Ready promises a later scheduling email without claiming dispatch or fulfillment', () => {
  const input = { orderName: '#1002', deliveryAddress: { address1: '123 Test Road', city: 'Arnprior', provinceCode: 'ON', zip: 'K7S 0A1' } };
  const email = renderReadyEmail({ ...input, kind: 'delivery' });
  assert.deepEqual(email, renderReadyEmail({ ...input, kind: 'dropoff' }));
  assert.match(email.subject, /ready for drop-off/);
  assert.match(email.text, /We’ll email you to confirm your drop-off time/);
  assert.match(email.text, /We deliver Monday–Friday, 9am–7pm \(Toronto time\)/);
  assert.match(email.text, /123 Test Road\nArnprior, ON K7S 0A1/);
  assert.doesNotMatch(email.text, /has shipped|on its way|out for delivery|has been delivered|pickup box/i);
});

test('templates escape every customer-controlled HTML field and label previews unmistakably', () => {
  const email = renderReadyEmail({ kind: 'delivery', orderName: '#1002 <img src=x onerror=alert(1)>', test: true,
    deliveryAddress: { address1: '123 <script>alert(1)</script> Road', address2: 'Unit "A" & B', city: 'Renfrew', provinceCode: 'ON', zip: 'K7V 3Z8' } });
  assert.match(email.subject, /^\[TEST\]/);
  assert.match(email.text, /^TEST PREVIEW — this is a sample email, not an order ready/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /&lt;img/);
  assert.match(email.html, /Unit &quot;A&quot; &amp; B/);
  assert.doesNotMatch(email.html, /<script|<img|unsubscribe|tracking pixel/);
  assert.throws(() => renderReadyEmail({ kind: 'pickup', orderName: '#1\nBcc:person@example.com' }), { code: 'EMAIL_INVALID' });
});

test('unsupported readiness kind or corrupt cut snapshot cannot produce an email', () => {
  for (const input of [{ kind: 'shipping', orderName: '#1' }, { kind: 'pickup', orderName: '' },
    { kind: 'pickup', orderName: '#1', cutList: [{ shape: 'rectangle', quantity: -1, widthUnits: 1, heightUnits: 1 }] },
    { kind: 'pickup', orderName: '#1', cutList: [{ shape: 'circle', quantity: 1, widthUnits: 100, heightUnits: 200 }] }]) {
    assert.throws(() => renderReadyEmail(input), { code: 'EMAIL_INVALID' });
  }
});

test('preview script defaults to files only and rejects recipient overrides', async () => {
  const { main } = require('../scripts/send-email-previews');
  const result = await main([], {});
  assert.equal(result.action, 'rendered');
  assert.equal(result.sent, 0);
  assert.match(result.directory, /output\/email-previews$/);
  await assert.rejects(main(['--send', '--to=someone@example.com'], {}), /Usage:/);
  await assert.rejects(main(['--send'], {}), /Email is disabled/);
});
