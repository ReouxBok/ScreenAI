import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const RUN_ID = 'bb0e8400-e29b-41d4-a716-446655440000';

let app;
let supertest;
let originalOrchestrator;

const request = () => {
  const agent = supertest(app);
  const post = agent.post.bind(agent);
  const get = agent.get.bind(agent);
  agent.post = url => post(url).set('Origin', EXT_ORIGIN);
  agent.get = url => get(url).set('Origin', EXT_ORIGIN);
  return agent;
};

beforeAll(async () => {
  process.env.EXTENSION_GEMINI_API_KEY = 'test_gemini_key';
  process.env.ALLOWED_EXTENSION_ID = EXT_ID;
  process.env.PORT = '0';
  process.env.MEMORY_API_URL = 'https://memory.example';
  process.env.MEMORY_SERVICE_TOKEN = 'm'.repeat(40);
  process.env.MEMORY_IDENTITY_SECRET_V1 = 'memory-identity-test-secret-that-is-long-enough';
  process.env.ADK_TEXT_MODE = 'on';
  app = requireFromProxy('./index.js');
  supertest = (await import('supertest')).default;
  originalOrchestrator = app.locals.adkOrchestrator;
});

beforeEach(() => {
  globalThis.fetch = vi.fn();
  app.locals.adkOrchestrator = {
    serverOrchestrationFor: vi.fn(() => true),
    openSession: vi.fn(async () => ({ id: SESSION_ID, sessionRevision: 2 })),
    turn: vi.fn(async (_userKey, input) => ({ type: 'message', sessionId: input.sessionId, content: 'Terminé.' })),
    resume: vi.fn(async (_userKey, _runId, result) => ({ type: 'message', sessionId: SESSION_ID, content: result.status === 'ok' ? 'Action vérifiée.' : 'Échec.' }))
  };
});

afterEach(() => {
  app.locals.adkOrchestrator = originalOrchestrator;
  vi.restoreAllMocks();
});

describe('copilot v2 public API', () => {
  it('opens a real remote session for a new visible chat', async () => {
    const response = await request().post('/api/copilot/v2/sessions').send({ previousSessionId: SESSION_ID, closePrevious: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sessionId: SESSION_ID, promptRevision: expect.stringMatching(/^prompt_/) });
    expect(app.locals.adkOrchestrator.openSession).toHaveBeenCalledWith(expect.any(String), { previousSessionId: SESSION_ID, closePrevious: true });
  });

  it('runs a validated text turn without accepting a client model or system prompt', async () => {
    const payload = {
      sessionId: SESSION_ID,
      message: 'Clique sur Gmail',
      source: 'text',
      locale: 'fr-FR',
      idempotencyKey: 'integration-turn-1',
      page: { url: 'https://new.limova.ai/integrations', title: 'Intégrations', contextVersion: 3, dom: '[1] Gmail' }
    };
    const response = await request().post('/api/copilot/v2/turn').send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 'message', sessionId: SESSION_ID, content: 'Terminé.' });
    const rejected = await request().post('/api/copilot/v2/turn').send({ ...payload, model: 'not-google' });
    expect(rejected.status).toBe(400);
  });

  it('resumes a suspended tool call and rejects malformed screenshots', async () => {
    const result = {
      callId: 'adk-call-1', status: 'ok', contextVersion: 4,
      page: { url: 'https://new.limova.ai/integrations', title: 'Intégrations', contextVersion: 4, dom: '[2] Connecté' }
    };
    const response = await request().post(`/api/copilot/v2/runs/${RUN_ID}/result`).send(result);
    expect(response.status).toBe(200);
    expect(response.body.content).toBe('Action vérifiée.');
    const rejected = await request().post(`/api/copilot/v2/runs/${RUN_ID}/result`).send({
      ...result,
      capture: { mimeType: 'image/jpeg', data: '<script>' }
    });
    expect(rejected.status).toBe(400);
  });
});
