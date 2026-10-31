'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {markOrderReady,processNotificationBatch,markStaleNotificationsForReview} = require('../server/notifications');
const {migrate,poolOptions,setOrderCut,listOrders,readyBlockReason} = require('../server/db');
const {buildQuote} = require('../server/quote');
const {buildDraftOrderInput,ORDER_NOTIFICATION_RECIPIENT} = require('../server/shopify');
const {processWebhook} = require('../server/process-webhooks');
const {fulfillmentConfig} = require('../server/settings');

const SHOP = 'nice-test.myshopify.com';
const WHEN = '2026-10-31T12:00:00Z';

test('readiness validates its owner action and remains off without configured mail', async () => {
  const pool = {connect(){throw new Error('must not connect');}};
  await assert.rejects(markOrderReady(pool,{orderId:'bad',expectedRevision:1,actor:'owner'}),{code:'invalid_ready_update'});
  await assert.rejects(markOrderReady(pool,{orderId:randomUUID(),expectedRevision:1,actor:'owner'}),{code:'notification_unconfigured'});
  const valid = {payment_status:'paid',is_cut:true,hold_reason:null,refunded:false,cancelled_at:null};
  assert.equal(readyBlockReason(valid),null);
  assert.match(readyBlockReason({...valid,hold_reason:'test_order'}),/Test orders/);
});

