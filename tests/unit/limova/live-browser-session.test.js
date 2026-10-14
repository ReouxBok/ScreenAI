import { describe, expect, it, vi } from 'vitest';
import { createBrowserLiveSession } from '../../../src/limova/live-browser-session.js';

const id = '11111111-1111-4111-8111-111111111111';
const context = { userId: id, workspaceId: id };
const page = { tabId: 7, origin: 'https://example.com', contextVersion: 1 };

function harness() {
  let callbacks, driverOptions;
  const live = { session: { sessionId: id }, sendAudio: vi.fn(), cancel: vi.fn(), stop: vi.fn(), continueBrowser: vi.fn(), refreshBrowserContext: vi.fn() };
  const openTransport = vi.fn(async options => { callbacks = options; options.onEvent('session.ready', live.session); return live; });
  const client = { getConversation: vi.fn().mockResolvedValue({}), uploadBrowserScreenshot: vi.fn().mockResolvedValue({ fileId: id }) };
  const journal = { getSession: vi.fn().mockResolvedValue(id) };
  const driver = { readPage: vi.fn().mockResolvedValue(page) };
  const createDriver = vi.fn(options => { driverOptions = options; return driver; });
  return { live, client, journal, driver, createDriver, openTransport,
    callbacks: () => callbacks, driverOptions: () => driverOptions,
    start: createBrowserLiveSession({ openTransport, client, journal, createDriver }) };
}

describe('browser-enabled live session composition', () => {
  it('reads a fresh authorized page for the requested turn without blocking event ingestion', async () => {
    const h = harness();
    const session = await h.start({ context, conversationId: id });
    const fresh = { ...page, contextVersion: 8 };
    h.driver.readPage.mockResolvedValue(fresh);
    const request = { sessionId: id, turnId: id, requestId: id };
    expect(h.callbacks().onEvent('turn.browser_context_requested', request)).toBeUndefined();
    await vi.waitFor(() => expect(h.live.refreshBrowserContext).toHaveBeenCalledWith({ turnId: id, requestId: id, browserContext: fresh }));
    expect(h.client.getConversation).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it('discards a context read that finishes after cancellation', async () => {
    const h = harness();
    const session = await h.start({ context, conversationId: id });
    let finish;
    h.driver.readPage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    h.callbacks().onEvent('turn.browser_context_requested', { sessionId: id, turnId: id, requestId: id });
    await vi.waitFor(() => expect(h.driver.readPage).toHaveBeenCalledTimes(2));
    session.cancel(); finish(page);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.live.refreshBrowserContext).not.toHaveBeenCalled();
    session.stop();
  });

  it('opens voice without inspecting any page when browser consent is absent', async () => {
    const h = harness();
    const session = await h.start({ context, conversationId: id, browserEnabled: false });
    expect(h.client.getConversation).toHaveBeenCalledOnce();
    expect(h.journal.getSession).not.toHaveBeenCalled();
    expect(h.createDriver).not.toHaveBeenCalled();
    expect(h.openTransport).toHaveBeenCalledWith(expect.objectContaining({ browserSession: undefined, browserContext: undefined }));
    session.sendAudio(new Uint8Array([0, 0]));
    expect(h.live.sendAudio).toHaveBeenCalledOnce();
    session.stop();
  });

  it('opens an authorized page binding and scopes screenshot uploads to the conversation', async () => {
    const h = harness();
    const session = await h.start({ context, conversationId: id });
    expect(h.openTransport).toHaveBeenCalledWith(expect.objectContaining({ browserSession: id, browserContext: page, context, conversationId: id }));
    expect(h.driverOptions().scope).toEqual({ ...context, sessionId: id });
    const image = new Blob(['image'], { type: 'image/png' });
    const abort = new AbortController();
    await h.driverOptions().uploadScreenshot(image, abort.signal);
    expect(h.client.uploadBrowserScreenshot).toHaveBeenCalledWith(context, id, image, abort.signal);
    session.sendAudio(new Uint8Array([0, 0]));
    session.cancel(50);
    expect(h.live.cancel).toHaveBeenCalledWith(50);
    session.stop(); session.stop();
    expect(h.live.stop).toHaveBeenCalledTimes(1);
    expect(h.callbacks().signal.aborted).toBe(true);
    expect(() => session.sendAudio(new Uint8Array([0, 0]))).toThrow();
  });

  it('does not open audio when page authorization fails', async () => {
    const h = harness();
    h.driver.readPage.mockRejectedValue(new Error('No consent'));
    await expect(h.start({ context, conversationId: id })).rejects.toThrow('No consent');
    expect(h.openTransport).not.toHaveBeenCalled();
    expect(h.driverOptions().signal.aborted).toBe(true);
  });

  it('closes transport and notifies only once on invalid native events', async () => {
    const h = harness(), onError = vi.fn();
    await h.start({ context, conversationId: id, onError });
    h.callbacks().onEvent('turn.deep_agent_stream.started', { sessionId: id, turnId: 'invalid' });
    h.callbacks().onError(new Error('disconnect'));
    expect(h.live.stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending startup when its parent scope is revoked', async () => {
    const h = harness(), abort = new AbortController();
    let finish;
    h.client.getConversation.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const starting = h.start({ context, conversationId: id, signal: abort.signal });
    abort.abort(); finish({});
    await expect(starting).rejects.toThrow();
    expect(h.openTransport).not.toHaveBeenCalled();
    expect(h.createDriver).not.toHaveBeenCalled();
  });
});


it('passes the evaluation grant to the voice transport without exposing it to the browser driver', async () => {
  const h = harness();
  const code = 'private-staff-evaluation-code';
  const session = await h.start({ context, conversationId: id, evaluationCode: code });
  expect(h.openTransport).toHaveBeenCalledWith(expect.objectContaining({ evaluationCode: code }));
  expect(JSON.stringify(h.driverOptions())).not.toContain(code);
  expect(JSON.stringify(h.client.getConversation.mock.calls)).not.toContain(code);
  session.stop();
});
