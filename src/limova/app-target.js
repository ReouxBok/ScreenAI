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


function waitForApp(chrome, tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const timer = setTimeout(() => finish(unavailable()), 15_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
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