test('PostgreSQL readiness and notification delivery remain separate, durable and duplicate-safe', {
  skip:process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL for real PostgreSQL notification tests.'
}, async t => {
  const {Pool} = require('pg');
  const url = new URL(process.env.TEST_DATABASE_URL);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const options = poolOptions({...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,
    DATABASE_SSL:process.env.TEST_DATABASE_SSL || (local ? 'disable':'verify-full')});
  const admin = new Pool(options);
  const schema = `nice_mail_${randomUUID().replaceAll('-','')}`;
  let pool;
  const remotes = new Map();
  let sequence = 200000;
  const sent = [];
  const sender = {send:async message => {sent.push(message);return {messageId:message.messageId,accepted:[message.to]};}};
  const client = {shopDomain:SHOP,request:async (query,{id}) => {
    assert.equal(query,ORDER_NOTIFICATION_RECIPIENT); return {order:remotes.get(id)};
  }};
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({...options,options:`-c search_path=${schema}`});
    await migrate(pool);
    async function seed({fulfillment='pickup',isCut=true,payment='paid',hold=null,refund=false,cancelled=false} = {}) {
      const id=randomUUID(),attemptId=randomUUID(),remoteId=String(sequence++);
      const quote=buildQuote({cuts:[{sheetId:'birch-12-7',shape:'circle',widthUnits:1000000,heightUnits:1000000,quantity:2}],fulfillment});
      const address={address1:'123 Test Road',city:'Renfrew',provinceCode:'ON',countryCode:'CA',zip:'K7V 3Z8'};
      const config={...fulfillmentConfig,delivery:{...fulfillmentConfig.delivery,address}};
      const draft=buildDraftOrderInput(quote,{reference:attemptId,taxPolicy:'shopify_authoritative',fulfillmentConfig:config});
      const metadata={shopDomain:SHOP,termsVersion:'v1',acceptedTermsVersion:'v1',fulfillmentAddress:draft.shippingAddress,
        deliveryAddress:fulfillment==='delivery'?address:null,shippingPriceCents:fulfillment==='delivery'?442:0,
        taxPolicy:'shopify_authoritative',draftInput:draft};
      await pool.query(`INSERT INTO checkout_attempts
        (id,idempotency_key,request_hash,cuts,catalogue_snapshot,catalogue_hash,quoted_subtotal_cents,fulfillment,lead_time_days,metadata)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,14,$9::jsonb)`,
      [attemptId,randomUUID(),'a'.repeat(64),JSON.stringify(quote.cuts),JSON.stringify(quote.catalogueSnapshot),quote.catalogueHash,
        quote.subtotalCents,fulfillment,JSON.stringify(metadata)]);
      await pool.query(`INSERT INTO orders(id,shop,shopify_order_id,checkout_attempt_id,cuts,payment_status,hold_reason,refunded,
        cancelled_at,is_cut,cut_at,cut_by,shopify_updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,SHOP,remoteId,attemptId,JSON.stringify(quote.cuts),payment,hold,refund,cancelled?WHEN:null,isCut,isCut?WHEN:null,isCut?'owner':null,WHEN]);
      const remote={id:`gid://shopify/Order/${remoteId}`,name:`#${remoteId}`,email:`customer-${remoteId}@example.test`,
        test:false,cancelledAt:null,displayFinancialStatus:'PAID',updatedAt:WHEN,refunds:[],
        customAttributes:[{key:'nice_workshop_reference',value:attemptId}]};
      remotes.set(remote.id,remote);
      return {id,remoteId,remote,quote};
    }
    const mark=(order,extra={})=>markOrderReady(pool,{orderId:order.id,expectedRevision:1,actor:'owner',mailSender:sender,shopifyClient:client,...extra});
    const run=(extra={})=>processNotificationBatch(pool,{shopDomain:SHOP,shopifyClient:client,mailSender:sender,limit:100,...extra});
    const row=async order=>(await pool.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0];
    const notices=async order=>(await pool.query('SELECT * FROM notification_outbox WHERE order_id=$1 ORDER BY generation',[order.id])).rows;
    async function enqueue(order,topic,payload) {
      return (await pool.query(`INSERT INTO webhook_deliveries(shop,webhook_id,topic,raw_body_hash,payload)
        VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,[SHOP,randomUUID(),topic,'b'.repeat(64),JSON.stringify(payload)])).rows[0].id;
    }

    await t.test('concurrent owner clicks queue once; multiple workers submit once with immutable content',async()=>{
      const order=await seed();
      const results=await Promise.all([mark(order),mark(order)]);
      assert.deepEqual(results.map(r=>r.reused).sort(),[false,true]);
      assert.equal((await notices(order)).length,1);
      assert.equal(sent.length,0);
      const ready=await row(order);
      assert.equal(ready.is_cut,true);assert.ok(ready.ready_at);assert.equal(ready.ready_generation,1);assert.equal(ready.revision,2);
      assert.deepEqual(ready.cuts,order.quote.cuts);
      const n=(await notices(order))[0];
      assert.equal(n.recipient,order.remote.email);assert.match(n.text_body,/diameter/);
      await assert.rejects(pool.query("UPDATE notification_outbox SET recipient='other@example.test' WHERE id=$1",[n.id]),{code:'23514'});
      const list=(await listOrders(pool,{notificationEnabled:true})).find(o=>o.id===order.id);
      assert.equal(list.fulfillment,'pickup');assert.equal(list.ready_eligible,false);assert.equal(list.latest_notification.state,'queued');
      assert.equal(list.metadata,undefined);assert.equal(list.latest_notification.recipient,undefined);
      await run({mailSender:null});assert.equal((await notices(order))[0].state,'queued');
      await Promise.all([run(),run()]);
      assert.equal(sent.filter(m=>m.to===order.remote.email).length,1);
      assert.equal((await notices(order))[0].state,'sent');
      assert.equal((await mark(order)).reused,true);
      await run();assert.equal(sent.filter(m=>m.to===order.remote.email).length,1);
    });

    await t.test('unpaid, uncut, refunded, cancelled, held and test orders cannot queue',async()=>{
      for(const state of [{payment:'authorized'},{isCut:false},{refund:true},{cancelled:true},{hold:'test_order'},{hold:'cut_lines_mismatch'}]) {
        const order=await seed(state);
        await assert.rejects(mark(order),{code:'ready_ineligible'});
        assert.equal((await notices(order)).length,0);assert.equal((await row(order)).ready_at,null);
      }
      const order=await seed();order.remote.test=true;
      await assert.rejects(mark(order),{code:'SHOPIFY_ORDER_NOT_READY'});
      assert.equal((await notices(order)).length,0);
    });

    await t.test('stale revision and changed Shopify contact evidence cannot commit readiness',async()=>{
      const order=await seed();
      await assert.rejects(mark(order,{expectedRevision:99}),{code:'stale_revision'});
      order.remote.email=null;await assert.rejects(mark(order),{code:'SHOPIFY_ORDER_CONTACT_REQUIRED'});
      assert.equal((await row(order)).ready_at,null);
      assert.equal((await notices(order)).length,0);
    });

    await t.test('readiness, outbox and audit commit together or all roll back',async()=>{
      await pool.query(`CREATE FUNCTION reject_ready_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event='order_ready' THEN RAISE EXCEPTION 'test ready audit failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER reject_ready_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_ready_audit();`);
      const order=await seed();
      await assert.rejects(mark(order),/test ready audit failure/);
      assert.equal((await row(order)).ready_at,null);assert.equal((await row(order)).revision,1);
      assert.equal((await notices(order)).length,0);
      await pool.query('DROP TRIGGER reject_ready_audit ON audit_log');
    });

    await t.test('an order changed during Shopify lookup cannot commit an old readiness decision',async()=>{
      const order=await seed();
      const changingClient={...client,request:async(query,variables)=>{
        await setOrderCut(pool,{orderId:order.id,isCut:false,expectedRevision:1,actor:'owner',reason:'Correction during lookup'});
        return client.request(query,variables);
      }};
      await assert.rejects(mark(order,{shopifyClient:changingClient}),{code:'stale_revision'});
      assert.equal((await row(order)).ready_at,null);assert.equal((await notices(order)).length,0);
    });

    await t.test('queued pickup and drop-off messages use immutable fulfillment and current verified contact',async()=>{
      const order=await seed({fulfillment:'delivery'});await mark(order);
      const n=(await notices(order))[0];assert.equal(n.kind,'delivery');assert.match(n.text_body,/123 Test Road/);
      order.remote.email='changed@example.test';await run();
      assert.equal((await notices(order))[0].state,'failed');
      assert.equal(sent.filter(m=>m.to===order.remote.email||m.to===n.recipient).length,0);
      await run();assert.equal((await notices(order))[0].attempts,1);
    });

    await t.test('pending Shopify events defer delivery and cancellation/refund invalidates readiness',async()=>{
      for(const topic of ['refunds/create','orders/cancelled']) {
        const order=await seed();await mark(order);
        const payload=topic==='refunds/create'?{id:'800',order_id:order.remoteId}
          :{id:order.remoteId,cancelled_at:'2026-10-31T13:00:00Z',updated_at:'2026-10-31T13:00:00Z',financial_status:'paid',test:false};
        const event=await enqueue(order,topic,payload);
        await run();assert.equal((await notices(order))[0].state,'queued');
        await processWebhook(pool,event,{shopDomain:SHOP});
        assert.equal((await row(order)).ready_at,null);assert.equal((await notices(order))[0].state,'cancelled');
        await run();assert.equal(sent.filter(m=>m.to===order.remote.email).length,0);
      }
    });

    await t.test('reopening cutting cancels unsent mail; explicit later readiness gets a new generation',async()=>{
      const order=await seed();await mark(order);
      const reopened=await setOrderCut(pool,{orderId:order.id,isCut:false,expectedRevision:2,actor:'owner',reason:'Cutting correction'});
      assert.equal(reopened.ready_at,null);assert.equal((await notices(order))[0].state,'cancelled');
      const cut=await setOrderCut(pool,{orderId:order.id,isCut:true,expectedRevision:reopened.revision,actor:'owner'});
      const again=await mark(order,{expectedRevision:cut.revision});assert.equal(again.order.ready_generation,2);
      await run();assert.equal(sent.filter(m=>m.to===order.remote.email).length,1);
      assert.deepEqual((await notices(order)).map(n=>n.state),['cancelled','sent']);
    });

    await t.test('definite rejection and ambiguous SMTP outcomes never automatically retry',async()=>{
      for(const outcome of ['rejected','unknown']) {
        const order=await seed();await mark(order);let calls=0;
        const failing={send:async()=>{calls++;throw Object.assign(new Error('private SMTP detail'),{deliveryOutcome:outcome});}};
        await run({mailSender:failing});await run({mailSender:failing});
        const n=(await notices(order))[0];assert.equal(calls,1);assert.equal(n.state,outcome==='rejected'?'failed':'needs_review');
        assert.doesNotMatch(JSON.stringify(n),/private SMTP detail/);
        assert.equal((await mark(order)).reused,true);
      }
    });

    await t.test('reopening while SMTP is in flight retains accepted-but-needs-review history',async()=>{
      const order=await seed();await mark(order);let started,finish;
      const began=new Promise(resolve=>{started=resolve;});
      const sending=run({mailSender:{send:async message=>{started();return new Promise(resolve=>{finish=()=>resolve({accepted:[message.to]});});}}});
      await began;
      const reopened=await setOrderCut(pool,{orderId:order.id,isCut:false,expectedRevision:2,actor:'owner',reason:'Correction before pickup'});
      finish();await sending;
      const n=(await notices(order))[0];assert.equal(n.state,'needs_review');assert.ok(n.sent_at);
      const cut=await setOrderCut(pool,{orderId:order.id,isCut:true,expectedRevision:reopened.revision,actor:'owner'});
      await assert.rejects(mark(order,{expectedRevision:cut.revision}),{code:'ready_ineligible'});
      assert.equal((await notices(order)).length,1);
    });

    await t.test('crash after SMTP acceptance becomes review, never a duplicate submission',async()=>{
      const order=await seed();await mark(order);
      await pool.query(`CREATE FUNCTION reject_sent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event='notification_accepted' THEN RAISE EXCEPTION 'test accepted audit failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER reject_sent_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_sent_audit();`);
      await assert.rejects(run(),/test accepted audit failure/);
      assert.equal((await notices(order))[0].state,'sending');
      await pool.query('DROP TRIGGER reject_sent_audit ON audit_log');
      await run();assert.equal(sent.filter(m=>m.to===order.remote.email).length,1);
      await pool.query("UPDATE notification_outbox SET sending_at=now()-interval '11 minutes' WHERE order_id=$1",[order.id]);
      await markStaleNotificationsForReview(pool,SHOP);
      assert.equal((await notices(order))[0].state,'needs_review');
      assert.equal((await notices(order))[0].last_error_code,'EMAIL_OUTCOME_UNKNOWN');
      await run();assert.equal(sent.filter(m=>m.to===order.remote.email).length,1);
    });
  } finally {
    if(pool)await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  }
});
