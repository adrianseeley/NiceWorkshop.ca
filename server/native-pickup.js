'use strict';

const {ShopifyError,validateShopDomain} = require('./shopify');

const PICKUP_OPTIONS = `query NiceWorkshopPickupOptions($input: DraftOrderAvailableDeliveryOptionsInput!, $offset: Int!) {
  draftOrderAvailableDeliveryOptions(input:$input, localPickupCount:25, localPickupFrom:$offset) {
    availableLocalPickupOptions { locationId handle code source title }
    pageInfo { hasNextPage }
  }
}`;
const PICKUP_PROOF = `query NiceWorkshopPickupProof($id: ID!) {
  order(id:$id) {
    id shippingLine { custom code source title }
    fulfillmentOrders(first:100, displayable:true) {
      nodes { deliveryMethod { methodType } assignedLocation { location { id } } }
      pageInfo { hasNextPage }
    }
  }
}`;
const READY_DRAFT = `query NiceWorkshopReadyDraft($id: ID!) {
  draftOrder(id:$id) { id invoiceUrl ready shippingLine { custom deliveryCategory code source title } }
}`;
const METHOD = 'native_pickup_v1';
const locationPattern = /^gid:\/\/shopify\/Location\/[1-9]\d*$/;
const cleanString = (value,max=150) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function unavailable() {
  return new ShopifyError('NATIVE_PICKUP_UNAVAILABLE','Shopify pickup is not ready. Try again shortly or contact the workshop.',{statusCode:503});
}

/** Read current native pickup rates. Custom-line lookup needs no customer address. */
async function findNativePickup(client,lineItems,locationId) {
  validateShopDomain(client?.shopDomain);
  if (!locationPattern.test(locationId || '') || !Array.isArray(lineItems) || !lineItems.length) throw unavailable();
  const matches=[];
  for (let offset=0;offset<250;offset+=25) {
    const data=await client.request(PICKUP_OPTIONS,{input:{lineItems,marketRegionCountryCode:'CA',acceptAutomaticDiscounts:false},offset});
    const result=data?.draftOrderAvailableDeliveryOptions;
    if (!Array.isArray(result?.availableLocalPickupOptions) || typeof result.pageInfo?.hasNextPage !== 'boolean') throw unavailable();
    matches.push(...result.availableLocalPickupOptions.filter(rate=>rate?.locationId===locationId));
    if (!result.pageInfo.hasNextPage) {
      if (matches.length !== 1) throw unavailable();
      const rate=matches[0];
      if (!cleanString(rate.handle,2048) || !['code','source','title'].every(key=>cleanString(rate[key]))) throw unavailable();
      return {locationId,handle:rate.handle,code:rate.code,source:rate.source,title:rate.title};
    }
  }
  throw unavailable();
}

/** Paid webhooks omit pickup/location identifiers, so verify both via Shopify.
 * Empty routing results are retried later: Shopify creates fulfillment orders
 * asynchronously. A known different delivery method/location is a mismatch.
 * Requires read_merchant_managed_fulfillment_orders in the runtime app.
 */
async function nativePickupEvidence(client,shopDomain,orderId,expected) {
  if (!client || validateShopDomain(client.shopDomain) !== shopDomain || !/^[1-9]\d{0,29}$/.test(orderId)
    || !locationPattern.test(expected?.locationId || '')) throw unavailable();
  const id=`gid://shopify/Order/${orderId}`;
  const data=await client.request(PICKUP_PROOF,{id});
  const order=data?.order;
  const fulfillment=order?.fulfillmentOrders;
  if (order?.id !== id || !Array.isArray(fulfillment?.nodes) || !fulfillment.nodes.length
    || typeof fulfillment.pageInfo?.hasNextPage !== 'boolean') throw unavailable();
  const shipping=order.shippingLine;
  return {orderId,valid:fulfillment.pageInfo.hasNextPage===false && shipping?.custom===false
    && ['code','source','title'].every(key=>shipping[key]===expected[key])
    && fulfillment.nodes.every(node=>node?.deliveryMethod?.methodType==='PICK_UP'
      && node.assignedLocation?.location?.id===expected.locationId)};
}

/** Poll only the already-created draft; never repeat a create mutation. */
async function waitForReadyDraft(client,draft,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if (!/^gid:\/\/shopify\/DraftOrder\/[1-9]\d*$/.test(draft?.id || '')) throw unavailable();
  const id=draft.id;
  for (const delay of [200,400,800,1600,2400,3200,4000]) {
    if (draft.ready===true) return draft;
    await sleep(delay);
    const data=await client.request(READY_DRAFT,{id});
    if (data?.draftOrder?.id !== id) throw unavailable();
    draft=data.draftOrder;
  }
  return draft;
}

function confirmedPickupDraft(draft,expected) {
  return draft?.shippingLine?.custom===false && draft.shippingLine.deliveryCategory==='pick-up'
    && ['code','source','title'].every(key=>draft.shippingLine[key]===expected[key]);
}

module.exports={METHOD,PICKUP_OPTIONS,PICKUP_PROOF,READY_DRAFT,findNativePickup,nativePickupEvidence,waitForReadyDraft,confirmedPickupDraft};
