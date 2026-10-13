import { createLiveBrowserController } from './live-browser-controller.js';

export function createBrowserLiveSession({ openTransport, client, journal, createDriver }) {
  return async ({ context, conversationId, languageCode, userTimezone, signal,
    onEvent = () => {}, onNativeEvent = () => {}, onError = () => {} }) => {
    context = Object.freeze({ ...context });
    const abort = new AbortController();
    let live, browser, closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', stop);
      abort.abort();
      browser?.stop();
      live?.stop();
    };
    const fail = error => { if (!closed) { stop(); onError(error); } };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      abort.signal.throwIfAborted();
      await client.getConversation(context, conversationId, abort.signal);
      abort.signal.throwIfAborted();
      const browserSession = await journal.getSession(context);
      abort.signal.throwIfAborted();
      const driver = createDriver({ scope: { ...context, sessionId: browserSession }, journal, signal: abort.signal,
        uploadScreenshot: (image, signal = abort.signal) => client.uploadBrowserScreenshot(context, conversationId, image, signal) });
      const browserContext = await driver.readPage(abort.signal);
      abort.signal.throwIfAborted();
      browser = createLiveBrowserController({ context, conversationId, browserSession,
        client, journal, driver, signal: abort.signal,
        continueBrowser: payload => live.continueBrowser(payload), onError: fail, notify: onNativeEvent });
      live = await openTransport({ context, conversationId, languageCode, userTimezone,
        browserSession, browserContext, signal: abort.signal, onError: fail,
        onEvent(event, payload) {
          browser.onEvent(event, payload);
          if (closed) return;
          try {
            const notification = onEvent(event, payload);
            if (typeof notification?.then === 'function') void Promise.resolve(notification).catch(fail);
          } catch (error) { fail(error); }
          if (event === 'session.ended') stop();
        },
      });
      if (closed) { live.stop(); abort.signal.throwIfAborted(); }
      return {
        session: live.session,
        sendAudio(bytes) { abort.signal.throwIfAborted(); live.sendAudio(bytes); },
        cancel(playedAudioMs = 0) {
          abort.signal.throwIfAborted();
          browser.onEvent('turn.interrupted', { sessionId: live.session.sessionId });
          live.cancel(playedAudioMs);
        },
        stop,
      };
    } catch (error) {
      stop();
      throw error;
    }
  };
}
