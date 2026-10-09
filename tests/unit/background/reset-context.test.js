import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

const OLD_SESSION = '550e8400-e29b-41d4-a716-446655440000';
const NEW_SESSION = '550e8400-e29b-41d4-a716-446655440001';
let background, chromeMock;
const sender = () => ({ id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('src/sidebar/sidebar.html') });
const message = request => background.handleMessage(request, sender());
const response = data => ({ ok: true, status: 200, json: async () => data });

async function setup(remoteSessionId = OLD_SESSION) {
  chromeMock = installFullChromeMock();
  await chromeMock.storage.local.set({
    charly_auth_session_v1: { token: 'test-charly-session-token', expiresAt: Date.now() + 60_000 },
    limova_session: { remoteSessionId, conversationHistory: [{ role: 'user', content: 'Fais mon audit SEO' }] }
  });
  globalThis.fetch = vi.fn(async url => response(String(url).endsWith('/sessions') ? { sessionId: NEW_SESSION } : {
    available: true, enabled: true, serverOrchestration: true, sessionId: OLD_SESSION,
    recentMessages: [{ role: 'assistant', content: 'Reprenons votre audit' }],
    goals: [{ title: 'Audit SEO' }], greeting: 'Nous parlions de votre audit'
  }));
  vi.resetModules();
  background = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => { uninstallFullChromeMock(); delete globalThis.fetch; });

describe('reset conversation boundaries', () => {
  it('clears visible history and excludes old bootstrap messages, goals and greeting', async () => {
    await setup();
    expect((await message({ type: 'GET_STATE' })).copilot.goals).toHaveLength(1);
    await background.handleResetSession();
    const state = await message({ type: 'GET_STATE' });
    expect(state.conversationHistory).toEqual([]);
    expect(state.copilot).toMatchObject({ sessionId: NEW_SESSION, recentMessages: [], goals: [], greeting: null });
    expect(chromeMock._storage.get('limova_session')).toMatchObject({ remoteSessionId: NEW_SESSION, resetContext: true });
  });

  it('keeps the reset boundary after a service-worker restart', async () => {
    await setup();
    await background.handleResetSession();
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = await message({ type: 'GET_STATE' });
    expect(state.copilot.recentMessages).toEqual([]);
    expect(state.copilot.greeting).toBeNull();
    expect(state.conversationHistory).toEqual([]);
  });

  it('opens a fresh remote session even when the previous id was unavailable', async () => {
    await setup(null);
    await background.handleResetSession();
    expect(await background.ensureRemoteCopilotSession()).toBe(NEW_SESSION);
    const open = fetch.mock.calls.find(([url]) => String(url).endsWith('/sessions'));
    expect(JSON.parse(open[1].body)).toEqual({ closePrevious: true });
  });

  it('passes the reset boundary to server-orchestrated text turns', async () => {
    await setup();
    await background.handleResetSession();
    fetch.mockImplementation(async url => response(String(url).endsWith('/turn')
      ? { type: 'message', sessionId: NEW_SESSION, content: 'Bonjour.' }
      : {}));
    await background.sendToCopilotV2({ tab: { id: 7, url: 'https://new.limova.ai/home' }, userMessage: 'Bonjour', pageContext: 'Accueil', operationId: 'reset-turn' });
    const turn = fetch.mock.calls.find(([url]) => String(url).endsWith('/v2/turn'));
    expect(JSON.parse(turn[1].body)).toMatchObject({ sessionId: NEW_SESSION, resetContext: true });
  });

  it('does not let a late response repopulate the cleared conversation', async () => {
    await setup();
    let finishTurn;
    fetch.mockImplementation(async url => String(url).endsWith('/v2/turn')
      ? new Promise(resolve => { finishTurn = resolve; })
      : response({ sessionId: NEW_SESSION }));
    const pending = background.sendToCopilotV2({ tab: { id: 7, url: 'https://new.limova.ai/home' }, userMessage: 'Fais mon audit SEO', pageContext: 'Accueil', operationId: 'old-turn' });
    await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'));
    await background.handleResetSession();
    finishTurn(response({ type: 'message', content: 'Reprenons votre audit SEO.' }));
    await pending;
    expect((await message({ type: 'GET_STATE' })).conversationHistory).toEqual([]);
  });
});
