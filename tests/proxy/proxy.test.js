import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const validConversation = () => ({
  systemInstruction: { parts: [{ text: 'You are Charly.' }] },
  contents: [{ role: 'user', parts: [{ text: 'q' }] }]
});

let app;
let supertest;

// Helper: every request includes the allowed extension origin unless overridden.
const req = () => {
  const agent = supertest(app);
  const origGet = agent.get.bind(agent);
  const origPost = agent.post.bind(agent);
  agent.get = (url) => origGet(url).set('Origin', EXT_ORIGIN);
  agent.post = (url) => origPost(url).set('Origin', EXT_ORIGIN);
  return agent;
};

beforeAll(async () => {
  process.env.EXTENSION_GEMINI_API_KEY = 'test_gemini_key';
  process.env.OPENAI_API_KEY = 'test_openai_key';
  process.env.ALLOWED_EXTENSION_ID = EXT_ID;
  process.env.PORT = '0';
  process.env.KNOWLEDGE_API_URL = 'https://studio.example';
  process.env.KNOWLEDGE_SERVICE_TOKEN = 'x'.repeat(40);
  process.env.MEMORY_IDENTITY_SECRET_V1 = 'memory-identity-test-secret-that-is-long-enough';

  app = requireFromProxy('./index.js');
  supertest = (await import('supertest')).default;
});

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch');
  // Silence proxy logs during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  delete app.locals.authDependencies;
  app.locals.authTesting.resetCaches();
  vi.restoreAllMocks();
});

describe('Charly OTP authentication', () => {
  it('derives a stable memory identity independently from the session subject', () => {
    const first = app.locals.authTesting.stableMemoryUserId('Member@Example.com');
    const second = app.locals.authTesting.stableMemoryUserId('member@example.com');
    expect(first).toBe(second);
    expect(first).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(first).not.toContain('member@example.com');
  });
  it('checks the existing Limova authentication API instead of opening a database connection', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ statusCode: 200, data: { exists: false } })
    });

    const requested = await req().post('/api/auth/request-otp').send({ email: 'unknown@example.com' });
    expect(requested.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.new.limova.ai/auth/check-email');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ email: 'unknown@example.com' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('sends a code only for an active Limova user and issues a persistent session', async () => {
    let deliveredCode = null;
    app.locals.authDependencies = {
      findActiveUserByEmail: vi.fn(async email => email === 'member@example.com' ? { id: 'user-123', email } : null),
      sendOtpEmail: vi.fn(async (_email, code) => { deliveredCode = code; })
    };

    const requested = await req().post('/api/auth/request-otp').send({ email: 'Member@Example.com' });
    expect(requested.status).toBe(200);
    expect(requested.body.challenge).toEqual(expect.any(String));
    expect(deliveredCode).toMatch(/^\d{6}$/);

    const verified = await req().post('/api/auth/verify-otp').send({
      challenge: requested.body.challenge,
      code: deliveredCode
    });
    expect(verified.status).toBe(200);
    expect(verified.body.token).toEqual(expect.any(String));
    expect(verified.body.expiresIn).toBe(30 * 24 * 60 * 60);
  });

  it('does not disclose an unknown Limova address and never sends it an email', async () => {
    app.locals.authDependencies = {
      findActiveUserByEmail: vi.fn(async () => null),
      sendOtpEmail: vi.fn()
    };

    const requested = await req().post('/api/auth/request-otp').send({ email: 'unknown@example.com' });
    expect(requested.status).toBe(200);
    expect(requested.body.challenge).toEqual(expect.any(String));
    expect(app.locals.authDependencies.sendOtpEmail).not.toHaveBeenCalled();

    const rejected = await req().post('/api/auth/verify-otp').send({
      challenge: requested.body.challenge,
      code: '000000'
    });
    expect(rejected.status).toBe(401);
  });
});

describe('GET /', () => {
  it('returns health status', async () => {
    const res = await req().get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'limova-proxy' });
  });
});

