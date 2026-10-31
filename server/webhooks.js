'use strict';
const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const TOPICS = new Set(['orders/paid', 'orders/updated', 'orders/cancelled', 'refunds/create']);
function verifyWebhook(raw, headers, { shopDomain, secret }) {
  if (!secret || !shopDomain) throw Object.assign(new Error('Webhook connection is not configured.'), { statusCode: 503 });
  const signature = headers['x-shopify-hmac-sha256'];
  if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  if (headers['x-shopify-shop-domain'] !== shopDomain || !TOPICS.has(headers['x-shopify-topic'])) return false;
  if (typeof headers['x-shopify-webhook-id'] !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(headers['x-shopify-webhook-id'])) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(signature, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Persist before acknowledging. Processing is deliberately separate so a slow
// Shopify request cannot cause an acknowledged event to be lost.
async function receiveWebhook(pool, raw, headers) {
  const payload = JSON.parse(raw.toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('Invalid webhook payload.'), { statusCode: 400 });
  const hash = createHash('sha256').update(raw).digest('hex');
  const result = await pool.query(`INSERT INTO webhook_deliveries
    (shop, webhook_id, topic, raw_body_hash, payload) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (shop, webhook_id) DO NOTHING RETURNING id`,
  [headers['x-shopify-shop-domain'], headers['x-shopify-webhook-id'], headers['x-shopify-topic'], hash, payload]);
  return { duplicate: result.rowCount === 0 };
}
module.exports = { verifyWebhook, receiveWebhook };
