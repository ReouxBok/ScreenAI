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
