/**
 * Fuller chrome.* mock for loading background.js as a module.
 * Captures all listener registrations so tests can drive the service worker
 * by invoking them directly.
 */
import { vi } from 'vitest';

export function installFullChromeMock({ lang = 'en-US', version = '2.1.0' } = {}) {
  const storage = new Map();
  const sessionStorage = new Map();
  const listeners = {
    runtime: { onInstalled: [], onMessage: [], onConnect: [], onStartup: [] },
    tabs: { onCreated: [], onUpdated: [], onActivated: [], onRemoved: [] },
    webNavigation: { onHistoryStateUpdated: [], onCompleted: [] }
  };

  const makeEvent = (arr) => ({
    addListener: vi.fn((fn) => arr.push(fn)),
    removeListener: vi.fn((fn) => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }),
    hasListener: vi.fn((fn) => arr.includes(fn))
  });

  const mock = {
    runtime: {
      id: 'test',
      getManifest: vi.fn(() => ({ version })),
      getURL: vi.fn((p) => `chrome-extension://test/${p}`),
      sendMessage: vi.fn(() => Promise.resolve()),
      onInstalled: makeEvent(listeners.runtime.onInstalled),
      onMessage: makeEvent(listeners.runtime.onMessage),
      onConnect: makeEvent(listeners.runtime.onConnect),
      onStartup: makeEvent(listeners.runtime.onStartup)
    },
    i18n: {
      getUILanguage: vi.fn(() => lang)
    },
    storage: {
      local: {
        get: vi.fn(async (key) => {
          if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) if (storage.has(k)) out[k] = storage.get(k);
            return out;
          }
          return Object.fromEntries(storage);
        }),
        set: vi.fn(async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        }),
        remove: vi.fn(async (key) => { storage.delete(key); }),
        clear: vi.fn(async () => { storage.clear(); })
      },
      session: {
        get: vi.fn(async (key) => {
          if (typeof key === 'string') return sessionStorage.has(key) ? { [key]: sessionStorage.get(key) } : {};
          return Object.fromEntries(sessionStorage);
        }),
        set: vi.fn(async (obj) => {
          for (const [k, v] of Object.entries(obj)) sessionStorage.set(k, v);
        }),
        remove: vi.fn(async (key) => { sessionStorage.delete(key); }),
        clear: vi.fn(async () => { sessionStorage.clear(); })
      }
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async (id) => ({ id, windowId: 1, url: 'https://new.limova.ai/home', active: true })),
      update: vi.fn(async () => ({})),
      sendMessage: vi.fn(() => Promise.resolve()),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,ABCD'),
      onCreated: makeEvent(listeners.tabs.onCreated),
      onUpdated: makeEvent(listeners.tabs.onUpdated),
      onActivated: makeEvent(listeners.tabs.onActivated),
      onRemoved: makeEvent(listeners.tabs.onRemoved)
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: null }])
    },
    webNavigation: {
      onHistoryStateUpdated: makeEvent(listeners.webNavigation.onHistoryStateUpdated),
      onCompleted: makeEvent(listeners.webNavigation.onCompleted)
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      open: vi.fn(async () => {})
    },
    action: {
      onClicked: makeEvent([])
    },
    _storage: storage,
    _sessionStorage: sessionStorage,
    _listeners: listeners
  };

  globalThis.chrome = mock;
  return mock;
}

export function uninstallFullChromeMock() {
  delete globalThis.chrome;
}
