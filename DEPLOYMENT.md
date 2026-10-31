# Nice Workshop deployment and recovery

Verified October 31, 2026. This document records the running environment and the checks already completed. [OPERATIONS.md](OPERATIONS.md) covers business procedures; [PRICING.md](PRICING.md) covers pricing. **Every Heroku command for this project must explicitly target `niceworkshop-ca`. Never use Mighty Fine Orders or its database.**

## Current environment

| Component | Verified value |
| --- | --- |
| Public app | https://www.niceworkshop.ca/ |
| Staff page | https://www.niceworkshop.ca/staff |
| Heroku app | `niceworkshop-ca` |
| Last code deployment | **v22**, Heroku deployment commit `748461d`, from source `abb3e76`; schema current. Pickup review explicitly tells customers to wait for the Ready email. Native pickup verified in v20 through fresh application order #1004 |
| Live configuration release | **v24**, October 31, 2026; Shopify Payments accepts payments with test mode off, and public checkout reports `mode: live` |
| Region / stack | `us` / `heroku-24` |
| Runtime | Node.js 24; one always-on Basic web dyno |
| Database | Separate Heroku Postgres Essential-0 |
| Approved baseline cost | US$7/month web + US$5/month database = US$12/month, excluding tax, currency conversion, and any additional usage/add-ons |
| Shopify store | Nice Workshop — `waj4za-5t.myshopify.com` |
| Installed Shopify app | Nice Workshop Orders; app ID `442209927169`, organization `236066190` |
| App permissions | Installed and verified: `read_orders`, `write_draft_orders`, `read_locations`, `read_merchant_managed_fulfillment_orders` |
| Customer service | `hello@niceworkshop.ca` |
| Canonical domain | `www.niceworkshop.ca`; verified HTTPS and root-domain redirect with path/query preservation |

**Live checkout is enabled following the owner's explicit authorization on October 31, 2026.** Shopify Payments displays **Accepting payments**, and its test-mode checkbox is off. The website is configured for live checkout. Shopify displays **Payouts pending** until **November 4, 2026** following the owner's earlier bank-details update; CAD and the existing **Weekly on Monday** payout schedule remain configured. The saved capture method is **Automatically at checkout**. The server's Shopify credentials, four webhook subscriptions, active HST registration, and saved Canada tax collection were verified. Prior pickup/delivery payments, partial/full refunds, an order edit, cancellation, and failed-payment scenarios all completed in test mode, with the expected synchronization and production holds. Those historical tests did not move real money or establish live settlement. First-live-sale/payout reconciliation, refund-notice receipt, and actual handoff remain operational follow-ups.

After release `v11`, the following safe public checks returned HTTP 200: `/healthz` reported `ok`, `/readyz` reported `ready`, and `/api/config` reported `checkoutEnabled: true`, `mode: test`. The readiness endpoint confirms database connectivity; it does not validate Shopify configuration or tax settings.

After the domain setup, `https://www.niceworkshop.ca/` returned HTTP 200, `/readyz` reported `ready`, and `/api/config` reported `checkoutEnabled: true`, `mode: test`. The original Heroku `/healthz` still returned HTTP 200 with `ok`. Domain setup did not change payment mode.

## Configuration and secrets

Store runtime secrets in this app's Heroku configuration, never in source files or browser code. The local owner access key is in `.private/admin-access-key.txt`. `.private/`, `.env`, `tmp/`, and `node_modules/` are excluded from source control and deployment packaging. The staff key stays in browser memory for the current page; do not put it in a URL.

`business.json` is intentionally public at the owner's request. It contains approved business/tax registration and reporting information, not credentials. Its annual GST/HST reporting record uses a December 31 year-end and shows a June 15, 2027 filing due date; that date is **not** confirmation of a payment deadline. Never add CRA login information, private account screenshots, banking data, or customer records to this public file.

