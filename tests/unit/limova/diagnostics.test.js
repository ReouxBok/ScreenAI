import { describe, expect, it, vi } from 'vitest';
import { diagnoseLimovaClient } from '../../../src/limova/diagnostics.js';

const selection = { userId: 'user', workspaceId: 'workspace', conversationId: 'chat' };
function fixture() {
  return {
    bootstrap: vi.fn().mockResolvedValue({ user: { id: 'user', email: 'private@example.test' }, workspaces: [{ id: 'workspace', enabled: true }] }),
    getMainAgent: vi.fn().mockResolvedValue({ id: 'agent', slug: 'charly' }),
    getConversation: vi.fn().mockResolvedValue({ id: 'chat', title: 'Private title' }),
  };
}

describe('native readiness diagnostics', () => {
  it('probes the selected account, agent and conversation without exposing their data', async () => {
    const client = fixture();
    const checks = await diagnoseLimovaClient(client, selection);
    expect(checks.map(check => check.code)).toEqual(['DIAGNOSTIC_LIMOVA_SESSION_OK', 'DIAGNOSTIC_LIMOVA_WORKSPACE_OK', 'DIAGNOSTIC_LIMOVA_AGENT_OK', 'DIAGNOSTIC_LIMOVA_CONVERSATION_OK', 'DIAGNOSTIC_DEEP_AGENT_NOT_EXECUTED']);
    expect(client.getMainAgent).toHaveBeenCalledWith(selection, expect.any(AbortSignal));
    expect(client.getConversation).toHaveBeenCalledWith(selection, 'chat', expect.any(AbortSignal));
    expect(JSON.stringify(checks)).not.toMatch(/private@example|Private title/);
  });
  it.each([
    [null, 'DIAGNOSTIC_LIMOVA_WORKSPACE_REQUIRED'],
    [{ ...selection, userId: 'other' }, 'DIAGNOSTIC_LIMOVA_ACCOUNT_CHANGED'],
    [{ ...selection, workspaceId: 'foreign' }, 'DIAGNOSTIC_LIMOVA_WORKSPACE_DISABLED'],
  ])('does not probe an agent with an invalid selection', async (context, code) => {
    const client = fixture();
    expect((await diagnoseLimovaClient(client, context)).at(-1).code).toBe(code);
    expect(client.getMainAgent).not.toHaveBeenCalled();
    expect(client.getConversation).not.toHaveBeenCalled();
  });
  it('stops when the shared flag is disabled', async () => {
    const client = fixture();
    client.bootstrap.mockResolvedValue({ user: { id: 'user' }, workspaces: [{ id: 'workspace', enabled: false }] });
    expect((await diagnoseLimovaClient(client, selection)).at(-1).code).toBe('DIAGNOSTIC_LIMOVA_WORKSPACE_DISABLED');
    expect(client.getMainAgent).not.toHaveBeenCalled();
  });
  it.each(['LIMOVA_LOGIN_REQUIRED', 'NETWORK_ERROR'])('reports a fixed session failure without returning an exception body', async code => {
    const client = fixture();
    client.bootstrap.mockRejectedValue(Object.assign(new Error('secret token and private URL'), { code }));
    const checks = await diagnoseLimovaClient(client, selection);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('error');
    expect(JSON.stringify(checks)).not.toContain('secret');
    expect(client.getMainAgent).not.toHaveBeenCalled();
  });
  it('reports unavailable agent and inaccessible conversation distinctly', async () => {
    const client = fixture();
    client.getMainAgent.mockRejectedValueOnce(new Error('private failure'));
    expect((await diagnoseLimovaClient(client, selection)).at(-1).code).toBe('DIAGNOSTIC_LIMOVA_AGENT_UNAVAILABLE');
    expect(client.getConversation).not.toHaveBeenCalled();
    client.getConversation.mockRejectedValueOnce(new Error('private failure'));
    expect(await diagnoseLimovaClient(client, selection)).toContainEqual(expect.objectContaining({ code: 'DIAGNOSTIC_LIMOVA_CONVERSATION_UNAVAILABLE', status: 'error' }));
  });
  it('does not require or create a conversation for a new user', async () => {
    const client = fixture();
    const checks = await diagnoseLimovaClient(client, { ...selection, conversationId: null });
    expect(checks.some(check => check.status === 'error')).toBe(false);
    expect(checks).toContainEqual(expect.objectContaining({ code: 'DIAGNOSTIC_LIMOVA_CONVERSATION_NOT_SELECTED', status: 'info' }));
    expect(client.getConversation).not.toHaveBeenCalled();
  });
});
