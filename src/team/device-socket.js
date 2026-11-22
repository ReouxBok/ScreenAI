// device-socket.js — One product connection's WebSocket to its backend (TEAM-724).
//
// Protocol: docs/desktop-device-protocol.md (hello/ready, ping every 25 s, state,
// call/progress/result, close codes) extended by docs/browser-device-protocol.md.
// A browser cannot set `Authorization` on a WebSocket, so the token travels as the
// second subprotocol: new WebSocket(url, ["limova-device.v1", token]). It never goes
// in the URL, so it never lands in access logs.
//
// Close codes:
//   4401  token revoked or unknown        -> forget the connection (sign out)
//   4404  browser devices off             -> retry slowly (10 min)
//   4409  a newer socket replaced this one -> do not reconnect from this socket
//   4400  first message was not a hello   -> reconnect after a delay
//   other (1000, 1011, 4408, network)     -> exponential backoff 1 s -> 60 s with jitter
//
// `browser.v2` (TEAM-726) tells the server this app returns `data.page` on
// `include_page`, runs `browser.batch`, and only asks the person before paying.
//
// TEAM-729 (docs/login-vault.md): with a `vault` key factory, every socket gets a fresh
// ECDH P-256 key pair when it opens (vault.js). The private key is non-extractable and
// held in memory for that socket only; it is dropped when the socket closes or stops.
// `hello` then carries `browser.v1+vault` and `vault_key` (the public JWK: kty, crv, x,
// y). If the key cannot be made, `hello` goes out without them and the agent cannot
// fill. A call's `ctx.vault()` returns that socket's key and the device id from `ready`,
// or null once the socket is gone. `import_sessions` is answered `cancelled`: in Chrome
// the person's cookies are already there, there is nothing to import.
//
// Results are cached by call_id for 10 minutes: a repeated call_id gets the same
// answer without running again. A call is only answered on the socket it arrived on
// (or the socket that last repeated it), as the server only accepts that.
//
// Everything Chrome-specific is injected, so tests drive it with a fake WebSocket and
// fake timers.

import { VAULT_CAPABILITY } from './vault.js';

export const DEVICE_SUBPROTOCOL = 'limova-device.v1';
export const CAPABILITIES = Object.freeze(['browser.v1', 'browser.v2', 'autonomy.v1', 'browser_control.v1']);
export const PING_INTERVAL_MS = 25_000;
export const RESULT_CACHE_MS = 10 * 60_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const DISABLED_RETRY_MS = 10 * 60_000;
export const BAD_HELLO_RETRY_MS = 5_000;
// The server closes with 4408 after 90 s of silence; give up on a silent socket a bit earlier.
export const SILENCE_LIMIT_MS = 80_000;

const OPEN = 1;
const KNOWN_ERROR_CODES = new Set([
  'denied_by_owner', 'paused', 'approval_timeout', 'invalid_args', 'too_large', 'unsupported', 'internal',
  'not_found', 'taken_over', 'not_in_group', 'tab_not_found', 'stale_snapshot', 'element_not_found',
  'sensitive_field', 'blocked_site', 'page_unavailable', 'origin_mismatch', 'secret_unreadable'
]);

export function backoffDelay(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  // « Equal jitter »: half fixed, half random, so many browsers never reconnect in lockstep.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function normalizeResult(callId, result) {
  if (result?.ok === true) return { type: 'result', call_id: callId, ok: true, data: result.data ?? {} };
  const code = KNOWN_ERROR_CODES.has(result?.error?.code) ? result.error.code : 'internal';
  const message = typeof result?.error?.message === 'string' ? result.error.message.slice(0, 500) : code;
  return { type: 'result', call_id: callId, ok: false, error: { code, message } };
}

