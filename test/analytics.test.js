'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'analytics.js'), 'utf8');
const CONFIG = {enabled:true,projectToken:'phc_testproject1234567890',host:'https://us.i.posthog.com',publicOrigin:'https://www.niceworkshop.ca'};
const CONSENT_KEY = 'niceworkshop.analytics.consent.v1';
const OWNER_KEY = 'niceworkshop.analytics.owner.v1';
const SESSION_KEY = 'niceworkshop.analytics.session.v1';

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {getItem:key => data.get(key) ?? null,setItem:(key,value) => data.set(key,value),removeItem:key => data.delete(key),data};
}
function target() {
  const listeners = new Map();
  return {
    addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
    emit(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); }};
}
function browser(options = {}) {
  let now = 1000000, uuidCount = 0, timerCount = 0;
  const requests = [], timers = new Map();
  const document = {...target(),visibilityState:'visible',referrer:'https://example.com/private?email=secret@example.com'};
  const window = {...target(),location:{origin:'https://www.niceworkshop.ca',pathname:'/',search:'?email=secret@example.com',hash:'#private'},
    localStorage:options.localStorage || storage(),sessionStorage:options.sessionStorage || storage(),screen:{width:1200},
    crypto:{randomUUID() { uuidCount++; return `00000000-0000-4000-8000-${String(uuidCount).padStart(12,'0')}`; }},
    fetch(url, init) { if (options.fetchThrows) throw new Error('offline'); requests.push({url,...init,data:JSON.parse(init.body)}); return options.fetchRejects ? Promise.reject(new Error('offline')) : Promise.resolve({ok:true}); }};
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const navigator = {...options.navigator};
  vm.runInNewContext(source,{window,document,navigator,Date:Clock,URL,Set,Map,JSON,Promise,
    setInterval(fn) { timers.set(++timerCount,fn); return timerCount; },clearInterval(id) { timers.delete(id); }});
  return {api:window.NiceAnalytics,window,document,requests,navigator,
    uuidCount:() => uuidCount,advance(ms) { now += ms; for (const fn of [...timers.values()]) fn(); },
    tickWithoutTimer(ms) { now += ms; }};
}

test('analytics starts by default only after a valid enabled configuration', () => {
  const b = browser();
  b.api.track('part_added',{shape:'rectangle'});
  assert.equal(b.requests.length,0);
  assert.equal(b.uuidCount(),0);
  assert.equal(b.window.sessionStorage.getItem(SESSION_KEY),null);
  assert.equal(b.api.configure(CONFIG),true);
  assert.equal(b.api.enabled(),true);
  assert.equal(b.requests.length,1);
  assert.equal(b.requests[0].data.event,'$pageview');
  assert.equal(b.requests[0].data.properties.$lib_version,'1.1.0');
  assert.equal(b.window.localStorage.getItem(CONSENT_KEY),null);
  b.api.track('part_added',{shape:'rectangle'});
  assert.equal(b.requests.at(-1).data.event,'part_added');
});

test('earlier explicit denial remains effective across reload and creates no new identity', () => {
  const preferences = storage({[CONSENT_KEY]:'denied'});
  for (let i = 0; i < 2; i++) {
    const b = browser({localStorage:preferences});
    assert.equal(b.api.configure(CONFIG),true);
    b.api.track('part_added'); b.document.emit('pointerdown'); b.advance(60000);
    assert.equal(b.api.enabled(),false);
    assert.equal(b.requests.length,0);
    assert.equal(b.uuidCount(),0);
    assert.equal(b.window.sessionStorage.getItem(SESSION_KEY),null);
    assert.equal(preferences.getItem(CONSENT_KEY),'denied');
  }
});

