// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

const LIMOVA_TAB = 17;
const MODAL = { title: 'Connecter Google Drive', role: 'dialog', controls: ['Autoriser'] };

function createSidebarPort() {
  const disconnectListeners = [];
  return {
    name: 'sidebar',
    messages: [],
    postMessage: vi.fn(function postMessage(message) { this.messages.push(message); }),
    onDisconnect: { addListener: vi.fn(listener => disconnectListeners.push(listener)) },
    disconnect() {
      disconnectListeners.splice(0).forEach(listener => listener());
    }
  };
}

function analysisStatuses(port, chromeMock) {
  return [
    ...port.messages,
    ...chromeMock.runtime.sendMessage.mock.calls.map(([message]) => message)
  ].filter(message => message?.type === 'STATUS_UPDATE' && message.status === 'analyzing');
}

describe('closed side panel keeps the assistant silent', () => {
  let background;
  let chromeMock;
  let port;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  beforeEach(async () => {
    port = createSidebarPort();
    chromeMock._listeners.runtime.onConnect[0](port);
    background.handleResetSession();
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: '' }]);
    background.lockTab(LIMOVA_TAB);
    chromeMock.tabs.sendMessage.mockReset();
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    chromeMock.runtime.sendMessage.mockClear();
    delete chromeMock.runtime.getContexts;
    port.messages.length = 0;
  });

  afterEach(() => port.disconnect());

  it('analyzes a detected modal while the panel is open', async () => {
    await background.handleMessage({ type: 'MODAL_DETECTED', modal: MODAL }, { tab: { id: LIMOVA_TAB } });

    expect(analysisStatuses(port, chromeMock)).toHaveLength(1);
  });

  it('stops page observation and ignores modals once the panel is closed', async () => {
    port.disconnect();

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(LIMOVA_TAB, { type: 'SESSION_STATE', active: false });
    const result = await background.handleMessage({ type: 'MODAL_DETECTED', modal: MODAL }, { tab: { id: LIMOVA_TAB } });

    expect(result).toEqual({ ok: true, ignored: true });
    expect(analysisStatuses(port, chromeMock)).toHaveLength(0);
  });

  it('does not analyze a new page after the panel is closed', async () => {
    port.disconnect();
    chromeMock._listeners.tabs.onUpdated[0](LIMOVA_TAB, { status: 'complete' }, { url: 'https://new.limova.ai/documents' });
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(analysisStatuses(port, chromeMock)).toHaveLength(0);
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(LIMOVA_TAB, expect.objectContaining({ type: 'HIGHLIGHT_ELEMENT' }));
  });

  it('ignores manual page interactions after the panel is closed', async () => {
    port.disconnect();
    const result = await background.handleMessage(
      { type: 'USER_PAGE_INTERACTION', interaction: { kind: 'click', label: 'Documents' } },
      { tab: { id: LIMOVA_TAB, url: 'https://new.limova.ai/' } }
    );

    expect(result).toEqual({ ok: true, ignored: true });
  });

  it('resumes page observation when the panel reopens', async () => {
    port.disconnect();
    chromeMock.tabs.sendMessage.mockClear();
    port = createSidebarPort();
    chromeMock._listeners.runtime.onConnect[0](port);

    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(LIMOVA_TAB, { type: 'SESSION_STATE', active: true });
    await background.handleMessage({ type: 'MODAL_DETECTED', modal: MODAL }, { tab: { id: LIMOVA_TAB } });
    expect(analysisStatuses(port, chromeMock)).toHaveLength(1);
  });

  it('keeps working when a restarted worker has not received the open panel port yet', async () => {
    port.disconnect();
    chromeMock.runtime.getContexts = vi.fn(async () => [{ contextType: 'SIDE_PANEL' }]);

    const result = await background.handleMessage({ type: 'MODAL_DETECTED', modal: MODAL }, { tab: { id: LIMOVA_TAB } });

    expect(result).not.toEqual({ ok: true, ignored: true });
    expect(chromeMock.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['SIDE_PANEL'] });
  });

  describe('switching tabs while the panel is open', () => {
    const FIGARO_TAB = 31;

    function activate(tabId, url) {
      chromeMock.tabs.get.mockImplementation(async id => (
        id === tabId ? { id, windowId: 1, active: true, url } : { id, windowId: 1, active: false, url: 'https://new.limova.ai/home' }
      ));
      return new Promise(resolve => {
        chromeMock._listeners.tabs.onActivated[0]({ tabId });
        setTimeout(resolve, 400);
      });
    }

    afterEach(() => chromeMock.tabs.get.mockImplementation(async id => ({ id, windowId: 1, url: 'https://new.limova.ai/home', active: true })));

    it('follows the user to another site instead of sending them back to Limova', async () => {
      await activate(FIGARO_TAB, 'https://www.lefigaro.fr/actualite-france/article-20261022');

      const types = port.messages.map(message => message.type);
      expect(types).toContain('CORRECT_TAB');
      expect(types).not.toContain('WRONG_TAB');
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(FIGARO_TAB, { type: 'SESSION_STATE', active: true });
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(LIMOVA_TAB, { type: 'SESSION_STATE', active: false });
      // The written chat refreshes its page map silently on other sites.
      expect(analysisStatuses(port, chromeMock)).toHaveLength(0);
    });

    it('still warns on a browser page Charly cannot read', async () => {
      await activate(FIGARO_TAB, 'chrome://settings/');

      expect(port.messages.map(message => message.type)).toContain('WRONG_TAB');
      expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(FIGARO_TAB, { type: 'SESSION_STATE', active: true });
    });

    it('does not warn about a wrong tab when Charly opens a site from Limova', async () => {
      const OPENED_TAB = 40;
      chromeMock.tabs.query.mockResolvedValueOnce([{ id: LIMOVA_TAB, index: 1, url: 'https://new.limova.ai/home' }]);
      // Chrome activates the new tab before its address is committed.
      chromeMock.tabs.get.mockImplementation(async id => ({ id, windowId: 1, active: id === OPENED_TAB, status: 'complete', url: id === OPENED_TAB ? '' : 'https://new.limova.ai/home' }));
      chromeMock.tabs.create = vi.fn(async () => {
        chromeMock._listeners.tabs.onActivated[0]({ tabId: OPENED_TAB });
        return { id: OPENED_TAB };
      });

      await background.openPageForUser('lefigaro.fr');
      await new Promise(resolve => setTimeout(resolve, 400));

      const types = port.messages.map(message => message.type);
      expect(types).toContain('CORRECT_TAB');
      expect(types).not.toContain('WRONG_TAB');
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(LIMOVA_TAB, { type: 'SESSION_STATE', active: false });
    });

    it('moves Charly to the Limova conversation after a spoken content request', async () => {
      const HANDOFF_TAB = 41;
      const article = 'https://www.lefigaro.fr/actualite-france/article-20261022';
      background.lockTab(FIGARO_TAB);
      chromeMock.tabs.query.mockResolvedValue([{ id: FIGARO_TAB, index: 1, active: true, url: article }]);
      chromeMock.tabs.create = vi.fn(async () => ({ id: HANDOFF_TAB }));
      chromeMock.tabs.get.mockImplementation(async id => ({ id, windowId: 1, active: true, status: 'complete', url: id === HANDOFF_TAB ? 'https://new.limova.ai/' : article }));
      chromeMock.tabs.sendMessage.mockImplementation(async (tabId, message) => (
        message.type === 'GET_READABLE_CONTENT'
          ? { ok: true, title: 'Manifestation à Paris', url: article, text: 'Le cortège partira de Bastille.' }
          : message.type === 'LIMOVA_COMPOSE_AND_SEND' ? { ok: true, sent: true } : { ok: true }
      ));
      port.messages.length = 0;

      const result = await background.createInLimovaByVoice('Rédige un post LinkedIn sur cet article');

      expect(result).toMatchObject({ ok: true, sent: true });
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(HANDOFF_TAB, expect.objectContaining({
        type: 'LIMOVA_COMPOSE_AND_SEND',
        prompt: expect.stringContaining('Rédige un post LinkedIn sur cet article')
      }));
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(FIGARO_TAB, { type: 'SESSION_STATE', active: false });
      expect(port.messages.map(message => message.type)).toContain('CORRECT_TAB');
      chromeMock.tabs.query.mockResolvedValue([]);
    });

    it('stops a Limova message being written when the voice conversation ends', async () => {
      await background.handleMessage({ type: 'VOICE_SESSION_STATE', active: true }, {});
      await background.showAgentPresence(42);

      await background.handleMessage({ type: 'VOICE_SESSION_STATE', active: false }, {});

      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'AGENT_PRESENCE', active: false, stop: true });
    });
  });
});
