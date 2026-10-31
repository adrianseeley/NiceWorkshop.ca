'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { poolOptions, migrate, transaction, listOrders, setOrderCut } = require('../server/db');

test('remote database TLS verifies certificates and ignores weaker URL options', () => {
  const options = poolOptions({ DATABASE_URL: 'postgres://user:password@db.example.test/nice?sslmode=require' });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'), false);
  assert.throws(() => poolOptions({ DATABASE_URL: 'postgres://user:password@db.example.test/nice', DATABASE_SSL: 'disable' }), /Verified TLS/);
  assert.throws(() => poolOptions({ DATABASE_URL: 'https://example.test' }), /PostgreSQL URL/);
  assert.throws(() => poolOptions({ DATABASE_URL: 'postgres://localhost/nice', DATABASE_POOL_MAX: '50' }), /1 and 20/);
});

test('local databases require an explicit setting to disable TLS', () => {
  assert.equal(poolOptions({ DATABASE_URL: 'postgres://localhost/nice' }).ssl.rejectUnauthorized, true);
  assert.equal(poolOptions({ DATABASE_URL: 'postgres://localhost/nice', DATABASE_SSL: 'disable' }).ssl, false);
});

test('cut updates validate identity, revision and reopening reason before touching the database', async () => {
  const pool = { connect() { throw new Error('must not connect'); } };
  const base = { orderId: randomUUID(), isCut: true, expectedRevision: 1, actor: 'staff:owner' };
  for (const patch of [{ actor: '' }, { expectedRevision: 0 }, { orderId: 'invalid' }, { isCut: 'yes' }, { isCut: false }]) {
    await assert.rejects(setOrderCut(pool, { ...base, ...patch }), { code: 'invalid_cut_update' });
  }
  await assert.rejects(listOrders(pool, { limit: 500 }), { code: 'invalid_pagination' });
});

