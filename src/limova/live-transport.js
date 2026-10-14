import { evaluationGrant } from './evaluation-grant.js';
import { liveBrowserBinding, liveBrowserContinuation, liveBrowserContextReply } from './live-browser-contract.js';
import { createLimovaAppTarget } from './app-target.js';
import { LIVE_PORT } from './live-bridge.js';

const unavailable = () => new Error('La connexion vocale Limova a été interrompue.');

export function createLimovaLiveTransport(chrome) {
  const prepare = createLimovaAppTarget(chrome, 'src/limova/app-live-bridge.js');
  return async ({ context, conversationId, languageCode, userTimezone, browserSession, browserContext, evaluationCode, signal, onEvent, onError }) => {
    const grant = evaluationGrant(evaluationCode);
    const browserBinding = liveBrowserBinding(browserSession, browserContext);
    signal?.throwIfAborted();
    const target = await prepare(signal);
    signal?.throwIfAborted();
    const port = chrome.tabs.connect(target.tabId, { documentId: target.documentId, name: LIVE_PORT });
    return new Promise((resolve, reject) => {
      let ready = false;
      let closed = false;
      let consuming = false;
      let sequence = 1;
      let audioSequence = 0;
      const close = error => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', abort);
        port.disconnect();
        if (!ready) reject(error ?? unavailable());
        else if (error) onError?.(error);
      };
      const abort = () => close(signal.reason ?? unavailable());
      const send = message => {
        if (closed) throw unavailable();
        try { port.postMessage(message); } catch { close(unavailable()); throw unavailable(); }
      };
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; close(unavailable()); });
      port.onMessage.addListener(message => {
        if (closed) return;
        if (consuming || message?.kind !== 'event' || message.sequence !== sequence) { close(unavailable()); return; }
        consuming = true;
        sequence += 1;
        void (async () => {
          try {
            if (message.event === 'error') throw unavailable();
            if (!ready && message.event !== 'session.ready') throw unavailable();
            if (message.event === 'session.ready') {
              if (ready) throw unavailable();
              ready = true;
              resolve({
                session: message.payload,
                sendAudio(bytes) {
                  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2
                    || bytes.length > message.payload.maxAudioFrameBytes) throw new TypeError('Invalid PCM frame');
                  send({ kind: 'audio', sequence: audioSequence++, bytes: Array.from(bytes) });
                },
                refreshBrowserContext(payload) { send({ kind: 'browser_context', payload: liveBrowserContextReply(payload) }); },
                continueBrowser(continuation) { send({ kind: 'browser_continue', payload: liveBrowserContinuation(continuation) }); },
                cancel(playedAudioMs = 0) { send({ kind: 'cancel', playedAudioMs }); },
                stop() { close(); },
              });
            }
            await onEvent(message.event, message.payload);
            if (closed) return;
            consuming = false;
            send({ kind: 'ack', sequence: message.sequence });
            if (message.event === 'session.ended') close();
          } catch { close(unavailable()); }
        })();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        send({ kind: 'start', userId: context.userId, workspaceId: context.workspaceId,
          conversationId, languageCode, userTimezone, ...browserBinding,
          ...(grant !== undefined ? { evaluationCode: grant } : {}) });
      } catch { close(unavailable()); }
    });
  };
}
