import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTeamService, isTeamMessage, isTeamPageMessage, RECONNECT_ALARM } from '../../../src/team/team-service.js';
import { CONNECTIONS_STORAGE_KEY } from '../../../src/team/connections.js';

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
}

function area(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async key => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {})),
    set: vi.fn(async values => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); }),
    remove: vi.fn(async key => { data.delete(key); })
  };
}

const STORED = {
  version: 1,
  connections: {
    limova_team: {
      product: 'limova_team',
      environment: 'staging',
      device_id: '3f8b2c1e-0000-4000-8000-000000000001',
      device_token: 'lmd_abcdefghijklmnopqrstuvwxyz012345',
      machine_id: '5d2c9a10-1111-4111-8111-111111111111',
      autonomy: 'approve_for_me',
      paused: false
    }
  }
};

function fakeChrome(local) {
  return {
    storage: { local, session: area() },
    runtime: {
      id: 'fpkgfhhomlijmhbgcpbpjnfafdedfccj',
      getURL: path => `chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/${path}`,
      getManifest: () => ({ version: '2.2.63' }),
      sendMessage: vi.fn(async () => {})
    },
    tabs: { create: vi.fn(async () => ({ id: 1 })), query: vi.fn(async () => []), onCreated: { addListener() {}, removeListener() {} } },
    windows: { onRemoved: { addListener: vi.fn() }, create: vi.fn(async () => ({ id: 3 })), remove: vi.fn(async () => {}) },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setBadgeTextColor: vi.fn(async () => {}) }
  };
}

