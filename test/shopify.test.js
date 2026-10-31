'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQuote } = require('../server/quote');
const { createShopifyClient, buildDraftOrderInput, validateShopDomain, validateApiVersion,
  validateDeliveryAddress, DELIVERY_PRICE_CENTS, ShopifyError } = require('../server/shopify');

const cut = (extra = {}) => ({ sheetId: 'birch-12-7', shape: 'rectangle', widthUnits: 3048000,
  heightUnits: 6096000, quantity: 3, ...extra });
const makeQuote = (fulfillment = 'pickup', cuts = [cut()]) => buildQuote({ cuts, fulfillment });
const pickup = () => ({ approved: true, title: 'Shop Pickup', priceCents: 0,
  address: { address1: '1019 Castleford Road', city: 'Renfrew', provinceCode: 'ON', countryCode: 'CA', zip: 'K7V 3Z8' } });
const options = () => ({ reference: 'checkout-123', taxPolicy: 'shopify_authoritative', fulfillmentConfig: { pickup: pickup() } });
const credentials = { shopDomain: 'nice-workshop.myshopify.com', clientId: 'test-client', clientSecret: 'secret-never-in-errors' };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const token = (extra = {}) => ok({ access_token: 'test-access-token', expires_in: 86400, ...extra });

test('custom Shopify lines retain exact group subtotal and describe the real piece quantity', () => {
  const quote = makeQuote();
  const input = buildDraftOrderInput(quote, options());
  assert.equal(input.lineItems.length, 1);
  assert.equal(input.lineItems[0].quantity, 1);
  assert.equal(input.lineItems[0].originalUnitPriceWithCurrency.amount, '50.80');
  assert.equal(input.lineItems[0].originalUnitPriceWithCurrency.currencyCode, 'CAD');
  assert.match(input.lineItems[0].title, /3 pieces/);
  assert.equal(input.lineItems[0].customAttributes.find(item => item.key === 'Piece quantity').value, '3');
  assert.deepEqual(JSON.parse(input.lineItems[0].customAttributes.find(item => item.key === '_nice_workshop_cut').value), cut());
  assert.equal(input.lineItems[0].taxable, true);
  assert.equal(input.shippingLine.priceWithCurrency.amount, '0.00');
  assert.equal(input.shippingAddress.address1, '1019 Castleford Road');
  assert.equal(input.acceptAutomaticDiscounts, false);
  assert.equal(input.allowDiscountCodesInCheckout, false);
  assert.equal(input.taxExempt, false);
  assert.equal(input.customAttributes.find(item => item.key === 'nice_workshop_reference').value, 'checkout-123');
  assert.equal('email' in input, false);
});

test('multiple cut groups preserve subtotal without pretending to set the final tax', () => {
  const q = makeQuote('pickup', [cut(), cut({ shape: 'circle', sheetId: 'birch-25', widthUnits: 1270000, heightUnits: 1270000, quantity: 1 })]);
  const payload = buildDraftOrderInput(q, options());
  const total = payload.lineItems.reduce((sum, line) => sum + Math.round(Number(line.originalUnitPriceWithCurrency.amount) * 100), 0);
  assert.equal(total, q.subtotalCents);
  assert.equal('taxLines' in payload, false);
  assert.match(payload.lineItems.find(line => line.title.includes('Circle')).customAttributes.find(attribute => attribute.key === 'Size').value, /^Diameter/);
});

