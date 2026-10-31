'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {findNativePickup,nativePickupEvidence,waitForReadyDraft,PICKUP_OPTIONS,PICKUP_PROOF,READY_DRAFT}=require('../server/native-pickup');
const shopDomain='nice-test.myshopify.com';
const rate={locationId:'gid://shopify/Location/94464344279',handle:'fresh-rate',source:'shopify',code:'Shop location',title:'Shop location'};

test('pickup lookup searches complete pages and pins the approved location, never the first rate',async()=>{
  const offsets=[];
  const client={shopDomain,request:async(query,variables)=>{
    assert.equal(query,PICKUP_OPTIONS);assert.equal(variables.input.shippingAddress,undefined);offsets.push(variables.offset);
    return {draftOrderAvailableDeliveryOptions:{availableLocalPickupOptions:variables.offset===0
      ? [{...rate,locationId:'gid://shopify/Location/999'}]:[rate],pageInfo:{hasNextPage:variables.offset===0}}};
  }};
  assert.deepEqual(await findNativePickup(client,[{title:'Cut group'}],rate.locationId),rate);
  assert.deepEqual(offsets,[0,25]);
  client.request=async()=>({draftOrderAvailableDeliveryOptions:{availableLocalPickupOptions:[rate,rate],pageInfo:{hasNextPage:false}}});
  await assert.rejects(findNativePickup(client,[{}],rate.locationId),{code:'NATIVE_PICKUP_UNAVAILABLE'});
});

test('native paid-order proof requires actual pickup at the approved location, not a matching title alone',async()=>{
  const node={deliveryMethod:{methodType:'PICK_UP'},assignedLocation:{location:{id:rate.locationId}}};
  const base={id:'gid://shopify/Order/123',shippingLine:{custom:false,code:rate.code,source:rate.source,title:rate.title},
    fulfillmentOrders:{nodes:[node],pageInfo:{hasNextPage:false}}};
  let order=structuredClone(base);
  const client={shopDomain,request:async(query,{id})=>{assert.equal(query,PICKUP_PROOF);assert.equal(id,base.id);return {order};}};
  assert.deepEqual(await nativePickupEvidence(client,shopDomain,'123',rate),{orderId:'123',valid:true});
  for(const alter of [o=>{o.fulfillmentOrders.nodes[0].deliveryMethod.methodType='SHIPPING';},
    o=>{o.fulfillmentOrders.nodes[0].assignedLocation.location.id='gid://shopify/Location/999';},
    o=>{o.shippingLine.custom=true;},o=>{o.shippingLine.source='manual';},o=>{o.fulfillmentOrders.pageInfo.hasNextPage=true;}]){
    order=structuredClone(base);alter(order);assert.equal((await nativePickupEvidence(client,shopDomain,'123',rate)).valid,false);
  }
  order=structuredClone(base);order.fulfillmentOrders.nodes=[];
  await assert.rejects(nativePickupEvidence(client,shopDomain,'123',rate),{code:'NATIVE_PICKUP_UNAVAILABLE'});
});

test('readiness polling reads only the original draft and is bounded',async()=>{
  const id='gid://shopify/DraftOrder/123';let reads=0;const waits=[];
  const client={request:async(query,variables)=>{
    assert.equal(query,READY_DRAFT);assert.deepEqual(variables,{id});reads++;return {draftOrder:{id,ready:reads===2,invoiceUrl:'https://nice-test.myshopify.com/invoice'}};
  }};
  assert.equal((await waitForReadyDraft(client,{id,ready:false},{sleep:async ms=>waits.push(ms)})).ready,true);
  assert.equal(reads,2);assert.deepEqual(waits,[200,400]);
  reads=0;client.request=async()=>{reads++;return {draftOrder:{id,ready:false}};};
  assert.equal((await waitForReadyDraft(client,{id,ready:false},{sleep:async()=>{}})).ready,false);assert.equal(reads,7);
  client.request=async()=>({draftOrder:{id:'gid://shopify/DraftOrder/999',ready:true}});
  await assert.rejects(waitForReadyDraft(client,{id,ready:false},{sleep:async()=>{}}),{code:'NATIVE_PICKUP_UNAVAILABLE'});
});
