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

afterEach(() => { vi.useRealTimers(); uninstallFullChromeMock(); delete globalThis.fetch; });

async function prepareUserTurn(serverOrchestration = false) {
  await setup();
  await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true, limova_onboarding_dismissed: true });
  fetch.mockImplementation(async url => {
    const path = String(url);
    if (path.endsWith('/sessions')) return response({ sessionId: NEW_SESSION });
    if (path.endsWith('/bootstrap')) return response({ available: true, enabled: true, serverOrchestration, sessionId: OLD_SESSION });
    if (path.endsWith('/api/gemini')) return response({ candidates: [{ content: { parts: [{ text: 'Reprenons votre audit SEO.' }] } }] });
    if (path.endsWith('/v2/turn')) return response({ type: 'message', content: 'Reprenons votre audit SEO.' });
    return response({ revision: 'reset-test', results: [] });
  });
}

describe('reset conversation boundaries', () => {
  it.each([true, false])('drops a user turn whose bootstrap completes after reset (ADK=%s)', async serverOrchestration => {
    await prepareUserTurn(serverOrchestration);
    const normalFetch = fetch.getMockImplementation();
    let finishBootstrap;
    fetch.mockImplementation((url, options) => String(url).endsWith('/bootstrap') && !finishBootstrap
      ? new Promise(resolve => { finishBootstrap = resolve; })
      : normalFetch(url, options));
    const pending = message({ type: 'USER_MESSAGE', text: 'Fais mon audit SEO' });
    await vi.waitFor(() => expect(finishBootstrap).toBeTypeOf('function'));
    await background.handleResetSession();
    finishBootstrap(response({ available: true, enabled: true, serverOrchestration, sessionId: OLD_SESSION }));
    await pending;
    expect(fetch.mock.calls.filter(([url]) => /\/(v2\/turn|api\/gemini)$/.test(String(url)))).toHaveLength(0);
    expect((await message({ type: 'GET_STATE' })).conversationHistory).toEqual([]);
    expect(chromeMock._storage.get('limova_session').remoteSessionId).toBe(NEW_SESSION);
    await message({ type: 'USER_MESSAGE', text: 'Bonjour, nouvelle conversation' });
    const turns = fetch.mock.calls.filter(([url]) => /\/(v2\/turn|api\/gemini)$/.test(String(url)));
    expect(turns).toHaveLength(1);
    const body = JSON.parse(turns[0][1].body);
    expect(body.resetContext).toBe(true);
    expect(serverOrchestration ? body.message : body.contents.at(-1).parts[0].text).toContain('Bonjour, nouvelle conversation');
    expect((await message({ type: 'GET_STATE' })).conversationHistory[0].content).toBe('Bonjour, nouvelle conversation');
  });

  it.each([503, 429])('cancels a pending retry after reset (HTTP %s)', async status => {
    await prepareUserTurn();
    vi.useFakeTimers();
    const normalFetch = fetch.getMockImplementation();
    let attempts = 0;
    fetch.mockImplementation((url, options) => String(url).endsWith('/api/gemini') && ++attempts === 1
      ? Promise.resolve({ ok: false, status, json: async () => ({}) })
      : normalFetch(url, options));
    const pending = message({ type: 'USER_MESSAGE', text: 'Fais mon audit SEO' });
    await vi.waitFor(() => expect(attempts).toBe(1));
    await background.handleResetSession();
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/gemini'))).toHaveLength(1);
    expect((await message({ type: 'GET_STATE' })).conversationHistory).toEqual([]);
  });

  it.each([503, 429])('still retries without a reset (HTTP %s)', async status => {
    await prepareUserTurn();
    vi.useFakeTimers();
    const normalFetch = fetch.getMockImplementation();
    let attempts = 0;
    fetch.mockImplementation((url, options) => String(url).endsWith('/api/gemini') && ++attempts === 1
      ? Promise.resolve({ ok: false, status, json: async () => ({}) })
      : normalFetch(url, options));
    const pending = message({ type: 'USER_MESSAGE', text: 'Fais mon audit SEO' });
    await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/gemini'))).toHaveLength(2);
    expect((await message({ type: 'GET_STATE' })).conversationHistory.at(-1).content).toBe('Reprenons votre audit SEO.');
  });

  it('does not send an old user message after a knowledge search spanning the reset', async () => {
    await prepareUserTurn();
    const normalFetch = fetch.getMockImplementation();
    let finishSearch;
    fetch.mockImplementation((url, options) => String(url).includes('/api/knowledge/search') && !finishSearch
      ? new Promise(resolve => { finishSearch = resolve; })
      : normalFetch(url, options));
    const pending = message({ type: 'USER_MESSAGE', text: 'Fais mon audit SEO' });
    await vi.waitFor(() => expect(finishSearch).toBeTypeOf('function'));
    await background.handleResetSession();
    finishSearch(response({ revision: 'reset-test', results: [] }));
    await pending;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/gemini'))).toHaveLength(0);
    expect((await message({ type: 'GET_STATE' })).conversationHistory).toEqual([]);
  });

  it('does not replace the new session id with a late session-opening response', async () => {
    await setup(null);
    await background.handleResetSession();
    let finishOpening;
    fetch.mockImplementation(async () => new Promise(resolve => { finishOpening = resolve; }));
    const pending = background.sendToCopilotV2({ userMessage: 'Fais mon audit SEO', pageContext: 'Accueil', operationId: 'old-opening' });
    await vi.waitFor(() => expect(finishOpening).toBeTypeOf('function'));
    await background.handleResetSession();
    finishOpening(response({ sessionId: OLD_SESSION }));
    await pending;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/v2/turn'))).toHaveLength(0);
    expect(chromeMock._storage.get('limova_session').remoteSessionId).toBeNull();
  });

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
