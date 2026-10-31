'use strict';

const { buildQuote, QuoteValidationError } = require('./quote');
const { quote: priceCut, dimensionLabel } = require('../app.js');

// The owner requested approximately $5 including Ontario HST. With a two-decimal
// pre-tax rate, $4.42 produces approximately $4.99; Shopify calculates final tax.
const DELIVERY_PRICE_CENTS = 442;
const DELIVERY_CITIES = ['Arnprior', 'Braeside', 'McNab', 'Renfrew'];

/** Eligibility/format validation only. This does not geocode or prove an address. */
function validateDeliveryAddress(address) {
  const allowed = ['address1', 'address2', 'city', 'provinceCode', 'countryCode', 'zip'];
  if (!address || typeof address !== 'object' || Array.isArray(address)
    || Object.keys(address).some(key => !allowed.includes(key))) {
    throw new QuoteValidationError('Enter a local delivery address.');
  }
  const clean = value => typeof value === 'string' && value.length <= 150 && !/[\r\n\x00-\x1f\x7f]/.test(value)
    ? value.trim().replace(/\s+/g, ' ') : '';
  const address1 = clean(address.address1);
  const cityInput = clean(address.city).toLowerCase();
  const city = DELIVERY_CITIES.find(name => name.toLowerCase() === cityInput);
  const provinceCode = clean(address.provinceCode).toUpperCase();
  const countryCode = clean(address.countryCode).toUpperCase();
  const postal = clean(address.zip).toUpperCase().replace(/ /g, '');
  if (!address1 || !/[0-9]/.test(address1) || !/[A-Za-z]/.test(address1)
    || !city || provinceCode !== 'ON' || countryCode !== 'CA'
    || !/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(postal)) {
    throw new QuoteValidationError('Local delivery requires a street address and postal code in Arnprior, Braeside, McNab, or Renfrew, Ontario, Canada.');
  }
  const result = { address1, city, provinceCode, countryCode, zip: `${postal.slice(0, 3)} ${postal.slice(3)}` };
  if (address.address2 !== undefined) {
    if (typeof address.address2 !== 'string' || address.address2.length > 150 || /[\r\n\x00-\x1f\x7f]/.test(address.address2)) {
      throw new QuoteValidationError('The delivery address second line is invalid.');
    }
    result.address2 = clean(address.address2);
  }
  return result;
}

class ShopifyError extends Error {
  constructor(code, message, { ambiguous = false, statusCode = 502 } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.code = code;
    this.statusCode = statusCode;
    this.ambiguous = ambiguous;
  }
}

function configurationError(message) {
  return new ShopifyError('SHOPIFY_CONFIGURATION_REQUIRED', message, { statusCode: 503 });
}

function validateShopDomain(domain) {
  if (typeof domain !== 'string' || domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(domain)) {
    throw configurationError('Configure the exact Shopify myshopify.com store domain.');
  }
  return domain;
}

function validateApiVersion(version) {
  if (typeof version !== 'string' || !/^20\d{2}-(?:01|04|07|10)$/.test(version)) {
    throw configurationError('Configure a dated Shopify API version.');
  }
  return version;
}

// Schema inspected and this read validated against Admin API 2026-10.
// https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order
const ORDER_NOTIFICATION_RECIPIENT = `query NiceWorkshopNotificationRecipient($id: ID!) {
  order(id: $id) {
    id name email test cancelledAt displayFinancialStatus updatedAt
    customAttributes { key value }
    refunds(first: 1) { id }
  }
}`;

