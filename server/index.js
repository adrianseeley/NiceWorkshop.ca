'use strict';
const { createApp } = require('./http');
const { createPool } = require('./db');
const { createShopifyClient } = require('./shopify');
const { processWebhookBatch } = require('./process-webhooks');
const { createMailSender } = require('./email');
const { processNotificationBatch } = require('./notifications');
const shopifyClient = process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
  ? createShopifyClient({shopDomain:process.env.SHOPIFY_SHOP_DOMAIN,clientId:process.env.SHOPIFY_CLIENT_ID,clientSecret:process.env.SHOPIFY_CLIENT_SECRET,apiVersion:process.env.SHOPIFY_API_VERSION || '2026-10'}) : null;
const pool = process.env.DATABASE_URL ? createPool() : null;
if (pool) pool.on('error', () => console.error('Database connection interrupted.'));
const mailSender = createMailSender(process.env);
const server = createApp({ pool, shopifyClient, mailSender }).listen(Number(process.env.PORT || 3000), () => console.log('Nice Workshop server started.'));
let working = null;
const timer = pool && process.env.SHOPIFY_SHOP_DOMAIN ? setInterval(() => {
  if (working) return;
  working = processWebhookBatch(pool, {shopDomain:process.env.SHOPIFY_SHOP_DOMAIN,limit:20})
    .then(() => processNotificationBatch(pool, {shopifyClient,mailSender,shopDomain:process.env.SHOPIFY_SHOP_DOMAIN,limit:5}))
    .catch(() => console.error('Order processing interrupted; persisted work retained for review.'))
    .finally(() => { working = null; });
}, 3000) : null;
timer?.unref();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  server.close(async () => { if (working) await working; if (pool) await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