describe('Copilot memory fallback', () => {
  it('keeps the extension usable when the private memory service is not configured', async () => {
    const res = await req().get('/api/copilot/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ available: false, enabled: false, recentMessages: [] }));
  });
});

describe('CORS', () => {
  it('allows the configured extension origin', async () => {
    const res = await supertest(app).get('/').set('Origin', EXT_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
  });

  it('rejects other origins', async () => {
    const res = await supertest(app).get('/').set('Origin', 'https://evil.example');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST /api/knowledge/search', () => {
  it('forwards only the validated search contract', async () => {
    fetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ revision: 'kb_test_1', results: [{ id: 'gmail', title: 'Gmail', content: 'Connexion', score: .9 }] })
    });
    const res = await req().post('/api/knowledge/search').send({ query: 'Comment connecter Gmail ?', path: '/integrations', locale: 'fr-FR', contentTypes: ['article'], limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe('kb_test_1');
    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ query: 'Comment connecter Gmail ?', path: '/integrations', locale: 'fr-FR', contentTypes: ['article'], limit: 5 });
    expect(options.headers.Authorization).toBe(`Bearer ${'x'.repeat(40)}`);
  });

  it('rejects invalid payloads before the upstream call', async () => {
    const res = await req().post('/api/knowledge/search').send({ query: 'x' });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a stable 503 when the studio is unavailable', async () => {
    fetch.mockRejectedValueOnce(new Error('timeout'));
    const res = await req().post('/api/knowledge/search').send({ query: 'connecter gmail' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Knowledge service unavailable');
  });
});

describe('POST /api/gemini', () => {
  it('rejects an empty conversation payload', async () => {
    const res = await req()
      .post('/api/gemini')
      .send({ contents: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid conversation payload' });
  });

  it('accepts one validated ephemeral screenshot on the latest user turn', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'seen' }] } }] })
    });
    const body = validConversation();
    body.contents[0].parts.push({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    const res = await req().post('/api/gemini').send(body);
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(fetch.mock.calls[0][1].body);
    expect(forwarded.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
  });

  it('rejects screenshots outside the latest user turn and unknown media types', async () => {
    const historical = validConversation();
    historical.contents.unshift({ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] });
    const historicalRes = await req().post('/api/gemini').send(historical);
    expect(historicalRes.status).toBe(400);

    const invalid = validConversation();
    invalid.contents[0].parts.push({ inlineData: { mimeType: 'image/svg+xml', data: 'AAAA' } });
    const invalidRes = await req().post('/api/gemini').send(invalid);
    expect(invalidRes.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('proxies to Gemini with the default model when no header is set', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })
    });

    const res = await req()
      .post('/api/gemini')
      .send(validConversation());

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe('hi');

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain('gemini-3.6-flash:generateContent');
    expect(url).toContain('key=test_gemini_key');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).generationConfig).toEqual({ temperature: 0.35, maxOutputTokens: 2048 });
  });

  it('forwards upstream errors with the original status', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'too many requests' } })
    });

    const res = await req()
      .post('/api/gemini')
      .send(validConversation());

    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('too many requests');
  });

  it('returns 500 when the upstream fetch throws', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await req()
      .post('/api/gemini')
      .send(validConversation());
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AI service unavailable');
  });

  it('does not allow a request header to override the server model', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const res = await req()
      .post('/api/gemini')
      .set('x-model', 'gemini-2.5-pro')
      .send(validConversation());
    expect(res.status).toBe(200);
    expect(fetch.mock.calls[0][0]).toContain('gemini-3.6-flash');
    expect(fetch.mock.calls[0][0]).not.toContain('gemini-2.5-pro');
  });
});

