import { captureBrowserScreenshot } from './browser-screenshot.js';
import { waitForBrowserReady } from './browser-ready.js';
import { createBrowserAuthority } from './browser-authority.js';
import { createBrowserBinding } from './browser-binding.js';

const DOCUMENT_OPERATIONS = new Set(['read_page', 'click', 'type_text', 'scroll', 'highlight', 'navigate']);

export function createBrowserDriver({ chrome, journal, scope, hasConsent, uploadScreenshot, onBound = () => {} }) {
  scope = Object.freeze({ ...scope });
  let tabId;
  const hasSiteAccess = origin => chrome.permissions.contains({ origins: [`${origin}/*`] });
  const binding = createBrowserBinding({ scripting: chrome.scripting,
    allocateVersion: async signal => {
      signal?.throwIfAborted();
      const version = await journal.allocateVersion(scope);
      signal?.throwIfAborted();
      return version;
    } });
  const authorize = createBrowserAuthority({ tabs: chrome.tabs, hasConsent, hasSiteAccess,
    readBinding: (id, signal) => binding.inspect(id, signal) });
  const pageOnly = page => ({ tabId: page.tabId, origin: page.origin, contextVersion: page.contextVersion });
  return {
    async readPage(signal) {
      signal?.throwIfAborted();
      if (!await hasConsent(scope, signal)) throw new Error('Browser consent required');
      const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active.length !== 1 || !Number.isSafeInteger(active[0].id)) throw new Error('Browser active tab unavailable');
      if (tabId !== undefined && active[0].id !== tabId) throw new Error('Browser target changed');
      const tab = await waitForBrowserReady(chrome.tabs, active[0].id, signal);
      if (tabId !== undefined && tab.id !== tabId) throw new Error('Browser target changed');
      const url = new URL(tab.url);
      if (url.protocol !== 'https:' || tab.pendingUrl || tab.discarded) throw new Error('Browser page unavailable');
      if (!await hasSiteAccess(url.origin)) throw new Error('Browser site access required');
      const page = await binding.bind(tab.id, url.origin, signal);
      await authorize(scope, { target: pageOnly(page) }, signal);
      tabId = tab.id;
      onBound(tabId);
      return pageOnly(page);
    },
    async authorize(context, action, signal) {
      if (context.userId !== scope.userId || context.workspaceId !== scope.workspaceId
        || action.target?.tabId !== tabId) throw new Error('Browser context changed');
      return authorize(scope, action, signal);
    },
    async execute(action, signal) {
      if (action.target?.tabId !== tabId) throw new Error('Browser target changed');
      if (action.input.operation === 'screenshot') {
        return captureBrowserScreenshot({ chrome, binding, action, signal, upload: uploadScreenshot,
          authorize: () => authorize(scope, action, signal) });
      }
      if (!DOCUMENT_OPERATIONS.has(action.input.operation)) {
        return { status: 'rejected', observation: 'This browser operation is not available in the current driver.' };
      }
      let destination;
      if (action.input.operation === 'navigate') {
        try { destination = new URL(action.input.url); } catch {
          return { status: 'rejected', observation: 'Invalid navigation URL.' };
        }
        if (destination.protocol !== 'https:' || destination.username || destination.password
          || action.input.url.length > 2048 || !await hasSiteAccess(destination.origin)) {
          return { status: 'rejected', observation: 'Navigation destination is not authorized.' };
        }
      }
      return binding.execute(action.target, action.input.operation, action.input, signal, async () => {
        if (destination && !await hasSiteAccess(destination.origin)) throw new Error('Browser destination access revoked');
        await authorize(scope, action, signal);
      });
    },
  };
}
