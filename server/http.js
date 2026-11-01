'use strict';
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { buildQuote } = require('./quote');
const { listOrders, setOrderCut } = require('./db');
const { verifyWebhook, receiveWebhook } = require('./webhooks');
const { createCheckout } = require('./checkout');
const { markOrderReady } = require('./notifications');
const { TERMS_VERSION, fulfillmentConfig, checkoutSettings } = require('./settings');
const { analyticsSettings, botTrafficMiddleware } = require('./analytics');
const ROOT = path.resolve(__dirname, '..');
function createApp({ pool = null, shopifyClient = null, mailSender = null, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
    const origin = new URL(env.PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Configure a secure public origin.');
    app.use((req, res, next) => {
      const browserMethod = ['GET', 'HEAD'].includes(req.method);
      const destination = origin.origin + (req.originalUrl.startsWith('/') ? req.originalUrl : '/');
      if (!req.secure) {
        if (browserMethod) return res.redirect(308, destination);
        return res.status(400).json({error:'Use HTTPS for this request.'});
      }
      // Shopify and health checks keep their stable Heroku URLs. Browser pages
      // use the public origin so their same-origin checkout requests can succeed.
      const servicePath = /^\/(?:api(?:\/|$)|healthz\/?$|readyz\/?$)/i.test(req.path);
      if (browserMethod && !servicePath && (req.get('host') || '').toLowerCase() !== origin.host.toLowerCase()) {
        return res.redirect(308, destination);
      }
      return next();
    });
  }
  const analytics = analyticsSettings(env);
  app.get('/api/config', (_req, res) => res.set('Cache-Control', 'no-store').json({
    ...checkoutSettings(env, pool, shopifyClient), analytics
  }));
  app.use(helmet({ contentSecurityPolicy: { directives: {
    upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
    connectSrc: ["'self'", ...(analytics.enabled ? [analytics.host] : [])]
  } } }));
  app.use(botTrafficMiddleware(env));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    if (!pool) return res.status(503).json({ status: 'database_unconfigured' });
    try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'database_unavailable' }); }
  });
  app.post('/api/webhooks/shopify', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!verifyWebhook(req.body, req.headers, { shopDomain: env.SHOPIFY_SHOP_DOMAIN, secret: env.SHOPIFY_WEBHOOK_SECRET })) return res.status(401).json({ error: 'Invalid webhook.' });
    if (!pool) return res.status(503).json({ error: 'Database unavailable.' });
    await receiveWebhook(pool, req.body, req.headers);
    res.sendStatus(200);
  });
  app.use('/api', express.json({ limit: '64kb' }));
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  app.post('/api/quote', limiter, (req, res) => {
    const quote = buildQuote(req.body);
    // Supplier costs and the immutable private catalogue belong in storage,
    // not in the public quote response.
    const { catalogueSnapshot, ...publicQuote } = quote;
    res.json(publicQuote);
  });
  app.post('/api/checkout', limiter, async (req, res) => {
    if (!checkoutSettings(env, pool, shopifyClient).checkoutEnabled) return res.status(503).json({
      error: 'Checkout is not open yet. No payment has been taken.', code: 'CHECKOUT_NOT_READY'
    });
    if (req.get('origin') !== env.PUBLIC_ORIGIN) return res.status(403).json({error:'Start checkout from the workshop website.'});
    const result = await createCheckout(pool, shopifyClient, {input:req.body,
      idempotencyKey:req.get('idempotency-key'), fulfillmentConfig, termsVersion:TERMS_VERSION});
    res.json(result);
  });
  app.use('/api/admin', (req, res, next) => {
    const expected = env.ADMIN_API_TOKEN;
    if (!expected || expected.length < 32) return res.status(503).json({ error: 'Staff access is not configured.' });
    const actual = req.get('authorization') || '';
    const a = Buffer.from(actual), b = Buffer.from(`Bearer ${expected}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Staff sign-in required.' });
    if (!pool) return res.status(503).json({ error: 'Database unavailable.' });
    next();
  });
  app.get('/api/admin/orders', async (req, res) => {
    const notification_connected = !!mailSender && !!shopifyClient;
    res.json({orders:await listOrders(pool, {limit:50,offset:Number(req.query.offset || 0),notificationEnabled:notification_connected}),notification_connected});
  });
  app.post('/api/admin/orders/:orderId/ready', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => key !== 'expectedRevision')) {
      return res.status(400).json({error:'Only the current order revision may be submitted.',code:'invalid_ready_update'});
    }
    if (!mailSender || !shopifyClient) return res.status(503).json({error:'Email sending isn’t connected yet.',code:'notification_unconfigured'});
    res.json(await markOrderReady(pool, {orderId:req.params.orderId,expectedRevision:req.body.expectedRevision,
      actor:'workshop-owner',shopifyClient,mailSender}));
  });
  app.patch('/api/admin/orders/:orderId/cut', async (req, res) => {
    const { isCut, expectedRevision, reason } = req.body || {};
    res.json(await setOrderCut(pool, { orderId: req.params.orderId, isCut, expectedRevision, reason, actor: 'workshop-owner' }));
  });
  app.get('/staff', (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT, 'staff.html')));
  app.get('/staff.js', (_req, res) => res.sendFile(path.join(ROOT, 'staff.js')));
  app.get('/privacy', (_req, res) => res.sendFile(path.join(ROOT, 'privacy.html')));
  // Never serve the repository root: it contains secrets, source and operations.
  for (const file of ['index.html', 'app.js', 'analytics.js', 'styles.css', 'favicon.svg', 'materials.json', 'nice-workshop-family.webp', 'mighty-fine-pastries.webp']) {
    app.get(file === 'index.html' ? ['/', '/index.html'] : `/${file}`, (_req, res) => res.sendFile(path.join(ROOT, file)));
  }
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    const status = error.statusCode || error.status || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status < 500 ? (error instanceof SyntaxError ? 'Invalid JSON.' : error.message) : 'Service temporarily unavailable.',
      ...(status < 500 && error.code ? { code: error.code } : {})
    });
  });
  return app;
}
module.exports = { createApp };
