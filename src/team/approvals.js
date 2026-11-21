// approvals.js — Ask the person in a small Chrome window (TEAM-724).
//
// Used for two things only since `browser.v2` (TEAM-726): a payment (« Limova Team veut
// cliquer sur « Payer » sur example.com », « Autoriser » / « Refuser »), and
// `browser.request_tab` (the person picks one of their tabs, or refuses). Routine
// actions and autonomy changes no longer open a window.
//
// The window only carries an opaque id in its URL; it reads the details from the
// service worker by message, so element names and domains never land in Chrome's
// history. Details stay in memory and are dropped once decided.
//
// Outcomes: `approve`, `deny` (refused, or window closed), `timeout` (deadline
// reached), `cancelled` (« Tout arrêter » or the connection went away).

export const APPROVAL_PAGE = 'src/team/approval.html';

export function createApprovalManager({
  windowsApi = globalThis.chrome?.windows,
  getUrl = path => globalThis.chrome.runtime.getURL(path),
  timers = globalThis,
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID()
} = {}) {
  const pending = new Map();

  function finish(id, outcome) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    if (entry.timer) timers.clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    if (entry.windowId !== null && outcome.decision !== 'deny-closed') {
      Promise.resolve(windowsApi?.remove(entry.windowId)).catch(() => {});
    }
    entry.resolve({ ...outcome, decision: outcome.decision === 'deny-closed' ? 'deny' : outcome.decision });
    return true;
  }

  /**
   * @param {object} details what the window shows: {kind, productId, productLabel, productColor, title, lines, tabs?}
   * @param {{deadlineMs: number, signal?: AbortSignal}} options
   * @returns {Promise<{decision: 'approve'|'deny'|'timeout'|'cancelled', tabId?: number}>}
   */
  function request(details, { deadlineMs, signal } = {}) {
    const id = randomId();
    return new Promise(resolve => {
      const entry = { id, details: { ...details, expires_at: deadlineMs }, resolve, windowId: null, timer: null, signal, onAbort: null };
      pending.set(id, entry);
      const remaining = Math.max(0, Number(deadlineMs) - now());
      entry.timer = timers.setTimeout(() => finish(id, { decision: 'timeout' }), remaining);
      if (signal) {
        entry.onAbort = () => finish(id, { decision: 'cancelled' });
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
        signal.addEventListener?.('abort', entry.onAbort, { once: true });
      }
      Promise.resolve(windowsApi?.create({
        type: 'popup',
        url: getUrl(`${APPROVAL_PAGE}?id=${encodeURIComponent(id)}`),
        width: 440,
        height: details.kind === 'request_tab' ? 560 : 400,
        focused: true
      })).then(window => {
        const current = pending.get(id);
        if (!current) {
          if (window?.id !== undefined) Promise.resolve(windowsApi?.remove(window.id)).catch(() => {});
          return;
        }
        current.windowId = window?.id ?? null;
      }).catch(() => {
        // No window, no way to ask: refuse rather than act.
        finish(id, { decision: 'deny' });
      });
    });
  }

  return {
    request,
    get(id) {
      const entry = pending.get(id);
      return entry ? { id, ...entry.details } : null;
    },
    decide(id, decision, extra = {}) {
      if (!['approve', 'deny'].includes(decision)) return false;
      const entry = pending.get(id);
      if (!entry) return false;
      if (decision === 'approve' && entry.details.kind === 'request_tab' && !Number.isInteger(extra.tabId)) return false;
      return finish(id, decision === 'approve' && entry.details.kind === 'request_tab'
        ? { decision, tabId: extra.tabId }
        : { decision });
    },
    // The person closed the window: same as « Refuser ».
    windowClosed(windowId) {
      for (const [id, entry] of pending) {
        if (entry.windowId === windowId) finish(id, { decision: 'deny-closed' });
      }
    },
    // « Tout arrêter »: close every open approval of a product as refused.
    denyAll(productId) {
      let count = 0;
      for (const [id, entry] of [...pending]) {
        if (!productId || entry.details.productId === productId) {
          if (finish(id, { decision: 'deny' })) count += 1;
        }
      }
      return count;
    },
    size: () => pending.size,
    // Ids of the open approvals, oldest first (tests, diagnostics).
    ids: () => [...pending.keys()]
  };
}
