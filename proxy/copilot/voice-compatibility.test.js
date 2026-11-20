const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Exercise real HTTP routes with authentication enabled and mocked providers.
Object.assign(process.env, {
  NODE_ENV: 'development', AUTH_DISABLED: 'false',
  EXTENSION_GEMINI_API_KEY: 'test-gemini', OPENAI_API_KEY: 'test-openai',
  ALLOWED_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  LIMOVA_JWT_ISSUER: 'https://auth.example', LIMOVA_JWKS_URL: 'https://auth.example/jwks',
  RESEND_API_KEY: 'test-resend', RESEND_FROM_EMAIL: 'test@example.com',
  CHARLY_SESSION_SECRET: 'voice-compatibility-test-secret',
  KNOWLEDGE_API_URL: '', MEMORY_API_URL: '', EVALUATION_API_URL: ''
});
const app = require('../index');
const realFetch = global.fetch;
let server, base, token;
before(async () => {
  app.locals.authDependencies = { findActiveUserByEmail: async () => ({ id: 'voice-test', email: 'voice@example.com' }) };
  token = app.locals.authTesting.issueSessionToken({ id: 'voice-test', email: 'voice@example.com' });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { global.fetch = realFetch; });
after(() => new Promise(resolve => server.close(resolve)));
const post = (route, body, authenticated = true) => realFetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});
const mockProvider = (status, data, inspect = () => {}) => {
  global.fetch = async (url, options) => {
    inspect(String(url), JSON.parse(options.body));
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
};

test('both voice protocols require authentication', async () => {
  global.fetch = () => { throw new Error('Must not contact provider'); };
  for (const route of ['/api/live-token', '/api/live-session']) {
    assert.equal((await post(route, {}, false)).status, 401);
  }
});

test('legacy client receives a constrained Gemini token, with current server prompt and tools', async () => {
  mockProvider(200, { name: 'authTokens/test' }, (url, body) => {
    assert.match(url, /generativelanguage.googleapis.com\/v1beta\/auth_tokens/);
    assert.equal(body.uses, 1);
    const setup = body.bidiGenerateContentSetup;
    assert.equal(setup.model, 'models/gemini-3.1-flash-live-preview');
    assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
    assert.ok(setup.systemInstruction.parts[0].text.includes('Page: Conversation'));
    assert.match(setup.systemInstruction.parts[0].text, /Conversation/);
    assert.equal(setup.tools[0].functionDeclarations[0].name, 'click_element');
    assert.ok(body.fieldMask.includes('tools'));
    assert.ok(Date.parse(body.newSessionExpireTime) < Date.parse(body.expireTime));
  });
  const response = await post('/api/live-token', { lang: 'fr', pageContext: 'Page: Conversation' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.token, 'authTokens/test');
  assert.equal(data.model, 'gemini-3.1-flash-live-preview');
  assert.ok(Date.parse(data.expiresAt) > Date.now());
});

test('legacy training sessions exclude tools, page data and history', async () => {
  mockProvider(200, { name: 'authTokens/training' }, (_url, body) => {
    assert.equal(body.bidiGenerateContentSetup.tools, undefined);
    assert.ok(!body.fieldMask.split(',').includes('tools'));
    assert.ok(!body.bidiGenerateContentSetup.systemInstruction.parts[0].text.includes('PRIVATE-DATA'));
  });
  assert.equal((await post('/api/live-token', { trainingMode: true, pageContext: 'PRIVATE-DATA', history: [{ role: 'user', content: 'PRIVATE-DATA' }] })).status, 200);
});

test('Gemini provider errors are returned to the legacy client', async () => {
  mockProvider(429, { error: { message: 'Quota exceeded' } });
  const response = await post('/api/live-token', {});
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.message, 'Quota exceeded');
});

test('existing WebRTC protocol still validates offers and creates OpenAI sessions', async () => {
  assert.equal((await post('/api/live-session', {})).status, 400);
  mockProvider(201, { session: { id: 'live-test' }, transport: { sdp: 'answer-sdp' } }, (url, body) => {
    assert.equal(url, 'https://api.openai.com/v1/live/sessions');
    assert.equal(body.session.model, 'gpt-live-1');
    assert.equal(body.transport.type, 'webrtc');
    assert.equal(body.session.delegation.type, 'responses');
    assert.equal(body.session.audio.output.voice, 'marin');
    const tools = body.session.delegation.responses.tools;
    assert.ok(!tools.some(tool => tool.name === 'fill_fields'), 'Older extensions must not receive an unsupported batch tool');
    assert.ok(!tools.some(tool => tool.name === 'dismiss_popup'), 'Older extensions must not receive an unsupported dismissal tool');
    assert.ok(tools.some(tool => tool.name === 'select_control'));
    assert.ok(tools.some(tool => tool.name === 'create_in_limova'));
    assert.ok(tools.find(tool => tool.name === 'verify_expected_result').parameters.required.includes('conditions'));
  });
  const response = await post('/api/live-session', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.sdp, 'answer-sdp');
  assert.equal(data.protocol, 'gpt_live_webrtc_v1');
});

test('capable GPT clients get form batching and low-latency reasoning without changing the live model or voice', async () => {
  mockProvider(201, { session: { id: 'live-batch' }, transport: { sdp: 'answer-sdp' } }, (_url, body) => {
    assert.equal(body.session.model, 'gpt-live-1');
    assert.equal(body.session.audio.output.voice, 'marin');
    const backend = body.session.delegation.responses;
    assert.equal(backend.model, 'gpt-6-luna');
    assert.equal(backend.reasoning.effort, 'low');
    const batch = backend.tools.find(tool => tool.name === 'fill_fields');
    assert.ok(batch);
    assert.equal(batch.parameters.properties.fields.maxItems, 12);
    assert.ok(batch.parameters.required.includes('contextVersion'));
    assert.ok(backend.tools.find(tool => tool.name === 'dismiss_popup').parameters.required.includes('contextVersion'));
    assert.ok(backend.tools.find(tool => tool.name === 'inspect_current_page').description.includes('ne la relis pas'));
    assert.match(body.session.instructions, /Accès complet/);
  });
  assert.equal((await post('/api/live-session', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', capabilities: ['browser_tasks', 'batch_fields', 'dismiss_popup'], autonomyMode: 'full' })).status, 201);
});

test('GPT training keeps transcription passive and does not delegate browser tools', async () => {
  mockProvider(201, { session: { id: 'live-training' }, transport: { sdp: 'answer-sdp' } }, (_url, body) => {
    assert.equal(body.session.model, 'gpt-live-1');
    assert.deepEqual(body.session.delegation, { type: 'client' });
    assert.ok(!body.session.instructions.includes('PRIVATE-DATA'));
  });
  const response = await post('/api/live-session', { trainingMode: true, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', pageContext: 'PRIVATE-DATA' });
  assert.equal(response.status, 201);
});
