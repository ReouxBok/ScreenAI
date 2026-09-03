import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

const token = 'training-token-that-survives-worker-restart';
const session = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Créer une campagne',
  goal: 'Créer le brouillon',
  agentKey: 'charly',
  startPath: '/'
};

function dispatchFromSidebar(chromeMock, request) {
  const listener = chromeMock._listeners.runtime.onMessage[0];
  return new Promise((resolve) => {
    listener(request, {
      id: chromeMock.runtime.id,
      url: chromeMock.runtime.getURL('src/sidebar/sidebar.html')
    }, resolve);
  });
}

describe('training recovery after a Manifest V3 worker restart', () => {
  afterEach(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
    vi.restoreAllMocks();
  });

  it('restores event capture and finalizes with the persisted training token', async () => {
    const chromeMock = installFullChromeMock();
    await chromeMock.storage.session.set({
      charly_training_active_v1: { token, session, savedAt: Date.now() }
    });
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/events')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ordinal: 42 }) };
      }
      if (String(url).endsWith('/complete')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, id: session.id }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    vi.resetModules();
    await import('../../../src/background.js');

    const eventResult = await dispatchFromSidebar(chromeMock, {
      type: 'TRAINING_EVENT',
      event: { kind: 'click', path: '/campaigns', label: 'Créer' }
    });
    const completionResult = await dispatchFromSidebar(chromeMock, { type: 'STOP_TRAINING' });

    expect(eventResult).toEqual({ ok: true });
    expect(completionResult).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/events$/),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) })
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/complete$/),
      expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } })
    );
    expect(chromeMock._sessionStorage.has('charly_training_active_v1')).toBe(false);
  });

  it('notifies the Studio when an interrupted restored training is cancelled', async () => {
    const chromeMock = installFullChromeMock();
    await chromeMock.storage.session.set({
      charly_training_active_v1: { token, session, savedAt: Date.now() }
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, id: session.id, status: 'archived' })
    }));

    vi.resetModules();
    await import('../../../src/background.js');

    const result = await dispatchFromSidebar(chromeMock, { type: 'CANCEL_TRAINING' });

    expect(result).toEqual({ ok: true, recovered: false, status: 'archived' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/cancel$/),
      expect.objectContaining({ method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    );
    expect(chromeMock._sessionStorage.has('charly_training_active_v1')).toBe(false);
  });

  it('never connects the Studio before a Limova tab has been validated', async () => {
    const chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn();
    vi.resetModules();
    await import('../../../src/background.js');

    const result = await dispatchFromSidebar(chromeMock, { type: 'START_TRAINING', token });

    expect(result).toEqual({ ok: false, error: 'Ouvre Limova avant de démarrer la démonstration.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('cancels the server session when page preparation fails after connect', async () => {
    const chromeMock = installFullChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, url: 'https://new.limova.ai/home', active: true }]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('content unavailable'));
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('reinjection failed'));
    globalThis.fetch = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/connect') ? session : { ok: true, status: 'archived' }
    }));
    vi.resetModules();
    await import('../../../src/background.js');

    const result = await dispatchFromSidebar(chromeMock, { type: 'START_TRAINING', token });

    expect(result.ok).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/cancel$/),
      expect.objectContaining({ method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    );
    expect(chromeMock._sessionStorage.has('charly_training_active_v1')).toBe(false);
  });
});
