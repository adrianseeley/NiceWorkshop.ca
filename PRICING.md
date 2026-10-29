# Nice Workshop pricing

This is the workshop's pricing policy for cut birch plywood pieces. The customer pays **$1.00 per piece before tax**, plus the exact allocated material cost and a fixed workshop contribution for every chargeable square inch. Ontario HST is added to that subtotal. The whole-cent area rates displayed with the thickness options are rounded estimates only; they never determine the actual quote.

**Cutting, light edge cleanup, and a little love are all included in the price.** These are included services, not separate customer charges.

`materials.json` is the source of truth for the four sheet products, purchase prices, shipping allowances, contribution rates, and per-piece base price. Prices are the owner's before-tax purchase prices supplied on October 28, 2026. Product names and item numbers were checked against the linked McFadden's product pages on that date.

## 1. Charge for the rectangular footprint

The chargeable area is the smallest width-by-length rectangle enclosing the piece, multiplied by the number of identical pieces:

```text
piece area in square inches = width in inches × length in inches
total chargeable area       = piece area × quantity
```

For a circle, both width and length are its diameter. A 10-inch diameter circle therefore uses a **10 × 10 = 100 square inch footprint**. Do not use the circle's geometric area (πr²). The rectangle accounts for surrounding material; the pricing policy already allows for hold-down space and tool clearance. Do not add a second waste, clearance, or hold-down multiplier.

The standard sheet is 48 × 96 inches, or **4,608 square inches**. Dimensions are converted to inches before pricing. Sheet thickness is a product description, not an area multiplier. Width is across the sheet and must be at most 48 inches; length follows the face grain and must be at most 96 inches. **Do not rotate pieces to make them fit.** A 60-inch-wide × 24-inch-long piece is therefore invalid even though it could physically fit after rotation. Circle diameter must be at most 48 inches. This calculator does not promise a production nesting layout.

Each side must be at least **1 inch**, and at least one side must be at least **5 inches**. This permits a 5 × 1 inch rectangle, as well as a 1 × 5 inch rectangle with a different grain orientation, but excludes a 4 × 4 inch piece. A circle's diameter must be at least 5 inches. Sizes below these limits show a warning beneath the dimension controls and cannot be added to the cart. On restoring an older cart, smaller pieces are excluded with a notice.

The inch controls offer whole widths from 1 through 48 and whole lengths from 1 through 96, plus fractions in 1/16-inch steps. The maximum whole value permits no added fraction. The metric controls offer only whole millimetres: width from 26 through 1,219 mm and length from 26 through 2,438 mm. The 26 mm minimum is the ceiling of 1 inch (25.4 mm). At least one selected side must reach 127 mm, the exact equivalent of 5 inches. Circle diameter must be at least 127 mm and at most 1,219 mm. The metric maxima are the floors of 1,219.2 mm and 2,438.4 mm, keeping all selectable dimensions inside the sheet limits.

The builder initially opens at 5 × 5 inches. Changing to millimetres resets its width and length to 127 × 127 mm; changing to inches resets them to 5 × 5 inches. For circles, the diameter resets to 127 mm or 5 inches respectively. The customer then chooses the desired dimensions in the new unit system. Calculate the preview from the newly selected size. Existing cart selections keep their original dimensions and chosen units when the builder's unit changes.

These rules are shared settings in `materials.json`: `piece_size_rules.minimum_side_inches` is `1`, `minimum_longer_side_inches` is `5`, and `default_side_inches` is `5`. They determine which pieces can be quoted and the builder's default size; they do not add a charge or change the per-square-inch rates.

The top-down preview keeps the selected aspect ratio: width is horizontal, length is vertical, and face grain runs along the length. Depicted plywood edge layers are illustrative and do not establish a ply count or a measured thickness.

## 2. Recover the material cost

First calculate the cost of one sheet delivered to the workshop, then allocate its cost to the customer's chargeable footprint:

```text
landed sheet cost = before-tax purchase price × 1.13 + shipping allowance
material cost = landed sheet cost × total chargeable area / 4,608
```

The material line includes the allocated purchase price, purchase HST, and inbound shipping. All four products currently use a **$10.00 per-sheet shipping allowance**. This is a flat amount for getting the sheet to the workshop, not delivery of a finished order to a customer. The $10 allowance is treated as the total shipping cost to recover, with no additional inbound HST applied to it.

