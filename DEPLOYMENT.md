# Nice Workshop deployment and recovery

Verified October 31, 2026. This document records the running environment and the checks already completed. [OPERATIONS.md](OPERATIONS.md) covers business procedures; [PRICING.md](PRICING.md) covers pricing. **Every Heroku command for this project must explicitly target `niceworkshop-ca`. Never use Mighty Fine Orders or its database.**

## Current environment

| Component | Verified value |
| --- | --- |
| Public app | https://www.niceworkshop.ca/ |
| Staff page | https://www.niceworkshop.ca/staff |
| Heroku app | `niceworkshop-ca` |
| Deployment | Code release `v12`, commit `92e9eb6` (canonical hostname fix); configuration release `v13` sets the new public origin |
| Region / stack | `us` / `heroku-24` |
| Runtime | Node.js 24; one always-on Basic web dyno |
| Database | Separate Heroku Postgres Essential-0 |
| Approved baseline cost | US$7/month web + US$5/month database = US$12/month, excluding tax, currency conversion, and any additional usage/add-ons |
| Shopify store | Nice Workshop — `waj4za-5t.myshopify.com` |
| Installed Shopify app | Nice Workshop Orders; app ID `442209927169`, organization `236066190` |
| App permissions | `read_orders`, `write_draft_orders` |
| Customer service | `hello@niceworkshop.ca` |
| Canonical domain | `www.niceworkshop.ca`; verified HTTPS and root-domain redirect with path/query preservation |

**Test checkout is enabled; live payments remain gated by the owner's choice.** The official Test payment gateway is active. The server's Shopify credentials were installed and validated by a direct API query. The app's four webhook subscriptions are registered, and actual signed paid-order events have been received and processed. Pickup and delivery payments, partial/full refunds, a paid-order edit, cancellation, and failed-payment scenarios have completed successfully in test mode, with the expected local synchronization and production holds. The owner's active HST registration and saved Canada tax collection have been verified. On October 31, 2026, the owner reported completing all business-verification steps and setting weekly payouts, while deliberately leaving Shopify Payments unactivated. The Shopify UI subsequently confirmed **Inactive**, **Your shop is ready to use Shopify Payments**, a connected payout account, CAD, and **Weekly on Monday**. The saved capture method **Automatically at checkout** was also verified read-only; no payment setting was changed. Live activation requires explicit later authorization from the owner.

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
| `CHECKOUT_ENABLED` | Currently `true` for authorized test checkout |
| `CHECKOUT_MODE` | Currently `test` |
| `SHOPIFY_TEST_MODE_CONFIRMED` | Currently `true`; must reflect the actual gateway, not merely the desired environment |
| `HST_REGISTRATION_CONFIRMED` | Currently `true`; active registration and saved Canada collection verified |
| `LIVE_CHECKOUT_VERIFIED` | Currently `false`; leave false until all launch checks pass and the owner explicitly authorizes activation |

Checkout requires an enabled flag, a database, a configured Shopify client, a public origin, and the relevant mode confirmations. `test` mode requires confirmed provider test mode. `live` mode requires confirmed HST registration and completed live-readiness verification. These flags do not themselves enable or disable Shopify's gateway; verify the provider state separately. To close checkout immediately, set `CHECKOUT_ENABLED=false` on `niceworkshop-ca` and verify `/api/config` reports checkout disabled.

The database connection verifies the certificate chain and server hostname. Heroku Essential/Advanced databases use AWS RDS certificates; Heroku's stack includes the required CA bundle. For external local checks, download the [official AWS RDS global bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) and set `DATABASE_CA_FILE` to its path. Do not fix certificate errors by disabling verification. An actual authenticated connection to this database was verified with `authorized=true`, TLS 1.3, and a successful `SELECT 1`. [Heroku certificate instructions](https://devcenter.heroku.com/articles/connecting-heroku-postgres).

## Deployments and migrations

The `Procfile` runs `npm run db:migrate` as the release command and `npm start` as the web process. Migrations use a transaction, advisory lock, and checksums; an applied migration must never be edited in place. Add a new numbered migration for a schema change. Both `001_initial.sql` and `002_checkout_metadata.sql` are applied.

Before deploying, run the complete local test suite with a disposable PostgreSQL database and inspect the source package. Exclude `.env`, `.private/`, backup files, and test data. Preserve the repository's existing storefront edits. Deploy only the explicitly identified Nice Workshop app, then verify the release succeeded, `/healthz`, `/readyz`, `/api/config`, and the staff page. Check that checkout remained in its intended mode.

Heroku release rollback changes application code; it does not undo committed database migrations. Keep migrations compatible with rollback where possible. Review a database restoration separately rather than treating code rollback as database recovery.

The web process polls the durable webhook inbox every three seconds. HMAC verification and database persistence happen before the HTTP acknowledgement. Processing verifies the order against its immutable cut/price/fulfillment snapshot, deduplicates repeated events, and holds edited, refunded, cancelled, mismatched, or test orders. Test purchases are never eligible for actual cutting. The independent `scripts/process-webhooks.js` entry point can run a bounded processing batch for recovery; it reports counts rather than customer payloads.

The installed app is registered for `orders/paid`, `orders/updated`, `orders/cancelled`, and `refunds/create` at `https://niceworkshop-ca-b8d9f27f02c2.herokuapp.com/api/webhooks/shopify`. Actual signed payment events were persisted and processed for both test orders below. Do not expose a manually constructed unsigned event endpoint or treat a browser return as payment confirmation.

## Local development and tests

