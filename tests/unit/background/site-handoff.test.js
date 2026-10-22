import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('sites opened to Charly and Limova handoff', () => {
  let background;
  let chromeMock;
  let grantedOrigins;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    grantedOrigins = [];
    chromeMock.runtime.getManifest = vi.fn(() => ({
      version: '2.2.46',
      host_permissions: ['https://new.limova.ai/*', 'https://vercel.com/*']
    }));
    chromeMock.permissions = {
      getAll: vi.fn(async () => ({ origins: grantedOrigins })),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() }
    };
    chromeMock.scripting.registerContentScripts = vi.fn(async () => {});
    chromeMock.tabs.create = vi.fn(async () => ({ id: 99 }));
    chromeMock.scripting.unregisterContentScripts = vi.fn(async () => {});
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  beforeEach(async () => {
    grantedOrigins = ['https://new.limova.ai/*', 'https://vercel.com/*', 'https://www.linkedin.com/*'];
    await background.refreshGrantedSites();
  });

  it('treats only user-granted sites as assisted, never the hosts the manifest requires', () => {
    expect(background.isAssistedUrl('https://www.linkedin.com/feed/')).toBe(true);
    expect(background.isAssistedUrl('https://new.limova.ai/chat/new')).toBe(true);
    expect(background.isAssistedUrl('https://vercel.com/dashboard')).toBe(false);
    expect(background.isAssistedUrl('https://www.google.com/')).toBe(false);
  });

  it('loads the content script on granted sites only', () => {
    expect(chromeMock.scripting.registerContentScripts).toHaveBeenLastCalledWith([
      expect.objectContaining({ matches: ['https://www.linkedin.com/*'], js: ['src/content/content.js'] })
    ]);
  });

  it('accepts the stop button from a granted site but not from an unknown one', async () => {
    const [onMessage] = chromeMock._listeners.runtime.onMessage;
    const reply = sender => new Promise(resolve => onMessage({ type: 'STOP_AGENT' }, sender, resolve));
    const sender = url => ({ id: chromeMock.runtime.id, url, tab: { id: 9, url } });

    await expect(reply(sender('https://www.linkedin.com/feed/'))).resolves.toEqual({ ok: true });
    await expect(reply(sender('https://www.google.com/'))).resolves.toEqual({ error: 'Unauthorized message source' });
  });

  it('builds a prompt with the request, the page and the selection, within the chat limit', () => {
    const prompt = background.buildLimovaHandoffPrompt('Fais-moi un post LinkedIn', {
      title: 'Réseau | LinkedIn',
      url: 'https://www.linkedin.com/mynetwork/',
      selection: 'Limova AI met l’IA en production',
      text: 'x'.repeat(20_000)
    });

    expect(prompt.startsWith('Fais-moi un post LinkedIn\n')).toBe(true);
    expect(prompt).toContain('Page : Réseau | LinkedIn');
    expect(prompt).toContain('Adresse : https://www.linkedin.com/mynetwork/');
    expect(prompt).toContain('"""\nLimova AI met l’IA en production\n"""');
    expect(prompt.length).toBeLessThanOrEqual(8000);
  });

  it('refuses a handoff from a site the user has not allowed', async () => {
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    chromeMock.tabs.query.mockResolvedValueOnce([{ id: 4, url: 'https://www.google.com/' }]);

    const result = await background.handoffToLimova('Résume cette page');

    expect(result).toMatchObject({ ok: false });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
