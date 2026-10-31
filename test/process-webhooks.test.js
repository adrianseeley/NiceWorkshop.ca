'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildQuote } = require('../server/quote');
const { buildDraftOrderInput } = require('../server/shopify');
const {ShopifyError,ORDER_NOTIFICATION_RECIPIENT} = require('../server/shopify');
const {METHOD,PICKUP_PROOF} = require('../server/native-pickup');
const {markOrderReady,processNotificationBatch} = require('../server/notifications');
const { cents, orderIdentifier, validateOrderSnapshot, processWebhook, processWebhookBatch } = require('../server/process-webhooks');
const { migrate, poolOptions, setOrderCut } = require('../server/db');
const catalogue = require('../materials.json');

const SHOP = 'nice-test.myshopify.com';
const OPTIONS = { shopDomain: SHOP };
const ADDRESS = { address1: '1019 Castleford Road', city: 'Renfrew', provinceCode: 'ON', countryCode: 'CA', zip: 'K7V 3Z8' };
const format = amount => (amount / 100).toFixed(2);
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({ fulfillment = 'pickup', id = randomUUID(), orderId = '123456789',nativePickup=false } = {}) {
  const quote = buildQuote({ cuts: [
    { sheetId: catalogue.sheets[0].id, shape: 'rectangle', widthUnits: 1000000, heightUnits: 250000, quantity: 3 },
    { sheetId: catalogue.sheets[1].id, shape: 'circle', widthUnits: 1000000, heightUnits: 1000000, quantity: 2 },
  ], fulfillment });
  const shippingPriceCents = fulfillment === 'pickup' ? 0 : 442;
  const pickupRate={locationId:'gid://shopify/Location/94464344279',handle:'current-pickup-rate',source:'shopify',code:'Shop location',title:'Shop location'};
  const draftInput = buildDraftOrderInput(quote, { reference: id, taxPolicy: 'shopify_authoritative', fulfillmentConfig: {
    pickup: { approved: true, title: 'Shop Pickup', priceCents: 0, address: ADDRESS,nativePickupLocationId:pickupRate.locationId },
    delivery: { approved: true, title: 'Local Delivery', priceCents: 442, address: ADDRESS, taxTreatment: 'exclusive', serviceAreaConfirmed: true }
  },...(nativePickup?{nativePickup:pickupRate}:{}) });
  draftInput.customAttributes.push({ key: 'nice_workshop_terms_version', value: 'v1' });
  if(nativePickup)draftInput.customAttributes.push({key:'nice_workshop_fulfillment_method',value:METHOD});
  const attempt = { id, cuts: quote.cuts, catalogue_snapshot: quote.catalogueSnapshot, catalogue_hash: quote.catalogueHash,
    quoted_subtotal_cents: String(quote.subtotalCents), currency: 'CAD', fulfillment, lead_time_days: 14,
    metadata: { shopDomain: SHOP, termsVersion: 'v1', acceptedTermsVersion: 'v1', acceptedAt: '2026-10-31T12:00:00Z',
      deliveryAddress: fulfillment === 'delivery' ? ADDRESS : null, fulfillmentAddress: ADDRESS, shippingPriceCents,
      taxPolicy: 'shopify_authoritative', draftInput,...(nativePickup?{fulfillmentMethod:METHOD,nativePickup:pickupRate}:{}) } };
  const tax = Math.round((quote.subtotalCents + shippingPriceCents) * 0.13);
  const payload = { id: orderId, updated_at: '2026-10-31T12:01:00Z', currency: 'CAD', presentment_currency: 'CAD',
    financial_status: 'paid', tax_exempt: false, taxes_included: false, test: false, cancelled_at: null, refunds: [],
    total_discounts: '0.00', current_total_discounts: '0.00', discount_codes: [], discount_applications: [],
    subtotal_price: format(quote.subtotalCents), current_subtotal_price: format(quote.subtotalCents),
    total_line_items_price: format(quote.subtotalCents), total_tax: format(tax), current_total_tax: format(tax),
    total_price: format(quote.subtotalCents + shippingPriceCents + tax), current_total_price: format(quote.subtotalCents + shippingPriceCents + tax),
    total_outstanding: '0.00', total_tip_received: '0.00',
    note_attributes: draftInput.customAttributes.map(({ key, value }) => ({ name: key, value })),
    shipping_address: nativePickup?null:{ address1: ADDRESS.address1, address2: null, city: ADDRESS.city, province_code: 'ON', country_code: 'CA', zip: 'K7V3Z8' },
    shipping_lines: [{ title: nativePickup?pickupRate.title:draftInput.shippingLine.title,price:format(shippingPriceCents),discounted_price:format(shippingPriceCents),discount_allocations:[],
      ...(nativePickup?{code:pickupRate.code,source:pickupRate.source,is_removed:false}:{}) }],
    line_items: draftInput.lineItems.map(line => ({ title: line.title, quantity: 1, current_quantity: 1,
      price: line.originalUnitPriceWithCurrency.amount, taxable: true, requires_shipping: true, product_id: null, variant_id: null,
      properties: line.customAttributes.map(({ key, value }) => ({ name: key, value })), total_discount: '0.00', discount_allocations: [] })) };
  return { attempt, payload };
}