describe('team service', () => {
  beforeEach(() => { FakeWebSocket.instances = []; });

  it('recognises only its own message types', () => {
    expect(isTeamMessage('TEAM_GET_STATE')).toBe(true);
    expect(isTeamMessage('USER_MESSAGE')).toBe(false);
  });

  it('connects every stored connection on start and sets the reconnect alarm', async () => {
    const chromeApi = fakeChrome(area({ [CONNECTIONS_STORAGE_KEY]: STORED }));
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    await service.init();
    expect(chromeApi.alarms.create).toHaveBeenCalledWith(RECONNECT_ALARM, { periodInMinutes: 1 });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('wss://api.staging.team.limova.ai/api/v1/devices/me/socket');
    const { state } = await service.handleMessage({ type: 'TEAM_GET_STATE' });
    expect(state.products.map(product => product.id)).toEqual(['limova_team']);
    expect(state.products[0].connection).toEqual(expect.objectContaining({ environment: 'staging', autonomy: 'approve_for_me', status: 'connecting' }));
    expect(JSON.stringify(state)).not.toContain('lmd_');
  });

  it('forgets the connection when the socket closes with 4401', async () => {
    const local = area({ [CONNECTIONS_STORAGE_KEY]: STORED });
    const service = createTeamService({ chromeApi: fakeChrome(local), WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    await service.init();
    FakeWebSocket.instances[0].onclose({ code: 4401 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(local.data.get(CONNECTIONS_STORAGE_KEY).connections).toEqual({});
    expect(service.links.size).toBe(0);
  });

  it('accepts a pairing callback only from its own callback page', async () => {
    const service = createTeamService({ chromeApi: fakeChrome(area()), WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    const fromPage = await service.handleMessage({ type: 'TEAM_PAIR_CALLBACK', code: 'a', state: 'b' }, { url: 'https://app.team.limova.ai/desktop/pair' });
    expect(fromPage.ok).toBe(false);
    const fromSidebar = await service.handleMessage({ type: 'TEAM_PAIR_CALLBACK', code: 'a', state: 'b' }, {
      url: 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/sidebar/sidebar.html'
    });
    expect(fromSidebar.ok).toBe(false);
    const fromCallback = await service.handleMessage({ type: 'TEAM_PAIR_CALLBACK', code: 'a', state: 'b' }, {
      url: 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/team/pair-callback.html'
    });
    expect(fromCallback).toEqual(expect.objectContaining({ ok: false, error: 'no_pending_pairing' }));
  });

  it('has no approval window any more: only the side panel decides a save-login notice (TEAM-757)', async () => {
    const chromeApi = fakeChrome(area());
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    const sidebar = { url: 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/sidebar/sidebar.html' };
    expect(isTeamMessage('TEAM_APPROVAL_GET')).toBe(false);
    expect(isTeamMessage('TEAM_APPROVAL_DECIDE')).toBe(false);
    expect(isTeamMessage('TEAM_LOGIN_OFFER_GET')).toBe(false);
    expect(await service.handleMessage({ type: 'TEAM_APPROVAL_DECIDE', id: 'x', decision: 'approve' }, sidebar)).toEqual({ ok: false, error: 'unknown_message' });
    // A web page, or any other extension page, cannot answer the notice.
    const page = { url: 'https://evil.example/', tab: { id: 3 } };
    const other = { url: 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/team/pair-callback.html' };
    expect((await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_DECIDE', id: 'x', decision: 'save' }, page)).ok).toBe(false);
    expect((await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_DECIDE', id: 'x', decision: 'save' }, other)).ok).toBe(false);
    expect(await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_DECIDE', id: 'x', decision: 'save' }, sidebar)).toEqual({ ok: false, error: 'expired' });
    expect((await service.handleMessage({ type: 'TEAM_GET_STATE' }, sidebar)).state.login_offers).toEqual([]);
    expect(chromeApi.windows.create).not.toHaveBeenCalled();
  });

  it('runs payments only with a token, bound to this connection’s device (TEAM-757)', async () => {
    const chromeApi = fakeChrome(area({ [CONNECTIONS_STORAGE_KEY]: STORED }));
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    await service.init();
    const { controller, browser } = service.links.get('limova_team');
    // The engine's checks pass (a live « Payer » button); only the token is missing.
    browser.prepareAction = vi.fn(async (tool, args) => ({ plan: { tool, args, element: { name: 'Payer', role: 'button', page: { path: '/' } }, domain: 'shop.example', tab: { id: 812 } } }));
    browser.executeAction = vi.fn(async () => ({ ok: true, data: {} }));
    const result = await controller.handleCall({
      call_id: 'c-pay', tool: 'browser.click', deadline_ms: Date.now() + 60_000,
      args: { tab_id: 812, snapshot_id: 's17', element_id: 'e3', target: 'Payer', risk: 'risky', risk_reason: 'pay' }
    });
    expect(result.error.code).toBe('payment_confirmation_required');
    expect(browser.executeAction).not.toHaveBeenCalled();
    expect(chromeApi.windows.create).not.toHaveBeenCalled();
  });

  it('refuses environments outside the allowlist when connecting', async () => {
    const chromeApi = fakeChrome(area());
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    expect(await service.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'https://evil.example' }))
      .toEqual({ ok: false, error: 'invalid_environment' });
    expect(chromeApi.tabs.create).not.toHaveBeenCalled();
  });

  it('connects to the build environment only, unless the developer toggle is on (TEAM-726)', async () => {
    const chromeApi = fakeChrome(area());
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    await service.init();
    const state = (await service.handleMessage({ type: 'TEAM_GET_STATE' })).state;
    expect(state.environmentChoice).toBe(false);
    expect(state.products[0].environments).toEqual([{ id: 'production', label: 'Production' }]);
    expect(await service.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'staging' }))
      .toEqual({ ok: false, error: 'invalid_environment' });
    expect((await service.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team' })).ok).toBe(true);
    expect(new URL(chromeApi.tabs.create.mock.calls[0][0].url).origin).toBe('https://app.team.limova.ai');

    const developer = fakeChrome(area({ limova_team_developer_v1: true }));
    const devService = createTeamService({ chromeApi: developer, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    await devService.init();
    expect((await devService.handleMessage({ type: 'TEAM_GET_STATE' })).state.environmentChoice).toBe(true);
    expect((await devService.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'staging' })).ok).toBe(true);
    expect(new URL(developer.tabs.create.mock.calls[0][0].url).origin).toBe('https://staging.team.limova.ai');
  });

  it('a staging test build pairs with staging by default', async () => {
    const chromeApi = fakeChrome(area());
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn(), build: { defaultEnvironment: 'staging' } });
    await service.init();
    expect((await service.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team' })).ok).toBe(true);
    expect(new URL(chromeApi.tabs.create.mock.calls[0][0].url).origin).toBe('https://staging.team.limova.ai');
    expect(await service.handleMessage({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'production' }))
      .toEqual({ ok: false, error: 'invalid_environment' });
  });

  describe('login vault (TEAM-729)', () => {
    const EXT = 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/';
    const sidebar = { url: `${EXT}src/sidebar/sidebar.html` };

    it('accepts only the watcher\'s two messages from web pages', async () => {
      expect(isTeamPageMessage('TEAM_LOGIN_SUBMITTED')).toBe(true);
      expect(isTeamPageMessage('TEAM_LOGIN_FIELD_GONE')).toBe(true);
      expect(isTeamPageMessage('TEAM_SESSION_EXPORT')).toBe(false);
      const service = createTeamService({ chromeApi: fakeChrome(area({ [CONNECTIONS_STORAGE_KEY]: STORED })), WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
      await service.init();
      const webPage = { id: 'fpkgfhhomlijmhbgcpbpjnfafdedfccj', tab: { id: 5 }, frameId: 0, url: 'https://example.com/', origin: 'https://example.com' };
      for (const type of ['TEAM_GET_STATE', 'TEAM_SESSION_EXPORT', 'TEAM_VAULT_SET_PREFS', 'TEAM_DISCONNECT', 'TEAM_LOGIN_OFFER_GET']) {
        expect(await service.handleMessage({ type, productId: 'limova_team', site: 'example.com', consent: true }, webPage), type)
          .toEqual(expect.objectContaining({ ok: false }));
      }
      expect(service.links.size).toBe(1);
    });

    it('lets only the save window read an offer', async () => {
      const service = createTeamService({ chromeApi: fakeChrome(area()), WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
      expect((await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_GET', id: 'x' }, sidebar)).ok).toBe(false);
      expect((await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_DECIDE', id: 'x', decision: 'save' }, sidebar)).ok).toBe(false);
      expect((await service.handleMessage({ type: 'TEAM_LOGIN_OFFER_GET', id: 'x' }, { url: `${EXT}src/team/save-login.html?id=x` })).ok).toBe(false);
    });

    it('sends a session only with the consent flag, for a registrable domain, and records the site only', async () => {
      const chromeApi = fakeChrome(area({ [CONNECTIONS_STORAGE_KEY]: STORED }));
      chromeApi.cookies = { getAll: vi.fn(async () => [{ name: 'sid', value: 'cookie-value-1', domain: '.free.fr', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }]) };
      const fetchImpl = vi.fn(async () => ({ status: 201, ok: true, json: async () => ({ updated: false }) }));
      const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl });
      await service.init();
      expect(await service.handleMessage({ type: 'TEAM_SESSION_EXPORT', productId: 'limova_team', site: 'free.fr' }, sidebar))
        .toEqual({ ok: false, error: 'consent_required' });
      expect(await service.handleMessage({ type: 'TEAM_SESSION_SUGGEST', input: 'https://subscribe.free.fr/login' }, sidebar))
        .toEqual({ ok: true, site: 'free.fr' });
      expect(await service.handleMessage({ type: 'TEAM_SESSION_SUGGEST', input: 'www.linkedin.com' }, sidebar))
        .toEqual({ ok: false, error: 'blocked_site' });
      expect(await service.handleMessage({ type: 'TEAM_SESSION_EXPORT', productId: 'limova_team', site: 'subscribe.free.fr', consent: true }, sidebar))
        .toEqual({ ok: false, error: 'invalid_site' });
      expect(chromeApi.cookies.getAll).not.toHaveBeenCalled();
      expect(await service.handleMessage({ type: 'TEAM_SESSION_EXPORT', productId: 'limova_team', site: 'free.fr', consent: true }, sidebar))
        .toEqual({ ok: true, count: 1, updated: false });
      const { state } = await service.handleMessage({ type: 'TEAM_GET_STATE' }, sidebar);
      expect(state.activity[0]).toEqual(expect.objectContaining({ domain: 'free.fr', label: 'Session envoyée à Limova', outcome: 'done' }));
      expect(JSON.stringify(state)).not.toContain('cookie-value-1');
    });

    it('stores the opt-in and shows it in the panel state, off by default', async () => {
      const local = area({ [CONNECTIONS_STORAGE_KEY]: STORED });
      const service = createTeamService({ chromeApi: fakeChrome(local), WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
      await service.init();
      let { state } = await service.handleMessage({ type: 'TEAM_GET_STATE' }, sidebar);
      expect(state.products[0].connection.vault).toEqual({ offer_in_own_tabs: false, never_origins: [] });
      expect((await service.handleMessage({ type: 'TEAM_VAULT_SET_PREFS', productId: 'limova_team', offer_in_own_tabs: true }, sidebar)).ok).toBe(true);
      ({ state } = await service.handleMessage({ type: 'TEAM_GET_STATE' }, sidebar));
      expect(state.products[0].connection.vault.offer_in_own_tabs).toBe(true);
      expect(local.data.get('limova_team_vault_prefs_v1')).toEqual({ version: 1, products: { limova_team: { offer_in_own_tabs: true, never_origins: [] } } });
    });

    it('advertises the vault and cookies capabilities with a key in hello', async () => {
      const chromeApi = fakeChrome(area({ [CONNECTIONS_STORAGE_KEY]: STORED }));
      chromeApi.cookies = { getAll: vi.fn() };
      const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
      await service.init();
      const ws = FakeWebSocket.instances[0];
      ws.readyState = 1;
      ws.onopen();
      for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
      expect(ws.sent[0].capabilities).toEqual(expect.arrayContaining(['browser.v1', 'browser.v2', 'browser.v1+vault', 'browser.v1+cookies']));
      expect(Object.keys(ws.sent[0].vault_key).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    });
  });
});