export class DeviceSocket {
  /**
   * @param {object} options
   * @param {string} options.url wss://{api}/api/v1/devices/me/socket
   * @param {() => string} options.getToken the connection's lmd_ token
   * @param {() => object} options.getState {autonomy, paused, control}
   * @param {string} options.appVersion
   * @param {object} options.handlers {onCall(call, ctx), onSetAutonomy(msg), onBrowserControl(msg), onImportSessions?(msg)}
   * @param {{createKeyPair: () => Promise<{privateKey: CryptoKey, publicJwk: object}>}} [options.vault] TEAM-729
   * @param {string[]} [options.extraCapabilities] e.g. browser.v1+cookies
   * @param {() => string|null} [options.getDeviceId] the paired device id, if `ready` carries none
   * @param {(status: string, info?: object) => void} [options.onStatus]
   * @param {() => void} [options.onRevoked] 4401: forget the connection
   * @param {(hold: {until: number, reason: string} | null) => void} [options.onHold]
   */
  constructor({
    url, getToken, getState, appVersion, handlers,
    onStatus = () => {}, onRevoked = () => {}, onHold = () => {},
    WebSocketImpl = globalThis.WebSocket,
    timers = globalThis,
    now = () => Date.now(),
    random = Math.random,
    hold = null,
    vault = null,
    extraCapabilities = [],
    getDeviceId = () => null
  }) {
    this.url = url;
    this.getToken = getToken;
    this.getState = getState;
    this.appVersion = appVersion;
    this.handlers = handlers;
    this.onStatus = onStatus;
    this.onRevoked = onRevoked;
    this.onHold = onHold;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.now = now;
    this.random = random;
    this.ws = null;
    this.status = 'idle';
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageAt = 0;
    this.stopped = false;
    this.hold = hold && Number.isFinite(hold.until) ? hold : null;
    this.deviceId = null;
    this.vault = vault && typeof vault.createKeyPair === 'function' ? vault : null;
    // {ws, privateKey, publicJwk} of the open socket only.
    this.vaultKey = null;
    this.extraCapabilities = Array.isArray(extraCapabilities) ? extraCapabilities.filter(item => typeof item === 'string') : [];
    this.getDeviceId = getDeviceId;
    this.results = new Map();
    this.inflight = new Map();
  }

  setStatus(status, info) {
    if (this.status === status && !info) return;
    this.status = status;
    this.onStatus(status, info);
  }

  isHeld() {
    return Boolean(this.hold && this.now() < this.hold.until);
  }

  setHold(hold) {
    this.hold = hold;
    this.onHold(hold);
  }

