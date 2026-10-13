import { describe, expect, it, vi } from 'vitest';
import { createLimovaBackground } from '../../../src/limova/background.js';

const KEY = 'limova_deep_agent_context_v1';
function harness() {
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
  const notify = vi.fn();
  return { state, storage, client, notify, background: createLimovaBackground({ storage, client, notify, openTab: vi.fn() }) };
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