/** Resolve only the contact for this exact verified order; never a staff-supplied address. */
async function getOrderNotificationRecipient(client, order) {
  if (!client || typeof client.request !== 'function' || validateShopDomain(client.shopDomain) !== order.shop
    || typeof order.shopify_order_id !== 'string' || !/^[1-9]\d{0,29}$/.test(order.shopify_order_id)) {
    throw configurationError('The order notification connection is not configured.');
  }
  const id = `gid://shopify/Order/${order.shopify_order_id}`;
  const data = await client.request(ORDER_NOTIFICATION_RECIPIENT, {id});
  const remote = data?.order;
  const reference = remote?.customAttributes?.filter(item => item?.key === 'nice_workshop_reference');
  const timestamp = Date.parse(remote?.updatedAt);
  if (remote?.id !== id || remote.test !== false || remote.cancelledAt !== null
    || remote.displayFinancialStatus !== 'PAID' || !Array.isArray(remote.refunds) || remote.refunds.length
    || !Number.isFinite(timestamp) || !order.shopify_updated_at || timestamp !== new Date(order.shopify_updated_at).getTime()
    || reference?.length !== 1 || reference[0].value !== order.checkout_attempt_id) {
    throw new ShopifyError('SHOPIFY_ORDER_NOT_READY', 'Shopify order details need review or are still updating. Refresh before marking ready.', {statusCode:409});
  }
  const recipient = typeof remote.email === 'string' ? remote.email.trim() : '';
  if (recipient.length > 254 || recipient.includes('..') || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(recipient)
    || typeof remote.name !== 'string' || !remote.name.trim() || remote.name.length > 100 || /[\r\n\x00-\x1f\x7f]/.test(remote.name)) {
    throw new ShopifyError('SHOPIFY_ORDER_CONTACT_REQUIRED', 'The order needs a valid customer email address in Shopify before it can be marked ready.', {statusCode:409});
  }
  return {recipient,orderName:remote.name,updatedAt:remote.updatedAt};
}

/**
 * Server-only GraphQL client for a store and app in the same Shopify organization.
 * It obtains short-lived tokens lazily and coalesces simultaneous token refreshes.
 * request(query, variables) returns response.data. It never retries a mutation:
 * an ambiguous error must be reconciled before a caller creates another draft.
 * All failures use fixed messages; upstream bodies and credentials are not logged.
 */
