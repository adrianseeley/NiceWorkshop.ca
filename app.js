(() => {
  'use strict';

  // Lengths use whole ten-thousandths of a millimetre for exact pricing.
  // New cut sizes are selected in whole millimetres; inch labels are references only.
  const PER_MM = 10000;
  const PER_INCH = 254000;
  const BASIS_POINTS = 10000n;
  const SQUARE_INCH = BigInt(PER_INCH) ** 2n;
  const SQUARE_FOOT = 144n * SQUARE_INCH;
  const millimetreFormatter = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 4 });
  const STORAGE_KEY = 'niceworkshop.cart.v1';
  const FRACTIONS = ['0', '1/16', '1/8', '3/16', '1/4', '5/16', '3/8', '7/16',
    '1/2', '9/16', '5/8', '11/16', '3/4', '13/16', '7/8', '15/16'];
  const LEGACY_MATERIAL = { id: 'birch', name: 'Sanded Birch Plywood', finish: 'Unfinished', short_name: 'birch' };

  function roundRatio(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) throw new Error('Invalid pricing ratio.');
    return Number((2n * numerator + denominator) / (2n * denominator));
  }

  function sheetAreaUnits(size) {
    return BigInt(Math.round(size.width * PER_MM)) * BigInt(Math.round(size.height * PER_MM));
  }

  function fitsSheet(config, shape, width, height) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return false;
    const widthLimit = config.cut_size_limits_mm.width * PER_MM;
    const lengthLimit = config.cut_size_limits_mm.height * PER_MM;
    return shape === 'circle'
      ? width === height && width <= Math.min(widthLimit, lengthLimit)
      : shape === 'rectangle' && width <= widthLimit && height <= lengthLimit;
  }

  function meetsMinimumSize(config, width, height) {
    const rules = config.piece_size_rules;
    return Math.min(width, height) >= rules.minimum_side_mm * PER_MM
      && Math.max(width, height) >= rules.minimum_longer_side_mm * PER_MM;
  }

  function nominalInches(units) {
    // Round the reference once, including carry into the next whole inch.
    const totalSixteenths = Math.round(units * 16 / PER_INCH);
    const whole = Math.floor(totalSixteenths / 16);
    const fraction = totalSixteenths % 16;
    return fraction ? `${whole} and ${FRACTIONS[fraction]} inches`
      : `${whole} ${whole === 1 ? 'inch' : 'inches'}`;
  }

  function millimetres(units) {
    // Stored legacy dimensions may contain fractions of a mm; never resize them.
    return millimetreFormatter.format(units / PER_MM);
  }

  function dimensionLabel(units) {
    return `${millimetres(units)} mm (${nominalInches(units)})`;
  }

  function catalogueMaterials(config) {
    return config.materials || [LEGACY_MATERIAL];
  }

  function materialForSheet(config, sheet) {
    return catalogueMaterials(config).find(material => material.id === (sheet.material_id || LEGACY_MATERIAL.id));
  }

  function productName(material) {
    return material.finish ? `${material.name} (${material.finish})` : material.name;
  }

  function defaultSheet(config) {
    return config.sheets.find(sheet => sheet.id === 'birch-12-7') || config.sheets[0];
  }

  function thicknessUnits(sheet) {
    return Math.round(Number(sheet.display_thickness?.mm || sheet.nominal_thickness.mm) * PER_MM);
  }

  function thicknessesForMaterial(config, material) {
    return [
      ...config.sheets.filter(sheet => materialForSheet(config, sheet).id === material.id)
        .map(sheet => ({ id: sheet.id, units: thicknessUnits(sheet), sheet, image: sheet.image })),
      ...(material.preview_thicknesses || []).map(preview => ({
        id: preview.id, units: Math.round(preview.nominal_thickness_mm * PER_MM), image: preview.image, preview
      }))
    ];
  }

  function restoreItems(config, items) {
    return items.slice(0, 100).filter(item => validItem(config, item)).map(item => ({
      sheetId: item.sheetId, shape: item.shape, widthUnits: item.widthUnits,
      heightUnits: item.heightUnits, quantity: item.quantity
    }));
  }

  function changeCartQuantity(items, index, delta) {
    if (!Number.isInteger(index) || !items[index] || ![-1, 1].includes(delta)) return items;
    const quantity = Math.min(999, items[index].quantity + delta);
    return items.flatMap((item, itemIndex) => itemIndex !== index ? [item]
      : quantity > 0 ? [{ ...item, quantity }] : []);
  }

  function validItem(config, item) {
    return item && config.sheets.some(sheet => sheet.id === item.sheetId)
      && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 999
      && fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)
      && meetsMinimumSize(config, item.widthUnits, item.heightUnits);
  }

  function materialRate(config, sheet) {
    return {
      numerator: BigInt(sheet.price_cents) * (BASIS_POINTS + BigInt(config.tax_rate_basis_points))
        + BigInt(sheet.shipping_cents) * BASIS_POINTS,
      denominator: BASIS_POINTS * sheetAreaUnits(sheet.sheet_size_mm ?? config.sheet_size_mm)
    };
  }

  function labourRate(config, sheet, material) {
    // Checkout snapshots use the price model from when the draft was created.
    if (config.schema_version === 2) {
      return { numerator: BigInt(sheet.profit_per_square_inch_cents), denominator: SQUARE_INCH };
    }
    return {
      numerator: material.numerator * BigInt(sheet.labour_markup_basis_points),
      denominator: material.denominator * BASIS_POINTS
    };
  }

  function displayRatePerSquareFootCents(config, sheet) {
    const material = materialRate(config, sheet);
    const labour = labourRate(config, sheet, material);
    const beforeTax = material.numerator * labour.denominator + labour.numerator * material.denominator;
    const taxFactor = BASIS_POINTS + BigInt(config.tax_rate_basis_points);
    return roundRatio(beforeTax * SQUARE_FOOT * taxFactor,
      material.denominator * labour.denominator * BASIS_POINTS);
  }

  function quote(config, item) {
    if (!validItem(config, item)) throw new Error('Choose a valid material, size, and quantity.');
    const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
    const areaNumerator = BigInt(item.widthUnits) * BigInt(item.heightUnits) * BigInt(item.quantity);
    const material = materialRate(config, sheet);
    const labour = labourRate(config, sheet, material);
    const materialCents = roundRatio(material.numerator * areaNumerator, material.denominator);
    const profitCents = roundRatio(labour.numerator * areaNumerator, labour.denominator);
    const baseCents = config.base_price_per_piece_cents * item.quantity;
    const subtotalCents = materialCents + profitCents + baseCents;
    const taxCents = roundRatio(BigInt(subtotalCents) * BigInt(config.tax_rate_basis_points), BASIS_POINTS);
    return { materialCents, profitCents, baseCents, subtotalCents, taxCents,
      totalCents: subtotalCents + taxCents,
      areaSquareInches: Number(areaNumerator) / Number(SQUARE_INCH) };
  }

  function cartTotals(config, items) {
    const lines = items.map(item => quote(config, item));
    const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
    const taxCents = roundRatio(BigInt(subtotalCents) * BigInt(config.tax_rate_basis_points), BASIS_POINTS);
    return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
  }

  function validateConfig(config) {
    const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
    const validSheetSize = size => [size?.width, size?.height]
      .every(value => Number.isFinite(value) && Math.round(value * PER_MM) > 0 && value <= 25400);
    const legacyPricing = config?.schema_version === 2;
    if ((!legacyPricing && config?.schema_version !== 3) || config.money_scale !== 100 || config.currency !== 'CAD'
      || config.display_rate_rounding !== (legacyPricing ? 'up_to_whole_cent_including_hst' : 'nearest_cent_per_square_foot_including_hst')
      || !nonnegativeInteger(config.tax_rate_basis_points) || config.tax_rate_basis_points > 10000
      || !nonnegativeInteger(config.base_price_per_piece_cents) || config.base_price_per_piece_cents > 1000000
      || !validSheetSize(config.sheet_size_mm)
      || ![config.cut_size_limits_mm?.width, config.cut_size_limits_mm?.height]
        .every(value => Number.isInteger(value) && value > 0)
      || config.cut_size_limits_mm.width > config.sheet_size_mm.width
      || config.cut_size_limits_mm.height > config.sheet_size_mm.height
      || ![config.piece_size_rules?.minimum_side_mm, config.piece_size_rules?.minimum_longer_side_mm,
        config.piece_size_rules?.default_side_mm].every(value => Number.isInteger(value) && value >= 1)
      || config.piece_size_rules.minimum_side_mm > config.piece_size_rules.minimum_longer_side_mm
      || config.piece_size_rules.default_side_mm < config.piece_size_rules.minimum_longer_side_mm
      || config.piece_size_rules.default_side_mm > Math.min(config.cut_size_limits_mm.width, config.cut_size_limits_mm.height)
      || !Array.isArray(config.sheets) || !config.sheets.length) throw new Error('Invalid material settings.');
    const ids = new Set();
    for (const sheet of config.sheets) {
      if (typeof sheet.id !== 'string' || !sheet.id || ids.has(sheet.id)
        || typeof sheet.label !== 'string'
        || ![sheet.price_cents, sheet.shipping_cents,
          legacyPricing ? sheet.profit_per_square_inch_cents : sheet.labour_markup_basis_points]
          .every(value => nonnegativeInteger(value) && value <= 1000000)
        || (sheet.sheet_size_mm !== undefined && (!validSheetSize(sheet.sheet_size_mm)
          || sheet.sheet_size_mm.width < config.cut_size_limits_mm.width
          || sheet.sheet_size_mm.height < config.cut_size_limits_mm.height))
        || !Number.isFinite(sheet.nominal_thickness?.mm) || sheet.nominal_thickness.mm <= 0
        || !Number.isFinite(sheet.nominal_thickness?.inches) || sheet.nominal_thickness.inches <= 0) {
        throw new Error('Invalid sheet record.');
      }
      ids.add(sheet.id);
    }
    if (config.materials !== undefined) {
      const validId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
      const validText = value => typeof value === 'string' && value.trim().length > 0;
      const validImage = value => typeof value === 'string' && /^\/images\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:webp|jpe?g|png)$/.test(value);
      const materialIds = new Set();
      if (!Array.isArray(config.materials) || !config.materials.length) throw new Error('Invalid material groups.');
      for (const material of config.materials) {
        if (!validId(material?.id) || materialIds.has(material.id) || !validText(material.name)
          || !validText(material.short_name) || !validText(material.description) || !validImage(material.image)
          || (material.finish !== undefined && !validText(material.finish))
          || (material.has_grain !== undefined && typeof material.has_grain !== 'boolean')
          || (material.preview_thicknesses !== undefined && !Array.isArray(material.preview_thicknesses))) {
          throw new Error('Invalid material group.');
        }
        materialIds.add(material.id);
        for (const preview of material.preview_thicknesses || []) {
          if (!validId(preview?.id) || ids.has(preview.id) || !validText(preview.label) || !validImage(preview.image)
            || !Number.isFinite(preview.nominal_thickness_mm) || preview.nominal_thickness_mm <= 0) {
            throw new Error('Invalid preview thickness.');
          }
          ids.add(preview.id);
        }
      }
      if (config.sheets.some(sheet => !materialIds.has(sheet.material_id) || (sheet.image !== undefined && !validImage(sheet.image)))) {
        throw new Error('Invalid sheet material group or photo.');
      }
      if (config.materials.some(material => !material.preview_thicknesses?.length && !config.sheets.some(sheet => sheet.material_id === material.id))) {
        throw new Error('A material group must have at least one thickness.');
      }
    }
    return config;
  }

  // The same calculation functions are available to Node for financial checks.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { quote, cartTotals, displayRatePerSquareFootCents, fitsSheet, meetsMinimumSize, validItem, validateConfig, roundRatio, nominalInches, dimensionLabel, restoreItems, changeCartQuantity, catalogueMaterials, materialForSheet, productName, defaultSheet, thicknessesForMaterial, PER_INCH, PER_MM };
  }
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const money = cents => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  let config;
  let checkoutSettings = { checkoutEnabled: false, mode: 'closed', termsVersion: '', deliveryPriceCents: 442,
    pickupAddress: '1019 Castleford Road, Renfrew, ON K7V 3Z8' };
  let checkoutConfigAvailable = false;
  let checkoutBusy = false;
  const CHECKOUT_STORAGE_KEY = 'niceworkshop.checkout.v1';
  let checkoutAttempt = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHECKOUT_STORAGE_KEY));
    if (/^[a-f0-9]{64}$/.test(saved?.fingerprint) && /^[A-Za-z0-9_-]{16,200}$/.test(saved?.key)
      && ['pending', 'ready', 'rejected', 'uncertain'].includes(saved?.status)) {
      checkoutAttempt = { ...saved, status: saved.status === 'pending' ? 'uncertain' : saved.status };
    }
  } catch { /* The current tab still retains its key when browser storage is unavailable. */ }
  const state = { shape: 'rectangle', materialId: '', thicknessId: '', widthUnits: 100 * PER_MM,
    heightUnits: 100 * PER_MM, diameterUnits: null, quantity: 1, items: [], fulfillment: 'pickup' };
  const selectedThicknesses = new Map();

  // Analytics is optional and must never interrupt pricing, cart, or checkout.
  function track(event, properties = {}) {
    try { window.NiceAnalytics?.track(event, typeof properties === 'function' ? properties() : properties); } catch { /* Optional reporting. */ }
  }
  function analyticsCart() {
    return { cart_total_cents: cartEstimate().totalCents,
      cart_piece_count: state.items.reduce((sum, item) => sum + item.quantity, 0),
      cart_line_count: state.items.length, fulfillment: state.fulfillment === 'dropoff' ? 'delivery' : 'pickup', currency: 'CAD' };
  }
  function analyticsPart(item) {
    const valid = validItem(config, item);
    const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
    return { ...(sheet && { sheet_id: item.sheetId, thickness_mm: thicknessUnits(sheet) / PER_MM }), shape: item.shape,
      width_mm: item.widthUnits / PER_MM, length_mm: item.heightUnits / PER_MM,
      quantity: item.quantity, valid, ...(valid ? { price_cents: quote(config, item).totalCents } : {}), currency: 'CAD' };
  }
  let configurationTimer;
  function trackConfiguration() {
    // Only interaction calls this: default/restored values are not new demand.
    clearTimeout(configurationTimer);
    let enabled = false;
    try { enabled = !!window.NiceAnalytics?.enabled(); } catch { return; }
    if (enabled) track('builder_started');
    if (!enabled || state.shape === 'other') return;
    configurationTimer = setTimeout(() => track('part_configured', () => analyticsPart(currentItem())), 700);
  }

  function thicknessLabel(sheet) {
    return dimensionLabel(thicknessUnits(sheet));
  }

  function readDimension(field) {
    const value = Number($(`${field}-mm`).value);
    state[`${field}Units`] = value * PER_MM;
  }

  function currentItem() {
    const circle = state.shape === 'circle';
    return { sheetId: state.thicknessId, shape: state.shape, widthUnits: circle ? state.diameterUnits : state.widthUnits,
      heightUnits: circle ? state.diameterUnits : state.heightUnits, quantity: state.quantity };
  }

  function currentMaterial() {
    return catalogueMaterials(config).find(material => material.id === state.materialId);
  }

  function materialIsUpcoming(material) {
    return !config.sheets.some(sheet => materialForSheet(config, sheet).id === material.id);
  }

  function renderDiagram(item, material) {
    const width = item.widthUnits / PER_MM;
    const length = item.heightUnits / PER_MM;
    const scale = Math.min(260 / width, 145 / length);
    const w = width * scale;
    const h = length * scale;
    const centerX = 190;
    const x = centerX - w / 2;
    const y = 70 + (145 - h) / 2;
    const dimensionY = y - 24;
    const dimensionX = x + w + 24;
    const horizontalArrow = Math.min(7, w / 3);
    const verticalArrow = Math.min(7, h / 3);
    const circle = item.shape === 'circle';
    const hasGrain = material.has_grain !== false;
    const fill = hasGrain ? 'url(#plan-grain)' : '#d8bc99';
    const shape = circle
      ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w / 2}" fill="${fill}" stroke="#977249" stroke-width="1.2"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#977249" stroke-width="1.2"/>`;
    const widthLabel = `${circle ? 'Diameter' : 'Width'} ${millimetres(item.widthUnits)} mm`;
    const lengthLabel = `Length ${millimetres(item.heightUnits)} mm`;
    $('piece-diagram-title').textContent = circle
      ? `${dimensionLabel(item.widthUnits)} diameter circle${hasGrain ? ', with grain running vertically' : ''}.`
      : `Width ${dimensionLabel(item.widthUnits)}${hasGrain ? ' across the grain' : ''}, length ${dimensionLabel(item.heightUnits)}${hasGrain ? ' along the grain' : ''}.`;
    $('diagram-content').innerHTML = `
      <defs>
        <pattern id="plan-grain" width="88" height="330" patternUnits="userSpaceOnUse">
          <rect width="88" height="330" fill="#efd9b7"/>
          <g fill="none" stroke="#ba925b" opacity=".32" stroke-width=".9">
            <path d="M5-10C17 40-3 95 9 150S1 265 7 340M18-10C30 52 8 105 21 170S13 274 20 340M34-10C44 60 23 115 37 184S29 287 36 340M48-10C58 65 38 120 51 183S43 287 49 340M66-10C77 47 55 100 69 170S61 280 66 340M80-10C90 48 72 115 83 175S73 287 80 340"/>
            <path d="M35 76C23 108 26 156 36 177C45 149 48 109 35 76ZM35 98C30 119 31 146 36 157C40 133 40 116 35 98Z"/>
          </g>
        </pattern>
      </defs>
      ${shape}
      <g fill="none" stroke="#6d543e" stroke-width="1.2">
        <path d="M${x} ${y - 8}V${y - 32}M${x + w} ${y - 8}V${y - 32}" opacity=".55"/>
        <path d="M${x} ${dimensionY}H${x + w}"/>
        ${circle ? '' : `<path d="M${x + w + 8} ${y}H${x + w + 32}M${x + w + 8} ${y + h}H${x + w + 32}" opacity=".55"/><path d="M${dimensionX} ${y}V${y + h}"/>`}
        ${hasGrain ? `<path d="M${centerX} 238V260"/>` : ''}
      </g>
      <g fill="#6d543e">
        <path class="dimension-arrow" d="M${x + horizontalArrow} ${dimensionY}L${x} ${dimensionY - 3}V${dimensionY + 3}Z M${x + w - horizontalArrow} ${dimensionY}L${x + w} ${dimensionY - 3}V${dimensionY + 3}Z"/>
        ${circle ? '' : `<path class="dimension-arrow" d="M${dimensionX} ${y + verticalArrow}L${dimensionX - 3} ${y}H${dimensionX + 3}Z M${dimensionX} ${y + h - verticalArrow}L${dimensionX - 3} ${y + h}H${dimensionX + 3}Z"/>`}
        ${hasGrain ? `<path d="M${centerX} 235l-3 6h6Z M${centerX} 263l-3-6h6Z"/>` : ''}
      </g>
      <g fill="#594332" font-family="system-ui, sans-serif" font-size="15" font-weight="400">
        <text x="${centerX}" y="${y - 59}" text-anchor="middle" font-size="14">${escape(widthLabel)}<tspan x="${centerX}" dy="22" font-size="11">(${nominalInches(item.widthUnits)})</tspan></text>
        ${circle ? '' : `<text transform="translate(${x + w + 77} ${y + h / 2}) rotate(90)" text-anchor="middle" font-size="14">${escape(lengthLabel)}<tspan x="0" dy="22" font-size="11">(${nominalInches(item.heightUnits)})</tspan></text>`}
        ${hasGrain ? `<text x="${centerX}" y="285" text-anchor="middle" font-size="12" letter-spacing="1">GRAIN DIRECTION</text>` : ''}
      </g>`;
  }

  function renderMaterialControls() {
    const material = currentMaterial();
    $('wood-cards').querySelectorAll('input[name="material"]').forEach(input => {
      input.checked = input.value === state.materialId;
    });
    $('rate-cards').querySelectorAll('[data-material]').forEach(card => {
      const input = card.querySelector('input');
      card.hidden = card.dataset.material !== state.materialId;
      input.disabled = card.hidden;
      input.checked = !card.hidden && input.value === state.thicknessId;
    });
    const upcoming = materialIsUpcoming(material);
    const status = $('material-status');
    status.textContent = upcoming ? 'Browse the planned thicknesses before online ordering opens.' : '';
    status.hidden = !upcoming;
    const hasGrain = material.has_grain !== false;
    $('width-help').textContent = `Max ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)}${hasGrain ? '\nAcross the grain' : ''}`;
    $('height-help').textContent = `Max ${dimensionLabel(config.cut_size_limits_mm.height * PER_MM)}${hasGrain ? '\nAlong the grain' : ''}`;
  }

  function renderControls() {
    $('shape').querySelectorAll('input[name="shape"]').forEach(input => {
      input.checked = input.value === state.shape;
    });
    const custom = state.shape === 'other';
    $('cut-options').hidden = custom;
    $('custom-shape-note').hidden = !custom;
    if (custom) {
      $('add-to-cart').disabled = true;
      return;
    }
    const circle = state.shape === 'circle';
    $('width-field').hidden = circle;
    $('height-field').hidden = circle;
    $('diameter-field').hidden = !circle;
    $('width-mm').value = String(state.widthUnits / PER_MM);
    if (circle) {
      state.diameterUnits ??= Math.max(config.piece_size_rules.minimum_longer_side_mm * PER_MM,
        Math.min(state.widthUnits, config.cut_size_limits_mm.height * PER_MM));
    }
    $('diameter-mm').value = String(state.diameterUnits === null ? config.piece_size_rules.default_side_mm : state.diameterUnits / PER_MM);
    $('height-mm').value = String(state.heightUnits / PER_MM);
    renderQuote();
  }

  function renderQuote() {
    if (state.shape === 'other') return;
    const item = currentItem();
    const material = currentMaterial();
    const valid = validItem(config, item);
    let error = '';
    if (!Number.isInteger(state.quantity) || state.quantity < 1 || state.quantity > 999) error = 'Enter a quantity from 1 to 999.';
    else if (!item.widthUnits || !item.heightUnits) error = 'Choose a size greater than zero.';
    else if (!fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) error = state.shape === 'circle'
      ? `The diameter must fit within ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)}.`
      : `Width is limited to ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)} and length to ${dimensionLabel(config.cut_size_limits_mm.height * PER_MM)}.${material.has_grain === false ? '' : ' Grain runs along the length.'}`;
    else if (!meetsMinimumSize(config, item.widthUnits, item.heightUnits)) {
      const minimumLong = dimensionLabel(config.piece_size_rules.minimum_longer_side_mm * PER_MM);
      const minimumShort = dimensionLabel(config.piece_size_rules.minimum_side_mm * PER_MM);
      error = state.shape === 'circle' ? `Circles must be at least ${minimumLong} in diameter.`
        : `At least one side must be ${minimumLong} or longer. The other must be at least ${minimumShort}.`;
    }
    $('size-error').textContent = error;
    $('size-error').hidden = !error;
    $('add-to-cart').disabled = !valid;
    $('quantity-minus').disabled = !Number.isInteger(state.quantity) || state.quantity <= 1;
    $('quantity-plus').disabled = !Number.isInteger(state.quantity) || state.quantity >= 999;
    const validSize = fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)
      && meetsMinimumSize(config, item.widthUnits, item.heightUnits);
    $('width-mm').setAttribute('aria-invalid', String(!validSize));
    $('height-mm').setAttribute('aria-invalid', String(!validSize));
    $('diameter-mm').setAttribute('aria-invalid', String(!validSize));
    $('quantity').setAttribute('aria-invalid', String(!Number.isInteger(state.quantity) || state.quantity < 1 || state.quantity > 999));
    if (fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) renderDiagram(item, material);
    if (valid) {
      const single = quote(config, { ...item, quantity: 1 });
      const line = quote(config, item);
      $('piece-price').textContent = money(state.quantity === 1 ? single.totalCents : line.totalCents);
      $('piece-price-note').textContent = state.quantity === 1 ? 'each · estimated HST included' : `for ${state.quantity} pieces · estimated HST included`;
      if ($('line-price')) {
        $('line-price').hidden = state.quantity === 1;
        $('line-price').textContent = state.quantity > 1 ? `${money(single.totalCents)} for one piece` : '';
      }
    } else {
      $('piece-price').textContent = '—';
      const thickness = thicknessesForMaterial(config, material).find(option => option.id === state.thicknessId);
      $('piece-price-note').textContent = materialIsUpcoming(material) || thickness?.preview ? 'Coming soon'
        : thickness ? 'Choose a valid size and quantity for a price' : 'Choose a thickness for a price';
      if ($('line-price')) { $('line-price').textContent = ''; $('line-price').hidden = true; }
    }
  }

  function saveCart() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, items: state.items, fulfillment: state.fulfillment })); }
    catch { /* The cart still works when browser storage is unavailable. */ }
  }

  function restoreCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if ([1, 2].includes(saved?.version) && Array.isArray(saved.items)) {
        state.items = restoreItems(config, saved.items);
        if (state.items.length < saved.items.length) {
          $('cart-restore-note').textContent = 'Some saved pieces no longer meet the size requirements and have been left out of this cart. Please choose their sizes again.';
          $('cart-restore-note').hidden = false;
        }
        state.fulfillment = saved.fulfillment === 'dropoff' ? 'dropoff' : 'pickup';
      }
    } catch { /* Ignore old or corrupt saved carts. */ }
    document.querySelector(`input[name="fulfillment"][value="${state.fulfillment}"]`).checked = true;
  }

  function itemDescription(item) {
    const dimensions = item.shape === 'circle' ? `Diameter ${dimensionLabel(item.widthUnits)}`
      : `${dimensionLabel(item.widthUnits)} wide × ${dimensionLabel(item.heightUnits)} long`;
    return `${dimensions} · ${thicknessLabel(config.sheets.find(sheet => sheet.id === item.sheetId))} thick`;
  }

  function productTitle(item) {
    const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
    return `${productName(materialForSheet(config, sheet))} - ${item.shape === 'circle' ? 'Circle' : 'Rectangle'}`;
  }

  function cartEstimate() {
    const totals = cartTotals(config, state.items);
    const deliveryCents = state.fulfillment === 'dropoff' ? checkoutSettings.deliveryPriceCents : 0;
    const deliveryTaxCents = roundRatio(BigInt(deliveryCents) * BigInt(config.tax_rate_basis_points), 10000n);
    return { ...totals, deliveryCents, deliveryTaxCents,
      taxCents: totals.taxCents + deliveryTaxCents,
      totalCents: totals.totalCents + deliveryCents + deliveryTaxCents };
  }

  function renderCart() {
    const count = state.items.reduce((sum, item) => sum + item.quantity, 0);
    $('cart-count').textContent = String(count);
    $('empty-cart').hidden = !!count;
    $('cart-summary').hidden = !count;
    $('review-order').disabled = !count;
    $('cart-items').innerHTML = state.items.map((item, index) => {
      const line = quote(config, item);
      return `<article class="cart-item"><div class="cart-item-icon" aria-hidden="true"><span class="cart-item-swatch${item.shape === 'circle' ? ' is-circle' : ''}"></span></div><div class="cart-item-details"><div class="cart-item-heading"><h3 class="cart-item-title">${escape(productTitle(item))}</h3><button type="button" class="cart-item-remove" data-remove="${index}" aria-label="Remove ${escape(productTitle(item))}, ${escape(itemDescription(item))}">Remove</button></div><p class="cart-item-meta">${escape(itemDescription(item))}</p><div class="cart-item-bottom"><div class="cart-quantity" role="group" aria-label="Quantity for ${escape(productTitle(item))}, ${escape(itemDescription(item))}"><button type="button" data-quantity-index="${index}" data-delta="-1" aria-label="Decrease quantity of ${escape(productTitle(item))}, ${escape(itemDescription(item))}">−</button><span class="cart-quantity-value" aria-label="Quantity ${item.quantity}">Qty ${item.quantity}</span><button type="button" data-quantity-index="${index}" data-delta="1" aria-label="Increase quantity of ${escape(productTitle(item))}, ${escape(itemDescription(item))}"${item.quantity >= 999 ? ' disabled' : ''}>+</button></div></div><div class="cart-item-price">${money(line.subtotalCents)} <small>before HST</small></div></div></article>`;
    }).join('');
    const totals = cartEstimate();
    $('cart-subtotal').textContent = money(totals.subtotalCents);
    $('cart-delivery-row').hidden = state.fulfillment !== 'dropoff';
    $('cart-delivery').textContent = money(totals.deliveryCents);
    $('cart-tax').textContent = money(totals.taxCents);
    if ($('cart-tax-rate')) $('cart-tax-rate').textContent = `(${config.tax_rate_basis_points / 100}%)`;
    $('cart-total').textContent = money(totals.totalCents);
    if ($('cart-area')) $('cart-area').textContent = `${count} ${count === 1 ? 'piece' : 'pieces'}`;
    $('fulfillment-note').textContent = 'At this time we are a local only provider and do not offer shipping of any kind.';
  }

  function announce(message) {
    $('cart-announcement').textContent = message;
  }

  function addToCart() {
    const item = currentItem();
    if (!validItem(config, item)) return;
    const existing = state.items.find(line => ['sheetId', 'shape', 'widthUnits', 'heightUnits'].every(key => line[key] === item[key]));
    if (existing && existing.quantity + item.quantity > 999) {
      $('size-error').hidden = false;
      $('size-error').textContent = 'A matching cart item already has this size. The maximum is 999 of each piece.';
      return;
    }
    if (!existing && state.items.length >= 100) {
      $('size-error').hidden = false;
      $('size-error').textContent = 'Your cart has 100 different pieces. Remove a piece before adding another size.';
      return;
    }
    if (existing) existing.quantity += item.quantity;
    else state.items.push(item);
    saveCart();
    renderCart();
    track('part_added', () => ({ ...analyticsPart(item), ...analyticsCart() }));
    announce(`${item.quantity} ${currentMaterial().short_name} ${item.shape}${item.quantity === 1 ? '' : 's'} added to your cart.`);
    $('add-to-cart').textContent = 'Added to your cart ✓';
    clearTimeout(addToCart.timer);
    addToCart.timer = setTimeout(() => { $('add-to-cart').innerHTML = 'Add to cart <span aria-hidden="true">+</span>'; }, 1800);
  }

  function orderText() {
    const totals = cartEstimate();
    const lines = state.items.map((item, index) => {
      const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
      return `${index + 1}. ${productTitle(item)} — ${itemDescription(item)}\n   ${thicknessLabel(sheet)} nominal ${materialForSheet(config, sheet).short_name}; quantity ${item.quantity}\n   ${money(quote(config, item).subtotalCents)} before HST`;
    });
    return `NICE WORKSHOP — ORDER SUMMARY${checkoutSettings.mode === 'test' ? ' — TEST ONLY' : ''}\n\n${lines.join('\n\n')}\n\nCut subtotal: ${money(totals.subtotalCents)} CAD${totals.deliveryCents ? `\nLocal delivery before HST: ${money(totals.deliveryCents)}` : ''}\nEstimated HST (${config.tax_rate_basis_points / 100}%): ${money(totals.taxCents)}\nEstimated total: ${money(totals.totalCents)} CAD\n\n${state.fulfillment === 'pickup' ? `Free driveway pickup — ${checkoutSettings.pickupAddress}.` : 'Local Drop Off — Arnprior, Braeside, McNab, or Renfrew, Ontario. Delivery is included in the estimate above.'}\nCurrent lead time: 14 days.\n\nAll measurements are in mm. Inches are provided as a nominal reference only, rounded to the nearest 1/16 inch.\nThicknesses are nominal. Actual thickness may vary.\nCutting, light edge cleanup, and a little love are all included.\nShopify calculates final tax at checkout.\nThis is an estimate. Your order will not be submitted until you check out with Shopify.`;
  }

  function saveCheckoutAttempt() {
    // Save only a fingerprint/key/status, never the customer's delivery address.
    try { sessionStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(checkoutAttempt)); }
    catch { /* Retry protection remains available in this open page. */ }
  }

  function checkoutMessage(message, warning = false) {
    $('checkout-status').textContent = message;
    $('checkout-status').hidden = !message;
    $('checkout-status').classList.toggle('is-warning', warning);
  }

  function renderCheckoutControls() {
    const enabled = checkoutSettings.checkoutEnabled && ['test', 'live'].includes(checkoutSettings.mode);
    const test = checkoutSettings.mode === 'test';
    $('checkout-form').hidden = !enabled;
    $('checkout-mode-notice').hidden = !test;
    $('checkout-mode-notice').textContent = 'Test shop — use test payment details only. Do not enter a real card.';
    $('dialog-test-notice').hidden = !test;
    $('order-dialog-intro').textContent = enabled
      ? 'Check every size and quantity. You’ll review the final total and complete payment securely with Shopify.'
      : checkoutConfigAvailable
        ? 'Checkout is not open yet. You can save this estimate. No order is sent and no payment is taken.'
        : 'Save a copy of your estimate. Checkout is not available in this preview.';
    const delivery = enabled && state.fulfillment === 'dropoff';
    $('pickup-checkout-note').hidden = delivery;
    $('delivery-address-fields').hidden = !delivery;
    $('delivery-address-fields').disabled = !delivery || checkoutBusy;
    $('accept-order-terms').disabled = checkoutBusy;
    $('close-order').disabled = checkoutBusy;
    $('checkout-submit').disabled = checkoutBusy;
    $('checkout-new-request').disabled = checkoutBusy;
    $('checkout-submit').textContent = checkoutBusy ? 'Preparing your checkout…'
      : test ? 'Continue to test checkout →' : 'Continue to Shopify checkout →';
    $('checkout-form').setAttribute('aria-busy', String(checkoutBusy));
  }

  async function loadCheckoutSettings() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/config', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const settings = await response.json();
      if (typeof settings.checkoutEnabled !== 'boolean' || !['test', 'live', 'closed'].includes(settings.mode)
        || !Number.isSafeInteger(settings.deliveryPriceCents) || settings.deliveryPriceCents < 0 || settings.deliveryPriceCents > 100000
        || typeof settings.pickupAddress !== 'string' || !settings.pickupAddress
        || typeof settings.termsVersion !== 'string') return;
      checkoutSettings = settings;
      checkoutConfigAvailable = true;
      try { window.NiceAnalytics?.configure(settings.analytics); } catch { /* Optional reporting. */ }
    } catch { /* A static preview remains a working estimate and summary builder. */ }
    finally {
      clearTimeout(timeout);
      renderCheckoutControls();
      renderCart();
      if ($('order-dialog').open) $('order-summary').textContent = orderText();
    }
  }

  function checkoutPayload() {
    const cuts = state.items.map(item => ({ sheetId: item.sheetId, shape: item.shape,
      widthUnits: item.widthUnits, heightUnits: item.heightUnits, quantity: item.quantity }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const payload = { cuts, fulfillment: state.fulfillment === 'dropoff' ? 'delivery' : 'pickup',
      acceptedTermsVersion: checkoutSettings.termsVersion };
    if (payload.fulfillment === 'delivery') {
      const normalize = value => value.trim().replace(/\s+/g, ' ');
      const postal = $('delivery-postal').value.replace(/\s/g, '').toUpperCase();
      payload.deliveryAddress = { address1: normalize($('delivery-address1').value),
        city: $('delivery-city').value, provinceCode: 'ON', countryCode: 'CA',
        zip: `${postal.slice(0, 3)} ${postal.slice(3)}` };
      const secondLine = normalize($('delivery-address2').value);
      if (secondLine) payload.deliveryAddress.address2 = secondLine;
    }
    return payload;
  }

  async function submitCheckout(allowUpdatedOrder = false) {
    if (checkoutBusy || !checkoutSettings.checkoutEnabled || !state.items.length
      || !$('checkout-form').reportValidity()) return;
    checkoutBusy = true;
    renderCheckoutControls();
    let submitted = false;
    try {
      if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) {
        checkoutMessage('Checkout needs a secure, supported browser. Save your summary and contact the workshop if this continues.', true);
        return;
      }
      const payload = checkoutPayload();
      const serialized = JSON.stringify(payload);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
      const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (checkoutAttempt && checkoutAttempt.fingerprint !== fingerprint) {
        if (['uncertain', 'pending'].includes(checkoutAttempt.status)) {
          checkoutMessage(`An earlier checkout may already exist. Contact hello@niceworkshop.ca before creating another order. Keep this reference: ${checkoutAttempt.key}. Your cart is still saved.`, true);
          $('checkout-new-request').hidden = true;
          return;
        }
        if (!allowUpdatedOrder) {
          checkoutMessage('Your order details changed since your previous checkout. If you already paid, contact the workshop. Otherwise, review the updated details and choose “Create checkout for these updated details”.', true);
          $('checkout-new-request').hidden = false;
          return;
        }
      }
      if (!checkoutAttempt || checkoutAttempt.fingerprint !== fingerprint) {
        checkoutAttempt = { fingerprint, key: crypto.randomUUID(), status: 'pending' };
      } else checkoutAttempt.status = 'pending';
      saveCheckoutAttempt();
      checkoutBusy = true;
      submitted = true;
      track('checkout_started', analyticsCart);
      $('checkout-new-request').hidden = true;
      renderCheckoutControls();
      checkoutMessage('Preparing a secure Shopify checkout. Your cart will stay here.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response, result;
      try {
        response = await fetch('/api/checkout', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': checkoutAttempt.key },
          body: serialized, signal: controller.signal });
        result = await response.json();
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        track('checkout_failed', () => ({ reason: 'rejected', ...analyticsCart() }));
        const uncertain = ['CHECKOUT_NEEDS_RECONCILIATION', 'CHECKOUT_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(result?.code)
          || (response.status >= 500 && result?.code !== 'CHECKOUT_NOT_READY');
        checkoutAttempt.status = uncertain ? 'uncertain' : 'rejected';
        saveCheckoutAttempt();
        if (result?.code === 'CHECKOUT_IN_PROGRESS') {
          checkoutMessage('This checkout is already being prepared. Wait a moment, then continue again with these same order details. Your cart is saved.', true);
        } else if (uncertain) {
          checkoutMessage(`We couldn’t confirm the checkout outcome. Your cart is saved. Retry only with these same details, or contact hello@niceworkshop.ca with reference ${checkoutAttempt.key} before starting another order.`, true);
        } else {
          checkoutMessage(typeof result?.error === 'string' ? `${result.error} Your cart is saved.` : 'Checkout could not be prepared. Your cart is saved; review your details and try again.', true);
        }
        return;
      }
      const url = new URL(result.checkoutUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !(url.hostname === 'checkout.shopify.com' || /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname))) {
        throw new Error('Invalid checkout destination.');
      }
      checkoutAttempt.status = 'ready';
      saveCheckoutAttempt();
      checkoutMessage('Your checkout is ready. Opening Shopify…');
      track('checkout_opened', analyticsCart);
      window.location.assign(url.toString());
    } catch {
      track('checkout_failed', () => ({ reason: 'network_error', ...analyticsCart() }));
      if (submitted && checkoutAttempt) {
        checkoutAttempt.status = 'uncertain';
        saveCheckoutAttempt();
      }
      checkoutMessage(submitted
        ? `The connection was interrupted. Your cart is saved. Retry with these same details, or contact hello@niceworkshop.ca with reference ${checkoutAttempt.key} before creating another order.`
        : 'Checkout could not start in this browser. Your cart is saved; please try again.', true);
    } finally {
      checkoutBusy = false;
      renderCheckoutControls();
    }
  }

  function wireEvents() {
    $('shape').addEventListener('change', event => {
      if (!event.target.matches('input[name="shape"]')) return;
      state.shape = event.target.value;
      renderControls();
      trackConfiguration();
    });
    $('wood-cards').addEventListener('change', event => {
      if (!event.target.matches('input[name="material"]')) return;
      const material = catalogueMaterials(config).find(candidate => candidate.id === event.target.value);
      if (!material || material.id === state.materialId) return;
      const previous = thicknessesForMaterial(config, currentMaterial()).find(option => option.id === state.thicknessId);
      const options = thicknessesForMaterial(config, material);
      if (previous) selectedThicknesses.set(state.materialId, previous.id);
      state.materialId = material.id;
      state.thicknessId = selectedThicknesses.get(material.id)
        || options.find(option => option.units === previous?.units)?.id || '';
      renderMaterialControls();
      renderQuote();
      trackConfiguration();
    });
    $('rate-cards').addEventListener('change', event => {
      if (!event.target.matches('input[name="thickness"]') || event.target.disabled) return;
      state.thicknessId = event.target.value;
      renderQuote();
      trackConfiguration();
    });
    ['width', 'height', 'diameter'].forEach(field => {
      $(`${field}-mm`).addEventListener('change', () => { readDimension(field); renderQuote(); trackConfiguration(); });
    });
    $('quantity').addEventListener('input', event => { state.quantity = event.target.valueAsNumber; renderQuote(); trackConfiguration(); });
    ['minus', 'plus'].forEach(direction => $(`quantity-${direction}`).addEventListener('click', () => {
      state.quantity = Math.max(1, Math.min(999, state.quantity + (direction === 'plus' ? 1 : -1)));
      $('quantity').value = String(state.quantity);
      renderQuote();
      trackConfiguration();
    }));
    $('add-to-cart').addEventListener('click', addToCart);
    $('cart-items').addEventListener('click', event => {
      const button = event.target.closest('[data-remove], [data-quantity-index]');
      if (!button) return;
      const isRemove = button.hasAttribute('data-remove');
      const index = Number(isRemove ? button.dataset.remove : button.dataset.quantityIndex);
      if (!state.items[index]) return;
      const previousItem = { ...state.items[index] };
      const oldQuantity = state.items[index].quantity;
      const delta = Number(button.dataset.delta);
      const removed = isRemove || (delta === -1 && oldQuantity === 1);
      if (isRemove) state.items.splice(index, 1);
      else state.items = changeCartQuantity(state.items, index, delta);
      saveCart();
      renderCart();
      track(removed ? 'part_removed' : 'cart_quantity_changed', () => ({
        ...analyticsPart(removed ? previousItem : state.items[index]), ...analyticsCart()
      }));
      const nextIndex = Math.min(index, state.items.length - 1);
      const selector = removed ? `[data-remove="${nextIndex}"]`
        : `[data-quantity-index="${index}"][data-delta="${state.items[index].quantity === 999 ? -1 : delta}"]`;
      const next = $('cart-items').querySelector(selector);
      const builderControl = state.shape === 'other' ? $('custom-shape-note').querySelector('a') : $('add-to-cart');
      (next || builderControl).focus({ preventScroll: true });
      announce(removed ? 'Piece removed from your cart.'
        : `Quantity updated to ${state.items[index].quantity}. Cart total ${$('cart-total').textContent}.`);
    });
    document.querySelectorAll('input[name="fulfillment"]').forEach(input => input.addEventListener('change', () => {
      state.fulfillment = input.value;
      saveCart();
      renderCart();
      track('fulfillment_changed', analyticsCart);
    }));
    $('review-order').addEventListener('click', () => {
      if (!state.items.length) return;
      track('order_reviewed', analyticsCart);
      $('order-summary').textContent = orderText();
      $('copy-status').textContent = '';
      $('accept-order-terms').checked = false;
      $('checkout-new-request').hidden = true;
      checkoutMessage(checkoutAttempt?.status === 'uncertain'
        ? `An earlier checkout was not confirmed. Keep the same details to retry, or contact hello@niceworkshop.ca with reference ${checkoutAttempt.key} before starting another order.` : '', checkoutAttempt?.status === 'uncertain');
      renderCheckoutControls();
      $('order-dialog').showModal();
    });
    $('close-order').addEventListener('click', () => $('order-dialog').close());
    $('order-dialog').addEventListener('cancel', event => { if (checkoutBusy) event.preventDefault(); });
    $('checkout-form').addEventListener('submit', event => { event.preventDefault(); submitCheckout(); });
    $('checkout-new-request').addEventListener('click', () => submitCheckout(true));
    ['delivery-address1', 'delivery-address2', 'delivery-city', 'delivery-postal'].forEach(id => {
      $(id).addEventListener('change', () => { $('accept-order-terms').checked = false; });
    });
    $('copy-order').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(orderText()); $('copy-status').textContent = 'Order summary copied.'; track('estimate_copied', analyticsCart); }
      catch { $('copy-status').textContent = 'Copy is unavailable here. Use Download summary instead.'; }
    });
    $('download-order').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([orderText()], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'niceworkshop-order.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('copy-status').textContent = 'Order summary downloaded.';
      track('estimate_downloaded', analyticsCart);
    });
  }

  async function start() {
    try {
      const response = await fetch('./materials.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Material data returned ${response.status}.`);
      config = validateConfig(await response.json());
      state.widthUnits = config.piece_size_rules.default_side_mm * PER_MM;
      state.heightUnits = state.widthUnits;
      const sheet = defaultSheet(config);
      state.materialId = materialForSheet(config, sheet).id;
      state.thicknessId = sheet.id;
      restoreCart();
      // Firefox can restore form values on reload; keep static controls aligned with the quote.
      renderMaterialControls();
      $('quantity').value = String(state.quantity);
      wireEvents();
      renderControls();
      renderCart();
      $('loading-status').hidden = true;
      $('app-content').hidden = false;
      renderCheckoutControls();
      loadCheckoutSettings();
    } catch (error) {
      $('loading-status').hidden = true;
      $('fatal-error').hidden = false;
      $('fatal-error').textContent = location.protocol === 'file:'
        ? 'Open this project through a local web server so the material catalogue can load. See README.md for the one-step preview command.'
        : 'We couldn’t load the material catalogue. Please refresh the page to try again.';
      console.error('Nice Workshop could not load:', error);
    }
  }
  start();
})();