test('PostgreSQL schema and production transitions', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run real PostgreSQL integration tests.'
}, async t => {
  const { Pool } = require('pg');
  const connection = new URL(process.env.TEST_DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname);
  const options = poolOptions({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL: process.env.TEST_DATABASE_SSL || (local ? 'disable' : 'verify-full') });
  const admin = new Pool(options);
  const schema = `nice_test_${randomUUID().replaceAll('-', '')}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...options, options: `-c search_path=${schema}` });
    assert.deepEqual(await migrate(pool), ['001_initial.sql', '002_checkout_metadata.sql']);
    assert.deepEqual(await migrate(pool), []);

    const cuts = [{ sheetId: 'test-sheet', shape: 'rectangle', widthUnits: 1000000, heightUnits: 1000000, quantity: 1 }];
    async function seed({ paymentStatus = 'paid', hold = null, refund = false, cancelled = false } = {}) {
      const attemptId = randomUUID();
      const orderId = randomUUID();
      await pool.query(`INSERT INTO checkout_attempts
        (id,idempotency_key,request_hash,cuts,catalogue_snapshot,catalogue_hash,quoted_subtotal_cents,fulfillment,lead_time_days)
        VALUES ($1,$2,$3,$4::jsonb,'{}'::jsonb,$3,100,'pickup',14)`,
      [attemptId, randomUUID(), 'a'.repeat(64), JSON.stringify(cuts)]);
      await pool.query(`INSERT INTO orders
        (id,shop,shopify_order_id,checkout_attempt_id,cuts,payment_status,hold_reason,refunded,cancelled_at)
        VALUES ($1,'nice-test.myshopify.com',$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [orderId, randomUUID(), attemptId, JSON.stringify(cuts), paymentStatus, hold, refund, cancelled ? new Date() : null]);
      return { orderId, attemptId };
    }

    await t.test('checkout price/cut snapshot is immutable and cut-state constraints reject inconsistent records', async () => {
      const { orderId, attemptId } = await seed();
      await assert.rejects(pool.query('UPDATE checkout_attempts SET quoted_subtotal_cents=101 WHERE id=$1', [attemptId]), { code: '23514' });
      await assert.rejects(pool.query('UPDATE checkout_attempts SET metadata=\'{"termsVersion":"changed"}\'::jsonb WHERE id=$1', [attemptId]), { code: '23514' });
      await assert.rejects(pool.query('UPDATE orders SET is_cut=true WHERE id=$1', [orderId]), { code: '23514' });
      await assert.rejects(pool.query('UPDATE checkout_attempts SET state=\'ready\' WHERE id=$1', [attemptId]), { code: '23514' });
    });

    await t.test('simultaneous real database checkout claims make one Shopify draft and preserve accepted metadata', async () => {
      const { createCheckout } = require('../server/checkout');
      const shopDomain = 'nice-test.myshopify.com';
      let started, finish;
      const began = new Promise(resolve => { started = resolve; });
      let calls = 0;
      const client = { shopDomain, request: async () => {
        calls++; started();
        return new Promise(resolve => { finish = resolve; });
      } };
      const request = {
        input: { cuts: [{ sheetId: 'birch-12-7', shape: 'rectangle', widthUnits: 3048000, heightUnits: 6096000, quantity: 3 }],
          fulfillment: 'pickup', acceptedTermsVersion: '2026-10-31' },
        idempotencyKey: randomUUID(), termsVersion: '2026-10-31',
        fulfillmentConfig: { pickup: { approved: true, title: 'Shop Pickup', priceCents: 0,
          address: { address1: '1019 Castleford Road', city: 'Renfrew', provinceCode: 'ON', countryCode: 'CA', zip: 'K7V 3Z8' } } }
      };
      const pending = createCheckout(pool, client, request);
      await began;
      try {
        await assert.rejects(createCheckout(pool, client, request), { code: 'CHECKOUT_IN_PROGRESS' });
        assert.equal(calls, 1);
      } finally {
        finish({ draftOrderCreate: { userErrors: [], draftOrder: { id: 'gid://shopify/DraftOrder/987654',
          invoiceUrl: `https://${shopDomain}/invoices/test-checkout`, ready: true } } });
      }
      const result = await pending;
      const retried = await createCheckout(pool, client, request);
      assert.deepEqual(retried, { ...result, reused: true });
      assert.equal(calls, 1);
      const stored = (await pool.query('SELECT metadata, quoted_subtotal_cents FROM checkout_attempts WHERE id=$1', [result.checkoutAttemptId])).rows[0];
      assert.equal(stored.metadata.acceptedTermsVersion, '2026-10-31');
      assert.equal(stored.quoted_subtotal_cents, '5080');
      await assert.rejects(pool.query('UPDATE checkout_attempts SET metadata=\'{}\'::jsonb WHERE id=$1', [result.checkoutAttemptId]), { code: '23514' });
    });

    await t.test('paid orders can be cut and reopened with revision history', async () => {
      const { orderId } = await seed();
      const cut = await setOrderCut(pool, { orderId, isCut: true, expectedRevision: 1, actor: 'staff:owner' });
      assert.equal(cut.is_cut, true);
      assert.equal(cut.revision, 2);
      assert.equal(cut.cut_by, 'staff:owner');
      assert.ok(cut.cut_at);
      const reopened = await setOrderCut(pool, { orderId, isCut: false, expectedRevision: 2, actor: 'staff:owner', reason: 'Incorrect completion recorded' });
      assert.equal(reopened.is_cut, false);
      assert.equal(reopened.cut_at, null);
      assert.equal(reopened.cut_by, null);
      assert.equal(reopened.revision, 3);
      const audit = (await pool.query('SELECT event, metadata FROM audit_log WHERE order_id=$1 ORDER BY id', [orderId])).rows;
      assert.deepEqual(audit.map(row => row.event), ['order_cut', 'order_reopened']);
      assert.equal(audit[1].metadata.previousCutBy, 'staff:owner');
      assert.equal(audit[1].metadata.reason, 'Incorrect completion recorded');
      await assert.rejects(pool.query('DELETE FROM audit_log WHERE order_id=$1', [orderId]), { code: '23514' });
      assert.ok((await listOrders(pool)).some(order => order.id === orderId));
    });

    await t.test('unpaid, refunded, cancelled and held orders cannot be released as cut', async () => {
      for (const state of [{ paymentStatus: 'pending' }, { paymentStatus: 'authorized' }, { refund: true }, { cancelled: true }, { hold: 'Order changed' }]) {
        const { orderId } = await seed(state);
        await assert.rejects(setOrderCut(pool, { orderId, isCut: true, expectedRevision: 1, actor: 'staff:owner' }), { code: 'production_hold' });
        assert.equal((await pool.query('SELECT revision FROM orders WHERE id=$1', [orderId])).rows[0].revision, 1);
      }
    });

    await t.test('concurrent stale revisions cannot overwrite the winner', async () => {
      const { orderId } = await seed();
      const updates = await Promise.allSettled(['staff:a', 'staff:b'].map(actor => setOrderCut(pool, { orderId, isCut: true, expectedRevision: 1, actor })));
      assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(updates.find(result => result.status === 'rejected').reason.code, 'stale_revision');
      assert.equal((await pool.query('SELECT count(*) FROM audit_log WHERE order_id=$1', [orderId])).rows[0].count, '1');
    });

    await t.test('failed audit insertion rolls the cut state back atomically', async () => {
      await pool.query(`CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.actor = 'staff:reject-test' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_audit();`);
      const { orderId } = await seed();
      await assert.rejects(setOrderCut(pool, { orderId, isCut: true, expectedRevision: 1, actor: 'staff:reject-test' }), /test audit failure/);
      const row = (await pool.query('SELECT is_cut,revision FROM orders WHERE id=$1', [orderId])).rows[0];
      assert.deepEqual(row, { is_cut: false, revision: 1 });
    });

    await t.test('duplicate Shopify delivery IDs cannot enqueue duplicate work', async () => {
      const webhookId = randomUUID();
      const sql = `INSERT INTO webhook_deliveries (shop,webhook_id,topic,raw_body_hash,payload)
        VALUES ('nice-test.myshopify.com',$1,'orders/paid',$2,'{}'::jsonb)`;
      await pool.query(sql, [webhookId, 'b'.repeat(64)]);
      await assert.rejects(pool.query(sql, [webhookId, 'b'.repeat(64)]), { code: '23505' });
    });

    await t.test('transaction failures rollback every write', async () => {
      const { orderId } = await seed();
      await assert.rejects(transaction(pool, async client => {
        await client.query('UPDATE orders SET hold_reason=\'test hold\' WHERE id=$1', [orderId]);
        throw new Error('deliberate failure');
      }), /deliberate failure/);
      assert.equal((await pool.query('SELECT hold_reason FROM orders WHERE id=$1', [orderId])).rows[0].hold_reason, null);
    });
  } finally {
    if (pool) await pool.end();
    // Only the unique schema created above is removed; no existing schema is touched.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
