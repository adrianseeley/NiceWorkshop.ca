'use strict';

const { randomUUID } = require('node:crypto');

const POSTHOG_HOSTS = new Set(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
const HOUR_MS = 60 * 60 * 1000;
const MAX_BOT_EVENTS_PER_HOUR = 100;
// These are self-reported user-agent hints, not verified crawler identities.
const CRAWLER_NAMES = ['Googlebot', 'GoogleOther', 'bingbot', 'BingPreview', 'DuckDuckBot',
  'Applebot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot',
  'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Amazonbot', 'PetalBot', 'Bytespider',
  'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Pinterestbot'];
const RECOGNIZED_CRAWLER = new RegExp(`\\b(?:${CRAWLER_NAMES.join('|')})\\b`, 'i');

function analyticsSettings(env = process.env) {
  const projectToken = env.POSTHOG_PROJECT_TOKEN;
  const host = env.POSTHOG_HOST;
  if (env.ANALYTICS_ENABLED !== 'true'
      || typeof projectToken !== 'string' || projectToken.length > 200
      || !/^phc_[A-Za-z0-9]+$/.test(projectToken) || !POSTHOG_HOSTS.has(host)) {
    return { enabled: false };
  }
  try {
    const origin = new URL(env.PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) return { enabled: false };
    return { enabled: true, projectToken, host, publicOrigin: origin.origin };
  } catch {
    return { enabled: false };
  }
}

function botTrafficMiddleware(env = process.env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const settings = analyticsSettings(env);
  let windowStart = now(), sentInWindow = 0, pending = 0;
  return (req, res, next) => {
    if (!settings.enabled || env.ANALYTICS_BOT_TRACKING_ENABLED !== 'true'
        || typeof fetchImpl !== 'function' || req.method !== 'GET'
        || !['/', '/index.html'].includes(req.path)) return next();

    const userAgent = String(req.get('user-agent') || '').slice(0, 256);
    const match = userAgent.match(RECOGNIZED_CRAWLER);
    if (!match) return next();
    // Forward only a known software name, never the caller-controlled header.
    const crawlerName = CRAWLER_NAMES.find(name => name.toLowerCase() === match[0].toLowerCase());

    res.once('finish', () => {
      if (res.statusCode !== 200) return;
      const timestamp = now();
      if (timestamp - windowStart >= HOUR_MS) {
        windowStart = timestamp;
        sentInWindow = 0;
      }
      if (sentInWindow >= MAX_BOT_EVENTS_PER_HOUR || pending >= 2) return;
      sentInWindow++;
      pending++;
      // Per-request IDs deliberately measure requests, never unique bots/people.
      // No client IP, query string, referrer, cookie, or form data is forwarded.
      const payload = {
        api_key: settings.projectToken,
        event: '$http_log',
        distinct_id: `http_log_${randomUUID()}`,
        timestamp: new Date(timestamp).toISOString(),
        properties: {
          $process_person_profile: false,
          $geoip_disable: true,
          $current_url: `${settings.publicOrigin}/`,
          $host: new URL(settings.publicOrigin).host,
          $pathname: '/',
          $raw_user_agent: crawlerName,
          method: 'GET',
          status_code: 200,
          source: 'server_bot_request',
          bot_classification: 'user_agent_hint',
          metric: 'requests'
        }
      };
      // Analytics has no effect on the response or checkout. No retries/queues
      // survive a failure or restart, keeping traffic and memory use bounded.
      void (async () => {
        try {
          const response = await fetchImpl(`${settings.host}/i/v0/e/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(2000)
          });
          await response?.body?.cancel();
        } catch { /* Optional analytics must never interrupt the storefront. */ }
        finally { pending--; }
      })();
    });
    next();
  };
}

module.exports = { analyticsSettings, botTrafficMiddleware };
