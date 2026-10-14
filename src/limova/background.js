import { createEvaluationResponseEvidence } from './evaluation-response.js';
import { projectEvaluationAction } from './evaluation-evidence.js';
import { evaluationGrant } from './evaluation-grant.js';
import { createBrowserTurnRunner } from './browser-turn.js';
import { createBrowserJournal } from './browser-journal.js';
import { LimovaDeepAgentClient, LIMOVA_APP_URL } from './client.js';

const STORAGE_KEY = 'limova_deep_agent_context_v1';
export const LIMOVA_MESSAGE_TYPES = new Set([
  'LIMOVA_GET_STATE', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_LIST_CONVERSATIONS',
  'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_SEND_MESSAGE',
  'LIMOVA_CANCEL', 'LIMOVA_OPEN_APP', 'LIMOVA_LOGOUT',
  'LIMOVA_GET_MESSAGES', 'LIMOVA_RESUME_BROWSER',
  'LIMOVA_START_EVALUATION', 'LIMOVA_END_EVALUATION', 'LIMOVA_PREPARE_VOICE', 'LIMOVA_EVALUATION_ACTION', 'LIMOVA_FLUSH_EVALUATION', 'LIMOVA_EVALUATION_RESPONSE',
]);

export function createLimovaBackground({ storage, openTab, notify, client = new LimovaDeepAgentClient(), journal = createBrowserJournal(), createDriver, recordEvaluation = async () => { throw new Error('Studio evidence transport unavailable'); } }) {
  let context = null;
  let conversationId = null;
  let activeTurn = null;
  let evaluation = null;
  let contextQueue = Promise.resolve();

  async function save() {
    if (!context) return storage.remove(STORAGE_KEY);
    await storage.set({ [STORAGE_KEY]: { ...context, conversationId: evaluation ? evaluation.previousConversationId : conversationId } });
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
      evaluation = null;
      await save();
    } else {
      context = { userId: current.user.id, workspaceId: workspace.id };
      await journal.getSession(context);
      conversationId = conversationId ?? stored?.conversationId ?? null;
    }
    return { authenticated: true, ...current, context, conversationId, evaluationActive: Boolean(evaluation), activeTurnId: activeTurn?.id ?? null };
  }

  function requireContext() {
    if (!context) throw new Error('Sélectionne un espace Limova activé.');
    return { ...context };
  }

  async function recordAction(selectedConversation, action, receipt) {
    if (!evaluation || selectedConversation !== conversationId) throw new Error('Le test Studio a changé.');
    const event = projectEvaluationAction(action, receipt);
    if (!event) throw new Error('Preuve navigateur invalide.');
    const current = evaluation;
    const key = `action:${action.actionId}`;
    if (!current.evidence.has(key)) {
      if (current.evidence.size >= 1000) throw new Error('Limite de preuves Studio atteinte.');
      const pending = Promise.resolve().then(() => recordEvaluation(event, current.code));
      current.evidence.set(key, { payload: JSON.stringify(event), pending });
    }
    const saved = current.evidence.get(key);
    if (saved.payload !== JSON.stringify(event)) throw new Error('Preuves contradictoires pour cette action.');
    await saved.pending;
    return { ok: true };
  }

  async function recordResponse(selectedConversation, evidence) {
    if (!evidence) return;
    if (!evaluation || selectedConversation !== conversationId) throw new Error('Le test Studio a changé.');
    const current = evaluation;
    const key = `response:${evidence.id}`;
    if (!current.evidence.has(key)) {
      if (current.evidence.size >= 1000) throw new Error('Limite de preuves Studio atteinte.');
      const pending = Promise.resolve().then(() => recordEvaluation(evidence.event, current.code));
      current.evidence.set(key, { payload: JSON.stringify(evidence.event), pending });
    }
    await current.evidence.get(key).pending;
  }

  async function handle(request) {
    if (evaluation && ['LIMOVA_SELECT_WORKSPACE', 'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION'].includes(request.type)) {
      throw new Error('Termine le test Studio avant de changer de conversation ou d’espace.');
    }
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
          evaluation = null;
          await save();
          return { authenticated: false, workspaces: [], context: null, conversationId: null };
        }
      case 'LIMOVA_EVALUATION_RESPONSE':
        if (typeof request.messageId !== 'string' || !request.messageId || request.messageId.length > 256) throw new Error('Réponse Studio invalide.');
        await recordResponse(request.conversationId, { id: request.messageId, event: { kind: 'response', status: 'ok' } });
        return { ok: true };
      case 'LIMOVA_EVALUATION_ACTION':
        return recordAction(request.conversationId, request.action, request.receipt);
      case 'LIMOVA_FLUSH_EVALUATION':
        if (evaluation) {
          const current = evaluation;
          await Promise.all([...current.pendingTurns]);
          await Promise.all([...current.evidence.values()].map(entry => entry.pending));
        }
        return { ok: true };
      case 'LIMOVA_PREPARE_VOICE': {
        await state();
        const identity = requireContext();
        if (!conversationId || request.conversationId !== conversationId) throw new Error('La conversation vocale a changé.');
        return { context: identity, conversationId, ...(evaluation ? { evaluationCode: evaluation.code } : {}) };
      }
      case 'LIMOVA_START_EVALUATION': {
        if (evaluation) throw new Error('Un test Studio est déjà actif.');
        const code = evaluationGrant(request.evaluationCode);
        if (!code) throw new Error('Code de test Studio requis.');
        await state();
        const identity = requireContext();
        await cancel();
        const conversation = await client.createConversation(identity, 'Évaluation Studio', undefined, code);
        evaluation = { code, previousConversationId: conversationId, evidence: new Map(), pendingTurns: new Set() };
        conversationId = conversation.id;
        await save();
        return { ok: true, conversationId, context: identity, evaluationActive: true };
      }
      case 'LIMOVA_END_EVALUATION': {
        if (!evaluation) return { ok: true };
        const previous = evaluation.previousConversationId;
        try { await cancel(); } finally {
          evaluation = null;
          conversationId = previous;
          await save();
        }
        return { ok: true, conversationId };
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
        const turn = { id: crypto.randomUUID(), context: requireContext(), conversationId, evaluationCode: evaluation?.code, controller: new AbortController() };
        activeTurn = turn;
        const currentEvaluation = evaluation;
        let finish;
        const finished = new Promise(resolve => { finish = resolve; });
        currentEvaluation?.pendingTurns.add(finished);
        notify({ type: 'LIMOVA_TURN_STARTED', turnId: turn.id, conversationId });
        try {
          const responseEvidence = turn.evaluationCode
            ? createEvaluationResponseEvidence(await client.getMessages(turn.context, turn.conversationId, undefined, turn.controller.signal)) : null;
          turn.controller.signal.throwIfAborted();
          const emit = event => {
            responseEvidence?.consume(event);
            if (activeTurn === turn) notify({ type: 'LIMOVA_STREAM_EVENT', turnId: turn.id, conversationId: turn.conversationId, event });
          };
          if (request.browser === true) {
            if (!createDriver) throw new Error('Le pilote navigateur est indisponible.');
            const sessionId = await journal.getSession(turn.context);
            const driver = createDriver({ scope: { ...turn.context, sessionId }, journal, signal: turn.controller.signal,
              uploadScreenshot: (image, signal) => client.uploadBrowserScreenshot(turn.context, turn.conversationId, image, signal) });
            const runner = createBrowserTurnRunner({ client, journal, readPage: driver.readPage,
              execute: driver.execute, authorize: driver.authorize, notify: emit, evaluationCode: turn.evaluationCode,
              onActionResult: async (action, receipt) => {
                if (!turn.evaluationCode) return;
                if (evaluation?.code !== turn.evaluationCode) throw new Error('Le test Studio a changé.');
                await recordAction(turn.conversationId, action, receipt);
              } });
            const outcome = request.type === 'LIMOVA_RESUME_BROWSER'
              ? await runner.resume(turn.context, turn.conversationId, turn.controller.signal)
              : await runner.send(turn.context, turn.conversationId, request.text, turn.controller.signal);
            turn.controller.signal.throwIfAborted();
            await recordResponse(turn.conversationId, responseEvidence?.finish());
            notify({ type: 'LIMOVA_BROWSER_STATE', turnId: turn.id, conversationId: turn.conversationId, state: outcome.state, actionId: outcome.actionId, browserTurnId: outcome.turnId });
            return { ok: true, turnId: turn.id, browserState: outcome.state };
          }
          for await (const event of client.sendMessage(turn.context, turn.conversationId, request.text, turn.controller.signal, undefined, turn.evaluationCode)) {
            if (activeTurn !== turn) break;
            emit(event);
          }
          turn.controller.signal.throwIfAborted();
          await recordResponse(turn.conversationId, responseEvidence?.finish());
          return { ok: true, turnId: turn.id };
        } catch (error) {
          if (activeTurn === turn && ['LIMOVA_ACCOUNT_CHANGED', 'LIMOVA_LOGIN_REQUIRED', 'LIMOVA_EXTENSION_DISABLED'].includes(error.code)) {
            await journal.clearAccount(turn.context.userId);
            context = null;
            conversationId = null;
            evaluation = null;
            await save();
            notify({ type: 'LIMOVA_SESSION_CHANGED' });
          }
          throw error;
        } finally {
          finish();
          currentEvaluation?.pendingTurns.delete(finished);
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
          evaluation = null;
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
    if (['LIMOVA_GET_STATE', 'LIMOVA_SELECT_WORKSPACE', 'LIMOVA_CREATE_CONVERSATION', 'LIMOVA_OPEN_CONVERSATION', 'LIMOVA_LOGOUT', 'LIMOVA_START_EVALUATION', 'LIMOVA_END_EVALUATION'].includes(request.type)) {
      const operation = contextQueue.then(() => handle(request));
      contextQueue = operation.catch(() => {});
      return operation;
    }
    if (request.type === 'LIMOVA_CANCEL') return handle(request);
    return contextQueue.then(() => handle(request));
  } };
}
