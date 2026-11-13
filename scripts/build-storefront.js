'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateConfig, dimensionLabel, nominalInches, displayRatePerSquareFootCents, catalogueMaterials,
  materialForSheet, defaultSheet, thicknessesForMaterial, PER_MM } = require('../app');
const ROOT = path.resolve(__dirname, '..');
const moneyFormatter = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const millimetreFormatter = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 4 });
const money = cents => moneyFormatter.format(cents / 100);
const millimetres = units => millimetreFormatter.format(units / PER_MM);
const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function dimensionOptions(config, field) {
  const min = field === 'diameter' ? config.piece_size_rules.minimum_longer_side_mm : config.piece_size_rules.minimum_side_mm;
  const { width, height } = config.cut_size_limits_mm;
  const max = field === 'diameter' ? Math.min(width, height) : field === 'height' ? height : width;
  return Array.from({ length: max - min + 1 }, (_, index) => {
    const mm = min + index;
    return `<option value="${mm}"${mm === config.piece_size_rules.default_side_mm ? ' selected' : ''}>${escape(dimensionLabel(mm * PER_MM))}</option>`;
  }).join('');
}

function samplePhoto(image, className) {
  return image ? `<img class="${className}" src="${escape(image)}" alt="" width="600" height="400" loading="lazy" decoding="async">` : '';
}

function materialCards(config, activeMaterial) {
  return catalogueMaterials(config).map(material => {
    const upcoming = !config.sheets.some(sheet => materialForSheet(config, sheet).id === material.id);
    return `<label class="material-card"><input type="radio" name="material" value="${escape(material.id)}"${material.id === activeMaterial.id ? ' checked' : ''}>${samplePhoto(material.image, 'material-card-image')}<span class="material-card-copy"><strong class="material-card-name">${escape(material.name)}</strong>${material.description ? `<span class="material-card-description">${escape(material.description)}</span>` : ''}${upcoming ? '<span class="material-card-status">Coming soon</span>' : ''}</span></label>`;
  }).join('');
}

function thicknessCards(config, activeSheet, activeMaterial) {
  const basePriceWithTax = Math.round(config.base_price_per_piece_cents * (10000 + config.tax_rate_basis_points) / 10000);
  const baseLabel = money(basePriceWithTax);
  return catalogueMaterials(config).flatMap(material => {
    const inactive = material.id !== activeMaterial.id;
    return thicknessesForMaterial(config, material).map(option => {
      const label = option.preview ? escape(option.preview.label) : `${millimetres(option.units)} mm`;
      const details = option.sheet ? `<span class="nominal-reference">(${nominalInches(option.units)})</span><strong class="rate-value"><span class="rate-base">${baseLabel} + </span>${money(displayRatePerSquareFootCents(config, option.sheet))}<span class="rate-unit">/sq ft</span></strong>` : '';
      return `<label class="thickness-option rate-card" data-material="${escape(material.id)}"${inactive ? ' hidden' : ''}><input type="radio" name="thickness" value="${escape(option.id)}"${option.id === activeSheet.id ? ' checked' : ''}${inactive ? ' disabled' : ''}>${samplePhoto(option.image || material.image, 'rate-card-image')}<span class="rate-copy"><span class="rate-label">${label}</span>${details}</span></label>`;
    });
  }).join('');
}

function buildStorefront(template, catalogue) {
  const config = validateConfig(catalogue);
  const activeSheet = defaultSheet(config);
  const activeMaterial = materialForSheet(config, activeSheet);
  const widthLimit = escape(dimensionLabel(config.cut_size_limits_mm.width * PER_MM));
  const lengthLimit = escape(dimensionLabel(config.cut_size_limits_mm.height * PER_MM));
  const diameterLimit = escape(dimensionLabel(Math.min(config.cut_size_limits_mm.width, config.cut_size_limits_mm.height) * PER_MM));
  const hasGrain = activeMaterial.has_grain !== false;
  const replacements = {
    WOOD_CARDS: materialCards(config, activeMaterial),
    MATERIAL_CARDS: thicknessCards(config, activeSheet, activeMaterial),
    WIDTH_OPTIONS: dimensionOptions(config, 'width'),
    HEIGHT_OPTIONS: dimensionOptions(config, 'height'),
    DIAMETER_OPTIONS: dimensionOptions(config, 'diameter'),
    WIDTH_HELP: `Max ${widthLimit}${hasGrain ? '\nAcross the grain' : ''}`,
    HEIGHT_HELP: `Max ${lengthLimit}${hasGrain ? '\nAlong the grain' : ''}`,
    DIAMETER_HELP: `Max ${diameterLimit}`
  };
  for (const [key, value] of Object.entries(replacements)) {
    const marker = `{{${key}}}`;
    if (template.split(marker).length !== 2) throw new Error(`Expected one ${marker} in storefront template.`);
    template = template.replace(marker, () => value);
  }
  if (/\{\{[A-Z_]+\}\}/.test(template)) throw new Error('Unresolved storefront template marker.');
  return template;
}

if (require.main === module) {
  const html = buildStorefront(fs.readFileSync(path.join(ROOT, 'index.template.html'), 'utf8'),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'materials.json'), 'utf8')));
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') !== html) {
      throw new Error('index.html is out of date. Run npm run build.');
    }
    console.log('Static storefront is up to date.');
  } else {
    fs.writeFileSync(path.join(ROOT, 'index.html'), html);
    console.log('Built index.html from index.template.html and materials.json.');
  }
}
module.exports = { buildStorefront };