Use Node.js 24 and `npm ci`. `npm start` consumes exported environment variables. For an ignored `.env` file based on `.env.example`, use `node --env-file=.env server/index.js`; run local migrations with `node --env-file=.env scripts/migrate.js` only after verifying that its database is the intended development database. `DATABASE_SSL=disable` is accepted only for loopback databases; remote databases require verified TLS.

`npm test` runs all unit and HTTP tests and explicitly skips real PostgreSQL suites when `TEST_DATABASE_URL` is absent. For complete verification, either supply a dedicated test database or use the temporary-cluster helper:

```sh
NICE_TEST_POSTGRES_BIN=/absolute/path/to/postgresql/bin scripts/test-db-local.sh app.test.js test/*.test.js
```

The supplied directory must contain `postgres`, `initdb`, and `pg_ctl`. The helper binds a fresh cluster to loopback on an available port, creates a disposable database, runs tests, and stops/removes that cluster. It never starts or changes a system PostgreSQL service. Each database test suite uses its own generated schema.

Latest complete run: **74 tests passed, zero failures and zero skips**, using actual PostgreSQL 17. Tests include exact price calculations, invalid/tampered cuts, checkout races and uncertain external outcomes, staff authorization, HTTPS enforcement, webhook signature checks, out-of-order/refund/cancellation events, permanent test-order holds, database constraints, immutable snapshots, and atomic cutting/audit transitions. Live provider checks remain separate from these local results.

## Verified Shopify test payments

Both successful orders used the official test gateway, with a circle and rectangle represented as two cut groups containing three physical pieces. Each produced exactly one matching local order with the correct saved cuts. Their only production hold at initial import was `test_order`.

| Test | Shopify order | Cut subtotal | Delivery before tax | HST | Total |
| --- | --- | --- | --- | --- | --- |
| Free driveway pickup | #1001 | $7.29 | $0.00 | $0.95 | $8.24 |
| Eligible local delivery | #1002 | $7.29 | $4.42 | $1.52 | $13.23 |

An attempt to mark a test order cut returned HTTP 409, as intended. The gateway's failed-card scenario (`2`) and gateway-error scenario (`3`) did not create paid orders. Test payment success does not activate live card processing; complete the remaining checks before a later owner-authorized launch.

Actual adjustment tests also passed:

- **Pickup #1001:** refunded $2.10 first, then the remaining $6.14, for a full $8.24 test refund. Shopify and the local order recorded the resulting refunded state correctly.
- **Delivery #1002 — edit:** intentionally changed the circle bundle's Shopify quantity to two. The Shopify order total became $15.33 against $13.23 already paid, leaving $2.10 outstanding. The local order became `partially_paid`, retained its original cut snapshot, and stayed on hold for the mismatch; the changed Shopify quantity did not silently rewrite production cuts.
- **Delivery #1002 — cancellation:** cancelled the edited order and refunded the full $13.23 actually paid. Shopify displayed cancelled/refunded; the local record was refunded and cancelled, retained its original three pieces, and remained uncut.

The application checks and hosted test-gateway scenarios above are complete. Remaining work is delivered email and handoff confirmation, payment/payout export access, and reconciliation after the first live sale/payout. Activation remains deferred until explicit owner authorization. The Taxes and Total sales by order screens and export controls were also verified in this store; both showed no data for the selected test-only period. No export file was produced, and payment/payout export access remains unverified.

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

The pre-change Route 53 snapshot is saved locally in ignored `.private/route53-before-domain-setup.txt`. An exact before/after comparison confirmed all **eight original non-website records** retained their values and TTLs: MX, NS, SOA, apex TXT, DMARC, and three DKIM records. These include Proton's MX, SPF, and verification data. Public MX still resolves to Proton. No mailbox send/receive test was performed.

Keep the ACM validation CNAME for automatic renewal: `_654fabb0e13bd7e5daa7417eb5a894c5.niceworkshop.ca` → `_f8fcd9845f9a8539f8de050438072ac1.wzccmgtwzk.acm-validations.aws.` Do not remove this record after certificate issuance. The CloudFront console still showed deployment in progress at the final recorded check, while the published redirect was already serving correctly in public tests. Domain setup does not authorize payment activation; the official Test payment gateway remains active.

## Remaining launch checks

1. Respect the owner's decision to defer activation. Business-verification steps are owner-reported complete as of October 31, 2026. The Shopify UI now shows **Inactive** and **Your shop is ready to use Shopify Payments**; **Activate** would replace the current test gateway. Payout account connection, CAD, and **Weekly on Monday** are UI verified. These observations confirm the displayed readiness, without asserting additional underwriting status. The saved capture method **Automatically at checkout** is also verified; its dialog showed Save disabled and was closed without changes. See [payment verification and deferred activation](OPERATIONS.md#payment-verification-and-deferred-activation). Leave `LIVE_CHECKOUT_VERIFIED=false` and the Test payment gateway active until all checks pass and the owner explicitly authorizes activation.
2. Confirm the actual receipt/notification email arrives in the intended Proton mailbox and contains the expected order and pickup/delivery details; verify readiness/handoff separately from the cutting flag.
3. Verify payment/payout export access, then after the first authorized live sale and resulting payout reconcile the order, tax, any fees, bank deposit, and Shopify report exports. Sales/tax report-screen access is verified; test-gateway payments cannot prove live settlement or payout reporting.

Only after explicit later owner authorization and completion of the launch checks, deliberately switch the gateway and application to the approved live configuration and verify the public status again. Do not infer authorization or live readiness from completed verification steps, a successful deployment, or a test payment.

PayPal Express Checkout was deactivated for testing on October 31, 2026; Shopify confirmed **Inactive** and retained its connected account details for later reactivation. Only the official test gateway should be offered while live activation is deferred. Decide on any live PayPal offering separately during an authorized launch.