| Variable | Purpose / current gate |
| --- | --- |
| `DATABASE_URL` | Heroku-managed connection string for this app only; never print or copy it into documentation |
| `DATABASE_CA_FILE` | `/usr/lib/ssl/certs/ca-certificates.crt` on Heroku |
| `DATABASE_CA_CERT` | Optional PEM certificate bundle for another environment; keep TLS verification enabled |
| `SHOPIFY_SHOP_DOMAIN` | `waj4za-5t.myshopify.com` |
| `SHOPIFY_API_VERSION` | `2026-10` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Installed app credentials; server obtains and renews its access token |
| `SHOPIFY_WEBHOOK_SECRET` | Signing secret corresponding to the installed app's subscriptions |
| `ADMIN_API_TOKEN` | Long random staff access key |
| `PUBLIC_ORIGIN` | `https://www.niceworkshop.ca` without a trailing slash, set in release `v13` |
| `CHECKOUT_ENABLED` | `true` for owner-authorized live checkout |
| `CHECKOUT_MODE` | `live` |
| `SHOPIFY_TEST_MODE_CONFIRMED` | `false`; Shopify Payments test mode is off |
| `HST_REGISTRATION_CONFIRMED` | Currently `true`; active registration and saved Canada collection verified |
| `LIVE_CHECKOUT_VERIFIED` | `true` after owner-authorized activation and live configuration verification; this does not assert that a real sale or payout has already settled |

The deployed Ready-email implementation also uses `EMAIL_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM`, and `EMAIL_REPLY_TO`. **SMTP connection and preview delivery are verified:** exactly two previews were accepted and both received in Proton, from and to `hello@niceworkshop.ca`. Nonsecret settings were prepared in release `v16`, and the owner subsequently saved `SMTP_PASSWORD` directly in Heroku. Defaults are `smtp.protonmail.ch`, submission port 587, and sender/reply address `hello@niceworkshop.ca`. The sender requires dedicated credentials, STARTTLS, and a verified server certificate. Keep credentials in Heroku configuration or an ignored local environment file; never copy them into documentation, screenshots, or logs. Shopify sender authentication does not configure these application credentials.

Checkout requires an enabled flag, a database, a configured Shopify client, a public origin, and the relevant mode confirmations. `test` mode requires confirmed provider test mode. `live` mode requires confirmed HST registration and completed live-readiness verification. These flags do not themselves enable or disable Shopify's gateway; verify the provider state separately. To close website checkout creation immediately, set `CHECKOUT_ENABLED=false` on `niceworkshop-ca` and verify `/api/config` reports checkout disabled. Existing Shopify draft checkout links are independent of this flag and can remain payable; resolve them separately when needed. During a test-to-live transition, retire confirmed unpaid test drafts while retaining paid test orders and their audit history.

The database connection verifies the certificate chain and server hostname. Heroku Essential/Advanced databases use AWS RDS certificates; Heroku's stack includes the required CA bundle. For external local checks, download the [official AWS RDS global bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) and set `DATABASE_CA_FILE` to its path. Do not fix certificate errors by disabling verification. An actual authenticated connection to this database was verified with `authorized=true`, TLS 1.3, and a successful `SELECT 1`. [Heroku certificate instructions](https://devcenter.heroku.com/articles/connecting-heroku-postgres).

## Deployments and migrations

The `Procfile` runs `npm run db:migrate` as the release command and `npm start` as the web process. Migrations use a transaction, advisory lock, and checksums; an applied migration must never be edited in place. Add a new numbered migration for a schema change. Both `001_initial.sql` and `002_checkout_metadata.sql` are applied.

`003_ready_notifications.sql` was **applied in production with release v18**. It adds readiness fields and a durable notification queue with immutable message snapshots. All three migrations are now applied; the earlier backup evidence below remains a record of its original two-migration capture.

Before deploying, run the complete local test suite with a disposable PostgreSQL database and inspect the source package. Exclude `.env`, `.private/`, backup files, and test data. Preserve the repository's existing storefront edits. Deploy only the explicitly identified Nice Workshop app, then verify the release succeeded, `/healthz`, `/readyz`, `/api/config`, and the staff page. Check that checkout remained in its intended mode.

