'use strict';
const { DELIVERY_PRICE_CENTS } = require('./shopify');
const TERMS_VERSION = '2026-10-31';
const PICKUP_ADDRESS = {address1:'1019 Castleford Road',city:'Renfrew',provinceCode:'ON',countryCode:'CA',zip:'K7V 3Z8'};
const fulfillmentConfig = {
  pickup: {approved:true,title:'Free driveway pickup',priceCents:0,address:PICKUP_ADDRESS},
  delivery: {approved:true,title:'Local drop-off',priceCents:DELIVERY_PRICE_CENTS,taxTreatment:'exclusive',serviceAreaConfirmed:true}
};
function checkoutSettings(env, pool, shopifyClient) {
  const mode = env.CHECKOUT_MODE;
  const connected = !!pool && !!shopifyClient && !!env.PUBLIC_ORIGIN;
  const confirmed = (mode === 'test' && env.SHOPIFY_TEST_MODE_CONFIRMED === 'true')
    || (mode === 'live' && env.HST_REGISTRATION_CONFIRMED === 'true' && env.LIVE_CHECKOUT_VERIFIED === 'true');
  const enabled = env.CHECKOUT_ENABLED === 'true' && connected && confirmed;
  return {checkoutEnabled:enabled,mode:enabled ? mode : 'closed',termsVersion:TERMS_VERSION,
    deliveryPriceCents:DELIVERY_PRICE_CENTS,pickupAddress:'1019 Castleford Road, Renfrew, ON K7V 3Z8'};
}
module.exports = { TERMS_VERSION, fulfillmentConfig, checkoutSettings };
