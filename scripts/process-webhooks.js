#!/usr/bin/env node
'use strict';
const { createPool } = require('../server/db');
const { processWebhookBatch } = require('../server/process-webhooks');

(async () => {
  const pool = createPool();
  try {
    const results = await processWebhookBatch(pool, { shopDomain: process.env.SHOPIFY_SHOP_DOMAIN, limit: 100 });
    console.log(JSON.stringify({ processed: results.filter(row => row.state === 'processed').length,
      needsReconciliation: results.filter(row => row.state === 'needs_reconciliation').length,
      ignored: results.filter(row => row.state === 'ignored').length }));
  } finally { await pool.end(); }
})().catch(() => { console.error('Webhook processing failed; persisted events remain available for retry.'); process.exitCode = 1; });
