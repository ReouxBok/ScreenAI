import { describe, expect, it, vi } from 'vitest';
import { createLimovaBackground } from '../../../src/limova/background.js';

const KEY = 'limova_deep_agent_context_v1';
function harness(options = {}) {
  const state = {};
  const storage = {
    get: vi.fn(async key => ({ [key]: state[key] })),
    set: vi.fn(async values => Object.assign(state, values)),
    remove: vi.fn(async key => { delete state[key]; }),
  };
  const client = {
    bootstrap: vi.fn().mockResolvedValue({ user: { id: 'user-1' }, workspaces: [{ id: 'workspace-1', enabled: true }] }),
    createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
    getConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
    getMessages: vi.fn().mockResolvedValue({ data: [], pagination: {} }),
    cancel: vi.fn().mockResolvedValue({ cancelled: true }),
    logout: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn(async function* () { yield { event: 'values', data: { messages: [] } }; }),
  };
  const journal = {
    getSession: vi.fn().mockResolvedValue('browser-session'),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    clearAccount: vi.fn().mockResolvedValue(undefined),
  };
  const notify = vi.fn();
  return { state, storage, client, journal, notify, background: createLimovaBackground({ storage, client, journal, notify, openTab: vi.fn(), ...options }) };
}
async function open(background) {
  await background.handle({ type: 'LIMOVA_SELECT_WORKSPACE', workspaceId: 'workspace-1' });
  await background.handle({ type: 'LIMOVA_CREATE_CONVERSATION' });
}

describe('Limova background session isolation', () => {
  it('persists only the account/workspace/conversation identifiers and emits native events', async () => {
    const { background, state, notify } = harness();
    await open(background);
    await background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Bonjour' });
    expect(state[KEY]).toEqual({ userId: 'user-1', workspaceId: 'workspace-1', conversationId: 'conversation-1' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIMOVA_STREAM_EVENT', conversationId: 'conversation-1', event: { event: 'values', data: { messages: [] } } }));
  });

  it('clears the old selection when the account changes', async () => {
    const { background, state, client } = harness();
    await open(background);
    client.bootstrap.mockResolvedValue({ user: { id: 'user-2' }, workspaces: [{ id: 'workspace-1', enabled: true }] });
    const current = await background.handle({ type: 'LIMOVA_GET_STATE' });
    expect(current.context).toBeNull();
    expect(current.conversationId).toBeNull();
    expect(state[KEY]).toBeUndefined();
    await expect(background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Bonjour' })).rejects.toThrow('Ouvre une conversation');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('does not retain a conversation after losing workspace access', async () => {
    const { background, client, state } = harness();
    await open(background);
    client.bootstrap.mockResolvedValue({ user: { id: 'user-1' }, workspaces: [] });
    await background.handle({ type: 'LIMOVA_GET_STATE' });
    expect(state[KEY]).toBeUndefined();
  });

  it('serializes context changes while conversation creation is in flight', async () => {
    const { background, client, state } = harness();
    await background.handle({ type: 'LIMOVA_SELECT_WORKSPACE', workspaceId: 'workspace-1' });
    let finish;
    client.createConversation.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const creation = background.handle({ type: 'LIMOVA_CREATE_CONVERSATION' });
    const selection = background.handle({ type: 'LIMOVA_SELECT_WORKSPACE', workspaceId: 'workspace-1' });
    finish({ id: 'conversation-1' });
    await Promise.all([creation, selection]);
    expect(state[KEY].conversationId).toBeNull();
  });

  it('does not convert a temporary outage into logout', async () => {
    const { background, client, state } = harness();
    await open(background);
    client.bootstrap.mockRejectedValue(new Error('Network unavailable'));
    await expect(background.handle({ type: 'LIMOVA_GET_STATE' })).rejects.toThrow('Network unavailable');
    expect(state[KEY].userId).toBe('user-1');
  });

  it('clears the context and notifies the panel if the account changes just before sending', async () => {
    const { background, client, state, notify } = harness();
    await open(background);
    client.sendMessage.mockImplementation(async function* () {
      throw Object.assign(new Error('Account changed'), { code: 'LIMOVA_ACCOUNT_CHANGED' });
    });
    await expect(background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Bonjour' })).rejects.toThrow('Account changed');
    expect(state[KEY]).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({ type: 'LIMOVA_SESSION_CHANGED' });
  });
});

describe('privileged browser session lifecycle', () => {
  it('creates a private session without exposing its nonce in the panel state', async () => {
    const { background, journal } = harness();
    await open(background);
    const state = await background.handle({ type: 'LIMOVA_GET_STATE' });
    expect(journal.getSession).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'workspace-1' });
    expect(JSON.stringify(state)).not.toContain('browser-session');
  });

  it('can cancel a paused backend turn even with no active local stream', async () => {
    const { background, client } = harness();
    await open(background);
    await background.handle({ type: 'LIMOVA_CANCEL' });
    expect(client.cancel).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'workspace-1' }, 'conversation-1');
  });

  it('revokes the previous workspace binding when selecting an enabled workspace', async () => {
    const { background, journal } = harness();
    await open(background);
    await background.handle({ type: 'LIMOVA_SELECT_WORKSPACE', workspaceId: 'workspace-1' });
    expect(journal.revokeSession).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'workspace-1' });
  });

  it('clears local session and receipts even when remote cancellation prevents logout', async () => {
    const { background, client, journal, state } = harness();
    await open(background);
    client.cancel.mockRejectedValueOnce(new Error('Network down'));
    await expect(background.handle({ type: 'LIMOVA_LOGOUT' })).rejects.toThrow('Network down');
    expect(journal.clearAccount).toHaveBeenCalledWith('user-1');
    expect(state[KEY]).toBeUndefined();
  });

  it('revokes the former account when a different Limova account is detected', async () => {
    const { background, client, journal } = harness();
    await open(background);
    client.bootstrap.mockResolvedValueOnce({ user: { id: 'user-2' }, workspaces: [{ id: 'workspace-1', enabled: true }] });
    await background.handle({ type: 'LIMOVA_GET_STATE' });
    expect(journal.clearAccount).toHaveBeenCalledWith('user-1');
  });
});


