const crypto = require('node:crypto');
const {
  Gemini,
  LlmAgent,
  LlmSummarizer,
  Runner,
  TokenBasedContextCompactor,
  getFunctionCalls,
  isFinalResponse
} = require('@google/adk');
const { CLIENT_TOOL_NAMES, publicToolResult, sanitizeToolResult } = require('./contracts');
const { APP_NAME, CharlyMemoryService, CharlySessionService } = require('./services');
const { createCharlyTools } = require('./tools');

const MAX_ACTIONS_PER_TURN = 6;
const RUN_TTL_MS = 10 * 60_000;

function textFromEvent(event) {
  return (event?.content?.parts || []).map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
}

function stablePercentage(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest().readUInt32BE(0) % 100;
}

function modeAllowsUser(mode, canaryPercent, userKey) {
  if (mode === 'on') return true;
  if (mode !== 'canary') return false;
  return stablePercentage(userKey) < Math.max(0, Math.min(100, canaryPercent));
}

function responseSimilarity(first, second) {
  const words = value => new Set(String(value || '').toLocaleLowerCase('fr')
    .match(/[\p{L}\p{N}]{4,}/gu) || []);
  const a = words(first);
  const b = words(second);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return Math.round((intersection / new Set([...a, ...b]).size) * 1_000) / 1_000;
}

function technicalErrorCode(error) {
  const rawCode = String(error?.code || '');
  if (/^[A-Z0-9_:-]{1,80}$/i.test(rawCode)) return rawCode;
  const rawName = String(error?.name || '');
  return /^[A-Z][A-Z0-9_]{0,79}$/i.test(rawName) ? rawName : 'unknown';
}

class CharlyAdkOrchestrator {
  constructor({
    apiKey,
    modelName,
    promptBundle,
    memoryRequest,
    searchKnowledge,
    mode = 'off',
    canaryPercent = 0
  }) {
    this.promptBundle = promptBundle;
    this.memoryRequest = memoryRequest;
    this.mode = ['off', 'shadow', 'canary', 'on'].includes(mode) ? mode : 'off';
    this.canaryPercent = Number(canaryPercent) || 0;
    this.runs = new Map();
    this.completedRuns = new Map();
    this.idempotency = new Map();
    this.inflightTurns = new Map();
    this.inflightRuns = new Map();
    const model = new Gemini({ model: modelName, apiKey, vertexai: false });
    this.sessionService = new CharlySessionService({ memoryRequest, promptRevision: promptBundle.revision });
    this.memoryService = new CharlyMemoryService({ memoryRequest });
    this.contextCompactor = new TokenBasedContextCompactor({
      tokenThreshold: 32_000,
      eventRetentionSize: 24,
      summarizer: new LlmSummarizer({ llm: model })
    });
    const dynamicInstruction = context => {
      const personal = String(context.state.get('temp:personalContext', '') || '').slice(0, 18_000);
      const page = String(context.state.get('temp:pageContext', '') || '').slice(0, 80_000);
      const locale = String(context.state.get('temp:locale', 'fr-FR') || 'fr-FR');
      const evaluation = String(context.state.get('temp:evaluationContext', '') || '').slice(0, 70_000);
      return [
        promptBundle.content,
        'RÈGLES D’ORCHESTRATION ADK',
        '- Utilise uniquement les outils typés. N’émets jamais de marqueur {{ACTION}} ou {{HIGHLIGHT}}.',
        '- Six actions au maximum par tour. Après un échec, rafraîchis le contexte et ne tente qu’une seule récupération.',
        '- Ne prétends jamais qu’une action a réussi avant verify_expected_result.',
        '- Demande une clarification si plusieurs cibles restent plausibles.',
        `Langue de réponse: ${locale}.`,
        personal ? `CONTEXTE PERSONNEL PRIVÉ\n${personal}` : '',
        evaluation ? `MODE TEST RÉEL — BROUILLON ISOLÉ\nUtilise prioritairement ce parcours non publié. Agis réellement dans Limova, vérifie chaque résultat et ne mémorise rien de cette session.\n${evaluation}` : '',
        page ? `ÉTAT TEMPORAIRE DE LA PAGE — ne jamais mémoriser ce contenu\n${page}` : ''
      ].filter(Boolean).join('\n\n');
    };
    this.agent = new LlmAgent({
      name: APP_NAME,
      description: 'Copilote d’onboarding Limova',
      model,
      instruction: dynamicInstruction,
      tools: createCharlyTools({ searchKnowledge }),
      generateContentConfig: { temperature: 0.3, maxOutputTokens: 2_048 },
      contextCompactors: [this.contextCompactor]
    });
    this.runner = new Runner({
      appName: APP_NAME,
      agent: this.agent,
      sessionService: this.sessionService,
      memoryService: this.memoryService
    });
  }