The model intentionally recovers purchase HST as part of the material line, as requested by the owner. Customer HST is a separate final calculation. No input tax credit adjustment is included in this pricing model.

Keep the landed sheet cost and allocation precise until the customer material line is rounded to cents. For example, the 25 mm sheet costs $109.13 × 1.13 + $10.00 = **$133.3169** in this allocation model.

## 3. Add the workshop contribution

The owner's “profit margin” is a fixed dollar contribution per square inch, not a percentage markup or percentage margin:

| Material | Contribution per square inch | Stored cents per square inch |
| --- | ---: | ---: |
| 4.75 mm actual; sold as 5.2 mm | $0.03 | 3 |
| ½ inch nominal | $0.04 | 4 |
| ¾ inch nominal | $0.06 | 6 |
| 25 mm nominal; shop category 1 inch | $0.07 | 7 |

```text
workshop contribution = total chargeable area × contribution rate
```

Thicker material requires more processing: larger tools and clearance, heavier handling, more bit wear, sanding, and dust collection. The increasing contribution rate allows for these costs and the workshop's earnings. It is not a promise of net profit after all operating expenses.

## 4. Add $1 for every piece

The shared setting `base_price_per_piece_cents: 100` adds **$1.00 before HST for each physical piece**, regardless of shape, size, or thickness:

```text
baseCents = base_price_per_piece_cents × quantity
base price in dollars = $1.00 × quantity
```

Twenty pieces therefore add $20.00 before HST. This is not a one-time cart fee or a minimum price; it is added to the material and workshop contribution for every piece. Including 13% HST, the base portion is $1.13 per piece.

## 5. Add the final sales tax

For a single material-and-size selection, add its rounded material line, rounded workshop contribution, and exact base price for its quantity. For a cart, add those subtotals for every distinct selection, then calculate HST once on the combined amount:

```text
selection subtotal = rounded material cost + rounded workshop contribution + base price
cart subtotal      = sum of selection subtotals
customer HST       = round to cents(cart subtotal × 0.13)
cart total         = cart subtotal + customer HST
```

Cart item amounts are shown **before HST**. The cart tax line is calculated from the combined subtotal; it is not the sum of independently rounded taxes for each item. The builder shows a tax-inclusive estimate for the current selection by itself.

