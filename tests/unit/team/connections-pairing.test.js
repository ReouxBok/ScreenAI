import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import {
  CONNECTIONS_STORAGE_KEY, createConnectionStore, fetchDeviceOwner, revokeConnection, sanitizeConnection
} from '../../../src/team/connections.js';
import {
  PAIRING_SESSION_KEY, buildPairUrl, codeChallengeFor, createPairing, defaultDeviceName, sameSecret
} from '../../../src/team/pairing.js';
import { classifyUrl, domainOf, isBlockedHost, safeFavicon, safeUrl } from '../../../src/team/products.js';

function memoryArea() {
  const data = new Map();
  return {
    data,
    get: vi.fn(async key => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {})),
    set: vi.fn(async values => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); }),
    remove: vi.fn(async key => { data.delete(key); })
  };
}

const CONNECTION = {
  product: 'limova_team',
  environment: 'production',
  device_id: '3f8b2c1e-0000-4000-8000-000000000001',
  device_token: 'lmd_abcdefghijklmnopqrstuvwxyz012345',
  machine_id: '5d2c9a10-1111-4111-8111-111111111111',
  device_name: 'Chrome · macOS',
  autonomy: 'approve_for_me',
  paused: false
};

describe('products: fixed origins and blocked sites', () => {
  it('reports URLs as origin + pathname only', () => {
    expect(safeUrl('https://example.com/a/b?token=1#frag')).toBe('https://example.com/a/b');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(domainOf('https://www.example.com/x')).toBe('example.com');
    expect(safeFavicon('data:image/png;base64,AA')).toBeNull();
    expect(safeFavicon('chrome://favicon/x')).toBeNull();
    expect(safeFavicon('https://example.com/favicon.ico?v=2')).toBe('https://example.com/favicon.ico');
  });

  it('blocks LinkedIn, lnkd.in and every Limova Team origin', () => {
    for (const host of ['linkedin.com', 'www.linkedin.com', 'fr.linkedin.com', 'lnkd.in', 'app.team.limova.ai', 'api.team.limova.ai', 'staging.team.limova.ai', 'api.staging.team.limova.ai']) {
      expect(isBlockedHost(host)).toBe(true);
    }
    for (const host of ['example.com', 'notlinkedin.com', 'new.limova.ai', 'limova.ai']) {
      expect(isBlockedHost(host)).toBe(false);
    }
    expect(classifyUrl('ftp://example.com', { fromAgent: true }).code).toBe('invalid_args');
    expect(classifyUrl('chrome://extensions').code).toBe('page_unavailable');
    expect(classifyUrl('https://chromewebstore.google.com/detail/x').code).toBe('page_unavailable');
  });
});

describe('connections registry', () => {
  let area;
  let store;
  beforeEach(() => {
    area = memoryArea();
    store = createConnectionStore({ storage: area });
  });

  it('stores one entry per product, under limova_connections_v1', async () => {
    await store.save(CONNECTION);
    const raw = area.data.get(CONNECTIONS_STORAGE_KEY);
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.connections)).toEqual(['limova_team']);
    expect(await store.get('limova_team')).toEqual(expect.objectContaining({ device_token: CONNECTION.device_token, autonomy: 'approve_for_me' }));
    await store.update('limova_team', { autonomy: 'full_access', paused: true });
    expect(await store.get('limova_team')).toEqual(expect.objectContaining({ autonomy: 'full_access', paused: true }));
  });

  it('drops entries for unknown products or environments, and bad tokens', () => {
    expect(sanitizeConnection('limova_team', { ...CONNECTION, environment: 'https://evil.example' })).toBeNull();
    expect(sanitizeConnection('evil', { ...CONNECTION, product: 'evil' })).toBeNull();
    expect(sanitizeConnection('limova_team', { ...CONNECTION, device_token: 'Bearer x' })).toBeNull();
    expect(sanitizeConnection('limova_team', { ...CONNECTION, autonomy: 'yolo' }).autonomy).toBe('approve_for_me');
  });

  it('revokes with the device token, then forgets locally', async () => {
    await store.save(CONNECTION);
    const fetchImpl = vi.fn(async () => ({ status: 204, ok: true }));
    const outcome = await revokeConnection(store, 'limova_team', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.team.limova.ai/api/v1/devices/me', expect.objectContaining({
      method: 'DELETE',
      headers: { Authorization: `Device ${CONNECTION.device_token}` }
    }));
    expect(outcome).toEqual({ forgotten: true, revoked: true, status: 204 });
    expect(await store.get('limova_team')).toBeNull();
  });

  it('forgets locally even when the network fails', async () => {
    await store.save(CONNECTION);
    const outcome = await revokeConnection(store, 'limova_team', { fetchImpl: async () => { throw new Error('offline'); } });
    expect(outcome.forgotten).toBe(true);
    expect(outcome.revoked).toBe(false);
    expect(await store.get('limova_team')).toBeNull();
  });

  it('reads the owner e-mail, and a 401 forgets the connection', async () => {
    await store.save(CONNECTION);
    const owner = await fetchDeviceOwner(store, CONNECTION, {
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ user: { email: 'marie@acme.fr', name: 'Marie' } }) })
    });
    expect(owner).toEqual({ email: 'marie@acme.fr', name: 'Marie' });
    expect(JSON.stringify([...area.data.values()])).not.toContain('marie@acme.fr');
    const revoked = await fetchDeviceOwner(store, CONNECTION, { fetchImpl: async () => ({ status: 401, ok: false }) });
    expect(revoked).toEqual({ revoked: true });
    expect(await store.get('limova_team')).toBeNull();
  });
});

