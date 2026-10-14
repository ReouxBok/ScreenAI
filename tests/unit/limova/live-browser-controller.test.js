import { describe, expect, it, vi } from 'vitest';
import { createLiveBrowserController } from '../../../src/limova/live-browser-controller.js';

const uuid = n => `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) + '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12);
const sessionId = uuid(1), turnId = uuid(2), browserId = uuid(3);
const action = { type: 'extension.action_requested', turnId: browserId, actionId: 'action-1', toolCallId: 'tool-1' };
const waiting = { type: 'extension.turn_state', turnId: browserId, state: 'waiting' };
const page = { tabId: 7, origin: 'https://example.com', contextVersion: 2 };

function harness(onActionResult, evidence = {}) {
  const client = { getConversation: vi.fn().mockResolvedValue({}) };
  const driver = { authorize: vi.fn().mockResolvedValue(undefined), execute: vi.fn().mockResolvedValue({ status: 'completed', observation: 'Done' }), readPage: vi.fn().mockResolvedValue(page) };
  const journal = { run: vi.fn(async (_scope, action, execute) => ({ state: 'completed', result: { turnId: action.turnId, actionId: action.actionId, ...await execute(action) } })) };
  const continueBrowser = vi.fn(), onError = vi.fn(), notify = vi.fn();
  const controller = createLiveBrowserController({ context: { userId: uuid(4), workspaceId: uuid(5) }, conversationId: uuid(6), browserSession: uuid(7), client, driver, journal, continueBrowser, onError, notify, onActionResult, ...evidence });
  controller.onEvent('session.ready', { sessionId });
  controller.onEvent('turn.deep_agent_stream.started', { sessionId, turnId });
  const bytes = chunk => controller.onEvent('turn.deep_agent_stream.delta', { sessionId, turnId, chunk: Array.from(chunk) });
  const send = (...frames) => bytes(new TextEncoder().encode(frames.map(data => `event: custom\ndata: ${JSON.stringify(data)}\n\n`).join('')));
  return { controller, client, driver, journal, continueBrowser, onError, notify, send, bytes };
}

describe('voice browser controller', () => {
  it('executes only after durable waiting, without awaiting the action in ingestion', async () => {
    const h = harness();
    let finish;
    h.driver.execute.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    expect(h.send(action)).toBeUndefined();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.driver.execute).not.toHaveBeenCalled();
    expect(h.send(waiting)).toBeUndefined();
    await vi.waitFor(() => expect(h.driver.execute).toHaveBeenCalledTimes(1));
    expect(h.continueBrowser).not.toHaveBeenCalled();
    finish({ status: 'completed', observation: 'Done' });
    await vi.waitFor(() => expect(h.continueBrowser).toHaveBeenCalledTimes(1));
    expect(h.continueBrowser).toHaveBeenCalledWith({ turnId, kind: 'browser_tool_result', browserContext: page, browserResult: expect.objectContaining({ turnId: browserId, actionId: 'action-1' }) });
    h.controller.stop();
  });

  it('aborts an in-flight action and does not send its late result', async () => {
    const h = harness();
    let finish;
    h.driver.execute.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    h.send(action, waiting);
    await vi.waitFor(() => expect(h.driver.execute).toHaveBeenCalled());
    h.controller.onEvent('turn.interrupted', { sessionId, turnId });
    expect(h.driver.execute.mock.calls[0][1].aborted).toBe(true);
    finish({ status: 'completed', observation: 'Late' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.continueBrowser).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('does not replay an uncertain journal receipt', async () => {
    const h = harness();
    h.journal.run.mockResolvedValue({ state: 'uncertain' });
    h.send(action, waiting);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    expect(h.driver.execute).not.toHaveBeenCalled();
    expect(h.continueBrowser).not.toHaveBeenCalled();
  });

  it('returns rejection when permission was revoked before dispatch', async () => {
    const h = harness();
    h.driver.authorize.mockRejectedValue(new Error('Revoked'));
    h.send(action, waiting);
    await vi.waitFor(() => expect(h.continueBrowser).toHaveBeenCalled());
    expect(h.driver.execute).not.toHaveBeenCalled();
    expect(h.continueBrowser.mock.calls[0][0].browserResult.status).toBe('rejected');
    h.controller.stop();
  });

  it('rejects mixed browser identities before dispatch', async () => {
    const h = harness();
    h.send(action, { ...waiting, turnId: uuid(8) });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());
    expect(h.driver.execute).not.toHaveBeenCalled();
  });

  it('releases a completed turn before accepting the next voice turn', async () => {
    const h = harness();
    h.send(action, waiting);
    await vi.waitFor(() => expect(h.continueBrowser).toHaveBeenCalledTimes(1));
    h.send({ ...waiting, state: 'completed' });
    h.controller.onEvent('turn.deep_agent_stream.completed', { sessionId, turnId });
    await new Promise(resolve => setTimeout(resolve, 0));
    const nextTurn = uuid(8);
    h.controller.onEvent('turn.deep_agent_stream.started', { sessionId, turnId: nextTurn });
    const frames = [{ ...action, turnId: uuid(9), actionId: 'action-2' }, { ...waiting, turnId: uuid(9) }];
    h.controller.onEvent('turn.deep_agent_stream.delta', { sessionId, turnId: nextTurn,
      chunk: Array.from(new TextEncoder().encode(frames.map(data => `event: custom\ndata: ${JSON.stringify(data)}\n\n`).join(''))) });
    await vi.waitFor(() => expect(h.continueBrowser).toHaveBeenCalledTimes(2));
    expect(h.continueBrowser.mock.calls[1][0].turnId).toBe(nextTurn);
    expect(h.onError).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('closes on an oversized native chunk before executing anything', () => {
    const h = harness();
    h.bytes(new Uint8Array(65537));
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.driver.execute).not.toHaveBeenCalled();
  });

  it('parses fragmented UTF-8 and rejects an unfinished frame at completion', async () => {
    const h = harness();
    const chunk = new TextEncoder().encode('event: values\ndata: {"text":"é 🎉"}\n\n');
    chunk.forEach(byte => h.bytes(new Uint8Array([byte])));
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ data: { text: 'é 🎉' } })));
    h.bytes(new TextEncoder().encode('event: custom\ndata: {'));
    h.controller.onEvent('turn.deep_agent_stream.completed', { sessionId, turnId });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());
    expect(h.driver.execute).not.toHaveBeenCalled();
  });
});


it('stops the voice turn if its executed action cannot be recorded in Studio', async () => {
  const report = vi.fn().mockRejectedValue(new Error('Studio offline'));
  const h = harness(report);
  h.send(action, waiting);
  await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Studio offline' })));
  expect(h.driver.execute).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(h.continueBrowser).not.toHaveBeenCalled();
  h.controller.stop();
});


const canonicalVoiceFrame = (answerId = 'new-answer') => new TextEncoder().encode(`event: values\ndata: ${JSON.stringify({ messages: [
  { id: 'human', type: 'human', content: 'Question' },
  { id: answerId, type: 'ai', content: 'Private answer', tool_calls: [] },
] })}\n\n`);

it('records canonical voice response only after explicit completion and excludes its text', async () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const h = harness(undefined, { evaluationHistory: { data: [] }, onCanonicalResponse: record });
  h.bytes(canonicalVoiceFrame());
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalled());
  expect(record).not.toHaveBeenCalled();
  h.controller.onEvent('turn.deep_agent_stream.completed', { sessionId, turnId });
  await h.controller.flushEvidence();
  expect(record).toHaveBeenCalledExactlyOnceWith('new-answer');
  h.controller.stop();
});

it.each(['turn.interrupted', 'turn.deep_agent_stream.failed'])('does not count interrupted voice output: %s', event => {
  const record = vi.fn();
  const h = harness(undefined, { evaluationHistory: { data: [] }, onCanonicalResponse: record });
  h.bytes(canonicalVoiceFrame());
  h.controller.onEvent(event, { sessionId, turnId });
  expect(record).not.toHaveBeenCalled();
  h.controller.stop();
});

it('keeps a failed voice evidence delivery visible to finalization', async () => {
  const record = vi.fn().mockRejectedValue(new Error('Studio offline'));
  const h = harness(undefined, { evaluationHistory: { data: [] }, onCanonicalResponse: record });
  h.bytes(canonicalVoiceFrame());
  h.controller.onEvent('turn.deep_agent_stream.completed', { sessionId, turnId });
  await expect(h.controller.flushEvidence()).rejects.toThrow('Studio offline');
  expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Studio offline' }));
  h.controller.stop();
});

it('does not count a previous voice response replayed in a new turn', async () => {
  const record = vi.fn();
  const h = harness(undefined, { evaluationHistory: { data: [{ id: 'old-answer' }] }, onCanonicalResponse: record });
  h.bytes(canonicalVoiceFrame('old-answer'));
  h.controller.onEvent('turn.deep_agent_stream.completed', { sessionId, turnId });
  await h.controller.flushEvidence();
  expect(record).not.toHaveBeenCalled();
  h.controller.stop();
});
