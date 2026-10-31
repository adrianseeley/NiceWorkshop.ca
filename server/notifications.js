'use strict';

const { randomUUID } = require('node:crypto');
const { transaction, StoreError, readyBlockReason, decorateOrder, publicNotification } = require('./db');
const { getOrderNotificationRecipient, validateShopDomain } = require('./shopify');
const { renderReadyEmail } = require('./email');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_VERSION = 'ready-v1';

async function orderContext(db, id, lock = false) {
  return (await db.query(`SELECT o.*,c.fulfillment,c.metadata,
    EXISTS(SELECT 1 FROM notification_outbox n WHERE n.order_id=o.id AND n.state IN ('sending','needs_review')) AS notification_review_required
    FROM orders o JOIN checkout_attempts c ON c.id=o.checkout_attempt_id WHERE o.id=$1${lock ? ' FOR UPDATE OF o' : ''}`, [id])).rows[0];
}

async function pendingOrderEvent(db, order) {
  return (await db.query(`SELECT 1 FROM webhook_deliveries WHERE shop=$1 AND
    ((topic='refunds/create' AND payload->>'order_id'=$2) OR
     (topic IN ('orders/paid','orders/updated','orders/cancelled') AND payload->>'id'=$2)) AND
    (state='pending' OR (state='needs_reconciliation' AND last_error_code='ORDER_SNAPSHOT_MISMATCH')) LIMIT 1`,
  [order.shop, order.shopify_order_id])).rows.length > 0;
}

async function responseFor(db, order, reused) {
  const notification = (await db.query('SELECT * FROM notification_outbox WHERE order_id=$1 ORDER BY generation DESC LIMIT 1', [order.id])).rows[0];
  const {metadata, ...publicOrder} = order;
  return {order:decorateOrder({...publicOrder,latest_notification:publicNotification(notification)}, {notificationEnabled:true}),
    notification:publicNotification(notification),reused};
}

async function checkNewReadiness(db, order, expectedRevision) {
  if (!order) throw new StoreError('order_not_found', 'Order not found.', 404);
  if (order.ready_at) return false; // A lost response/repeated click cannot enqueue again.
  if (order.revision !== expectedRevision) throw new StoreError('stale_revision', 'This order changed. Refresh it before continuing.', 409);
  const reason = readyBlockReason(order, {includeAlreadyReady:false});
  if (reason) throw new StoreError('ready_ineligible', reason, 409);
  if (!['pickup','delivery'].includes(order.fulfillment) || order.metadata?.shopDomain !== order.shop) {
    throw new StoreError('ready_ineligible', 'Saved pickup or delivery details need review.', 409);
  }
  if (await pendingOrderEvent(db, order)) throw new StoreError('ready_ineligible', 'An order update is waiting to be checked. Refresh before marking ready.', 409);
  return true;
}