function createShopifyClient({ shopDomain, clientId, clientSecret, apiVersion = '2026-10',
  fetchImpl = globalThis.fetch, now = Date.now, requestTimeoutMs = 15000 } = {}) {
  validateShopDomain(shopDomain);
  validateApiVersion(apiVersion);
  if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) {
    throw configurationError('Configure Shopify server credentials and request settings.');
  }
  const origin = `https://${shopDomain}`;
  let token = null;
  let refreshAt = 0;
  let refreshing = null;

  async function send(url, options, mutation = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        if (response.status === 401) { token = null; refreshAt = 0; }
        const code = response.status === 401 ? 'SHOPIFY_UNAUTHORIZED'
          : response.status === 429 ? 'SHOPIFY_RATE_LIMITED' : 'SHOPIFY_HTTP_ERROR';
        throw new ShopifyError(code, 'Shopify could not complete the request.', {
          ambiguous: mutation && response.status >= 500,
        });
      }
      try { return await response.json(); }
      catch { throw new ShopifyError('SHOPIFY_INVALID_RESPONSE', 'Shopify returned an unreadable response.', { ambiguous: mutation }); }
    } catch (error) {
      if (error instanceof ShopifyError) throw error;
      throw new ShopifyError(controller.signal.aborted ? 'SHOPIFY_TIMEOUT' : 'SHOPIFY_NETWORK_ERROR',
        'Shopify could not be reached. Check the request outcome before trying again.', { ambiguous: mutation });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getAccessToken() {
    if (token && now() < refreshAt) return token;
    if (!refreshing) {
      refreshing = (async () => {
        const result = await send(`${origin}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
        });
        if (typeof result?.access_token !== 'string' || !result.access_token
          || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0
          || !Number.isSafeInteger(result.expires_in * 1000)) {
          throw new ShopifyError('SHOPIFY_INVALID_TOKEN_RESPONSE', 'Shopify did not return a usable access token.');
        }
        token = result.access_token;
        const lifetimeMs = result.expires_in * 1000;
        refreshAt = now() + lifetimeMs - Math.min(60000, Math.floor(lifetimeMs / 10));
        return token;
      })();
    }
    try { return await refreshing; }
    finally { refreshing = null; }
  }

  async function request(query, variables = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 100000
      || variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
      throw configurationError('Provide a GraphQL operation and variables object.');
    }
    let body;
    try { body = JSON.stringify({ query, variables }); }
    catch { throw configurationError('GraphQL variables must be JSON serializable.'); }
    const accessToken = await getAccessToken();
    const mutation = /^mutation\b/.test(query.replace(/#[^\n]*/g, '').trimStart());
    const result = await send(`${origin}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': accessToken }, body,
    }, mutation);
    if (!result || typeof result !== 'object' || (Array.isArray(result.errors) && result.errors.length)
      || !result.data || typeof result.data !== 'object') {
      throw new ShopifyError('SHOPIFY_GRAPHQL_ERROR', 'Shopify could not complete the operation.', { ambiguous: mutation });
    }
    return result.data;
  }

  return { request, getAccessToken, shopDomain, apiVersion, invalidateToken() { token = null; refreshAt = 0; } };
}

function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw configurationError('A configured price is invalid.');
  return { amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, currencyCode: 'CAD' };
}

function shippingAddress(address) {
  if (!address || typeof address !== 'object'
    || !['address1', 'city', 'zip'].every(key => typeof address[key] === 'string' && address[key].trim() && address[key].length <= 150)
    || address.provinceCode !== 'ON' || address.countryCode !== 'CA') {
    throw configurationError('Configure and verify the Ontario fulfillment address.');
  }
  const output = { address1: address.address1.trim(), city: address.city.trim(), zip: address.zip.trim(), provinceCode: 'ON', countryCode: 'CA' };
  if (address.address2 !== undefined) {
    if (typeof address.address2 !== 'string' || address.address2.length > 150) throw configurationError('The fulfillment address is invalid.');
    output.address2 = address.address2.trim();
  }
  return output;
}

/**
 * Pure draft-input builder. Does not create/send an invoice or collect payment.
 * options are trusted SERVER configuration, never the customer's request body:
 * {reference, taxPolicy:'shopify_authoritative', fulfillmentConfig:{
 *   pickup:{approved:true,title:'Shop Pickup',priceCents:0,address:{...}},
 *   delivery:{approved:true,title:'Local Delivery',priceCents:442,
 *     taxTreatment:'exclusive',serviceAreaConfirmed:true,address:{...}}
 * }}
 * Pickup's address is the agreed collection destination. Delivery requires an
 * independently checked service area/address and an explicitly before-tax fee.
 * Without options.nativePickup this preserves the original custom rate format.
 * Native pickup requires a fresh, verified location/rate from Shopify; it omits
 * shippingAddress so the buyer enters their own billing address at checkout.
 */
function buildDraftOrderInput(quote, options = {}) {
  if (options.taxPolicy !== 'shopify_authoritative') {
    throw configurationError('Confirm Shopify as the authority for final checkout tax.');
  }
  if (typeof options.reference !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.reference)) {
    throw configurationError('Provide a stable internal checkout reference.');
  }
  if (!quote?.catalogueSnapshot) throw configurationError('Provide a server-generated quote with its catalogue snapshot.');
  const verified = buildQuote({ cuts: quote.cuts, fulfillment: quote.fulfillment }, quote.catalogueSnapshot);
  if (quote.catalogueHash !== verified.catalogueHash || quote.subtotalCents !== verified.subtotalCents || quote.currency !== 'CAD') {
    throw configurationError('The stored quote no longer matches its pricing snapshot.');
  }
  const fulfillment = options.fulfillmentConfig?.[verified.fulfillment];
  if (!fulfillment || fulfillment.approved !== true || typeof fulfillment.title !== 'string'
    || !fulfillment.title.trim() || fulfillment.title.length > 150) {
    throw configurationError('Confirm fulfillment terms before creating checkout.');
  }
  if (verified.fulfillment === 'pickup' && fulfillment.priceCents !== 0) {
    throw configurationError('Shop pickup must have an explicitly configured zero delivery charge.');
  }
  if (verified.fulfillment === 'delivery'
    && (fulfillment.serviceAreaConfirmed !== true || fulfillment.taxTreatment !== 'exclusive')) {
    throw configurationError('Confirm delivery eligibility and the before-tax delivery fee before checkout.');
  }
  const address = verified.fulfillment === 'delivery'
    ? validateDeliveryAddress(fulfillment.address) : shippingAddress(fulfillment.address);
  const shippingPrice = money(fulfillment.priceCents);
  const nativePickup = options.nativePickup;
  if (nativePickup && (verified.fulfillment !== 'pickup'
    || nativePickup.locationId !== fulfillment.nativePickupLocationId
    || !/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(nativePickup.locationId)
    || typeof nativePickup.handle !== 'string' || !nativePickup.handle || nativePickup.handle.length > 2048)) {
    throw configurationError('Verify the native pickup location before checkout.');
  }
  return {
    presentmentCurrencyCode: 'CAD',
    acceptAutomaticDiscounts: false,
    allowDiscountCodesInCheckout: false,
    taxExempt: false,
    tags: ['nice-workshop', `nw-${options.reference}`],
    note: `Nice Workshop checkout ${options.reference}. Requested fulfillment: ${verified.fulfillment}. Cut quantities are shown in each custom line; Shopify quantity 1 means one configured group.`,
    customAttributes: [
      { key: 'nice_workshop_reference', value: options.reference },
      { key: 'nice_workshop_catalogue_hash', value: verified.catalogueHash },
      { key: 'nice_workshop_fulfillment', value: verified.fulfillment },
    ],
    ...(nativePickup ? {} : {shippingAddress: address}),
    shippingLine: nativePickup ? {shippingRateHandle:nativePickup.handle} : { title: fulfillment.title.trim(), priceWithCurrency: shippingPrice },
    lineItems: verified.cuts.map((cut, index) => {
      const sheet = verified.catalogueSnapshot.sheets.find(item => item.id === cut.sheetId);
      const groupPrice = priceCut(verified.catalogueSnapshot, cut).subtotalCents;
      const thickness = sheet.display_thickness?.mm ?? sheet.nominal_thickness.mm;
      const size = cut.shape === 'circle' ? `Diameter ${dimensionLabel(cut.widthUnits)}`
        : `${dimensionLabel(cut.widthUnits)} across grain × ${dimensionLabel(cut.heightUnits)} along grain`;
      return {
        title: `Sanded Birch Plywood (Unfinished) — ${cut.shape === 'circle' ? 'Circle' : 'Rectangle'} — ${cut.quantity} ${cut.quantity === 1 ? 'piece' : 'pieces'}`,
        quantity: 1,
        originalUnitPriceWithCurrency: money(groupPrice),
        requiresShipping: true,
        taxable: true,
        customAttributes: [
          { key: 'Cut group', value: String(index + 1) },
          { key: 'Material', value: `${thickness} mm nominal birch (${cut.sheetId})` },
          { key: 'Size', value: size },
          { key: 'Piece quantity', value: String(cut.quantity) },
          { key: '_nice_workshop_cut', value: JSON.stringify(cut) },
        ],
      };
    }),
  };
}

module.exports = { createShopifyClient, buildDraftOrderInput, validateShopDomain, validateApiVersion,
  validateDeliveryAddress, DELIVERY_PRICE_CENTS, ShopifyError, getOrderNotificationRecipient, ORDER_NOTIFICATION_RECIPIENT };
