# Nice Workshop operations

Last reviewed: October 31, 2026. Times used for customer promises and reporting: America/Toronto. Currency: CAD.

**Current status: deployed for test checkout; live sales remain closed by the owner's choice.** The Heroku app, Postgres database, installed Shopify app, signed-event subscriptions, tax registration, and daily backups are configured. Pickup, delivery, failed-payment, partial/full-refund, order-edit, and cancellation tests passed, and a populated database backup was restored successfully. The official Shopify **Test payment gateway** remains active; no real money moved. On October 31, 2026, the owner reported completing all business-verification steps and choosing weekly payouts, while deliberately leaving Shopify Payments unactivated. Shopify now displays **Inactive** and **Your shop is ready to use Shopify Payments**; the connected payout account and **weekly Monday** schedule were verified in its settings. Payment capture is verified as **Automatically at checkout**; mailbox receipt of customer notices remains unverified. Use only test payment details. Live activation requires the owner's explicit later authorization as well as the remaining launch checks. This project must never modify or deploy to **Mighty Fine Orders**.

## Store and service details

| Item | Current value |
| --- | --- |
| Website | [Nice Workshop](https://www.niceworkshop.ca/) |
| Cutting queue | [Workshop orders](https://www.niceworkshop.ca/staff) |
| Heroku app | `niceworkshop-ca`, US region, one always-on Basic web dyno |
| Database | Separate Heroku Postgres Essential-0 |
| Approved hosting cost | US$7/month web + US$5/month database = **US$12/month**, before taxes/currency conversion/additional usage |
| Shopify store | Nice Workshop — `waj4za-5t.myshopify.com`, Basic plan, CAD, America/Toronto |
| Runtime Shopify app | **Nice Workshop Orders**, installed; server credentials verified |
| Customer service | `hello@niceworkshop.ca` |
| Pickup | **1019 Castleford Road, Renfrew, ON K7V 3Z8, Canada** |
| GST/HST | **795906486RT0001**, confirmed active by the owner and saved in Shopify's Canada tax collection settings |
| Daily database backup | **03:00 America/Toronto** |
| Website domain | `www.niceworkshop.ca` serves the site over verified HTTPS; `niceworkshop.ca` redirects there with paths and query values preserved |

Business identifiers and annual reporting details are maintained in [business.json](business.json). [DEPLOYMENT.md](DEPLOYMENT.md) records configuration, deployment, test commands, and recovery evidence. Never put passwords, API secrets, signed backup links, or customer data in either document or in source control.

## Where to do each job

| Job | Place to do it | Completion evidence |
| --- | --- | --- |
| Take payment | Shopify hosted checkout, opened directly from the website | Shopify confirms captured payment; local order records that confirmation |
| Refund money, cancel an order, review payment problems | Shopify admin → Orders → the order | Correct transaction and status in Shopify, synchronized local production hold |
| Read the cut specifications and mark the entire order cut | Nice Workshop production record | Saved JSON cut list, current revision, cut timestamp and operator |
| Change paid cut specifications | Owner-approved exception, following the procedure below | New reviewed revision, financial adjustment complete, old revision retained |
| Confirm pickup or delivery | Order record and the tested Shopify fulfillment workflow | Actual handoff recorded separately from cutting |
| Export sales and tax records | Shopify admin → Analytics → Reports | Date-stamped exports reconciled to orders and refunds |
| Export payment fees and deposits | Shopify Finance/Payments and bank statement | Payouts matched to bank deposits |
| Recover the application database | The designated Nice Workshop database provider | Restore tested in a separate database before any production replacement |

The runtime app's four API-version **2026-10** subscriptions are registered for paid orders, order updates, cancellations, and refunds. Actual signed events were received and processed during the tests below. The app checks them against the original quote and retains the original cutting specifications when a payment or order changes.

## Service rules

The service sells custom rectangles and circles cut from plywood. There is no product inventory or SKU system. The cut list may remain JSON; completion is recorded for the **whole order**, not individual cuts. A paid order enters the nesting/production queue, with a stated 14-day lead time. Capture the lead time and policy version accepted at purchase; a later banner change must not rewrite an existing promise.

The fulfillment options are free driveway pickup at the address above and approximately **$5 tax included** for local drop-off, with no shipping. Delivery is available where the legal address's city is **Arnprior, Braeside, McNab, or Renfrew**. The configured fee is $4.42 before tax; test checkout confirmed **$4.99 including HST**, an owner-approved difference from $5. Check the actual delivery address before dispatch. Pickup is the driveway stand; use the current instructions in the customer confirmation.

The owner has approved exact pre-tax group pricing with **estimated tax on the site and Shopify's final tax at checkout**. Each matching cut group is represented as one priced bundle with its physical piece count clearly labelled; Shopify quantity one means one group, not one physical piece. The existing calculator taxes the combined subtotal, so its estimate can differ from Shopify's rounding. Test this distinction in the cart, checkout, refunds, and reports.

The owner has authorized test pickup, delivery, refund, and cancellation orders on this previously unused store. Every test purchase remains held out of actual production, including after refund or cancellation. Keep live checkout closed until customer-notice receipt and the remaining launch review are verified and the owner explicitly authorizes activation.

The intended policy is that paid custom orders enter production and are ordinarily final. Have the owner approve the wording presented before payment. “Final sale” does not settle every complaint: Ontario does not provide a general change-of-mind return right, but statutory remedies can still apply. Escalate defective, misdescribed, missing, or materially delayed orders to the owner; do not reject them solely because a checkbox was accepted. [Ontario returns guidance](https://www.ontario.ca/page/returns-exchanges-and-warranties-ontario), [online purchase disclosures](https://www.ontario.ca/page/safe-online-shopping), [delivery and consumer rights](https://www.ontario.ca/page/your-rights-under-consumer-protection-act).

Pickup currently uses a custom zero-cost Shopify shipping rate. Customers keep the workshop address as the pickup destination and enter their own name/contact details. If their payment card uses another billing address, they uncheck **Use shipping address as billing address** in checkout and enter it separately. The website explains this before checkout. Changing the agreed pickup/delivery destination creates a production hold for review.

## Daily order routine

Open the [Workshop orders page](https://www.niceworkshop.ca/staff), enter the workshop access key, and select **Load orders**. The owner key is kept locally in the ignored `.private/admin-access-key.txt`; do not send it to customers or place it in a URL. The page retains the key only in memory for the current session. Use **Refresh orders** before cutting; **Sign out** clears the key and displayed orders. Each record links to its Shopify order. Refresh and sign-out were verified against the deployed staff page.

1. Review new Shopify orders, payment problems, refunds/cancellations, and local synchronization errors.
2. Match each new paid order to exactly one local order using its Shopify ID. Confirm the saved cuts, physical quantities, grain orientation, fulfillment choice, agreed price, policy version, and lead time.
3. Only release an order for cutting when confirmed paid, matched to its current specifications, and free of a production hold. An unpaid draft, payment authorization, browser success page, or customer screenshot is not sufficient.
4. Review the due-date queue. Contact the customer promptly when the promised date is at risk and record the agreement.
5. Before marking an entire order cut, check all pieces against the current approved cut list. Record who completed it and when. If only some pieces are finished, leave the whole-order flag uncut and add an internal progress note.
6. Keep the cutting state separate from delivery. Cut does not mean collected, delivered, refunded, or closed.

If an order is marked cut accidentally, correct it with a reason and an audit entry. Do not erase its history. A new cut-list revision requires review; never silently reuse an earlier completion flag.

The staff page offers **Mark entire order cut** and **Reopen cutting status**. It does not edit cut specifications, refund payments, or clear production holds. Held records need owner review and, where required, an audited reconciliation by the maintainer. Do not remove a hold or change saved JSON directly just to make a button available. `test_order` always means a simulated purchase that must not be cut.

## Refund an order

First pause any remaining production/handoff for the affected order, identify the customer/order, and record the owner's decision and reason. Check previous refunds and disputes before moving money. If a physical return is needed, arrange and create that return before refunding.

In Shopify: **Orders → open order → Refund**. Select the affected line quantities, review tax and any delivery refund separately, choose the refund method, and record the reason. Review the total and customer notification, then submit once. A submitted refund cannot be reversed. Shopify Payments card processing fees are not returned. [Shopify refund procedure](https://help.shopify.com/en/manual/fulfillment/managing-orders/refunding-orders).

After submitting:

- Confirm the transaction and financial status in Shopify. If the result is unclear, inspect the order timeline before retrying.
- Confirm the local payment/refund state and production hold agree. Keep the original paid cut list and cutting history.
- Record whether remaining work is cancelled, still required, or being remade. A partial money refund does not by itself identify which physical cuts to remove.
- For a partial refund within a priced cut group, use the owner's approved calculation and verify the tax adjustment. If a Shopify line represents several pieces as one bundle, its quantity is **not** the physical piece count. Do not reduce it mechanically.
- Save the reason and adjustment reference for bookkeeping. Do not simulate a refund by changing a local total or deleting a database row.

## Cancel an order or handle an abandoned checkout

An unpaid, abandoned draft does not enter production. Unpaid drafts and their checkout attempts are currently retained; there is no automatic expiry job. Use the checkout reference to match the saved attempt to the Shopify draft before resolving an uncertain result. Do not send an invoice just because an unpaid draft exists.

For an accepted cancellation of a paid order, halt production first. In Shopify: **Orders → open order → More actions → Cancel order**. Review the refund choice carefully. “Later” cancels processing without issuing the refund now, so track that obligation. Cancel already-refunded orders individually and select the appropriate no-additional-refund path; bulk cancellation can create duplicate refunds. Archiving only removes an order from the open list. [Shopify cancellation procedure](https://help.shopify.com/en/manual/fulfillment/managing-orders/canceling-orders).

Verify both cancellation and refund outcomes, then reconcile the local order. Keep cut history even when an order is cancelled after cutting.

## Change an order

### Before payment

Let the customer revise the website cart and start a fresh validated checkout. The backend must price the new specifications and associate payment with that exact saved revision. An old checkout can remain usable unless it is invalidated or otherwise controlled; never assume starting a new draft disables the previous one. Reconcile any old paid attempt before releasing work.

### After payment

Changes are owner-approved exceptions to the stated production policy. Pause work before promising a change. Determine whether nesting or cutting has begun and whether the requested revision can actually be supplied.

1. Save the request and the old specification. Prepare a complete new cut list with dimensions, shape, material, physical quantity, grain orientation, price, and any revised delivery promise. Obtain the customer's agreement.
2. Check whether Shopify allows the edit. Native local-delivery orders cannot be edited, and the editor cannot switch the delivery method. Do not disguise an unsupported change as a note. For those cases, the owner must approve a separately priced replacement order and any refund/cancellation of the original; cross-reference both records. [Editing restrictions](https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders/considerations).
3. Where supported, use **Orders → open order → Edit**. Add/remove the necessary custom items, review quantities and taxable status, record a reason, and review the updated order. A decrease requires an actual refund; an increase requires collection of the additional payment. Saving an edit does not complete either money movement. [Editing custom items and reviewing changes](https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders/products).
4. Reconcile the Shopify order to the new local cut-list revision. Do not assume a free-text Shopify note changes the machine-readable JSON.
5. Keep production on hold until the new revision, totals, payment balance, and any refund are verified. Record the operator who releases the hold.

**Current limit:** detecting an edited order and holding it is implemented; a staff-screen workflow for replacing its cut list and releasing that hold is not. For an approved specification change, use an owner-reviewed replacement checkout with the correct cuts and handle the original's cancellation/refund separately, or have the maintainer perform a documented reconciliation. Keep both order references. Do not promise that saving a Shopify edit automatically updates the workshop's cutting instructions.

Changing a contact detail is different from changing a cut. A delivery-address change still requires renewed eligibility/tax review. Do not silently reroute an order outside the agreed delivery area.

## Pickup, delivery, and customer messages

Before notifying a customer that an order is ready, verify the entire order is cut, checked, labelled, and packed. Use the saved fulfillment choice and approved pickup instructions. Record collection or completed delivery only when it happens.

The initial purchase should open Shopify checkout directly; an emailed invoice is not required. Order confirmations, ready notices, refund notices, and exceptional additional-payment requests are separate messages. Confirm which system sends each before launch to avoid duplicates. Test delivery to the connected business inbox and a customer test inbox. Do not assume that an open Proton Mail session configures outbound application email.

A custom delivery charge titled “pickup” or “local delivery” does not prove Shopify's native pickup/delivery workflow is enabled. The launch tests must establish the actual buttons/statuses and customer notifications for both choices before staff use them.

## Find tax records and close the books

Do this monthly as well as at year-end. Ask the accountant for the correct fiscal/GST-HST reporting periods and accounting treatment. Use the same period, currency, and timezone across exports; keep a note of those filters. Sales, refunds, payments, and bank deposits can fall in different periods.

The owner's CRA screenshots show **annual GST/HST reporting**, a **December 31 year-end**, and a January 1–December 31, 2026 reporting period. The displayed GST34 return filing date is **June 15, 2027**. The payment deadline is recorded separately as unconfirmed; do not use the filing date as the payment deadline. Check the current account details and [business.json](business.json) when preparing the return.

| Record | Where to get it | What to retain/check |
| --- | --- | --- |
| Tax collected and adjusted | **Analytics → Reports → search Taxes → Taxes**, or [open this store's Taxes report](https://admin.shopify.com/store/waj4za-5t/analytics/reports/taxes); also review **Finance Summary** | Choose the reporting dates and CAD, then **Export → CSV → All results from data query**. Reconcile to sales/refunds. [Finance report guidance](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/finances-report) |
| Order-level sales detail | **Analytics → Reports → Total sales by order**, or [open this store's report](https://admin.shopify.com/store/waj4za-5t/analytics/reports/total_sales_by_order) | Export gross/net sales, discounts, reversals, shipping, return fees, taxes, and total for the same period. [Tax reporting options](https://help.shopify.com/en/manual/taxes/tax-reports) |
| Order source records | **Orders → Export → Orders by date** | Export orders and transaction histories. Date-based exports may arrive by email; transaction histories cover captured payments, not authorizations. Include older orders refunded in this period in reconciliation. [Order exports](https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders) |
| Payment fees and balances | **Finance → Documents → Shopify Payments activity report**, select period and CAD, export PDF; use **Payouts** for individual deposits | Compare fees, refunds, holds, balances, and deposits to the bank. This is balance activity, not a revenue statement, and excludes Shopify subscription bills/other processors. If the store has **Money**, open the business under Payment volume instead. [Payments activity report](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/payouts-activity-report) |
| Shopify subscription/app invoices | **Settings → Billing → Past bills** | Download the bills, retaining any taxes shown. [Shopify bills](https://help.shopify.com/en/manual/your-account/manage-billing/managing-your-bills) |
| Other expenses | Supplier, Heroku/database, domain, tools, and other business invoices | Keep original invoices and payment evidence, with tax information, in the bookkeeping archive |

The **Taxes** and **Total sales by order** screens and their export controls were verified in this store on October 31, 2026. Both loaded in CAD with date selectors and no data for the selected test-only period. The Taxes export dialog offered CSV and **All results from data query**; no empty file was exported. Payment/payout export access and reconciliation to actual transactions remain unverified.

If the store uses Shopify Tax in Canada with CAD currency, it may also have a **Canada sales tax** report. Its detail is useful, but it includes only orders with Canadian shipping addresses; check pickup orders separately. That report's CSV export is limited to one month, so export each month or use the general Taxes report for a longer period. [Canada report limitations](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/finances-report#canada-sales-tax-report).

Reconcile gross receipts, refunds, tax, fees, net deposits, and outstanding balances. Do not treat the net bank deposit as sales revenue or tax collected. Do not count tax twice by adding overlapping reports. Keep unresolved differences on a dated list for the accountant.

The workshop's pricing model includes supplier HST in its material-cost allocation. That pricing choice does not decide eligibility for an input tax credit. Keep compliant supplier invoices and let the accountant determine ITCs and the return. CRA generally requires GST/HST records for six years from the end of the year concerned, with exceptions requiring longer retention. Preserve sales/purchase invoices, adjustments, supporting records, and filed-return working copies. [CRA GST/HST records](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/calculate-prepare-report/gst-hst-records-keep.html).

Keep readable electronic records and backups, including after changing providers. Confirm record location/retention requirements with the accountant before relying solely on an overseas-hosted database. [CRA electronic records](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/15-2/electronic-records.html).

## Reconciliation, outages, and recovery

If Shopify shows paid but the local order is absent, hold that order and reconcile by Shopify order ID. Recover the original saved cut list and payment association; do not ask the customer to pay again or create a second production order. If the association is ambiguous, stop that order for investigation.

If checkout creation times out, the remote draft might still exist. Use the internal checkout reference to inspect/reconcile before retrying creation. Repeated clicks or duplicate webhooks must not duplicate paid orders.

If the database or Shopify is unavailable, keep checkout/production in a safe paused state. Restore service, reconcile affected orders, and then resume. Do not infer successful payment from a frontend redirect. Record the incident, affected IDs, and resolution without copying payment credentials into logs.

The Nice Workshop database is scheduled for a backup every day at **03:00 America/Toronto**. Check successful backup timestamps regularly because scheduled failures do not send notifications. Backup **b002** proved schema recovery. Populated backup **b003** was then restored into a separate local database on October 31, 2026, preserving two test orders, their immutable cut lists, signed paid-event records, audit history, production holds, and uncut status. Both migrations, all five application tables, constraints, and protection triggers were verified. Recovery details are in [DEPLOYMENT.md](DEPLOYMENT.md).

Recheck schedules after database attachment changes and keep an independent retained copy. Never overwrite production just to test recovery. Provider backup retention is not an accounting archive. [Heroku PGBackups](https://devcenter.heroku.com/articles/heroku-postgres-backups).

## Verification record and remaining launch checks

Verified on October 31, 2026:

| Check | Result |
| --- | --- |
| Heroku app/database deployment | Separate Nice Workshop Basic/Essential-0 environment running; health and database readiness checks pass |
| Custom domain | `www.niceworkshop.ca` homepage HTTP 200 and readiness healthy; root HTTPS HTTP 308 redirects to `www`, preserving paths and query values. Browser follows the redirect to the storefront with its test-mode banner. Proton DNS records remain unchanged |
| Runtime app and webhooks | Credentials verified and all four 2026-10 subscriptions registered |
| HST registration | Owner confirmed active; Canada collection setting saved |
| Pickup payment — **#1001** (`18898327044311`) | Cut groups **$7.29**, HST **$0.95**, free pickup, paid test total **$8.24** |
| Delivery payment — **#1002** (`18898327929047`) | Cut groups **$7.29**, delivery **$4.42**, HST **$1.52**, paid test total **$13.23**. Delivery adds **$4.99** including its tax |
| Failed test payments | Test gateway cards **2** and **3** rejected; local order count remained **zero** |
| Signed order receipt and saved cuts | Each paid test produced exactly **one** local order, **two** custom cut groups and **three** physical pieces: one circle and two rectangles. Immutable JSON matched the selections |
| Test-order production hold | Both records retain `test_order` hold and remain uncut through edits/refunds/cancellation; attempting to mark #1001 cut returned **409 production_hold** |
| Partial then full refund — **#1001** | Circle group **$1.86 + $0.24 HST = $2.10** refunded first; remaining rectangle bundle **$5.43 + $0.71 HST = $6.14** refunded next. Total refund **$8.24**. Signed events changed the local status to `partially_refunded`, then `refunded`, with the refund flag set. Original JSON still records the three ordered pieces |
| Changed order — **#1002** | Intentional Shopify circle-group quantity change **1 → 2** changed the total to **$15.33** against **$13.23** already paid, leaving **$2.10** outstanding. No additional-payment invoice was sent. The local record became `partially_paid`; comparison reported `ORDER_SNAPSHOT_MISMATCH` for changed cut lines/subtotal/total and unpaid balance. Original JSON stayed at three pieces and production remained held |
| Cancellation and full refund — **#1002** | **More actions → Cancel order**, reason **Other**, restocking off, refund **$13.23** to the original test payment. Shopify showed cancelled/refunded; the local record has a cancellation timestamp, refund flag, `refunded` payment status, and remains uncut |
| Customer emails | Both Shopify timelines report confirmation/refund messages sent to `hello@niceworkshop.ca`. Actual receipt in the mailbox has **not** been verified |
| Backups | Daily 03:00 Toronto schedule; b002 schema restore and b003 populated restore passed |
| Automated tests | Complete suite passed with actual PostgreSQL; see [DEPLOYMENT.md](DEPLOYMENT.md) for the latest count and coverage |

For each further live-store test, record its date, tester, Shopify order number, expected amounts, actual result, and any unresolved issue. Automated checks and actual hosted checkout tests are separate requirements.

- [x] Complete rectangle-plus-circle pickup and eligible delivery tests through hosted payment, signed events, and matching local order creation; verify charges and cut specifications.
- [x] Verify the approximately $5 tax-inclusive delivery charge in actual checkout.
- [x] Verify signed payment delivery creates exactly one matching local order and test purchases cannot be cut.
- [x] Deployed checkout rejected an Ottawa delivery address with HTTP 400. Replaying an existing signed test event with the same delivery ID returned HTTP 200 and left counts unchanged: two orders, thirteen deliveries, four checkout attempts. Repeating the delivery checkout with its original request key reused the same attempt and checkout URL.
- [x] Test partial/full refunds, order editing, and cancellation; verify Shopify status, signed events, local financial state, production holds, and preservation of the original cuts.
- [x] Two unpaid drafts remained without workshop orders while the two paid drafts each created one order. Automated database tests cover uncertain creation outcomes and prevent automatic duplicate creation; deliberately disrupting the external provider was not required. Uncertain outcomes still need the manual reconciliation described above.
- [ ] Confirm customer-facing terms and pickup/delivery instructions; check actual mailbox receipt of confirmation/refund notices and test readiness/handoff independently from the cut flag.
- [x] Test a populated database backup and restore, including cut snapshots, signed events, audit history, and production holds.
- [x] Open this store's Taxes and Total sales by order reports and verify export controls. Both currently show no data for the selected test-only period; no export file was produced.
- [ ] Verify payment/payout export access and reconcile the first live sale, tax, fees, refund if applicable, and bank payout. Test transactions do not establish live report-to-bank reconciliation.
- [x] Owner reports completing all business-verification steps and setting weekly payouts on October 31, 2026; Shopify Payments was deliberately left unactivated.
- [x] Shopify displays **Inactive** and **Your shop is ready to use Shopify Payments**; payout account connection, CAD, and **Weekly on Monday** are verified in the UI. No payment setting was changed.
- [x] Saved payment capture method is **Automatically at checkout**; verified read-only with Save disabled, then closed without changes.
- [x] Configure `www.niceworkshop.ca` with a valid Heroku-managed certificate; HTTPS returns the site. Application origin is now `https://www.niceworkshop.ca`; existing Shopify webhook URLs remain on the stable Heroku hostname.
- [x] Verify the `niceworkshop.ca` root-domain HTTPS redirect, public DNS, and path/query preservation. All eight original non-website DNS records retained their exact values and TTLs, including Proton MX, SPF/verification, three DKIM selectors, and DMARC. Public MX still points to Proton; this does not verify mailbox send/receive.
- [ ] Only after the owner's explicit later authorization and all checks pass, deliberately replace the Test payment gateway with the approved live provider and enable live checkout; verify customer-facing mode again.

The current gateway is Shopify's official **Test payment gateway**, not an activated real Shopify Payments account. For future Shopify Payments testing after onboarding, use **Settings → Payments → Shopify Payments → Manage → Test mode → Enable test mode → Save**. Verify the test indicator on resulting orders. Test mode does not capture real payments; simulated Shopify Payments transactions do not appear in payouts/reports. [Shopify Payments testing](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments).

## Payment verification and deferred activation

On October 31, 2026, the owner reported **all business-verification steps complete** and **weekly payouts selected**. The owner deliberately did **not activate Shopify Payments** and is not ready to launch. A subsequent Shopify UI check showed **Inactive**, the banner **Your shop is ready to use Shopify Payments**, and an **Activate** button that would replace the existing test gateway. Payout settings showed a connected bank account, CAD, and **Weekly on Monday**. This confirms the displayed readiness and payout setup, without asserting anything beyond Shopify's visible status. The saved payment capture method is **Automatically at checkout**; its dialog was inspected with Save disabled and closed without changes. No payment settings were changed. Do not activate payments or change the live-checkout gate without explicit later authorization.

The owner confirmed that the address and operating/trading name were changed in **CRA My Business Account**. A newly issued CRA letter dated October 31, 2026 has been inspected: it shows **ADRIAN SEELEY**, **NICEWORKSHOP.CA**, **1019 CASTLEFORD RD, RENFREW ON K7V 3Z8**, and business number **795906486**. Keep the legal entity name distinct from the operating name when checking account details or responding to any later verification request.

For Canadian business verification, Shopify requires the legal entity name and business address to match the submitted document. Accepted categories include government-issued letters/documents and a CRA Notice of Assessment or Reassessment from the past 12 months. A personal Notice of Assessment is not automatically suitable for the particular business-verification request. Use the original issued digital PDF, including all pages, rather than a screenshot or edited document. Follow the document category requested in the Shopify verification screen. [Shopify Canada verification requirements](https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries/canada/requirements).

The inspected document is a **Filing and balance confirmation letter**, requested through My Business Account and retrieved through **View mail**. Its current name/address content is verified. Shopify now displays the readiness banner described above; the acceptance of this individual document was not separately inspected. Preserve the original three-page PDF, including its blank and barcode-information pages, for any later request. A later account change does not update an old document. [CRA letter instructions](https://www.canada.ca/en/revenue-agency/services/e-services/digital-services-businesses/business-account/help-filing-balance.html).

If Shopify requests further documents, upload them only through its official account flow; do not add them to this repository. Keep the Test payment gateway active and live checkout gated until the owner explicitly authorizes activation and the remaining launch checks are complete.

PayPal Express Checkout was deactivated for testing on October 31, 2026; Shopify confirmed **Inactive** and retained its connected account details for later reactivation. Only the official test gateway should be offered while live activation is deferred. Decide on any live PayPal offering separately during an authorized launch.
