import { LIMOVA_API_URL, LIMOVA_APP_URL, LimovaClientError } from './client.js';

const PORT = 'limova-app-session-v1';
const unavailable = () => new LimovaClientError('LIMOVA_APP_SESSION_UNAVAILABLE',
  'La connexion avec l’onglet Limova a été interrompue. Rouvre Limova, puis réessaie.');

export async function openLimovaApp(chrome) {
  const tabs = await chrome.tabs.query({ url: `${LIMOVA_APP_URL}/*` });
  const tab = tabs.find(item => !item.discarded) ?? tabs[0];
  if (!tab) return chrome.tabs.create({ url: LIMOVA_APP_URL });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

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

async function serializeBody(body) {
  if (body === undefined) return undefined;
  if (typeof body === 'string' && body.length <= 128_000) return { kind: 'json', value: body };
  if (!(body instanceof FormData)) throw unavailable();
  const entries = [...body.entries()];
  const file = entries[0]?.[1];
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(file instanceof Blob)
    || !['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) throw unavailable();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let index = 0; index < bytes.length; index += 16_384) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 16_384)));
  }
  return { kind: 'image', mime: file.type, base64: btoa(parts.join('')) };
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

export function createLimovaSessionFetch(chrome) {
  let preparing;
  async function prepare() {
    if (!preparing) preparing = (async () => {
      const tabs = await chrome.tabs.query({ url: `${LIMOVA_APP_URL}/*` });
      const tab = tabs.find(item => !item.discarded) ?? await chrome.tabs.create({ url: LIMOVA_APP_URL, active: false });
      await waitForApp(chrome, tab.id);
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
      if (!frame?.documentId || new URL(frame.url).origin !== LIMOVA_APP_URL) throw unavailable();
      const target = { tabId: tab.id, documentIds: [frame.documentId] };
      await chrome.scripting.executeScript({ target, world: 'ISOLATED', files: ['src/limova/app-session-bridge.js'] });
      return { tabId: tab.id, documentId: frame.documentId };
    })().finally(() => { preparing = null; });
    return preparing;
  }

  async function appFetch(url, options) {
    options.signal?.throwIfAborted();
    const [target, body] = await waitForPreparation(Promise.all([prepare(), serializeBody(options.body)]), options.signal);
    options.signal?.throwIfAborted();
    const port = chrome.tabs.connect(target.tabId, { documentId: target.documentId, name: PORT });
    return new Promise((resolve, reject) => {
      let controller;
      let headersReceived = false;
      let finished = false;
      let pendingAck;
      let nextSequence = 1;
      const acknowledge = () => {
        if (!pendingAck || finished) return;
        port.postMessage({ kind: 'ack', sequence: pendingAck });
        pendingAck = null;
      };
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort);
        port.disconnect();
      };
      const fail = error => {
        if (finished) return;
        finished = true;
        if (headersReceived) controller?.error(error); else reject(error);
        cleanup();
      };
      const abort = () => fail(options.signal.reason ?? unavailable());
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; fail(unavailable()); });
      port.onMessage.addListener(message => {
        if (finished) return;
        try {
          if (message?.kind === 'headers' && !headersReceived
            && Number.isInteger(message.status) && message.status >= 200 && message.status <= 599) {
            const body = new ReadableStream({
              start(value) { controller = value; },
              pull() { acknowledge(); },
              cancel() { if (!finished) { finished = true; cleanup(); } },
            });
            headersReceived = true;
            resolve(new Response([204, 205, 304].includes(message.status) ? null : body, {
              status: message.status, headers: { 'content-type': message.contentType },
            }));
          } else if (message?.kind === 'chunk' && headersReceived
            && message.sequence === nextSequence && Array.isArray(message.bytes) && message.bytes.length <= 16_384
            && message.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            nextSequence += 1;
            pendingAck = message.sequence;
            controller.enqueue(Uint8Array.from(message.bytes));
            if (controller.desiredSize > 0) acknowledge();
          } else if (message?.kind === 'end' && headersReceived) {
            finished = true;
            controller.close();
            cleanup();
          } else fail(unavailable());
        } catch { fail(unavailable()); }
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) return abort();
      try {
        port.postMessage({ kind: 'request', request: { url, method: options.method ?? 'GET',
          headers: Object.fromEntries(new Headers(options.headers)), ...(body ? { body } : {}) } });
      } catch { fail(unavailable()); }
    });
  }

  return async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(input);
    if (url.origin !== LIMOVA_API_URL || url.username || url.password || url.hash) throw unavailable();
    return appFetch(url.href, options);
  };
}
