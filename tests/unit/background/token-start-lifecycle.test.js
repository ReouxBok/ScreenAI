import { afterEach, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

const sessionId = '550e8400-e29b-41d4-a716-446655440001';
const auth = { token: 'synthetic-token-long-enough-for-validation', expiresAt: Date.now() + 60_000 };
let chromeMock, background;
const sender = () => ({ id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('src/sidebar/sidebar.html') });
const message = request => background.handleMessage(request, sender());
const response = data => ({ ok: true, status: 200, json: async () => data });

async function setup(remoteSessionId = null) {
  chromeMock = installFullChromeMock();
  await chromeMock.storage.local.set({
    limova_ai_processing_consent_v1: true,
    charly_auth_session_v1: auth,
    limova_session: { remoteSessionId, conversationHistory: [] }
  });
  globalThis.fetch = vi.fn(async url => response(String(url).endsWith('/sessions')
    ? { sessionId } : { available: true, enabled: true, token: 'synthetic-only' }));
  vi.resetModules();
  background = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  chromeMock.tabs.query.mockResolvedValue([{ id: 17, url: 'https://new.limova.ai/home', active: true }]);
  chromeMock.scripting.executeScript.mockResolvedValue([{ result: { title: 'Synthetic', url: 'https://new.limova.ai/home', elements: [] } }]);
}

afterEach(() => { uninstallFullChromeMock(); delete globalThis.fetch; });

async function invalidate(kind) {
  if (kind === 'reset') await background.handleResetSession();
  else await message({ type: 'VOICE_SESSION_STATE', active: false });
}

it.each(['bootstrap', 'sessions', 'session JSON'].flatMap(phase => ['reset', 'stop'].map(kind => [phase, kind])))
('does not revive a token start after pending %s crosses %s', async (phase, kind) => {
  await setup();
  let release;
  const normalFetch = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => {
    const matches = String(url).endsWith(phase === 'bootstrap' ? '/bootstrap' : '/sessions');
    if (matches && !release) {
      if (phase === 'session JSON') return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { release = () => resolve({ sessionId }); }) });
      return new Promise(resolve => { release = () => resolve(response(phase === 'bootstrap' ? { available: true } : { sessionId })); });
    }
    return normalFetch(url, options);
  });
  const pending = message({ type: 'GET_LIVE_TOKEN', context: {} });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await invalidate(kind);
  release();
  expect((await pending).cancelled).toBe(true);
  expect((await message({ type: 'GET_SESSION_STATE' })).active).toBe(false);
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/live-token'))).toBe(false);
});

it.each(['reset', 'stop'])('does not dispatch a live-token POST after authentication crosses %s', async kind => {
  await setup(sessionId);
  let release;
  const normalGet = chromeMock.storage.local.get.getMockImplementation();
  chromeMock.storage.local.get.mockImplementation(key => key === 'charly_auth_session_v1' && !release
    ? new Promise(resolve => { release = resolve; }) : normalGet(key));
  const pending = message({ type: 'GET_LIVE_TOKEN', context: {} });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await invalidate(kind);
  release({ charly_auth_session_v1: auth });
  expect((await pending).cancelled).toBe(true);
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/live-token'))).toBe(false);
});

it('starts voice on the tab in front even when Charly was on another tab', async () => {
  await setup(sessionId);
  // The panel was last used on Limova (tab 17); the user reopens it on a news site.
  background.lockTab(17);
  chromeMock.tabs.query.mockResolvedValue([{ id: 31, url: 'https://www.tf1info.fr/politique/article', active: true }]);
  chromeMock.scripting.executeScript.mockResolvedValue([{ result: { title: 'TF1 Info', url: 'https://www.tf1info.fr/politique/:id', elements: [] } }]);

  const result = await message({ type: 'GET_LIVE_TOKEN', context: {} });

  expect(result.cancelled).toBeUndefined();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/live-token'))).toBe(true);
});
