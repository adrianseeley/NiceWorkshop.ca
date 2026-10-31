'use strict';

const { createShopifyClient, validateApiVersion } = require('../server/shopify');

// Deliberately pinned to this project's store and deployed endpoint. This script
// must never register subscriptions for another store or send orders elsewhere.
const SHOP_DOMAIN = 'waj4za-5t.myshopify.com';
const CALLBACK_URL = 'https://niceworkshop-ca-b8d9f27f02c2.herokuapp.com/api/webhooks/shopify';
const TOPICS = Object.freeze(['ORDERS_PAID', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']);

// Schema inspected and both operations validated against Admin API 2026-10.
// Query returns only this authenticated app's API-created, shop-scoped hooks.
// https://shopify.dev/docs/api/admin-graphql/2026-10/queries/webhookSubscriptions
const LIST_SUBSCRIPTIONS = `query NiceWorkshopWebhookSubscriptions($after: String) {
  webhookSubscriptions(first: 100, after: $after) {
    nodes { id topic uri format filter includeFields apiVersion { handle } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const CREATE_SUBSCRIPTION = `mutation NiceWorkshopWebhookSubscriptionCreate(
  $topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!
) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription { id topic uri format filter includeFields apiVersion { handle } }
    userErrors { field message }
  }
}`;

class RegistrationError extends Error {
  constructor(code, message, summary = null) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
    this.summary = summary;
  }
}

function configurationError() {
  return new RegistrationError('WEBHOOK_CONFIGURATION_INVALID', 'Use the intended store, deployed endpoint, and matching app/webhook secrets.');
}

function validSubscription(subscription) {
  return subscription && typeof subscription.id === 'string'
    && /^gid:\/\/shopify\/WebhookSubscription\/\d+$/.test(subscription.id)
    && typeof subscription.topic === 'string' && typeof subscription.uri === 'string'
    && typeof subscription.format === 'string' && (subscription.filter === null || typeof subscription.filter === 'string')
    && Array.isArray(subscription.includeFields)
    && subscription.includeFields.every(field => typeof field === 'string')
    && typeof subscription.apiVersion?.handle === 'string';
}

function exactSubscription(subscription, topic, apiVersion) {
  return subscription.topic === topic && subscription.uri === CALLBACK_URL
    && subscription.format === 'JSON' && !subscription.filter
    && subscription.includeFields.length === 0 && subscription.apiVersion.handle === apiVersion;
}

async function listSubscriptions(client) {
  const subscriptions = [];
  const cursors = new Set();
  let after = null;
  for (let page = 0; page < 100; page++) {
    const response = await client.request(LIST_SUBSCRIPTIONS, { after });
    const connection = response?.webhookSubscriptions;
    if (!Array.isArray(connection?.nodes) || connection.nodes.some(item => !validSubscription(item))
      || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new RegistrationError('WEBHOOK_LIST_INVALID', 'Shopify returned incomplete subscription data; no registrations were attempted.');
    }
    subscriptions.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return subscriptions;
    after = connection.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || cursors.has(after)) {
      throw new RegistrationError('WEBHOOK_PAGINATION_INVALID', 'Shopify subscription pagination could not be completed.');
    }
    cursors.add(after);
  }
  throw new RegistrationError('WEBHOOK_LIST_LIMIT', 'Review the unusually large subscription list before registering more.');
}

/**
 * Only creates missing full-JSON subscriptions belonging to this runtime app.
 * Always finishes listing before any mutation. Never deletes or updates hooks.
 * On an uncertain create response, stop; a rerun lists first to reconcile it.
 * App-wide TOML subscriptions are not returned by Shopify's list operation.
 */
async function registerWebhooks(client, { callbackUrl = CALLBACK_URL } = {}) {
  if (!client || client.shopDomain !== SHOP_DOMAIN || typeof client.request !== 'function' || callbackUrl !== CALLBACK_URL) {
    throw configurationError();
  }
  const apiVersion = validateApiVersion(client.apiVersion || '2026-10');
  const subscriptions = await listSubscriptions(client);
  const summary = { created: [], existing: [], duplicateTopics: [],
    otherSubscriptionsUnchanged: subscriptions.filter(item => !TOPICS.includes(item.topic) || item.uri !== CALLBACK_URL).length };

  // A partial payload/filter/old API version at our exact endpoint needs review.
  // Do not overwrite it or silently create a second competing subscription.
  for (const topic of TOPICS) {
    const matchingEndpoint = subscriptions.filter(item => item.topic === topic && item.uri === CALLBACK_URL);
    if (matchingEndpoint.some(item => !exactSubscription(item, topic, apiVersion))) {
      throw new RegistrationError('WEBHOOK_SUBSCRIPTION_CONFLICT',
        'An existing subscription at this endpoint has different settings; review it without automatic changes.', summary);
    }
    if (matchingEndpoint.length) summary.existing.push(topic);
    if (matchingEndpoint.length > 1) summary.duplicateTopics.push(topic);
  }

  for (const topic of TOPICS) {
    if (summary.existing.includes(topic)) continue;
    let response;
    try {
      response = await client.request(CREATE_SUBSCRIPTION, { topic,
        subscription: { uri: CALLBACK_URL, format: 'JSON' } });
    } catch {
      throw new RegistrationError('WEBHOOK_REGISTRATION_UNCERTAIN',
        'A registration outcome is uncertain. Run the script again to list existing subscriptions before creating anything else.', summary);
    }
    const payload = response?.webhookSubscriptionCreate;
    if (Array.isArray(payload?.userErrors) && payload.userErrors.length && !payload.webhookSubscription) {
      throw new RegistrationError('WEBHOOK_REGISTRATION_REJECTED', 'Shopify rejected a subscription; check the app scopes and configuration.', summary);
    }
    if (!validSubscription(payload?.webhookSubscription) || !Array.isArray(payload?.userErrors) || payload.userErrors.length
      || !exactSubscription(payload.webhookSubscription, topic, apiVersion)) {
      throw new RegistrationError('WEBHOOK_REGISTRATION_UNCERTAIN', 'Shopify did not confirm the requested subscription settings. List and review before continuing.', summary);
    }
    summary.created.push(topic);
  }
  return summary;
}

/** Reads environment only. Never reads credential files or prints tokens. */
async function main(env = process.env) {
  if (env.SHOPIFY_SHOP_DOMAIN !== SHOP_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET
    || env.SHOPIFY_WEBHOOK_SECRET !== env.SHOPIFY_CLIENT_SECRET
    || (env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN.replace(/\/$/, '') !== new URL(CALLBACK_URL).origin)) {
    throw configurationError();
  }
  const client = createShopifyClient({ shopDomain: env.SHOPIFY_SHOP_DOMAIN, clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET, apiVersion: env.SHOPIFY_API_VERSION || '2026-10' });
  const result = await registerWebhooks(client);
  console.log(`Webhook registration complete: ${result.created.length} created, ${result.existing.length} already present, ${result.otherSubscriptionsUnchanged} other subscriptions unchanged.`);
  if (result.duplicateTopics.length) console.log(`${result.duplicateTopics.length} topic(s) already have duplicate matching subscriptions; none were changed.`);
  return result;
}

if (require.main === module) main().catch(error => {
  const code = error instanceof RegistrationError ? error.code : 'WEBHOOK_REGISTRATION_FAILED';
  const created = error instanceof RegistrationError ? error.summary?.created.length || 0 : 0;
  console.error(`Webhook registration stopped (${code}); ${created} creation(s) confirmed. Existing subscriptions were not modified.`);
  process.exitCode = 1;
});

module.exports = { registerWebhooks, listSubscriptions, main, RegistrationError,
  SHOP_DOMAIN, CALLBACK_URL, TOPICS, LIST_SUBSCRIPTIONS, CREATE_SUBSCRIPTION };
