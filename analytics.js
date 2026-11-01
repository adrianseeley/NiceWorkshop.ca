(() => {
  'use strict';

  // Only explicitly chosen product events are sent. This deliberately does not
  // load a third-party script, record the screen, or read checkout form fields.
  const CONSENT_KEY = 'niceworkshop.analytics.consent.v1';
  const OWNER_KEY = 'niceworkshop.analytics.owner.v1';
  const SESSION_KEY = 'niceworkshop.analytics.session.v1';
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const MAX_EVENTS = 250;
  const EVENTS = new Set(['$pageview', '$pageleave', 'builder_started', 'part_configured',
    'part_added', 'part_removed', 'cart_quantity_changed', 'fulfillment_changed',
    'order_reviewed', 'estimate_copied', 'estimate_downloaded', 'checkout_started',
    'checkout_opened', 'checkout_failed', 'active_time']);
  const ENUMS = {
    shape: ['circle', 'rectangle'],
    sheet_id: ['birch-5-2', 'birch-12-7', 'birch-19-05', 'birch-25'],
    fulfillment: ['pickup', 'dropoff', 'delivery'],
    currency: ['CAD'],
    reason: ['invalid_size', 'invalid_quantity', 'rejected', 'uncertain', 'network_error',
      'checkout_unavailable', 'validation_error', 'connection_interrupted', 'unknown']
  };
  const NUMBERS = {
    thickness_mm: [0, 100], width_mm: [0, 1200], length_mm: [0, 2400],
    quantity: [0, 999], price_cents: [0, 10000000000], cart_total_cents: [0, 10000000000],
    cart_piece_count: [0, 99900], cart_line_count: [0, 100], active_seconds: [0, 60]
  };
  const INTEGER_FIELDS = new Set(['quantity', 'price_cents', 'cart_total_cents',
    'cart_piece_count', 'cart_line_count']);
  let settings = null, session = null, timer = null, bound = false;
  let consent = readConsent();
  let ownerExcluded = read('localStorage', OWNER_KEY) === 'true';
  let pageStarted = 0, pageViewed = false, pageLeft = false;
  let lastInput = 0, lastTick = 0, activeMilliseconds = 0;
  let visible = document.visibilityState !== 'hidden';

  function read(storage, key) {
    try { return window[storage].getItem(key); } catch { return null; }
  }
  function write(storage, key, value) {
    try {
      if (value === null) window[storage].removeItem(key);
      else window[storage].setItem(key, value);
    } catch { /* Analytics preferences still apply to this document. */ }
  }
  function readConsent() {
    const value = read('localStorage', CONSENT_KEY);
    return ['granted', 'denied'].includes(value) ? value : null;
  }
  function privacySignal() {
    return navigator.globalPrivacyControl === true || navigator.doNotTrack === '1'
      || window.doNotTrack === '1';
  }
  function enabled() {
    // Keep earlier explicit choices while enabling analytics for new visits.
    return !!settings && consent !== 'denied' && !ownerExcluded && !privacySignal();
  }
  function clearSession() {
    session = null;
    pageViewed = false;
    pageLeft = false;
    activeMilliseconds = 0;
    write('sessionStorage', SESSION_KEY, null);
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
  function saveSession() {
    if (session) write('sessionStorage', SESSION_KEY, JSON.stringify(session));
  }
  function validSession(value, now) {
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
      && Number.isFinite(value.lastActivity) && value.lastActivity <= now
      && now - value.lastActivity < SESSION_IDLE_MS
      && Number.isInteger(value.events) && value.events >= 0 && value.events <= MAX_EVENTS;
  }
  function ensureSession(now) {
    if (!enabled()) return false;
    if (!session) {
      try {
        const saved = JSON.parse(read('sessionStorage', SESSION_KEY));
        if (validSession(saved, now)) session = saved;
      } catch { /* Discard malformed or expired identifiers. */ }
    }
    if (!validSession(session, now)) {
      if (typeof window.crypto?.randomUUID !== 'function') return false;
      session = {id: window.crypto.randomUUID(), lastActivity: now, events: 0};
      pageViewed = false;
      pageLeft = false;
      activeMilliseconds = 0;
      saveSession();
    }
    if (!pageViewed) {
      pageViewed = true;
      pageStarted = now;
      session.lastActivity = now;
      send('$pageview', {});
    }
    return true;
  }
  function sanitize(properties) {
    const result = {};
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return result;
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (allowed.includes(properties[key])) result[key] = properties[key];
    }
    for (const [key, [min, max]] of Object.entries(NUMBERS)) {
      const value = properties[key];
      if (Number.isFinite(value) && value >= min && value <= max
        && (!INTEGER_FIELDS.has(key) || Number.isInteger(value))) result[key] = value;
    }
    if (typeof properties.valid === 'boolean') result.valid = properties.valid;
    return result;
  }
  function referral() {
    try {
      const url = new URL(document.referrer);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        && url.origin !== settings.publicOrigin) return url.hostname;
    } catch { /* No usable referrer. */ }
    return '$direct';
  }
  function send(event, properties) {
    if (!enabled() || !session || session.events >= MAX_EVENTS) return false;
    const props = {
      ...sanitize(properties),
      $process_person_profile: false,
      $session_id: session.id,
      $current_url: settings.publicOrigin + '/',
      $pathname: '/',
      $host: new URL(settings.publicOrigin).hostname,
      $referring_domain: referral(),
      $device_type: Number(window.screen?.width || window.innerWidth) < 768 ? 'Mobile' : 'Desktop',
      $lib: 'niceworkshop',
      $lib_version: '1.1.0'
    };
    if (event === '$pageleave') props.$prev_pageview_duration = Math.max(0, (Date.now() - pageStarted) / 1000);
    session.events++;
    saveSession();
    try {
      // No cookies, URL query values, browser form values, or contact details.
      // The ingest service can derive approximate geography from this request.
      Promise.resolve(window.fetch(settings.host + '/i/v0/e/', {
        method: 'POST', credentials: 'omit', keepalive: true, referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({api_key: settings.projectToken, event,
          distinct_id: session.id, properties: props, timestamp: new Date().toISOString()})
      })).catch(() => {});
      return true;
    } catch { return false; }
  }
  function track(event, properties = {}) {
    try {
      if (!EVENTS.has(event) || !enabled()) return false;
      const now = Date.now();
      if (['$pageleave', 'active_time'].includes(event)) {
        if (!session) return false;
      } else if (!ensureSession(now)) return false;
      if (event === '$pageview') return false; // One pageview per document/session start.
      if (event === 'builder_started') {
        if (session.builderStarted === true) return false;
        session.builderStarted = true;
      }
      if (event === '$pageleave') {
        if (pageLeft) return false;
        pageLeft = true;
      } else if (event !== 'active_time') {
        lastInput = now;
        session.lastActivity = now;
        saveSession();
      }
      return send(event, properties);
    } catch { return false; } // Analytics must never interrupt a quote or payment.
  }
  function accountTime(now) {
    if (enabled() && session && visible && lastTick) {
      const end = Math.min(now, lastInput + 60000);
      activeMilliseconds += Math.max(0, end - lastTick);
    }
    lastTick = now;
  }
  function flushTime() {
    if (!enabled() || !session || activeMilliseconds < 1000) return;
    // At most 60 seconds/event, including after a suspended background timer.
    const seconds = Math.min(60, Math.floor(activeMilliseconds / 1000));
    activeMilliseconds -= seconds * 1000;
    send('active_time', {active_seconds: seconds});
  }
  function begin() {
    if (!enabled()) { clearSession(); return; }
    const now = Date.now();
    lastInput = now;
    lastTick = now;
    visible = document.visibilityState !== 'hidden';
    if (!ensureSession(now)) return;
    if (timer === null) timer = setInterval(() => {
      if (!enabled()) { clearSession(); return; }
      accountTime(Date.now());
      if (activeMilliseconds >= 60000) flushTime();
    }, 1000);
  }
  function setConsent(allowed) {
    consent = allowed === true ? 'granted' : 'denied';
    write('localStorage', CONSENT_KEY, consent);
    if (enabled()) begin();
    else clearSession();
    return enabled();
  }
  function excludeOwner(excluded = true) {
    ownerExcluded = excluded === true;
    write('localStorage', OWNER_KEY, ownerExcluded ? 'true' : null);
    if (enabled()) begin();
    else clearSession();
    return ownerExcluded;
  }
  function bind() {
    if (bound) return;
    bound = true;
    for (const event of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
      document.addEventListener(event, () => {
        if (!enabled()) return;
        const now = Date.now();
        accountTime(now);
        if (!ensureSession(now)) return;
        lastInput = now;
        session.lastActivity = now;
        saveSession();
      }, {passive: true});
    }
    document.addEventListener('visibilitychange', () => {
      accountTime(Date.now());
      visible = document.visibilityState !== 'hidden';
      if (!visible) flushTime();
    });
    window.addEventListener('pagehide', () => {
      accountTime(Date.now());
      flushTime();
      track('$pageleave');
      visible = false;
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) { pageViewed = false; pageLeft = false; begin(); }
    });
    window.addEventListener('storage', event => {
      if (event.key === CONSENT_KEY || event.key === OWNER_KEY) {
        consent = readConsent();
        ownerExcluded = read('localStorage', OWNER_KEY) === 'true';
        begin();
      }
    });
  }
  function configure(config) {
    try {
      let next = null;
      if (config?.enabled === true && ['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(config.host)
        && typeof config.projectToken === 'string' && config.projectToken.length <= 200
        && /^phc_[A-Za-z0-9]+$/.test(config.projectToken)) {
        const origin = new URL(config.publicOrigin);
        if (origin.protocol === 'https:' && !origin.username && !origin.password
          && origin.pathname === '/' && !origin.search && !origin.hash
          && window.location.origin === origin.origin
          && ['/', '/index.html'].includes(window.location.pathname)) {
          next = {projectToken: config.projectToken, host: config.host, publicOrigin: origin.origin};
        }
      }
      if (settings && JSON.stringify(settings) !== JSON.stringify(next)) clearSession();
      settings = next;
      bind();
      begin();
      return !!settings;
    } catch { settings = null; clearSession(); return false; }
  }
  window.NiceAnalytics = Object.freeze({configure, track, setConsent, excludeOwner, enabled});
})();
