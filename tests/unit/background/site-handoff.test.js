import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('Charly on other sites and Limova handoff', () => {
  let background;
  let chromeMock;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    chromeMock.tabs.create = vi.fn(async () => ({ id: 99 }));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  function deliver(type, url) {
    const [onMessage] = chromeMock._listeners.runtime.onMessage;
    const sender = { id: chromeMock.runtime.id, url, tab: { id: 9, url } };
    return new Promise(resolve => onMessage({ type, profile: {} }, sender, resolve));
  }

  it('assists any web page but not the browser’s own pages', () => {
    expect(background.isAssistedUrl('https://www.linkedin.com/feed/')).toBe(true);
    expect(background.isAssistedUrl('https://new.limova.ai/chat/new')).toBe(true);
    expect(background.isAssistedUrl('chrome://extensions')).toBe(false);
    expect(background.isAssistedUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
  });

  it('accepts the stop button from any site', async () => {
    await expect(deliver('STOP_AGENT', 'https://www.linkedin.com/feed/')).resolves.toEqual({ ok: true });
  });

  it('keeps profile, training and modal messages bound to Limova', async () => {
    const rejected = { error: 'Unauthorized message source' };
    await expect(deliver('LIMOVA_PROFILE', 'https://evil.example/')).resolves.toEqual(rejected);
    await expect(deliver('TRAINING_EVENT', 'https://evil.example/')).resolves.toEqual(rejected);
    await expect(deliver('MODAL_DETECTED', 'https://evil.example/')).resolves.toEqual(rejected);
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

  it('does not hand off from a browser page', async () => {
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    chromeMock.tabs.query.mockResolvedValueOnce([{ id: 4, url: 'chrome://newtab/' }]);

    const result = await background.handoffToLimova('Résume cette page');

    expect(result).toMatchObject({ ok: false });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('opens only web addresses the user names', () => {
    expect(background.normalizeRequestedPageUrl('lemonde.fr')).toBe('https://lemonde.fr/');
    expect(background.normalizeRequestedPageUrl('https://www.lefigaro.fr/actualite-france')).toBe('https://www.lefigaro.fr/actualite-france');
    expect(background.normalizeRequestedPageUrl('javascript:alert(1)')).toBeNull();
    expect(background.normalizeRequestedPageUrl('chrome://settings')).toBeNull();
    expect(background.normalizeRequestedPageUrl('file:///etc/passwd')).toBeNull();
    expect(background.normalizeRequestedPageUrl('https://user:pass@evil.example')).toBeNull();
    expect(background.normalizeRequestedPageUrl('bonjour')).toBeNull();
  });

  it('opens a named site next to Limova instead of replacing it', async () => {
    chromeMock.tabs.create.mockClear();
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    chromeMock.tabs.query.mockResolvedValueOnce([{ id: 4, index: 2, url: 'https://new.limova.ai/home' }]);
    chromeMock.tabs.get.mockResolvedValueOnce({ id: 99, status: 'complete', active: true, url: 'https://lemonde.fr/' });

    await background.openPageForUser('lemonde.fr');

    expect(chromeMock.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://lemonde.fr/', index: 3, openerTabId: 4, active: true }));
  });
});