test('money and Shopify IDs reject ambiguous/unsafe representations', () => {
  assert.equal(cents('4.42'), 442);
  assert.equal(cents('0'), 0);
  for (const value of [4.42, '-1.00', '1.005', '1e3', 'NaN', '9007199254740992.00']) assert.equal(cents(value), null);
  assert.equal(orderIdentifier({ id: Number.MAX_SAFE_INTEGER + 1 }, 'orders/paid'), null);
  assert.equal(orderIdentifier({ order_id: '123' }, 'refunds/create'), '123');
});

test('paid pickup/delivery snapshots accept exact groups and Shopify-authoritative tax', () => {
  for (const fulfillment of ['pickup', 'delivery']) {
    const { attempt, payload } = fixture({ fulfillment });
    assert.deepEqual(validateOrderSnapshot(payload, attempt, OPTIONS), { valid: true, reasons: [] });
    payload.total_tax = payload.current_total_tax = format(cents(payload.total_tax) + 1);
    payload.total_price = payload.current_total_price = format(cents(payload.total_price) + 1);
    assert.equal(validateOrderSnapshot(payload, attempt, OPTIONS).valid, true);
  }
});

test('altered cuts, price, quantity, metadata, discounts, address and currency fail closed', () => {
  const mutations = [
    p => { p.line_items[0].price = '0.01'; },
    p => { p.line_items[0].quantity = 2; },
    p => { p.line_items[0].current_quantity = 0; },
    p => { p.line_items[0].properties.find(x => x.name === '_nice_workshop_cut').value = '{}'; },
    p => { p.line_items[0].properties.push({ name: '_nice_workshop_cut', value: '{}' }); },
    p => { p.line_items[0].title = 'Changed specification'; },
    p => { p.line_items[0].total_discount = '0.01'; },
    p => { p.discount_codes.push({ code: 'FREE' }); },
    p => { p.discount_applications.push({ type: 'manual' }); },
    p => { p.total_discounts = '0.01'; },
    p => { p.currency = 'USD'; },
    p => { p.presentment_currency = 'USD'; },
    p => { p.shipping_lines[0].price = '10.00'; },
    p => { p.shipping_address.city = 'Ottawa'; },
    p => { p.shipping_address.address1 = '999 Different Road'; },
    p => { p.note_attributes[0].value = randomUUID(); },
    p => { p.note_attributes.push(clone(p.note_attributes[0])); },
    p => { p.total_outstanding = '1.00'; },
    p => { delete p.total_outstanding; },
    p => { p.line_items.pop(); },
    p => { p.line_items[0] = null; },
    p => { p.shipping_lines[0] = null; },
    p => { p.line_items[0].variant_id = 1; },
    p => { p.tax_exempt = true; },
    p => { p.current_subtotal_price = '0.00'; },
    p => { p.current_total_price = '0.00'; },
  ];
  for (const mutate of mutations) {
    const { attempt, payload } = fixture();
    mutate(payload);
    assert.equal(validateOrderSnapshot(payload, attempt, OPTIONS).valid, false, mutate.toString());
  }
});

