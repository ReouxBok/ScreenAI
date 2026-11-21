// pairing.js — Connect a product to this browser with PKCE (TEAM-724).
//
// Flow (docs/browser-device-protocol.md, « Pairing »):
// 1. The extension creates a `code_verifier` (32 random bytes, base64url) and a
//    `state` (16 random bytes, base64url), keeps both in chrome.storage.session (never
//    synced, gone when Chrome closes), and opens a normal tab on
//    {dashboard}/desktop/pair?code_challenge&state&device_name&platform=chrome&extension_id.
// 2. The person approves on the dashboard, which sends the tab to
//    chrome-extension://<id>/src/team/pair-callback.html?code&state.
// 3. That page hands code + state to the service worker, which checks `state`, then
//    redeems the code with the verifier on POST {api}/api/v1/devices/pair.
//
// Why a normal tab and an extension page rather than chrome.identity.launchWebAuthFlow:
// the auth-flow window does not reliably share the person's dashboard session (they
// would have to sign in again, and Slack or Microsoft sign-in inside that window is
// fragile), and it needs the `identity` permission. A normal tab already has the
// session. Why PKCE still matters: any page on the listed dashboard origins can open
// the callback page with a code of its choosing, and another extension could start its
// own pairing; neither has this extension's verifier, so neither can pair.

import { getEnvironment, getProduct, DEFAULT_AUTONOMY } from './products.js';

export const PAIRING_SESSION_KEY = 'limova_pairing_v1';
// A pairing the person did not finish within this long is dropped.
export const PAIRING_MAX_AGE_MS = 15 * 60_000;

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBase64Url(byteLength, cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(byteLength);
  cryptoImpl.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// S256: base64url(SHA-256(ascii(code_verifier))), as the backend checks it.
export async function codeChallengeFor(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

// Constant-time comparison, so the time to reject a forged `state` says nothing.
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

const PLATFORM_LABELS = { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD', fuchsia: 'Fuchsia' };

// « Chrome · macOS », at most 120 characters.
export async function defaultDeviceName(runtime = globalThis.chrome?.runtime) {
  let os = '';
  try {
    const info = await runtime?.getPlatformInfo?.();
    os = PLATFORM_LABELS[info?.os] || '';
  } catch {
    os = '';
  }
  return (os ? `Chrome · ${os}` : 'Chrome').slice(0, 120);
}

export function newMachineId(cryptoImpl = globalThis.crypto) {
  // A UUID matches the backend's ^[A-Za-z0-9-]{8,64}$.
  return cryptoImpl.randomUUID();
}

export function buildPairUrl({ dashboard, challenge, state, deviceName, extensionId }) {
  const url = new URL('/desktop/pair', dashboard);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  url.searchParams.set('device_name', deviceName);
  url.searchParams.set('platform', 'chrome');
  url.searchParams.set('extension_id', extensionId);
  return url.toString();
}

function pairingError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Pairing for every product. Dependencies are injected so tests run without Chrome.
 */
export function createPairing({
  session = globalThis.chrome?.storage?.session,
  tabs = globalThis.chrome?.tabs,
  runtime = globalThis.chrome?.runtime,
  store,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  now = () => Date.now()
} = {}) {
  async function readPending() {
    const data = await session.get(PAIRING_SESSION_KEY).catch(() => ({}));
    const pending = data?.[PAIRING_SESSION_KEY];
    if (!pending || typeof pending !== 'object') return null;
    if (!Number.isFinite(pending.created_at) || now() - pending.created_at > PAIRING_MAX_AGE_MS) return null;
    return pending;
  }

  async function start({ productId, environment }) {
    const product = getProduct(productId);
    const env = getEnvironment(productId, environment);
    if (!product || !env) throw pairingError('invalid_environment', 'Unknown product or environment');
    const verifier = randomBase64Url(32, cryptoImpl);
    const state = randomBase64Url(16, cryptoImpl);
    const challenge = await codeChallengeFor(verifier, cryptoImpl);
    const deviceName = await defaultDeviceName(runtime);
    // Pairing again on the same product and environment reuses the machine id, so
    // the backend replaces the earlier device instead of keeping two.
    const existing = await store?.get(productId).catch(() => null);
    const machineId = existing?.environment === env.id ? existing.machine_id : newMachineId(cryptoImpl);
    await session.set({
      [PAIRING_SESSION_KEY]: {
        product: product.id,
        environment: env.id,
        verifier,
        state,
        device_name: deviceName,
        machine_id: machineId,
        created_at: now()
      }
    });
    const url = buildPairUrl({ dashboard: env.dashboard, challenge, state, deviceName, extensionId: runtime.id });
    const tab = await tabs.create({ url, active: true });
    return { tabId: tab?.id ?? null, url };
  }

  /**
   * Redeem the code the dashboard sent back. The pending pairing is single-use: it is
   * removed before the network call, so a replayed callback cannot try again.
   */
  async function complete({ code, state }) {
    if (typeof code !== 'string' || !code || code.length > 200) throw pairingError('invalid_callback', 'Missing code');
    if (typeof state !== 'string' || !state || state.length > 200) throw pairingError('invalid_callback', 'Missing state');
    const pending = await readPending();
    if (!pending) throw pairingError('no_pending_pairing', 'No pairing in progress');
    if (!sameSecret(pending.state, state)) throw pairingError('state_mismatch', 'State does not match');
    await session.remove(PAIRING_SESSION_KEY).catch(() => {});

    const env = getEnvironment(pending.product, pending.environment);
    if (!env) throw pairingError('invalid_environment', 'Unknown environment');
    let response;
    try {
      response = await fetchImpl(`${env.api}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify({
          code,
          code_verifier: pending.verifier,
          device_name: pending.device_name,
          platform: 'chrome',
          app_version: runtime?.getManifest?.().version || null,
          machine_id: pending.machine_id
        })
      });
    } catch {
      throw pairingError('network', 'Network error');
    }
    if (response.status === 404) throw pairingError('disabled', 'Browser devices are not enabled');
    if (!response.ok) throw pairingError('rejected', `Pairing refused (${response.status})`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw pairingError('invalid_response', 'Invalid pairing response');
    }
    const existing = await store.get(pending.product).catch(() => null);
    const connection = await store.save({
      product: pending.product,
      environment: env.id,
      device_id: String(body?.device_id || body?.device?.id || ''),
      device_token: body?.device_token,
      machine_id: pending.machine_id,
      device_name: pending.device_name,
      // Pairing again keeps the person's own level; a new connection starts at
      // « Accès complet » (TEAM-726).
      autonomy: existing?.autonomy || DEFAULT_AUTONOMY,
      paused: false,
      paired_at: now()
    }).catch(() => {
      throw pairingError('invalid_response', 'Invalid pairing response');
    });
    return connection;
  }

  async function cancel() {
    await session.remove(PAIRING_SESSION_KEY).catch(() => {});
  }

  return { start, complete, cancel, readPending };
}
