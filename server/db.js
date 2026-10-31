'use strict';

const { readFile, readdir } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

class StoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function poolOptions(env = process.env) {
  if (!env.DATABASE_URL) throw new StoreError('database_unconfigured', 'DATABASE_URL is required.', 503);
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new StoreError('database_config', 'DATABASE_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new StoreError('database_config', 'DATABASE_URL must be a PostgreSQL URL.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const mode = env.DATABASE_SSL || 'verify-full';
  if (!['verify-full', 'disable'].includes(mode) || (mode === 'disable' && !local)) {
    throw new StoreError('database_config', 'Verified TLS is required for remote PostgreSQL connections.');
  }
  // pg connection-string SSL options override its ssl object. Remove them so
  // the explicit verification policy below cannot be silently weakened.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  const max = Number(env.DATABASE_POOL_MAX || 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new StoreError('database_config', 'DATABASE_POOL_MAX must be between 1 and 20.');
  const ssl = mode === 'disable' ? false : {
    rejectUnauthorized: true,
    ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}),
    ...(env.DATABASE_CA_FILE ? { ca: readFileSync(env.DATABASE_CA_FILE, 'utf8') } : {})
  };
  return { connectionString: url.toString(), ssl, max, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 10000, application_name: 'nice-workshop' };
}

function createPool(env = process.env) {
  const { Pool } = require('pg');
  return new Pool(poolOptions(env));
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function migrate(pool, directory = path.join(__dirname, '..', 'db', 'migrations')) {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [183647922]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map(row => [row.name, row.checksum]));
    const completed = [];
    for (const name of names) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new StoreError('migration_changed', `Applied migration ${name} has changed.`, 500);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      completed.push(name);
    }
    return completed;
  });
}

const ORDER_FIELDS = `id, shop, shopify_order_id, checkout_attempt_id, cuts,
  payment_status, cancelled_at, refunded, hold_reason, is_cut, cut_at, cut_by,
  revision, shopify_updated_at, created_at, updated_at`;

async function listOrders(pool, { limit = 50, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw new StoreError('invalid_pagination', 'Use a limit of 1–100 and a nonnegative offset.');
  }
  return (await pool.query(`SELECT ${ORDER_FIELDS} FROM orders ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, [limit, offset])).rows;
}

async function setOrderCut(pool, { orderId, isCut, expectedRevision, actor, reason = '' }) {
  if (typeof orderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)
      || typeof isCut !== 'boolean' || !Number.isInteger(expectedRevision) || expectedRevision < 1
      || typeof actor !== 'string' || !actor.trim() || actor.length > 256
      || typeof reason !== 'string' || reason.length > 2000 || (!isCut && !reason.trim())) {
    throw new StoreError('invalid_cut_update', 'Provide an order, revision, authenticated actor, and a reason when reopening.');
  }
  return transaction(pool, async client => {
    const order = (await client.query(`SELECT ${ORDER_FIELDS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw new StoreError('order_not_found', 'Order not found.', 404);
    if (order.revision !== expectedRevision) throw new StoreError('stale_revision', 'This order changed. Refresh it before continuing.', 409);
    if (isCut && (order.payment_status !== 'paid' || order.refunded || order.cancelled_at || order.hold_reason)) {
      throw new StoreError('production_hold', 'Only fully paid orders without a cancellation, refund, or hold may be marked cut.', 409);
    }
    if (order.is_cut === isCut) return order;
    const updated = (await client.query(`UPDATE orders SET is_cut = $2,
      cut_at = CASE WHEN $2 THEN now() ELSE NULL END,
      cut_by = CASE WHEN $2 THEN $3 ELSE NULL END,
      revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING ${ORDER_FIELDS}`,
    [orderId, isCut, actor.trim()])).rows[0];
    await client.query('INSERT INTO audit_log (order_id, event, actor, metadata) VALUES ($1, $2, $3, $4::jsonb)',
      [orderId, isCut ? 'order_cut' : 'order_reopened', actor.trim(), JSON.stringify({
        fromRevision: order.revision, toRevision: updated.revision, fromIsCut: order.is_cut,
        toIsCut: isCut, previousCutAt: order.cut_at, previousCutBy: order.cut_by, reason: reason.trim()
      })]);
    return updated;
  });
}

module.exports = { StoreError, poolOptions, createPool, transaction, migrate, listOrders, setOrderCut };
