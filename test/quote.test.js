'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalogue = require('../materials.json');
const { buildQuote, QuoteValidationError } = require('../server/quote');
const cut = (width, height, extra = {}) => ({ sheetId: 'birch-12-7', shape: 'rectangle',
  widthUnits: Math.round(width * 10000), heightUnits: Math.round(height * 10000), quantity: 1, ...extra });
const input = cuts => ({ cuts, fulfillment: 'pickup' });

test('server quote preserves documented group and cart rounding, including legacy dimensions', () => {
  const three = buildQuote(input([cut(304.8, 609.6, { quantity: 3 })]));
  assert.equal(three.subtotalCents, 5080);
  assert.equal(three.estimatedTaxCents, 660);
  assert.equal(three.estimatedTotalCents, 5740);
  assert.equal(three.cuts[0].widthUnits, 3048000);
  const circle = buildQuote(input([cut(127, 127, { shape: 'circle', sheetId: 'birch-25' })]));
  assert.equal(circle.estimatedTotalCents, 392);
  const orientations = buildQuote(input([cut(127, 25.4, { sheetId: 'birch-5-2' }), cut(25.4, 127, { sheetId: 'birch-5-2' })]));
  assert.equal(orientations.cuts.length, 2);
  assert.equal(orientations.subtotalCents, 238);
  assert.equal(orientations.estimatedTaxCents, 31);
});

test('duplicate groups merge before rounding with a shared quantity bound', () => {
  const a = cut(304.8, 609.6);
  const grouped = buildQuote(input([a, { ...a, quantity: 2 }]));
  assert.deepEqual(grouped, buildQuote(input([{ ...a, quantity: 3 }])));
  assert.equal(grouped.cuts.length, 1);
  assert.equal(grouped.estimatedTotalCents, 5740); // Three individually rounded pieces would cost 5739.
  assert.equal(a.quantity, 1);
  assert.throws(() => buildQuote(input([{ ...a, quantity: 999 }, a])), QuoteValidationError);
  assert.equal(buildQuote(input([{ ...a, quantity: 999 }])).cuts[0].quantity, 999);
});

test('canonical cuts and catalogue fingerprints do not depend on object or input ordering', () => {
  const a = cut(100, 25), b = cut(25, 100);
  assert.deepEqual(buildQuote(input([a, b])), buildQuote(input([b, a])));
  const reordered = Object.fromEntries(Object.entries(catalogue).reverse());
  assert.equal(buildQuote(input([a])).catalogueHash, buildQuote(input([a]), reordered).catalogueHash);
  const changed = structuredClone(catalogue);
  changed.base_price_per_piece_cents++;
  assert.notEqual(buildQuote(input([a])).catalogueHash, buildQuote(input([a]), changed).catalogueHash);
  const result = buildQuote(input([a]), changed);
  changed.base_price_per_piece_cents++;
  assert.notEqual(result.catalogueSnapshot.base_price_per_piece_cents, changed.base_price_per_piece_cents);
});

test('client price tampering and unsupported fields fail instead of influencing the quote', () => {
  for (const field of ['price', 'subtotalCents', 'taxCents', 'catalogueSnapshot', 'currency', '__proto__']) {
    const request = input([cut(100, 100)]);
    Object.defineProperty(request, field, { value: 1, enumerable: true });
    assert.throws(() => buildQuote(request), QuoteValidationError);
    const piece = cut(100, 100);
    Object.defineProperty(piece, field, { value: 1, enumerable: true });
    assert.throws(() => buildQuote(input([piece])), QuoteValidationError);
  }
});

test('invalid cuts, dimensions, shapes, quantity, grain orientation, and oversized requests fail', () => {
  const invalid = [null, [], {}, cut(99, 99), cut(24, 100), cut(1201, 100), cut(2400, 1200),
    cut(100, 2401), cut(100, 99, { shape: 'circle' }), cut(99, 99, { shape: 'circle' }),
    cut(1201, 1201, { shape: 'circle' }), cut(100, 100, { shape: 'triangle' }),
    cut(100, 100, { sheetId: 'untrusted' }), cut(100, 100, { quantity: 0 }),
    cut(100, 100, { quantity: 1000 }), cut(100, 100, { quantity: 1.5 }),
    cut(100, 100, { quantity: '1' }), cut(100, 100, { widthUnits: Infinity }),
    cut(100, 100, { widthUnits: Number.MAX_SAFE_INTEGER + 1 }), cut(100, 100, { widthUnits: 1000000.5 })];
  for (const piece of invalid) assert.throws(() => buildQuote(input([piece])), QuoteValidationError);
  for (const request of [null, [], {}, input([]), input(Array(101).fill(cut(100, 100))),
    { ...input([cut(100, 100)]), fulfillment: 'shipping' }]) {
    assert.throws(() => buildQuote(request), QuoteValidationError);
  }
  assert.equal(buildQuote(input([cut(1200, 2400)])).cuts.length, 1);
  assert.equal(buildQuote(input([cut(1200, 1200, { shape: 'circle' })])).cuts.length, 1);
});

test('delivery is explicitly unpriced and cannot silently receive free delivery', () => {
  const quote = buildQuote({ cuts: [cut(100, 100)], fulfillment: 'delivery' });
  assert.equal(quote.includesDelivery, false);
  assert.equal(quote.deliveryPriceStatus, 'unconfirmed');
  assert.equal(quote.fulfillment, 'delivery');
  assert.equal(quote.leadTimeDays, 14);
  assert.equal(quote.currency, 'CAD');
});
