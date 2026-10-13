export function waitForBrowserReady(tabs, tabId, signal, timeoutMs = 15000) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let revision = 0;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tabs.onUpdated.removeListener(updated);
      tabs.onRemoved.removeListener(removed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(tab);
    };
    const check = async () => {
      const current = ++revision;
      try {
        const tab = await tabs.get(tabId);
        if (settled || current !== revision) return;
        if (tab.discarded) finish(new Error('Browser tab discarded'));
        else if (!tab.pendingUrl && tab.status !== 'loading') finish(null, tab);
      } catch (error) { if (current === revision) finish(error); }
    };
    const updated = id => { if (id === tabId) void check(); };
    const removed = id => { if (id === tabId) finish(new Error('Browser tab closed')); };
    const aborted = () => finish(signal.reason ?? new Error('Browser wait aborted'));
    const timer = setTimeout(() => finish(new Error('Browser page loading timed out')), timeoutMs);
    tabs.onUpdated.addListener(updated);
    tabs.onRemoved.addListener(removed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else void check();
  });
}
