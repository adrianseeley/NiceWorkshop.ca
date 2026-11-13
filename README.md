# Nice Workshop — cut orders

Node.js 24 application for custom plywood cuts, Shopify hosted checkout, and a PostgreSQL production queue. The existing framework-free storefront shares its exact cut-pricing functions with the server.

**Live checkout is enabled:** [Nice Workshop](https://www.niceworkshop.ca/). The owner authorized the switch on October 31, 2026. Shopify Payments is accepting payments with test mode off, and the application reports live mode in Heroku configuration release v24. The separate `niceworkshop-ca` app runs a Basic web dyno and Heroku Postgres Essential-0 with verified database TLS and applied migrations. Hosted test payments, failed payments, refunds, editing, cancellation, and signed synchronization passed; a fresh live checkout also displayed real card fields and the correct pickup total without submitting payment. Shopify reports payouts resuming November 4 after the earlier bank-details change; the weekly Monday schedule and automatic capture remain configured. See `OPERATIONS.md` for first-sale, handoff, and payout reconciliation follow-ups.

The site is available at **https://www.niceworkshop.ca/**. The root address **https://niceworkshop.ca/** redirects there over verified HTTPS, preserving paths and query values. DNS remains in Route 53; CloudFront handles the root redirect on its Free flat-rate plan. Existing Proton mail DNS records were preserved and checked. Shopify confirmations and both workshop Ready-email previews have been received in Proton.

Read [DEPLOYMENT.md](DEPLOYMENT.md) for the exact environment, configuration gates, backups, restore evidence, and local setup. Read [OPERATIONS.md](OPERATIONS.md) for refunds, changes, production, and year-end records. **Never deploy this project to or change Mighty Fine Orders.**

Automatic PostHog analytics is live as of November 1, 2026, in Heroku release v27. There is no banner, footer privacy link, or preference control; previously saved denials, GPC/DNT signals, and owner exclusions remain respected. Open [Nice Workshop — Visits and parts](https://us.posthog.com/project/702454/dashboard/2287933) for visits, active time, part choices, cart activity, and limited recognizable-crawler request counts. The project uses the Free plan without a payment card, with 1,000,000 analytics events/month. Browsing is not joined to paid orders, and live checkout remains enabled. See [DEPLOYMENT.md](DEPLOYMENT.md) for verification evidence and measurement limits.

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

Run `npm run build` after editing `index.template.html` or `materials.json`. It generates the checked-in `index.html`, including material and thickness cards, all three size menus, and size-limit labels. `npm start` rebuilds automatically, and Heroku runs the build during deployment. Shape changes show or hide existing controls and update the drawing and quote. `npm test` rejects stale generated HTML.

## Files

- `index.html`, `styles.css`, `app.js`, `favicon.svg`: storefront, exact pricing, cart, checkout handoff, and visual assets.
- `index.template.html`, `scripts/build-storefront.js`: editable page template and static HTML build. Edit the template instead of the generated `index.html`.
- `images/`: AI-generated hero and material sample WebPs. Replace the corresponding WebP when a workshop photo is ready.
- `nice-workshop-family.webp`: optimized, owner-approved team photo with white handwritten name labels.
- `mighty-fine-pastries.webp`: optimized official Mighty Fine Bakehouse photo for its Friends tile; source recorded in `DEPLOYMENT.md`.
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

The storefront opens with cut plywood shapes and explains pickup in Renfrew and local delivery. The builder presents wood, thickness, shape, and size in that order. The proportional drawing sits with the size controls. The cart sits alongside the builder on wider screens and below it on mobile.

The About section introduces Jacquelyn, Adrian, Ham, and Sandwich and links to the workshop email for custom projects. It sits above Friends of Nice Workshop, which starts with a photo tile for [Mighty Fine Bakehouse](https://mightyfinebakehouse.ca/).

Millimetres are the source of truth throughout the builder, preview, cart, and order summary. There is no unit switch or separate fraction selector. Every dimension dropdown option shows its mm value followed by the nearest 1/16-inch nominal reference in brackets, for example `44 mm (1 and 3/4 inches)`. Values below one inch retain the whole zero, such as `5.2 mm (0 and 3/16 inches)`. These rounded references never change the selected size or price. The page and exported summary explain this convention.

Rectangles require both sides to be at least **25 mm** and at least one side to be **100 mm** or longer. Thus 100 × 25 mm and 25 × 100 mm are valid, while 99 × 99 mm is not. Circles require a diameter of at least **100 mm**. A warning explains invalid selections and blocks Add to cart.

New dimensions use whole-millimetre dropdowns: width from 25 through 1,200 mm and length from 25 through 2,400 mm. Circle diameter has its own prebuilt dropdown from 100 through 1,200 mm. The builder starts at **100 × 100 mm**. The authoritative cut-size limits in `materials.json` are **1,200 × 2,400 mm**, including restored-cart validation. Supplier sheet dimensions are recorded separately for material-cost allocation; changing cut limits does not change prices. Width is across the grain, length follows it, and pieces are never rotated to make them fit. The preview preserves that orientation and ratio, with inward-pointing dimension arrows and a centred Grain Direction label. It is not a manufacturing nesting plan.

The builder offers birch plywood in 5.2, 12.7, 19.05, and 25 mm, MDF in ¼″, ½″, ¾″, and 1″, and Fibrex HDF in 3 and 5.5 mm. Actual thicknesses remain separate from nominal product labels. Each choice shows a sample photo and its per-piece charge and square-foot estimate, for example **$1.13 + $4.61/sq ft**, including estimated HST. For a custom shape, choose Other to email the workshop.

Matching pieces merge into one cart line. Each cart row has separate minus and plus buttons around a plain, non-editable “Qty” label, capped at 999. Decreasing a quantity of one removes the row; the Remove link also remains available. Cart counts, line prices, and totals update and persist after every change. Pickup and local drop-off remain available.

Legacy saved pieces retain their exact physical dimensions, including fractional millimetres from earlier inch selections; only their labels change to the common mm-first format. Their old unit preference is discarded. Internal dimensions remain integer ten-thousandths of a millimetre to preserve precise pricing. Saved pieces that fail current requirements are omitted with a notice. The cart works without browser storage, but persistence requires storage to be available. Prices recalculate against the current catalogue on reload.

Review the order and copy or download a plain-text estimate. When checkout is enabled, the server validates the cuts, saves an immutable snapshot, creates a Shopify draft order, and sends the browser directly to Shopify checkout without emailing an invoice. Paid Shopify notifications enter the production queue only after verification. The hosted app enables live checkout through Shopify Payments. Local drop-off is available for legal addresses whose city is Arnprior, Braeside, McNab, or Renfrew, Ontario, at $4.42 before tax (approximately $4.99 with 13% HST). The sheet's $10 inbound shipping allowance is already part of material pricing and is separate from customer delivery.

Cart items are named “Sanded Birch Plywood (Unfinished) - Rectangle” or “Sanded Birch Plywood (Unfinished) - Circle”; the order summary uses the same names. Free driveway pickup appears above Local Drop Off. The centred local-only notice states that no shipping is offered. Free driveway pickup is at 1019 Castleford Road, Renfrew, ON K7V 3Z8. The current lead time is 14 days and is saved with each checkout snapshot. Shopify confirmation emails and both workshop Ready-email previews have been received and verified. The separate staff Ready action is deployed. Native pickup is deployed and verified through a fresh paid test checkout and signed order synchronization. For pickup, customers enter only their own billing address; pickup remains free. Actual collection or delivery must be recorded separately from payment, cutting, and the Ready email.

## Editing prices and measurements

Edit `materials.json`, run `npm run build`, then refresh the page. Deploy the regenerated HTML and catalogue together. Monetary fields use **whole cents: 100 units per dollar** (`1000` means $10.00 and `2670` means $26.70). Leave unmeasured actual thicknesses as `null`; do not use nominal thickness as a substitute. Read `PRICING.md` before changing the calculation or shipping convention.

Every piece costs **$1.00 before HST plus its area price**. The shared `base_price_per_piece_cents` setting is `100`, and the base charge multiplies by quantity: twenty pieces add $20.00 before HST, or $22.60 including HST.

Set each orderable sheet's `labour_markup_basis_points` by thickness. The rates are **225%** for thin stock, **250%** for about 1/2″, **275%** for 3/4″, and **300%** for about 1″. The markup is applied to exact allocated landed cost, including purchase HST and the inbound allowance. Each sheet can specify its purchased dimensions in `sheet_size_mm` for area pricing. The shared cut-size limits still apply.

The `display_rate_rounding` setting is `nearest_cent_per_square_foot_including_hst`. Each square-foot rate is a display estimate. The quote rounds material and labour separately for each cut group, adds the $1 per-piece charge before HST, and estimates HST on the combined cart subtotal. Shopify calculates final tax at checkout. For 25 mm birch, the estimated total is **$4.40** for a 5-inch circle and **$14.20** for a 10-inch circle.

## Checks

Run `npm test` for the full test suite. PostgreSQL integration suites run when `TEST_DATABASE_URL` is provided and otherwise explicitly skip. To create a disposable loopback-only PostgreSQL cluster using an existing PostgreSQL binary directory:

```sh
NICE_TEST_POSTGRES_BIN=/absolute/path/to/postgresql/bin scripts/test-db-local.sh app.test.js test/*.test.js
```

The helper stops and removes its own temporary cluster and never starts a system service. Tests cover pricing boundaries and tampering, checkout races and uncertain outcomes, certificate verification, staff authorization, signed webhook handling, duplicate/out-of-order events, refund/cancellation/test-order holds, immutable snapshots, and audited cutting transitions. Passing local tests does not replace actual Shopify test payments and webhook verification; see the launch checklist in `OPERATIONS.md`.
