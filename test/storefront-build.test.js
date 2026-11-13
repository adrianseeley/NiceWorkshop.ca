'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStorefront } = require('../scripts/build-storefront');
const { displayRatePerSquareFootCents } = require('../app');
const catalogue = require('../materials.json');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'index.template.html'), 'utf8');

function options(html, field) {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bid="${field}-mm"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(select, `${field} menu exists in the HTML before JavaScript runs`);
  return [...select[1].matchAll(/<option value="(\d+)"( selected)?>([^<]*)<\/option>/g)]
    .map(([, value, selected, label]) => ({ value: Number(value), selected: !!selected, label }));
}

function assertMenu(html, field, min, max, selected) {
  const menu = options(html, field);
  assert.deepEqual(menu.map(option => option.value), Array.from({ length: max - min + 1 }, (_, index) => min + index));
  assert.deepEqual(menu.filter(option => option.selected).map(option => option.value), [selected]);
  assert.ok(menu.every(option => /^\d[\d,]* mm \(.+ inch(?:es)?\)$/.test(option.label)));
  return menu;
}

function cards(html) {
  return [...html.matchAll(/<label class="thickness-option rate-card" data-material="([^"]+)"( hidden)?>([\s\S]*?)<\/label>/g)]
    .map(([, material, hidden, content]) => {
      const input = content.match(/<input type="radio" name="thickness" value="([^"]+)"( checked)?( disabled)?>/);
      assert.ok(input, 'each thickness card has a native radio control');
      assert.equal(!!input[3], !!hidden, 'inactive cards cannot receive keyboard focus');
      return { material, hidden: !!hidden, id: input[1], checked: !!input[2], content };
    });
}

test('checked-in storefront is the complete deterministic build of its template and catalogue', () => {
  const html = buildStorefront(template, catalogue);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), html);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.equal(buildStorefront(template, catalogue), html);
});

test('all three dimension menus have their complete ranges and one default selection at build time', () => {
  const html = buildStorefront(template, catalogue);
  const width = assertMenu(html, 'width', 25, 1200, 100);
  assertMenu(html, 'height', 25, 2400, 100);
  assertMenu(html, 'diameter', 100, 1200, 100);
  assert.equal(width.find(option => option.value === 44).label, '44 mm (1 and 3/4 inches)');
  assert.equal(width.at(-1).label, '1,200 mm (47 and 1/4 inches)');
  assert.match(html, /id="diameter-field" hidden/);
});

test('material and thickness cards include sample photos, rates and default choices before JavaScript runs', () => {
  const html = buildStorefront(template, catalogue);
  for (const material of catalogue.materials) {
    assert.ok(html.includes(`name="material" value="${material.id}"${material.id === 'birch' ? ' checked' : ''}>`));
    assert.ok(html.includes(`src="${material.image}"`));
  }
  const materialCards = cards(html);
  const birch = materialCards.filter(card => !card.hidden);
  assert.deepEqual(birch.map(card => card.id), catalogue.sheets.filter(sheet => sheet.material_id === 'birch').map(sheet => sheet.id));
  assert.deepEqual(materialCards.filter(card => card.checked).map(card => card.id), ['birch-12-7']);
  assert.doesNotMatch(html, /class="material-card-status">Coming soon/);
  for (const material of catalogue.materials) {
    const group = materialCards.filter(card => card.material === material.id);
    const sheets = catalogue.sheets.filter(sheet => sheet.material_id === material.id);
    assert.deepEqual(group.map(card => card.id), sheets.map(sheet => sheet.id));
    group.forEach((card, index) => {
      const sheet = sheets[index];
      const rate = (displayRatePerSquareFootCents(catalogue, sheet) / 100).toFixed(2);
      assert.equal(card.hidden, material.id !== 'birch');
      assert.ok(card.content.includes(`src="${sheet.image}"`));
      assert.ok(card.content.includes(`<span class="rate-base">$1.13 + </span>$${rate}<span class="rate-unit">/sq ft</span>`));
    });
  }
  assert.match(birch[0].content, /5\.2 mm/);
  assert.match(birch[0].content, /\(0 and 3\/16 inches\)/);
});

test('catalogue edits change generated limits, defaults and rates without editing the template', () => {
  const changed = structuredClone(catalogue);
  changed.cut_size_limits_mm = { width: 180, height: 300 };
  changed.piece_size_rules = { minimum_side_mm: 40, minimum_longer_side_mm: 120, default_side_mm: 140 };
  changed.base_price_per_piece_cents = 125;
  changed.sheets = [changed.sheets[0]];
  changed.materials = changed.materials.filter(material => material.id === changed.sheets[0].material_id);
  changed.sheets[0].labour_markup_basis_points += 1000;
  const html = buildStorefront(template, changed);
  assertMenu(html, 'width', 40, 180, 140);
  assertMenu(html, 'height', 40, 300, 140);
  assertMenu(html, 'diameter', 120, 180, 140);
  assert.match(html, /id="width-help">Max 180 mm \(7 and 1\/16 inches\)\nAcross the grain<\/p>/);
  assert.match(html, /id="height-help">Max 300 mm \(11 and 13\/16 inches\)\nAlong the grain<\/p>/);
  assert.match(html, /id="diameter-help">Max 180 mm \(7 and 1\/16 inches\)<\/p>/);
  const materialCards = cards(html).filter(card => !card.hidden);
  assert.equal(materialCards.length, 1);
  assert.equal(materialCards[0].id, changed.sheets[0].id);
  assert.equal(materialCards[0].checked, true);
  const rate = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
    .format(displayRatePerSquareFootCents(changed, changed.sheets[0]) / 100);
  assert.ok(materialCards[0].content.includes(`<span class="rate-base">$1.41 + </span>${rate}<span class="rate-unit">/sq ft</span>`));
});

test('build rejects missing, duplicate and unresolved template markers', () => {
  const markers = [...template.matchAll(/\{\{[A-Z_]+\}\}/g)].map(match => match[0]);
  assert.equal(markers.length, 8);
  for (const marker of markers) {
    assert.throws(() => buildStorefront(template.replace(marker, ''), catalogue), /Expected one/);
    assert.throws(() => buildStorefront(template + marker, catalogue), /Expected one/);
  }
  assert.throws(() => buildStorefront(template + '{{UNKNOWN_CONTENT}}', catalogue), /Unresolved storefront template marker/);
});

test('build validates the catalogue before producing controls', () => {
  const invalid = structuredClone(catalogue);
  invalid.piece_size_rules.default_side_mm = 5000;
  assert.throws(() => buildStorefront(template, invalid), /Invalid material settings/);
});