Heroku release rollback changes application code; it does not undo committed database migrations. Keep migrations compatible with rollback where possible. Review a database restoration separately rather than treating code rollback as database recovery.

The web process polls the durable webhook inbox every three seconds. HMAC verification and database persistence happen before the HTTP acknowledgement. Processing verifies the order against its immutable cut/price/fulfillment snapshot, deduplicates repeated events, and holds edited, refunded, cancelled, mismatched, or test orders. Test purchases are never eligible for actual cutting. The independent `scripts/process-webhooks.js` entry point can run a bounded processing batch for recovery; it reports counts rather than customer payloads.

The installed app is registered for `orders/paid`, `orders/updated`, `orders/cancelled`, and `refunds/create` at `https://niceworkshop-ca-b8d9f27f02c2.herokuapp.com/api/webhooks/shopify`. Actual signed payment events were persisted and processed for both test orders below. Do not expose a manually constructed unsigned event endpoint or treat a browser return as payment confirmation.

## Ready emails and sender authentication

The workflow was introduced from source `9b3b055` in release **v18** and is retained in **v20**, with migration 003 applied and SMTP preview delivery verified. `POST /api/admin/orders/:orderId/ready` accepts `expectedRevision` and requires an explicit staff click. It verifies a paid, fully cut, unheld, unrefunded, uncancelled order against Shopify, then records readiness and one email snapshot in a transaction. Repeated requests return the existing notification. The staff API cannot override the recipient or body. Marking an order cut does not send an email.

The existing web process handles queued messages after its webhook batch every three seconds, without another dyno. It rechecks the order and recipient before submission. Reopening cutting or a disqualifying order update clears readiness and cancels queued messages; submissions already in progress are held for review. A sending record older than ten minutes becomes `needs_review`, never an automatic resend. `sent` means SMTP acceptance, **not inbox delivery**. Failed or uncertain results require reconciliation; there is no resend button.

Pickup and drop-off templates use **Monday–Friday, 9am–7pm Toronto time**. Pickup identifies the driveway box and confirmed workshop address; drop-off promises a separate email confirming the particular time. Replies go to `hello@niceworkshop.ca`. Until the sender is connected, the UI disables Ready and displays **Email sending isn’t connected yet**. Existing test orders stay blocked regardless of email setup.

Generate local previews with `node scripts/send-email-previews.js`; it writes HTML/plain text to ignored `output/email-previews/` without sending. After checking the saved SMTP configuration, `node scripts/send-email-previews.js --send` submits exactly two clearly labelled test previews to `hello@niceworkshop.ca`. Inspect its receipt file and mailbox before repeating an uncertain attempt. SMTP acceptance and actual inbox receipt must be verified separately. The completed run reported **two accepted previews**, and **both were received in Proton**, from and to `hello@niceworkshop.ca`. The pickup body was checked. No production order was marked ready by this preview run.

Six Shopify sender-authentication CNAMEs were added to Route 53, leaving all existing DNS records unchanged. Shopify now displays **Authenticated**; the private evidence is `.private/email-proof/shopify-sender-authenticated.png`. Retain these records alongside the existing Proton records. This authentication covers Shopify's sender and does not establish an SMTP connection for the workshop app. The owner saved the dedicated SMTP password, and separate application SMTP tests subsequently verified acceptance and receipt of both previews. Shopify sender authentication and application SMTP are independent checks.

The Shopify order-confirmation template was saved through Shopify admin and its preview rendered successfully. The full template is tracked in `shopify/notifications/order-confirmation.liquid`; its custom introduction is also kept in `shopify/notifications/order-confirmation-intro.liquid`. An explicit Shopify test send was then **received at hello@niceworkshop.ca in Proton**, with sender/recipient fields and rendered body verified. Actual paid test orders **#1003** and **#1004** also produced confirmations received at `hello@niceworkshop.ca`. The #1004 sender/recipient and rendered pickup branch were verified: driveway box, correct address, weekday hours, and 14-day lead time. Shopify’s saved email accent is **#3D513E**, matching the storefront. Application SMTP was verified separately with the two previews above; refund-notice receipt remains unverified.