test('test orders always stay held and corrupted trusted snapshots are held', () => {
  const { attempt, payload } = fixture();
  payload.test = true;
  assert.deepEqual(validateOrderSnapshot(payload, attempt, OPTIONS).reasons, ['test_order']);
  assert.equal(validateOrderSnapshot(payload, attempt, { ...OPTIONS, allowTestOrders: true }).valid, false);
  payload.test = false;
  const invalid = clone(attempt);
  invalid.quoted_subtotal_cents = '1';
  assert.ok(validateOrderSnapshot(payload, invalid, OPTIONS).reasons.includes('snapshot_invalid'));
  invalid.metadata = {};
  assert.ok(validateOrderSnapshot(payload, invalid, OPTIONS).reasons.includes('checkout_metadata_invalid'));
});

test('native pickup needs independent method/location proof and keeps legacy address validation',()=>{
  const {attempt,payload}=fixture({nativePickup:true});
  payload.billing_address={address1:'123 Example Street',city:'Gatineau',province_code:'QC',country_code:'CA',zip:'J8X1A1'};
  const options={...OPTIONS,pickupEvidence:{orderId:String(payload.id),valid:true}};
  assert.deepEqual(validateOrderSnapshot(payload,attempt,options),{valid:true,reasons:[]});
  for(const evidence of [undefined,{orderId:payload.id,valid:false},{orderId:'999',valid:true}]) {
    assert.ok(validateOrderSnapshot(payload,attempt,{...OPTIONS,pickupEvidence:evidence}).reasons.includes('native_pickup_mismatch'));
  }
  for(const alter of [p=>{p.shipping_lines[0].source='manual';},p=>{p.shipping_lines[0].code='Free delivery';},
    p=>{p.shipping_lines[0].price='4.42';},p=>{p.shipping_lines[0].is_removed=true;},
    p=>{p.shipping_address={address1:'Other address'};},p=>{p.note_attributes=p.note_attributes.filter(a=>a.name!=='nice_workshop_fulfillment_method');}]){
    const changed=clone(payload);alter(changed);assert.equal(validateOrderSnapshot(changed,attempt,options).valid,false);
  }
  const legacy=fixture();legacy.payload.shipping_address=null;
  assert.ok(validateOrderSnapshot(legacy.payload,legacy.attempt,OPTIONS).reasons.includes('fulfillment_address_mismatch'));
});

