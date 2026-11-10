// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

// Closing any Charly panel stops her; a page change caused by her own click
// never shows a false error, and errors read as plain sentences.
const LIMOVA_TAB = 17;
const HOME = 'https://new.limova.ai/home';
let background, chromeMock;
const sender = () => ({ id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('src/sidebar/sidebar.html') });
const message = request => background.handleMessage(request, sender());
const response = (data, status = 200) => ({ ok: status < 400, status, statusText: 'Internal Server Error', json: async () => data });
const calls = pattern => fetch.mock.calls.filter(([url]) => pattern.test(String(url)));
const errors = port => port.messages.filter(item => item.type === 'ERROR');

function createSidebarPort() {
  const disconnectListeners = [];
  return {
    name: 'sidebar',
    messages: [],
    postMessage: vi.fn(function postMessage(item) { this.messages.push(item); }),
    onDisconnect: { addListener: vi.fn(listener => disconnectListeners.push(listener)) },
    disconnect() { disconnectListeners.splice(0).forEach(listener => listener()); }
  };
}

function openPanel() {
  const port = createSidebarPort();
  chromeMock._listeners.runtime.onConnect[0](port);
  return port;
}

async function setup(routes = {}) {
  chromeMock = installFullChromeMock();
  await chromeMock.storage.local.set({
    charly_auth_session_v1: { token: 'test-charly-session-token', expiresAt: Date.now() + 60_000 },
    limova_ai_processing_consent_v1: true,
    limova_onboarding_dismissed: true
  });
  globalThis.fetch = vi.fn(async (url, options) => {
    const path = String(url);
    for (const [suffix, handler] of Object.entries(routes)) if (path.endsWith(suffix)) return handler(options);
    if (path.endsWith('/sessions')) return response({ sessionId: '550e8400-e29b-41d4-a716-446655440000' });
    if (path.endsWith('/bootstrap')) return response({ available: true, enabled: true, serverOrchestration: true });
    if (path.endsWith('/v2/turn')) return response({ type: 'message', content: 'Voilà.' });
    if (path.endsWith('/api/gemini')) return response({ candidates: [{ content: { parts: [{ text: 'Nouvelle page.' }] } }] });
    return response({ revision: 'test', results: [] });
  });
  vi.resetModules();
  background = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  chromeMock.tabs.query.mockResolvedValue([{ id: LIMOVA_TAB, url: HOME, active: true }]);
  chromeMock.tabs.get.mockImplementation(async id => ({ id, windowId: 1, url: HOME, active: true, status: 'complete' }));
  chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
  chromeMock.scripting.executeScript.mockResolvedValue([{ result: '' }]);
  background.lockTab(LIMOVA_TAB);
}

function abortable(options) {
  return new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')));
  });
}

afterEach(() => {
  vi.useRealTimers();
  uninstallFullChromeMock();
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe('closing a Charly panel', () => {
  it('stops Charly when one of two open panels is closed', async () => {
    await setup();
    const closing = openPanel();
    const remaining = openPanel();
    await background.showAgentPresence(42);
    chromeMock.tabs.sendMessage.mockClear();

    closing.disconnect();

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'AGENT_PRESENCE', active: false });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(LIMOVA_TAB, { type: 'SESSION_STATE', active: false });
    expect(remaining.messages).toContainEqual({ type: 'STATUS_UPDATE', status: 'ready' });
  });

  it('drops the running turn instead of finishing it after the panel closed', async () => {
    let finishTurn;
    await setup({ '/v2/turn': () => new Promise(resolve => { finishTurn = resolve; }) });
    const port = openPanel();
    const pending = message({ type: 'USER_MESSAGE', text: 'Crée un agent' });
    await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'));

    port.disconnect();
    finishTurn(response({ type: 'message', content: 'Trop tard.' }));
    await pending;

    expect(port.messages.map(item => item.type)).not.toContain('GEMINI_RESPONSE');
    expect(errors(port)).toEqual([]);
  });
});

