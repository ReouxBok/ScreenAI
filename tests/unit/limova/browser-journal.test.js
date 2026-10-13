import { describe, expect, it, vi } from 'vitest';
import { createBrowserJournal } from '../../../src/limova/browser-journal.js';

const ID = '11111111-1111-4111-8111-111111111111';
const scope = { userId: ID, workspaceId: ID, conversationId: ID, sessionId: ID };
const action = { type: 'extension.action_requested', protocolVersion: 1, turnId: ID, actionId: 'action', toolCallId: 'call',
  target: { tabId: 1, origin: 'https://example.com', contextVersion: 1 }, input: { operation: 'click', elementId: 1 },
  expiresAt: '2099-01-01T00:00:00.000Z' };

describe('browser journal input boundary', () => {
  it.each([
    { operation: 'eval', script: 'dangerous' },
    { operation: 'click', elementId: '1' },
    { operation: 'click', elementId: 1, url: 'https://example.com' },
    { operation: 'highlight', elementId: -1 },
    { operation: 'type_text', elementId: 1, text: 'x'.repeat(8001) },
    { operation: 'type_text', elementId: 1 },
    { operation: 'scroll', direction: 'left' },
    { operation: 'navigate', url: 'javascript:alert(1)' },
    { operation: 'navigate', url: 'https://name:secret@example.com/' },
    { operation: 'navigate', url: 'broken' },
    { operation: 'navigate', url: 'http://example.com/' },
    { operation: 'read_page', elementId: 1 },
    { operation: 'screenshot', text: 'unexpected' },
  ])('rejects malformed or unsupported operation before storage or execution %#', async input => {
    const execute = vi.fn();
    await expect(createBrowserJournal().run(scope, { ...action, input }, execute)).rejects.toThrow('Invalid browser action');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not coerce an array into an account identifier', async () => {
    await expect(createBrowserJournal().run({ ...scope, userId: [ID] }, action, vi.fn())).rejects.toThrow('Invalid browser action');
  });

  it.each([
    { ...action, type: 'interrupt' },
    { ...action, protocolVersion: 2 },
    { ...action, expiresAt: 1 },
    { ...action, turnId: [ID] },
    { ...action, target: { ...action.target, origin: 'https://example.com/path' } },
  ])('refuses raw interrupts and invalid action bindings %#', async invalid => {
    const execute = vi.fn();
    await expect(createBrowserJournal().run(scope, invalid, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
