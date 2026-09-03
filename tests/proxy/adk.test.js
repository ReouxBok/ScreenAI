import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));

let contracts;
let createCharlyTools;
let orchestratorModule;
let loadPromptBundle;

beforeAll(() => {
  contracts = requireFromProxy('./copilot/contracts.js');
  ({ createCharlyTools } = requireFromProxy('./copilot/tools.js'));
  orchestratorModule = requireFromProxy('./copilot/orchestrator.js');
  ({ loadPromptBundle } = requireFromProxy('./copilot/prompt.js'));
});

describe('Google ADK contracts', () => {
  it('accepts only the server-owned v2 turn contract', () => {
    const valid = {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      message: 'Connecte Gmail',
      source: 'text',
      locale: 'fr-FR',
      idempotencyKey: 'turn-test-123',
      page: { url: 'https://new.limova.ai/integrations', title: 'Intégrations', contextVersion: 4, dom: '[1] Gmail' }
    };
    expect(contracts.turnSchema.safeParse(valid).success).toBe(true);
    expect(contracts.turnSchema.safeParse({ ...valid, model: 'other-model' }).success).toBe(false);
    expect(contracts.turnSchema.safeParse({ ...valid, source: 'voice' }).success).toBe(false);
  });

  it('never exposes an arbitrary URL in navigate_internal', () => {
    const tools = createCharlyTools({ searchKnowledge: async () => ({ results: [] }) });
    const declarations = Object.fromEntries(tools.map(tool => [tool.name, tool._getDeclaration()]));
    expect(declarations.navigate_internal.parameters.properties).toHaveProperty('elementId');
    expect(declarations.navigate_internal.parameters.properties).toHaveProperty('contextVersion');
    expect(declarations.navigate_internal.parameters.properties).not.toHaveProperty('url');
    expect(declarations.fill_field.parameters.properties).toHaveProperty('text');
    expect(declarations.scroll_page.parameters.properties.direction.enum).toEqual(['up', 'down', 'top', 'bottom']);
    expect(declarations.scroll_page.parameters.properties).not.toHaveProperty('coordinates');
    expect(JSON.stringify(Object.values(declarations))).not.toContain('exclusiveMinimum');
    expect(tools.filter(tool => tool.name !== 'search_knowledge_base').every(tool => tool.isLongRunning)).toBe(true);
  });

  it('validates and then strips captures from the persisted tool result shape', () => {
    const parsed = contracts.sanitizeToolResult({
      callId: 'call-1', status: 'unexpected', contextVersion: 8,
      page: { url: 'https://new.limova.ai/', title: 'Accueil', contextVersion: 8, dom: '[1] Accueil' },
      capture: { mimeType: 'image/jpeg', data: 'QUJDRA==' }
    });
    expect(parsed.capture.data).toBe('QUJDRA==');
    expect(contracts.publicToolResult(parsed)).not.toHaveProperty('capture');
  });
});