  enabledFor(userKey) {
    return modeAllowsUser(this.mode, this.canaryPercent, userKey);
  }

  serverOrchestrationFor(userKey) {
    return this.enabledFor(userKey);
  }

  async shadow(userKey, { message, pageContext = '', locale = 'fr-FR', legacyResponse = '' }, requestId = crypto.randomUUID()) {
    if (this.mode !== 'shadow' || !message) return null;
    const startedAt = Date.now();
    let responseType = 'empty';
    let shadowResponse = '';
    const tools = [];
    try {
      for await (const event of this.runner.runEphemeral({
        userId: userKey,
        newMessage: { role: 'user', parts: [{ text: String(message).slice(0, 8_000) }] },
        stateDelta: {
          'temp:personalContext': '',
          'temp:pageContext': String(pageContext).slice(0, 80_000),
          'temp:locale': locale
        },
        customMetadata: { requestId, shadow: true, promptRevision: this.promptBundle.revision }
      })) {
        const calls = getFunctionCalls(event);
        if (calls.length) {
          responseType = 'tool_call';
          tools.push(...calls.map(call => call.name).filter(Boolean));
        } else if (textFromEvent(event)) {
          responseType = 'message';
          shadowResponse = textFromEvent(event);
        }
      }
      console.info(JSON.stringify({
        type: 'adk_shadow', requestId, responseType, tools: [...new Set(tools)].slice(0, 6),
        responseSimilarity: responseSimilarity(legacyResponse, shadowResponse),
        promptRevision: this.promptBundle.revision, latencyMs: Date.now() - startedAt
      }));
      return { responseType, tools };
    } catch (error) {
      console.error(JSON.stringify({ type: 'adk_shadow_error', requestId, code: technicalErrorCode(error), latencyMs: Date.now() - startedAt }));
      return null;
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.expiresAtMs > now) continue;
      if (run.expiryTimer) clearTimeout(run.expiryTimer);
      this.scrubEphemeralSession(run.userKey, run.sessionId);
      this.runs.delete(id);
      this.memoryRequest('/api/internal/memory/runs', {
        body: { action: 'complete', userKey: run.userKey, runId: id, status: 'interrupted', errorCode: 'run_expired' },
        requestId: run.requestId
      }).catch(() => null);
    }
    for (const [id, run] of this.completedRuns) if (run.expiresAtMs <= now) this.completedRuns.delete(id);
    for (const [key, entry] of this.idempotency) if (entry.expiresAtMs <= now) this.idempotency.delete(key);
  }

  scrubEphemeralSession(userKey, sessionId) {
    const session = this.sessionService.sessions.get(this.sessionService.key(userKey, sessionId));
    if (!session) return;
    for (const event of session.events) {
      if (!Array.isArray(event?.content?.parts)) continue;
      event.content.parts = event.content.parts.flatMap(part => {
        if (part.inlineData) return [];
        if (part.functionCall) {
          const args = part.functionCall.args || {};
          return [{ functionCall: {
            id: part.functionCall.id,
            name: part.functionCall.name,
            args: {
              ...(Number.isInteger(args.elementId) ? { elementId: args.elementId } : {}),
              ...(Number.isInteger(args.contextVersion) ? { contextVersion: args.contextVersion } : {})
            }
          } }];
        }
        if (part.functionResponse) {
          const response = part.functionResponse.response || {};
          return [{ functionResponse: {
            id: part.functionResponse.id,
            name: part.functionResponse.name,
            response: {
              status: response.status,
              contextVersion: response.contextVersion,
              ...(response.message ? { message: String(response.message).slice(0, 500) } : {})
            }
          } }];
        }
        return [part];
      });
    }
  }

  async openSession(userKey, input = {}) {
    const result = await this.memoryRequest('/api/internal/memory/sessions', {
      body: {
        userKey,
        action: 'open',
        ...(input.previousSessionId ? { previousSessionId: input.previousSessionId } : {}),
        closePrevious: input.closePrevious === true,
        promptRevision: this.promptBundle.revision
      }
    });
    if (!result?.response?.ok || !result.data?.id) throw new Error('SESSION_OPEN_FAILED');
    if (input.previousSessionId && input.closePrevious) {
      this.sessionService.sessions.delete(this.sessionService.key(userKey, input.previousSessionId));
    }
    return result.data;
  }

  async personalContext(userKey, query, sessionId, requestId) {
    const result = await this.memoryRequest('/api/internal/memory/bootstrap', {
      body: { userKey, query: String(query || '').slice(0, 2_000), sessionId },
      requestId
    });
    return result?.response?.ok ? result.data : null;
  }

  async persistMessage(userKey, input) {
    const result = await this.memoryRequest('/api/internal/memory/turns', {
      body: {
        userKey,
        sessionId: input.sessionId,
        ...(input.role === 'assistant' ? { assistant: input.content } : { user: input.content }),
        source: input.source || 'text',
        idempotencyKey: input.idempotencyKey,
        ...(input.adkEventId ? { adkEventId: input.adkEventId } : {}),
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        finalStatus: input.finalStatus || 'completed'
      },
      requestId: input.requestId,
      timeoutMs: 12_000
    });
    if (result && !result.response.ok) throw new Error('MEMORY_WRITE_FAILED');
    return result?.data || { ok: true, stored: 0, available: false };
  }

  async consumeEvents({ userKey, sessionId, message, stateDelta, requestId, actionCount = 0, recoveryCount = 0, evaluationContext = null }) {
    let finalText = '';
    let finalEvent = null;
    let pendingCall = null;
    for await (const event of this.runner.runAsync({
      userId: userKey,
      sessionId,
      newMessage: message,
      stateDelta,
      customMetadata: { requestId, promptRevision: this.promptBundle.revision }
    })) {
      const calls = getFunctionCalls(event).filter(call => CLIENT_TOOL_NAMES.has(call.name));
      if (calls.length) {
        pendingCall = calls[0];
        finalEvent = event;
        break;
      }
      const text = textFromEvent(event);
      if (text) finalText = text;
      if (isFinalResponse(event)) finalEvent = event;
    }
    if (pendingCall) {
      if (actionCount >= MAX_ACTIONS_PER_TURN) {
        return { type: 'message', sessionId, content: 'Je me suis arrêtée pour éviter une boucle d’actions. Dis-moi quelle étape tu veux faire maintenant.' };
      }
      return this.createPendingRun({ userKey, sessionId, call: pendingCall, requestId, actionCount: actionCount + 1, recoveryCount, event: finalEvent, evaluationContext });
    }
    if (!finalText) throw new Error('ADK_EMPTY_RESPONSE');
    return {
      type: 'message',
      sessionId,
      content: finalText,
      eventId: finalEvent?.id,
      invocationId: finalEvent?.invocationId
    };
  }

  async createPendingRun({ userKey, sessionId, call, requestId, actionCount, recoveryCount, event, evaluationContext = null }) {
    const runId = crypto.randomUUID();
    const expiresAtMs = Date.now() + RUN_TTL_MS;
    const run = {
      runId,
      userKey,
      sessionId,
      callId: call.id,
      callName: call.name,
      callArgs: call.args || {},
      requestId,
      actionCount,
      recoveryCount,
      eventId: event?.id,
      invocationId: event?.invocationId,
      expiresAtMs,
      evaluationContext
    };
    run.expiryTimer = setTimeout(() => {
      if (this.runs.get(runId) !== run) return;
      this.scrubEphemeralSession(userKey, sessionId);
      this.runs.delete(runId);
      if (!run.evaluationContext) this.memoryRequest('/api/internal/memory/runs', {
        body: { action: 'complete', userKey, runId, status: 'interrupted', errorCode: 'run_expired' },
        requestId
      }).catch(() => null);
    }, RUN_TTL_MS);
    run.expiryTimer.unref?.();
    this.runs.set(runId, run);
    if (!evaluationContext) await this.memoryRequest('/api/internal/memory/runs', {
      body: {
        action: 'create', userKey, runId, sessionId, callId: call.id, toolName: call.name,
        contextVersion: Number(call.args?.contextVersion) || 0,
        actionCount, recoveryCount, promptRevision: this.promptBundle.revision
      }, requestId
    }).catch(() => null);
    console.info(JSON.stringify({ type: 'adk_tool_call', requestId, runId, tool: call.name, actionCount, promptRevision: this.promptBundle.revision }));
    return {
      type: 'tool_call',
      sessionId,
      runId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      call: { id: call.id, name: call.name, args: call.args || {} }
    };
  }

  async turn(userKey, input, requestId = crypto.randomUUID()) {
    this.cleanup();
    const dedupeKey = `${userKey}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(dedupeKey);
    if (existing) return existing.response;
    const inflight = this.inflightTurns.get(dedupeKey);
    if (inflight) return inflight;
    const promise = this._turnInternal(userKey, input, requestId)
      .then(response => {
        this.idempotency.set(dedupeKey, { response, expiresAtMs: Date.now() + RUN_TTL_MS });
        return response;
      })
      .finally(() => this.inflightTurns.delete(dedupeKey));
    this.inflightTurns.set(dedupeKey, promise);
    return promise;
  }

  async _turnInternal(userKey, input, requestId) {
    const evaluationContext = input.evaluationContext || null;
    const persistedRun = evaluationContext ? null : await this.memoryRequest('/api/internal/memory/runs', {
      body: { action: 'active', userKey, sessionId: input.sessionId },
      requestId
    }).catch(() => null);
    const activeRun = persistedRun?.response?.ok ? persistedRun.data?.run : null;
    if (activeRun) {
      if (!this.runs.has(activeRun.id)) {
        await this.memoryRequest('/api/internal/memory/runs', {
          body: { action: 'complete', userKey, runId: activeRun.id, status: 'interrupted', errorCode: 'proxy_restarted' },
          requestId
        }).catch(() => null);
        return {
          type: 'message',
          sessionId: input.sessionId,
          content: 'Le précédent geste a été interrompu avant sa vérification. J’ai relu le contexte : demande-moi de reprendre et je repartirai sans rejouer automatiquement le clic.'
        };
      }
      return {
        type: 'message',
        sessionId: input.sessionId,
        content: 'Je termine encore l’action précédente. Attends son résultat avant de me demander une nouvelle étape.'
      };
    }
    await this.sessionService.getOrCreateSession({ appName: APP_NAME, userId: userKey, sessionId: input.sessionId });
    if (!evaluationContext) await this.persistMessage(userKey, {
      sessionId: input.sessionId,
      role: 'user',
      content: input.message,
      source: 'text',
      idempotencyKey: `${input.idempotencyKey}:user`,
      requestId
    });
    const memory = evaluationContext ? null : await this.personalContext(userKey, input.message, input.sessionId, requestId);
    const response = await this.consumeEvents({
      userKey,
      sessionId: input.sessionId,
      message: { role: 'user', parts: [{ text: input.message }] },
      stateDelta: {
        'temp:personalContext': memory?.context || '',
        'temp:pageContext': JSON.stringify(input.page),
        'temp:locale': input.locale,
        ...(evaluationContext ? { 'temp:evaluationContext': evaluationContext.context } : {}),
        ...(input.onboarding?.revision ? { onboardingRevision: input.onboarding.revision } : {}),
        ...(input.onboarding?.activeStep ? { onboardingStep: input.onboarding.activeStep } : {}),
        ...(input.onboarding?.completedSteps ? { completedOnboardingSteps: input.onboarding.completedSteps } : {})
      },
      requestId,
      evaluationContext
    });
    if (response.type === 'message') {
      if (!evaluationContext) await this.persistMessage(userKey, {
        sessionId: input.sessionId,
        role: 'assistant',
        content: response.content,
        source: 'text',
        idempotencyKey: `${input.idempotencyKey}:assistant`,
        adkEventId: response.eventId,
        invocationId: response.invocationId,
        requestId
      });
      delete response.eventId;
      delete response.invocationId;
      this.scrubEphemeralSession(userKey, input.sessionId);
    }
    return response;
  }

  async resume(userKey, runId, rawResult, requestId = crypto.randomUUID()) {
    this.cleanup();
    const replay = this.completedRuns.get(runId);
    if (replay?.userKey === userKey && replay.callId === rawResult?.callId) return replay.response;
    const inflight = this.inflightRuns.get(runId);
    if (inflight) {
      const active = this.runs.get(runId);
      if (active?.userKey !== userKey || active?.callId !== rawResult?.callId) {
        const error = new Error('CALL_ID_MISMATCH');
        error.status = 409;
        throw error;
      }
      return inflight;
    }
    const promise = this._resumeInternal(userKey, runId, rawResult, requestId)
      .finally(() => this.inflightRuns.delete(runId));
    this.inflightRuns.set(runId, promise);
    return promise;
  }

  async _resumeInternal(userKey, runId, rawResult, requestId) {
    const run = this.runs.get(runId);
    if (!run || run.userKey !== userKey || run.expiresAtMs <= Date.now()) {
      const error = new Error('RUN_EXPIRED');
      error.status = 410;
      throw error;
    }
    const result = sanitizeToolResult(rawResult);
    if (result.callId !== run.callId) {
      const error = new Error('CALL_ID_MISMATCH');
      error.status = 409;
      throw error;
    }
    const recoveryStatus = ['not_found', 'ambiguous', 'unexpected'].includes(result.status);
    const usedRecoveryCapture = Boolean(result.capture) && (recoveryStatus || run.callName === 'capture_current_view');
    const recoveryCount = run.recoveryCount + (usedRecoveryCapture ? 1 : 0);
    if (recoveryCount > 1) {
      const error = new Error('RECOVERY_LIMIT_REACHED');
      error.status = 409;
      throw error;
    }
    this.runs.delete(runId);
    if (run.expiryTimer) clearTimeout(run.expiryTimer);
    if (!run.evaluationContext) await this.memoryRequest('/api/internal/memory/runs', {
      body: { action: 'complete', userKey, runId, status: result.status === 'ok' ? 'completed' : 'failed', errorCode: result.status === 'ok' ? undefined : result.status },
      requestId
    }).catch(() => null);
    const parts = [{
      functionResponse: {
        id: run.callId,
        name: run.callName,
        response: publicToolResult(result)
      }
    }];
    if (result.capture) parts.push({ inlineData: result.capture });
    const response = await this.consumeEvents({
      userKey,
      sessionId: run.sessionId,
      message: { role: 'user', parts },
      stateDelta: {
        'temp:pageContext': result.page ? JSON.stringify(result.page) : '',
        'temp:locale': 'fr-FR',
        ...(run.evaluationContext ? { 'temp:evaluationContext': run.evaluationContext.context } : {})
      },
      requestId,
      actionCount: run.actionCount,
      recoveryCount,
      evaluationContext: run.evaluationContext
    });
    if (response.type === 'message') {
      if (!run.evaluationContext) await this.persistMessage(userKey, {
        sessionId: run.sessionId,
        role: 'assistant',
        content: response.content,
        source: 'text',
        idempotencyKey: `run:${runId}:assistant`,
        adkEventId: response.eventId,
        invocationId: response.invocationId,
        requestId
      });
      delete response.eventId;
      delete response.invocationId;
      this.scrubEphemeralSession(userKey, run.sessionId);
    }
    this.completedRuns.set(runId, {
      userKey,
      callId: run.callId,
      response,
      expiresAtMs: Date.now() + RUN_TTL_MS
    });
    return response;
  }
}

module.exports = { CharlyAdkOrchestrator, MAX_ACTIONS_PER_TURN, RUN_TTL_MS, modeAllowsUser, responseSimilarity, stablePercentage };