it('routes an explicitly browser-enabled message through the durable turn runner', async () => {
  const driver = { readPage: vi.fn().mockResolvedValue({ tabId: 1, origin: 'https://example.com', contextVersion: 1 }),
    authorize: vi.fn(), execute: vi.fn() };
  const createDriver = vi.fn(() => driver);
  const h = harness({ createDriver });
  h.client.sendMessage.mockImplementation(async function* () {
    yield { event: 'custom', data: { type: 'extension.turn_state', turnId: 'backend-turn', state: 'completed' } };
  });
  await open(h.background);
  const result = await h.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Lis cette page', browser: true });
  expect(result.browserState).toBe('completed');
  expect(createDriver.mock.calls[0][0].scope.sessionId).toBe('browser-session');
  expect(h.client.sendMessage.mock.calls[0][4]).toEqual({ sessionId: 'browser-session', page: { tabId: 1, origin: 'https://example.com', contextVersion: 1 } });
  expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIMOVA_BROWSER_STATE', state: 'completed', browserTurnId: 'backend-turn', turnId: result.turnId }));
});

it('does not silently send a browser request as a text-only request without a driver', async () => {
  const h = harness();
  await open(h.background);
  await expect(h.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Lis cette page', browser: true })).rejects.toThrow('pilote navigateur');
  expect(h.client.sendMessage).not.toHaveBeenCalled();
});

it('resumes a browser turn without sending a new human message', async () => {
  const driver = { readPage: vi.fn().mockResolvedValue({ tabId: 1, origin: 'https://example.com', contextVersion: 2 }), authorize: vi.fn(), execute: vi.fn() };
  const h = harness({ createDriver: () => driver });
  h.client.getBrowserTurn = vi.fn().mockResolvedValue({ turnId: 'backend-turn', status: 'open' });
  h.client.resumeBrowserTurn = vi.fn(async function* () {
    yield { event: 'custom', data: { type: 'extension.turn_state', turnId: 'backend-turn', state: 'completed' } };
  });
  await open(h.background);
  const result = await h.background.handle({ type: 'LIMOVA_RESUME_BROWSER', browser: true });
  expect(result.browserState).toBe('completed');
  expect(h.client.sendMessage).not.toHaveBeenCalled();
  expect(h.client.resumeBrowserTurn).toHaveBeenCalledTimes(1);
});

it('requires fresh browser authorization before resume', async () => {
  const h = harness();
  await open(h.background);
  await expect(h.background.handle({ type: 'LIMOVA_RESUME_BROWSER' })).rejects.toThrow('Autorise le navigateur');
  expect(h.client.sendMessage).not.toHaveBeenCalled();
});


it('binds screenshot uploads to the active account and conversation', async () => {
  const image = new Blob(['masked'], { type: 'image/png' });
  const target = { tabId: 1, origin: 'https://example.com', contextVersion: 1 };
  const h = harness({ createDriver: ({ uploadScreenshot }) => ({
    readPage: async signal => { await uploadScreenshot(image, signal); return target; },
    authorize: vi.fn(), execute: vi.fn(),
  }) });
  h.client.uploadBrowserScreenshot = vi.fn(async () => ({ fileId: 'image' }));
  h.client.sendMessage.mockImplementation(async function* () {
    yield { event: 'custom', data: { type: 'extension.turn_state', turnId: 'backend-turn', state: 'completed' } };
  });
  await open(h.background);
  await h.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Observe', browser: true });
  expect(h.client.uploadBrowserScreenshot).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'workspace-1' }, 'conversation-1', image, expect.any(AbortSignal));
});