test('capture uses anonymous events and an allowlist, never form data or URL secrets', () => {
  const b = browser();
  b.api.configure(CONFIG); b.api.setConsent(true);
  b.api.track('part_added',{shape:'circle',sheet_id:'birch-25',width_mm:120,length_mm:120,thickness_mm:25,
    quantity:2,price_cents:550,currency:'CAD',valid:true,email:'secret@example.com',address:'101 private street',
    $set:{email:'secret@example.com'},$current_url:'https://leak.example/private',reason:'free text with private details'});
  const request = b.requests.at(-1), event = request.data;
  assert.equal(request.url,'https://us.i.posthog.com/i/v0/e/');
  assert.equal(request.credentials,'omit');
  assert.equal(request.referrerPolicy,'no-referrer');
  assert.equal(request.keepalive,true);
  assert.equal(event.properties.$process_person_profile,false);
  assert.equal(event.properties.$session_id,event.distinct_id);
  assert.equal(event.properties.$current_url,'https://www.niceworkshop.ca/');
  assert.equal(event.properties.$referring_domain,'example.com');
  assert.equal(event.properties.shape,'circle');
  assert.equal(event.properties.quantity,2);
  assert.doesNotMatch(request.body,/secret|private|free text|leak\.example/);
  b.api.track('part_configured',{shape:'triangle',sheet_id:'customer-name',quantity:Infinity,width_mm:-1,price_cents:1.1,valid:'yes'});
  for (const key of ['shape','sheet_id','quantity','width_mm','price_cents','valid']) assert.equal(b.requests.at(-1).data.properties[key],undefined);
  assert.equal(b.api.track('arbitrary_event',{email:'secret'}),false);
});

test('revoke, owner exclusion, and browser privacy signals prevent later capture', () => {
  for (const navigator of [{globalPrivacyControl:true},{doNotTrack:'1'}]) {
    const b = browser({navigator}); b.api.configure(CONFIG); b.api.setConsent(true);
    b.api.track('part_added'); b.advance(60000);
    assert.equal(b.requests.length,0); assert.equal(b.uuidCount(),0);
    assert.equal(b.api.enabled(),false);
  }
  const savedOwner = browser({localStorage:storage({[OWNER_KEY]:'true'})});
  savedOwner.api.configure(CONFIG); savedOwner.api.track('part_added');
  assert.equal(savedOwner.requests.length,0); assert.equal(savedOwner.uuidCount(),0);
  const b = browser(); b.api.configure(CONFIG); b.api.setConsent(true);
  b.api.excludeOwner();
  assert.equal(b.api.enabled(),false);
  assert.equal(b.window.sessionStorage.getItem(SESSION_KEY),null);
  b.api.track('part_added'); b.advance(60000);
  assert.equal(b.requests.length,1);
  b.api.excludeOwner(false);
  assert.equal(b.requests.length,2);
  b.api.setConsent(false);
  const count = b.requests.length;
  b.api.track('part_added'); b.window.emit('pagehide');
  assert.equal(b.requests.length,count);
  assert.equal(b.window.sessionStorage.getItem(SESSION_KEY),null);
});

test('configuration never sends data to an arbitrary destination or from staff/local pages', () => {
  const invalid = [{...CONFIG,host:'https://attacker.example'}, {...CONFIG,host:CONFIG.host+'/anything'},
    {...CONFIG,publicOrigin:'https://www.niceworkshop.ca/?secret=1'}, {...CONFIG,publicOrigin:'https://other.example'},
    {...CONFIG,projectToken:'phx_personal_secret'}, {...CONFIG,enabled:false}];
  for (const config of invalid) {
    const b = browser(); b.api.setConsent(true);
    assert.equal(b.api.configure(config),false);
    assert.equal(b.api.track('part_added'),false);
    assert.equal(b.requests.length,0);
  }
  const staff = browser(); staff.window.location.pathname = '/staff'; staff.api.setConsent(true);
  assert.equal(staff.api.configure(CONFIG),false); assert.equal(staff.requests.length,0);
});