/** Explicit owner action only. There is no recipient or body override. */
async function markOrderReady(pool, {orderId,expectedRevision,actor,shopifyClient,mailSender} = {}) {
  if (!UUID.test(orderId || '') || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || typeof actor !== 'string' || !actor.trim() || actor.length > 256) {
    throw new StoreError('invalid_ready_update', 'Provide an order, its current revision, and an authenticated actor.');
  }
  if (!mailSender || typeof mailSender.send !== 'function' || !shopifyClient || typeof shopifyClient.request !== 'function') {
    throw new StoreError('notification_unconfigured', 'Email sending isn’t connected yet.', 503);
  }
  const initial = await transaction(pool, async db => {
    const order = await orderContext(db, orderId, true);
    return await checkNewReadiness(db, order, expectedRevision) ? {order} : {response:await responseFor(db, order, true)};
  });
  if (initial.response) return initial.response;
  // No transaction is held open while reading Shopify. Recheck the revision and
  // eligibility under the lock before committing the readiness/outbox snapshot.
  const contact = await getOrderNotificationRecipient(shopifyClient, initial.order);
  const message = renderReadyEmail({kind:initial.order.fulfillment,orderName:contact.orderName,
    cutList:initial.order.cuts,deliveryAddress:initial.order.fulfillment === 'delivery' ? initial.order.metadata.deliveryAddress : undefined});
  return transaction(pool, async db => {
    const order = await orderContext(db, orderId, true);
    if (!await checkNewReadiness(db, order, expectedRevision)) return responseFor(db, order, true);
    const id = randomUUID();
    const generation = order.ready_generation + 1;
    await db.query(`INSERT INTO notification_outbox
      (id,order_id,generation,kind,recipient,subject,text_body,html_body,message_id,template_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id,orderId,generation,order.fulfillment,contact.recipient,
      message.subject,message.text,message.html,`<nice-ready-${id}@niceworkshop.ca>`,TEMPLATE_VERSION]);
    await db.query(`UPDATE orders SET ready_at=now(),ready_by=$2,ready_generation=$3,revision=revision+1,updated_at=now() WHERE id=$1`,
      [orderId,actor.trim(),generation]);
    await db.query(`INSERT INTO audit_log(order_id,event,actor,metadata) VALUES ($1,'order_ready',$2,$3::jsonb)`,
      [orderId,actor.trim(),JSON.stringify({notificationId:id,generation,kind:order.fulfillment,fromRevision:order.revision})]);
    return responseFor(db, await orderContext(db, orderId), false);
  });
}

async function auditNotification(db, row, event, extra = {}) {
  await db.query(`INSERT INTO audit_log(order_id,event,actor,metadata) VALUES ($1,$2,'notification-worker',$3::jsonb)`,
    [row.order_id,event,JSON.stringify({notificationId:row.id,generation:row.generation,...extra})]);
}

async function finishNotification(pool, row, state, code = null) {
  return transaction(pool, async db => {
    // Lock order before notification, the same order used by readiness/reopening.
    await db.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [row.order_id]);
    const current = (await db.query('SELECT * FROM notification_outbox WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (!current || !['sending','needs_review'].includes(current.state)) return publicNotification(current);
    // A cancellation/reopening during submission remains visibly uncertain even
    // if the SMTP server subsequently confirms acceptance. Never clear that flag.
    const actualState = current.state === 'needs_review' ? 'needs_review' : state;
    const saved = (await db.query(`UPDATE notification_outbox SET state=$2,
      sent_at=CASE WHEN $3 THEN now() ELSE sent_at END,last_error_code=$4 WHERE id=$1 RETURNING *`,
    [row.id,actualState,state === 'sent',current.state === 'needs_review' ? current.last_error_code : code])).rows[0];
    await auditNotification(db, row, state === 'sent' ? 'notification_accepted' : 'notification_stopped', {state:actualState,code});
    return publicNotification(saved);
  });
}

/** No sending row is replayed after a crash. SMTP does not promise idempotency. */
async function markStaleNotificationsForReview(pool, shopDomain) {
  const stale = (await pool.query(`SELECT n.* FROM notification_outbox n JOIN orders o ON o.id=n.order_id
    WHERE o.shop=$1 AND n.state='sending' AND n.sending_at < now()-interval '10 minutes' ORDER BY n.sending_at LIMIT 100`, [shopDomain])).rows;
  for (const row of stale) await finishNotification(pool, row, 'needs_review', 'EMAIL_OUTCOME_UNKNOWN');
  return stale.length;
}

function sendEligible(order, row) {
  // The current sending row itself is not an earlier unresolved notification.
  return order && order.ready_at && order.ready_generation === row.generation
    && !readyBlockReason({...order,notification_review_required:false}, {includeAlreadyReady:false});
}

/** Claim once, commit, and only then contact SMTP. Never automatically resend. */
async function processNotificationBatch(pool, {shopifyClient,mailSender,shopDomain = shopifyClient?.shopDomain,limit = 5} = {}) {
  validateShopDomain(shopDomain);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError('invalid_notification_limit', 'Use a notification batch limit of 1–100.');
  await markStaleNotificationsForReview(pool, shopDomain);
  if (!mailSender || typeof mailSender.send !== 'function' || !shopifyClient || shopifyClient.shopDomain !== shopDomain) return [];
  const candidates = (await pool.query(`SELECT n.id,n.order_id FROM notification_outbox n JOIN orders o ON o.id=n.order_id
    WHERE o.shop=$1 AND n.state='queued' ORDER BY n.queued_at,n.id LIMIT $2`, [shopDomain,limit])).rows;
  const results = [];
  for (const candidate of candidates) {
    const claimed = await transaction(pool, async db => {
      const order = await orderContext(db, candidate.order_id, true);
      const row = (await db.query('SELECT * FROM notification_outbox WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0];
      if (!row || row.state !== 'queued') return null;
      if (!sendEligible(order,row)) {
        await db.query(`UPDATE notification_outbox SET state='cancelled',last_error_code='ORDER_NO_LONGER_READY' WHERE id=$1`, [row.id]);
        await auditNotification(db,row,'notification_stopped',{state:'cancelled',code:'ORDER_NO_LONGER_READY'});
        return null;
      }
      if (await pendingOrderEvent(db, order)) return null;
      const notification = (await db.query(`UPDATE notification_outbox SET state='sending',sending_at=now(),attempts=attempts+1
        WHERE id=$1 RETURNING *`, [row.id])).rows[0];
      await auditNotification(db,row,'notification_sending');
      return {order,notification};
    });
    if (!claimed) continue;
    const {order,notification} = claimed;
    try {
      const contact = await getOrderNotificationRecipient(shopifyClient, order);
      if (contact.recipient !== notification.recipient) throw new Error('contact_changed');
      const confirmed = await transaction(pool, async db => {
        const current = await orderContext(db, order.id, true);
        const row = (await db.query('SELECT * FROM notification_outbox WHERE id=$1 FOR UPDATE', [notification.id])).rows[0];
        return row?.state === 'sending' && sendEligible(current,row)
          && new Date(current.shopify_updated_at).getTime() === Date.parse(contact.updatedAt)
          && !await pendingOrderEvent(db,current);
      });
      if (!confirmed) throw new Error('order_changed');
    } catch {
      results.push(await finishNotification(pool,notification,'failed','NOTIFICATION_PREFLIGHT_FAILED'));
      continue;
    }
    let accepted = false;
    try {
      const result = await mailSender.send({to:notification.recipient,subject:notification.subject,
        text:notification.text_body,html:notification.html_body,messageId:notification.message_id});
      if (!Array.isArray(result?.accepted) || result.accepted.length !== 1 || result.accepted[0] !== notification.recipient) {
        throw new Error('uncertain_acceptance');
      }
      accepted = true;
    } catch (error) {
      const rejected = error?.deliveryOutcome === 'rejected';
      results.push(await finishNotification(pool,notification,rejected ? 'failed' : 'needs_review',
        rejected ? 'EMAIL_REJECTED' : 'EMAIL_OUTCOME_UNKNOWN'));
    }
    // If this transaction fails after SMTP accepts, the sending row stays put.
    // Stale recovery marks it for review; it never submits a duplicate message.
    if (accepted) results.push(await finishNotification(pool,notification,'sent'));
  }
  return results;
}

module.exports = {markOrderReady,processNotificationBatch,markStaleNotificationsForReview};
