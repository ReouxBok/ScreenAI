import { LIMOVA_APP_URL, LimovaClientError } from './client.js';

const unavailable = () => new LimovaClientError('LIMOVA_APP_SESSION_UNAVAILABLE', 'La connexion avec l’onglet Limova a été interrompue.');

async function waitForPreparation(preparation, signal) {
  if (!signal) return preparation;
  let abort;
  const interrupted = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([preparation, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}


function waitForApp(chrome, tabId, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve(tab);
    };
    const inspect = tab => {
      if (tab.status !== 'complete') return;
      try {
        if (new URL(tab.url).origin !== LIMOVA_APP_URL) return finish(unavailable());
      } catch { return finish(unavailable()); }
      finish(null, tab);
    };
    const updated = (id, _change, tab) => { if (id === tabId) inspect(tab); };
    const removed = id => { if (id === tabId) finish(unavailable()); };
    const abort = () => finish(signal.reason ?? unavailable());
    const timer = setTimeout(() => finish(unavailable()), 15_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    chrome.tabs.get(tabId).then(inspect, () => finish(unavailable()));
  });
}


export function createLimovaAppTarget(chrome, file) {
  let preparing;
  async function prepare(signal) {
    if (!preparing) preparing = (async () => {
      const tabs = await chrome.tabs.query({ url: `${LIMOVA_APP_URL}/*` });
      const tab = tabs.find(item => !item.discarded) ?? await chrome.tabs.create({ url: LIMOVA_APP_URL, active: false });
      await waitForApp(chrome, tab.id);
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
      if (!frame?.documentId || new URL(frame.url).origin !== LIMOVA_APP_URL) throw unavailable();
      const target = { tabId: tab.id, documentIds: [frame.documentId] };
      await chrome.scripting.executeScript({ target, world: 'ISOLATED', files: [file] });
      return { tabId: tab.id, documentId: frame.documentId };
    })().finally(() => { preparing = null; });
    return waitForPreparation(preparing, signal);
  }

  return prepare;
}

// A browser voice session must not live in the document its own tools navigate.
export async function createLimovaAppLease(chrome, file, signal) {
  let tabId, documentId, claimed = false, released = false;
  const activated = info => { if (info.tabId === tabId) claimed = true; };
  chrome.tabs.onActivated.addListener(activated);
  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (claimed || tabId === undefined) return;
      const tab = await chrome.tabs.get(tabId);
      if (claimed || tab.active) return;
      if (documentId) {
        if (tab.pendingUrl || new URL(tab.url).origin !== LIMOVA_APP_URL) return;
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
        if (frame?.documentId !== documentId) return;
      } else if (new URL(tab.pendingUrl || tab.url).href !== new URL(LIMOVA_APP_URL).href) return;
      if (!claimed) await chrome.tabs.remove(tabId);
    } catch { /* The owned tab may already have been closed. */ }
    finally { chrome.tabs.onActivated.removeListener(activated); }
  };
  try {
    signal?.throwIfAborted();
    const tab = await chrome.tabs.create({ url: LIMOVA_APP_URL, active: false });
    tabId = tab.id;
    signal?.throwIfAborted();
    await waitForApp(chrome, tabId, signal);
    signal?.throwIfAborted();
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame?.documentId || new URL(frame.url).origin !== LIMOVA_APP_URL) throw unavailable();
    documentId = frame.documentId;
    await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', files: [file] });
    signal?.throwIfAborted();
    return { tabId, documentId, release };
  } catch (error) { await release(); throw error; }
}
