'use strict';

const { randomUUID } = require('node:crypto');
const { transaction, invalidateOrderReadiness } = require('./db');
const { buildQuote } = require('./quote');
const { validateShopDomain, ShopifyError } = require('./shopify');
const {METHOD,nativePickupEvidence} = require('./native-pickup');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_TOPICS = new Set(['orders/paid', 'orders/updated', 'orders/cancelled']);
const PAYMENT_STATUSES = new Set(['pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided', 'expired']);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function cents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function attributes(items, key) {
  if (!Array.isArray(items)) return null;
  const matches = items.filter(item => item && (item.name ?? item.key) === key);
  return matches.length === 1 && typeof matches[0].value === 'string' ? matches[0].value : null;
}

function orderIdentifier(payload, topic) {
  const id = topic === 'refunds/create' ? payload?.order_id : payload?.id;
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  return typeof id === 'string' && /^[1-9]\d{0,29}$/.test(id) ? id : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
  return {
    address1: normalize(address.address1), address2: normalize(address.address2),
    city: normalize(address.city), provinceCode: normalize(address.province_code ?? address.provinceCode),
    countryCode: normalize(address.country_code ?? address.countryCode),
    zip: normalize(address.zip).replace(/ /g, '')
  };
}

/** Pure validation against an immutable server-owned checkout snapshot.
 * The signed Shopify order remains authoritative for final tax, never cut sizes.
 * Missing evidence fails closed, including current totals after an order edit.
 */
