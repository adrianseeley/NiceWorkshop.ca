'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { createApp } = require('../server/http');
const { verifyWebhook } = require('../server/webhooks');
const config = require('../materials.json');
async function fixture(t, options = {}) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => {
    if (!options?.headers?.host) return fetch(origin + path, options);
    // Node's fetch replaces Host. Use a real HTTP request to verify aliases.
    return new Promise((resolve, reject) => {
      const req = httpRequest(origin + path, {method:options.method,headers:options.headers}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(options.method === 'HEAD' ? null : Buffer.concat(chunks),
          {status:res.statusCode,headers:res.headers})));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(options.body);
    });
  };
}
const payload = { cuts: [{ sheetId: config.sheets[0].id, shape: 'rectangle', widthUnits: 1000000, heightUnits: 1000000, quantity: 1 }], fulfillment: 'pickup' };
test('server serves storefront but never repository secrets or operations', async t => {
  const request = await fixture(t);
  assert.equal((await request('/')).status, 200);
  for (const path of ['/nice-workshop-family.webp', '/mighty-fine-pastries.webp']) {
    const photo = await request(path);
    assert.equal(photo.status, 200, path);
    assert.equal(photo.headers.get('content-type'), 'image/webp', path);
  }
  for (const path of ['/.env', '/.git/config', '/server/db.js', '/OPERATIONS.md', '/package.json']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/readyz')).status, 503);
  assert.equal((await request('/healthz')).status, 200);
});
test('analytics stays off by default and only exposes the configured public ingest token', async t => {
  const request = await fixture(t);
  assert.deepEqual((await (await request('/api/config')).json()).analytics, {enabled:false});
  assert.equal((await request('/analytics.js')).status, 200);
  assert.equal((await request('/privacy')).status, 200);
  assert.equal((await request('/server/analytics.js')).status, 404);
  assert.doesNotMatch((await request('/')).headers.get('content-security-policy'), /posthog/);
  const enabled = await fixture(t, {env:{ANALYTICS_ENABLED:'true',POSTHOG_PROJECT_TOKEN:'phc_testpublictoken',
    POSTHOG_HOST:'https://eu.i.posthog.com',PUBLIC_ORIGIN:'https://www.niceworkshop.ca',
    POSTHOG_PERSONAL_API_KEY:'never-expose-this'}});
  const configResponse = await enabled('/api/config');
  const body = await configResponse.json();
  assert.deepEqual(body.analytics, {enabled:true,projectToken:'phc_testpublictoken',
    host:'https://eu.i.posthog.com',publicOrigin:'https://www.niceworkshop.ca'});
  assert.doesNotMatch(JSON.stringify(body), /never-expose/);
  const csp = (await enabled('/')).headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' https:\/\/eu\.i\.posthog\.com/);
  assert.doesNotMatch(csp, /us\.i\.posthog\.com/);
});
test('quote validates request and uses trusted source pricing', async t => {
  const request = await fixture(t);
  const response = await request('/api/quote', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.ok(quote.subtotalCents > 0);
  assert.equal(quote.catalogueSnapshot, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/quote', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({...payload, subtotalCents: 1}) })).status, 400);
  assert.equal((await request('/api/quote', { method:'POST', headers:{'content-type':'application/json'}, body:'{' })).status, 400);
});
test('checkout stays closed before live configuration, even with an environment flag', async t => {
  const request = await fixture(t, { env: { CHECKOUT_ENABLED: 'true' } });
  const response = await request('/api/checkout', { method: 'POST' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'CHECKOUT_NOT_READY');
});
test('staff routes fail closed and do not touch storage without a valid token', async t => {
  let calls = 0;
  const request = await fixture(t, { env: { ADMIN_API_TOKEN: 'a'.repeat(32) }, pool: { query: async () => { calls++; return { rows: [] }; } } });
  assert.equal((await request('/api/admin/orders')).status, 401);
  assert.equal((await request('/api/admin/orders', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await request('/api/admin/orders', { headers: { authorization: `Bearer ${'a'.repeat(32)}` } })).status, 200);
  assert.equal(calls, 1);
});
test('webhook authenticates the original bytes and expected shop/topic', () => {
  const body = Buffer.from('{ "id": 123 }');
  const secret = 'test-secret';
  const headers = { 'x-shopify-shop-domain': 'test.myshopify.com', 'x-shopify-topic': 'orders/paid', 'x-shopify-webhook-id':'event-1', 'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64') };
  const settings = {secret, shopDomain:'test.myshopify.com'};
  assert.equal(verifyWebhook(body, headers, settings), true);
  assert.equal(verifyWebhook(Buffer.from('{"id":123}'), headers, settings), false);
  assert.equal(verifyWebhook(body, {...headers,'x-shopify-hmac-sha256':'short'}, settings), false);
  assert.equal(verifyWebhook(body, {...headers,'x-shopify-shop-domain':'other.myshopify.com'}, settings), false);
  assert.equal(verifyWebhook(body, {...headers,'x-shopify-topic':'unknown'}, settings), false);
});
test('webhook is only acknowledged after database persistence; storage failure is retryable', async t => {
  const body = '{"id":123}';
  let fail = false, calls = 0;
  const request = await fixture(t, { env: { SHOPIFY_SHOP_DOMAIN:'test.myshopify.com', SHOPIFY_WEBHOOK_SECRET:'test' }, pool: { query: async(sql, args) => { calls++; assert.match(sql,/raw_body_hash/); assert.deepEqual(args[4],{id:123}); if(fail) throw new Error('private database detail'); return {rowCount:1}; } } });
  const headers = {'content-type':'application/json','x-shopify-shop-domain':'test.myshopify.com','x-shopify-topic':'orders/paid','x-shopify-webhook-id':'event-1','x-shopify-hmac-sha256':createHmac('sha256','test').update(body).digest('base64')};
  assert.equal((await request('/api/webhooks/shopify',{method:'POST',headers,body})).status,200);
  fail = true;
  const response = await request('/api/webhooks/shopify',{method:'POST',headers,body});
  assert.equal(response.status,500);
  assert.doesNotMatch(await response.text(),/private database detail/);
  assert.equal(calls,2);
});
test('production redirects to the configured HTTPS origin, never a supplied Host', async t => {
  const request = await fixture(t, {env:{NODE_ENV:'production',PUBLIC_ORIGIN:'https://workshop.example'}});
  const response = await request('/staff', {redirect:'manual',headers:{host:'attacker.example'}});
  assert.equal(response.status,308);
  assert.equal(response.headers.get('location'),'https://workshop.example/staff');
  assert.equal((await request('/api/checkout',{method:'POST'})).status,400);
  assert.equal((await request('/healthz',{headers:{'x-forwarded-proto':'https'}})).status,200);
});
test('secure browser visits to an alias move to the public origin with path and query preserved', async t => {
  const request = await fixture(t, {env:{NODE_ENV:'production',PUBLIC_ORIGIN:'https://www.niceworkshop.ca'}});
  const alias = {host:'old-workshop.herokuapp.com','x-forwarded-proto':'https','x-forwarded-host':'attacker.example'};
  for (const [method, path] of [['GET','/?from=old'],['GET','/staff?view=orders'],['HEAD','/index.html'],['GET','/staff.js']]) {
    const response = await request(path, {method,redirect:'manual',headers:alias});
    assert.equal(response.status,308);
    assert.equal(response.headers.get('location'),`https://www.niceworkshop.ca${path}`);
  }
  const canonical = await request('/staff', {redirect:'manual',headers:{...alias,host:'www.niceworkshop.ca'}});
  assert.equal(canonical.status,200);
  assert.equal(canonical.headers.get('location'),null);
  const post = await request('/staff', {method:'POST',redirect:'manual',headers:alias});
  assert.equal(post.status,404);
  assert.equal(post.headers.get('location'),null);
});
test('secure API, webhook and health requests remain available at the Heroku hostname', async t => {
  let saved = false;
  const request = await fixture(t, {env:{NODE_ENV:'production',PUBLIC_ORIGIN:'https://www.niceworkshop.ca',
    SHOPIFY_SHOP_DOMAIN:'test.myshopify.com',SHOPIFY_WEBHOOK_SECRET:'test'},
  pool:{query:async sql => {if (/INSERT INTO webhook_deliveries/.test(sql)) saved = true; return {rows:[],rowCount:1};}}});
  const headers = {host:'old-workshop.herokuapp.com','x-forwarded-proto':'https'};
  for (const path of ['/healthz','/readyz','/api/config','/API/config','/healthz/']) {
    const response = await request(path, {redirect:'manual',headers});
    assert.equal(response.status,200,path);
    assert.equal(response.headers.get('location'),null);
  }
  const quote = await request('/api/quote', {method:'POST',redirect:'manual',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(quote.status,200);
  const body = '{"id":123}';
  const webhook = await request('/api/webhooks/shopify', {method:'POST',redirect:'manual',body,headers:{...headers,
    'content-type':'application/json','x-shopify-shop-domain':'test.myshopify.com','x-shopify-topic':'orders/paid',
    'x-shopify-webhook-id':'event-alias','x-shopify-hmac-sha256':createHmac('sha256','test').update(body).digest('base64')}});
  assert.equal(webhook.status,200);
  assert.equal(webhook.headers.get('location'),null);
  assert.equal(saved,true);
});
test('staff can retrieve older order pages', async t => {
  let values;
  const request = await fixture(t,{env:{ADMIN_API_TOKEN:'a'.repeat(32)},pool:{query:async(_sql,args)=>{values=args;return {rows:[]};}}});
  const response = await request('/api/admin/orders?offset=50',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}});
  assert.equal(response.status,200);
  assert.deepEqual(values,[50,50]);
});

test('readiness requires staff authentication and configured mail, and rejects recipient overrides', async t => {
  let calls = 0;
  const request = await fixture(t,{env:{ADMIN_API_TOKEN:'a'.repeat(32)},pool:{query:async()=>{calls++;return {rows:[]};}}});
  const path = '/api/admin/orders/00000000-0000-4000-8000-000000000001/ready';
  const headers = {'content-type':'application/json',authorization:`Bearer ${'a'.repeat(32)}`};
  assert.equal((await request(path,{method:'POST',headers:{'content-type':'application/json'},body:'{"expectedRevision":1}'})).status,401);
  assert.equal((await request(path,{method:'POST',headers,body:'{"expectedRevision":1,"to":"other@example.test"}'})).status,400);
  const unavailable = await request(path,{method:'POST',headers,body:'{"expectedRevision":1}'});
  assert.equal(unavailable.status,503);
  assert.equal((await unavailable.json()).code,'notification_unconfigured');
  assert.equal(calls,0);
  const list = await request('/api/admin/orders',{headers});
  assert.equal((await list.json()).notification_connected,false);
});
