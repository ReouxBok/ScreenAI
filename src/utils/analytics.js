/**
 * Usage analytics sent to PostHog through the Limova proxy.
 *
 * Only event names and scalar properties (enums, counts, durations, error
 * codes, generalized paths) are recorded: never message text, page content,
 * form values, full URLs or emails. The proxy applies its own allowlist and
 * attaches the signed-in account. Users can turn it off from the menu.
 */

const INSTALL_ID_KEY = 'charly_analytics_install_id_v1';
const ENABLED_KEY = 'charly_usage_analytics_v1';
const QUEUE_KEY = 'charly_analytics_queue_v1';
const SESSION_KEY = 'charly_analytics_session_v1';
const SESSION_IDLE_MS = 30 * 60_000;
const FLUSH_DELAY_MS = 3_000;
const FLUSH_BATCH_SIZE = 20;
const MAX_QUEUE = 200;
const MAX_RETRY_DELAY_MS = 60_000;
const ERROR_DEDUPE_MS = 10 * 60_000;

// UUIDv7: PostHog derives session start times from the embedded timestamp.
export function uuidv7(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanProperties(properties) {
  const result = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string' && value) result[key] = value.slice(0, 100);
  }
  return result;
}

export function createAnalytics({
  endpoint,
  localStorage,
  sessionStorage,
  getAccessToken = async () => null,
  getCommonProperties = () => ({}),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now()
}) {
  let installId = null;
  let enabled = true;
  let queue = [];
  let session = null;
  let flushTimer = null;
  let flushing = null;
  let retryDelay = FLUSH_DELAY_MS;
  const lastErrorAt = new Map();

  const persistQueue = () => sessionStorage.set({ [QUEUE_KEY]: queue }).catch(() => {});

  function currentSessionId() {
    const time = now();
    if (!session || time - session.lastActivityAt > SESSION_IDLE_MS) session = { id: uuidv7(time), lastActivityAt: time };
    session.lastActivityAt = time;
    sessionStorage.set({ [SESSION_KEY]: session }).catch(() => {});
    return session.id;
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      analytics.flush();
    }, delay);
  }

  const analytics = {
    async initialize() {
      const [local, stored] = await Promise.all([
        localStorage.get([INSTALL_ID_KEY, ENABLED_KEY]).catch(() => ({})),
        sessionStorage.get([QUEUE_KEY, SESSION_KEY]).catch(() => ({}))
      ]);
      enabled = local?.[ENABLED_KEY] !== false;
      installId = typeof local?.[INSTALL_ID_KEY] === 'string' ? local[INSTALL_ID_KEY] : null;
      if (!installId) {
        installId = crypto.randomUUID();
        await localStorage.set({ [INSTALL_ID_KEY]: installId }).catch(() => {});
      }
      if (stored?.[SESSION_KEY]?.id) session = stored[SESSION_KEY];
      // Events tracked before a service-worker restart are sent on next boot.
      const pending = enabled && Array.isArray(stored?.[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
      queue = [...pending, ...queue].slice(-MAX_QUEUE);
      if (queue.length) scheduleFlush();
    },

    get installId() {
      return installId;
    },

    isEnabled() {
      return enabled;
    },

    track(event, properties = {}) {
      if (!enabled) return;
      queue.push({
        event,
        uuid: crypto.randomUUID(),
        timestamp: new Date(now()).toISOString(),
        properties: { ...cleanProperties(getCommonProperties()), ...cleanProperties(properties), $session_id: currentSessionId() }
      });
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      persistQueue();
      if (queue.length >= FLUSH_BATCH_SIZE) analytics.flush();
      else scheduleFlush();
    },

    // Technical errors, at most once per component/code every 10 minutes.
    trackError(component, code) {
      const key = `${component}:${code}`;
      const time = now();
      if (time - (lastErrorAt.get(key) || 0) < ERROR_DEDUPE_MS) return;
      lastErrorAt.set(key, time);
      analytics.track('extension_error', { component, code });
    },

    async flush() {
      if (flushing) return flushing;
      if (!enabled || !installId || queue.length === 0) return;
      const batch = queue.slice(0, FLUSH_BATCH_SIZE);
      flushing = (async () => {
        let delivered = false;
        try {
          const token = await getAccessToken().catch(() => null);
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ installId, events: batch }),
            keepalive: true
          });
          // A rejected payload will never succeed: drop it instead of retrying.
          delivered = response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429);
        } catch (_) {
          delivered = false;
        }
        if (delivered) {
          const sent = new Set(batch.map(item => item.uuid));
          queue = queue.filter(item => !sent.has(item.uuid));
          retryDelay = FLUSH_DELAY_MS;
          persistQueue();
          if (queue.length) scheduleFlush(0);
        } else if (enabled && queue.length) {
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
          scheduleFlush(retryDelay);
        }
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },

    async setEnabled(value) {
      const next = value === true;
      if (next === enabled) return enabled;
      if (!next) {
        // The opt-out itself is the last event this install sends.
        analytics.track('usage_analytics_changed', { enabled: false });
        // A flush already in flight does not carry this last event yet.
        await analytics.flush();
        await analytics.flush();
        enabled = false;
        queue = [];
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        await sessionStorage.remove(QUEUE_KEY).catch(() => {});
      } else {
        enabled = true;
        analytics.track('usage_analytics_changed', { enabled: true });
      }
      await localStorage.set({ [ENABLED_KEY]: enabled }).catch(() => {});
      return enabled;
    },

    // After logout the next person on this browser starts anonymous again.
    async reset() {
      await analytics.flush();
      installId = crypto.randomUUID();
      session = null;
      await localStorage.set({ [INSTALL_ID_KEY]: installId }).catch(() => {});
      await sessionStorage.remove(SESSION_KEY).catch(() => {});
      return installId;
    },

    uninstallUrl(baseUrl, version) {
      if (!enabled || !installId) return '';
      const url = new URL('/api/uninstalled', baseUrl);
      url.searchParams.set('iid', installId);
      url.searchParams.set('v', version);
      return url.toString();
    }
  };
  return analytics;
}
