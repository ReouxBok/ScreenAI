import { describe, expect, it, vi } from 'vitest';
import { createBrowserTurnRunner } from '../../../src/limova/browser-turn.js';

const context = { userId: 'user', workspaceId: 'workspace' };
const action = { type: 'extension.action_requested', turnId: 'turn', actionId: 'action-1', toolCallId: 'tool-1' };
const event = data => ({ event: 'custom', data });
const waiting = event({ type: 'extension.turn_state', turnId: 'turn', state: 'waiting' });
const complete = event({ type: 'extension.turn_state', turnId: 'turn', state: 'completed' });
async function* events(...items) { yield* items; }
function harness() {
  const client = {
    getConversation: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn(() => events(event(action), waiting)),
    sendBrowserResult: vi.fn(() => events(complete)),
    getBrowserTurn: vi.fn().mockResolvedValue({ turnId: 'turn', status: 'open' }),
    resumeBrowserTurn: vi.fn(() => events(event(action), waiting)),
  };
  const execute = vi.fn().mockResolvedValue({ status: 'completed', observation: 'Done' });
  const journal = { getSession: vi.fn().mockResolvedValue('session'), run: vi.fn(async (_scope, action, callback) => ({ state: 'completed', result: { actionId: action.actionId, ...await callback(action) } })) };
  const authorize = vi.fn().mockResolvedValue(undefined);
  const readPage = vi.fn().mockResolvedValue({ tabId: 1, origin: 'https://example.com', contextVersion: 2 });
  const notify = vi.fn();
  return { client, execute, journal, authorize, readPage, notify, runner: createBrowserTurnRunner({ client, journal, execute, authorize, readPage, notify }) };
}

describe('browser turn continuation', () => {
  it('finishes the initial response before executing and continues the same turn', async () => {
    const h = harness();
    let ended = false;
    h.client.sendMessage.mockImplementation(async function* () { yield event(action); yield waiting; ended = true; });
    h.execute.mockImplementation(async () => { expect(ended).toBe(true); return { status: 'completed', observation: 'Done' }; });
    expect(await h.runner.send(context, 'conversation', 'Hello')).toEqual({ state: 'completed', turnId: 'turn' });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.client.sendBrowserResult).toHaveBeenCalledTimes(1);
  });
  it('never executes raw SDK interrupt events', async () => {
    const h = harness();
    h.client.sendMessage.mockReturnValue(events({ event: 'updates', data: { __interrupt__: [action] } }));
    await expect(h.runner.send(context, 'conversation', 'Hello')).rejects.toThrow('durable turn state');
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('refuses action frames without a completed durable waiting response', async () => {
    const h = harness();
    h.client.sendMessage.mockReturnValue(events(event(action)));
    await expect(h.runner.send(context, 'conversation', 'Hello')).rejects.toThrow('durable turn state');
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('stops for uncertain execution without submitting an invented result', async () => {
    const h = harness();
    h.journal.run.mockResolvedValue({ state: 'uncertain', result: null });
    expect(await h.runner.send(context, 'conversation', 'Hello')).toEqual({ state: 'uncertain', turnId: 'turn', actionId: 'action-1' });
    expect(h.client.sendBrowserResult).not.toHaveBeenCalled();
  });
  it('reconnects through recovery without another human message or repeated local action', async () => {
    const h = harness();
    h.journal.run.mockResolvedValue({ state: 'completed', result: { actionId: 'action-1', status: 'completed', observation: 'Saved' } });
    await h.runner.resume(context, 'conversation');
    expect(h.client.sendMessage).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.client.sendBrowserResult).toHaveBeenCalledTimes(1);
  });
  it('does not retry an ambiguous result submission automatically', async () => {
    const h = harness();
    h.client.sendBrowserResult.mockImplementation(async function* () { throw new Error('Network lost'); });
    await expect(h.runner.send(context, 'conversation', 'Hello')).rejects.toThrow('Network lost');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.client.sendBrowserResult).toHaveBeenCalledTimes(1);
  });
  it('rechecks authorization before claiming an action', async () => {
    const h = harness();
    h.authorize.mockRejectedValue(new Error('Permission revoked'));
    await expect(h.runner.send(context, 'conversation', 'Hello')).rejects.toThrow('Permission revoked');
    expect(h.journal.run).not.toHaveBeenCalled();
  });
  it('rejects a continuation from a different turn', async () => {
    const h = harness();
    h.client.resumeBrowserTurn.mockReturnValue(events(event({ ...action, turnId: 'foreign' }), waiting));
    await expect(h.runner.resume(context, 'conversation')).rejects.toThrow('identity changed');
    expect(h.execute).not.toHaveBeenCalled();
  });
});

it('does not interpret an error frame as successful completion', async () => {
  const h = harness();
  h.client.sendMessage.mockReturnValue(events({ event: 'error', data: { message: 'Failure' } }));
  await expect(h.runner.send(context, 'conversation', 'Hello')).rejects.toThrow('stream failed');
  expect(h.execute).not.toHaveBeenCalled();
});

it('reconciles each result response before deciding which next action to execute', async () => {
  const h = harness();
  const second = { ...action, actionId: 'action-2', toolCallId: 'tool-2' };
  h.client.sendMessage.mockReturnValue(events(event(action), event(second), waiting));
  h.client.sendBrowserResult.mockReturnValueOnce(events(event(second), waiting)).mockReturnValueOnce(events(complete));
  expect(await h.runner.send(context, 'conversation', 'Hello')).toEqual({ state: 'completed', turnId: 'turn' });
  expect(h.execute.mock.calls.map(([action]) => action.actionId)).toEqual(['action-1', 'action-2']);
});