describe('CharlySessionService adapter', () => {
  it('creates, reads, updates, lists and closes an ADK session through the private memory API', async () => {
    const { createEvent } = requireFromProxy('@google/adk');
    const { CharlySessionService } = requireFromProxy('./copilot/services.js');
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const memoryRequest = vi.fn(async (_path, options) => {
      const action = options.body.action;
      if (action === 'open') return { response: { ok: true }, data: { id: sessionId, status: 'active', lastUpdateTime: Date.now() } };
      return { response: { ok: true }, data: { ok: true } };
    });
    const service = new CharlySessionService({ memoryRequest, promptRevision: 'prompt_test' });
    const session = await service.createSession({ appName: 'charly_copilot', userId: 'user-1', sessionId, state: { onboardingStep: 'start' } });
    expect(await service.getSession({ appName: 'charly_copilot', userId: 'user-1', sessionId })).toBe(session);
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation-1',
        author: 'charly_copilot',
        content: { role: 'model', parts: [{ text: 'Étape suivante' }] },
        actions: { stateDelta: { onboardingStep: 'gmail' } }
      })
    });
    const listed = await service.listSessions({ appName: 'charly_copilot', userId: 'user-1' });
    expect(listed.sessions).toEqual([session]);
    await service.deleteSession({ appName: 'charly_copilot', userId: 'user-1', sessionId });
    expect(memoryRequest.mock.calls.map(call => call[1].body.action)).toEqual(['open', 'update_state', 'close']);
  });

  it('never persists the isolated draft or state of a real-condition evaluation', async () => {
    const { createEvent } = requireFromProxy('@google/adk');
    const { CharlySessionService } = requireFromProxy('./copilot/services.js');
    const sessionId = '650e8400-e29b-41d4-a716-446655440000';
    const memoryRequest = vi.fn(async () => ({ response: { ok: true }, data: { id: sessionId, status: 'active' } }));
    const service = new CharlySessionService({ memoryRequest, promptRevision: 'prompt_test' });
    const session = await service.createSession({ appName: 'charly_copilot', userId: 'user-eval', sessionId, state: {} });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'evaluation-invocation',
        author: 'user',
        content: { role: 'user', parts: [{ text: 'Teste ce parcours' }] },
        actions: { stateDelta: { 'temp:evaluationContext': '{"draft":"private"}', 'temp:pageContext': '{"dom":"private"}' } }
      })
    });
    expect(memoryRequest.mock.calls.map(call => call[1].body.action)).toEqual(['open']);
  });
});