A final staff refresh showed **three local orders** and **Ready emails are connected**. #1004 displayed paid in full with a test-order hold; both its **Cut** and **Ready** buttons were disabled. The two earlier refunded test orders remained blocked as well.

## Native pickup implementation and verification

Native pickup is deployed in **v20**, Heroku commit `d6dc38e`, from source `64ac888`, with the schema current. Shopify pickup is configured at workshop location **94464344279**. The owner-approved scopes **`read_locations`** and **`read_merchant_managed_fulfillment_orders`** are installed and verified; the active app version is **2026-10-31-pickup-location**.

New pickup drafts use the native pickup option and `shippingAddress: {countryCode: 'CA'}` to supply country context. Shopify did not retain the native pickup rate when the country was omitted. No street, customer name, or billing address is seeded by that payload. The tested checkout shows no shipping-address form and asks the customer to enter their own billing address. The paid order's `shipping_address` is null; the runtime client independently verifies `PICK_UP` and the assigned workshop location before accepting it. Legacy checkout snapshots retain their original validation rules.

The owner approved using only the billing address as the backup address. Confirm it with the customer before any later change to delivery, including eligibility and charges; free pickup remains selected until a change is agreed.

The fresh v20 application checkout was verified end to end:

| Record | Verified result |
| --- | --- |
| Shopify order | **#1004**, ID `18898869944535` |
| Draft / checkout attempt | Draft `1619907018967`; attempt `b454e3fb-09dc-4337-8a71-5b461a93bc32` |
| Local order | `ce3ecb65-b0a7-451b-ae6a-865c0b7fd39f` |
| Saved cuts | One 100 mm circle in 25 mm birch, quantity one |
| Checkout | No shipping-address form; blank own-billing form completed with a Quebec test address |
| Amount | $2.54 before tax + **$0.33 HST** = **$2.87**, paid through the Test payment gateway |
| Signed events | `orders/updated` and `orders/paid` processed once each, without errors |
| Stored state | Paid, hold **only `test_order`**, `is_cut=false`, `ready_at=null`; original cut snapshot preserved |
| Native proof | Runtime pickup/location verification returned `valid: true`; Shopify `shipping_address` was null |
| Confirmation | Received in Proton from/to `hello@niceworkshop.ca`; correct pickup address/box, weekday hours, 14-day lead time, and green branding |

Earlier test evidence is retained separately. D6/#1003 proved native pickup with Quebec billing, 13% HST, and a $57.40 test total. After v19, unpaid D7 (`1619905970391`, request key `d3c0a697-93df-4b6e-947c-ed9a404b239b`) was quarantined for reconciliation when Shopify did not preserve the pickup option; it took no payment and sent no invoice email. Do not reuse that uncertain attempt. The isolated country-context validation draft D8 (`1619906756823`) was unpaid; D7 and D8 were subsequently retired during the authorized live launch. The corrected v20 result above is the completed application checkout proof. No real money moved in these tests.

## Local development and tests

Use Node.js 24 and `npm ci`. `npm start` consumes exported environment variables. For an ignored `.env` file based on `.env.example`, use `node --env-file=.env server/index.js`; run local migrations with `node --env-file=.env scripts/migrate.js` only after verifying that its database is the intended development database. `DATABASE_SSL=disable` is accepted only for loopback databases; remote databases require verified TLS.

`npm test` runs all unit and HTTP tests and explicitly skips real PostgreSQL suites when `TEST_DATABASE_URL` is absent. For complete verification, either supply a dedicated test database or use the temporary-cluster helper:

```sh
NICE_TEST_POSTGRES_BIN=/absolute/path/to/postgresql/bin scripts/test-db-local.sh app.test.js test/*.test.js
```

