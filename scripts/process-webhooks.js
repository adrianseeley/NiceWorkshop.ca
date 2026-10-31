#!/usr/bin/env node
'use strict';
const { createPool } = require('../server/db');
const { processWebhookBatch } = require('../server/process-webhooks');
const { createShopifyClient } = require('../server/shopify');

(async () => {
  const pool = createPool();
  const shopifyClient = process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
    ? createShopifyClient({shopDomain:process.env.SHOPIFY_SHOP_DOMAIN,clientId:process.env.SHOPIFY_CLIENT_ID,
      clientSecret:process.env.SHOPIFY_CLIENT_SECRET,apiVersion:process.env.SHOPIFY_API_VERSION || '2026-10'}) : null;
  try {
    const results = await processWebhookBatch(pool, { shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,shopifyClient,limit:100 });
    console.log(JSON.stringify({ processed: results.filter(row => row.state === 'processed').length,
      needsReconciliation: results.filter(row => row.state === 'needs_reconciliation').length,
      ignored: results.filter(row => row.state === 'ignored').length }));
  } finally { await pool.end(); }
})().catch(() => { console.error('Webhook processing failed; persisted events remain available for retry.'); process.exitCode = 1; });
