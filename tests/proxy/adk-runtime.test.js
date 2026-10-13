import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const requireProxy = createRequire(new URL('../../proxy/package.json', import.meta.url));
const { BaseLlm } = requireProxy('@google/adk');
const { CharlyAdkOrchestrator } = requireProxy('./copilot/orchestrator.js');
const sessionId = '550e8400-e29b-41d4-a716-446655440000';

describe('installed ADK runner compatibility', () => {
  it('pauses for a browser result, resumes the same call and deduplicates delivery', async () => {
    const requests = [];
    class ScriptedModel extends BaseLlm {
      constructor() { super({ model: 'local-compatibility-test' }); }
      async *generateContentAsync(request) {
        requests.push(structuredClone(request.contents));
        if (requests.length === 1) {
          yield { content: { role: 'model', parts: [{ functionCall: {
            id: 'browser-call', name: 'inspect_current_page', args: { reason: 'Check the page' }
          } }] } };
        } else {
          yield { content: { role: 'model', parts: [{ text: 'Page verified.' }] } };
        }
      }
    }
    const memoryRequest = vi.fn(async (_path, { body }) => ({
      response: { ok: true },
      data: body.action === 'open' ? { id: sessionId, status: 'active' } : { ok: true }
    }));
    const instance = new CharlyAdkOrchestrator({
      apiKey: 'unused-test-key', modelName: 'gemini-test',
      promptBundle: { content: 'Use the provided tools.', revision: 'test-revision' },
      memoryRequest, searchKnowledge: async () => ({ results: [] }), mode: 'on'
    });
    instance.agent.model = new ScriptedModel();
    try {
      const input = {
        sessionId, message: 'Inspect this page', locale: 'fr-FR', idempotencyKey: 'runtime-turn',
        page: { url: 'https://new.limova.ai/', title: 'Limova', contextVersion: 1, dom: '[1] Accueil' }
      };
      const pending = await instance.turn('runtime-user', input, 'runtime-request');
      expect(pending).toMatchObject({ type: 'tool_call', sessionId, call: { id: 'browser-call', name: 'inspect_current_page' } });
      expect(requests).toHaveLength(1);
      expect(await instance.turn('runtime-user', input, 'retry-request')).toEqual(pending);
      const result = { callId: 'browser-call', status: 'ok', contextVersion: 1, page: input.page };
      const completed = await instance.resume('runtime-user', pending.runId, result, 'resume-request');
      expect(completed).toEqual({ type: 'message', sessionId, content: 'Page verified.' });
      expect(requests).toHaveLength(2);
      const parts = requests[1].flatMap(content => content.parts || []);
      expect(parts.filter(part => part.functionCall?.id === 'browser-call')).toHaveLength(1);
      expect(parts.filter(part => part.functionResponse?.id === 'browser-call')).toHaveLength(1);
      expect(await instance.resume('runtime-user', pending.runId, result, 'retry-result')).toEqual(completed);
      expect(requests).toHaveLength(2);
      const writes = memoryRequest.mock.calls.filter(([route]) => route.endsWith('/turns'));
      expect(writes.map(([, options]) => options.body.user || options.body.assistant)).toEqual(['Inspect this page', 'Page verified.']);
    } finally {
      for (const run of instance.runs.values()) clearTimeout(run.expiryTimer);
    }
  });
});
