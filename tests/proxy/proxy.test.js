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

describe('POST /api/live-token', () => {
  it('isolates a real-flow voice evaluation from onboarding, history, and personal memory', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        run: { id: 'run-evaluation-voice' },
        case: {
          kind: 'live_action',
          title: 'Tester le flow complet dans Limova',
          prompt: 'Aide-moi à connecter HubSpot.',
          expectation: { objective: 'Connecter HubSpot', expectedPages: ['/integrations'] }
        },
        content: {
          versionId: 'version-draft-1',
          title: 'Connecter HubSpot',
          summary: 'Flow de connexion complet',
          bodyMarkdown: '## Étapes\n\nOuvrir Intégrations puis connecter HubSpot.',
          metadata: { expectedPages: ['/integrations'] }
        }
      })
    }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'authTokens/evaluation-voice' })
    });

    const res = await req().post('/api/live-token').send({
      lang: 'fr',
      evaluationCode: 'evaluation-code-that-is-long-enough',
      pageContext: 'Page: Accueil',
      history: [{ role: 'user', content: 'Secret personnel historique' }]
    });

    expect(res.status).toBe(200);
    expect(fetch.mock.calls[0][0]).toContain('/api/evaluations/runs/connect');
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    const systemText = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
    expect(systemText).toContain('MODE TEST DE FLOW ISOLÉ');
    expect(systemText).toContain('Connecter HubSpot');
    expect(systemText).toContain('verify_expected_result');
    expect(systemText).not.toContain('Secret personnel historique');
    expect(systemText).not.toContain('Trame de secours');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations.map(tool => tool.name))
      .not.toContain('search_knowledge_base');
  });

  it('creates a one-use constrained Gemini Live token', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        revision: 'onboarding_v7',
        version: 7,
        name: 'Trame E2E',
        openingPrompt: 'Est-ce qu’il y a un sujet en particulier que tu veux traiter aujourd’hui ?',
        fallbackPrompt: 'Propose Créer une campagne de prospection LinkedIn ou Créer une campagne de posts pour réseaux sociaux, puis demande ce que l’utilisateur fait dans la vie.',
        steps: [{ id: 'linkedin', contentItemId: 'content-1', name: 'Prospection LinkedIn', depth: 0, trigger: 'si le membre cherche des clients', optional: false, description: 'Lancer le super-pouvoir LinkedIn.' }]
      })
    }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'authTokens/ephemeral-test' })
    });
    const res = await req().post('/api/live-token').send({ lang: 'fr', pageContext: 'Page: Accueil' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('authTokens/ephemeral-test');
    expect(res.body.model).toBe('gemini-3.1-flash-live-preview');
    const [url, options] = fetch.mock.calls[1];
    expect(url).toContain('/v1beta/auth_tokens');
    const body = JSON.parse(options.body);
    expect(body.uses).toBe(1);
    expect(body).not.toHaveProperty('liveConnectConstraints');
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(body.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('accent français métropolitain neutre');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('ne demande aucune confirmation');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('carte DOM structurée');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Empreintes d’action démontrées');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('vérifie la route, la modale');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('ne dis jamais que tu ne vois pas l’écran');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('pose une seule question de clarification concise');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('La saisie ne valide et n’envoie jamais le formulaire');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Est-ce qu’il y a un sujet en particulier que tu veux traiter aujourd’hui ?');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Créer une campagne de prospection LinkedIn');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Créer une campagne de posts pour réseaux sociaux');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('demande ce que l’utilisateur fait dans la vie');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('TRAME D’ONBOARDING PUBLIÉE');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('onboarding_v7');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Envoyer le message');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('Ne remplace jamais cette cible par le micro');
    expect(body.bidiGenerateContentSetup).not.toHaveProperty('sessionResumption');
    expect(body.bidiGenerateContentSetup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(body.bidiGenerateContentSetup.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        prefixPaddingMs: 160,
        silenceDurationMs: 1100
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
    });
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[0].name).toBe('click_element');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[0].parameters.required).toEqual([
      'elementId',
      'contextVersion',
      'targetLabel',
      'explicitRequest'
    ]);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[1].name).toBe('inspect_current_page');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[1].description).toContain('métadonnées réseau filtrées');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[2].name).toBe('capture_current_view');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[3].name).toBe('search_knowledge_base');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[3].parameters.required).toEqual(['query']);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[4].name).toBe('scroll_page');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[4].parameters.required).toEqual(['direction', 'amount', 'contextVersion']);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[5].name).toBe('fill_field');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[5].parameters.required).toEqual(['elementId', 'contextVersion', 'targetLabel', 'text']);
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[5].description).toContain('Ne soumet jamais');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[6].name).toBe('navigate_internal');
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[7].name).toBe('verify_expected_result');
    expect(body.fieldMask.split(',')).toEqual(expect.arrayContaining([
      'model',
      'generationConfig.responseModalities',
      'generationConfig.speechConfig',
      'realtimeInputConfig',
      'systemInstruction',
      'tools'
    ]));
  });

  it('creates a tool-free passive token for a trainer demonstration', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'authTokens/passive-training' })
    });
    const res = await req().post('/api/live-token').send({
      lang: 'fr',
      trainingMode: true,
      pageContext: 'Page privée à ne pas inclure',
      history: [{ role: 'user', content: 'Conversation à ne pas inclure' }]
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.fieldMask.split(',')).not.toContain('tools');
    expect(body.bidiGenerateContentSetup).not.toHaveProperty('tools');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('strictement passive');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).not.toContain('Page privée');
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).not.toContain('Conversation à ne pas inclure');
  });

  it('forwards up to the 200 most recent messages to a new voice session', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'authTokens/history-test' })
    });
    const history = Array.from({ length: 205 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `voice-message-${index}`
    }));

    const res = await req().post('/api/live-token').send({ lang: 'fr', history });

    expect(res.status).toBe(200);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const systemText = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
    const forwardedMessages = systemText.match(/(?:Utilisateur|Charly): voice-message-\d+/g) || [];
    expect(forwardedMessages).toHaveLength(200);
    expect(systemText).not.toContain('voice-message-4\n');
    expect(systemText).toContain('voice-message-5');
    expect(systemText).toContain('voice-message-204');
  });

  it('bounds long voice history while preserving the newest message', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: 'authTokens/long-history-test' })
    });
    const history = Array.from({ length: 200 }, (_, index) => ({
      role: 'user',
      content: `long-message-${index}-${'x'.repeat(1_000)}`
    }));

    const res = await req().post('/api/live-token').send({ lang: 'fr', history });

    expect(res.status).toBe(200);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const systemText = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
    const recentConversation = systemText.split('Conversation récente:\n')[1];
    expect(recentConversation.length).toBeLessThanOrEqual(60_000);
    expect(recentConversation).toContain('long-message-199-');
    expect(recentConversation).not.toContain('long-message-0-');
  });

  it('forwards a Gemini token provisioning error without hiding its status', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid auth token configuration' } })
    });
    const res = await req().post('/api/live-token').send({ lang: 'fr' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid auth token configuration');
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