describe('Studio evaluation lifecycle', () => {
  const code = 'private-staff-evaluation-code';
  async function begin(f) {
    await open(f.background);
    f.client.createConversation.mockResolvedValueOnce({ id: 'evaluation-conversation' });
    return f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: code });
  }
  it('keeps the grant and evaluation selection out of storage and restores the personal selection', async () => {
    const f = harness();
    const started = await begin(f);
    expect(started).toMatchObject({ conversationId: 'evaluation-conversation', evaluationActive: true });
    expect(JSON.stringify(started)).not.toContain(code);
    expect(f.state[KEY].conversationId).toBe('conversation-1');
    expect(JSON.stringify(f.storage.set.mock.calls)).not.toContain(code);
    await f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Test' });
    expect(f.client.sendMessage).toHaveBeenCalledWith(
      { userId: 'user-1', workspaceId: 'workspace-1' }, 'evaluation-conversation', 'Test', expect.any(AbortSignal), undefined, code);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain(code);
    await f.background.handle({ type: 'LIMOVA_END_EVALUATION' });
    expect(f.client.cancel).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'workspace-1' }, 'evaluation-conversation');
    await f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Personnel' });
    expect(f.client.sendMessage).toHaveBeenLastCalledWith(
      { userId: 'user-1', workspaceId: 'workspace-1' }, 'conversation-1', 'Personnel', expect.any(AbortSignal), undefined, undefined);
  });

  it.each(['LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_START_EVALUATION'])('prevents changing the evaluation scope through %s', async type => {
    const f = harness(); await begin(f);
    await expect(f.background.handle({ type, evaluationCode: code })).rejects.toThrow();
    expect((await f.background.handle({ type: 'LIMOVA_GET_STATE' })).conversationId).toBe('evaluation-conversation');
  });

  it('does not retain a grant after an account switch', async () => {
    const f = harness(); await begin(f);
    f.client.bootstrap.mockResolvedValue({ user: { id: 'user-2' }, workspaces: [{ id: 'workspace-1', enabled: true }] });
    expect(await f.background.handle({ type: 'LIMOVA_GET_STATE' })).toMatchObject({ evaluationActive: false, conversationId: null });
    await f.background.handle({ type: 'LIMOVA_SELECT_WORKSPACE', workspaceId: 'workspace-1' });
    await f.background.handle({ type: 'LIMOVA_CREATE_CONVERSATION' });
    await f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Hello' });
    expect(f.client.sendMessage.mock.calls.at(-1).at(-1)).toBeUndefined();
  });

  it('clears the local grant even if remote cancellation fails', async () => {
    const f = harness(); await begin(f);
    f.client.cancel.mockRejectedValueOnce(new Error('offline'));
    await expect(f.background.handle({ type: 'LIMOVA_END_EVALUATION' })).rejects.toThrow('offline');
    expect(await f.background.handle({ type: 'LIMOVA_GET_STATE' })).toMatchObject({ evaluationActive: false, conversationId: 'conversation-1' });
  });

  it('leaves the personal selection intact when evaluation authorization fails', async () => {
    const f = harness(); await open(f.background);
    f.client.createConversation.mockRejectedValueOnce(new Error('denied'));
    await expect(f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: code })).rejects.toThrow('denied');
    expect(await f.background.handle({ type: 'LIMOVA_GET_STATE' })).toMatchObject({ evaluationActive: false, conversationId: 'conversation-1' });
  });
});


