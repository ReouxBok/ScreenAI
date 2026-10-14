import { createLimovaAppLease } from './app-target.js';
import { TRANSCRIPTION_PORT } from './transcription-bridge.js';

const unavailable = () => new Error('La transcription Limova a été interrompue.');

export function createTranscriptionTransport(chrome) {
  return async ({ context, languageCode, signal, onEvent = () => {}, onError = () => {} }) => {
    signal?.throwIfAborted();
    const target = await createLimovaAppLease(chrome, 'src/limova/app-transcription-bridge.js', signal);
    let port;
    try {
      signal?.throwIfAborted();
      port = chrome.tabs.connect(target.tabId, { documentId: target.documentId, name: TRANSCRIPTION_PORT });
    } catch (error) { await target.release(); throw error; }
    return new Promise((resolve, reject) => {
      let ready = false, closed = false, consuming = false, sequence = 1, audioSequence = 0;
      const stop = error => {
        if (closed) return;
        closed = true; signal?.removeEventListener('abort', abort); port.disconnect();
        void target.release();
        if (!ready) reject(error ?? unavailable()); else if (error) onError(error);
      };
      const abort = () => stop(signal.reason ?? unavailable());
      const send = message => {
        if (closed) throw unavailable();
        try { port.postMessage(message); } catch { stop(unavailable()); throw unavailable(); }
      };
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; stop(unavailable()); });
      port.onMessage.addListener(message => {
        if (closed) return;
        if (consuming || message?.kind !== 'event' || message.sequence !== sequence++) { stop(unavailable()); return; }
        consuming = true;
        void (async () => {
          try {
            if (!ready && message.event !== 'session_started') throw unavailable();
            if (message.event === 'session_started') {
              if (ready) throw unavailable(); ready = true;
              resolve({ session: message.payload, stop: () => stop(), sendAudio(bytes) {
                if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > message.payload.maxAudioFrameBytes) throw new TypeError('Invalid PCM frame');
                send({ kind: 'audio', sequence: audioSequence++, bytes: Array.from(bytes) });
              } });
            }
            await onEvent(message.event, message.payload);
            if (closed) return;
            consuming = false; send({ kind: 'ack', sequence: message.sequence });
            if (message.event === 'session_ended') stop();
          } catch { stop(unavailable()); }
        })();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      send({ kind: 'start', userId: context.userId, workspaceId: context.workspaceId, languageCode });
    });
  };
}
