export function createBrowserAuthority({ tabs, hasConsent, hasSiteAccess, readBinding }) {
  return async function authorize(context, action, signal) {
    signal?.throwIfAborted();
    const target = action?.target ? Object.freeze({ ...action.target }) : undefined;
    if (!target || !Number.isSafeInteger(target.tabId) || target.tabId < 0
      || !Number.isSafeInteger(target.contextVersion) || target.contextVersion < 0) throw new Error('Invalid browser target');
    const origin = new URL(target.origin);
    if (origin.protocol !== 'https:' || origin.origin !== target.origin) throw new Error('Invalid browser origin');
    if (!await hasConsent(context, signal)) throw new Error('Browser consent required');
    if (!await hasSiteAccess(target.origin, target.tabId, signal)) throw new Error('Browser site access required');
    signal?.throwIfAborted();
    const [tab, active] = await Promise.all([
      tabs.get(target.tabId),
      tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    if (!tab || !tab.active || tab.discarded || active.length !== 1 || active[0].id !== target.tabId
      || new URL(tab.url).origin !== target.origin || tab.pendingUrl) throw new Error('Browser target changed');
    const current = await readBinding(target.tabId, signal);
    signal?.throwIfAborted();
    if (current?.tabId !== target.tabId || current.origin !== target.origin
      || current.contextVersion !== target.contextVersion) throw new Error('Browser page changed');
    return { ...current };
  };
}
