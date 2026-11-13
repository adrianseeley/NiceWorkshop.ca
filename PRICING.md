# Nice Workshop pricing

## Checkout tax authority — October 31, 2026

The owner approved Shopify as the authority for final checkout tax. The calculations below are website estimates. Shopify rounds tax per line, so checkout tax can differ by a few cents. Matching cuts are sold as one bundle with the physical piece count on the line. [Shopify tax rounding](https://help.shopify.com/en/manual/taxes/registration/manage#tax-rounding)

The customer pays the allocated landed material cost, a thickness-based labour markup, and **$1.00 per piece before HST**. Cutting and light edge cleanup are included. The storefront shows estimated prices per square foot. Quotes use the exact cut dimensions.

`materials.json` stores the purchase prices, shipping allowances, labour markups, and per-piece base price for orderable birch, MDF, and HDF. The owner supplied the birch costs on October 28, 2026 and the labour tiers on November 13, 2026.

## 1. Charge for the rectangular footprint

The chargeable area is the smallest width-by-length rectangle enclosing the piece, multiplied by the number of identical pieces:

```text
piece area in square inches = width in inches × length in inches
total chargeable area       = piece area × quantity
```

For a circle, both width and length are its diameter. A 10-inch diameter circle therefore uses a **10 × 10 = 100 square inch footprint**. Do not use the circle's geometric area (πr²). The rectangle accounts for surrounding material; the pricing policy already allows for hold-down space and tool clearance. Do not add a second waste, clearance, or hold-down multiplier.

The standard sheet is **1,219.2 × 2,438.4 mm**, equivalent to 48 × 96 inches or **4,608 square inches**. Stock purchased as 49 × 97 inches uses **1,244.6 × 2,463.8 mm**, or **4,753 square inches**. Millimetres are the source of truth for sheet and piece dimensions. The selected sheet determines the area and thickness tier. For plywood, width is across the grain and length follows it. **Do not rotate pieces to make them fit.** This calculator does not promise a production nesting layout.

Both sides must be at least **25 mm**, and at least one side must be at least **100 mm**. This permits 100 × 25 mm and 25 × 100 mm rectangles with different grain orientations, but excludes 99 × 99 mm. Circle diameter must be at least **100 mm**. Smaller selections show a warning and cannot be added. On restoring an older cart, pieces that fail these rules are omitted with a notice.

The controls offer whole millimetres: width from 25 through 1,200 mm and length from 25 through 2,400 mm. Circle diameter uses the width control, with the 100 mm minimum enforced by validation. The authoritative cutting limits are **1,200 × 2,400 mm**, regardless of the larger purchased sheet. They apply to dropdown options, validation, circle diameter, and restored carts. Each dropdown, preview, cart row, and exported order shows millimetres with an inch reference in brackets, rounded to the nearest **1/16 inch**, such as `44 mm (1 and 3/4 inches)`. The page and order summary state that inches are nominal references only. References carry into the next whole inch when needed; they never resize a piece.

The builder starts at **100 × 100 mm**. There is no unit switch. Legacy saved pieces keep their exact physical dimensions, including fractional millimetres; their original display-unit preference is discarded. New dropdown selections are always whole millimetres. Internal dimensions remain integer ten-thousandths of a millimetre for exact calculations.

These rules are shared settings in `materials.json`: `piece_size_rules.minimum_side_mm` is `25`, `minimum_longer_side_mm` is `100`, and `default_side_mm` is `100`. `cut_size_limits_mm` records the 1,200 × 2,400 mm cutting limits. `sheet_size_mm` separately records the physical purchased sheet dimensions used for material-cost allocation. The larger purchased sheet is not a permitted cut-size range. Size rules control eligibility and defaults without adding charges or changing area rates.

## 2. Recover the material cost

First calculate the cost of one sheet delivered to the workshop, then allocate its cost to the customer's chargeable footprint:

```text
landed sheet cost = before-tax purchase price × 1.13 + shipping allowance
material cost = landed sheet cost × total chargeable area / purchased sheet area
```

The material line includes the allocated purchase price, purchase HST, and inbound shipping. All current products use a **$10.00 per-sheet shipping allowance**. This is a flat amount for getting the sheet to the workshop, not delivery of a finished order to a customer. The $10 allowance is treated as the total shipping cost to recover, with no additional inbound HST applied to it.

The model intentionally recovers purchase HST as part of the material line, as requested by the owner. Customer HST is a separate final calculation. No input tax credit adjustment is included in this pricing model.

Keep the landed sheet cost and allocation precise until the customer material line is rounded to cents. For example, the 25 mm sheet costs $109.13 × 1.13 + $10.00 = **$133.3169** in this allocation model.

## 3. Add the labour markup

Apply the markup to the unrounded allocated landed material cost. A 225% markup charges 2.25 times the material cost for labour, for a combined material and labour charge of 3.25 times the cost.

| Thickness tier | Labour markup | Stored basis points |
| --- | ---: | ---: |
| Thin (3–6.35 mm) | 225% | 22,500 |
| About 1/2″ (12.7 mm) | 250% | 25,000 |
| 3/4″ (19.05 mm) | 275% | 27,500 |
| About 1″ (25–25.4 mm) | 300% | 30,000 |

```text
labour charge = unrounded material cost × labour markup
```

The thicker tiers account for more handling and machining, including tool wear, sanding, and dust collection.

## 4. Add $1 for every piece

The shared setting `base_price_per_piece_cents: 100` adds **$1.00 before HST for each physical piece**, regardless of shape, size, or thickness:

```text
baseCents = base_price_per_piece_cents × quantity
base price in dollars = $1.00 × quantity
```

Twenty pieces therefore add $20.00 before HST. This is not a one-time cart fee or a minimum price; it is added to the material and labour charge for every piece. Including 13% HST, the base portion is $1.13 per piece.

## 5. Add the final sales tax

For a single material-and-size selection, add its rounded material line, rounded labour charge, and exact base price for its quantity. For a cart, add those subtotals for every distinct selection, then calculate HST once on the combined amount:

```text
selection subtotal = rounded material cost + rounded labour charge + base price
cart subtotal      = sum of selection subtotals
customer HST       = round to cents(cart subtotal × 0.13)
cart total         = cart subtotal + customer HST
```

Cart item amounts are shown **before HST**. The cart tax line is calculated from the combined subtotal; it is not the sum of independently rounded taxes for each item. The builder shows a tax-inclusive estimate for the current selection by itself.

The configured rate is **13% Ontario HST**, verified against the [Canada Revenue Agency's GST/HST rates and place-of-supply guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html).

## Square-foot display estimates

Each orderable thickness shows the **$1.13 per-piece charge** plus its area rate per square foot, both including estimated HST. The area rate is rounded to the nearest cent for display.

```text
area rate per ft² = (landed sheet cost / purchased sheet area in ft²) × (1 + labour markup) × 1.13
```

The quote uses precise material allocation and rounds material and labour separately. A 1 ft² cut can differ from the displayed area rate plus $1.13 by a cent.

## Worked example for 25 mm birch

The 25 mm birch sheet costs $109.13 before HST. Including purchase HST and the $10 shipping allowance, its landed cost is $133.3169. The 300% markup is applied to each cut group's exact allocated share.

| Step | One 10″ circle | One 5″ circle | Twenty 5″ circles |
| --- | ---: | ---: | ---: |
| Chargeable footprint | 100 in² | 25 in² | 500 in² |
| Rounded material charge | $2.89 | $0.72 | $14.47 |
| Rounded labour charge at 300% | $8.68 | $2.17 | $43.40 |
| Per-piece charges | $1.00 | $1.00 | $20.00 |
| Subtotal | $12.57 | $3.89 | $77.87 |
| Estimated HST | $1.63 | $0.51 | $10.12 |
| **Estimated total** | **$14.20** | **$4.40** | **$87.99** |

## Money and rounding

Money in `materials.json` uses integer Canadian cents, so `1000` is $10.00. Tax and labour markup use basis points. `1300 / 10000 = 0.13` and `22500 / 10000 = 2.25`.

Keep the sheet-level HST and allocated material calculation precise. Multiply by the total quantity before rounding material and labour separately to the nearest cent, with half cents rounded up. Add the $1 charge for each piece. Sum the selection subtotals, then calculate and round customer HST once on the combined subtotal.

Identical cuts merge by sheet, shape, exact width, and exact length. For example, one 12″ × 24″ rectangle in 1/2″ birch totals $18.59 with HST. Three identical pieces total $55.77, including $13.24 material, $33.11 labour, $3.00 in per-piece charges, and $6.42 HST. Swapping width and length creates a different cut group.

Existing checkout snapshots with fixed per-square-inch rates reproduce the prices that were saved when those checkouts were created.

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
| `display_thickness` | The shop's customer-facing mm thickness; inch references are derived from this value. |
| `nominal_thickness` | Numeric thickness declared by the supplier, with its exact unit conversion. |
| `actual_thickness` | Numeric measured thickness, or `null` until measured. |

The display categories are:

| Product | Inch-mode label | Millimetre-mode label |
| --- | --- | --- |
| 5.2 mm CW/4 birch | 3/16 inch | 5.2 mm |
| ½ inch C/2 birch | 1/2 inch | 12.7 mm |
| ¾ inch CNAT/2 birch | 3/4 inch | 19.05 mm |
| 25 mm C/2 panel | 1 inch | 25 mm |

The interface shows the mm category first, then its nearest 1/16-inch nominal reference in brackets (with a whole zero for sub-inch fractions). The table above abbreviates those references. The page explains the reference-only convention; actual sheet thickness is still usually less than nominal. The paired labels identify the same stock product; they are not statements of mathematical equality or measured thickness. In particular, 3/16 inch equals 4.7625 mm, not 5.2 mm, and 1 inch equals 25.4 mm, not 25 mm. The supplier's 5.2 mm and 25 mm numeric nominal values remain unchanged. The known 4.75 mm actual thickness of the thinnest sheet also remains separate from its labels.

Exact nominal conversions use **1 inch = 25.4 mm**. The 1/2″ panel is nominally 12.7 mm, the 3/4″ panel is nominally 19.05 mm, and 25 mm is about 0.984252 inches. The selected sheet determines the purchase price and labour markup.

Unknown actual measurements are JSON `null`, never zero and never copied from the nominal thickness. When a sheet arrives, fill both `actual_thickness.mm` and `actual_thickness.inches`, using `inches = mm / 25.4`. Repeating conversions can be recorded to 10 decimal places. Updating thickness measurements alone must not change a price.

### MDF and HDF stock

McFadden’s Ottawa account prices checked on November 13, 2026. Prices are CAD per full sheet before HST. The dimensions below are supplier specifications. Actual thicknesses await measurement.

| Stock | Purchased sheet | McFadden’s SKU | Before-tax price |
| --- | --- | --- | ---: |
| [1/4″ (6.35 mm) Arauco Standard MDF](https://mcfaddens.com/Arauco-1-4-Thick-Standard-49-x-97-FSC-MDF-Panel.html) | 49″ × 97″ | `MDFS.04G2S.32` | $26.67 |
| [1/2″ (12.7 mm) Arauco Trupan Standard MDF](https://mcfaddens.com/Arauco-Trupan-1-2-Thick-Standard-49-x-97-FSC-MDF-Panel-with-Raw-Finish.html) | 49″ × 97″ | `MDFS.08G2S.32FSC` | $45.90 |
| [3/4″ (19.05 mm) Arauco Trupan Standard MDF](https://mcfaddens.com/Arauco-Trupan-3-4-Thick-Standard-49-x-97-FSC-MDF-Panel-with-Raw-Finish.html) | 49″ × 97″ | `MDFS.12G2S.FSC32` | $63.17 |
| [1″ (25.4 mm) Arauco Trupan Standard MDF](https://mcfaddens.com/Arauco-Trupan-1-Thick-Standard-49-x-97-FSC-MDF-Panel-with-Raw-Finish.html) | 49″ × 97″ | `MDFS.16G2S.32F` | $95.78 |
| [3 mm Arauco Raw Fibrex HDF](https://mcfaddens.com/3mm-Raw-Fibrex-HDF-49-x-97-Panel.html) | 49″ × 97″ | `HD.FX02STD.32A` | $16.35 |
| [5.5 mm Arauco Raw Fibrex HDF](https://mcfaddens.com/5.5mm-Raw-Fibrex-HDF-48-x-96-Panel.html) | 48″ × 96″ | `HD.FX04STD.32` | $33.52 |

### Cut pricing

Square-foot rates include estimated HST and cover material and labour. The 10″ × 10″ examples also include the $1 per-piece charge and its HST. The full purchased area is used for the calculation, with 4,753 in² for 49″ × 97″ sheets and 4,608 in² for 48″ × 96″ sheets.

| Material | Labour markup | Area rate before HST | Area rate incl. HST | 10″ × 10″ incl. HST |
| --- | ---: | ---: | ---: | ---: |
| 5.2 mm birch | 225% | $4.08/ft² | $4.61/ft² | $4.33 |
| 1/2″ birch | 250% | $7.72/ft² | $8.73/ft² | $7.19 |
| 3/4″ birch | 275% | $8.70/ft² | $9.83/ft² | $7.96 |
| 25 mm birch | 300% | $16.66/ft² | $18.83/ft² | $14.20 |
| 1/4″ Arauco MDF | 225% | $3.95/ft² | $4.47/ft² | $4.23 |
| 1/2″ Arauco MDF | 250% | $6.56/ft² | $7.41/ft² | $6.27 |
| 3/4″ Trupan MDF | 275% | $9.25/ft² | $10.45/ft² | $8.38 |
| 1″ Trupan MDF | 300% | $14.33/ft² | $16.19/ft² | $12.37 |
| 3 mm Raw Fibrex HDF | 225% | $2.80/ft² | $3.17/ft² | $3.33 |
| 5.5 mm Raw Fibrex HDF | 225% | $4.86/ft² | $5.49/ft² | $4.95 |

At 275%, 3/4″ Trupan costs $0.62 more per square foot than 3/4″ birch because of its higher landed material cost per square foot.

## Updating the model

Edit the relevant sheet record in `materials.json`:

- `price_cents`: the owner's before-tax purchase price for one full sheet.
- `shipping_cents`: the shipping allowance allocated to that sheet; currently `1000` for every sheet.
- `labour_markup_basis_points`: the percentage of exact allocated landed material cost charged for labour.
- `sheet_size_mm`: optional purchased width and height for this sheet. If omitted, the calculation uses the catalogue’s standard sheet size. Both dimensions must cover the common cut limits.
- `actual_thickness`: the measured thickness, filled in when known.
- `display_thickness`: the nominal mm shop label used to derive the bracketed inch reference; this value must not replace the numeric supplier nominal or measured fields.

`base_price_per_piece_cents`, `display_rate_rounding`, `tax_rate_basis_points`, `sheet_size_mm`, `cut_size_limits_mm`, and `piece_size_rules` are shared settings at the root of `materials.json`. The base price is currently `100`, or $1.00 before tax per piece. `display_rate_rounding` is `"nearest_cent_per_square_foot_including_hst"` and governs the displayed estimates. If the pricing, inbound shipping, or purchase-HST recovery policy changes, update the JavaScript and this document together. Prices, shipping, labour markup, per-piece base price, tax rate, part dimensions, quantity, and sheet area drive billing; display rounding, the descriptive grade, name, link, and thickness fields do not. Size rules control eligibility and defaults without altering rates.
