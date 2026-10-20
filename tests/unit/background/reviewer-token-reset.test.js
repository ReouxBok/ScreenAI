import { afterEach, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

afterEach(() => { uninstallFullChromeMock(); delete globalThis.fetch; vi.restoreAllMocks(); });

it.each(['reset', 'stop'])('does not reactivate page monitoring when an old token request crosses %s', async invalidation => {
  const chrome = installFullChromeMock();
  await chrome.storage.local.set({
    limova_ai_processing_consent_v1: true,
    limova_session: { remoteSessionId: null, conversationHistory: [] },
    charly_auth_session_v1: { token: 'synthetic-review-token', expiresAt: Date.now() + 60000 }
  });
  globalThis.fetch = vi.fn(async url => ({ ok: true, status: 200, json: async () => String(url).endsWith('/sessions')
    ? { sessionId: '550e8400-e29b-41d4-a716-446655440001' }
    : { available: true, enabled: true, token: 'synthetic-only', recentMessages: [], goals: [] }
  }));
  vi.resetModules();
  const bg = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  chrome.tabs.query.mockResolvedValue([{ id: 17, active: true, url: 'https://new.limova.ai/home' }]);
  chrome.scripting.executeScript.mockResolvedValue([{ result: { title: 'Synthetic', url: 'https://new.limova.ai/home', elements: [] } }]);
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/sidebar/sidebar.html') };
  const message = request => bg.handleMessage(request, sender);
  let release;
  const normalGet = chrome.storage.local.get.getMockImplementation();
  chrome.storage.local.get.mockImplementation(key => key === 'limova_ai_processing_consent_v1' && !release
    ? new Promise(resolve => { release = resolve; }) : normalGet(key));
  const pending = message({ type: 'GET_LIVE_TOKEN', context: {} });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  if (invalidation === 'reset') await bg.handleResetSession();
  else await message({ type: 'VOICE_SESSION_STATE', active: false });
  expect((await message({ type: 'GET_SESSION_STATE' })).active).toBe(false);
  chrome.tabs.sendMessage.mockClear();
  release({ limova_ai_processing_consent_v1: true });
  await pending;
  const state = await message({ type: 'GET_SESSION_STATE' });
  console.log('OLD_TOKEN_AFTER_RESET', JSON.stringify({ state, sent: chrome.tabs.sendMessage.mock.calls, proxy: fetch.mock.calls.map(([url]) => String(url)) }));
  expect(state.active).toBe(false);
  expect(chrome.tabs.sendMessage.mock.calls.some(([, request]) => request.type === 'SESSION_STATE' && request.active === true)).toBe(false);
});
