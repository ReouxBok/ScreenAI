import { readDeepAgentEvents } from './sse.js';
import { liveUuid } from './live-browser-contract.js';

const MAX_BUFFER = 256_000;
const MAX_ACTIONS = 100;

export function createLiveBrowserController({ context, conversationId, browserSession,
  client, journal, driver, continueBrowser, onError, notify = () => {}, signal }) {
  context = Object.freeze({ ...context });
  const scope = Object.freeze({ ...context, conversationId, sessionId: browserSession });
  if (![scope.userId, scope.workspaceId, conversationId, browserSession].every(liveUuid)) throw new TypeError('Invalid voice browser scope');
  let current, sessionId, closed = false;
  const cancelTurn = () => {
    const turn = current;
    current = undefined;
    turn?.abort.abort();
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    cancelTurn();
    signal?.removeEventListener('abort', stop);
  };
  const fail = error => { if (!closed) { stop(); onError(error); } };

  async function runAction(turn, action) {
    const signal = turn.abort.signal;
    signal.throwIfAborted();
    await client.getConversation(context, conversationId, signal);
    signal.throwIfAborted();
    const receipt = await journal.run(scope, action, async validated => {
      signal.throwIfAborted();
      try { await driver.authorize(context, validated, signal); }
      catch {
        signal.throwIfAborted();
        return { status: 'rejected', observation: 'Browser action is no longer authorized for this page.' };
      }
      signal.throwIfAborted();
      return driver.execute(validated, signal);
    });
    signal.throwIfAborted();
    if (receipt.state !== 'completed') throw new Error('Browser action outcome is uncertain; no replay was attempted');
    const page = await driver.readPage(signal);
    signal.throwIfAborted();
    if (current !== turn) throw new Error('Voice turn changed');
    turn.busy = false;
    continueBrowser({ turnId: turn.id, kind: 'browser_tool_result', browserContext: page, browserResult: receipt.result });
  }

  function consume(turn, event) {
    if (event.event === 'error') throw new Error('Native voice stream failed');
    const data = event.event === 'custom' ? event.data : undefined;
    if (['extension.action_requested', 'extension.turn_state'].includes(data?.type)) {
      if (!liveUuid(data.turnId) || (turn.browserId && turn.browserId !== data.turnId)) throw new Error('Browser turn identity changed');
      turn.browserId = data.turnId;
      if (data.type === 'extension.action_requested') {
        if (turn.busy || turn.actions.size >= MAX_ACTIONS) throw new Error('Unexpected browser action sequence');
        const previous = turn.actions.get(data.actionId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(data)) throw new Error('Conflicting browser action');
        turn.actions.set(data.actionId, data);
      } else if (data.state === 'waiting') {
        if (turn.busy || !turn.actions.size || ++turn.count > MAX_ACTIONS) throw new Error('Invalid browser waiting state');
        const action = turn.actions.values().next().value;
        turn.actions.clear();
        turn.busy = true;
        turn.job = runAction(turn, action);
        void turn.job.catch(error => { if (!turn.abort.signal.aborted) fail(error); });
      } else if (data.state === 'completed') {
        if (turn.actions.size || turn.busy) throw new Error('Browser turn completed before its actions');
      } else if (data.state !== 'resuming') throw new Error('Invalid browser turn state');
    }
    const notification = notify(event);
    if (typeof notification?.then === 'function') void Promise.resolve(notification).catch(fail);
  }

  function startTurn(id) {
    if (!liveUuid(id) || current) throw new Error('Unexpected voice turn');
    const turn = { id, abort: new AbortController(), actions: new Map(), count: 0, busy: false, ending: false, job: Promise.resolve() };
    const body = new ReadableStream({ start(controller) { turn.input = controller; } },
      { highWaterMark: MAX_BUFFER, size: chunk => chunk.byteLength });
    current = turn;
    turn.parsing = (async () => {
      for await (const event of readDeepAgentEvents(body, turn.abort.signal)) consume(turn, event);
      if (turn.actions.size || turn.busy) throw new Error('Voice stream ended before browser completion');
    })();
    void turn.parsing.catch(error => { if (!turn.abort.signal.aborted) fail(error); });
  }

  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return {
    // Synchronous ingestion keeps the transport ACK independent of action execution.
    onEvent(event, payload) {
      if (closed) return;
      try {
        if (event === 'session.ready') {
          if (sessionId || !liveUuid(payload?.sessionId)) throw new Error('Invalid voice session');
          sessionId = payload.sessionId;
          return;
        }
        if (!sessionId || payload?.sessionId !== sessionId) throw new Error('Voice session changed');
        if (event === 'session.ended' || event === 'error') { stop(); return; }
        if (event === 'turn.deep_agent_stream.started') { startTurn(payload.turnId); return; }
        if (['turn.interrupted', 'turn.deep_agent_stream.interrupted', 'turn.deep_agent_stream.failed'].includes(event)) {
          if (current && (!payload.turnId || payload.turnId === current.id)) cancelTurn();
          return;
        }
        if (!['turn.deep_agent_stream.delta', 'turn.deep_agent_stream.completed'].includes(event)) return;
        const turn = current;
        if (!turn || payload.turnId !== turn.id || turn.ending) throw new Error('Unexpected native voice frame');
        if (event === 'turn.deep_agent_stream.completed') {
          turn.ending = true;
          turn.input.close();
          void turn.parsing.then(() => { if (current === turn) current = undefined; }).catch(() => {});
          return;
        }
        const bytes = payload.chunk;
        if (!Array.isArray(bytes) || !bytes.length || bytes.length > 65_536
          || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
          || turn.input.desiredSize < bytes.length) throw new Error('Native voice buffer exceeded');
        turn.input.enqueue(Uint8Array.from(bytes));
      } catch (error) { fail(error); }
    },
    stop,
  };
}