The configured rate is **13% Ontario HST**, verified against the [Canada Revenue Agency's GST/HST rates and place-of-supply guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html).

## Rounded rates in the thickness options are display estimates only

Each thickness option repeats the **$1 per-piece base** together with its rounded area estimate, so that option contains the pricing information instead of relying on a separate base-price row. The $1 base is before HST; its tax-inclusive value is $1.13.

The area estimate includes HST and is rounded upward to a whole cent per square inch:

```text
raw display rate = (landed sheet cost / 4,608 + contribution per square inch) × 1.13
displayed rate in cents = ceiling(raw display rate in cents)
```

| Thickness category | Raw area estimate including HST | Rounded display estimate including HST |
| --- | ---: | ---: |
| 3/16 inch / supplier 5.2 mm | 4.375096…¢/in² | **$0.05/in²** |
| ½ inch / 12.7 mm | 6.251894…¢/in² | **$0.07/in²** |
| ¾ inch / 19.05 mm | 8.599736…¢/in² | **$0.09/in²** |
| 1 inch / supplier 25 mm | 11.179272…¢/in² | **$0.12/in²** |

The JSON setting is `display_rate_rounding: "up_to_whole_cent_including_hst"`. This controls presentation only. **Do not multiply these rounded display rates by area to calculate a quote.** Actual prices use the precise material allocation, contribution, base charge, and final tax calculations above. Rounding the display estimate does not change what the customer pays. The complete price beneath the controls is the exact calculated total including HST.

## Worked example: one 10-inch circle in 25 mm birch

The owner supplied a purchase price of $109.13 for the 25 mm sheet, with $10.00 shipping and a $0.07 per-square-inch contribution. The shared base price adds $1.00 for this one piece.

| Step | Calculation | Amount |
| --- | --- | ---: |
| Chargeable footprint | 10 × 10 × 1 | 100 in² |
| Landed sheet cost, kept unrounded internally | $109.13 × 1.13 + $10.00 | $133.3169 |
| Material share, kept unrounded internally | $133.3169 × 100 / 4,608 | $2.893161892… |
| Material line | Rounded to cents | $2.89 |
| Workshop contribution | 100 × $0.07 | $7.00 |
| Per-piece base price | 1 × $1.00 | $1.00 |
| Subtotal | $2.89 + $7.00 + $1.00 | $10.89 |
| Customer HST | $10.89 × 13%, rounded to cents | $1.42 |
| **Customer total** | **$10.89 + $1.42** | **$12.31** |

The $30 material figure mentioned in the original brief was illustrative. The actual configured material share for this example is $2.89. The rounded 12¢ area display does not enter this calculation.

## Worked example: 5-inch circles in 25 mm birch

Each circle meets the minimum diameter and has a 5 × 5 = 25 in² chargeable footprint. The $1.00 base applies to every circle:

| Step | One circle | Twenty identical circles |
| --- | ---: | ---: |
| Total chargeable area | 25 in² | 500 in² |
| Material share, rounded after quantity | $0.72 | $14.47 |
| Workshop contribution at $0.07/in² | $1.75 | $35.00 |
| Per-piece base price | $1.00 | $20.00 |
| Subtotal | $3.47 | $69.47 |
| Customer HST | $0.45 | $9.03 |
| **Customer total** | **$3.92** | **$78.50** |

The base price for twenty pieces is exactly `100 × 20 = 2000` cents. The twenty-piece total is calculated from the whole selection, rather than multiplying a rounded single-piece preview by twenty.

## Money and rounding

Money in `materials.json` uses **whole integer Canadian cents**. The stored value `1000` means **$10.00**:

```text
1 CAD = 100 cents
1 cent = 1
$26.70 = 2670
$10.00 = 1000
$1.00 = 100
$0.03 = 3
```

Tax is stored in basis points: `1300 / 10000 = 0.13`. Thickness measurements remain decimal numbers in their named units.

Keep the sheet-level HST and the allocated material calculation precise until the customer line is calculated. Do not first round a per-square-inch material rate, and do not round each individual piece and then multiply by quantity. Multiply by the total quantity first, then round the entire material line and contribution line to the nearest cent, with half cents rounded up. Add the base price, already an exact whole-cent amount (`100 × quantity`). Sum these amounts across all selections into the cart subtotal; calculate and round customer HST once on that combined subtotal; add it to the subtotal. Use integer or rational arithmetic for the pricing operations to avoid binary floating-point rounding errors.

The upward whole-cent rounding used for the thickness display is separate from these billing rules and is never a billing input.

Adding another piece with the same material, shape, width, and length merges it into the existing selection and increases its quantity. Its material and contribution are recalculated for the combined quantity before rounding, and its base price increases by $1.00 for every added piece. Different shapes, materials, or stored dimensions remain separate selections. After changing units, the builder starts from its reset dimensions; any newly added piece merges only with a selection having the same physical dimensions. Swapping width and length is a different selection because face-grain direction is fixed.

Because rounding happens at the selection and cart levels, a single-piece preview multiplied by quantity, or the sum of standalone tax-inclusive previews, may differ from the final cart by a few cents. The final cart calculation above is authoritative. For example, a 5 × 1 inch rectangle and a 1 × 5 inch rectangle in the thinnest birch remain separate selections because their grain orientations differ. Each has a $1.19 subtotal, including its $1.00 base price. Purchased together, their $2.38 combined subtotal incurs $0.31 HST for a $2.69 total. Taxing them separately would round each selection's HST to $0.15 and incorrectly produce $2.68 for the combined cart.

For a quantity example, one 12 × 24 inch rectangle in ½ inch birch totals $19.13. Three identical pieces together total $57.40: $13.24 material plus $34.56 contribution plus $3.00 base price, then $6.60 HST. The combined material amount is rounded after multiplication by three.

For example, purchase HST on $109.13 is retained as $14.1869 in this allocation model, even though a supplier invoice may round its tax line to cents. This is a deliberate, consistent estimator convention.

## Sheet catalogue and measurements

| Product | Nominal inches | Nominal mm | Actual inches | Actual mm | Before-tax price | Shipping |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [5.2 mm CW/4 birch](https://mcfaddens.com/5.2mm-CW-4-Grade-Rotary-Cut-Birch-48-x-96-Veneer-Core-Plywood-Panel.html) | 0.2047244094 | 5.2 | 0.1870078740 | 4.75 | $26.70 | $10.00 |
| [½ inch C/2 birch](https://mcfaddens.com/1-2-Thick-C-2-Grade-Rotary-Cut-Birch-48-x-96-Veneer-Core-Plywood-Panel.html) | 0.5 | 12.7 | Not measured | Not measured | $53.65 | $10.00 |
| [¾ inch CNAT/2 birch](https://mcfaddens.com/3-4-Thick-CNAT-2-Grade-Rotary-Cut-Birch-48-x-96-Veneer-Core-Plywood-Panel.html) | 0.75 | 19.05 | Not measured | Not measured | $56.82 | $10.00 |
| [25 mm C/2 panel](https://mcfaddens.com/25mm-Grade-C-2-Rotary-Cut-48-x-96-Veneer-Core-Plywood-Panel.html) | 0.9842519685 | 25 | Not measured | Not measured | $109.13 | $10.00 |

The exact supplier-declared product name is stored in each record's `supplier_name`, along with its `product_url` and item number. In this schema, `supplier_name` means the product name as declared by the supplier; the supplier company is separately recorded as `metadata.supplier`.

Three separate thickness concepts are recorded:

| Field | Purpose |
| --- | --- |
| `display_thickness` | Strings for the shop's customer-facing thickness categories in each unit system. |
| `nominal_thickness` | Numeric thickness declared by the supplier, with its exact unit conversion. |
| `actual_thickness` | Numeric measured thickness, or `null` until measured. |

The display categories are:

| Product | Inch-mode label | Millimetre-mode label |
| --- | --- | --- |
| 5.2 mm CW/4 birch | 3/16 inch | 5.2 mm |
| ½ inch C/2 birch | 1/2 inch | 12.7 mm |
| ¾ inch CNAT/2 birch | 3/4 inch | 19.05 mm |
| 25 mm C/2 panel | 1 inch | 25 mm |

Use these as nominal shop categories without a tilde. The simplified configurator omits the former nominal-thickness paragraph; actual sheet thickness is still usually less than nominal. The paired labels identify the same stock product; they are not statements of mathematical equality or measured thickness. In particular, 3/16 inch equals 4.7625 mm, not 5.2 mm, and 1 inch equals 25.4 mm, not 25 mm. The supplier's 5.2 mm and 25 mm numeric nominal values remain unchanged. The known 4.75 mm actual thickness of the thinnest sheet also remains separate from its labels.

Exact nominal conversions use **1 inch = 25.4 mm**: ½ inch is 12.7 mm; ¾ inch is 19.05 mm; 25 mm is approximately 0.984252 inch. The owner's earlier “12 mm” and “19 mm” labels were rounded categories, not measured thicknesses. None of the thickness labels or measurements multiplies the price; selecting the product determines its configured purchase price and contribution rate.

Unknown actual measurements are JSON `null`, never zero and never copied from the nominal thickness. When a sheet arrives, fill both `actual_thickness.mm` and `actual_thickness.inches`, using `inches = mm / 25.4`. Repeating conversions can be recorded to 10 decimal places. Updating thickness measurements alone must not change a price.

## Updating the model

Edit the relevant sheet record in `materials.json`:

- `price_cents`: the owner's before-tax purchase price for one full sheet.
- `shipping_cents`: the shipping allowance allocated to that sheet; currently `1000` for every sheet.
- `profit_per_square_inch_cents`: the workshop contribution for one chargeable square inch.
- `actual_thickness`: the measured thickness, filled in when known.
- `display_thickness`: the nominal shop labels shown in the two unit systems; these strings must not replace the numeric supplier nominal or measured fields.

`base_price_per_piece_cents`, `display_rate_rounding`, `tax_rate_basis_points`, `sheet_size_inches`, and `piece_size_rules` are shared settings at the root of `materials.json`. The base price is currently `100`, or $1.00 before tax per piece. `display_rate_rounding` is `"up_to_whole_cent_including_hst"` and affects only the displayed area estimates. If the pricing, inbound shipping, or purchase-HST recovery policy changes, update the JavaScript and this document together. Prices, shipping, contribution rate, per-piece base price, tax rate, part dimensions, quantity, and sheet area drive billing; display rounding, the descriptive grade, name, link, and thickness fields do not. Size rules control eligibility and defaults without altering rates.
