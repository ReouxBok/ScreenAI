const crypto = require('node:crypto');

// Product analytics forwarded to PostHog. Only allowlisted event names and
// typed scalar properties leave the proxy: never message text, page content,
// form values or full URLs. The email is attached to the person profile only.

const DEFAULT_HOST = 'https://eu.i.posthog.com';
const MAX_BATCH_EVENTS = 50;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60_000;
const IDENTIFY_CACHE_MAX = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Common properties the extension attaches to every client event.
const COMMON_CLIENT_PROPERTIES = ['extension_version', 'lang', 'chrome_version', '$session_id'];

// Client events (extension >= 2.2.53) and the properties each one may carry.
const CLIENT_EVENTS = {
  extension_installed: [],
  extension_updated: ['previous_version'],
  extension_uninstalled: [],
  sidebar_opened: ['authenticated', 'has_history'],
  sidebar_closed: ['duration_ms'],
  otp_requested: [],
  otp_failed: ['error_code'],
  signed_in: [],
  signed_out: [],
  ai_consent_decided: ['granted'],
  message_sent: ['channel', 'history_length', 'page_path', 'is_limova_page'],
  assistant_replied: ['engine', 'trigger', 'duration_ms', 'action_count'],
  assistant_failed: ['engine', 'trigger', 'error_code'],
  page_analysis_requested: ['voice_active'],
  next_step_requested: [],
  tool_executed: ['tool', 'status', 'channel'],
  action_executed: ['result', 'interaction_mode', 'risk'],
  action_confirmation: ['decision', 'risk'],
  voice_session_started: ['training_mode', 'page_path'],
  voice_session_ended: ['duration_ms', 'end_reason', 'user_turns', 'assistant_turns', 'tools_used', 'reconnects'],
  voice_session_failed: ['code'],
  voice_mic_muted: ['muted'],
  voice_turn: ['role'],
  voice_error: ['code'],
  link_clicked: ['link_id', 'placement', 'domain'],
  onboarding_started: ['total_steps', 'revision'],
  onboarding_step_completed: ['step_id', 'step_index', 'total_steps', 'revision'],
  onboarding_completed: ['total_steps', 'revision'],
  onboarding_dismissed: ['step_index', 'total_steps'],
  conversation_reset: ['history_length'],
  handoff_to_limova: ['channel'],
  memory_preference_changed: ['enabled'],
  copilot_data_exported: [],
  copilot_data_deleted: [],
  usage_analytics_changed: ['enabled'],
  training_started: ['internal_tool'],
  training_stopped: ['internal_tool', 'duration_ms'],
  evaluation_completed: ['internal_tool', 'verdict'],
  ui_clicked: ['target'],
  extension_error: ['component', 'code']
};

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function generalizePath(value) {
  const pathname = String(value || '').split(/[?#]/)[0];
  return pathname.split('/').map(segment => {
    if (/^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48) return ':id';
    return segment;
  }).join('/').slice(0, 100);
}

function sanitizeProperties(allowedKeys, properties) {
  const result = {};
  for (const key of allowedKeys) {
    const value = properties?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string' && value) {
      result[key] = key === 'page_path'
        ? generalizePath(value)
        : value.replace(/[\r\n]/g, ' ').slice(0, 100);
    }
  }
  return result;
}

function clientTimestamp(value, now = Date.now()) {
  const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return new Date(Number.isFinite(parsed) && Math.abs(parsed - now) <= MAX_CLOCK_SKEW_MS ? parsed : now).toISOString();
}

// Who the request belongs to, as PostHog sees it. Charly OTP sessions map to
// the stable opaque user id; legacy Limova JWTs keep a separate namespace.
function identityFromAuth(auth) {
  if (!auth?.sub) return null;
  const legacy = auth.provider === 'limova-legacy';
  const email = normalizeEmail(auth.email);
  return {
    distinctId: legacy ? `limova:${auth.sub}` : String(auth.sub),
    sub: String(auth.sub),
    email,
    provider: auth.provider || 'charly-otp'
  };
}

function personProperties(identity) {
  if (!identity) return {};
  return {
    $set: {
      auth_provider: identity.provider,
      ...(identity.email ? { email: identity.email, email_domain: identity.email.split('@')[1] } : {})
    }
  };
}

function createAnalytics({ apiKey, host = DEFAULT_HOST, blocked = '', libVersion = 'unknown' } = {}) {
  const blockedIds = new Set(String(blocked || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  const identified = new Set();

  const analytics = {
    enabled: Boolean(apiKey),

    // Replaced in tests. Fire-and-forget: analytics must never slow down or
    // fail a user request.
    async transport(batch) {
      const response = await fetch(`${String(host).replace(/\/$/, '')}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, batch }),
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw Object.assign(new Error('PostHog rejected batch'), { code: `HTTP_${response.status}` });
    },

    isBlocked(req, identity) {
      if (String(req?.get?.('x-charly-analytics') || '').toLowerCase() === 'off') return true;
      if (!identity) return false;
      return blockedIds.has(identity.sub.toLowerCase()) || Boolean(identity.email && blockedIds.has(identity.email));
    },

    send(batch) {
      if (!analytics.enabled || batch.length === 0) return;
      Promise.resolve()
        .then(() => analytics.transport(batch))
        .catch(error => {
          console.error(JSON.stringify({ type: 'posthog_forward_error', events: batch.length, code: error?.code || error?.name || 'unknown' }));
        });
    },

    baseProperties(req) {
      return {
        $lib: 'limova-proxy',
        $lib_version: libVersion,
        ...(req?.ip ? { $ip: req.ip } : {})
      };
    },

    // Server-side event attributed to the authenticated user of `req`.
    capture(req, event, properties = {}, identity = identityFromAuth(req?.auth)) {
      if (!analytics.enabled || !identity || analytics.isBlocked(req, identity)) return;
      analytics.send([{
        event,
        distinct_id: identity.distinctId,
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        properties: { ...analytics.baseProperties(req), ...properties, ...personProperties(identity) }
      }]);
    },

    // Person-only update (e.g. first and last name from the Limova profile).
    setPerson(req, properties, identity = identityFromAuth(req?.auth)) {
      const clean = Object.fromEntries(Object.entries(properties || {}).filter(([, value]) => typeof value === 'string' && value));
      if (!Object.keys(clean).length) return;
      analytics.capture(req, '$set', { $set: { ...clean, ...personProperties(identity).$set } }, identity);
    },

    // Batch posted by the extension. Returns the number of accepted events.
    captureClientBatch(req, { installId, events }, identity) {
      const accepted = (Array.isArray(events) ? events : [])
        .slice(0, MAX_BATCH_EVENTS)
        .filter(item => item && Object.hasOwn(CLIENT_EVENTS, item.event));
      if (!analytics.enabled || analytics.isBlocked(req, identity) || accepted.length === 0) return accepted.length;
      const anonymousId = UUID_PATTERN.test(String(installId || '')) ? String(installId).toLowerCase() : null;
      const distinctId = identity?.distinctId || anonymousId;
      if (!distinctId) return 0;
      const now = Date.now();
      const base = analytics.baseProperties(req);
      const batch = accepted.map(item => ({
        event: item.event,
        distinct_id: distinctId,
        uuid: UUID_PATTERN.test(String(item.uuid || '')) ? item.uuid : crypto.randomUUID(),
        timestamp: clientTimestamp(item.timestamp, now),
        properties: {
          ...base,
          ...sanitizeProperties([...COMMON_CLIENT_PROPERTIES, ...CLIENT_EVENTS[item.event]], item.properties),
          ...(anonymousId ? { install_id: anonymousId } : {}),
          ...personProperties(identity)
        }
      }));
      // Link the anonymous install to the signed-in person once per process.
      const identifyKey = identity && anonymousId ? `${identity.distinctId}:${anonymousId}` : null;
      if (identifyKey && !identified.has(identifyKey)) {
        if (identified.size >= IDENTIFY_CACHE_MAX) identified.clear();
        identified.add(identifyKey);
        batch.unshift({
          event: '$identify',
          distinct_id: identity.distinctId,
          uuid: crypto.randomUUID(),
          timestamp: new Date(now).toISOString(),
          properties: { ...base, $anon_distinct_id: anonymousId, ...personProperties(identity) }
        });
      }
      analytics.send(batch);
      return accepted.length;
    }
  };
  return analytics;
}

// Express middleware: emits `event` once the response is sent, with status
// and latency. Handlers add details through `res.locals.analytics`.
function trackedRoute(getAnalytics, event, properties = () => ({})) {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      try {
        getAnalytics().capture(req, event, {
          status: res.statusCode,
          ok: res.statusCode < 400,
          duration_ms: Date.now() - startedAt,
          ...properties(req, res),
          ...(res.locals.analytics || {})
        }, res.locals.analyticsIdentity || identityFromAuth(req.auth));
      } catch (_) {}
    });
    next();
  };
}

module.exports = {
  CLIENT_EVENTS,
  createAnalytics,
  generalizePath,
  identityFromAuth,
  trackedRoute
};