test('PostgreSQL webhook processing preserves production safety across retries and ordering', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL for real PostgreSQL event tests.'
}, async t => {
  const { Pool } = require('pg');
  const url = new URL(process.env.TEST_DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const options = poolOptions({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL: process.env.TEST_DATABASE_SSL || (local ? 'disable' : 'verify-full') });
  const admin = new Pool(options);
  const schema = `nice_events_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let sequence = 100000;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...options, options: `-c search_path=${schema}` });
    await migrate(pool);
    async function seed(options={}) {
      const result = fixture({ ...options,orderId: String(sequence++) });
      const a = result.attempt;
      await pool.query(`INSERT INTO checkout_attempts
        (id,idempotency_key,request_hash,cuts,catalogue_snapshot,catalogue_hash,quoted_subtotal_cents,fulfillment,lead_time_days,metadata)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,14,$9::jsonb)`,
      [a.id, randomUUID(), 'a'.repeat(64), JSON.stringify(a.cuts), JSON.stringify(a.catalogue_snapshot), a.catalogue_hash,
        a.quoted_subtotal_cents, a.fulfillment, JSON.stringify(a.metadata)]);
      return result;
    }
    async function enqueue(payload, topic = 'orders/paid') {
      return (await pool.query(`INSERT INTO webhook_deliveries(shop,webhook_id,topic,raw_body_hash,payload)
        VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`, [SHOP, randomUUID(), topic, 'b'.repeat(64), JSON.stringify(payload)])).rows[0].id;
    }
    async function order(payload) {
      return (await pool.query('SELECT * FROM orders WHERE shop=$1 AND shopify_order_id=$2', [SHOP, payload.id])).rows[0];
    }
    async function delivered(payload, topic = 'orders/paid') {
      const id = await enqueue(payload, topic);
      return processWebhook(pool, id, OPTIONS);
    }

    await t.test('paid snapshots insert once and replay creates no duplicate audit or order', async () => {
      const { attempt, payload } = await seed();
      const id = await enqueue(payload);
      const first = await processWebhook(pool, id, OPTIONS);
      assert.equal(first.state, 'processed');
      const row = await order(payload);
      assert.equal(row.payment_status, 'paid');
      assert.equal(row.hold_reason, null);
      assert.equal(row.is_cut, false);
      assert.deepEqual(row.cuts, attempt.cuts);
      assert.equal((await processWebhook(pool, id, OPTIONS)).reused, true);
      await delivered(payload);
      assert.equal((await pool.query('SELECT count(*) FROM orders WHERE checkout_attempt_id=$1', [attempt.id])).rows[0].count, '1');
      assert.equal((await pool.query('SELECT count(*) FROM audit_log WHERE order_id=$1', [row.id])).rows[0].count, '1');
    });

    await t.test('refund before payment is retained and holds the first production record', async () => {
      const { payload } = await seed();
      const refundId = await enqueue({ id: '800', order_id: payload.id, created_at: '2026-10-31T12:02:00Z' }, 'refunds/create');
      assert.equal((await processWebhook(pool, refundId, OPTIONS)).code, 'ORDER_NOT_FOUND');
      await delivered(payload);
      const row = await order(payload);
      assert.equal(row.refunded, true);
      assert.equal(row.hold_reason, 'refund_review');
      await processWebhookBatch(pool, OPTIONS);
      assert.equal((await pool.query('SELECT state FROM webhook_deliveries WHERE id=$1', [refundId])).rows[0].state, 'processed');
    });

    await t.test('test purchases persist but cannot be marked cut', async () => {
      const { payload } = await seed();
      payload.test = true;
      assert.equal((await delivered(payload)).state, 'processed');
      const row = await order(payload);
      assert.equal(row.hold_reason, 'test_order');
      await assert.rejects(setOrderCut(pool, { orderId: row.id, isCut: true, expectedRevision: row.revision, actor: 'staff:owner' }), { code: 'production_hold' });
    });

    await t.test('cancellation before payment cannot be released by a late paid event', async () => {
      const { payload } = await seed();
      const cancelled = { ...payload, updated_at: '2026-10-31T12:02:00Z', cancelled_at: '2026-10-31T12:02:00Z' };
      assert.equal((await delivered(cancelled, 'orders/cancelled')).code, 'ORDER_NOT_FOUND');
      await delivered(payload);
      const row = await order(payload);
      assert.equal(row.hold_reason, 'cancelled');
      assert.ok(row.cancelled_at);
      await delivered({ ...payload, updated_at: '2026-10-31T12:03:00Z' }, 'orders/updated');
      assert.equal((await order(payload)).hold_reason, 'cancelled');
    });

    await t.test('edits hold the order without changing cut specifications or completion', async () => {
      const { payload, attempt } = await seed();
      await delivered(payload);
      const row = await order(payload);
      const cut = await setOrderCut(pool, { orderId: row.id, isCut: true, expectedRevision: row.revision, actor: 'staff:owner' });
      const changed = clone(payload);
      changed.updated_at = '2026-10-31T12:02:00Z';
      changed.line_items[0].properties.find(p => p.name === '_nice_workshop_cut').value = '{}';
      assert.equal((await delivered(changed, 'orders/updated')).state, 'needs_reconciliation');
      const held = await order(payload);
      assert.equal(held.hold_reason, 'cut_lines_mismatch');
      assert.deepEqual(held.cuts, attempt.cuts);
      assert.equal(held.is_cut, true);
      assert.equal(held.cut_by, cut.cut_by);
      assert.equal(held.cut_at.toISOString(), cut.cut_at.toISOString());
      await delivered({ ...payload, updated_at: '2026-10-31T12:03:00Z' }, 'orders/updated');
      assert.equal((await order(payload)).hold_reason, 'cut_lines_mismatch');
    });

    await t.test('older unpaid events cannot downgrade newer paid state; older refunds still hold', async () => {
      const { payload } = await seed();
      await delivered(payload);
      await delivered({ ...payload, financial_status: 'pending', updated_at: '2026-10-31T12:00:00Z', total_outstanding: payload.total_price }, 'orders/updated');
      assert.equal((await order(payload)).payment_status, 'paid');
      assert.equal((await order(payload)).hold_reason, null);
      await delivered({ ...payload, financial_status: 'refunded', updated_at: '2026-10-31T12:00:00Z' }, 'orders/updated');
      assert.equal((await order(payload)).refunded, true);
      assert.equal((await order(payload)).hold_reason, 'refund_review');
    });

    await t.test('unknown references and unpaid events never invent cuts', async () => {
      const unknown = fixture({ orderId: String(sequence++) }).payload;
      assert.equal((await delivered(unknown)).code, 'CHECKOUT_NOT_FOUND');
      assert.equal(await order(unknown), undefined);
      const { payload } = await seed();
      payload.financial_status = 'authorized';
      assert.equal((await delivered(payload, 'orders/updated')).code, 'ORDER_NOT_PAID');
      assert.equal(await order(payload), undefined);
    });

    await t.test('two remote orders cannot claim one checkout snapshot', async () => {
      const { payload, attempt } = await seed();
      await delivered(payload);
      const second = { ...payload, id: String(sequence++) };
      assert.equal((await delivered(second)).code, 'CHECKOUT_ALREADY_LINKED');
      assert.equal(await order(second), undefined);
      assert.equal((await pool.query('SELECT count(*) FROM orders WHERE checkout_attempt_id=$1', [attempt.id])).rows[0].count, '1');
    });

    await t.test('concurrent workers claim deliveries once and serialize one order', async () => {
      const { payload } = await seed();
      const ids = await Promise.all([enqueue(payload), enqueue({ ...payload, updated_at: '2026-10-31T12:02:00Z' }, 'orders/updated')]);
      await Promise.all([processWebhookBatch(pool, { ...OPTIONS, limit: 10 }), processWebhookBatch(pool, { ...OPTIONS, limit: 10 })]);
      assert.equal((await order(payload)).shopify_updated_at.toISOString(), '2026-10-31T12:02:00.000Z');
      const rows = (await pool.query('SELECT state,attempts FROM webhook_deliveries WHERE id=ANY($1::bigint[])', [ids])).rows;
      assert.ok(rows.every(row => row.state === 'processed' && row.attempts === 1));
    });

    await t.test('audit failures roll back order changes and inbox acknowledgement', async () => {
      const { payload } = await seed();
      const id = await enqueue(payload);
      await pool.query(`CREATE FUNCTION reject_webhook_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'audit test failure'; END; $$;
        CREATE TRIGGER reject_webhook_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_webhook_audit();`);
      await assert.rejects(processWebhook(pool, id, OPTIONS), /audit test failure/);
      assert.equal(await order(payload), undefined);
      assert.deepEqual((await pool.query('SELECT state,attempts FROM webhook_deliveries WHERE id=$1', [id])).rows[0], { state: 'pending', attempts: 0 });
      await pool.query('DROP TRIGGER reject_webhook_audit ON audit_log');
      assert.equal((await processWebhook(pool, id, OPTIONS)).state, 'processed');
    });

    await t.test('native pickup routing delay retries safely; matching method/location accepts and cancellation remains immediate',async()=>{
      const {payload,attempt}=await seed({nativePickup:true});payload.test=true;
      const id=await enqueue(payload);
      await assert.rejects(processWebhook(pool,id,OPTIONS),{code:'NATIVE_PICKUP_UNAVAILABLE'});
      assert.equal(await order(payload),undefined);
      assert.equal((await pool.query('SELECT state FROM webhook_deliveries WHERE id=$1',[id])).rows[0].state,'pending');
      let routingReady=false,calls=0;
      const client={shopDomain:SHOP,request:async(query,{id:remoteId})=>{
        calls++;assert.equal(query,PICKUP_PROOF);assert.equal(remoteId,`gid://shopify/Order/${payload.id}`);
        return {order:{id:remoteId,shippingLine:{custom:false,code:'Shop location',source:'shopify',title:'Shop location'},
          fulfillmentOrders:{nodes:routingReady?[{deliveryMethod:{methodType:'PICK_UP'},assignedLocation:{location:{id:attempt.metadata.nativePickup.locationId}}}]:[],pageInfo:{hasNextPage:false}}}};
      }};
      await assert.rejects(processWebhook(pool,id,{...OPTIONS,shopifyClient:client}),{code:'NATIVE_PICKUP_UNAVAILABLE'});
      assert.equal(await order(payload),undefined);routingReady=true;
      assert.equal((await processWebhook(pool,id,{...OPTIONS,shopifyClient:client})).state,'processed');
      assert.equal((await order(payload)).hold_reason,'test_order');
      const before=calls;
      const cancelled={...payload,updated_at:'2026-10-31T12:03:00Z',cancelled_at:'2026-10-31T12:03:00Z'};
      const cancellation=await enqueue(cancelled,'orders/cancelled');
      assert.equal((await processWebhook(pool,cancellation,OPTIONS)).state,'processed'); // Adverse holds need no API connection.
      assert.ok((await order(payload)).cancelled_at);assert.equal(calls,before);
    });

    await t.test('deferred pickup proof cannot starve later refunds or ready-email processing across bounded batches',async()=>{
      const waiting=await seed({nativePickup:true});
      const waitingId=await enqueue(waiting.payload);
      const refunded=await seed();await delivered(refunded.payload);
      const refundId=await enqueue({id:'900',order_id:refunded.payload.id},'refunds/create');
      const ready=await seed();await delivered(ready.payload);
      const productionOrder=await order(ready.payload);
      const cut=await setOrderCut(pool,{orderId:productionOrder.id,isCut:true,expectedRevision:productionOrder.revision,actor:'owner'});
      let sends=0;
      const sender={send:async({to})=>{sends++;return {accepted:[to]};}};
      const recipientClient={shopDomain:SHOP,request:async query=>{
        assert.equal(query,ORDER_NOTIFICATION_RECIPIENT);
        return {order:{id:`gid://shopify/Order/${ready.payload.id}`,name:'#QUEUE-TEST',email:'queue@example.test',
          test:false,cancelledAt:null,displayFinancialStatus:'PAID',updatedAt:ready.payload.updated_at,refunds:[],
          customAttributes:[{key:'nice_workshop_reference',value:ready.attempt.id}]}};
      }};
      await markOrderReady(pool,{orderId:cut.id,expectedRevision:cut.revision,actor:'owner',shopifyClient:recipientClient,mailSender:sender});
      const unavailable={shopDomain:SHOP,request:async()=>{throw new ShopifyError('SHOPIFY_GRAPHQL_ERROR','Unavailable');}};
      const first=await processWebhookBatch(pool,{...OPTIONS,shopifyClient:unavailable,limit:1});
      assert.equal(first[0].id,waitingId);assert.equal(first[0].code,'NATIVE_PICKUP_RETRY');
      const second=await processWebhookBatch(pool,{...OPTIONS,shopifyClient:unavailable,limit:1});
      assert.equal(second[0].id,refundId);assert.equal(second[0].state,'processed');
      assert.equal((await order(refunded.payload)).refunded,true);
      const third=await processWebhookBatch(pool,{...OPTIONS,shopifyClient:unavailable,limit:20});
      assert.equal(third.length,1); // Never retry the same failed lookup within one batch.
      await processNotificationBatch(pool,{shopifyClient:recipientClient,mailSender:sender});
      assert.equal(sends,1);
      const inbox=(await pool.query('SELECT state,attempts,last_error_code FROM webhook_deliveries WHERE id=$1',[waitingId])).rows[0];
      assert.deepEqual(inbox,{state:'pending',attempts:2,last_error_code:'NATIVE_PICKUP_RETRY'});
      assert.equal(await order(waiting.payload),undefined);
    });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
