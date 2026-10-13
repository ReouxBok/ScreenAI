(() => {
  const APP = 'https://new.limova.ai';
  const API = 'https://api.new.limova.ai';
  const PORT = 'limova-app-session-v1';
  if (location.origin !== APP || globalThis.__limovaAppSessionBridgeV1) return;
  globalThis.__limovaAppSessionBridgeV1 = true;
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const uuid = new RegExp(`^${UUID}$`, 'i');
  const read = new RegExp(`^/conversation/${UUID}(?:/messages)?$`, 'i');
  const write = new RegExp(`^/message/${UUID}(?:/cancel)?$`, 'i');

  function decode(request) {
    if (!request || !['GET', 'POST'].includes(request.method)) throw new Error();
    const url = new URL(request.url);
    if (url.origin !== API || url.username || url.password || url.hash) throw new Error();
    const allowed = request.method === 'GET'
      ? ['/users/me', '/workspaces', '/agent/by-slug/charly', '/conversation'].includes(url.pathname) || read.test(url.pathname)
      : ['/auth/refresh-token', '/auth/logout', '/conversation', '/files'].includes(url.pathname) || write.test(url.pathname);
    if (!allowed) throw new Error();
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      const name = key.toLowerCase();
      if (name === 'accept' && ['application/json', 'text/event-stream'].includes(value)
        || name === 'content-type' && value === 'application/json'
        || ['x-workspace-id', 'x-extension-session'].includes(name) && typeof value === 'string' && uuid.test(value)) {
        headers.set(name, value);
      } else throw new Error();
    }
    let body;
    if (request.body !== undefined) {
      if (request.method !== 'POST') throw new Error();
      if (request.body.kind === 'json' && typeof request.body.value === 'string'
        && request.body.value.length <= 128_000 && headers.get('content-type') === 'application/json') {
        JSON.parse(request.body.value);
        body = request.body.value;
      } else if (request.body.kind === 'image' && url.pathname === '/files'
        && url.search === '?isTemporary=true&useAsDefaultContext=false'
        && !headers.has('content-type') && ['image/png', 'image/jpeg'].includes(request.body.mime)
        && typeof request.body.base64 === 'string' && request.body.base64.length <= 7_000_000) {
        const bytes = Uint8Array.from(atob(request.body.base64), character => character.charCodeAt(0));
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error();
        body = new FormData();
        body.append('file', new Blob([bytes], { type: request.body.mime }),
          request.body.mime === 'image/png' ? 'browser-screenshot.png' : 'browser-screenshot.jpg');
      } else throw new Error();
    }
    return { url: url.href, method: request.method, headers, body };
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PORT || port.sender?.id !== chrome.runtime.id) return;
    const controller = new AbortController();
    let started = false;
    let acknowledgement;
    let sequence = 0;
    const stop = () => {
      controller.abort();
      acknowledgement?.reject(new Error());
      acknowledgement = null;
    };
    port.onDisconnect.addListener(stop);
    const sendChunk = bytes => new Promise((resolve, reject) => {
      acknowledgement = { sequence: ++sequence, resolve, reject };
      port.postMessage({ kind: 'chunk', sequence, bytes: Array.from(bytes) });
    });
    async function run(message) {
      try {
        const request = decode(message.request);
        const response = await fetch(request.url, {
          method: request.method, headers: request.headers, body: request.body,
          credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        port.postMessage({ kind: 'headers', status: response.status,
          contentType: response.headers.get('content-type') ?? '' });
        if (new URL(request.url).pathname === '/auth/refresh-token' || !response.ok) {
          await response.body?.cancel();
          port.postMessage({ kind: 'end' });
          return;
        }
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              for (let offset = 0; offset < value.length; offset += 16_384) {
                await sendChunk(value.subarray(offset, offset + 16_384));
              }
            }
          } finally { reader.releaseLock(); }
        }
        port.postMessage({ kind: 'end' });
      } catch {
        try { port.postMessage({ kind: 'error' }); } catch { /* The requesting document closed. */ }
        stop();
      }
    }
    port.onMessage.addListener(message => {
      if (message?.kind === 'abort') return stop();
      if (message?.kind === 'ack' && message.sequence === acknowledgement?.sequence) {
        const pending = acknowledgement;
        acknowledgement = null;
        pending.resolve();
      } else if (message?.kind === 'request' && !started) {
        started = true;
        void run(message);
      }
    });
  });
})();