describe('page change while Charly answers', () => {
  it('reads the new page at once, keeps the turn and analyses the page afterwards', async () => {
    let finishTurn, turnSignal;
    await setup({ '/v2/turn': options => { turnSignal = options.signal; return new Promise(resolve => { finishTurn = resolve; }); } });
    const port = openPanel();
    const pending = message({ type: 'USER_MESSAGE', text: 'Ouvre mes documents' });
    await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'));
    chromeMock.scripting.executeScript.mockClear();

    await background.handleUrlChange(LIMOVA_TAB, 'https://new.limova.ai/documents');

    expect(chromeMock.scripting.executeScript).toHaveBeenCalled();
    expect(turnSignal.aborted).toBe(false);
    expect(calls(/\/api\/gemini$/)).toHaveLength(0);

    finishTurn(response({ type: 'message', content: 'Voici tes documents.' }));
    await pending;
    await vi.waitFor(() => expect(calls(/\/api\/gemini$/)).toHaveLength(1));
    expect(port.messages).toContainEqual(expect.objectContaining({ type: 'GEMINI_RESPONSE', content: 'Voici tes documents.' }));
    expect(errors(port)).toEqual([]);
  });

  it('analyses a page change at once when no turn is running', async () => {
    await setup();
    const port = openPanel();

    await background.handleUrlChange(LIMOVA_TAB, 'https://new.limova.ai/documents');

    expect(calls(/\/api\/gemini$/)).toHaveLength(1);
    expect(errors(port)).toEqual([]);
  });

  it('shows no error for a request replaced by a newer one', async () => {
    let firstTurn = true;
    await setup({
      '/v2/turn': options => {
        if (!firstTurn) return response({ type: 'message', content: 'Deuxième réponse.' });
        firstTurn = false;
        return abortable(options);
      }
    });
    const port = openPanel();
    const track = vi.spyOn(background.analytics, 'track');
    const first = message({ type: 'USER_MESSAGE', text: 'Première demande' });
    await vi.waitFor(() => expect(calls(/\/v2\/turn$/)).toHaveLength(1));

    await message({ type: 'USER_MESSAGE', text: 'Deuxième demande' });
    await first;

    expect(errors(port)).toEqual([]);
    expect(port.messages).toContainEqual(expect.objectContaining({ type: 'GEMINI_RESPONSE', content: 'Deuxième réponse.' }));
    expect(track.mock.calls.filter(([event, properties]) =>
      ['extension_error', 'assistant_failed'].includes(event)
      && [properties.code, properties.error_code].includes('PROXY_REQUEST_ABORTED')
    )).toEqual([]);
  });

  it('drops an old legacy response whose body finishes after the newer answer', async () => {
    let finishBody;
    let first = true;
    await setup({
      '/bootstrap': () => response({ available: true, enabled: true, serverOrchestration: false }),
      '/api/gemini': () => {
        if (!first) return response({ candidates: [{ content: { parts: [{ text: 'Réponse actuelle.' }] } }] });
        first = false;
        return { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) };
      }
    });
    const port = openPanel();
    const pending = message({ type: 'USER_MESSAGE', text: 'Ancienne demande' });
    await vi.waitFor(() => expect(finishBody).toBeTypeOf('function'));
    await message({ type: 'USER_MESSAGE', text: 'Nouvelle demande' });
    finishBody({ candidates: [{ content: { parts: [{ text: 'Réponse périmée.' }] } }] });
    await pending;

    expect(port.messages.filter(item => item.type === 'GEMINI_RESPONSE').map(item => item.content)).toEqual(['Réponse actuelle.']);
    expect(errors(port)).toEqual([]);
  });

  it('keeps an external knowledge deadline visible as a timeout', async () => {
    await setup({ '/api/knowledge/search': abortable });
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const track = vi.spyOn(background.analytics, 'track');
    const pending = background.getKnowledgeContext('Connexion Gmail');
    await vi.waitFor(() => expect(calls(/\/api\/knowledge\/search$/)).toHaveLength(1));
    deadline.abort(new DOMException('The operation timed out', 'TimeoutError'));
    await pending;

    expect(track).toHaveBeenCalledWith('extension_error', expect.objectContaining({
      component: 'proxy', code: 'PROXY_REQUEST_TIMEOUT'
    }));
    expect(track.mock.calls.some(([event, properties]) => event === 'extension_error' && properties.code === 'PROXY_REQUEST_ABORTED')).toBe(false);
  });

  it('does not execute tools from an ADK response superseded while its body was loading', async () => {
    let finishBody;
    let first = true;
    await setup({ '/v2/turn': () => {
      if (!first) return response({ type: 'message', content: 'Réponse actuelle.' });
      first = false;
      return { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) };
    } });
    const port = openPanel();
    const pending = message({ type: 'USER_MESSAGE', text: 'Ancienne demande' });
    await vi.waitFor(() => expect(finishBody).toBeTypeOf('function'));
    await message({ type: 'USER_MESSAGE', text: 'Nouvelle demande' });
    chromeMock.scripting.executeScript.mockClear();
    finishBody({ type: 'tool_call', runId: 'stale-run', call: { id: 'old-tool', name: 'capture_current_view', args: {} } });
    await pending;

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/stale-run/result'))).toBe(false);
    expect(port.messages.filter(item => item.type === 'GEMINI_RESPONSE').map(item => item.content)).toEqual(['Réponse actuelle.']);
    expect(errors(port)).toEqual([]);
  });

  it.each([
    [{ candidates: [] }, 'GEMINI_EMPTY_RESPONSE'],
    [{ candidates: [{ content: { parts: [{ text: '   ' }] } }] }, 'GEMINI_EMPTY_RESPONSE'],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'GEMINI_RESPONSE_BLOCKED']
  ])('reports a structured failure for an unusable model response', async (payload, code) => {
    await setup({
      '/bootstrap': () => response({ available: true, enabled: true, serverOrchestration: false }),
      '/api/gemini': () => response(payload)
    });
    const port = openPanel();
    await message({ type: 'USER_MESSAGE', text: 'Aide-moi' });
    expect(errors(port)).toEqual([expect.objectContaining({ code })]);
    expect(port.messages.some(item => item.type === 'GEMINI_RESPONSE')).toBe(false);
  });

  it('reads all public text parts without exposing model thoughts', async () => {
    await setup({
      '/bootstrap': () => response({ available: true, enabled: true, serverOrchestration: false }),
      '/api/gemini': () => response({ candidates: [{ content: { parts: [
        { thought: true, text: 'internal thought' }, { text: 'Première partie.' }, { text: 'Suite.' }
      ] } }] })
    });
    const port = openPanel();
    await message({ type: 'USER_MESSAGE', text: 'Aide-moi' });
    expect(port.messages.filter(item => item.type === 'GEMINI_RESPONSE')).toEqual([
      expect.objectContaining({ content: 'Première partie.\nSuite.' })
    ]);
    expect(JSON.stringify(port.messages)).not.toContain('internal thought');
  });

  it('keeps a failed automatic analysis out of the chat', async () => {
    await setup({ '/api/gemini': () => response({ error: 'boom' }, 500) });
    const port = openPanel();

    await background.handleUrlChange(LIMOVA_TAB, 'https://new.limova.ai/documents');

    expect(errors(port)).toEqual([]);
    expect(port.messages.at(-1)).toEqual({ type: 'STATUS_UPDATE', status: 'ready' });
  });

  it('still reports a failed request the user asked for, in plain words', async () => {
    await setup({ '/v2/turn': () => Promise.reject(new TypeError('Failed to fetch')) });
    const port = openPanel();

    await message({ type: 'USER_MESSAGE', text: 'Crée un agent' });

    expect(errors(port)).toEqual([{
      type: 'ERROR',
      content: 'Impossible de joindre le service Limova. Vérifie ta connexion internet puis réessaie.',
      code: 'PROXY_NETWORK_FAILED'
    }]);
  });
});

describe('plain error messages', () => {
  it('replaces technical messages and keeps our own sentences', async () => {
    await setup();
    const error = message => Object.assign(new Error(message));

    expect(background.userFacingErrorMessage(error('signal timed out'), 'PROXY_REQUEST_TIMEOUT')).toBe('Charly met trop de temps à répondre. Réessaie dans un instant.');
    expect(background.userFacingErrorMessage(error('Gemini Error: Service Unavailable'), 'GEMINI_HTTP_5XX')).toBe('Le service est momentanément surchargé. Réessaie dans un instant.');
    expect(background.userFacingErrorMessage(error('Unexpected token <'), 'UNEXPECTED_ERROR')).toBe('Charly n’a pas pu répondre. Réessaie dans un instant.');
    expect(background.userFacingErrorMessage(error('Ta session Charly a expiré. Reconnecte-toi pour continuer.'), 'AUTH_SESSION_MISSING')).toBe('Ta session Charly a expiré. Reconnecte-toi pour continuer.');
  });
});
