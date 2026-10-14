import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('background.js — service worker smoke test', () => {
  let chromeMock;
  let background;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    // Loading background registers all its listeners via side effects
    vi.resetModules();
    background = await import('../../../src/background.js');
    // Give async bootstrap (restoreSession, etc.) a tick
    await new Promise(r => setTimeout(r, 10));
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  it('loads without throwing', () => {
    expect(chromeMock).toBeDefined();
  });

  it('registers onInstalled listener', () => {
    expect(chromeMock._listeners.runtime.onInstalled.length).toBeGreaterThan(0);
  });

  it('registers onMessage listener', () => {
    expect(chromeMock._listeners.runtime.onMessage.length).toBeGreaterThan(0);
  });

  it('registers onConnect listener for the sidebar port', () => {
    expect(chromeMock._listeners.runtime.onConnect.length).toBeGreaterThan(0);
  });

  it('registers popup lifecycle and tab state listeners', () => {
    expect(chromeMock._listeners.tabs.onCreated.length).toBeGreaterThan(0);
    expect(chromeMock._listeners.tabs.onUpdated.length).toBeGreaterThan(0);
    expect(chromeMock._listeners.tabs.onActivated.length).toBeGreaterThan(0);
    expect(chromeMock._listeners.tabs.onRemoved.length).toBeGreaterThan(0);
  });

  it('reads UI language on boot', () => {
    expect(chromeMock.i18n.getUILanguage).toHaveBeenCalled();
  });

  it('removes legacy local sessions on boot', () => {
    expect(chromeMock.storage.local.remove).toHaveBeenCalledWith([
      'limova_analytics_consent', 'limova_session', 'charly_auth_session_v1'
    ]);
  });
});

describe('background.js — onMessage router', () => {
  let chromeMock;
  let dispatch;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    await import('../../../src/background.js');
    await new Promise(r => setTimeout(r, 10));

    // Build a dispatcher that runs the first onMessage listener with the
    // Chrome MV3 calling convention.
    const listener = chromeMock._listeners.runtime.onMessage[0];
    dispatch = (request, sender = {
      id: chromeMock.runtime.id,
      url: chromeMock.runtime.getURL('src/sidebar/sidebar.html')
    }) =>
      new Promise((resolve) => {
        const ret = listener(request, sender, resolve);
        // If the listener returned true, it indicates async response via sendResponse
        // If it returned a Promise (not standard MV3 but used by some),
        // resolve with its value
        if (ret && typeof ret.then === 'function') ret.then(resolve);
      });
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  it('GET_SESSION_STATE returns an active flag', async () => {
    const result = await dispatch({ type: 'GET_SESSION_STATE' });
    expect(result).toHaveProperty('active');
    expect(typeof result.active).toBe('boolean');
    expect(typeof result.training).toBe('boolean');
  });

  it('does not allow a Limova content script to access the privileged account client', async () => {
    const result = await dispatch({ type: 'LIMOVA_GET_STATE' }, {
      id: chromeMock.runtime.id,
      url: 'https://new.limova.ai/',
      tab: { id: 1, url: 'https://new.limova.ai/' },
    });
    expect(result).toEqual({ error: 'Unauthorized message source' });
  });

  it('GET_STATE advertises only native Studio capabilities', async () => {
    const result = await dispatch({ type: 'GET_STATE' });
    expect(result.extensionVersion).toBeTruthy();
    expect(result.capabilities).toEqual({
      training: true,
      externalPopupLifecycle: true,
      realEvaluation: true,
      longTrainingRecording: true
    });
    expect(result).not.toHaveProperty('auth');
    expect(result).not.toHaveProperty('copilot');
  });

  it('rejects messages without the extension sender identity', async () => {
    const result = await dispatch({ type: 'GET_SETTINGS' }, {});
    expect(result).toEqual({ error: 'Unauthorized message source' });
  });

  it('only accepts the minimal content-script message surface', async () => {
    const sender = {
      id: chromeMock.runtime.id,
      url: 'https://new.limova.ai/dashboard',
      tab: { id: 42, url: 'https://new.limova.ai/dashboard' }
    };
    expect(await dispatch({ type: 'GET_SESSION_STATE' }, sender)).toHaveProperty('active');
    expect(await dispatch({ type: 'GET_SETTINGS' }, sender))
      .toEqual({ error: 'Unauthorized message source' });
  });

  it.each(['GET_SETTINGS', 'SAVE_SETTINGS', 'AUTH_REQUEST_OTP', 'VOICE_TRANSCRIPT'])(
    'rejects removed legacy route %s', async type => {
      expect(await dispatch({ type })).toEqual({ error: 'Unknown message type' });
    }
  );

  it('GET_LOGS returns a logs string', async () => {
    const result = await dispatch({ type: 'GET_LOGS' });
    expect(result).toHaveProperty('logs');
    expect(typeof result.logs).toBe('string');
    expect(result.logs).toContain('Limova');
  });

  it('SET_LANG acknowledges language switch', async () => {
    const result = await dispatch({ type: 'SET_LANG', lang: 'es' });
    expect(result).toEqual({ ok: true });
  });

  it('requires an explicit opt-in for AI processing', async () => {
    const initial = await dispatch({ type: 'GET_PRIVACY_STATE' });
    expect(initial.aiProcessing).toBe(false);
    expect(initial.aiProcessingDecided).toBe(false);
    expect(initial).not.toHaveProperty('analytics');
    expect(await dispatch({ type: 'AI_PROCESSING_CONSENT', granted: true })).toEqual({ ok: true });
    const enabled = await dispatch({ type: 'GET_PRIVACY_STATE' });
    expect(enabled.aiProcessing).toBe(true);
    expect(enabled.aiProcessingDecided).toBe(true);
  });

  it('unknown message types return an error', async () => {
    const result = await dispatch({ type: 'DEFINITELY_NOT_A_REAL_TYPE' });
    expect(result).toEqual({ error: 'Unknown message type' });
  });

});
