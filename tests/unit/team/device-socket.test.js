import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DeviceSocket, backoffDelay, BACKOFF_MAX_MS, DISABLED_RETRY_MS, PING_INTERVAL_MS, RESULT_CACHE_MS
} from '../../../src/team/device-socket.js';

class FakeWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  last(type) { return [...this.sent].reverse().find(message => message.type === type); }
}

function make(overrides = {}) {
  const state = { autonomy: 'approve_for_me', paused: false, control: 'agent' };
  const handlers = {
    onCall: vi.fn(async call => ({ ok: true, data: { echoed: call.tool } })),
    onSetAutonomy: vi.fn(async () => ({ status: 'applied' })),
    onBrowserControl: vi.fn(async () => ({ status: 'applied', control: 'owner', paused: false }))
  };
  const onRevoked = vi.fn();
  const onHold = vi.fn();
  const socket = new DeviceSocket({
    url: 'wss://api.team.limova.ai/api/v1/devices/me/socket',
    getToken: () => 'lmd_testtoken123',
    getState: () => state,
    appVersion: '2.2.63',
    handlers,
    onRevoked,
    onHold,
    WebSocketImpl: FakeWebSocket,
    random: () => 0.5,
    ...overrides
  });
  return { socket, state, handlers, onRevoked, onHold };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('DeviceSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('offers the token as a subprotocol, never in the URL, and says hello first', () => {
    const { socket } = make();
    socket.start();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://api.team.limova.ai/api/v1/devices/me/socket');
    expect(ws.url).not.toContain('lmd_');
    expect(ws.protocols).toEqual(['limova-device.v1', 'lmd_testtoken123']);
    ws.open();
    expect(ws.sent[0]).toEqual({
      type: 'hello',
      app_version: '2.2.63',
      capabilities: ['browser.v1', 'autonomy.v1', 'browser_control.v1'],
      autonomy: 'approve_for_me',
      paused: false,
      control: 'agent',
      roots: []
    });
  });

  it('pings every 25 s and sends state on demand', () => {
    const { socket, state } = make();
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'ready', device_id: 'd-123456789' });
    expect(socket.status).toBe('online');
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    ws.receive({ type: 'pong' });
    expect(ws.last('ping')).toEqual({ type: 'ping' });
    state.paused = true;
    state.control = 'owner';
    socket.sendState();
    expect(ws.last('state')).toEqual({ type: 'state', autonomy: 'approve_for_me', paused: true, control: 'owner', roots: [] });
  });

  it('reconnects with exponential backoff and jitter, capped at 60 s', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_MAX_MS);
    const { socket } = make();
    socket.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose(1011);
    expect(socket.status).toBe('offline');
    vi.advanceTimersByTime(749);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].serverClose(1006);
    vi.advanceTimersByTime(1499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('forgets the connection on 4401', () => {
    const { socket, onRevoked } = make();
    socket.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose(4401);
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(socket.status).toBe('revoked');
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('retries slowly on 4404 and keeps the hold across restarts', () => {
    const { socket, onHold } = make();
    socket.start();
    FakeWebSocket.instances[0].serverClose(4404);
    expect(socket.status).toBe('disabled');
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disabled' }));
    // The minute alarm must not reconnect early.
    expect(socket.start()).toBe(false);
    vi.advanceTimersByTime(DISABLED_RETRY_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect after 4409 until the person asks', () => {
    const { socket, onHold } = make();
    socket.start();
    FakeWebSocket.instances[0].serverClose(4409);
    expect(socket.status).toBe('replaced');
    expect(onHold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'replaced' }));
    vi.advanceTimersByTime(60 * 60_000);
    expect(socket.start()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.start({ force: true })).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconnects after a delay on 4400', () => {
    const { socket } = make();
    socket.start();
    FakeWebSocket.instances[0].serverClose(4400);
    vi.advanceTimersByTime(4999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('runs a call once, caches its result for 10 minutes and answers repeats from the cache', async () => {
    const { socket, handlers } = make();
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'call', call_id: 'c1', tool: 'browser.list_tabs', args: {}, deadline_ms: Date.now() + 30_000 });
    ws.receive({ type: 'call', call_id: 'c1', tool: 'browser.list_tabs', args: {}, deadline_ms: Date.now() + 30_000 });
    await flush();
    expect(handlers.onCall).toHaveBeenCalledOnce();
    expect(ws.sent.filter(message => message.type === 'result')).toEqual([
      { type: 'result', call_id: 'c1', ok: true, data: { echoed: 'browser.list_tabs' } }
    ]);
    ws.receive({ type: 'call', call_id: 'c1', tool: 'browser.list_tabs', args: {} });
    expect(handlers.onCall).toHaveBeenCalledOnce();
    expect(ws.sent.filter(message => message.type === 'result')).toHaveLength(2);
    vi.advanceTimersByTime(RESULT_CACHE_MS + 1);
    // The idle socket was dropped by the silence watchdog meanwhile; use the new one.
    const current = FakeWebSocket.instances.at(-1);
    current.open();
    current.receive({ type: 'call', call_id: 'c1', tool: 'browser.list_tabs', args: {} });
    await flush();
    expect(handlers.onCall).toHaveBeenCalledTimes(2);
  });

  it('only answers on the socket the call came from', async () => {
    let release;
    const { socket } = make({
      handlers: {
        onCall: () => new Promise(resolve => { release = resolve; }),
        onSetAutonomy: async () => ({ status: 'applied' }),
        onBrowserControl: async () => ({ status: 'applied' })
      }
    });
    socket.start();
    const first = FakeWebSocket.instances[0];
    first.open();
    first.receive({ type: 'call', call_id: 'c9', tool: 'browser.read_page', args: { tab_id: 1 } });
    await flush();
    first.serverClose(1000);
    vi.advanceTimersByTime(1000);
    const second = FakeWebSocket.instances[1];
    second.open();
    release({ ok: true, data: {} });
    await flush();
    expect(first.sent.some(message => message.type === 'result')).toBe(false);
    expect(second.sent.some(message => message.type === 'result')).toBe(false);
  });

  it('sends progress and maps unknown error codes to internal', async () => {
    const { socket } = make({
      handlers: {
        onCall: async (call, ctx) => {
          ctx.progress('waiting_approval');
          return { ok: false, error: { code: 'weird', message: 'x' } };
        },
        onSetAutonomy: async () => ({ status: 'applied' }),
        onBrowserControl: async () => ({ status: 'applied' })
      }
    });
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'call', call_id: 'c2', tool: 'browser.click', args: {} });
    await flush();
    expect(ws.last('progress')).toEqual({ type: 'progress', call_id: 'c2', status: 'waiting_approval' });
    expect(ws.last('result')).toEqual({ type: 'result', call_id: 'c2', ok: false, error: { code: 'internal', message: 'x' } });
  });

  it('answers set_autonomy and browser_control with their result types', async () => {
    const { socket } = make();
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'set_autonomy', request_id: 'r1', autonomy: 'ask_every_time' });
    ws.receive({ type: 'browser_control', request_id: 'r2', action: 'take_over' });
    ws.receive({ type: 'something_new', request_id: 'r3' });
    await flush();
    expect(ws.last('autonomy_result')).toEqual({ type: 'autonomy_result', request_id: 'r1', status: 'applied' });
    expect(ws.last('browser_control_result')).toEqual({ type: 'browser_control_result', request_id: 'r2', status: 'applied', control: 'owner', paused: false });
  });

  it('drops a silent socket and reconnects', () => {
    const { socket } = make();
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(socket.status).toBe('offline');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });
});
