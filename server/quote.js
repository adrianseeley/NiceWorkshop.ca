'use strict';

const { createHash } = require('node:crypto');
const pricing = require('../app.js');
const defaultCatalogue = require('../materials.json');

class QuoteValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuoteValidationError';
    this.code = 'INVALID_QUOTE';
    this.statusCode = 400;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function allowedKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new QuoteValidationError(`${label} contains unsupported fields.`);
  }
}

// A stable catalogue fingerprint makes a stored quote reproducible even if JSON
// object keys are reordered. Each quote also retains its own detached snapshot.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Input: { cuts: [{sheetId, shape, widthUnits, heightUnits, quantity}], fulfillment }.
 * Dimensions are integer ten-thousandths of a millimetre, including legacy sizes.
 * All prices come from the server-owned catalogue; prices in input are rejected.
 * The result prices the cuts only. Delivery remains unpriced until its policy is
 * explicitly configured. Shopify is authoritative for final checkout taxes.
 */
function buildQuote(input, catalogue = defaultCatalogue) {
  allowedKeys(input, ['cuts', 'fulfillment'], 'Order');
  if (!['pickup', 'delivery'].includes(input.fulfillment)) {
    throw new QuoteValidationError('Choose shop pickup or local delivery.');
  }
  if (!Array.isArray(input.cuts) || input.cuts.length < 1 || input.cuts.length > 100) {
    throw new QuoteValidationError('An order must contain between 1 and 100 cut groups.');
  }

  // Invalid server configuration is a server error, never a customer validation error.
  pricing.validateConfig(catalogue);
  const catalogueSnapshot = JSON.parse(JSON.stringify(catalogue));
  pricing.validateConfig(catalogueSnapshot);
  const groups = new Map();
  for (const cut of input.cuts) {
    allowedKeys(cut, ['sheetId', 'shape', 'widthUnits', 'heightUnits', 'quantity'], 'Cut');
    if (typeof cut.sheetId !== 'string' || !Number.isSafeInteger(cut.quantity)
      || !pricing.validItem(catalogueSnapshot, cut)) {
      throw new QuoteValidationError('Choose a valid material, shape, size, and quantity for every cut.');
    }
    const key = JSON.stringify([cut.sheetId, cut.shape, cut.widthUnits, cut.heightUnits]);
    const previous = groups.get(key);
    const quantity = (previous?.quantity || 0) + cut.quantity;
    if (quantity > 999) throw new QuoteValidationError('A matching cut group cannot exceed 999 pieces.');
    groups.set(key, {
      sheetId: cut.sheetId, shape: cut.shape, widthUnits: cut.widthUnits,
      heightUnits: cut.heightUnits, quantity,
    });
  }
  const cuts = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, cut]) => cut);
  const totals = pricing.cartTotals(catalogueSnapshot, cuts);
  if (![totals.subtotalCents, totals.taxCents, totals.totalCents].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Configured prices exceed supported monetary limits.');
  }
  return {
    cuts,
    subtotalCents: totals.subtotalCents,
    estimatedTaxCents: totals.taxCents,
    estimatedTotalCents: totals.totalCents,
    currency: 'CAD',
    catalogueHash: createHash('sha256').update(canonicalJson(catalogueSnapshot)).digest('hex'),
    catalogueSnapshot,
    leadTimeDays: 14,
    fulfillment: input.fulfillment,
    includesDelivery: false,
    deliveryPriceStatus: input.fulfillment === 'delivery' ? 'unconfirmed' : 'not_applicable',
  };
}

module.exports = { buildQuote, QuoteValidationError };
