import { createLiveBrowserController } from './live-browser-controller.js';

export function createBrowserLiveSession({ openTransport, client, journal, createDriver }) {
  return async ({ context, conversationId, languageCode, userTimezone, signal, browserEnabled = true,
    onEvent = () => {}, onNativeEvent = () => {}, onError = () => {} }) => {
    context = Object.freeze({ ...context });
    const abort = new AbortController();
    let live, browser, closed = false, refresh;
    const stop = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', stop);
      abort.abort();
      refresh?.abort();
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
      const browserSession = browserEnabled ? await journal.getSession(context) : undefined;
      abort.signal.throwIfAborted();
      const driver = browserEnabled ? createDriver({ scope: { ...context, sessionId: browserSession }, journal, signal: abort.signal,
        uploadScreenshot: (image, signal = abort.signal) => client.uploadBrowserScreenshot(context, conversationId, image, signal) }) : undefined;
      const browserContext = await driver?.readPage(abort.signal);
      abort.signal.throwIfAborted();
      browser = createLiveBrowserController({ context, conversationId, browserSession,
        client, journal, driver, signal: abort.signal,
        continueBrowser: payload => live.continueBrowser(payload), onError: fail, notify: onNativeEvent });
      live = await openTransport({ context, conversationId, languageCode, userTimezone,
        browserSession, browserContext, signal: abort.signal, onError: fail,
        onEvent(event, payload) {
          if (event === 'turn.browser_context_requested') {
            if (!driver || refresh) { fail(new Error('Unexpected browser context request')); return; }
            const current = new AbortController(); refresh = current;
            const refreshSignal = AbortSignal.any([abort.signal, current.signal]);
            void (async () => {
              await client.getConversation(context, conversationId, refreshSignal);
              const page = await driver.readPage(refreshSignal);
              refreshSignal.throwIfAborted();
              live.refreshBrowserContext({ turnId: payload.turnId, requestId: payload.requestId, browserContext: page });
            })().catch(error => { if (!current.signal.aborted) fail(error); })
              .finally(() => { if (refresh === current) refresh = undefined; });
            return;
          }
          if (['turn.interrupted', 'turn.deep_agent_stream.failed', 'turn.deep_agent_stream.interrupted'].includes(event)) {
            refresh?.abort(); refresh = undefined;
          }
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
          refresh?.abort(); refresh = undefined;
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