test('draft builder fails closed until tax and fulfillment terms are explicit', () => {
  for (const settings of [{}, { ...options(), taxPolicy: undefined },
    { ...options(), reference: 'invalid\nreference' }, { ...options(), fulfillmentConfig: {} },
    { ...options(), fulfillmentConfig: { pickup: { ...pickup(), approved: false } } },
    { ...options(), fulfillmentConfig: { pickup: { ...pickup(), priceCents: undefined } } }]) {
    assert.throws(() => buildDraftOrderInput(makeQuote(), settings), { code: 'SHOPIFY_CONFIGURATION_REQUIRED' });
  }
  assert.throws(() => buildDraftOrderInput(makeQuote('delivery'), options()), { code: 'SHOPIFY_CONFIGURATION_REQUIRED' });
  for (const alterations of [{}, { serviceAreaConfirmed: true }, { taxTreatment: 'exclusive' },
    { serviceAreaConfirmed: true, taxTreatment: 'inclusive' }]) {
    const settings = options();
    settings.fulfillmentConfig.delivery = { ...pickup(), title: 'Local Delivery', priceCents: DELIVERY_PRICE_CENTS, ...alterations };
    assert.throws(() => buildDraftOrderInput(makeQuote('delivery'), settings), { code: 'SHOPIFY_CONFIGURATION_REQUIRED' });
  }
  const settings = options();
  settings.fulfillmentConfig.delivery = { ...pickup(), title: 'Local Delivery', priceCents: DELIVERY_PRICE_CENTS,
    serviceAreaConfirmed: true, taxTreatment: 'exclusive' };
  assert.equal(buildDraftOrderInput(makeQuote('delivery'), settings).shippingLine.priceWithCurrency.amount, '4.42');
});

test('delivery address validation normalizes approved towns and rejects destinations outside the service area', () => {
  for (const city of ['Arnprior', 'Braeside', 'McNab', 'Renfrew']) {
    const result = validateDeliveryAddress({ ...pickup().address, city: `  ${city.toUpperCase()}  `,
      provinceCode: 'on', countryCode: 'ca', zip: ' k7v3z8 ', address1: '  1019   Castleford Road  ' });
    assert.equal(result.city, city);
    assert.equal(result.zip, 'K7V 3Z8');
    assert.equal(result.address1, '1019 Castleford Road');
  }
  for (const bad of [{ city: 'Ottawa' }, { city: 'Renfrew County' }, { provinceCode: 'QC' }, { countryCode: 'US' },
    { address1: 'Main Street' }, { address1: '123' }, { address1: '' }, { zip: '12345' }, { zip: 'D1D 1D1' },
    { zip: 'K7V 3Z8 arbitrary' }, { address2: 'unit\nmalformed' }, { email: 'unexpected@example.com' }]) {
    assert.throws(() => validateDeliveryAddress({ ...pickup().address, ...bad }), { code: 'INVALID_QUOTE' });
  }
  const settings = options();
  settings.fulfillmentConfig.delivery = { ...pickup(), title: 'Local Delivery', priceCents: DELIVERY_PRICE_CENTS,
    serviceAreaConfirmed: true, taxTreatment: 'exclusive', address: { ...pickup().address, city: 'Ottawa' } };
  assert.throws(() => buildDraftOrderInput(makeQuote('delivery'), settings), { code: 'INVALID_QUOTE' });
});

test('draft input refuses corrupted quotes, invalid prices, and unverified addresses', () => {
  assert.throws(() => buildDraftOrderInput({ ...makeQuote(), subtotalCents: 1 }, options()), ShopifyError);
  assert.throws(() => buildDraftOrderInput({ ...makeQuote(), catalogueHash: 'changed' }, options()), ShopifyError);
  assert.throws(() => buildDraftOrderInput({ ...makeQuote(), currency: 'USD' }, options()), ShopifyError);
  for (const address of [undefined, {}, { ...pickup().address, provinceCode: 'QC' }, { ...pickup().address, address1: '' }]) {
    const settings = options();
    settings.fulfillmentConfig.pickup.address = address;
    assert.throws(() => buildDraftOrderInput(makeQuote(), settings), ShopifyError);
  }
});

test('domain and API version validation keep credentials at a single Shopify origin', () => {
  assert.equal(validateShopDomain('nice-workshop.myshopify.com'), 'nice-workshop.myshopify.com');
  assert.equal(validateApiVersion('2026-10'), '2026-10');
  for (const domain of ['https://nice.myshopify.com', 'nice.myshopify.com.evil.example', 'nice.myshopify.com/path',
    'nice.myshopify.com:443', 'user@nice.myshopify.com', 'evil.example', '-nice.myshopify.com', 'nice-.myshopify.com']) {
    assert.throws(() => validateShopDomain(domain), ShopifyError);
  }
  for (const version of ['latest', 'unstable', '2026-11', '2026-10/../../other', '', null]) {
    assert.throws(() => validateApiVersion(version), ShopifyError);
  }
});

