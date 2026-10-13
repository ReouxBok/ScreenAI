import { describe, expect, it, vi } from 'vitest';
import { LimovaDeepAgentClient, LIMOVA_API_URL } from '../../../src/limova/client.js';

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CONTEXT = { userId: USER, workspaceId: WORKSPACE };
const json = data => Response.json({ data });

function harness({ enabled = true, userId = USER } = {}) {
  const fetch = vi.fn(async (url, options) => {
    expect(url.startsWith(LIMOVA_API_URL)).toBe(true);
    expect(options.credentials).toBe('include');
    expect(options.headers?.Authorization).toBeUndefined();
    if (url.endsWith('/users/me')) return json({ id: userId });
    if (url.endsWith('/workspaces')) return json([{ id: WORKSPACE, name: 'Workspace', is_charly_extension_enabled: enabled }]);
    if (url.endsWith('/agent/by-slug/charly')) return json({ id: AGENT, slug: 'charly' });
    if (url.endsWith(`/conversation/${CONVERSATION}`)) return json({ id: CONVERSATION, engine: 'deep_agents', mainAgent: { id: AGENT, slug: 'charly' } });
    if (url.endsWith('/conversation')) return json({ id: CONVERSATION });
    if (url.endsWith(`/message/${CONVERSATION}`)) return new Response('event: values\ndata: {"messages":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    throw new Error('Unexpected route');
  });
  return { client: new LimovaDeepAgentClient(fetch), fetch };
}

describe('Limova Deep Agent client', () => {
  it('uses the existing before query for an older history page', async () => {
    const { client, fetch } = harness();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => url.includes('/messages?')
      ? json({ data: [], pagination: { hasMore: false } }) : original(url, options));
    await client.getMessages(CONTEXT, CONVERSATION, USER);
    expect(fetch.mock.calls.at(-1)[0]).toBe(`${LIMOVA_API_URL}/conversation/${CONVERSATION}/messages?before=${USER}`);
  });
  it('resolves the existing main agent and creates a Deep Agent conversation', async () => {
    const { client, fetch } = harness();
    expect(await client.createConversation(CONTEXT)).toEqual({ id: CONVERSATION });
    const request = fetch.mock.calls.find(([url]) => url.endsWith('/conversation'));
    expect(JSON.parse(request[1].body)).toEqual({ title: 'Discussion avec Charly', type: 'general', engine: 'deep_agents', botAgentId: AGENT, disableFirstMessage: true });
    expect(request[1].headers['x-workspace-id']).toBe(WORKSPACE);
  });

  it('blocks a disabled workspace before creating or sending anything', async () => {
    const { client, fetch } = harness({ enabled: false });
    await expect(client.createConversation(CONTEXT)).rejects.toMatchObject({ code: 'LIMOVA_EXTENSION_DISABLED' });
    expect(fetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  });

  it('treats a missing server flag as disabled', async () => {
    // Use a backend response from before the flag contract was added.
    const legacy = new LimovaDeepAgentClient(vi.fn(async url => url.endsWith('/users/me')
      ? json({ id: USER }) : json([{ id: WORKSPACE }])));
    await expect(legacy.createConversation(CONTEXT)).rejects.toMatchObject({ code: 'LIMOVA_EXTENSION_DISABLED' });
  });

  it('invalidates an old context when the Limova account changes', async () => {
    const { client } = harness({ userId: AGENT });
    await expect(client.createConversation(CONTEXT)).rejects.toMatchObject({ code: 'LIMOVA_ACCOUNT_CHANGED' });
  });

  it('sends the extension marker and consumes native SSE without a second agent', async () => {
    const { client, fetch } = harness();
    const events = [];
    for await (const event of client.sendMessage(CONTEXT, CONVERSATION, 'Bonjour')) events.push(event);
    expect(events).toEqual([{ event: 'values', id: undefined, data: { messages: [] } }]);
    const request = fetch.mock.calls.find(([url]) => url.endsWith(`/message/${CONVERSATION}`));
    expect(JSON.parse(request[1].body)).toMatchObject({ content: 'Bonjour', clientSurface: 'chrome_extension' });
    expect(JSON.parse(request[1].body)).not.toHaveProperty('agentId');
  });

  it('coalesces concurrent cookie refreshes and retries each request only once', async () => {
    let refreshed = false;
    const fetch = vi.fn(async url => {
      if (url.endsWith('/auth/refresh-token')) { refreshed = true; return new Response(null, { status: 200 }); }
      if (url.endsWith('/users/me')) return refreshed ? json({ id: USER }) : new Response(null, { status: 401 });
      return json([{ id: WORKSPACE }]);
    });
    const client = new LimovaDeepAgentClient(fetch);
    await Promise.all([client.bootstrap(), client.bootstrap()]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/auth/refresh-token'))).toHaveLength(1);
    expect(fetch.mock.calls.every(([, options]) => options.credentials === 'include')).toBe(true);
  });

  it('does not loop when cookies remain unavailable', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(new LimovaDeepAgentClient(fetch).bootstrap()).rejects.toMatchObject({ code: 'LIMOVA_LOGIN_REQUIRED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not replay a message after a network failure', async () => {
    const { client, fetch } = harness();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => url.endsWith(`/message/${CONVERSATION}`)
      ? Promise.reject(new Error('network failure')) : original(url, options));
    const turn = client.sendMessage(CONTEXT, CONVERSATION, 'Bonjour');
    await expect(turn.next()).rejects.toThrow('network failure');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith(`/message/${CONVERSATION}`))).toHaveLength(1);
  });
});

const BROWSER_SESSION = '77777777-7777-4777-8777-777777777777';
const BROWSER = { sessionId: BROWSER_SESSION, page: { tabId: 17, origin: 'https://example.com', contextVersion: 4 } };
const RESULT = { turnId: USER, actionId: `${USER}:tool-1`, toolCallId: 'tool-1', contextVersion: 3, status: 'completed', observation: 'Page observed' };
async function consume(events) {
  const collected = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('Limova browser turn transport', () => {
  it('binds the initial message through a header and validated page context', async () => {
    const { client, fetch } = harness();
    await consume(client.sendMessage(CONTEXT, CONVERSATION, 'Observe', undefined, BROWSER));
    const [, options] = fetch.mock.calls.at(-1);
    expect(options.headers['x-extension-session']).toBe(BROWSER_SESSION);
    expect(JSON.parse(options.body)).toMatchObject({ content: 'Observe', browserContext: BROWSER.page, clientSurface: 'chrome_extension' });
    expect(options.body).not.toContain(BROWSER_SESSION);
    expect(fetch.mock.calls.slice(0, -1).every(([, call]) => !call.headers['x-extension-session'])).toBe(true);
  });

  it('submits a result without appending human text, timezone or attachments', async () => {
    const { client, fetch } = harness();
    await consume(client.sendBrowserResult(CONTEXT, CONVERSATION, BROWSER, { ...RESULT, ignored: 'not sent' }));
    const [url, options] = fetch.mock.calls.at(-1);
    expect(url).toBe(`${LIMOVA_API_URL}/message/${CONVERSATION}`);
    expect(options.headers['x-extension-session']).toBe(BROWSER_SESSION);
    expect(JSON.parse(options.body)).toEqual({ kind: 'browser_tool_result', browserContext: BROWSER.page, browserResult: RESULT, clientSurface: 'chrome_extension' });
  });

  it('recovers a turn on the existing GET route and resumes without a result', async () => {
    const { client, fetch } = harness();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => url.endsWith(`/conversation/${CONVERSATION}`)
      ? json({ engine: 'deep_agents', mainAgent: { slug: 'charly' }, browserTurn: { turnId: USER, status: 'open' } }) : original(url, options));
    expect(await client.getBrowserTurn(CONTEXT, CONVERSATION, BROWSER_SESSION)).toEqual({ turnId: USER, status: 'open' });
    expect(fetch.mock.calls.at(-1)[1].headers['x-extension-session']).toBe(BROWSER_SESSION);
    await consume(client.resumeBrowserTurn(CONTEXT, CONVERSATION, BROWSER, USER));
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body)).toEqual({ kind: 'browser_resume', browserTurnId: USER, browserContext: BROWSER.page, clientSurface: 'chrome_extension' });
  });

  it('returns no browser turn when the server has none for this session', async () => {
    const { client } = harness();
    expect(await client.getBrowserTurn(CONTEXT, CONVERSATION, BROWSER_SESSION)).toBeNull();
  });

  it.each([
    { ...BROWSER, sessionId: 'invalid' },
    { ...BROWSER, page: { ...BROWSER.page, tabId: '17' } },
    { ...BROWSER, page: { ...BROWSER.page, origin: 'http://example.com' } },
    { ...BROWSER, page: { ...BROWSER.page, origin: 'https://example.com/path' } },
    { ...BROWSER, page: { ...BROWSER.page, contextVersion: -1 } },
  ])('rejects malformed browser contexts before network activity %#', async browser => {
    const { client, fetch } = harness();
    await expect(consume(client.resumeBrowserTurn(CONTEXT, CONVERSATION, browser, USER))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...RESULT, status: 'unknown' },
    { ...RESULT, observation: 'x'.repeat(32001) },
    { ...RESULT, contextVersion: '3' },
    { ...RESULT, turnId: 'invalid' },
  ])('rejects malformed results before network activity %#', async result => {
    const { client, fetch } = harness();
    await expect(consume(client.sendBrowserResult(CONTEXT, CONVERSATION, BROWSER, result))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks account ownership before submitting browser observations', async () => {
    const { client, fetch } = harness({ userId: AGENT });
    await expect(consume(client.sendBrowserResult(CONTEXT, CONVERSATION, BROWSER, RESULT))).rejects.toMatchObject({ code: 'LIMOVA_ACCOUNT_CHANGED' });
    expect(fetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  });

  it('does not automatically replay a result after an ambiguous network failure', async () => {
    const { client, fetch } = harness();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => url.endsWith(`/message/${CONVERSATION}`)
      ? Promise.reject(new Error('Connection lost')) : original(url, options));
    await expect(consume(client.sendBrowserResult(CONTEXT, CONVERSATION, BROWSER, RESULT))).rejects.toThrow('Connection lost');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith(`/message/${CONVERSATION}`))).toHaveLength(1);
  });
});