The supplied directory must contain `postgres`, `initdb`, and `pg_ctl`. The helper binds a fresh cluster to loopback on an available port, creates a disposable database, runs tests, and stops/removes that cluster. It never starts or changes a system PostgreSQL service. Each database test suite uses its own generated schema.

Release **v21** removes the owner-requested statutory-rights sentence from the checkout checkbox and records wording version `2026-10-31.2`. It adds no billing-province restriction. All 16 focused storefront/HTTP checks passed after this wording revision.

Latest complete local run: **116/116 tests passed**, including actual PostgreSQL integration tests and the native-pickup changes. The corrected native-pickup implementation is deployed in v20 and its fresh application checkout is verified. Ready and SMTP preview delivery were verified separately. The earlier deployment was verified with 74 tests and the focused domain tests recorded below. Tests include exact price calculations, invalid/tampered cuts, checkout races and uncertain external outcomes, staff authorization, HTTPS enforcement, webhook signature checks, out-of-order/refund/cancellation events, permanent test-order holds, database constraints, immutable snapshots, and atomic cutting/audit transitions. Live provider checks remain separate from these local results.

## Verified Shopify test payments

Both successful orders used the official test gateway, with a circle and rectangle represented as two cut groups containing three physical pieces. Each produced exactly one matching local order with the correct saved cuts. Their only production hold at initial import was `test_order`.

| Test | Shopify order | Cut subtotal | Delivery before tax | HST | Total |
| --- | --- | --- | --- | --- | --- |
| Free driveway pickup | #1001 | $7.29 | $0.00 | $0.95 | $8.24 |
| Eligible local delivery | #1002 | $7.29 | $4.42 | $1.52 | $13.23 |

An attempt to mark a test order cut returned HTTP 409, as intended. The gateway's failed-card scenario (`2`) and gateway-error scenario (`3`) did not create paid orders. Test payment success did not itself activate live card processing; Shopify Payments was activated separately under the owner's later explicit request.

Actual adjustment tests also passed:

- **Pickup #1001:** refunded $2.10 first, then the remaining $6.14, for a full $8.24 test refund. Shopify and the local order recorded the resulting refunded state correctly.
- **Delivery #1002 — edit:** intentionally changed the circle bundle's Shopify quantity to two. The Shopify order total became $15.33 against $13.23 already paid, leaving $2.10 outstanding. The local order became `partially_paid`, retained its original cut snapshot, and stayed on hold for the mismatch; the changed Shopify quantity did not silently rewrite production cuts.
- **Delivery #1002 — cancellation:** cancelled the edited order and refunded the full $13.23 actually paid. Shopify displayed cancelled/refunded; the local record was refunded and cancelled, retained its original three pieces, and remained uncut.

The application checks and hosted test-gateway scenarios above are complete. Remaining work is refund-notice and actual handoff confirmation, payment/payout export access, and reconciliation after the first live sale/payout. The Shopify order-confirmation test has been received and verified. The owner subsequently authorized live activation; the remaining items are operational follow-ups, not evidence that a real payment or payout has already been reconciled. The Taxes and Total sales by order screens and export controls were also verified in this store; both showed no data for the selected test-only period. No export file was produced, and payment/payout export access remains unverified.

## Backups and restore evidence

