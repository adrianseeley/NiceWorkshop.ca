# Nice Workshop — first pass

A responsive birch plywood order builder based on the supplied desktop and mobile concepts. The implementation has one HTML file, one JavaScript file, and one CSS file, with no framework or build step.

## Preview

From this folder, run:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Then open [the local preview](http://127.0.0.1:4173). Use a local server rather than double-clicking `index.html`: the browser needs to fetch the separate JSON catalogue.

## Files

- `index.html`: accessible page structure and original SVG plywood illustrations.
- `styles.css`: warm birch colour palette, mobile layout, and desktop layout.
- `app.js`: dimension controls, exact pricing arithmetic, cart, and order summary.
- `materials.json`: sheet records, supplier links, prices, shipping, contribution rates, per-piece base price, and thickness measurements.
- `PRICING.md`: complete pricing policy, rounding rules, editable assumptions, and worked example.
- The four supplied PNG files remain as design references.

## What works

The inches/mm toggle sits in the top-right corner of the product panel. A centred proportional preview appears above the configuration controls, in the product-photo position. Below it, desktop shows thickness choices alongside a shape dropdown and width/length selectors; mobile stacks those controls. The separate Size heading is omitted. Thickness choices use consistent written fractions (`3/16`, `1/2`, `3/4`) and illustrative profiles of alternating light and dark veneer layers. Each choice shows its base charge and area price together, for example **$1 + $0.05 /sq in**. Displayed area rates include HST and are rounded up to whole cents for readability; they are estimates, never inputs to the price calculation. The $1 per-piece base is before HST. The preview has no contrasting panel or caption. Its dimension arrows point inward along their lines, and a centred Grain Direction label marks the face-grain orientation. The header includes the workshop help email beneath the lead time. The pricing and measurement policies are documented here and in `PRICING.md`.

Choose circles or rectangles, thickness, dimensions, and quantity. Every side must be at least 1 inch, and at least one side must be 5 inches or longer; a 5 × 1 inch rectangle is therefore valid, while 4 × 4 inches is not. Circle diameter must be at least 5 inches. A warning below the dimensions explains any smaller selection and blocks Add to cart.

Imperial dimensions use whole-inch dropdowns with a separate fraction dropdown in sixteenth-inch steps. Width offers whole values from 1 through 48; length offers 1 through 96. A fraction cannot take either dimension above its maximum. Metric dimensions use whole-millimetre dropdowns: width from 26 through 1,219 mm and length from 26 through 2,438 mm, with at least one side measuring 127 mm or more. The 26 mm minimum rounds 1 inch upward to a selectable whole millimetre; the maxima round 48 and 96 inches downward. Circles use one diameter control and must measure at least 127 mm, with a maximum of 1,219 mm.

The builder starts at 5 × 5 inches. Switching to millimetres resets width and length to 127 × 127 mm; switching to inches resets them to 5 × 5 inches. For a circle, the diameter resets to 127 mm or 5 inches respectively. Choose the desired size after switching units. Dimensions use integer ten-thousandths of a millimetre internally for precise area calculations; that internal precision does not add decimal options to the dropdowns. These minimum and default sizes are recorded in `piece_size_rules` in `materials.json`.

Width is across the sheet, with a fixed maximum of 48 inches. Length follows the face grain, with a fixed maximum of 96 inches. Pieces are not rotated to make them fit. The top-down diagram preserves the selected width-to-length ratio, with width horizontal, length vertical, and face grain running along the length. It is a proportional preview, not a full-size drawing or a manufacturing nesting plan. Any plywood edge layers shown are illustrative; they do not specify an exact ply count.

Thickness choices use the shop's nominal categories: 3/16, 1/2, 3/4, and 1 inch in imperial mode; 5.2, 12.7, 19.05, and 25 mm in metric mode. These are product-selection labels, not a promise of measured thickness or exact equivalence between each pair. The catalogue retains the supplier's exact nominal measurements separately, along with actual measurements when known. Actual sheet thickness is usually less than the nominal category; check the measured value when thickness matters.

Add multiple configurations to the cart, remove them, and select pickup or local drop-off. Matching pieces merge into one line. Each cart selection keeps its original dimensions and chosen unit; changing the builder's units resets only the current selection, without resizing or relabelling pieces already in the cart. Older saved selections without a recorded unit are labelled in inches. When an old cart is restored, pieces below the current minimum size are excluded and a notice explains their removal. The cart saves on this browser when local storage is available and recalculates against the current catalogue when reloaded. Prices and rounded area rates are generated from `materials.json`. Cutting, light edge cleanup, and a little love are all included in the price.

Review the order and copy or download a plain-text summary. This first pass does not submit an order, take payment, send email, or reserve production time. A payment/order service can be connected later. Local drop-off covers Renfrew, Arnprior, and nearby locations, with arrangements and any fee still to be confirmed; no customer delivery charge is currently calculated. The sheet's $10 inbound shipping allowance is already part of material pricing.

Cart items are named “Sanded Birch Plywood (Unfinished) - Rectangle” or “Sanded Birch Plywood (Unfinished) - Circle”; the order summary uses the same names. Shop Pickup and Local Drop Off choices appear side by side on desktop and stack on mobile. The centred local-only notice states that no shipping is offered. Pickup copy points to the Horton Community Center and says the customer will receive an email with the details; sending that email belongs to the future order service, since this static first pass does not send email. The current lead time is 14 days.

## Editing prices and measurements

Edit `materials.json`, then refresh the page. Monetary fields use **whole cents: 100 units per dollar** (`1000` means $10.00 and `2670` means $26.70). Leave unmeasured actual thicknesses as `null`; do not use nominal thickness as a substitute. Read `PRICING.md` before changing the calculation or shipping convention.

Every piece costs **$1.00 before HST plus its area price**. The shared `base_price_per_piece_cents` setting is `100`, and the base charge multiplies by quantity: twenty pieces add $20.00 before HST, or $22.60 including HST.

The `display_rate_rounding` setting is `up_to_whole_cent_including_hst`. The purchase cost, purchase HST, shipping allowance, contribution, and customer HST determine an unrounded area rate. For display only, that rate is rounded upward to a whole cent and shown in dollars: **$0.05, $0.07, $0.09, and $0.12 per square inch, including HST**. These are simplified estimates, not the rates multiplied by customer area. Every thickness option places the $1 base charge alongside its displayed rate. The original exact material and workshop contribution calculations determine the actual price.

The page uses exact integer/rational arithmetic for money, rounds material and contribution to cents for each configured quantity, adds the exact per-piece base charge, and calculates the cart's HST once on its combined subtotal. The base charge including HST is $1.13 per piece. Cart and order line prices are shown before HST; the configurator's complete price and cart total include HST. For example, a 5-inch circle in 25 mm stock still costs **$3.92**, and a 10-inch circle costs **$12.31**. The rounded display estimates never replace those calculations.
