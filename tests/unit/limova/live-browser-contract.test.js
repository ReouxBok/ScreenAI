import { describe, expect, it } from 'vitest';
import { liveBrowserBinding, liveBrowserContinuation, liveBrowserContextReply } from '../../../src/limova/live-browser-contract.js';

const turnId = '11111111-1111-4111-8111-111111111111';
const browserContext = { tabId: 7, origin: 'https://example.com', contextVersion: 2 };
const result = { turnId, actionId: 'action-1', toolCallId: 'tool-1', contextVersion: 1, status: 'completed', observation: 'Page inspectée' };
const request = { turnId, kind: 'browser_tool_result', browserContext, browserResult: result };

describe('live browser wire contract', () => {
  it('copies only the correlated page response fields', () => {
    const reply = liveBrowserContextReply({ turnId, requestId: turnId, browserContext });
    expect(reply).toEqual({ turnId, requestId: turnId, browserContext });
    expect(reply.browserContext).not.toBe(browserContext);
  });

  it.each([
    { requestId: 'invalid' }, { turnId: 'invalid' }, { agentId: turnId },
    { browserContext: { ...browserContext, origin: 'http://example.com' } },
    { browserContext: { ...browserContext, content: 'not a page binding' } },
  ])('rejects unsafe or unrelated page response fields: %j', changes => {
    expect(() => liveBrowserContextReply({ turnId, requestId: turnId, browserContext, ...changes })).toThrow(TypeError);
  });

  it('snapshots the binding and continuation without sharing caller mutations', () => {
    const binding = liveBrowserBinding(turnId, browserContext);
    expect(binding).toEqual({ browserSession: turnId, browserContext });
    expect(binding.browserContext).not.toBe(browserContext);
    const continuation = liveBrowserContinuation(request);
    expect(continuation).toEqual(request);
    expect(continuation.browserResult).not.toBe(result);
    expect(liveBrowserBinding()).toEqual({});
  });

  it.each([
    { content: 'inject another user message' },
    { turnId: 'wrong' },
    { browserTurnId: turnId },
    { browserContext: { ...browserContext, origin: 'https://example.com/path' } },
    { browserContext: { ...browserContext, contextVersion: -1 } },
    { browserResult: { ...result, observation: 'a'.repeat(32001) } },
    { browserResult: { ...result, status: 'unknown' } },
    { browserResult: { ...result, imageFileId: 'invalid' } },
    { browserResult: { ...result, secret: 'not part of protocol' } },
  ])('rejects invalid or extra continuation fields: %j', patch => {
    expect(() => liveBrowserContinuation({ ...request, ...patch })).toThrow(TypeError);
  });

  it('accepts image references and valid resume without copying a browser credential', () => {
    expect(liveBrowserContinuation({ ...request, browserResult: { ...result, imageFileId: turnId } }).browserResult.imageFileId).toBe(turnId);
    expect(liveBrowserContinuation({ turnId, kind: 'browser_resume', browserContext, browserTurnId: turnId })).toEqual({ turnId, kind: 'browser_resume', browserContext, browserTurnId: turnId });
  });
});
