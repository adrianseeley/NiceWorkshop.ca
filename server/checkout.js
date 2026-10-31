'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { transaction } = require('./db');
const { buildQuote, QuoteValidationError } = require('./quote');
const { buildDraftOrderInput, validateDeliveryAddress, validateShopDomain } = require('./shopify');

// Fields inspected in Shopify's Admin GraphQL schema on 2026-10-31. The connector
// deferred operation validation to execution; a test-store smoke test is required.
const CREATE_DRAFT = `mutation NiceWorkshopCreateDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id invoiceUrl ready }
    userErrors { field message }
  }
}`;

class CheckoutError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function verifyCheckoutUrl(value, shopDomain) {
  let url;
  try { url = new URL(value); } catch { throw new CheckoutError('CHECKOUT_URL_INVALID', 'Shopify returned an invalid checkout link.', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || ![validateShopDomain(shopDomain), 'checkout.shopify.com'].includes(url.hostname)) {
    throw new CheckoutError('CHECKOUT_URL_INVALID', 'Shopify returned an unexpected checkout link.', 502);
  }
  return url.toString();
}

function readyResponse(row, shopDomain, reused) {
  return { checkoutAttemptId: row.id, checkoutUrl: verifyCheckoutUrl(row.checkout_url, shopDomain), state: 'ready', reused };
}

/**
 * Create at most one Shopify draft for an idempotency key. The caller supplies a
 * database pool, an authenticated client with shopDomain/request, and trusted
 * fulfillmentConfig + current termsVersion. HTTP/auth/rate limiting are upstream.
 * Customer input: {cuts, fulfillment, acceptedTermsVersion, deliveryAddress?}.
 * Returns {checkoutAttemptId, checkoutUrl, state:'ready', reused}.
 * A creating/uncertain attempt is never automatically submitted again. Inspect
 * its immutable metadata.draftInput and Shopify reference to reconcile it.
 */
async function createCheckout(pool, shopifyClient, { input, idempotencyKey, fulfillmentConfig, termsVersion } = {}) {
  const allowed = ['cuts', 'fulfillment', 'acceptedTermsVersion', 'deliveryAddress'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new QuoteValidationError('The checkout request contains unsupported fields.');
  }
  if (typeof termsVersion !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(termsVersion)) {
    throw new CheckoutError('CHECKOUT_CONFIGURATION_REQUIRED', 'Configure the current order terms before checkout.', 503);
  }
  if (input.acceptedTermsVersion !== termsVersion) {
    throw new CheckoutError('TERMS_ACCEPTANCE_REQUIRED', 'Review and accept the current order terms before continuing.', 400);
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(idempotencyKey)) {
    throw new CheckoutError('IDEMPOTENCY_KEY_REQUIRED', 'Provide a unique checkout request key.', 400);
  }
  if (!shopifyClient || typeof shopifyClient.request !== 'function') {
    throw new CheckoutError('CHECKOUT_CONFIGURATION_REQUIRED', 'Shopify checkout is not configured.', 503);
  }
  const shopDomain = validateShopDomain(shopifyClient.shopDomain);
  const quote = buildQuote({ cuts: input.cuts, fulfillment: input.fulfillment });
  let deliveryAddress = null;
  if (quote.fulfillment === 'delivery') deliveryAddress = validateDeliveryAddress(input.deliveryAddress);
  else if (input.deliveryAddress !== undefined) throw new QuoteValidationError('Pickup orders must not include a delivery address.');

  const normalizedRequest = { cuts: quote.cuts, fulfillment: quote.fulfillment,
    acceptedTermsVersion: termsVersion, deliveryAddress };
  const requestHash = createHash('sha256').update(JSON.stringify(normalizedRequest)).digest('hex');
  const proposedId = randomUUID();
  const resolvedFulfillment = { ...fulfillmentConfig };
  if (deliveryAddress) resolvedFulfillment.delivery = { ...fulfillmentConfig?.delivery, address: deliveryAddress };
  const draftInput = buildDraftOrderInput(quote, { reference: proposedId,
    taxPolicy: 'shopify_authoritative', fulfillmentConfig: resolvedFulfillment });
  draftInput.customAttributes.push({ key: 'nice_workshop_terms_version', value: termsVersion });
  const metadata = { shopDomain, termsVersion, acceptedTermsVersion: termsVersion, acceptedAt: new Date().toISOString(),
    deliveryAddress, fulfillmentAddress: draftInput.shippingAddress,
    shippingPriceCents: resolvedFulfillment[quote.fulfillment].priceCents,
    taxPolicy: 'shopify_authoritative', draftInput };

  // Claim and commit BEFORE the external request. If the process crashes at any
  // point after this commit, a retry cannot accidentally create a second draft.
  const claim = await transaction(pool, async db => {
    const inserted = await db.query(`INSERT INTO checkout_attempts
      (id, idempotency_key, request_hash, cuts, catalogue_snapshot, catalogue_hash,
       quoted_subtotal_cents, currency, fulfillment, lead_time_days, state, metadata)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,'creating',$11::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [proposedId, idempotencyKey, requestHash, JSON.stringify(quote.cuts), JSON.stringify(quote.catalogueSnapshot),
      quote.catalogueHash, quote.subtotalCents, quote.currency, quote.fulfillment, quote.leadTimeDays, JSON.stringify(metadata)]);
    if (inserted.rows.length) return { row: inserted.rows[0], created: true };
    const existing = (await db.query('SELECT * FROM checkout_attempts WHERE idempotency_key = $1 FOR UPDATE', [idempotencyKey])).rows[0];
    if (!existing || existing.request_hash !== requestHash || existing.metadata?.shopDomain !== shopDomain) {
      throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This checkout key was already used for different order details.');
    }
    if (existing.state === 'ready') return { row: existing, created: false };
    if (existing.state === 'creating') {
      throw new CheckoutError('CHECKOUT_IN_PROGRESS', 'This checkout is already being prepared. Keep the same request key and try again shortly.');
    }
    throw new CheckoutError(existing.state === 'failed' ? 'CHECKOUT_REJECTED' : 'CHECKOUT_NEEDS_RECONCILIATION',
      'This checkout needs workshop review before another payment link can be created.');
  });
  if (!claim.created) return readyResponse(claim.row, shopDomain, true);

  let draftId = null;
  let failureCode = 'CHECKOUT_OUTCOME_UNKNOWN';
  let failureState = 'needs_reconciliation';
  try {
    const data = await shopifyClient.request(CREATE_DRAFT, { input: draftInput });
    const payload = data?.draftOrderCreate;
    const draft = payload?.draftOrder;
    if (typeof draft?.id === 'string' && /^gid:\/\/shopify\/DraftOrder\/\d+$/.test(draft.id)) draftId = draft.id;
    if (Array.isArray(payload?.userErrors) && payload.userErrors.length && !draftId) {
      failureCode = 'SHOPIFY_DRAFT_REJECTED';
      failureState = 'failed';
      throw new CheckoutError('CHECKOUT_REJECTED', 'Shopify could not accept this checkout. The workshop must review its settings.', 502);
    }
    if (!draftId || draft?.ready !== true || !Array.isArray(payload?.userErrors) || payload.userErrors.length) {
      failureCode = draftId ? 'SHOPIFY_DRAFT_NOT_READY' : 'SHOPIFY_DRAFT_RESPONSE_INVALID';
      throw new CheckoutError('CHECKOUT_NEEDS_RECONCILIATION', 'Shopify has not confirmed a ready checkout. The workshop must review it before another link is created.', 503);
    }
    const checkoutUrl = verifyCheckoutUrl(draft.invoiceUrl, shopDomain);
    const saved = await pool.query(`UPDATE checkout_attempts
      SET state = 'ready', shopify_draft_id = $2, checkout_url = $3, last_error_code = NULL
      WHERE id = $1 AND state = 'creating' RETURNING *`, [claim.row.id, draftId, checkoutUrl]);
    if (saved.rows.length !== 1) throw new CheckoutError('CHECKOUT_NEEDS_RECONCILIATION', 'The checkout outcome needs workshop review.', 503);
    return readyResponse(saved.rows[0], shopDomain, false);
  } catch (error) {
    if (error?.code === 'CHECKOUT_URL_INVALID') failureCode = 'CHECKOUT_URL_INVALID';
    // A database failure here leaves 'creating', which also prevents duplicate
    // creation. Never replace this outcome with an automatic second mutation.
    await pool.query(`UPDATE checkout_attempts SET state = $2,
      shopify_draft_id = COALESCE($3, shopify_draft_id), last_error_code = $4
      WHERE id = $1 AND state = 'creating'`, [claim.row.id, failureState, draftId, failureCode]).catch(() => {});
    if (error instanceof CheckoutError && ['CHECKOUT_REJECTED', 'CHECKOUT_NEEDS_RECONCILIATION'].includes(error.code)) throw error;
    throw new CheckoutError('CHECKOUT_NEEDS_RECONCILIATION', 'The checkout outcome is uncertain. Contact the workshop before starting another checkout.', 503);
  }
}

module.exports = { createCheckout, CheckoutError, verifyCheckoutUrl, CREATE_DRAFT };