it('only prepares the grant for the current evaluation conversation', async () => {
  const f = harness(); await open(f.background);
  f.client.createConversation.mockResolvedValueOnce({ id: 'evaluation-conversation' });
  const code = 'private-staff-evaluation-code';
  await f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: code });
  await expect(f.background.handle({ type: 'LIMOVA_PREPARE_VOICE', conversationId: 'conversation-1' })).rejects.toThrow();
  expect(await f.background.handle({ type: 'LIMOVA_PREPARE_VOICE', conversationId: 'evaluation-conversation' }))
    .toEqual({ context: { userId: 'user-1', workspaceId: 'workspace-1' }, conversationId: 'evaluation-conversation', evaluationCode: code });
  expect(JSON.stringify(await f.background.handle({ type: 'LIMOVA_GET_STATE' }))).not.toContain(code);
});

describe('Studio evidence delivery', () => {
  const code = 'private-staff-evaluation-code';
  const action = { actionId: 'a', input: { operation: 'click' }, target: { contextVersion: 3 } };
  const receipt = { state: 'completed', result: { actionId: 'a', status: 'completed' } };
  async function begin(recordEvaluation) {
    const f = harness({ recordEvaluation }); await open(f.background);
    f.client.createConversation.mockResolvedValueOnce({ id: 'evaluation' });
    await f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: code });
    return f;
  }
  it('deduplicates a receipt and binds delivery to the current grant', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const f = await begin(record);
    const request = { type: 'LIMOVA_EVALUATION_ACTION', conversationId: 'evaluation', action, receipt };
    await Promise.all([f.background.handle(request), f.background.handle(request)]);
    await f.background.handle({ type: 'LIMOVA_FLUSH_EVALUATION' });
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ kind: 'tool_result', toolName: 'click_element', status: 'ok', contextVersion: 3 }, code);
    await expect(f.background.handle({ ...request, receipt: { ...receipt, result: { ...receipt.result, status: 'rejected' } } })).rejects.toThrow('contradictoires');
    await f.background.handle({ type: 'LIMOVA_END_EVALUATION' });
    await expect(f.background.handle(request)).rejects.toThrow();
  });
  it('keeps a delivery failure visible when flushing rather than blindly retrying it', async () => {
    const record = vi.fn().mockRejectedValue(new Error('Studio unavailable'));
    const f = await begin(record);
    await expect(f.background.handle({ type: 'LIMOVA_EVALUATION_ACTION', conversationId: 'evaluation', action, receipt })).rejects.toThrow('Studio unavailable');
    await expect(f.background.handle({ type: 'LIMOVA_FLUSH_EVALUATION' })).rejects.toThrow('Studio unavailable');
    expect(record).toHaveBeenCalledOnce();
  });
});

