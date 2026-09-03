/**
 * Minimal Chrome extension API mock for unit tests.
 * Provides just enough surface for Logger, i18n, and message passing.
 */
import { vi } from 'vitest';

export function createChromeMock({ lang = 'en-US', manifestVersion = '2.1.0' } = {}) {
  const storage = new Map();

  return {
    runtime: {
      getManifest: vi.fn(() => ({ version: manifestVersion })),
      sendMessage: vi.fn(() => Promise.resolve()),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    i18n: {
      getUILanguage: vi.fn(() => lang)
    },
    storage: {
      local: {
        get: vi.fn(async (key) => {
          if (typeof key === 'string') {
            return storage.has(key) ? { [key]: storage.get(key) } : {};
          }
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
        clear: vi.fn(async () => storage.clear())
      }
    },
    _storage: storage
  };
}

export function installChromeMock(options) {
  const mock = createChromeMock(options);
  globalThis.chrome = mock;
  return mock;
}

export function uninstallChromeMock() {
  delete globalThis.chrome;
}
