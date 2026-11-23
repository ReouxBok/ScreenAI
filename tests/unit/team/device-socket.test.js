import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DeviceSocket, backoffDelay, BACKOFF_MAX_MS, DISABLED_RETRY_MS, PING_INTERVAL_MS, readFeatures, RESULT_CACHE_MS
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
      capabilities: ['browser.v1', 'browser.v2', 'browser.v3', 'browser.v2+keys', 'browser.v2+upload', 'browser.v2+frames', 'autonomy.v1', 'browser_control.v1', 'browser.record.v1'],
      autonomy: 'approve_for_me',
      paused: false,
      control: 'agent',
      roots: []
    });
  });

  it('hands the server features of every ready to onReady, null for an older server (TEAM-731)', () => {
    const onReady = vi.fn();
    const { socket } = make({ onReady });
    socket.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'ready', device_id: 'd-1', features: { procedures: true, login_vault: false } });
    expect(onReady).toHaveBeenLastCalledWith({ deviceId: 'd-1', features: { procedures: true, login_vault: false } });
    expect(socket.features).toEqual({ procedures: true, login_vault: false });
    // A reconnect reads them again: a deploy may have switched one.
    ws.serverClose(1011);
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    const next = FakeWebSocket.instances.at(-1);
    next.open();
    next.receive({ type: 'ready', device_id: 'd-1' });
    expect(onReady).toHaveBeenLastCalledWith({ deviceId: 'd-1', features: null });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(readFeatures({ procedures: 'yes', login_vault: true })).toEqual({ procedures: false, login_vault: true });
    expect(readFeatures([])).toBeNull();
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

describe('DeviceSocket: login vault (TEAM-729)', () => {
  // Real timers: WebCrypto resolves on the event loop.
  beforeEach(() => { FakeWebSocket.instances = []; });
  const settle = async () => { for (let i = 0; i < 20; i += 1) await flush(); };

  async function openVault(overrides = {}) {
    const { createVaultKeyPair } = await import('../../../src/team/vault.js');
    const made = make({
      vault: { createKeyPair: vi.fn(() => createVaultKeyPair()) },
      extraCapabilities: ['browser.v1+cookies'],
      getDeviceId: () => 'paired-device-0001',
      ...overrides
    });
    made.socket.start();
    const ws = FakeWebSocket.instances.at(-1);
    ws.open();
    await settle();
    return { ...made, ws };
  }

  it('says hello with browser.v1+vault, browser.v1+cookies and a bare public JWK', async () => {
    const { ws, socket } = await openVault();
    const hello = ws.sent[0];
    expect(hello.type).toBe('hello');
    expect(hello.capabilities).toEqual(['browser.v1', 'browser.v2', 'browser.v3', 'browser.v2+keys', 'browser.v2+upload', 'browser.v2+frames', 'autonomy.v1', 'browser_control.v1', 'browser.record.v1', 'browser.v1+cookies', 'browser.v1+vault']);
    expect(Object.keys(hello.vault_key).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(hello.vault_key).toEqual(expect.objectContaining({ kty: 'EC', crv: 'P-256' }));
    expect(socket.vaultKey.privateKey.extractable).toBe(false);
    socket.stop();
  });

  it('makes a new key for every socket and drops it on close', async () => {
    const { ws, socket } = await openVault();
    const first = ws.sent[0].vault_key.x;
    expect(socket.vaultFor(ws)).toEqual(expect.objectContaining({ deviceId: 'paired-device-0001' }));
    ws.serverClose(1011);
    expect(socket.vaultKey).toBeNull();
    expect(socket.vaultFor(ws)).toBeNull();
    socket.start({ force: true });
    const next = FakeWebSocket.instances.at(-1);
    next.open();
    await settle();
    expect(next.sent[0].vault_key.x).not.toBe(first);
    // The device id the server sent in `ready` wins over the stored one.
    next.receive({ type: 'ready', device_id: 'ready-device-0002' });
    expect(socket.vaultFor(next).deviceId).toBe('ready-device-0002');
    expect(socket.vaultFor(ws)).toBeNull();
    socket.stop();
    expect(socket.vaultKey).toBeNull();
  });

  it('says hello without the vault when no key can be made', async () => {
    const { ws, socket } = await openVault({ vault: { createKeyPair: async () => { throw new Error('no crypto'); } } });
    expect(ws.sent[0].capabilities).not.toContain('browser.v1+vault');
    expect(ws.sent[0].vault_key).toBeUndefined();
    socket.stop();
  });

  it('opens a fill_secret seal with the key of the socket the call came on, and caches the answer only', async () => {
    const { openSeal } = await import('../../../src/team/vault.js');
    const { sealForDevice, loginPayload } = await import('./vault-helpers.js');
    let opened = 0;
    const onCall = vi.fn(async (call, ctx) => {
      const vault = ctx.vault();
      const result = await openSeal({ sealed: call.args.sealed, callId: call.call_id, deviceId: vault.deviceId, privateKey: vault.privateKey });
      if (result.ok) opened += 1;
      return result.ok ? { ok: true, data: { filled: { username: true, password: true, otp: false } } } : { ok: false, error: { code: 'secret_unreadable' } };
    });
    const { ws, socket } = await openVault({ handlers: { onCall, onSetAutonomy: vi.fn(), onBrowserControl: vi.fn() } });
    ws.receive({ type: 'ready', device_id: 'ready-device-0003' });
    const sealed = await sealForDevice({
      devicePublicJwk: ws.sent[0].vault_key, callId: 'fill-1', deviceId: 'ready-device-0003',
      payload: loginPayload({ callId: 'fill-1', deviceId: 'ready-device-0003' })
    });
    const call = { type: 'call', call_id: 'fill-1', tool: 'browser.fill_secret', args: { sealed } };
    ws.receive(call);
    await settle();
    ws.receive(call);
    await settle();
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(opened).toBe(1);
    const results = ws.sent.filter(message => message.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual(results[0]);
    expect(JSON.stringify(ws.sent)).not.toContain('Tr0ub4dor');
    socket.stop();
  });

  it('keeps the new error codes and answers import_sessions « cancelled »', async () => {
    const onCall = vi.fn(async call => ({ ok: false, error: { code: call.args.code, message: 'x' } }));
    const { ws, socket } = await openVault({ handlers: { onCall, onSetAutonomy: vi.fn(), onBrowserControl: vi.fn() } });
    ws.receive({ type: 'call', call_id: 'a', tool: 'browser.fill_secret', args: { code: 'origin_mismatch' } });
    ws.receive({ type: 'call', call_id: 'b', tool: 'browser.fill_secret', args: { code: 'secret_unreadable' } });
    ws.receive({ type: 'import_sessions', request_id: 'r9', sites: ['free.fr'] });
    await settle();
    const codes = ws.sent.filter(message => message.type === 'result').map(message => message.error.code);
    expect(codes.sort()).toEqual(['origin_mismatch', 'secret_unreadable']);
    expect(ws.last('import_sessions_result')).toEqual({ type: 'import_sessions_result', request_id: 'r9', status: 'cancelled', sites: [] });
    socket.stop();
  });
});