function validateOrderSnapshot(payload, attempt, { shopDomain, pickupEvidence } = {}) {
  const reasons = new Set();
  const fail = code => reasons.add(code);
  let quote;
  try {
    quote = buildQuote({ cuts: attempt.cuts, fulfillment: attempt.fulfillment }, attempt.catalogue_snapshot);
    if (quote.catalogueHash !== attempt.catalogue_hash || quote.subtotalCents !== Number(attempt.quoted_subtotal_cents)
      || stable(quote.cuts) !== stable(attempt.cuts) || attempt.currency !== 'CAD') fail('snapshot_invalid');
  } catch { fail('snapshot_invalid'); }
  const metadata = attempt?.metadata;
  const draft = metadata?.draftInput;
  const nativePickup = metadata?.fulfillmentMethod === METHOD;
  if (!metadata || metadata.shopDomain !== shopDomain || metadata.taxPolicy !== 'shopify_authoritative'
    || !metadata.termsVersion || metadata.acceptedTermsVersion !== metadata.termsVersion
    || !draft || !Array.isArray(draft.lineItems) || !Number.isSafeInteger(metadata.shippingPriceCents)) {
    fail('checkout_metadata_invalid');
    return { valid: false, reasons: [...reasons] };
  }
  if (metadata.fulfillmentMethod !== undefined && !nativePickup) fail('checkout_metadata_invalid');
  if (nativePickup && (attempt.fulfillment !== 'pickup' || metadata.shippingPriceCents !== 0
    || !/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(metadata.nativePickup?.locationId || '')
    || !['code','source','title'].every(key=>typeof metadata.nativePickup[key]==='string' && metadata.nativePickup[key])
    || !draft.shippingLine?.shippingRateHandle
    || (draft.shippingAddress !== undefined && stable(draft.shippingAddress) !== stable({countryCode:'CA'})))) fail('checkout_metadata_invalid');
  for (const [key, value] of Object.entries({ nice_workshop_reference: attempt.id,
    nice_workshop_catalogue_hash: attempt.catalogue_hash, nice_workshop_fulfillment: attempt.fulfillment,
    nice_workshop_terms_version: metadata.termsVersion })) {
    if (attributes(payload.note_attributes, key) !== value) fail('order_reference_mismatch');
  }
  if (nativePickup && attributes(payload.note_attributes,'nice_workshop_fulfillment_method') !== METHOD) fail('order_reference_mismatch');
  if (payload.currency !== 'CAD' || (payload.presentment_currency !== undefined && payload.presentment_currency !== 'CAD')) fail('currency_mismatch');
  if (payload.tax_exempt !== false || payload.taxes_included !== false) fail('tax_settings_mismatch');
  // Test purchases are recorded and reconciled but never production-eligible.
  if (payload.test === true) fail('test_order');
  if (payload.test !== true && payload.test !== false) fail('test_status_missing');
  if (cents(payload.total_discounts) !== 0 || (payload.current_total_discounts !== undefined && cents(payload.current_total_discounts) !== 0)
    || !Array.isArray(payload.discount_codes) || payload.discount_codes.length
    || !Array.isArray(payload.discount_applications) || payload.discount_applications.length) fail('discount_mismatch');
  if (!Array.isArray(payload.line_items) || payload.line_items.length !== attempt.cuts.length || draft.lineItems.length !== attempt.cuts.length) {
    fail('cut_lines_mismatch');
  } else {
    const expected = new Map(attempt.cuts.map((cut, index) => [stable(cut), draft.lineItems[index]]));
    for (const line of payload.line_items) {
      if (!line || typeof line !== 'object') { fail('cut_lines_mismatch'); continue; }
      let cut;
      try { cut = JSON.parse(attributes(line.properties, '_nice_workshop_cut')); } catch { /* Missing/invalid attributes fail below. */ }
      const key = stable(cut);
      const wanted = expected.get(key);
      if (!wanted) { fail('cut_lines_mismatch'); continue; }
      expected.delete(key);
      if (line.quantity !== 1 || (line.current_quantity !== undefined && line.current_quantity !== 1)
        || line.title !== wanted.title || line.taxable !== true || line.requires_shipping !== true
        || line.product_id != null || line.variant_id != null) fail('cut_lines_mismatch');
      for (const property of wanted.customAttributes) {
        const actual = attributes(line.properties, property.key);
        if (property.key === '_nice_workshop_cut' ? stable(cut) !== stable(JSON.parse(property.value)) : actual !== property.value) fail('cut_lines_mismatch');
      }
      const expectedPrice = quote && require('../app.js').quote(attempt.catalogue_snapshot, cut).subtotalCents;
      if (!Number.isSafeInteger(expectedPrice) || cents(line.price) !== expectedPrice
        || cents(wanted.originalUnitPriceWithCurrency?.amount) !== expectedPrice
        || wanted.originalUnitPriceWithCurrency?.currencyCode !== 'CAD') fail('price_mismatch');
      if (cents(line.total_discount) !== 0 || !Array.isArray(line.discount_allocations) || line.discount_allocations.length) fail('discount_mismatch');
    }
    if (expected.size) fail('cut_lines_mismatch');
  }
  const subtotal = quote?.subtotalCents;
  if (cents(payload.subtotal_price) !== subtotal || cents(payload.total_line_items_price) !== subtotal
    || (payload.current_subtotal_price !== undefined && cents(payload.current_subtotal_price) !== subtotal)) fail('subtotal_mismatch');
  const lines = payload.shipping_lines;
  const expectedShippingTitle = nativePickup ? metadata.nativePickup?.title : draft.shippingLine?.title;
  if (!Array.isArray(lines) || lines.length !== 1 || !lines[0] || lines[0].title !== expectedShippingTitle
    || cents(lines[0].price) !== metadata.shippingPriceCents
    || (lines[0].discounted_price !== undefined && cents(lines[0].discounted_price) !== metadata.shippingPriceCents)
    || (lines[0].discount_allocations !== undefined && (!Array.isArray(lines[0].discount_allocations) || lines[0].discount_allocations.length))) fail('delivery_price_mismatch');
  if (nativePickup) {
    // Native pickup omits shipping_address; the buyer's own billing address is
    // retained by Shopify (and the signed inbox) for a separately confirmed backup.
    // The paid webhook does not contain a pickup category/location ID. Require
    // a read-backed PICK_UP + assigned-location proof; a rate title is insufficient.
    const adverse=adverseFlags(payload,'orders/updated');
    const needsProof=!adverse.cancelled && !adverse.refunded && payload.financial_status==='paid';
    if (lines?.[0]?.code !== metadata.nativePickup?.code || lines?.[0]?.source !== metadata.nativePickup?.source
      || lines?.[0]?.is_removed !== false || payload.shipping_address != null
      || (needsProof && (pickupEvidence?.orderId !== orderIdentifier(payload,'orders/paid') || pickupEvidence?.valid !== true))) fail('native_pickup_mismatch');
  } else if (stable(normalizeAddress(payload.shipping_address)) !== stable(normalizeAddress(metadata.fulfillmentAddress))) fail('fulfillment_address_mismatch');
  const tax = cents(payload.total_tax);
  const total = cents(payload.total_price);
  if (tax === null || total === null || total !== subtotal + metadata.shippingPriceCents + tax
    || (payload.current_total_price !== undefined && cents(payload.current_total_price) !== total)
    || (payload.current_total_tax !== undefined && cents(payload.current_total_tax) !== tax)
    || (payload.total_tip_received !== undefined && cents(payload.total_tip_received) !== 0)) fail('order_total_mismatch');
  if (payload.financial_status === 'paid' && cents(payload.total_outstanding) !== 0) fail('outstanding_balance');
  return { valid: reasons.size === 0, reasons: [...reasons] };
}