describe('POST /api/tts (removed)', () => {
  it('returns 404 — endpoint no longer exists', async () => {
    const res = await req().post('/api/tts').send({ text: 'x', voiceId: 'abcdefghij' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/live-session', () => {
  const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

  it('creates an authenticated GPT Live WebRTC session with DOM tools', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        revision: 'onboarding_v7',
        version: 7,
        name: 'Trame E2E',
        openingPrompt: 'Quel objectif veux-tu atteindre ?',
        fallbackPrompt: 'Comprends le métier avant de proposer un parcours.',
        steps: []
      })
    }).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        session: { id: 'live_test' },
        transport: { type: 'webrtc', sdp: 'v=0\r\na=answer\r\n' }
      })
    });

    const res = await req().post('/api/live-session').send({
      lang: 'fr',
      sdp,
      pageContext: 'Page: Accueil'
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 'live_test',
      sdp: 'v=0\r\na=answer\r\n',
      model: 'gpt-live-1'
    }));
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe('https://api.openai.com/v1/live/sessions');
    expect(options.headers.Authorization).toBe('Bearer test_openai_key');
    expect(options.headers['OpenAI-Safety-Identifier']).toMatch(/^[a-f0-9]{64}$/);
    const body = JSON.parse(options.body);
    expect(body.transport).toEqual({ type: 'webrtc', sdp: sdp.trim() });
    expect(body.session.model).toBe('gpt-live-1');
    expect(body.session.audio).toEqual({ output: { voice: 'marin' } });
    expect(body.session.instructions).toContain('pose une seule question courte à la fois');
    expect(body.session.instructions).toContain('Après un clic');
    expect(body.session.instructions).toContain('Page: Accueil');
    expect(body.session.delegation).toMatchObject({
      type: 'responses',
      responses: { model: 'gpt-6-luna', tool_choice: 'auto', parallel_tool_calls: false }
    });
    expect(body.session.delegation.responses.tools.map(tool => tool.name)).toEqual([
      'click_element', 'inspect_current_page', 'capture_current_view',
      'search_knowledge_base', 'scroll_page', 'fill_field',
      'navigate_internal', 'verify_expected_result'
    ]);
  });

  it('keeps trainer transcription passive and tool-free', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        session: { id: 'live_training' },
        transport: { type: 'webrtc', sdp: 'v=0\r\na=answer\r\n' }
      })
    });
    const res = await req().post('/api/live-session').send({
      lang: 'fr',
      sdp,
      trainingMode: true,
      pageContext: 'Page privée',
      history: [{ role: 'user', content: 'Historique privé' }]
    });
    expect(res.status).toBe(201);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.session.delegation).toEqual({ type: 'client' });
    expect(body.session.instructions).toContain('Reste silencieuse');
    expect(body.session.instructions).not.toContain('Page privée');
    expect(body.session.instructions).not.toContain('Historique privé');
  });

  it('rejects a missing or invalid SDP offer before calling OpenAI', async () => {
    const res = await req().post('/api/live-session').send({ lang: 'fr', sdp: 'invalid' });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards an OpenAI session error without exposing the API key', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Model access denied' } })
    });
    const res = await req().post('/api/live-session').send({ lang: 'fr', sdp, trainingMode: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Model access denied');
    expect(JSON.stringify(res.body)).not.toContain('test_openai_key');
  });
});

describe('POST /api/events', () => {
  it('rejects invalid payloads', async () => {
    const r1 = await req().post('/api/events').send({});
    expect(r1.status).toBe(400);

    const r2 = await req().post('/api/events').send({ sid: 'abc', events: [] });
    expect(r2.status).toBe(400);
  });

  it('accepts a valid batch and returns the count', async () => {
    const res = await req()
      .post('/api/events')
      .send({
        sid: 'session-1',
        v: '2.1.0',
        lang: 'fr',
        events: [
          { event: 'session_start', ts: Date.now() },
          { event: 'onboarding_step', props: { step: 'integrations' }, ts: Date.now() }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 2 });
  });

  it('caps the batch at 50 events', async () => {
    const events = Array.from({ length: 120 }, () => ({ event: 'session_start', ts: Date.now() }));
    const res = await req()
      .post('/api/events')
      .send({ sid: 's', events });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(50);
  });
});

describe('Body size limit', () => {
  it('rejects payloads larger than 2MB', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const res = await req()
      .post('/api/gemini')
      .set('Content-Type', 'application/json')
      .send({ blob: big });
    expect(res.status).toBe(413);
  });
});
