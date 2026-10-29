(() => {
  'use strict';

  // Lengths use whole ten-thousandths of a millimetre for exact pricing.
  // Dropdown selections are bounded to each unit's permitted increment.
  const PER_MM = 10000;
  const PER_INCH = 254000;
  const STORAGE_KEY = 'niceworkshop.cart.v1';
  const FRACTIONS = ['0', '1/16', '1/8', '3/16', '1/4', '5/16', '3/8', '7/16',
    '1/2', '9/16', '5/8', '11/16', '3/4', '13/16', '7/8', '15/16'];

  function roundRatio(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) throw new Error('Invalid pricing ratio.');
    return Number((2n * numerator + denominator) / (2n * denominator));
  }

  function fitsSheet(config, shape, width, height) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return false;
    const widthLimit = config.sheet_size_inches.width * PER_INCH;
    const lengthLimit = config.sheet_size_inches.height * PER_INCH;
    return shape === 'circle'
      ? width === height && width <= Math.min(widthLimit, lengthLimit)
      : shape === 'rectangle' && width <= widthLimit && height <= lengthLimit;
  }

  function meetsMinimumSize(config, width, height) {
    const rules = config.piece_size_rules;
    return Math.min(width, height) >= rules.minimum_side_inches * PER_INCH
      && Math.max(width, height) >= rules.minimum_longer_side_inches * PER_INCH;
  }

  function snapDimension(units, unit, maximumInches, minimumInches = 1) {
    const increment = unit === 'mm' ? PER_MM : PER_INCH / 16;
    const minSteps = Math.ceil(minimumInches * PER_INCH / increment);
    const maxSteps = Math.floor(maximumInches * PER_INCH / increment);
    return Math.max(minSteps, Math.min(maxSteps, Math.round(units / increment))) * increment;
  }

  function validItem(config, item) {
    return item && config.sheets.some(sheet => sheet.id === item.sheetId)
      && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 999
      && fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)
      && meetsMinimumSize(config, item.widthUnits, item.heightUnits);
  }

  function displayRateCents(config, sheet) {
    const sheetArea = BigInt(config.sheet_size_inches.width) * BigInt(config.sheet_size_inches.height);
    const taxFactor = 10000n + BigInt(config.tax_rate_basis_points);
    const beforeTax = BigInt(sheet.price_cents) * taxFactor
      + BigInt(sheet.shipping_cents) * 10000n
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
    const sheetArea = BigInt(config.sheet_size_inches.width) * BigInt(config.sheet_size_inches.height);
    const tax = BigInt(config.tax_rate_basis_points);
    // Keep supplier HST and allocated material exact until the customer line.
    const landedNumerator = BigInt(sheet.price_cents) * (10000n + tax)
      + BigInt(sheet.shipping_cents) * 10000n;
    const materialCents = roundRatio(landedNumerator * areaNumerator,
      10000n * sheetArea * areaDenominator);
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
    if (config?.schema_version !== 1 || config.money_scale !== 100 || config.currency !== 'CAD'
      || config.display_rate_rounding !== 'up_to_whole_cent_including_hst'
      || !nonnegativeInteger(config.tax_rate_basis_points) || config.tax_rate_basis_points > 10000
      || !nonnegativeInteger(config.base_price_per_piece_cents) || config.base_price_per_piece_cents > 1000000
      || ![config.sheet_size_inches?.width, config.sheet_size_inches?.height]
        .every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000)
      || ![config.piece_size_rules?.minimum_side_inches, config.piece_size_rules?.minimum_longer_side_inches,
        config.piece_size_rules?.default_side_inches].every(value => Number.isInteger(value) && value >= 1)
      || config.piece_size_rules.minimum_side_inches > config.piece_size_rules.minimum_longer_side_inches
      || config.piece_size_rules.default_side_inches < config.piece_size_rules.minimum_longer_side_inches
      || config.piece_size_rules.default_side_inches > Math.min(config.sheet_size_inches.width, config.sheet_size_inches.height)
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
    module.exports = { quote, cartTotals, displayRateCents, fitsSheet, meetsMinimumSize, validItem, validateConfig, roundRatio, snapDimension, PER_INCH, PER_MM };
  }
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const money = cents => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
  const number = (value, digits = 4) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: digits }).format(value);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  let config;
  const state = { unit: 'in', shape: 'rectangle', sheetId: '', widthUnits: 5 * PER_INCH,
    heightUnits: 5 * PER_INCH, quantity: 1, items: [], fulfillment: 'pickup' };

  function thicknessLabel(sheet, unit = state.unit) {
    const nominal = sheet.display_thickness;
    const inches = nominal?.inches || number(sheet.nominal_thickness.inches);
    return unit === 'mm' ? `${nominal?.mm || number(sheet.nominal_thickness.mm)} mm` : `${inches} in`;
  }

  function dimensionLabel(units, unit = state.unit) {
    if (unit === 'mm') return `${number(units / PER_MM)} mm`;
    const whole = Math.floor(units / PER_INCH);
    const sixteenths = (units % PER_INCH) / (PER_INCH / 16);
    if (Number.isInteger(sixteenths)) return `${whole || !sixteenths ? whole : ''}${whole && sixteenths ? ' ' : ''}${sixteenths ? FRACTIONS[sixteenths] : ''} in`;
    return `${number(units / PER_INCH, 6)} in`;
  }

  function setDimensionInputs(field) {
    const units = state[`${field}Units`];
    const input = $(`${field}-whole`);
    const fraction = $(`${field}-fraction`);
    const maxInches = field === 'width' ? config.sheet_size_inches.width : config.sheet_size_inches.height;
    $(`${field}-fraction-field`).hidden = state.unit === 'mm';
    $(`${field}-inputs`).classList.toggle('is-metric', state.unit === 'mm');
    if (state.unit === 'mm') {
      const max = Math.floor(maxInches * 25.4);
      const min = Math.ceil(config.piece_size_rules.minimum_side_inches * 25.4);
      input.innerHTML = Array.from({ length: max - min + 1 }, (_, i) => `<option value="${i + min}">${i + min} mm</option>`).join('');
      input.value = String(units / PER_MM);
    } else {
      const whole = Math.floor(units / PER_INCH);
      const sixteenths = (units % PER_INCH) / (PER_INCH / 16);
      const min = config.piece_size_rules.minimum_side_inches;
      input.innerHTML = Array.from({ length: maxInches - min + 1 }, (_, i) => `<option value="${i + min}">${i + min} in</option>`).join('');
      input.value = String(whole);
      fraction.innerHTML = FRACTIONS.map((label, index) => ({ label, index }))
        .filter(({ index }) => whole === maxInches ? index === 0 : true)
        .map(({ label, index }) => `<option value="${index}">${label === '0' ? 'None' : '+ ' + label}</option>`).join('');
      fraction.value = String(sixteenths);
      fraction.disabled = whole === maxInches;
    }
  }

  function readDimension(field) {
    const value = Number($(`${field}-whole`).value);
    const maxInches = field === 'width' ? config.sheet_size_inches.width : config.sheet_size_inches.height;
    if (state.unit === 'mm') {
      state[`${field}Units`] = snapDimension(value * PER_MM, 'mm', maxInches, config.piece_size_rules.minimum_side_inches);
    } else {
      let sixteenths = Number($(`${field}-fraction`).value) || 0;
      if (value === maxInches) sixteenths = 0;
      state[`${field}Units`] = snapDimension(value * PER_INCH + sixteenths * PER_INCH / 16, 'in', maxInches, config.piece_size_rules.minimum_side_inches);
    }
    setDimensionInputs(field);
  }

  function currentItem() {
    return { sheetId: state.sheetId, shape: state.shape, widthUnits: state.widthUnits,
      heightUnits: state.shape === 'circle' ? state.widthUnits : state.heightUnits, quantity: state.quantity, unit: state.unit };
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
      return `<label class="thickness-option rate-card"><input type="radio" name="thickness" value="${escape(sheet.id)}"${sheet.id === state.sheetId ? ' checked' : ''}><span class="rate-copy"><span class="rate-label">${escape(thicknessLabel(sheet))} <span class="thickness-suffix">thick</span></span> <span class="rate-description">Sanded birch plywood</span><strong class="rate-value"><span class="rate-base">${baseLabel} + </span>${money(rate)}<span class="rate-unit">/sq in</span></strong></span><svg class="ply-profile rate-profile" viewBox="0 0 112 40" aria-hidden="true"><defs><clipPath id="ply-clip-${index}"><rect x="8" y="${top}" width="96" height="${height}" rx="1"/></clipPath></defs><g clip-path="url(#ply-clip-${index})">${layers}</g><rect x="8" y="${top}" width="96" height="${height}" rx="1" fill="none" stroke="#ad8654" stroke-width=".8"/></svg></label>`;
    }).join('');
  }

  function renderDiagram(item) {
    const width = item.widthUnits / PER_INCH;
    const length = item.heightUnits / PER_INCH;
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
    const widthLabel = `${circle ? 'Diameter' : 'Width'} ${dimensionLabel(item.widthUnits)}`;
    const lengthLabel = `Length ${dimensionLabel(item.heightUnits)}`;
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
      <g fill="#594332" font-family="system-ui, sans-serif" font-size="18" font-weight="550">
        <text x="${centerX}" y="${y - 42}" text-anchor="middle">${escape(widthLabel)}</text>
        ${circle ? '' : `<text transform="translate(${x + w + 49} ${y + h / 2}) rotate(90)" text-anchor="middle">${escape(lengthLabel)}</text>`}
        <text x="${centerX}" y="285" text-anchor="middle">Grain Direction</text>
      </g>`;
  }

  function renderControls() {
    document.querySelectorAll('[data-unit]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.unit === state.unit)));
    $('shape').value = state.shape;
    const circle = state.shape === 'circle';
    $('height-field').hidden = circle;
    $('width-label').textContent = `${circle ? 'Diameter' : 'Width'} (${state.unit})`;
    document.querySelector('label[for="width-fraction"]').textContent = `${circle ? 'Diameter' : 'Width'} fraction`;
    $('height-label').textContent = `Length (${state.unit})`;
    $('width-help').textContent = state.unit === 'in'
      ? `Max ${config.sheet_size_inches.width} inches`
      : `Max ${Math.floor(config.sheet_size_inches.width * 25.4)} mm`;
    $('height-help').textContent = state.unit === 'in'
      ? `Max ${config.sheet_size_inches.height} inches · Grain runs in this direction`
      : `Max ${Math.floor(config.sheet_size_inches.height * 25.4)} mm · Grain runs in this direction`;
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
    else if (!item.widthUnits || !item.heightUnits) error = state.unit === 'in'
      ? 'Enter a size greater than zero. Use the fraction selector for partial inches.'
      : 'Enter a size greater than zero.';
    else if (!fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) error = state.shape === 'circle'
      ? `The diameter must fit within ${config.sheet_size_inches.width} inches (${number(config.sheet_size_inches.width * 25.4)} mm).`
      : `Width is limited to ${config.sheet_size_inches.width} inches and length to ${config.sheet_size_inches.height} inches. Grain runs along the length.`;
    else if (!meetsMinimumSize(config, item.widthUnits, item.heightUnits)) {
      const minimumLong = state.unit === 'in' ? `${config.piece_size_rules.minimum_longer_side_inches} inches`
        : `${Math.ceil(config.piece_size_rules.minimum_longer_side_inches * 25.4)} mm`;
      const minimumShort = state.unit === 'in' ? `${config.piece_size_rules.minimum_side_inches} inch`
        : `${Math.ceil(config.piece_size_rules.minimum_side_inches * 25.4)} mm`;
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
    $('width-whole').setAttribute('aria-invalid', String(!validSize));
    $('height-whole').setAttribute('aria-invalid', String(!validSize));
    $('quantity').setAttribute('aria-invalid', String(!Number.isInteger(state.quantity) || state.quantity < 1 || state.quantity > 999));
    if (fitsSheet(config, item.shape, item.widthUnits, item.heightUnits)) renderDiagram(item);
    if (valid) {
      const single = quote(config, { ...item, quantity: 1 });
      const line = quote(config, item);
      $('piece-price').textContent = money(state.quantity === 1 ? single.totalCents : line.totalCents);
      $('piece-price-note').textContent = state.quantity === 1 ? 'each · HST included' : `for ${state.quantity} pieces · HST included`;
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: state.items, fulfillment: state.fulfillment })); }
    catch { /* The cart still works when browser storage is unavailable. */ }
  }

  function restoreCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.version === 1 && Array.isArray(saved.items)) {
        state.items = saved.items.slice(0, 100).filter(item => validItem(config, item));
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
    const unit = item.unit || 'in';
    const dimensions = item.shape === 'circle' ? `Diameter ${dimensionLabel(item.widthUnits, unit)}`
      : `${dimensionLabel(item.widthUnits, unit)} wide × ${dimensionLabel(item.heightUnits, unit)} long`;
    return `${dimensions} · ${thicknessLabel(config.sheets.find(sheet => sheet.id === item.sheetId), unit)} thick`;
  }

  function productTitle(item) {
    return `Sanded Birch Plywood (Unfinished) - ${item.shape === 'circle' ? 'Circle' : 'Rectangle'}`;
  }

  function renderCart() {
    const count = state.items.reduce((sum, item) => sum + item.quantity, 0);
    $('cart-count').textContent = String(count);
    $('empty-cart').hidden = !!count;
    $('cart-summary').hidden = !count;
    $('review-order').disabled = !count;
    $('cart-items').innerHTML = state.items.map((item, index) => {
      const line = quote(config, item);
      return `<article class="cart-item"><div class="cart-item-icon" aria-hidden="true"><span class="cart-item-swatch${item.shape === 'circle' ? ' is-circle' : ''}"></span></div><div class="cart-item-details"><h3 class="cart-item-title">${escape(productTitle(item))}</h3><p class="cart-item-meta">${escape(itemDescription(item))}</p><div class="cart-item-bottom"><span class="cart-item-meta">Qty ${item.quantity}</span><button type="button" class="cart-item-remove" data-remove="${index}" aria-label="Remove ${escape(productTitle(item))}, ${escape(itemDescription(item))}">Remove</button></div><div class="cart-item-price">${money(line.subtotalCents)} <small>before HST</small></div></div></article>`;
    }).join('');
    const totals = cartTotals(config, state.items);
    $('cart-subtotal').textContent = money(totals.subtotalCents);
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
    announce(`${item.quantity} birch ${item.shape}${item.quantity === 1 ? '' : 's'} added to your cart.`);
    $('add-to-cart').textContent = 'Added to your cart ✓';
    clearTimeout(addToCart.timer);
    addToCart.timer = setTimeout(() => { $('add-to-cart').textContent = 'Add to cart'; }, 1800);
  }

  function orderText() {
    const totals = cartTotals(config, state.items);
    const lines = state.items.map((item, index) => {
      const sheet = config.sheets.find(candidate => candidate.id === item.sheetId);
      return `${index + 1}. ${productTitle(item)} — ${itemDescription(item)}\n   ${thicknessLabel(sheet, item.unit || 'in')} nominal birch; quantity ${item.quantity}\n   ${money(quote(config, item).subtotalCents)} before HST`;
    });
    return `NICE WORKSHOP — ORDER SUMMARY\n\n${lines.join('\n\n')}\n\nSubtotal: ${money(totals.subtotalCents)} CAD\nHST (${config.tax_rate_basis_points / 100}%): ${money(totals.taxCents)}\nTotal: ${money(totals.totalCents)} CAD\n\n${state.fulfillment === 'pickup' ? 'Shop Pickup — Near the Horton Community Center (you will get an email with all the details).' : 'Local Drop Off — Renfrew or Arnprior (or like pretty close). Arrangements and any delivery fee require confirmation; no delivery fee included.'}\n\nCut sizes above are width across the grain × length along the grain, or circle diameter. All thicknesses are nominal; actual thickness is typically slightly less, as is standard in the plywood industry.\nIncludes ${money(config.base_price_per_piece_cents)} per piece before HST, plus area pricing.\nCutting, light edge cleanup, and a little love are all included.\nThis is an estimate, not a submitted order. No payment has been taken.`;
  }

  function wireEvents() {
    document.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
      const unit = button.dataset.unit;
      if (unit === state.unit) return;
      state.unit = unit;
      state.widthUnits = config.piece_size_rules.default_side_inches * PER_INCH;
      state.heightUnits = state.widthUnits;
      announce(`Size reset to ${dimensionLabel(state.widthUnits)} by ${dimensionLabel(state.heightUnits)}.`);
      renderControls();
      renderCart();
    }));
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
      $(`${field}-whole`).addEventListener('change', () => { readDimension(field); renderQuote(); });
      $(`${field}-fraction`).addEventListener('change', () => { readDimension(field); renderQuote(); });
    });
    $('quantity').addEventListener('input', event => { state.quantity = event.target.valueAsNumber; renderQuote(); });
    ['minus', 'plus'].forEach(direction => $(`quantity-${direction}`).addEventListener('click', () => {
      state.quantity = Math.max(1, Math.min(999, state.quantity + (direction === 'plus' ? 1 : -1)));
      $('quantity').value = String(state.quantity);
      renderQuote();
    }));
    $('add-to-cart').addEventListener('click', addToCart);
    $('cart-items').addEventListener('click', event => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      const index = Number(button.dataset.remove);
      state.items.splice(index, 1);
      saveCart();
      renderCart();
      const next = $('cart-items').querySelector(`[data-remove="${Math.min(index, state.items.length - 1)}"]`);
      (next || $('add-to-cart')).focus({ preventScroll: true });
      announce('Piece removed from your cart.');
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
      $('order-dialog').showModal();
    });
    $('close-order').addEventListener('click', () => $('order-dialog').close());
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
      state.widthUnits = config.piece_size_rules.default_side_inches * PER_INCH;
      state.heightUnits = state.widthUnits;
      state.sheetId = config.sheets.find(sheet => sheet.id === 'birch-12-7')?.id || config.sheets[0].id;
      restoreCart();
      wireEvents();
      renderControls();
      renderCart();
      $('loading-status').hidden = true;
      $('app-content').hidden = false;
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
