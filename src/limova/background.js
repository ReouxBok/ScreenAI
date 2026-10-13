import { createBrowserTurnRunner } from './browser-turn.js';
import { createBrowserJournal } from './browser-journal.js';
import { LimovaDeepAgentClient, LIMOVA_APP_URL } from './client.js';

const STORAGE_KEY = 'limova_deep_agent_context_v1';
export const LIMOVA_MESSAGE_TYPES = new Set([
  'LIMOVA_GET_STATE', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_LIST_CONVERSATIONS',
  'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_SEND_MESSAGE',
  'LIMOVA_CANCEL', 'LIMOVA_OPEN_APP', 'LIMOVA_LOGOUT',
  'LIMOVA_GET_MESSAGES', 'LIMOVA_RESUME_BROWSER',
]);

export function createLimovaBackground({ storage, openTab, notify, client = new LimovaDeepAgentClient(), journal = createBrowserJournal(), createDriver }) {
  let context = null;
  let conversationId = null;
  let activeTurn = null;
  let contextQueue = Promise.resolve();

  async function save() {
    if (!context) return storage.remove(STORAGE_KEY);
    await storage.set({ [STORAGE_KEY]: { ...context, conversationId } });
  }

  async function cancel() {
    const turn = activeTurn;
    if (!turn) {
      if (context && conversationId) await client.cancel(context, conversationId);
      return { ok: true };
    }
    turn.controller.abort();
    activeTurn = null;
    await client.cancel(turn.context, turn.conversationId);
    return { ok: true };
  }

  async function state() {
    const current = await client.bootstrap();
    const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    const previous = context ?? stored;
    const workspace = previous?.userId === current.user.id
      ? current.workspaces.find(item => item.id === previous.workspaceId) : null;
    if (!workspace || !workspace.enabled) {
      if (previous?.userId === current.user.id) await cancel().catch(() => {});
      else {
        activeTurn?.controller.abort();
        activeTurn = null;
      }
      if (previous?.userId) await journal.clearAccount(previous.userId);
      context = null;
      conversationId = null;
      await save();
    } else {
      context = { userId: current.user.id, workspaceId: workspace.id };
      await journal.getSession(context);
      conversationId = conversationId ?? stored?.conversationId ?? null;
    }
    return { authenticated: true, ...current, context, conversationId, activeTurnId: activeTurn?.id ?? null };
  }

  function requireContext() {
    if (!context) throw new Error('Sélectionne un espace Limova activé.');
    return { ...context };
  }

  async function handle(request) {
    switch (request.type) {
      case 'LIMOVA_GET_STATE':
        try { return await state(); } catch (error) {
          if (error.code !== 'LIMOVA_LOGIN_REQUIRED') throw error;
          const previous = context ?? (await storage.get(STORAGE_KEY))[STORAGE_KEY];
          if (previous?.userId) await journal.clearAccount(previous.userId);
          activeTurn?.controller.abort();
          activeTurn = null;
          context = null;
          conversationId = null;
          await save();
          return { authenticated: false, workspaces: [], context: null, conversationId: null };
        }
      case 'LIMOVA_OPEN_APP':
        await openTab({ url: LIMOVA_APP_URL });
        return { ok: true };
      case 'LIMOVA_SELECT_WORKSPACE': {
        const current = await client.bootstrap();
        const workspace = current.workspaces.find(item => item.id === request.workspaceId && item.enabled);
        if (!workspace) throw new Error('L’extension n’est pas activée pour cet espace.');
        await cancel();
        if (context) await journal.revokeSession(context);
        context = { userId: current.user.id, workspaceId: workspace.id };
        await journal.getSession(context);
        conversationId = null;
        await save();
        return { ok: true, context };
      }
      case 'LIMOVA_LIST_CONVERSATIONS':
        return client.listConversations(requireContext(), request.page ?? 1);
      case 'LIMOVA_GET_MESSAGES':
        return client.getMessages(requireContext(), conversationId, request.cursor);
      case 'LIMOVA_CREATE_CONVERSATION': {
        await cancel();
        const conversation = await client.createConversation(requireContext(), request.title);
        conversationId = conversation.id;
        await save();
        return conversation;
      }
      case 'LIMOVA_OPEN_CONVERSATION': {
        await cancel();
        const conversation = await client.getConversation(requireContext(), request.conversationId);
        const messages = await client.getMessages(requireContext(), conversation.id);
        conversationId = conversation.id;
        await save();
        return { conversation, messages };
      }
      case 'LIMOVA_RESUME_BROWSER':
      case 'LIMOVA_SEND_MESSAGE': {
        if (request.type === 'LIMOVA_RESUME_BROWSER' && request.browser !== true) throw new Error('Autorise le navigateur avant de reprendre ce tour.');
        if (activeTurn) throw new Error('Un tour est déjà en cours.');
        if (!conversationId) throw new Error('Ouvre une conversation Limova.');
        const turn = { id: crypto.randomUUID(), context: requireContext(), conversationId, controller: new AbortController() };
        activeTurn = turn;
        notify({ type: 'LIMOVA_TURN_STARTED', turnId: turn.id, conversationId });
        try {
          const emit = event => {
            if (activeTurn === turn) notify({ type: 'LIMOVA_STREAM_EVENT', turnId: turn.id, conversationId: turn.conversationId, event });
          };
          if (request.browser === true) {
            if (!createDriver) throw new Error('Le pilote navigateur est indisponible.');
            const sessionId = await journal.getSession(turn.context);
            const driver = createDriver({ scope: { ...turn.context, sessionId }, journal, signal: turn.controller.signal,
              uploadScreenshot: (image, signal) => client.uploadBrowserScreenshot(turn.context, turn.conversationId, image, signal) });
            const runner = createBrowserTurnRunner({ client, journal, readPage: driver.readPage,
              execute: driver.execute, authorize: driver.authorize, notify: emit });
            const outcome = request.type === 'LIMOVA_RESUME_BROWSER'
              ? await runner.resume(turn.context, turn.conversationId, turn.controller.signal)
              : await runner.send(turn.context, turn.conversationId, request.text, turn.controller.signal);
            notify({ type: 'LIMOVA_BROWSER_STATE', turnId: turn.id, conversationId: turn.conversationId, state: outcome.state, actionId: outcome.actionId, browserTurnId: outcome.turnId });
            return { ok: true, turnId: turn.id, browserState: outcome.state };
          }
          for await (const event of client.sendMessage(turn.context, turn.conversationId, request.text, turn.controller.signal)) {
            if (activeTurn !== turn) break;
            emit(event);
          }
          return { ok: true, turnId: turn.id };
        } catch (error) {
          if (activeTurn === turn && ['LIMOVA_ACCOUNT_CHANGED', 'LIMOVA_LOGIN_REQUIRED', 'LIMOVA_EXTENSION_DISABLED'].includes(error.code)) {
            await journal.clearAccount(turn.context.userId);
            context = null;
            conversationId = null;
            await save();
            notify({ type: 'LIMOVA_SESSION_CHANGED' });
          }
          throw error;
        } finally {
          if (activeTurn === turn) activeTurn = null;
          notify({ type: 'LIMOVA_TURN_ENDED', turnId: turn.id, conversationId: turn.conversationId });
        }
      }
      case 'LIMOVA_CANCEL':
        return cancel();
      case 'LIMOVA_LOGOUT': {
        const previous = context ?? (await storage.get(STORAGE_KEY))[STORAGE_KEY];
        try { await cancel(); } finally {
          if (previous?.userId) await journal.clearAccount(previous.userId);
          context = null;
          conversationId = null;
          await save();
        }
        await client.logout();
        return { authenticated: false };
      }
      default:
        throw new Error('Opération Limova non reconnue.');
    }
  }
  return { handle(request) {
    if (['LIMOVA_GET_STATE', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_LOGOUT'].includes(request.type)) {
      const operation = contextQueue.then(() => handle(request));
      contextQueue = operation.catch(() => {});
      return operation;
    }
    if (request.type === 'LIMOVA_CANCEL') return handle(request);
    return contextQueue.then(() => handle(request));
  } };
}
