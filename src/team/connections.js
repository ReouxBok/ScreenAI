// connections.js — The registry of product connections (TEAM-724).
//
// One entry per product (Limova Team now, « Limova » later). Each entry holds that
// product's own device token, device id, machine id, environment, autonomy level and
// pause flag, in chrome.storage.local under `limova_connections_v1`. Nothing else is
// stored here: no page content, no screenshot, no field value, no e-mail.
//
// Revoking (« Déconnecter ») calls DELETE {api}/api/v1/devices/me with the device
// token, then forgets the entry. A 401 from the API or a 4401 close on the socket
// forgets it too: the token is no longer valid.

import { DEFAULT_AUTONOMY, getEnvironment, getProduct, isAutonomyLevel } from './products.js';

export const CONNECTIONS_STORAGE_KEY = 'limova_connections_v1';
const TOKEN_PATTERN = /^lmd_[A-Za-z0-9_-]{8,256}$/;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Keep only well-formed entries for known products and environments, so a corrupted
// or hand-edited value can never point the extension at another origin.
export function sanitizeConnection(productId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const product = getProduct(productId);
  if (!product) return null;
  const environment = getEnvironment(productId, raw.environment);
  if (!environment) return null;
  if (typeof raw.device_token !== 'string' || !TOKEN_PATTERN.test(raw.device_token)) return null;
  if (typeof raw.device_id !== 'string' || !DEVICE_ID_PATTERN.test(raw.device_id)) return null;
  if (typeof raw.machine_id !== 'string' || !MACHINE_ID_PATTERN.test(raw.machine_id)) return null;
  return {
    product: product.id,
    environment: environment.id,
    device_id: raw.device_id,
    device_token: raw.device_token,
    machine_id: raw.machine_id,
    device_name: typeof raw.device_name === 'string' ? raw.device_name.slice(0, 120) : '',
    autonomy: isAutonomyLevel(raw.autonomy) ? raw.autonomy : DEFAULT_AUTONOMY,
    paused: raw.paused === true,
    paired_at: Number.isFinite(raw.paired_at) ? raw.paired_at : null
  };
}

export function createConnectionStore({ storage = globalThis.chrome?.storage?.local } = {}) {
  async function readAll() {
    const data = await storage.get(CONNECTIONS_STORAGE_KEY).catch(() => ({}));
    const raw = data?.[CONNECTIONS_STORAGE_KEY];
    const out = {};
    if (raw && typeof raw === 'object' && raw.connections && typeof raw.connections === 'object') {
      for (const [productId, entry] of Object.entries(raw.connections)) {
        const clean = sanitizeConnection(productId, entry);
        if (clean) out[productId] = clean;
      }
    }
    return out;
  }

  async function writeAll(connections) {
    await storage.set({ [CONNECTIONS_STORAGE_KEY]: { version: 1, connections } });
  }

  // Writes are serialised so two quick changes (autonomy, then pause) never race.
  let queue = Promise.resolve();
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    list: () => readAll().then(all => Object.values(all)),
    get: productId => readAll().then(all => all[productId] || null),
    save: connection => serial(async () => {
      const clean = sanitizeConnection(connection?.product, connection);
      if (!clean) throw Object.assign(new Error('Invalid connection'), { code: 'invalid_connection' });
      const all = await readAll();
      all[clean.product] = clean;
      await writeAll(all);
      return clean;
    }),
    update: (productId, patch) => serial(async () => {
      const all = await readAll();
      if (!all[productId]) return null;
      const next = sanitizeConnection(productId, { ...all[productId], ...patch });
      if (!next) return null;
      all[productId] = next;
      await writeAll(all);
      return next;
    }),
    forget: productId => serial(async () => {
      const all = await readAll();
      if (!all[productId]) return false;
      delete all[productId];
      await writeAll(all);
      return true;
    })
  };
}

export function apiOrigin(connection) {
  return getEnvironment(connection?.product, connection?.environment)?.api || null;
}

export function deviceAuthHeader(connection) {
  return `Device ${connection.device_token}`;
}

// The reason of an API error: the backend's envelope is
// {"error": {"class", "message", "traceId", "code"?}} (TEAM-729 vault routes).
export function apiErrorCode(body) {
  const code = body?.error?.code;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : null;
}

/**
 * Revoke a connection on the server, then forget it locally.
 * The local copy is forgotten even when the network call fails: the person asked to
 * disconnect, and the dashboard can still revoke the device.
 * @returns {Promise<{forgotten: boolean, revoked: boolean, status: number|null}>}
 */
export async function revokeConnection(store, productId, { fetchImpl = globalThis.fetch } = {}) {
  const connection = await store.get(productId);
  if (!connection) return { forgotten: false, revoked: false, status: null };
  let status = null;
  try {
    const response = await fetchImpl(`${apiOrigin(connection)}/api/v1/devices/me`, {
      method: 'DELETE',
      headers: { Authorization: deviceAuthHeader(connection) },
      credentials: 'omit',
      cache: 'no-store'
    });
    status = response.status;
  } catch {
    status = null;
  }
  await store.forget(productId);
  // 401 means the token was already revoked, which is the outcome we want.
  const revoked = status !== null && ((status >= 200 && status < 300) || status === 401 || status === 404);
  return { forgotten: true, revoked, status };
}

/**
 * Read who owns the device (« connecté en tant que … »). A 401 forgets the connection.
 * The e-mail is kept in memory by the caller, never stored.
 * @returns {Promise<{email: string|null, name: string|null} | {revoked: true} | null>}
 */
export async function fetchDeviceOwner(store, connection, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`${apiOrigin(connection)}/api/v1/devices/me`, {
      method: 'GET',
      headers: { Authorization: deviceAuthHeader(connection), Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store'
    });
    if (response.status === 401) {
      await store.forget(connection.product);
      return { revoked: true };
    }
    if (!response.ok) return null;
    const body = await response.json();
    const email = typeof body?.user?.email === 'string' ? body.user.email.slice(0, 200) : null;
    const name = typeof body?.user?.name === 'string' ? body.user.name.slice(0, 120) : null;
    return { email, name };
  } catch {
    return null;
  }
}