Heroku PGBackups is scheduled daily at **03:00 America/Toronto** for the Nice Workshop database. Inspect backup success and retention regularly; a schedule alone is not proof of a successful backup. Preserve separate accounting exports according to the operations manual. [Heroku PGBackups](https://devcenter.heroku.com/articles/heroku-postgres-backups).

Initial backup **b002** proved schema-only recovery. A fresh populated backup **b003** was then captured from `niceworkshop-ca`, downloaded privately, and restored on October 31, 2026 into a new isolated local PostgreSQL 17 database. The signed download URL was never logged. Restore used PostgreSQL 17.11 `pg_restore` with `--single-transaction --no-owner --no-acl`; no production database was written to or replaced.

Verification passed:

- Both migration records were present.
- All five application tables were restored: `schema_migrations`, `checkout_attempts`, `orders`, `audit_log`, and `webhook_deliveries`.
- All 36 constraints and both snapshot/audit protection triggers were present.
- The populated restore contained **2 orders, 4 checkout attempts, 4 audit entries, 7 webhook deliveries, and 2 migration records**. These counts reflect the backup capture, before the later edit/cancellation test events; they are not the final live database event totals.
- Both #1001 (pickup) and #1002 (delivery) retained their exact checkout cut snapshots: two cut groups, three physical pieces, and a $7.29 cut subtotal. Recalculated catalogue hashes and pricing matched.
- Each restored order retained its signed paid-event record, audit history, production hold, and uncut status. Validation of each original paid payload against its restored immutable snapshot returned only the expected `test_order` hold.
- The temporary local server was stopped and removed after verification.

The backup archive and machine-readable evidence are in ignored `tmp/`, with the archive readable only by the local account. They are not committed or deployed. The restore client was built from checksum-verified official PostgreSQL source in temporary storage; it did not require changes to installed packages.

For a later recovery test, capture/download a new backup privately, create a separate disposable database, restore into that destination, and compare migrations, constraints, order counts, representative cut snapshots, and audit history. Repeat this populated restore check periodically and after significant schema changes. Never paste a signed backup URL into chat, logs, source control, or a ticket. Production replacement requires a separate recovery decision and current backup; a smoke test must not overwrite production.

## Custom-domain status

**Both public domain paths are verified: `www.niceworkshop.ca` serves the site over HTTPS, and `niceworkshop.ca` redirects to it.** DNS hosting remains in AWS Route 53. The `www` CNAME targets `still-tick-kg7uyxckj64b0v9u98kvxq48.herokudns.com`; Heroku's managed certificate is issued and an HTTPS request to the `www` homepage returned HTTP 200. `PUBLIC_ORIGIN` is now `https://www.niceworkshop.ca`. Code release `v12` contains the canonical-hostname fix; configuration release `v13` sets the origin. [Heroku custom domains](https://devcenter.heroku.com/articles/custom-domains), [Heroku certificate management](https://devcenter.heroku.com/articles/automated-certificate-management).

The root domain redirects to `www` through a separate CloudFront distribution, retaining Route 53. Its configuration is:

| Item | Value / verification state |
| --- | --- |
| CloudFront plan | **Free flat-rate, $0/month**, selected for the redirect distribution |
| Distribution | `E3LCIIW4V1KT0A` |
| Distribution hostname | `d2v1o55wqvom0v.cloudfront.net` |
| Root certificate | ACM in `us-east-1`, ID `5461a639-8937-4c57-a289-89449aea7954` for `niceworkshop.ca` |
| Redirect function | `niceworkshop-apex-redirect`, published **LIVE** with JavaScript runtime 2.0 and associated with the distribution's default **viewer-request** event |
| Function source | `scripts/cloudfront-apex-redirect.js`; returns HTTP 308 to `https://www.niceworkshop.ca` with the path and query fields retained |
| Root DNS | A and AAAA alias `d2v1o55wqvom0v.cloudfront.net.`, Evaluate target health **No** |
| Verification | Public HTTPS redirect, function association, paths/query values, and preservation of existing non-website DNS records verified |

All **five redirect-function tests** and **ten focused HTTP tests** passed, separately from the earlier 74-test full-suite run. An AWS runtime test also succeeded with HTTP 308 and preserved an encoded path and query. Keep the deployed function aligned with its repository source; changing its code requires publishing and verifying the associated live function. Existing signed Shopify webhook subscriptions remain on `https://niceworkshop-ca-b8d9f27f02c2.herokuapp.com/api/webhooks/shopify` and were not changed for the domain setup.

Public verification confirmed:

- HTTPS root `/` returned **308** to `https://www.niceworkshop.ca/`; encoded paths, repeated query fields, and their values were preserved.
- HTTP root returned **301** to HTTPS root; HTTP `www` returned **308** to HTTPS `www`.
- A browser opening the root reached the `www` storefront with its test-mode banner.
- The original Heroku staff URL returned **308** to the matching `www` path with its query retained; the Heroku health endpoint remained directly available.

The pre-change Route 53 snapshot is saved locally in ignored `.private/route53-before-domain-setup.txt`. An exact before/after comparison confirmed all **eight original non-website records** retained their values and TTLs: MX, NS, SOA, apex TXT, DMARC, and three DKIM records. These include Proton's MX, SPF, and verification data. Public MX still resolves to Proton. Later Shopify confirmation and application SMTP preview tests were received in Proton; these delivery checks were separate from the DNS comparison.

Keep the ACM validation CNAME for automatic renewal: `_654fabb0e13bd7e5daa7417eb5a894c5.niceworkshop.ca` → `_f8fcd9845f9a8539f8de050438072ac1.wzccmgtwzk.acm-validations.aws.` Do not remove this record after certificate issuance. The CloudFront console still showed deployment in progress at the final recorded check, while the published redirect was already serving correctly in public tests. Domain setup did not authorize payment activation; the Test payment gateway remained active at that stage. The owner subsequently authorized the live switch recorded above.

## Live activation and operational follow-ups

The owner explicitly authorized live checkout on October 31, 2026. Shopify Payments replaced the Test payment gateway; the provider now shows **Accepting payments**, and the **Turn on test mode for Shopify Payments** checkbox is off. CAD, the **Weekly on Monday** payout schedule, and **Automatically at checkout** capture method were preserved. Shopify reports payouts pending until **November 4, 2026** because the owner previously updated bank account details. See [payment verification and live activation](OPERATIONS.md#payment-verification-and-live-activation).

The application uses `CHECKOUT_ENABLED=true`, `CHECKOUT_MODE=live`, `HST_REGISTRATION_CONFIRMED=true`, `LIVE_CHECKOUT_VERIFIED=true`, and `SHOPIFY_TEST_MODE_CONFIRMED=false` in Heroku configuration release **v24**. Public `/healthz` and `/readyz` returned HTTP 200 with `ok` and `ready`; `/api/config` reported `checkoutEnabled: true` and `mode: live`. A fresh browser checkout showed real credit-card fields, free native pickup, the customer's billing-address form, and **Pay now $2.87** for the known 100 mm circle example. No payment was submitted. The test banner and test-only checkout wording are absent.

The five unpaid prelaunch test drafts **D1, D2, D5, D7, and D8** were retired after checking their exact identities, references, open status, and absence of an associated order. Their deletion was verified; completed test orders #1001–#1004 and database audit records were retained. A mode flag alone does not invalidate an existing Shopify draft checkout link. Previously paid test orders retain permanent production holds. The fresh live-checkout verification draft **D10** (`1619917930711`) was also retired after confirming its exact expected cut, $2.87 total, no email, no associated order, and unpaid status. Final inventory showed zero open drafts and four completed test drafts retained. No real payment or refund was made during activation.

The following work remains after activation:

1. Verify receipt of a real refund notice when a refund is needed, and record actual pickup/drop-off handoff independently from cutting and Ready. The refund template preview was inspected using Shopify sample products and amounts; it does not prove notice delivery. Native pickup v20/#1004, signed-event reconciliation, installed read permissions, Ready/migration 003, both SMTP previews, and the customized confirmation receipt remain verified.
2. Verify payment/payout export access. After the first authorized live sale and resulting payout, reconcile the order, tax, fees, bank deposit, and Shopify report exports. Sales/tax report-screen access is verified; test-gateway payments cannot prove live settlement or payout reporting.
3. Check Shopify's payout status after the displayed November 4 resumption date and confirm the actual payout schedule and bank receipt. Do not treat the activation banner as proof that a deposit has already occurred.

PayPal Express Checkout was deactivated for testing on October 31, 2026 and remains inactive. The owner-authorized launch uses Shopify Payments; any later PayPal offering is a separate decision.
