(() => {
  'use strict';

  // Lengths use whole ten-thousandths of a millimetre for exact pricing.
  // New cut sizes are selected in whole millimetres; inch labels are references only.
  const PER_MM = 10000;
  const PER_INCH = 254000;
  const STORAGE_KEY = 'niceworkshop.cart.v1';
  const FRACTIONS = ['0', '1/16', '1/8', '3/16', '1/4', '5/16', '3/8', '7/16',
    '1/2', '9/16', '5/8', '11/16', '3/4', '13/16', '7/8', '15/16'];

  function roundRatio(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) throw new Error('Invalid pricing ratio.');
    return Number((2n * numerator + denominator) / (2n * denominator));
  }

  function sheetAreaUnits(config) {
    return BigInt(Math.round(config.sheet_size_mm.width * PER_MM))
      * BigInt(Math.round(config.sheet_size_mm.height * PER_MM));
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
    return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 4 }).format(units / PER_MM);
  }

  function dimensionLabel(units) {
    return `${millimetres(units)} mm (${nominalInches(units)})`;
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

  function displayRateCents(config, sheet) {
    const sheetArea = sheetAreaUnits(config);
    const taxFactor = 10000n + BigInt(config.tax_rate_basis_points);
    const beforeTax = (BigInt(sheet.price_cents) * taxFactor
      + BigInt(sheet.shipping_cents) * 10000n) * BigInt(PER_INCH) ** 2n
      + BigInt(sheet.profit_per_square_inch_cents) * sheetArea * 10000n;
    const numerator = beforeTax * taxFactor;
    const denominator = sheetArea * 10000n * 10000n;
    // Round the HST-inclusive display estimate upward; never use this to bill.
    return Number((numerator + denominator - 1n) / denominator);
  }

  function quote(config, item) {
    if (!validItem(config, item)) throw new Error('Choose a valid material, size, and quantity.');
    const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
    const areaNumerator = BigInt(item.widthUnits) * BigInt(item.heightUnits) * BigInt(item.quantity);
    const areaDenominator = BigInt(PER_INCH) ** 2n;
    const sheetArea = sheetAreaUnits(config);
    const tax = BigInt(config.tax_rate_basis_points);
    // Keep supplier HST and allocated material exact until the customer line.
    const landedNumerator = BigInt(sheet.price_cents) * (10000n + tax)
      + BigInt(sheet.shipping_cents) * 10000n;
    const materialCents = roundRatio(landedNumerator * areaNumerator,
      10000n * sheetArea);
    const profitCents = roundRatio(BigInt(sheet.profit_per_square_inch_cents) * areaNumerator,
      areaDenominator);
    const baseCents = config.base_price_per_piece_cents * item.quantity;
    const subtotalCents = materialCents + profitCents + baseCents;
    const taxCents = roundRatio(BigInt(subtotalCents) * tax, 10000n);
    return { materialCents, profitCents, baseCents, subtotalCents, taxCents,
      totalCents: subtotalCents + taxCents,
      areaSquareInches: Number(areaNumerator) / Number(areaDenominator) };
  }

  function cartTotals(config, items) {
    const lines = items.map(item => quote(config, item));
    const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
    const taxCents = roundRatio(BigInt(subtotalCents) * BigInt(config.tax_rate_basis_points), 10000n);
    return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
  }

  function validateConfig(config) {
    const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
    if (config?.schema_version !== 2 || config.money_scale !== 100 || config.currency !== 'CAD'
      || config.display_rate_rounding !== 'up_to_whole_cent_including_hst'
      || !nonnegativeInteger(config.tax_rate_basis_points) || config.tax_rate_basis_points > 10000
      || !nonnegativeInteger(config.base_price_per_piece_cents) || config.base_price_per_piece_cents > 1000000
      || ![config.sheet_size_mm?.width, config.sheet_size_mm?.height]
        .every(value => Number.isFinite(value) && value > 0 && value <= 25400)
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
        || ![sheet.price_cents, sheet.shipping_cents, sheet.profit_per_square_inch_cents]
          .every(value => nonnegativeInteger(value) && value <= 1000000)
        || !Number.isFinite(sheet.nominal_thickness?.mm) || sheet.nominal_thickness.mm <= 0
        || !Number.isFinite(sheet.nominal_thickness?.inches) || sheet.nominal_thickness.inches <= 0) {
        throw new Error('Invalid sheet record.');
      }
      ids.add(sheet.id);
    }
    return config;
  }

  // The same calculation functions are available to Node for financial checks.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { quote, cartTotals, displayRateCents, fitsSheet, meetsMinimumSize, validItem, validateConfig, roundRatio, nominalInches, dimensionLabel, restoreItems, changeCartQuantity, PER_INCH, PER_MM };
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
  const state = { shape: 'rectangle', sheetId: '', widthUnits: 100 * PER_MM,
    heightUnits: 100 * PER_MM, quantity: 1, items: [], fulfillment: 'pickup' };

  function thicknessUnits(sheet) {
    return Math.round(Number(sheet.display_thickness?.mm || sheet.nominal_thickness.mm) * PER_MM);
  }

  function thicknessLabel(sheet) {
    return dimensionLabel(thicknessUnits(sheet));
  }

  function setDimensionInputs(field) {
    const input = $(`${field}-mm`);
    const min = config.piece_size_rules.minimum_side_mm;
    const max = field === 'width' ? config.cut_size_limits_mm.width : config.cut_size_limits_mm.height;
    input.innerHTML = Array.from({ length: max - min + 1 }, (_, index) => {
      const mm = min + index;
      return `<option value="${mm}">${dimensionLabel(mm * PER_MM)}</option>`;
    }).join('');
    input.value = String(state[`${field}Units`] / PER_MM);
  }

  function readDimension(field) {
    const value = Number($(`${field}-mm`).value);
    state[`${field}Units`] = value * PER_MM;
  }

  function currentItem() {
    return { sheetId: state.sheetId, shape: state.shape, widthUnits: state.widthUnits,
      heightUnits: state.shape === 'circle' ? state.widthUnits : state.heightUnits, quantity: state.quantity };
  }

  function renderMaterials() {
    const basePrice = config.base_price_per_piece_cents;
    const baseLabel = basePrice % 100 === 0 ? `$${basePrice / 100}` : money(basePrice);
    $('rate-cards').innerHTML = config.sheets.map((sheet, index) => {
      const rate = displayRateCents(config, sheet);
      const height = 7 + index * 6;
      const top = 32 - height;
      // Alternating veneer colours are illustrative, not a specified ply count.
      const layerCount = 3 + index * 2;
      const layerHeight = height / layerCount;
      const layers = Array.from({ length: layerCount }, (_, layer) => {
        const y = top + layer * layerHeight;
        return `<rect x="8" y="${y}" width="96" height="${layerHeight}" fill="${layer % 2 ? '#b18a59' : '#efdab2'}"/>`;
      }).join('');
      return `<label class="thickness-option rate-card"><input type="radio" name="thickness" value="${escape(sheet.id)}"${sheet.id === state.sheetId ? ' checked' : ''}><span class="rate-copy"><span class="rate-label">${millimetres(thicknessUnits(sheet))} mm <span class="thickness-suffix">thick</span></span><span class="nominal-reference">(${nominalInches(thicknessUnits(sheet))})</span><strong class="rate-value"><span class="rate-base">${baseLabel} + </span>${money(rate)}<span class="rate-unit">/sq in</span></strong></span><svg class="ply-profile rate-profile" viewBox="0 0 112 40" aria-hidden="true"><defs><clipPath id="ply-clip-${index}"><rect x="8" y="${top}" width="96" height="${height}" rx="1"/></clipPath></defs><g clip-path="url(#ply-clip-${index})">${layers}</g><rect x="8" y="${top}" width="96" height="${height}" rx="1" fill="none" stroke="#ad8654" stroke-width=".8"/></svg></label>`;
    }).join('');
  }

  function renderDiagram(item) {
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
    const shape = circle
      ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w / 2}" fill="url(#plan-grain)" stroke="#977249" stroke-width="1.2"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#plan-grain)" stroke="#977249" stroke-width="1.2"/>`;
    const widthLabel = `${circle ? 'Diameter' : 'Width'} ${millimetres(item.widthUnits)} mm`;
    const lengthLabel = `Length ${millimetres(item.heightUnits)} mm`;
    $('piece-diagram-title').textContent = circle
      ? `${dimensionLabel(item.widthUnits)} diameter circle, with grain running vertically.`
      : `Width ${dimensionLabel(item.widthUnits)} across the grain, length ${dimensionLabel(item.heightUnits)} along the grain.`;
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
        <path d="M${centerX} 238V260"/>
      </g>
      <g fill="#6d543e">
        <path class="dimension-arrow" d="M${x + horizontalArrow} ${dimensionY}L${x} ${dimensionY - 3}V${dimensionY + 3}Z M${x + w - horizontalArrow} ${dimensionY}L${x + w} ${dimensionY - 3}V${dimensionY + 3}Z"/>
        ${circle ? '' : `<path class="dimension-arrow" d="M${dimensionX} ${y + verticalArrow}L${dimensionX - 3} ${y}H${dimensionX + 3}Z M${dimensionX} ${y + h - verticalArrow}L${dimensionX - 3} ${y + h}H${dimensionX + 3}Z"/>`}
        <path d="M${centerX} 235l-3 6h6Z M${centerX} 263l-3-6h6Z"/>
      </g>
      <g fill="#594332" font-family="system-ui, sans-serif" font-size="15" font-weight="400">
        <text x="${centerX}" y="${y - 59}" text-anchor="middle" font-size="14">${escape(widthLabel)}<tspan x="${centerX}" dy="22" font-size="11">(${nominalInches(item.widthUnits)})</tspan></text>
        ${circle ? '' : `<text transform="translate(${x + w + 77} ${y + h / 2}) rotate(90)" text-anchor="middle" font-size="14">${escape(lengthLabel)}<tspan x="0" dy="22" font-size="11">(${nominalInches(item.heightUnits)})</tspan></text>`}
        <text x="${centerX}" y="285" text-anchor="middle" font-size="12" letter-spacing="1">GRAIN DIRECTION</text>
      </g>`;
  }

  function renderControls() {
    $('shape').value = state.shape;
    const circle = state.shape === 'circle';
    $('height-field').hidden = circle;
    $('width-label').textContent = circle ? 'Diameter' : 'Width';
    $('height-label').textContent = 'Length';
    $('width-help').textContent = `Max ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)}\nAcross the grain`;
    $('height-help').textContent = `Max ${dimensionLabel(config.cut_size_limits_mm.height * PER_MM)}\nAlong the grain`;
    setDimensionInputs('width');
    setDimensionInputs('height');
    renderMaterials();
    renderQuote();
  }

  function renderQuote() {
    const item = currentItem();
    const valid = validItem(config, item);
    let error = '';
    if (!Number.isInteger(state.quantity) || state.quantity < 1 || state.quantity > 999) error = 'Enter a quantity from 1 to 999.';
    else if (!item.widthUnits || !item.heightUnits) error = 'Choose a size greater than zero.';
    else if (!fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) error = state.shape === 'circle'
      ? `The diameter must fit within ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)}.`
      : `Width is limited to ${dimensionLabel(config.cut_size_limits_mm.width * PER_MM)} and length to ${dimensionLabel(config.cut_size_limits_mm.height * PER_MM)}. Grain runs along the length.`;
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
    $('quantity').setAttribute('aria-invalid', String(!Number.isInteger(state.quantity) || state.quantity < 1 || state.quantity > 999));
    if (fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) renderDiagram(item);
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
      $('piece-price-note').textContent = 'Choose your size for a price';
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
    return `Sanded Birch Plywood (Unfinished) - ${item.shape === 'circle' ? 'Circle' : 'Rectangle'}`;
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
    const deliveryTax = roundRatio(BigInt(checkoutSettings.deliveryPriceCents) * BigInt(config.tax_rate_basis_points), 10000n);
    $('delivery-estimate-note').textContent = `${money(checkoutSettings.deliveryPriceCents + deliveryTax)} including estimated HST`;
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
    announce(`${item.quantity} birch ${item.shape}${item.quantity === 1 ? '' : 's'} added to your cart.`);
    $('add-to-cart').textContent = 'Added to your cart ✓';
    clearTimeout(addToCart.timer);
    addToCart.timer = setTimeout(() => { $('add-to-cart').innerHTML = 'Add to cart <span aria-hidden="true">+</span>'; }, 1800);
  }

  function orderText() {
    const totals = cartEstimate();
    const lines = state.items.map((item, index) => {
      const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
      return `${index + 1}. ${productTitle(item)} — ${itemDescription(item)}\n   ${thicknessLabel(sheet)} nominal birch; quantity ${item.quantity}\n   ${money(quote(config, item).subtotalCents)} before HST`;
    });
    return `NICE WORKSHOP — ORDER SUMMARY${checkoutSettings.mode === 'test' ? ' — TEST ONLY' : ''}\n\n${lines.join('\n\n')}\n\nCut subtotal: ${money(totals.subtotalCents)} CAD${totals.deliveryCents ? `\nLocal delivery before HST: ${money(totals.deliveryCents)}` : ''}\nEstimated HST (${config.tax_rate_basis_points / 100}%): ${money(totals.taxCents)}\nEstimated total: ${money(totals.totalCents)} CAD\n\n${state.fulfillment === 'pickup' ? `Free driveway pickup — ${checkoutSettings.pickupAddress}.` : 'Local Drop Off — Arnprior, Braeside, McNab, or Renfrew, Ontario. Delivery is included in the estimate above.'}\nCurrent lead time: 14 days.\n\nAll measurements are in mm. Inches are provided as a nominal reference only, rounded to the nearest 1/16 inch.\nCut sizes above are width across the grain × length along the grain, or circle diameter. All thicknesses are nominal; actual thickness is typically slightly less, as is standard in the plywood industry.\nIncludes ${money(config.base_price_per_piece_cents)} per piece before HST, plus area pricing.\nCutting, light edge cleanup, and a little love are all included.\nShopify calculates final tax at checkout. This is an estimate, not a submitted order. No payment has been taken.`;
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
      window.location.assign(url.toString());
    } catch {
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
      state.shape = event.target.value;
      renderControls();
    });
    $('rate-cards').addEventListener('change', event => {
      if (!event.target.matches('input[name="thickness"]')) return;
      state.sheetId = event.target.value;
      renderQuote();
    });
    ['width', 'height'].forEach(field => {
      $(`${field}-mm`).addEventListener('change', () => { readDimension(field); renderQuote(); });
    });
    $('quantity').addEventListener('input', event => { state.quantity = event.target.valueAsNumber; renderQuote(); });
    ['minus', 'plus'].forEach(direction => $(`quantity-${direction}`).addEventListener('click', () => {
      state.quantity = Math.max(1, Math.min(999, state.quantity + (direction === 'plus' ? 1 : -1)));
      $('quantity').value = String(state.quantity);
      renderQuote();
    }));
    $('add-to-cart').addEventListener('click', addToCart);
    $('cart-items').addEventListener('click', event => {
      const button = event.target.closest('[data-remove], [data-quantity-index]');
      if (!button) return;
      const isRemove = button.hasAttribute('data-remove');
      const index = Number(isRemove ? button.dataset.remove : button.dataset.quantityIndex);
      if (!state.items[index]) return;
      const oldQuantity = state.items[index].quantity;
      const delta = Number(button.dataset.delta);
      const removed = isRemove || (delta === -1 && oldQuantity === 1);
      if (isRemove) state.items.splice(index, 1);
      else state.items = changeCartQuantity(state.items, index, delta);
      saveCart();
      renderCart();
      const nextIndex = Math.min(index, state.items.length - 1);
      const selector = removed ? `[data-remove="${nextIndex}"]`
        : `[data-quantity-index="${index}"][data-delta="${state.items[index].quantity === 999 ? -1 : delta}"]`;
      const next = $('cart-items').querySelector(selector);
      (next || $('add-to-cart')).focus({ preventScroll: true });
      announce(removed ? 'Piece removed from your cart.'
        : `Quantity updated to ${state.items[index].quantity}. Cart total ${$('cart-total').textContent}.`);
    });
    document.querySelectorAll('input[name="fulfillment"]').forEach(input => input.addEventListener('change', () => {
      state.fulfillment = input.value;
      saveCart();
      renderCart();
    }));
    $('review-order').addEventListener('click', () => {
      if (!state.items.length) return;
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
      try { await navigator.clipboard.writeText(orderText()); $('copy-status').textContent = 'Order summary copied.'; }
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
    });
  }

  async function start() {
    try {
      const response = await fetch('./materials.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Material data returned ${response.status}.`);
      config = validateConfig(await response.json());
      state.widthUnits = config.piece_size_rules.default_side_mm * PER_MM;
      state.heightUnits = state.widthUnits;
      state.sheetId = config.sheets.find(sheet => sheet.id === 'birch-12-7')?.id || config.sheets[0].id;
      restoreCart();
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
