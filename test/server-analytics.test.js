'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { analyticsSettings, botTrafficMiddleware } = require('../server/analytics');

const enabledEnv = {
  ANALYTICS_ENABLED: 'true',
  ANALYTICS_BOT_TRACKING_ENABLED: 'true',
  POSTHOG_PROJECT_TOKEN: 'phc_testToken123',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  PUBLIC_ORIGIN: 'https://www.niceworkshop.ca'
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function request(middleware, overrides = {}) {
  const req = {
    method: 'GET', path: '/',
    get: name => name === 'user-agent' ? 'Mozilla/5.0 (compatible; Googlebot/2.1)' : undefined,
    ...overrides
  };
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  let continued = 0;
  middleware(req, res, () => { continued++; });
  assert.equal(continued, 1, 'analytics never delays the next handler');
  return res;
}

test('analytics configuration fails closed and exposes only the public token and approved host', () => {
  assert.deepEqual(analyticsSettings({}), { enabled: false });
  assert.deepEqual(analyticsSettings(enabledEnv), {
    enabled: true, projectToken: enabledEnv.POSTHOG_PROJECT_TOKEN,
    host: enabledEnv.POSTHOG_HOST, publicOrigin: enabledEnv.PUBLIC_ORIGIN
  });
  for (const change of [
    { ANALYTICS_ENABLED: 'false' }, { POSTHOG_PROJECT_TOKEN: 'phx_privateToken' },
    { POSTHOG_PROJECT_TOKEN: 'phc_bad token' }, { POSTHOG_HOST: 'https://attacker.example' },
    { POSTHOG_HOST: 'https://us.i.posthog.com/redirect' }, { PUBLIC_ORIGIN: 'invalid' },
    { PUBLIC_ORIGIN: 'http://www.niceworkshop.ca' },
    { PUBLIC_ORIGIN: 'https://name:password@www.niceworkshop.ca' },
    { PUBLIC_ORIGIN: 'https://www.niceworkshop.ca/?secret=1' },
    { PUBLIC_ORIGIN: 'https://www.niceworkshop.ca/private' }
  ]) assert.deepEqual(analyticsSettings({ ...enabledEnv, ...change }), { enabled: false });
  assert.equal(analyticsSettings({ ...enabledEnv, POSTHOG_HOST: 'https://eu.i.posthog.com' }).enabled, true);
});

test('bot reporting requires both flags, a recognized crawler, and a successful public page GET', async () => {
  const sent = [];
  const fetchImpl = async (...args) => { sent.push(args); };
  for (const env of [{}, { ...enabledEnv, ANALYTICS_ENABLED: 'false' },
    { ...enabledEnv, ANALYTICS_BOT_TRACKING_ENABLED: 'false' }]) {
    request(botTrafficMiddleware(env, { fetchImpl })).emit('finish');
  }
  const middleware = botTrafficMiddleware(enabledEnv, { fetchImpl });
  for (const path of ['/staff', '/api/config', '/api/checkout', '/healthz', '/app.js', '/missing']) {
    request(middleware, { path }).emit('finish');
  }
  request(middleware, { method: 'HEAD' }).emit('finish');
  request(middleware, { method: 'POST' }).emit('finish');
  request(middleware, { get: () => 'Mozilla/5.0 Chrome/130.0 Safari/537.36' }).emit('finish');
  request(middleware, { get: () => 'UnknownCrawler/1.0' }).emit('finish');
  request(middleware, { get: () => undefined }).emit('finish');
  const failed = request(middleware);
  failed.statusCode = 404;
  failed.emit('finish');
  const redirected = request(middleware);
  redirected.statusCode = 308;
  redirected.emit('finish');
  await tick();
  assert.equal(sent.length, 0);
  const successful = request(middleware, { path: '/index.html' });
  assert.equal(sent.length, 0, 'waits until the response is finished');
  successful.emit('finish');
  successful.emit('finish');
  await tick();
  assert.equal(sent.length, 1, 'at most one event per response');
});

test('bot requests omit sensitive request data and normalize URL and software name', async () => {
  let sent;
  const middleware = botTrafficMiddleware(enabledEnv, { fetchImpl: async (...args) => { sent = args; } });
  request(middleware, {
    originalUrl: '/?email=private@example.test', ip: '192.0.2.55',
    headers: { cookie: 'secret=private', referer: 'https://private.example/path' },
    get: () => `GOOGLEBOT email=private@example.test ${'a'.repeat(400)}`
  }).emit('finish');
  await tick();
  assert.equal(sent[0], 'https://us.i.posthog.com/i/v0/e/');
  const payload = JSON.parse(sent[1].body);
  assert.equal(payload.event, '$http_log');
  assert.match(payload.distinct_id, /^http_log_[0-9a-f-]{36}$/);
  assert.equal(payload.properties.$current_url, 'https://www.niceworkshop.ca/');
  assert.equal(payload.properties.$raw_user_agent, 'Googlebot');
  assert.equal(payload.properties.$process_person_profile, false);
  assert.equal(payload.properties.$geoip_disable, true);
  assert.equal(payload.properties.source, 'server_bot_request');
  assert.equal(payload.properties.metric, 'requests');
  assert.doesNotMatch(sent[1].body, /private|192\.0\.2\.55|cookie|email/);
  assert.ok(sent[1].signal instanceof AbortSignal);
});

test('bot reporting bounds concurrency and silently tolerates thrown and rejected requests', async () => {
  let calls = 0;
  let resolveFirst, rejectSecond;
  const middleware = botTrafficMiddleware(enabledEnv, { fetchImpl: () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
    if (calls === 2) return new Promise((_resolve, reject) => { rejectSecond = reject; });
    throw new Error('provider unavailable');
  } });
  request(middleware).emit('finish');
  request(middleware).emit('finish');
  request(middleware).emit('finish');
  assert.equal(calls, 2);
  resolveFirst();
  rejectSecond(new Error('network failure'));
  await tick();
  request(middleware).emit('finish');
  request(middleware).emit('finish');
  await tick();
  assert.equal(calls, 4, 'failed requests release their concurrency slots without retries');
});

test('bot reporting caps attempts at 100 per hour per process and resets the window', async () => {
  let timestamp = 1000, calls = 0;
  const middleware = botTrafficMiddleware(enabledEnv, {
    now: () => timestamp,
    fetchImpl: async () => { calls++; }
  });
  for (let i = 0; i < 110; i++) {
    request(middleware).emit('finish');
    await tick();
  }
  assert.equal(calls, 100);
  timestamp += 60 * 60 * 1000;
  request(middleware).emit('finish');
  await tick();
  assert.equal(calls, 101);
});