describe('pairing (PKCE)', () => {
  let session;
  let local;
  let store;
  let tabs;
  const runtime = {
    id: 'fpkgfhhomlijmhbgcpbpjnfafdedfccj',
    getManifest: () => ({ version: '2.2.63' }),
    getPlatformInfo: async () => ({ os: 'mac' })
  };
  beforeEach(() => {
    session = memoryArea();
    local = memoryArea();
    store = createConnectionStore({ storage: local });
    tabs = { create: vi.fn(async ({ url }) => ({ id: 41, url })) };
  });

  it('derives the S256 challenge exactly as the backend checks it', async () => {
    const verifier = 'dBjftJeZ4CVP-mJ92K1D0lzzM0gwSFA4dpRCDYYm5S0abcdefgh';
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(await codeChallengeFor(verifier, webcrypto)).toBe(expected);
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('', '')).toBe(false);
    expect(await defaultDeviceName(runtime)).toBe('Chrome · macOS');
  });

  it('keeps the verifier in session storage and opens the dashboard pairing page', async () => {
    const pairing = createPairing({ session, tabs, runtime, store, cryptoImpl: webcrypto });
    await pairing.start({ productId: 'limova_team', environment: 'staging' });
    const pending = session.data.get(PAIRING_SESSION_KEY);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(pending.machine_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(local.data.size).toBe(0);
    const url = new URL(tabs.create.mock.calls[0][0].url);
    expect(url.origin + url.pathname).toBe('https://staging.team.limova.ai/desktop/pair');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(pending.verifier).digest('base64url'));
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('platform')).toBe('chrome');
    expect(url.searchParams.get('device_name')).toBe('Chrome · macOS');
    expect(url.searchParams.get('extension_id')).toBe(runtime.id);
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(tabs.create.mock.calls[0][0].active).toBe(true);
  });

  it('refuses environments outside the allowlist', async () => {
    const pairing = createPairing({ session, tabs, runtime, store, cryptoImpl: webcrypto });
    await expect(pairing.start({ productId: 'limova_team', environment: 'https://evil.example' })).rejects.toMatchObject({ code: 'invalid_environment' });
    expect(buildPairUrl({ dashboard: 'https://app.team.limova.ai', challenge: 'c', state: 's', deviceName: 'd', extensionId: 'e' }))
      .toBe('https://app.team.limova.ai/desktop/pair?code_challenge=c&state=s&device_name=d&platform=chrome&extension_id=e');
  });

  it('checks state, redeems the code once with the verifier and stores the token', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 201,
      ok: true,
      json: async () => ({ device_id: '3f8b2c1e-0000-4000-8000-000000000009', device_token: 'lmd_newtoken_abcdefghijklmnop', device: { id: '3f8b2c1e-0000-4000-8000-000000000009' } })
    }));
    const pairing = createPairing({ session, tabs, runtime, store, fetchImpl, cryptoImpl: webcrypto });
    await pairing.start({ productId: 'limova_team', environment: 'production' });
    const pending = session.data.get(PAIRING_SESSION_KEY);

    await expect(pairing.complete({ code: 'abc', state: 'forged' })).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
    // A forged callback does not cancel the real pairing.
    expect(session.data.has(PAIRING_SESSION_KEY)).toBe(true);

    const connection = await pairing.complete({ code: 'abc', state: pending.state });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.team.limova.ai/api/v1/devices/pair', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      code: 'abc',
      code_verifier: pending.verifier,
      device_name: 'Chrome · macOS',
      platform: 'chrome',
      app_version: '2.2.63',
      machine_id: pending.machine_id
    });
    expect(connection).toEqual(expect.objectContaining({ device_token: 'lmd_newtoken_abcdefghijklmnop', autonomy: 'approve_for_me', environment: 'production' }));
    expect(session.data.has(PAIRING_SESSION_KEY)).toBe(false);
    await expect(pairing.complete({ code: 'abc', state: pending.state })).rejects.toMatchObject({ code: 'no_pending_pairing' });
  });

  it('expires an unfinished pairing', async () => {
    let clock = 1_000;
    const pairing = createPairing({ session, tabs, runtime, store, cryptoImpl: webcrypto, now: () => clock });
    await pairing.start({ productId: 'limova_team', environment: 'production' });
    const { state } = session.data.get(PAIRING_SESSION_KEY);
    clock += 16 * 60_000;
    await expect(pairing.complete({ code: 'abc', state })).rejects.toMatchObject({ code: 'no_pending_pairing' });
  });

  it('maps a 404 to « not enabled »', async () => {
    const pairing = createPairing({ session, tabs, runtime, store, cryptoImpl: webcrypto, fetchImpl: async () => ({ status: 404, ok: false }) });
    await pairing.start({ productId: 'limova_team', environment: 'production' });
    const { state } = session.data.get(PAIRING_SESSION_KEY);
    await expect(pairing.complete({ code: 'abc', state })).rejects.toMatchObject({ code: 'disabled' });
  });
});
