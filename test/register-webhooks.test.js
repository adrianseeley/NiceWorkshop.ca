'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerWebhooks, main, SHOP_DOMAIN, CALLBACK_URL, TOPICS,
  LIST_SUBSCRIPTIONS, CREATE_SUBSCRIPTION } = require('../scripts/register-webhooks');

const subscription = (topic, id = 1, extra = {}) => ({ id: `gid://shopify/WebhookSubscription/${id}`, topic,
  uri: CALLBACK_URL, format: 'JSON', filter: null, includeFields: [], apiVersion: { handle: '2026-10' }, ...extra });
const list = (nodes, hasNextPage = false, endCursor = null) => ({ webhookSubscriptions: { nodes, pageInfo: { hasNextPage, endCursor } } });

test('registration lists first, creates only missing topics, and an exact rerun makes no mutations', async () => {
  const existing = [subscription('ORDERS_PAID')];
  const calls = [];
  const client = { shopDomain: SHOP_DOMAIN, apiVersion: '2026-10', request: async (query, variables) => {
    calls.push({ query, variables });
    if (query === LIST_SUBSCRIPTIONS) return list(existing);
    assert.equal(query, CREATE_SUBSCRIPTION);
    assert.deepEqual(variables.subscription, { uri: CALLBACK_URL, format: 'JSON' });
    const created = subscription(variables.topic, existing.length + 1);
    existing.push(created);
    return { webhookSubscriptionCreate: { webhookSubscription: created, userErrors: [] } };
  } };
  const first = await registerWebhooks(client);
  assert.deepEqual(first.existing, ['ORDERS_PAID']);
  assert.deepEqual(first.created, TOPICS.slice(1));
  assert.equal(calls[0].query, LIST_SUBSCRIPTIONS);
  const count = calls.length;
  const second = await registerWebhooks(client);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.existing, [...TOPICS]);
  assert.equal(calls.length, count + 1);
});

test('all pages are inspected before mutations and unrelated subscriptions stay unchanged', async () => {
  const unrelated = subscription('PRODUCTS_UPDATE', 99, { uri: 'https://existing.example/webhook' });
  let pages = 0, creates = 0;
  const client = { shopDomain: SHOP_DOMAIN, apiVersion: '2026-10', request: async (query, variables) => {
    if (query === LIST_SUBSCRIPTIONS) {
      pages++;
      if (pages === 1) { assert.equal(variables.after, null); return list([unrelated], true, 'next-page'); }
      assert.equal(variables.after, 'next-page');
      return list(TOPICS.map((topic, i) => subscription(topic, i + 1)));
    }
    creates++; assert.fail('All required subscriptions already exist on the second page');
  } };
  const result = await registerWebhooks(client);
  assert.equal(pages, 2);
  assert.equal(creates, 0);
  assert.equal(result.otherSubscriptionsUnchanged, 1);
  assert.equal(unrelated.uri, 'https://existing.example/webhook');
});

test('mismatched existing subscriptions fail before any mutation rather than being overwritten', async () => {
  for (const extra of [{ format: 'XML' }, { filter: 'financial_status:paid' },
    { includeFields: ['id'] }, { apiVersion: { handle: '2026-07' } }]) {
    let calls = 0;
    const client = { shopDomain: SHOP_DOMAIN, request: async query => {
      calls++; assert.equal(query, LIST_SUBSCRIPTIONS);
      return list([subscription('REFUNDS_CREATE', 1, extra)]);
    } };
    await assert.rejects(registerWebhooks(client), { code: 'WEBHOOK_SUBSCRIPTION_CONFLICT' });
    assert.equal(calls, 1);
  }
});

test('uncertain creation stops; rerunning lists the possibly created subscription before proceeding', async () => {
  const existing = [];
  let uncertain = true, mutations = 0;
  const client = { shopDomain: SHOP_DOMAIN, request: async (query, variables) => {
    if (query === LIST_SUBSCRIPTIONS) return list(existing);
    mutations++;
    const created = subscription(variables.topic, existing.length + 1);
    existing.push(created);
    if (uncertain) { uncertain = false; throw new Error('Secret upstream response must not leak'); }
    return { webhookSubscriptionCreate: { webhookSubscription: created, userErrors: [] } };
  } };
  await assert.rejects(registerWebhooks(client), error => {
    assert.equal(error.code, 'WEBHOOK_REGISTRATION_UNCERTAIN');
    assert.doesNotMatch(error.message, /Secret/); return true;
  });
  assert.equal(mutations, 1);
  const result = await registerWebhooks(client);
  assert.deepEqual(result.existing, ['ORDERS_PAID']);
  assert.equal(mutations, 4, 'No second ORDERS_PAID creation');
});

test('partial successes are reported without exposing Shopify error messages', async () => {
  let mutation = 0;
  const client = { shopDomain: SHOP_DOMAIN, request: async (query, variables) => {
    if (query === LIST_SUBSCRIPTIONS) return list([]);
    mutation++;
    return mutation === 1
      ? { webhookSubscriptionCreate: { webhookSubscription: subscription(variables.topic), userErrors: [] } }
      : { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['topic'], message: 'Private details' }] } };
  } };
  await assert.rejects(registerWebhooks(client), error => {
    assert.equal(error.code, 'WEBHOOK_REGISTRATION_REJECTED');
    assert.deepEqual(error.summary.created, ['ORDERS_PAID']);
    assert.doesNotMatch(error.message, /Private/); return true;
  });
  assert.equal(mutation, 2);
});

test('invalid pagination and incomplete existing data do not allow registration', async () => {
  for (const response of [list([{ id: 'incomplete' }]), list([], true, null),
    { webhookSubscriptions: { nodes: [], pageInfo: {} } }]) {
    const client = { shopDomain: SHOP_DOMAIN, request: async query => {
      assert.equal(query, LIST_SUBSCRIPTIONS); return response;
    } };
    await assert.rejects(registerWebhooks(client));
  }
  const client = { shopDomain: SHOP_DOMAIN, request: async query => {
    assert.equal(query, LIST_SUBSCRIPTIONS); return list([], true, 'repeated');
  } };
  await assert.rejects(registerWebhooks(client), { code: 'WEBHOOK_PAGINATION_INVALID' });
});

test('target store, endpoint, and secret configuration are checked before authentication', async () => {
  const request = async () => assert.fail('No request should run');
  await assert.rejects(registerWebhooks({ shopDomain: 'other.myshopify.com', request }), { code: 'WEBHOOK_CONFIGURATION_INVALID' });
  await assert.rejects(registerWebhooks({ shopDomain: SHOP_DOMAIN, request }, { callbackUrl: 'https://unrelated.example/webhook' }),
    { code: 'WEBHOOK_CONFIGURATION_INVALID' });
  await assert.rejects(main({ SHOPIFY_SHOP_DOMAIN: SHOP_DOMAIN, SHOPIFY_CLIENT_ID: 'client',
    SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_WEBHOOK_SECRET: 'different' }), { code: 'WEBHOOK_CONFIGURATION_INVALID' });
  await assert.rejects(main({ SHOPIFY_SHOP_DOMAIN: SHOP_DOMAIN, SHOPIFY_CLIENT_ID: 'client',
    SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_WEBHOOK_SECRET: 'secret', PUBLIC_ORIGIN: 'https://unrelated.example' }),
    { code: 'WEBHOOK_CONFIGURATION_INVALID' });
});
