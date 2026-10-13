import { LimovaDeepAgentClient, LIMOVA_APP_URL } from './client.js';

const STORAGE_KEY = 'limova_deep_agent_context_v1';
export const LIMOVA_MESSAGE_TYPES = new Set([
  'LIMOVA_GET_STATE', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_LIST_CONVERSATIONS',
  'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_SEND_MESSAGE',
  'LIMOVA_CANCEL', 'LIMOVA_OPEN_APP', 'LIMOVA_LOGOUT',
  'LIMOVA_GET_MESSAGES',
]);

export function createLimovaBackground({ storage, openTab, notify, client = new LimovaDeepAgentClient() }) {
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
    if (!turn) return { ok: true };
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
      context = null;
      conversationId = null;
      await save();
      await cancel().catch(() => {});
    } else {
      context = { userId: current.user.id, workspaceId: workspace.id };
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
        context = { userId: current.user.id, workspaceId: workspace.id };
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
      case 'LIMOVA_SEND_MESSAGE': {
        if (activeTurn) throw new Error('Un tour est déjà en cours.');
        if (!conversationId) throw new Error('Ouvre une conversation Limova.');
        const turn = { id: crypto.randomUUID(), context: requireContext(), conversationId, controller: new AbortController() };
        activeTurn = turn;
        notify({ type: 'LIMOVA_TURN_STARTED', turnId: turn.id, conversationId });
        try {
          for await (const event of client.sendMessage(turn.context, turn.conversationId, request.text, turn.controller.signal)) {
            if (activeTurn !== turn) break;
            notify({ type: 'LIMOVA_STREAM_EVENT', turnId: turn.id, conversationId: turn.conversationId, event });
          }
          return { ok: true, turnId: turn.id };
        } catch (error) {
          if (activeTurn === turn && ['LIMOVA_ACCOUNT_CHANGED', 'LIMOVA_LOGIN_REQUIRED', 'LIMOVA_EXTENSION_DISABLED'].includes(error.code)) {
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
      case 'LIMOVA_LOGOUT':
        await cancel();
        await client.logout();
        context = null;
        conversationId = null;
        await save();
        return { authenticated: false };
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