describe('ADK rollout and prompt revisions', () => {
  it('persists each v2 message under the authenticated memory identity', async () => {
    const { CharlyAdkOrchestrator } = orchestratorModule;
    const instance = Object.create(CharlyAdkOrchestrator.prototype);
    instance.memoryRequest = vi.fn(async () => ({ response: { ok: true }, data: { ok: true, stored: 1 } }));
    await instance.persistMessage('v1:test-user', {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'user',
      content: 'Bonjour',
      idempotencyKey: 'turn-test:user',
      requestId: 'request-test'
    });
    expect(instance.memoryRequest).toHaveBeenCalledWith('/api/internal/memory/turns', expect.objectContaining({
      body: expect.objectContaining({
        userKey: 'v1:test-user',
        user: 'Bonjour',
        sessionId: '550e8400-e29b-41d4-a716-446655440000'
      })
    }));
  });

  it('selects canaries deterministically without changing provider', () => {
    const { modeAllowsUser, responseSimilarity, stablePercentage } = orchestratorModule;
    expect(stablePercentage('user-a')).toBe(stablePercentage('user-a'));
    expect(modeAllowsUser('off', 100, 'user-a')).toBe(false);
    expect(modeAllowsUser('on', 0, 'user-a')).toBe(true);
    expect(modeAllowsUser('canary', 100, 'user-a')).toBe(true);
    expect(modeAllowsUser('canary', 0, 'user-a')).toBe(false);
    expect(responseSimilarity('Connecte ton compte Gmail', 'Tu peux connecter Gmail maintenant')).toBeGreaterThan(0);
  });

  it('coalesces duplicate in-flight turns before an action can be planned twice', async () => {
    const { CharlyAdkOrchestrator } = orchestratorModule;
    const instance = Object.create(CharlyAdkOrchestrator.prototype);
    instance.runs = new Map();
    instance.completedRuns = new Map();
    instance.idempotency = new Map();
    instance.inflightTurns = new Map();
    instance.inflightRuns = new Map();
    instance._turnInternal = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { type: 'message', sessionId: 's', content: 'ok' };
    });
    const input = { idempotencyKey: 'same-turn' };
    const [first, second] = await Promise.all([
      instance.turn('user', input, 'request-1'),
      instance.turn('user', input, 'request-2')
    ]);
    expect(first).toEqual(second);
    expect(instance._turnInternal).toHaveBeenCalledTimes(1);
    expect(await instance.turn('user', input, 'request-3')).toEqual(first);
    expect(instance._turnInternal).toHaveBeenCalledTimes(1);
  });

  it('interrupts a persisted orphan run after a proxy restart instead of planning a second click', async () => {
    const { CharlyAdkOrchestrator } = orchestratorModule;
    const instance = Object.create(CharlyAdkOrchestrator.prototype);
    instance.runs = new Map();
    instance.memoryRequest = vi.fn(async (_path, options) => {
      if (options.body.action === 'active') {
        return { response: { ok: true }, data: { run: { id: 'bb0e8400-e29b-41d4-a716-446655440000', toolName: 'click_element' } } };
      }
      return { response: { ok: true }, data: { ok: true } };
    });
    instance.sessionService = { getOrCreateSession: vi.fn() };
    const response = await instance._turnInternal('user', {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      message: 'Fais-le'
    }, 'request-restart');
    expect(response.content).toContain('sans rejouer automatiquement le clic');
    expect(instance.sessionService.getOrCreateSession).not.toHaveBeenCalled();
    expect(instance.memoryRequest).toHaveBeenLastCalledWith('/api/internal/memory/runs', expect.objectContaining({
      body: expect.objectContaining({ action: 'complete', status: 'interrupted', errorCode: 'proxy_restarted' })
    }));
  });

  it('creates a stable revision from all five server-side prompt files', () => {
    const first = loadPromptBundle(path.join(proxyDir, 'prompts'));
    const second = loadPromptBundle(path.join(proxyDir, 'prompts'));
    expect(first.revision).toBe(second.revision);
    expect(first.files).toEqual(['IDENTITY.md', 'SOUL.md', 'AGENT.md', 'TOOLS.md', 'MEMORY_POLICY.md']);
    expect(first.content).toContain('# MEMORY_POLICY.md');
  });

  it('pins the ADK compactor to 32k tokens and 24 retained events', () => {
    const promptBundle = loadPromptBundle(path.join(proxyDir, 'prompts'));
    const instance = new orchestratorModule.CharlyAdkOrchestrator({
      apiKey: 'test-key',
      modelName: 'gemini-3.6-flash',
      promptBundle,
      memoryRequest: async () => null,
      searchKnowledge: async () => ({ results: [] }),
      mode: 'off'
    });
    const compactor = instance.contextCompactor;
    expect(compactor.tokenThreshold).toBe(32_000);
    expect(compactor.eventRetentionSize).toBe(24);
    expect(instance.agent.model.model).toBe('gemini-3.6-flash');
  });

  it('keeps 200 short events intact and compacts a 1,000-event conversation', async () => {
    const { TokenBasedContextCompactor, createEvent } = requireFromProxy('@google/adk');
    const summarize = vi.fn(async events => ({
      ...createEvent({
        author: 'charly_copilot',
        content: { role: 'model', parts: [{ text: 'Objectif conservé : connecter Gmail.' }] }
      }),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: events.at(-1).timestamp,
      compactedContent: 'Objectif conservé : connecter Gmail.'
    }));
    const compactor = new TokenBasedContextCompactor({ tokenThreshold: 32_000, eventRetentionSize: 24, summarizer: { summarize } });
    const makeEvents = (count, size) => Array.from({ length: count }, (_, index) => createEvent({
      author: index % 2 ? 'charly_copilot' : 'user',
      timestamp: index + 1,
      content: { role: index % 2 ? 'model' : 'user', parts: [{ text: `${index}:${'x'.repeat(size)}` }] }
    }));
    const context = events => ({ session: { events }, agent: { name: 'charly_copilot' }, branch: undefined });
    const shortEvents = makeEvents(200, 80);
    expect(compactor.shouldCompact(context(shortEvents))).toBe(false);
    expect(shortEvents).toHaveLength(200);

    const longEvents = makeEvents(1_000, 160);
    expect(compactor.shouldCompact(context(longEvents))).toBe(true);
    await compactor.compact(context(longEvents));
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0].length).toBe(976);
    expect(longEvents.at(-1)).toMatchObject({ isCompacted: true, compactedContent: expect.stringContaining('Objectif conservé') });
  });
});
