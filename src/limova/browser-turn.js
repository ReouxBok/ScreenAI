const MAX_ACTIONS_PER_TURN = 100;

export function createBrowserTurnRunner({ client, journal, readPage, execute, authorize, notify }) {
  async function consume(stream, expectedTurnId, signal) {
    const actions = new Map();
    let turnId = expectedTurnId;
    let state;
    for await (const event of stream) {
      signal?.throwIfAborted();
      if (event.event === 'error') throw new Error('Deep Agent browser stream failed');
      if (event.event === 'custom') {
        const data = event.data;
        if (data?.type === 'extension.action_requested' || data?.type === 'extension.turn_state') {
          if (!data.turnId || (turnId && data.turnId !== turnId)) throw new Error('Browser turn identity changed');
          turnId = data.turnId;
          if (data.type === 'extension.action_requested') {
            const previous = actions.get(data.actionId);
            if (previous && JSON.stringify(previous) !== JSON.stringify(data)) throw new Error('Conflicting browser action frames');
            actions.set(data.actionId, data);
          } else {
            if (!['waiting', 'completed'].includes(data.state)) throw new Error('Invalid browser turn state');
            state = data.state;
          }
        }
      }
      notify(event);
    }
    if (!state) throw new Error('Browser response ended without a durable turn state');
    if (actions.size && state !== 'waiting') throw new Error('Browser actions were not durably advertised');
    return { turnId, state, actions: [...actions.values()] };
  }

  async function continueTurn(context, conversationId, sessionId, pending, signal) {
    let count = 0;
    while (pending.state === 'waiting' && pending.actions.length) {
      signal?.throwIfAborted();
      if (++count > MAX_ACTIONS_PER_TURN) throw new Error('Browser action limit reached');
      const action = pending.actions[0];
      await client.getConversation(context, conversationId, signal);
      await authorize(context, action, signal);
      signal?.throwIfAborted();
      const scope = { ...context, conversationId, sessionId };
      const receipt = await journal.run(scope, action, async validated => {
        signal?.throwIfAborted();
        return execute(validated, signal);
      });
      if (receipt.state !== 'completed') return { state: 'uncertain', turnId: pending.turnId, actionId: action.actionId };
      signal?.throwIfAborted();
      const page = await readPage(signal);
      const stream = client.sendBrowserResult(context, conversationId, { sessionId, page }, receipt.result, signal);
      pending = await consume(stream, pending.turnId, signal);
    }
    return { state: pending.state, turnId: pending.turnId };
  }

  return {
    async send(context, conversationId, content, signal) {
      context = Object.freeze({ ...context });
      const sessionId = await journal.getSession(context);
      const page = await readPage(signal);
      const stream = client.sendMessage(context, conversationId, content, signal, { sessionId, page });
      const pending = await consume(stream, undefined, signal);
      return continueTurn(context, conversationId, sessionId, pending, signal);
    },
    async resume(context, conversationId, signal) {
      context = Object.freeze({ ...context });
      const sessionId = await journal.getSession(context);
      const turn = await client.getBrowserTurn(context, conversationId, sessionId, signal);
      if (!turn || turn.status !== 'open') return { state: turn?.status ?? 'absent', turnId: turn?.turnId };
      const page = await readPage(signal);
      const stream = client.resumeBrowserTurn(context, conversationId, { sessionId, page }, turn.turnId, signal);
      const pending = await consume(stream, turn.turnId, signal);
      return continueTurn(context, conversationId, sessionId, pending, signal);
    },
  };
}
