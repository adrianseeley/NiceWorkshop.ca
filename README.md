# Nice Workshop — cut orders

Node.js 24 application for custom plywood cuts, Shopify hosted checkout, and a PostgreSQL production queue. The existing framework-free storefront shares its exact cut-pricing functions with the server.

**Live checkout is enabled:** [Nice Workshop](https://www.niceworkshop.ca/). The owner authorized the switch on October 31, 2026. Shopify Payments is accepting payments with test mode off, and the application reports live mode in Heroku configuration release v24. The separate `niceworkshop-ca` app runs a Basic web dyno and Heroku Postgres Essential-0 with verified database TLS and applied migrations. Hosted test payments, failed payments, refunds, editing, cancellation, and signed synchronization passed; a fresh live checkout also displayed real card fields and the correct pickup total without submitting payment. Shopify reports payouts resuming November 4 after the earlier bank-details change; the weekly Monday schedule and automatic capture remain configured. See `OPERATIONS.md` for first-sale, handoff, and payout reconciliation follow-ups.

The site is available at **https://www.niceworkshop.ca/**. The root address **https://niceworkshop.ca/** redirects there over verified HTTPS, preserving paths and query values. DNS remains in Route 53; CloudFront handles the root redirect on its Free flat-rate plan. Existing Proton mail DNS records were preserved and checked. Shopify confirmations and both workshop Ready-email previews have been received in Proton.

Read [DEPLOYMENT.md](DEPLOYMENT.md) for the exact environment, configuration gates, backups, restore evidence, and local setup. Read [OPERATIONS.md](OPERATIONS.md) for refunds, changes, production, and year-end records. **Never deploy this project to or change Mighty Fine Orders.**

## Run locally

Install Node.js 24 and project dependencies, then start the server:

```sh
npm ci
npm start
```

Open [the local app](http://localhost:3000). Without database and Shopify configuration the storefront remains an estimate builder and checkout stays closed. `npm start` reads exported environment variables; it does not automatically load `.env`. To use an ignored local configuration file copied from `.env.example`, run:

```sh
node --env-file=.env server/index.js
```

The [staff page](http://localhost:3000/staff) uses a server-configured access key. The generated local owner key is in `.private/admin-access-key.txt`; never copy its contents into documentation, source control, screenshots, or customer pages.

A static-only preview still works with `python3 -m http.server 4173 --bind 127.0.0.1`, but it cannot provide checkout or staff functions. Use a local server rather than opening `index.html` directly so the JSON catalogues can load.

## Files

- `index.html`, `styles.css`, `app.js`, `favicon.svg`: storefront, exact pricing, cart, checkout handoff, and visual assets.
- `materials.json`: trusted sheet catalogue, source costs, prices, measurements, and cut-size rules.
- `business.json`: owner-approved public business/tax registration information. This file is intentionally served publicly; never add private account documents or credentials.
- `server/`: HTTP application, server-side validation, Shopify client, checkout idempotency, webhook verification/processing, and database access.
- `db/migrations/`: versioned PostgreSQL schema and immutable order snapshots.
- `staff.html`, `staff.js`: protected order queue and whole-order cutting status.
- `scripts/`: migrations, webhook processing, disposable local database test helper, and the CloudFront root-domain redirect function.
- `PRICING.md`, `OPERATIONS.md`, `DEPLOYMENT.md`: pricing policy, business procedures, and deployment/recovery instructions.
- `test/` and `app.test.js`: pricing, checkout, security, database, and synchronization tests.
- `.env.example`: configuration names without secrets. `.env`, `.private/`, `tmp/`, and `node_modules/` are ignored.
- The four supplied PNG files remain as design references.

## What works

The visual design pairs warm ivory surfaces and deep olive controls with serif product and cart headings. The footer reads **NICE.** in heavy, upright type. The cart sits alongside the builder on wider screens and below it on mobile. A centred proportional preview appears above the configuration controls. Below it, wide screens show thickness choices alongside shape and dimension dropdowns; smaller screens stack the controls.

Millimetres are the source of truth throughout the builder, preview, cart, and order summary. There is no unit switch or separate fraction selector. Every dimension dropdown option shows its mm value followed by the nearest 1/16-inch nominal reference in brackets, for example `44 mm (1 and 3/4 inches)`. Values below one inch retain the whole zero, such as `5.2 mm (0 and 3/16 inches)`. These rounded references never change the selected size or price. The page and exported summary explain this convention.

Rectangles require both sides to be at least **25 mm** and at least one side to be **100 mm** or longer. Thus 100 × 25 mm and 25 × 100 mm are valid, while 99 × 99 mm is not. Circles require a diameter of at least **100 mm**. A warning explains invalid selections and blocks Add to cart.

New dimensions use whole-millimetre dropdowns: width from 25 through 1,200 mm and length from 25 through 2,400 mm. Circle diameter uses the width control and is subject to the 100 mm minimum. The builder starts at **100 × 100 mm**. The authoritative cut-size limits in `materials.json` are **1,200 × 2,400 mm**, including restored-cart validation. Supplier sheet dimensions are recorded separately for material-cost allocation; changing cut limits does not change prices. Width is across the grain, length follows it, and pieces are never rotated to make them fit. The preview preserves that orientation and ratio, with inward-pointing dimension arrows and a centred Grain Direction label. It is not a manufacturing nesting plan.

Thickness choices show 5.2, 12.7, 19.05, and 25 mm, each with its derived nominal inch reference. They use visible radio indicators and illustrative alternating veneer layers, which do not specify a ply count. Actual thicknesses remain separate from nominal product labels. Each choice shows its base charge and area estimate, for example **$1 + $0.05 /sq in**. Area rates retain the workshop's per-square-inch pricing convention; they include HST and round upward to whole cents for display only. The $1 base is before HST.

Matching pieces merge into one cart line. Each cart row has separate minus and plus buttons around a plain, non-editable “Qty” label, capped at 999. Decreasing a quantity of one removes the row; the Remove link also remains available. Cart counts, line prices, and totals update and persist after every change. Pickup and local drop-off remain available.

Legacy saved pieces retain their exact physical dimensions, including fractional millimetres from earlier inch selections; only their labels change to the common mm-first format. Their old unit preference is discarded. Internal dimensions remain integer ten-thousandths of a millimetre to preserve precise pricing. Saved pieces that fail current requirements are omitted with a notice. The cart works without browser storage, but persistence requires storage to be available. Prices recalculate against the current catalogue on reload.

Review the order and copy or download a plain-text estimate. When checkout is enabled, the server validates the cuts, saves an immutable snapshot, creates a Shopify draft order, and sends the browser directly to Shopify checkout without emailing an invoice. Paid Shopify notifications enter the production queue only after verification. The hosted app enables live checkout through Shopify Payments. Local drop-off is available for legal addresses whose city is Arnprior, Braeside, McNab, or Renfrew, Ontario, at $4.42 before tax (approximately $4.99 with 13% HST). The sheet's $10 inbound shipping allowance is already part of material pricing and is separate from customer delivery.

Cart items are named “Sanded Birch Plywood (Unfinished) - Rectangle” or “Sanded Birch Plywood (Unfinished) - Circle”; the order summary uses the same names. Shop Pickup and Local Drop Off choices appear side by side on desktop and stack on mobile. The centred local-only notice states that no shipping is offered. Free driveway pickup is at 1019 Castleford Road, Renfrew, ON K7V 3Z8. The current lead time is 14 days and is saved with each checkout snapshot. Shopify confirmation emails and both workshop Ready-email previews have been received and verified. The separate staff Ready action is deployed. Native pickup is deployed and verified through a fresh paid test checkout and signed order synchronization. For pickup, customers enter only their own billing address; pickup remains free. Actual collection or delivery must be recorded separately from payment, cutting, and the Ready email.

## Editing prices and measurements

Edit `materials.json`, then refresh the page. Monetary fields use **whole cents: 100 units per dollar** (`1000` means $10.00 and `2670` means $26.70). Leave unmeasured actual thicknesses as `null`; do not use nominal thickness as a substitute. Read `PRICING.md` before changing the calculation or shipping convention.

Every piece costs **$1.00 before HST plus its area price**. The shared `base_price_per_piece_cents` setting is `100`, and the base charge multiplies by quantity: twenty pieces add $20.00 before HST, or $22.60 including HST.

The `display_rate_rounding` setting is `up_to_whole_cent_including_hst`. The purchase cost, purchase HST, shipping allowance, contribution, and customer HST determine an unrounded area rate. For display only, that rate is rounded upward to a whole cent and shown in dollars: **$0.05, $0.07, $0.09, and $0.12 per square inch, including HST**. These are simplified estimates, not the rates multiplied by customer area. Every thickness option places the $1 base charge alongside its displayed rate. The original exact material and workshop contribution calculations determine the actual price.

The page uses exact integer/rational arithmetic for money, rounds material and contribution to cents for each configured quantity, adds the exact per-piece base charge, and estimates the cart's HST once on its combined taxable subtotal. Shopify calculates final tax at checkout; its rounding can differ by a few cents. The base charge including HST is $1.13 per piece. Cart and order line prices are shown before HST; the configurator's complete price and cart total include estimated HST. For example, a 5-inch circle in 25 mm stock still costs **$3.92**, and a 10-inch circle costs **$12.31**. The rounded display estimates never replace those calculations.

## Checks

Run `npm test` for the full test suite. PostgreSQL integration suites run when `TEST_DATABASE_URL` is provided and otherwise explicitly skip. To create a disposable loopback-only PostgreSQL cluster using an existing PostgreSQL binary directory:

```sh
NICE_TEST_POSTGRES_BIN=/absolute/path/to/postgresql/bin scripts/test-db-local.sh app.test.js test/*.test.js
```

The helper stops and removes its own temporary cluster and never starts a system service. Tests cover pricing boundaries and tampering, checkout races and uncertain outcomes, certificate verification, staff authorization, signed webhook handling, duplicate/out-of-order events, refund/cancellation/test-order holds, immutable snapshots, and audited cutting transitions. Passing local tests does not replace actual Shopify test payments and webhook verification; see the launch checklist in `OPERATIONS.md`.