test('client gets and reuses a server token, pins API version, and disallows redirects', async () => {
  const calls = [];
  const client = createShopifyClient({ ...credentials, fetchImpl: async (url, request) => {
    calls.push({ url, request });
    return calls.length === 1 ? token() : ok({ data: { shop: { name: 'Nice Workshop' } } });
  } });
  assert.deepEqual(await client.request('query { shop { name } }'), { shop: { name: 'Nice Workshop' } });
  await client.request('query { shop { name } }');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://nice-workshop.myshopify.com/admin/oauth/access_token');
  assert.equal(new URLSearchParams(calls[0].request.body).get('grant_type'), 'client_credentials');
  assert.equal(calls[1].url, 'https://nice-workshop.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(calls[1].request.headers['X-Shopify-Access-Token'], 'test-access-token');
  assert.ok(calls.every(call => call.request.redirect === 'error'));
});

test('token refresh follows expires_in and concurrent requests share one refresh', async () => {
  let clock = 1000, tokenCalls = 0;
  const client = createShopifyClient({ ...credentials, now: () => clock, fetchImpl: async (url) => {
    if (url.endsWith('/access_token')) { tokenCalls++; return token({ access_token: `token-${tokenCalls}`, expires_in: 100 }); }
    return ok({ data: { shop: { name: 'Nice' } } });
  } });
  assert.deepEqual(await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]), ['token-1', 'token-1', 'token-1']);
  assert.equal(tokenCalls, 1);
  clock = 90000;
  assert.equal(await client.getAccessToken(), 'token-1');
  clock = 91000;
  assert.deepEqual(await Promise.all([client.getAccessToken(), client.getAccessToken()]), ['token-2', 'token-2']);
  assert.equal(tokenCalls, 2);
  client.invalidateToken();
  assert.equal(await client.getAccessToken(), 'token-3');
});

test('upstream failures never expose response text, token, credentials, or internal exceptions', async () => {
  const upstreamSecret = 'private upstream text and secret-never-in-errors';
  for (const response of [
    async () => { throw new Error(upstreamSecret); },
    async () => ({ ok: false, status: 500, text: async () => upstreamSecret }),
    async () => ok({ errors: [{ message: upstreamSecret }] }),
    async () => ({ ok: true, json: async () => { throw new Error(upstreamSecret); } }),
  ]) {
    let calls = 0;
    const client = createShopifyClient({ ...credentials, fetchImpl: async () => ++calls === 1 ? token() : response() });
    await assert.rejects(client.request('mutation { draftOrderCreate(input: {}) { draftOrder { id } } }'), error => {
      assert.ok(error instanceof ShopifyError);
      assert.equal(error.ambiguous, true);
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /private upstream|secret-never|test-access-token/);
      return true;
    });
    assert.equal(calls, 2, 'No automatic retries of an ambiguous mutation');
  }
});

test('401 invalidates the token without replaying the mutation', async () => {
  let tokenCalls = 0, apiCalls = 0;
  const client = createShopifyClient({ ...credentials, fetchImpl: async url => {
    if (url.endsWith('/access_token')) { tokenCalls++; return token(); }
    apiCalls++;
    return apiCalls === 1 ? { ok: false, status: 401 } : ok({ data: { shop: { name: 'Nice' } } });
  } });
  await assert.rejects(client.request('mutation { example }'), { code: 'SHOPIFY_UNAUTHORIZED' });
  assert.equal(apiCalls, 1);
  await client.request('query { shop { name } }');
  assert.equal(tokenCalls, 2);
});

test('invalid token responses and rate limits produce safe errors', async () => {
  for (const value of [{}, { access_token: 'secret', expires_in: 0 }, { access_token: 'secret', expires_in: '86400' }]) {
    const client = createShopifyClient({ ...credentials, fetchImpl: async () => ok(value) });
    await assert.rejects(client.getAccessToken(), { code: 'SHOPIFY_INVALID_TOKEN_RESPONSE' });
  }
  const client = createShopifyClient({ ...credentials, fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(client.getAccessToken(), { code: 'SHOPIFY_RATE_LIMITED' });
});
