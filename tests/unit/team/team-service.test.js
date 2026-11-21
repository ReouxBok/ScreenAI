import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTeamService, isTeamMessage, RECONNECT_ALARM } from '../../../src/team/team-service.js';
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

  it('lets only the approval window read and decide', async () => {
    const chromeApi = fakeChrome(area());
    const service = createTeamService({ chromeApi, WebSocketImpl: FakeWebSocket, fetchImpl: vi.fn() });
    const pending = service.approvals.request({ kind: 'action', productId: 'limova_team' }, { deadlineMs: Date.now() + 5_000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    const approvalId = new URL(chromeApi.windows.create.mock.calls[0][0].url).searchParams.get('id');
    const sidebar = { url: 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/sidebar/sidebar.html' };
    const popup = { url: `chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/src/team/approval.html?id=${approvalId}` };
    expect((await service.handleMessage({ type: 'TEAM_APPROVAL_GET', id: approvalId }, sidebar)).ok).toBe(false);
    expect((await service.handleMessage({ type: 'TEAM_APPROVAL_DECIDE', id: approvalId, decision: 'approve' }, sidebar)).ok).toBe(false);
    expect((await service.handleMessage({ type: 'TEAM_APPROVAL_GET', id: approvalId }, popup)).ok).toBe(true);
    expect((await service.handleMessage({ type: 'TEAM_APPROVAL_DECIDE', id: approvalId, decision: 'approve' }, popup)).ok).toBe(true);
    expect(await pending).toEqual({ decision: 'approve' });
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
});
