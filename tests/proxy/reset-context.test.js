import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireProxy = createRequire(path.resolve('proxy/package.json'));
let app, supertest;
const OLD_CONTEXT = 'OBJECTIFS OUVERTS : Reprendre notre audit SEO';

beforeAll(async () => {
  Object.assign(process.env, {
    EXTENSION_GEMINI_API_KEY: 'test-key', ALLOWED_EXTENSION_ID: 'test',
    MEMORY_API_URL: 'https://memory.example', MEMORY_SERVICE_TOKEN: 'm'.repeat(40),
    MEMORY_IDENTITY_SECRET_V1: 'test-memory-identity-secret-long-enough',
    KNOWLEDGE_API_URL: '', KNOWLEDGE_SERVICE_TOKEN: ''
  });
  app = requireProxy('./index.js');
  supertest = (await import('supertest')).default;
});
beforeEach(() => {
  globalThis.fetch = vi.fn(async url => ({
    ok: true, status: 200, json: async () => String(url).includes('/memory/bootstrap')
      ? { enabled: true, context: OLD_CONTEXT }
      : { name: 'authTokens/test', candidates: [{ content: { parts: [{ text: 'Bonjour.' }] } }] }
  }));
});

describe('reset memory isolation in the proxy', () => {
  it('keeps voice memory after an explicit reset and marks the new conversation', async () => {
    for (const resetContext of [false, true]) {
      fetch.mockClear();
      const result = await supertest(app).post('/api/live-token').send({ lang: 'fr', resetContext });
      expect(result.status).toBe(200);
      const provider = fetch.mock.calls.find(([url]) => String(url).includes('/auth_tokens'));
      const prompt = JSON.parse(provider[1].body).bidiGenerateContentSetup.systemInstruction.parts[0].text;
      expect(prompt).toContain(OLD_CONTEXT);
      expect(prompt.includes('NOUVELLE CONVERSATION')).toBe(resetContext);
    }
  });

  it('keeps memory in legacy text after reset without losing the new message', async () => {
    const result = await supertest(app).post('/api/gemini').send({
      resetContext: true,
      systemInstruction: { parts: [{ text: 'Charly' }] },
      contents: [{ role: 'user', parts: [{ text: 'Créer une image' }] }]
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(fetch.mock.calls.find(([url]) => String(url).includes(':generateContent'))[1].body);
    expect(JSON.stringify(body.systemInstruction)).toContain(OLD_CONTEXT);
    expect(JSON.stringify(body.systemInstruction)).toContain('NOUVELLE CONVERSATION');
    expect(body.contents[0].parts[0].text).toBe('Créer une image');
  });

  it('keeps personal context in ADK turns after reset while persisting new messages', async () => {
    const { CharlyAdkOrchestrator } = requireProxy('./copilot/orchestrator.js');
    const instance = Object.create(CharlyAdkOrchestrator.prototype);
    instance.memoryRequest = vi.fn(async () => null);
    instance.sessionService = { getOrCreateSession: vi.fn(async () => ({})) };
    instance.persistMessage = vi.fn();
    instance.personalContext = vi.fn(async () => ({ context: OLD_CONTEXT }));
    instance.consumeEvents = vi.fn(async () => ({ type: 'message', content: 'Bonjour.' }));
    instance.scrubEphemeralSession = vi.fn();
    await instance._turnInternal('test-user', {
      sessionId: '550e8400-e29b-41d4-a716-446655440001', resetContext: true,
      message: 'Créer une image', idempotencyKey: 'fresh-turn', page: {}, locale: 'fr-FR'
    }, 'reset-request');
    expect(instance.personalContext).toHaveBeenCalledTimes(1);
    const supplied = instance.consumeEvents.mock.calls[0][0].stateDelta['temp:personalContext'];
    expect(supplied.startsWith('NOUVELLE CONVERSATION')).toBe(true);
    expect(supplied).toContain(OLD_CONTEXT);
    expect(instance.persistMessage).toHaveBeenCalledTimes(2);
  });
});
