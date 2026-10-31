'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckout, verifyCheckoutUrl } = require('../server/checkout');
const { DELIVERY_PRICE_CENTS } = require('../server/shopify');

const shopDomain = 'nice-workshop.myshopify.com';
const address = { address1: '1019 Castleford Road', city: 'Renfrew', provinceCode: 'ON', countryCode: 'CA', zip: 'K7V 3Z8' };
const cut = { sheetId: 'birch-12-7', shape: 'rectangle', widthUnits: 3048000, heightUnits: 6096000, quantity: 3 };
const makeRequest = () => ({ input: { cuts: [{ ...cut }], fulfillment: 'pickup', acceptedTermsVersion: '2026-10-31' },
  idempotencyKey: '7a2674fc-f020-45e3-8d49-1636271ee848', termsVersion: '2026-10-31',
  fulfillmentConfig: {
    pickup: { approved: true, title: 'Shop Pickup', priceCents: 0, address },
    delivery: { approved: true, title: 'Local Delivery', priceCents: DELIVERY_PRICE_CENTS,
      taxTreatment: 'exclusive', serviceAreaConfirmed: true },
  } });
const draftResponse = overrides => ({ draftOrderCreate: { userErrors: [], draftOrder: {
  id: 'gid://shopify/DraftOrder/123', invoiceUrl: `https://${shopDomain}/invoices/test-checkout`, ready: true, ...overrides } } });

// A bounded SQL adapter for orchestration tests. The database suite separately
// verifies PostgreSQL uniqueness, locking, migrations, and immutable snapshots.
class MemoryPool {
  constructor() { this.rows = new Map(); this.failUpdates = false; }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async query(sql, values = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('INSERT INTO checkout_attempts')) {
      if (this.rows.has(values[1])) return { rows: [] };
      const row = { id: values[0], idempotency_key: values[1], request_hash: values[2], cuts: JSON.parse(values[3]),
        catalogue_snapshot: JSON.parse(values[4]), catalogue_hash: values[5], quoted_subtotal_cents: values[6],
        currency: values[7], fulfillment: values[8], lead_time_days: values[9], state: 'creating', metadata: JSON.parse(values[10]) };
      this.rows.set(row.idempotency_key, row);
      return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith('SELECT * FROM checkout_attempts')) {
      return { rows: this.rows.has(values[0]) ? [structuredClone(this.rows.get(values[0]))] : [] };
    }
    if (sql.startsWith('UPDATE checkout_attempts')) {
      if (this.failUpdates) throw new Error('Private database connection details must stay private');
      const row = [...this.rows.values()].find(value => value.id === values[0]);
      if (!row || row.state !== 'creating') return { rows: [] };
      if (sql.includes("state = 'ready'")) {
        Object.assign(row, { state: 'ready', shopify_draft_id: values[1], checkout_url: values[2], last_error_code: null });
      } else {
        Object.assign(row, { state: values[1], shopify_draft_id: values[2] ?? row.shopify_draft_id, last_error_code: values[3] });
      }
      return { rows: [structuredClone(row)] };
    }
    throw new Error('Unsupported test query');
  }
}

test('checkout persists exact immutable request metadata before making one draft and reuses its URL', async () => {
  const pool = new MemoryPool();
  const calls = [];
  const client = { shopDomain, request: async (query, variables) => {
    assert.equal([...pool.rows.values()][0].state, 'creating');
    calls.push({ query, variables });
    return draftResponse();
  } };
  const request = makeRequest();
  const result = await createCheckout(pool, client, request);
  const stored = pool.rows.get(request.idempotencyKey);
  assert.equal(result.state, 'ready');
  assert.equal(result.reused, false);
  assert.equal(stored.quoted_subtotal_cents, 5080);
  assert.deepEqual(stored.cuts, [cut]);
  assert.equal(stored.metadata.acceptedTermsVersion, request.termsVersion);
  assert.ok(Number.isFinite(Date.parse(stored.metadata.acceptedAt)));
  assert.equal(stored.metadata.shippingPriceCents, 0);
  assert.deepEqual(stored.metadata.fulfillmentAddress, address);
  assert.equal(stored.metadata.draftInput.lineItems[0].originalUnitPriceWithCurrency.amount, '50.80');
  assert.equal(calls[0].variables.input.customAttributes.find(item => item.key === 'nice_workshop_reference').value, stored.id);
  const second = await createCheckout(pool, client, request);
  assert.deepEqual(second, { ...result, reused: true });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].query, /draftOrderInvoiceSend|draftOrderComplete/);
});

test('simultaneous checkout submissions cannot make duplicate Shopify drafts', async () => {
  const pool = new MemoryPool();
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const client = { shopDomain, request: async () => {
    calls++; started();
    return new Promise(resolve => { finish = resolve; });
  } };
  const pending = createCheckout(pool, client, makeRequest());
  await began;
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_IN_PROGRESS', statusCode: 409 });
  assert.equal(calls, 1);
  finish(draftResponse());
  assert.equal((await pending).state, 'ready');
});