  // Connect unless already connecting/open, stopped or held (4404 / 4409).
  start({ force = false } = {}) {
    if (force) {
      this.stopped = false;
      if (this.hold) this.setHold(null);
    }
    if (this.stopped) return false;
    if (this.isHeld()) return false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === OPEN)) return false;
    this.clearReconnect();
    this.connect();
    return true;
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    this.clearPing();
    this.vaultKey = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, 'stopped'); } catch { /* already closed */ }
    }
    this.setStatus('idle');
  }

  connect() {
    const token = this.getToken();
    if (!token) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url, [DEVICE_SUBPROTOCOL, token]);
    } catch {
      this.scheduleReconnect(backoffDelay(this.attempt++, this.random));
      return;
    }
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.now();
      if (!this.vault) {
        this.sendOn(ws, this.helloMessage());
        this.startPing(ws);
        return;
      }
      // A new socket, a new key: never reuse the previous socket's.
      this.vaultKey = null;
      Promise.resolve()
        .then(() => this.vault.createKeyPair())
        .then(pair => (pair?.privateKey && pair?.publicJwk ? pair : null), () => null)
        .then(pair => {
          if (this.ws !== ws) return;
          this.vaultKey = pair ? { ws, privateKey: pair.privateKey, publicJwk: pair.publicJwk } : null;
          this.sendOn(ws, this.helloMessage(this.vaultKey));
          this.startPing(ws);
        });
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.now();
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (message && typeof message === 'object') this.handleMessage(ws, message);
    };
    ws.onerror = () => {};
    ws.onclose = event => this.handleClose(ws, Number(event?.code) || 1006);
  }

  helloMessage(vaultKey = null) {
    const state = this.getState();
    const capabilities = [...CAPABILITIES, ...this.extraCapabilities];
    if (vaultKey) capabilities.push(VAULT_CAPABILITY);
    const hello = {
      type: 'hello',
      app_version: this.appVersion,
      capabilities,
      autonomy: state.autonomy,
      paused: Boolean(state.paused),
      control: state.control === 'owner' ? 'owner' : 'agent',
      roots: []
    };
    if (vaultKey) {
      const { kty, crv, x, y } = vaultKey.publicJwk;
      hello.vault_key = { kty, crv, x, y };
    }
    return hello;
  }

  // The key and device id a call that arrived on `ws` may use, or null once that socket
  // closed or was replaced (its key is gone with it).
  vaultFor(ws) {
    const key = this.vaultKey;
    if (!key || key.ws !== ws || this.ws !== ws || ws.readyState !== OPEN) return null;
    const deviceId = this.deviceId || this.getDeviceId?.() || null;
    if (!deviceId) return null;
    return { privateKey: key.privateKey, deviceId };
  }

  stateMessage() {
    const state = this.getState();
    return {
      type: 'state',
      autonomy: state.autonomy,
      paused: Boolean(state.paused),
      control: state.control === 'owner' ? 'owner' : 'agent',
      roots: []
    };
  }

  // Sends `state` on the current socket once it said hello. Returns whether it was sent.
  sendState() {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    return this.sendOn(this.ws, this.stateMessage());
  }

  sendOn(ws, message) {
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  startPing(ws) {
    this.clearPing();
    this.pingTimer = this.timers.setInterval(() => {
      if (this.ws !== ws) return;
      if (this.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
        // No pong for too long: drop it and reconnect with backoff.
        try { ws.close(); } catch { /* ignore */ }
        this.handleClose(ws, 4408);
        return;
      }
      this.sendOn(ws, { type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  clearPing() {
    if (this.pingTimer) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  clearReconnect() {
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(delay) {
    this.clearReconnect();
    if (this.stopped) return;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }

  handleClose(ws, code) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.vaultKey = null;
    this.clearPing();
    if (this.stopped) return;
    if (code === 4401) {
      this.stopped = true;
      this.setStatus('revoked');
      this.onRevoked();
      return;
    }
    if (code === 4409) {
      // Another socket of this device is live. Reconnecting would only kick it out
      // and start a ping-pong; wait for the person (or a browser restart).
      this.setHold({ until: Number.MAX_SAFE_INTEGER, reason: 'replaced' });
      this.setStatus('replaced');
      return;
    }
    if (code === 4404) {
      this.setHold({ until: this.now() + DISABLED_RETRY_MS, reason: 'disabled' });
      this.setStatus('disabled');
      this.scheduleReconnect(DISABLED_RETRY_MS);
      return;
    }
    this.setStatus('offline', { code });
    const delay = backoffDelay(this.attempt++, this.random);
    this.scheduleReconnect(code === 4400 ? Math.max(BAD_HELLO_RETRY_MS, delay) : delay);
  }

  pruneResults() {
    const now = this.now();
    for (const [callId, entry] of this.results) {
      if (entry.expiresAt <= now) this.results.delete(callId);
    }
  }

  handleMessage(ws, message) {
    switch (message.type) {
      case 'ready':
        this.attempt = 0;
        if (this.hold) this.setHold(null);
        this.deviceId = typeof message.device_id === 'string' ? message.device_id : this.deviceId;
        this.setStatus('online');
        return;
      case 'pong':
        return;
      case 'call':
        this.handleCall(ws, message);
        return;
      case 'set_autonomy':
        this.handleRequest(ws, message, 'autonomy_result', () => this.handlers.onSetAutonomy(message));
        return;
      case 'browser_control':
        this.handleRequest(ws, message, 'browser_control_result', () => this.handlers.onBrowserControl(message));
        return;
      case 'import_sessions':
        // TEAM-729: Limova Desktop imports cookies into its own panel; in Chrome they are
        // already there, so nothing is read and the answer is always « cancelled ».
        this.handleRequest(ws, message, 'import_sessions_result', () => (
          this.handlers.onImportSessions ? this.handlers.onImportSessions(message) : { status: 'cancelled', sites: [] }
        ));
        return;
      default:
        // Unknown types are ignored, so the server can add messages safely.
    }
  }

  handleRequest(ws, message, answerType, run) {
    const requestId = typeof message.request_id === 'string' ? message.request_id : null;
    if (!requestId) return;
    Promise.resolve()
      .then(run)
      .catch(() => ({ status: 'rejected' }))
      .then(answer => {
        // The handler already sent `state` (on this socket) when it applied a change,
        // so the server's presence shows the new state before it reads the answer.
        this.sendOn(ws, { type: answerType, request_id: requestId, ...(answer || { status: 'rejected' }) });
      });
  }

  handleCall(ws, message) {
    const callId = typeof message.call_id === 'string' && message.call_id ? message.call_id.slice(0, 100) : null;
    if (!callId) return;
    this.pruneResults();
    const cached = this.results.get(callId);
    if (cached) {
      this.sendOn(ws, cached.message);
      return;
    }
    const running = this.inflight.get(callId);
    if (running) {
      // A repeat while it runs: answer once, on the socket that asked last.
      running.ws = ws;
      return;
    }
    const entry = { ws };
    this.inflight.set(callId, entry);
    const ctx = {
      progress: status => this.sendOn(entry.ws, { type: 'progress', call_id: callId, status })
    };
    // Only a socket that advertised the vault can fill; the key is the one of the socket
    // the call arrived on, read when the fill runs (a held call may outlive it).
    if (this.vault) ctx.vault = () => this.vaultFor(ws);
    const call = {
      call_id: callId,
      tool: typeof message.tool === 'string' ? message.tool : '',
      args: message.args && typeof message.args === 'object' && !Array.isArray(message.args) ? message.args : {},
      deadline_ms: Number(message.deadline_ms)
    };
    Promise.resolve()
      .then(() => this.handlers.onCall(call, ctx))
      .catch(error => ({ ok: false, error: { code: 'internal', message: String(error?.message || 'internal').slice(0, 200) } }))
      .then(result => {
        const answer = normalizeResult(callId, result);
        this.results.set(callId, { message: answer, expiresAt: this.now() + RESULT_CACHE_MS });
        this.inflight.delete(callId);
        this.sendOn(entry.ws, answer);
      });
  }
}