describe('evaluation text response delivery', () => {
  const answer = { id: 'answer-new', type: 'ai', content: 'Private text', tool_calls: [] };
  async function start(history = []) {
    const record = vi.fn().mockResolvedValue(undefined);
    const f = harness({ recordEvaluation: record }); await open(f.background);
    await f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: 'private-staff-evaluation-code' });
    f.client.getMessages.mockResolvedValue({ data: history });
    f.client.sendMessage.mockImplementation(async function* () {
      yield { event: 'values', data: { messages: [{ id: 'human-new', type: 'human' }, answer] } };
    });
    return { ...f, record };
  }
  it('records only the delivery status of the new final answer', async () => {
    const f = await start();
    await f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Test' });
    expect(f.record).toHaveBeenCalledWith({ kind: 'response', status: 'ok' }, 'private-staff-evaluation-code');
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('Private text');
    await f.background.handle({ type: 'LIMOVA_FLUSH_EVALUATION' });
  });
  it('ignores an answer already present before the turn', async () => {
    const f = await start([answer]);
    await f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Test' });
    expect(f.record).not.toHaveBeenCalled();
  });
  it('blocks finalization if the response evidence could not be delivered', async () => {
    const f = await start(); f.record.mockRejectedValue(new Error('Studio offline'));
    await expect(f.background.handle({ type: 'LIMOVA_SEND_MESSAGE', text: 'Test' })).rejects.toThrow('Studio offline');
    await expect(f.background.handle({ type: 'LIMOVA_FLUSH_EVALUATION' })).rejects.toThrow('Studio offline');
  });
});

it('binds canonical voice evidence to the active evaluation and deduplicates its message ID', async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const f = harness({ recordEvaluation: record }); await open(f.background);
  f.client.createConversation.mockResolvedValueOnce({ id: 'evaluation' });
  await f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: 'private-staff-evaluation-code' });
  const request = { type: 'LIMOVA_EVALUATION_RESPONSE', conversationId: 'evaluation', messageId: 'answer-1' };
  await f.background.handle(request); await f.background.handle(request);
  expect(record).toHaveBeenCalledExactlyOnceWith({ kind: 'response', status: 'ok' }, 'private-staff-evaluation-code');
  await expect(f.background.handle({ ...request, conversationId: 'other' })).rejects.toThrow();
  await expect(f.background.handle({ ...request, messageId: '' })).rejects.toThrow();
  await f.background.handle({ type: 'LIMOVA_END_EVALUATION' });
  await expect(f.background.handle(request)).rejects.toThrow();
});

it('verifies a fresh read after a mutation and keeps the observation out of public state', async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const f = harness({ recordEvaluation: record }); await open(f.background);
  f.client.createConversation.mockResolvedValueOnce({ id: 'evaluation' });
  const code = 'private-staff-evaluation-code';
  await f.background.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: code });
  const observedAt = new Date().toISOString();
  await f.background.handle({ type: 'LIMOVA_EVALUATION_ACTION', conversationId: 'evaluation',
    action: { actionId: 'click', input: { operation: 'click' }, target: { contextVersion: 2 } },
    receipt: { state: 'completed', observedAt, result: { actionId: 'click', status: 'completed' } } });
  const snapshot = { text: 'Integration is connected', url: 'https://app.example/settings', contextVersion: 5 };
  const reading = { type: 'LIMOVA_EVALUATION_ACTION', conversationId: 'evaluation',
    action: { actionId: 'read', input: { operation: 'read_page' }, target: { origin: 'https://app.example', contextVersion: 4 } },
    receipt: { state: 'completed', observedAt: new Date().toISOString(), result: { actionId: 'read', contextVersion: 4, status: 'completed', observation: JSON.stringify(snapshot) } } };
  await f.background.handle(reading); await f.background.handle(reading);
  await f.background.handle({ type: 'LIMOVA_FLUSH_EVALUATION' });
  expect(record).toHaveBeenCalledTimes(3);
  expect(record).toHaveBeenLastCalledWith({ kind: 'native_verification', observation: {
    text: snapshot.text, origin: 'https://app.example', path: '/settings', contextVersion: 5, observedAt: reading.receipt.observedAt,
  } }, code);
  expect(JSON.stringify(await f.background.handle({ type: 'LIMOVA_GET_STATE' }))).not.toContain(snapshot.text);
  expect(JSON.stringify(f.storage.set.mock.calls)).not.toContain(snapshot.text);
});