test('reusing an idempotency key for different cuts or fulfillment fails', async () => {
  const pool = new MemoryPool();
  let calls = 0;
  const client = { shopDomain, request: async () => { calls++; return draftResponse(); } };
  await createCheckout(pool, client, makeRequest());
  const changed = makeRequest();
  changed.input.cuts[0].quantity++;
  await assert.rejects(createCheckout(pool, client, changed), { code: 'IDEMPOTENCY_CONFLICT' });
  const delivery = makeRequest();
  delivery.input.fulfillment = 'delivery'; delivery.input.deliveryAddress = address;
  await assert.rejects(createCheckout(pool, client, delivery), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(calls, 1);
});

test('unknown network outcomes become reconciliation holds and cannot be automatically resubmitted', async () => {
  const pool = new MemoryPool();
  let calls = 0;
  const client = { shopDomain, request: async () => { calls++; throw new Error('secret connection details'); } };
  await assert.rejects(createCheckout(pool, client, makeRequest()), error => {
    assert.equal(error.code, 'CHECKOUT_NEEDS_RECONCILIATION');
    assert.doesNotMatch(error.message, /secret/); return true;
  });
  const row = [...pool.rows.values()][0];
  assert.equal(row.state, 'needs_reconciliation');
  assert.equal(row.last_error_code, 'CHECKOUT_OUTCOME_UNKNOWN');
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_NEEDS_RECONCILIATION' });
  assert.equal(calls, 1);
});

test('a known unfinished draft retains its ID for reconciliation instead of creating another one', async () => {
  const pool = new MemoryPool();
  const client = { shopDomain, request: async () => draftResponse({ ready: false, invoiceUrl: null }) };
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_NEEDS_RECONCILIATION' });
  const row = [...pool.rows.values()][0];
  assert.equal(row.state, 'needs_reconciliation');
  assert.equal(row.shopify_draft_id, 'gid://shopify/DraftOrder/123');
  assert.equal(row.last_error_code, 'SHOPIFY_DRAFT_NOT_READY');
});

test('a confirmed Shopify validation rejection is recorded without exposing upstream messages', async () => {
  const pool = new MemoryPool();
  const client = { shopDomain, request: async () => ({ draftOrderCreate: {
    draftOrder: null, userErrors: [{ field: ['input'], message: 'Customer private details' }],
  } }) };
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_REJECTED' });
  assert.equal([...pool.rows.values()][0].state, 'failed');
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_REJECTED' });
});

test('failure to save a created draft never triggers a second create mutation', async () => {
  const pool = new MemoryPool();
  let calls = 0;
  const client = { shopDomain, request: async () => { calls++; pool.failUpdates = true; return draftResponse(); } };
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_NEEDS_RECONCILIATION' });
  assert.equal([...pool.rows.values()][0].state, 'creating');
  await assert.rejects(createCheckout(pool, client, makeRequest()), { code: 'CHECKOUT_IN_PROGRESS' });
  assert.equal(calls, 1);
});

test('delivery snapshots store normalized customer address and the approved before-tax charge', async () => {
  const pool = new MemoryPool();
  const request = makeRequest();
  request.input.fulfillment = 'delivery';
  request.input.deliveryAddress = { ...address, city: '  arnprior ', zip: 'k7s1a1', address1: '10 Main Street' };
  const client = { shopDomain, request: async (_, variables) => {
    assert.equal(variables.input.shippingLine.priceWithCurrency.amount, '4.42');
    assert.equal(variables.input.shippingAddress.city, 'Arnprior');
    return draftResponse();
  } };
  await createCheckout(pool, client, request);
  const metadata = [...pool.rows.values()][0].metadata;
  assert.equal(metadata.shippingPriceCents, 442);
  assert.equal(metadata.deliveryAddress.zip, 'K7S 1A1');
  assert.deepEqual(metadata.deliveryAddress, metadata.fulfillmentAddress);
});

test('terms, allowed fields, idempotency keys, and delivery address are checked before external work', async () => {
  for (const alter of [
    r => { delete r.input.acceptedTermsVersion; }, r => { r.input.acceptedTermsVersion = 'old'; },
    r => { r.input.price = 1; }, r => { r.idempotencyKey = 'short'; },
    r => { r.input.deliveryAddress = address; }, r => { r.input.fulfillment = 'delivery'; },
    r => { r.input.fulfillment = 'delivery'; r.input.deliveryAddress = { ...address, city: 'Ottawa' }; },
  ]) {
    const pool = new MemoryPool(), request = makeRequest();
    alter(request);
    const client = { shopDomain, request: async () => assert.fail('No Shopify request expected') };
    await assert.rejects(createCheckout(pool, client, request));
    assert.equal(pool.rows.size, 0);
  }
});

test('checkout links are restricted to HTTPS on the intended shop or Shopify checkout service', async () => {
  assert.equal(verifyCheckoutUrl(`https://${shopDomain}/invoices/123`, shopDomain), `https://${shopDomain}/invoices/123`);
  assert.equal(verifyCheckoutUrl('https://checkout.shopify.com/123', shopDomain), 'https://checkout.shopify.com/123');
  for (const url of ['javascript:alert(1)', `http://${shopDomain}/123`, 'https://other.myshopify.com/invoices/123',
    `https://${shopDomain}.evil.example/invoices/123`, `https://user:password@${shopDomain}/123`,
    `https://${shopDomain}:8443/123`, `https://${shopDomain}/123#fragment`, 'not a URL']) {
    assert.throws(() => verifyCheckoutUrl(url, shopDomain), { code: 'CHECKOUT_URL_INVALID' });
  }
  const pool = new MemoryPool();
  await assert.rejects(createCheckout(pool, { shopDomain, request: async () => draftResponse({ invoiceUrl: 'https://evil.example' }) }, makeRequest()),
    { code: 'CHECKOUT_NEEDS_RECONCILIATION' });
  assert.equal([...pool.rows.values()][0].last_error_code, 'CHECKOUT_URL_INVALID');
});