test('visit cap survives reload and inactive visits receive a new anonymous identifier', () => {
  const b = browser(); b.api.configure(CONFIG); b.api.setConsent(true);
  const firstId = b.requests[0].data.distinct_id;
  for (let i = 0; i < 300; i++) b.api.track('part_configured',{width_mm:100+i});
  assert.equal(b.requests.length,250);
  const reload = browser({localStorage:b.window.localStorage,sessionStorage:b.window.sessionStorage});
  reload.api.configure(CONFIG); reload.api.track('part_added');
  assert.equal(reload.requests.length,0);
  b.tickWithoutTimer(30 * 60 * 1000 + 1);
  b.api.track('part_added',{shape:'circle'});
  assert.equal(b.requests.length,252);
  assert.notEqual(b.requests.at(-1).data.distinct_id,firstId);
  assert.equal(b.requests.at(-2).data.event,'$pageview');
});

test('active time excludes hidden tabs and time after 60 seconds without interaction', () => {
  const b = browser(); b.api.configure(CONFIG); b.api.setConsent(true);
  b.advance(10000);
  b.document.visibilityState = 'hidden'; b.document.emit('visibilitychange');
  assert.equal(b.requests.at(-1).data.event,'active_time');
  assert.equal(b.requests.at(-1).data.properties.active_seconds,10);
  const count = b.requests.length;
  b.advance(120000);
  assert.equal(b.requests.length,count);
  b.document.visibilityState = 'visible'; b.document.emit('visibilitychange');
  b.document.emit('pointerdown');
  b.advance(180000);
  assert.equal(b.requests.at(-1).data.properties.active_seconds,60);
  const afterActive = b.requests.length;
  b.advance(180000);
  assert.equal(b.requests.length,afterActive);
});

test('builder start is counted once per session, including reload, but resets for new visits', () => {
  const b = browser(); b.api.configure(CONFIG); b.api.setConsent(true);
  b.api.track('builder_started'); b.api.track('builder_started');
  assert.equal(b.requests.filter(request => request.data.event === 'builder_started').length,1);
  const reload = browser({localStorage:b.window.localStorage,sessionStorage:b.window.sessionStorage});
  reload.api.configure(CONFIG); reload.api.track('builder_started');
  assert.equal(reload.requests.filter(request => request.data.event === 'builder_started').length,0);
  b.tickWithoutTimer(30 * 60 * 1000 + 1); b.api.track('builder_started');
  assert.equal(b.requests.filter(request => request.data.event === 'builder_started').length,2);
  b.api.setConsent(false); b.api.setConsent(true); b.api.track('builder_started');
  assert.equal(b.requests.filter(request => request.data.event === 'builder_started').length,3);
});

test('pageleave is emitted once and an idle page close does not invent a new visit', () => {
  const b = browser(); b.api.configure(CONFIG); b.api.setConsent(true);
  b.advance(10); b.window.emit('pagehide'); b.window.emit('pagehide');
  assert.equal(b.requests.filter(request => request.data.event === '$pageleave').length,1);
  const idle = browser(); idle.api.configure(CONFIG); idle.api.setConsent(true);
  idle.tickWithoutTimer(60 * 60 * 1000); idle.window.emit('pagehide');
  assert.equal(idle.requests.filter(request => request.data.event === '$pageview').length,1);
  assert.equal(idle.uuidCount(),1);
});

test('blocked storage and failed analytics requests do not break the storefront', async () => {
  const blockedStorage = {getItem() { throw new Error('blocked'); },setItem() { throw new Error('blocked'); },removeItem() { throw new Error('blocked'); }};
  for (const options of [{fetchThrows:true},{fetchRejects:true},{localStorage:blockedStorage,sessionStorage:blockedStorage}]) {
    const b = browser(options);
    assert.doesNotThrow(() => { b.api.configure(CONFIG); b.api.setConsent(true); b.api.track('part_added'); b.api.setConsent(false); });
  }
  await new Promise(resolve => setImmediate(resolve));
});
