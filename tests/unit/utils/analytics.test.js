import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAnalytics, uuidv7 } from '../../../src/utils/analytics.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => data.has(key)).map(key => [key, data.get(key)]));
    }),
    set: vi.fn(async values => {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    }),
    remove: vi.fn(async key => { data.delete(key); })
  };
}

describe('usage analytics', () => {
  let localStorage;
  let sessionStorage;
  let fetchImpl;
  let clock;

  const make = (options = {}) => createAnalytics({
    endpoint: 'https://proxy.test/api/events',
    localStorage,
    sessionStorage,
    fetchImpl,
    getCommonProperties: () => ({ extension_version: '2.2.53', lang: 'fr', bad: { nested: true } }),
    now: () => clock,
    ...options
  });
  const sentBodies = () => fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));

  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.parse('2026-10-23T10:00:00Z');
    localStorage = memoryStorage();
    sessionStorage = memoryStorage();
    fetchImpl = vi.fn(async () => ({ ok: true, status: 202 }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates RFC 9562 UUIDv7 values carrying the timestamp', () => {
    const id = uuidv7(clock);
    expect(id).toMatch(UUID_V7);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(clock);
  });

  it('creates a persistent install id once', async () => {
    const first = make();
    await first.initialize();
    expect(first.installId).toMatch(/^[0-9a-f-]{36}$/);

    const second = make();
    await second.initialize();
    expect(second.installId).toBe(first.installId);
  });

  it('batches events after the debounce with common properties and a session id', async () => {
    const analytics = make({ getAccessToken: async () => 'session-token' });
    await analytics.initialize();
    analytics.track('message_sent', { channel: 'text', history_length: 3, text: undefined, nested: { no: true } });
    analytics.track('assistant_replied', { engine: 'adk', duration_ms: 1200 });
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://proxy.test/api/events');
    expect(init.headers.Authorization).toBe('Bearer session-token');
    const body = sentBodies()[0];
    expect(body.installId).toBe(analytics.installId);
    expect(body.events.map(event => event.event)).toEqual(['message_sent', 'assistant_replied']);
    expect(body.events[0].properties).toEqual({
      extension_version: '2.2.53',
      lang: 'fr',
      channel: 'text',
      history_length: 3,
      $session_id: expect.stringMatching(UUID_V7)
    });
    expect(body.events[0].properties.$session_id).toBe(body.events[1].properties.$session_id);
  });

  it('starts a new session after 30 minutes of inactivity', async () => {
    const analytics = make();
    await analytics.initialize();
    analytics.track('sidebar_opened');
    clock += 31 * 60_000;
    analytics.track('sidebar_opened');
    await vi.advanceTimersByTimeAsync(3_000);
    const [first, second] = sentBodies()[0].events;
    expect(first.properties.$session_id).not.toBe(second.properties.$session_id);
  });

  it('keeps events after a network failure and retries them with the same uuid', async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const analytics = make();
    await analytics.initialize();
    analytics.track('sidebar_opened');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sessionStorage.data.get('charly_analytics_queue_v1')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [failed, retried] = sentBodies();
    expect(retried.events[0].uuid).toBe(failed.events[0].uuid);
    expect(sessionStorage.data.get('charly_analytics_queue_v1')).toHaveLength(0);
  });

  it('drops a batch the proxy rejects as invalid', async () => {
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 400 });
    const analytics = make();
    await analytics.initialize();
    analytics.track('sidebar_opened');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends events queued before a service-worker restart', async () => {
    const before = make();
    await before.initialize();
    fetchImpl.mockRejectedValue(new TypeError('offline'));
    before.track('voice_turn', { role: 'user' });
    await Promise.resolve();

    fetchImpl.mockResolvedValue({ ok: true, status: 202 });
    const after = make();
    await after.initialize();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentBodies().at(-1).events.map(event => event.event)).toEqual(['voice_turn']);
  });

  it('sends the opt-out as the last event, then nothing', async () => {
    const analytics = make();
    await analytics.initialize();
    analytics.track('sidebar_opened');
    await analytics.setEnabled(false);

    const events = sentBodies().flatMap(body => body.events);
    expect(events.map(event => event.event)).toEqual(['sidebar_opened', 'usage_analytics_changed']);
    expect(events[1].properties.enabled).toBe(false);
    expect(localStorage.data.get('charly_usage_analytics_v1')).toBe(false);
    expect(analytics.isEnabled()).toBe(false);
    expect(analytics.uninstallUrl('https://proxy.test', '2.2.53')).toBe('');

    fetchImpl.mockClear();
    analytics.track('message_sent');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stays off across restarts once the user opted out', async () => {
    localStorage = memoryStorage({ charly_usage_analytics_v1: false, charly_analytics_install_id_v1: 'existing-id' });
    const analytics = make();
    await analytics.initialize();
    analytics.track('sidebar_opened');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(analytics.isEnabled()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('starts a fresh anonymous identity after logout', async () => {
    const analytics = make();
    await analytics.initialize();
    const previous = analytics.installId;
    await analytics.reset();
    expect(analytics.installId).not.toBe(previous);
    expect(localStorage.data.get('charly_analytics_install_id_v1')).toBe(analytics.installId);
  });

  it('builds the uninstall URL from the install id and version', async () => {
    const analytics = make();
    await analytics.initialize();
    const url = new URL(analytics.uninstallUrl('https://proxy.test', '2.2.53'));
    expect(url.pathname).toBe('/api/uninstalled');
    expect(url.searchParams.get('iid')).toBe(analytics.installId);
    expect(url.searchParams.get('v')).toBe('2.2.53');
  });

  it('reports a repeated technical error at most once per 10 minutes', async () => {
    const analytics = make();
    await analytics.initialize();
    analytics.trackError('proxy', 'PROXY_NETWORK_FAILED');
    analytics.trackError('proxy', 'PROXY_NETWORK_FAILED');
    clock += 11 * 60_000;
    analytics.trackError('proxy', 'PROXY_NETWORK_FAILED');
    await vi.advanceTimersByTimeAsync(3_000);
    const events = sentBodies().flatMap(body => body.events);
    expect(events).toHaveLength(2);
    expect(events[0].properties).toMatchObject({ component: 'proxy', code: 'PROXY_NETWORK_FAILED' });
  });
});