function adverseFlags(payload, topic) {
  return {
    refunded: topic === 'refunds/create' || ['refunded', 'partially_refunded'].includes(payload.financial_status)
      || (Array.isArray(payload.refunds) && payload.refunds.length > 0),
    cancelled: topic === 'orders/cancelled' || payload.cancelled_at != null,
  };
}

async function finish(db, event, state, code = null) {
  await db.query(`UPDATE webhook_deliveries SET state=$2, attempts=attempts+1,
    processed_at=CASE WHEN $2 IN ('processed','ignored') THEN now() ELSE NULL END,
    last_error_code=$3 WHERE id=$1`, [event.id, state, code]);
  return { id: event.id, state, code };
}

async function applyEvent(db, event, options) {
  if (['processed', 'ignored', 'failed'].includes(event.state)) return { id: event.id, state: event.state, reused: true };
  const { payload, topic, shop } = event;
  if (!ORDER_TOPICS.has(topic) && topic !== 'refunds/create') return finish(db, event, 'ignored', 'UNSUPPORTED_TOPIC');
  const orderId = orderIdentifier(payload, topic);
  if (!orderId) return finish(db, event, 'needs_reconciliation', 'ORDER_ID_INVALID');
  // Different deliveries for the same order must serialize, including the first
  // payment racing a refund. The inbox row stays locked for this transaction.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${shop}:${orderId}`]);
  let order = (await db.query('SELECT * FROM orders WHERE shop=$1 AND shopify_order_id=$2 FOR UPDATE', [shop, orderId])).rows[0];
  let attempt;
  if (order) attempt = (await db.query('SELECT * FROM checkout_attempts WHERE id=$1', [order.checkout_attempt_id])).rows[0];
  else {
    if (topic === 'refunds/create' || topic === 'orders/cancelled') return finish(db, event, 'needs_reconciliation', 'ORDER_NOT_FOUND');
    const reference = attributes(payload.note_attributes, 'nice_workshop_reference');
    if (!reference || !UUID.test(reference)) return finish(db, event, 'needs_reconciliation', 'CHECKOUT_REFERENCE_INVALID');
    // Serialize attempts too: two remote orders must never share one cut list.
    attempt = (await db.query('SELECT * FROM checkout_attempts WHERE id=$1 FOR UPDATE', [reference])).rows[0];
    if (!attempt || attempt.metadata?.shopDomain !== shop) return finish(db, event, 'needs_reconciliation', 'CHECKOUT_NOT_FOUND');
    const other = (await db.query('SELECT id FROM orders WHERE checkout_attempt_id=$1', [attempt.id])).rows[0];
    if (other) return finish(db, event, 'needs_reconciliation', 'CHECKOUT_ALREADY_LINKED');
    if (payload.financial_status !== 'paid') return finish(db, event, 'needs_reconciliation', 'ORDER_NOT_PAID');
  }
  const incomingTime = topic === 'refunds/create' ? null : timestamp(payload.updated_at);
  const stale = order?.shopify_updated_at && incomingTime && incomingTime.getTime() < new Date(order.shopify_updated_at).getTime();
  const flags = adverseFlags(payload, topic);
  // Include prior persisted adverse deliveries even if they arrived before the
  // order. Do not lock/update their inbox rows here: another worker can own one.
  let historicalCancellation = null;
  const previous = (await db.query(`SELECT topic,payload,received_at FROM webhook_deliveries WHERE shop=$1 AND
    ((topic='refunds/create' AND payload->>'order_id'=$2) OR
     (topic IN ('orders/paid','orders/updated','orders/cancelled') AND payload->>'id'=$2))`, [shop, orderId])).rows;
  for (const row of previous) {
    const earlier = adverseFlags(row.payload, row.topic);
    flags.refunded ||= earlier.refunded;
    flags.cancelled ||= earlier.cancelled;
    if (earlier.cancelled) {
      const when = timestamp(row.payload.cancelled_at) || timestamp(row.payload.updated_at) || row.received_at;
      if (!historicalCancellation || when < historicalCancellation) historicalCancellation = when;
    }
  }
  const reasons = [];
  if (flags.cancelled) reasons.push('cancelled');
  if (flags.refunded) reasons.push('refund_review');
  let status = order?.payment_status || 'unknown';
  let lastTime = order?.shopify_updated_at || null;
  if (topic !== 'refunds/create' && !stale) {
    // Routing can lag the paid webhook. Unavailable proof throws and rolls back
    // inbox processing for retry; it must not invent a permanent production hold.
    // Adverse signed events must apply their hold even during a Shopify outage.
    const pickupEvidence = attempt.metadata?.fulfillmentMethod === METHOD && !flags.cancelled && !flags.refunded && payload.financial_status==='paid'
      ? await nativePickupEvidence(options.shopifyClient,shop,orderId,attempt.metadata.nativePickup) : undefined;
    const validation = validateOrderSnapshot(payload, attempt, {...options,pickupEvidence});
    reasons.push(...validation.reasons);
    if (!incomingTime) reasons.push('event_timestamp_invalid');
    status = PAYMENT_STATUSES.has(payload.financial_status) ? payload.financial_status : 'unknown';
    if (status !== 'paid') reasons.push('payment_not_paid');
    if (incomingTime) lastTime = incomingTime;
  }
  // Holds are monotonic. A later benign update must not undo an investigated
  // refund, cancellation, or changed specification; explicit review is required.
  const hold = order?.hold_reason || reasons[0] || null;
  const cancelledAt = order?.cancelled_at || (flags.cancelled ? historicalCancellation || timestamp(payload.cancelled_at) || incomingTime || event.received_at : null);
  const refunded = Boolean(order?.refunded || flags.refunded);
  if (!order) {
    order = (await db.query(`INSERT INTO orders
      (id,shop,shopify_order_id,checkout_attempt_id,cuts,payment_status,cancelled_at,refunded,hold_reason,shopify_updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING *`,
    [randomUUID(), shop, orderId, attempt.id, JSON.stringify(attempt.cuts), status, cancelledAt, refunded, hold, lastTime])).rows[0];
    await db.query(`INSERT INTO audit_log(order_id,event,actor,metadata) VALUES ($1,'shopify_order_created','shopify:webhook',$2::jsonb)`,
      [order.id, JSON.stringify({ webhookId: event.webhook_id, topic, reasons, paymentStatus: status, holdReason: hold })]);
  } else if (status !== order.payment_status || refunded !== order.refunded || hold !== order.hold_reason
    || String(cancelledAt) !== String(order.cancelled_at) || String(lastTime) !== String(order.shopify_updated_at)) {
    const prior = { paymentStatus: order.payment_status, holdReason: order.hold_reason, revision: order.revision };
    // Deliberately do not write cuts, is_cut, cut_at, or cut_by.
    order = (await db.query(`UPDATE orders SET payment_status=$2,cancelled_at=$3,refunded=$4,
      hold_reason=$5,shopify_updated_at=$6,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
    [order.id, status, cancelledAt, refunded, hold, lastTime])).rows[0];
    await db.query(`INSERT INTO audit_log(order_id,event,actor,metadata) VALUES ($1,'shopify_order_updated','shopify:webhook',$2::jsonb)`,
      [order.id, JSON.stringify({ webhookId: event.webhook_id, topic, reasons, prior, paymentStatus: status, holdReason: hold, revision: order.revision })]);
  }
  const mismatched = reasons.some(code => !['cancelled', 'refund_review', 'payment_not_paid', 'test_order'].includes(code));
  if (order.ready_at && (hold || refunded || cancelledAt || status !== 'paid')) {
    await invalidateOrderReadiness(db, order, 'shopify_order_changed', 'shopify:webhook');
  }
  return { ...await finish(db, event, mismatched ? 'needs_reconciliation' : 'processed', mismatched ? 'ORDER_SNAPSHOT_MISMATCH' : null), orderId: order.id };
}

function processorOptions(options = {}) {
  return { shopDomain: validateShopDomain(options.shopDomain),shopifyClient:options.shopifyClient };
}

/** Process only a persisted inbox ID. Ingress must verify HMAC before inserting. */
async function processWebhook(pool, id, options) {
  const config = processorOptions(options);
  if (!/^[1-9]\d*$/.test(String(id))) throw new Error('A persisted webhook ID is required.');
  return transaction(pool, async db => {
    const event = (await db.query('SELECT * FROM webhook_deliveries WHERE id=$1 AND shop=$2 FOR UPDATE', [id, config.shopDomain])).rows[0];
    return event ? applyEvent(db, event, config) : null;
  });
}

/** Multiple workers may call this safely. Each event commits with its audit log. */
async function processWebhookBatch(pool, options = {}) {
  const config = processorOptions(options);
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Use a webhook batch limit of 1–100.');
  const results = [];
  const deferred=[];
  for (let i = 0; i < limit; i++) {
    let eventId;
    let result;
    try {
      result = await transaction(pool, async db => {
      const event = (await db.query(`SELECT w.* FROM webhook_deliveries w WHERE w.shop=$1 AND NOT(w.id=ANY($2::bigint[])) AND
        (w.state='pending' OR (w.state='needs_reconciliation' AND w.last_error_code='ORDER_NOT_FOUND' AND EXISTS
          (SELECT 1 FROM orders o WHERE o.shop=w.shop AND o.shopify_order_id=CASE WHEN w.topic='refunds/create'
            THEN w.payload->>'order_id' ELSE w.payload->>'id' END)))
        ORDER BY w.attempts,w.received_at,w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`, [config.shopDomain,deferred])).rows[0];
      eventId=event?.id;
      return event ? applyEvent(db, event, config) : null;
      });
    } catch(error) {
      if (!(error instanceof ShopifyError) || !eventId) throw error;
      // Keep transient pickup lookup/routing failures pending, without holding
      // the order or starving later refunds, cancellations or notification work.
      // Attempt ordering provides fairness across ticks; exclusion bounds each
      // event to one attempt per batch even when it is the only pending row.
      deferred.push(eventId);
      await pool.query(`UPDATE webhook_deliveries SET attempts=attempts+1,last_error_code='NATIVE_PICKUP_RETRY'
        WHERE id=$1 AND state='pending'`,[eventId]);
      results.push({id:eventId,state:'pending',code:'NATIVE_PICKUP_RETRY'});
      continue;
    }
    if (!result) break;
    results.push(result);
  }
  return results;
}

module.exports = { cents, orderIdentifier, validateOrderSnapshot, processWebhook, processWebhookBatch };
