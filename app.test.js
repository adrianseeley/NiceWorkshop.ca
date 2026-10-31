'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('./materials.json');
const { validateConfig, validItem, quote, cartTotals, displayRateCents,
  dimensionLabel, nominalInches, restoreItems, changeCartQuantity, PER_MM } = require('./app.js');
const piece = (width, height, extra = {}) => ({ sheetId: 'birch-12-7', shape: 'rectangle',
  widthUnits: Math.round(width * PER_MM), heightUnits: Math.round(height * PER_MM), quantity: 1, ...extra });

test('metric minimums apply in either grain orientation and to circle diameters', () => {
  validateConfig(config);
  for (const [width, height] of [[100, 25], [25, 100], [100, 100]]) {
    assert.equal(validItem(config, piece(width, height)), true);
  }
  for (const [width, height] of [[99, 99], [100, 24], [24, 100], [99, 25]]) {
    assert.equal(validItem(config, piece(width, height)), false);
  }
  assert.equal(validItem(config, piece(100, 100, { shape: 'circle' })), true);
  assert.equal(validItem(config, piece(99, 99, { shape: 'circle' })), false);
  assert.equal(validItem(config, piece(1200, 2400)), true);
  assert.equal(validItem(config, piece(1201, 100)), false);
  assert.equal(validItem(config, piece(100, 2401)), false);
  assert.equal(validItem(config, piece(2400, 1200)), false);
  assert.equal(validItem(config, piece(1200, 1200, { shape: 'circle' })), true);
  assert.equal(validItem(config, piece(1201, 1201, { shape: 'circle' })), false);
  assert.equal(validItem(config, piece(1200.0001, 100)), false);
  assert.equal(validItem(config, piece(100, 2400.0001)), false);
  assert.equal(restoreItems(config, [piece(1219, 100), piece(100, 2438)]).length, 0);

});

test('inch references round to sixteenths, including whole-inch carry', () => {
  assert.equal(dimensionLabel(44 * PER_MM), '44 mm (1 and 3/4 inches)');
  assert.equal(dimensionLabel(5.2 * PER_MM), '5.2 mm (0 and 3/16 inches)');
  assert.equal(dimensionLabel(100 * PER_MM), '100 mm (3 and 15/16 inches)');
  assert.equal(nominalInches(25 * PER_MM), '1 inch');
  assert.equal(nominalInches(50 * PER_MM), '1 and 15/16 inches');
  assert.equal(nominalInches(51 * PER_MM), '2 inches');
  assert.equal(dimensionLabel(304.8 * PER_MM), '304.8 mm (12 inches)');
});

test('legacy mixed-unit carts keep exact dimensions and unchanged prices', () => {
  const legacy = [piece(304.8, 609.6, { unit: 'in' }),
    piece(772, 38, { sheetId: 'birch-19-05', unit: 'mm' }),
    piece(123.825, 25.4)];
  const restored = restoreItems(config, legacy);
  assert.equal(restored.length, 3);
  restored.forEach((item, index) => {
    assert.equal(item.widthUnits, legacy[index].widthUnits);
    assert.equal(item.heightUnits, legacy[index].heightUnits);
    assert.equal('unit' in item, false);
  });
  assert.equal(quote(config, restored[0]).totalCents, 1913);
  assert.equal(quote(config, restored[1]).totalCents, 504);
  assert.equal(restoreItems(config, [piece(99, 99), null, ...legacy]).length, 3);
});

test('metric sheet dimensions preserve the documented pricing and rounding', () => {
  assert.deepEqual(config.sheets.map(sheet => displayRateCents(config, sheet)), [5, 7, 9, 12]);
  assert.equal(quote(config, piece(254, 254, { shape: 'circle', sheetId: 'birch-25' })).totalCents, 1231);
  assert.equal(quote(config, piece(127, 127, { shape: 'circle', sheetId: 'birch-25' })).totalCents, 392);
  assert.equal(quote(config, piece(304.8, 609.6, { quantity: 3 })).totalCents, 5740);
  const items = [piece(127, 25.4, { sheetId: 'birch-5-2' }), piece(25.4, 127, { sheetId: 'birch-5-2' })];
  assert.equal(cartTotals(config, items).totalCents, 269);
});

test('cart steppers update one row, remove at zero, and respect the quantity cap', () => {
  const items = [piece(100, 25), piece(100, 100, { quantity: 999 })];
  const increased = changeCartQuantity(items, 0, 1);
  assert.equal(increased[0].quantity, 2);
  assert.equal(items[0].quantity, 1);
  assert.ok(cartTotals(config, increased).totalCents > cartTotals(config, items).totalCents);
  assert.deepEqual(changeCartQuantity(increased, 0, -1), items);
  assert.deepEqual(changeCartQuantity(items, 0, -1), [items[1]]);
  assert.equal(changeCartQuantity(items, 1, 1)[1].quantity, 999);
  assert.equal(changeCartQuantity(items, -1, 1), items);
  assert.equal(changeCartQuantity(items, 0, 0), items);
  assert.deepEqual(changeCartQuantity([items[0]], 0, -1), []);
});
