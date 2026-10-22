const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', EXTENSION_GEMINI_API_KEY: 'test-key', ALLOWED_EXTENSION_ID: 'test',
  MEMORY_API_URL: 'https://memory.example', MEMORY_SERVICE_TOKEN: 'm'.repeat(40),
  MEMORY_IDENTITY_SECRET_V1: 'test-memory-identity-secret-long-enough',
  KNOWLEDGE_API_URL: '', KNOWLEDGE_SERVICE_TOKEN: ''
});
const app = require('../index');
const { turnSchema } = require('./contracts');
const { CharlyAdkOrchestrator } = require('./orchestrator');
const realFetch = global.fetch;
const OLD_CONTEXT = 'OBJECTIFS OUVERTS : Reprendre notre audit SEO';
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { global.fetch = realFetch; });
after(() => new Promise(resolve => server.close(resolve)));

const post = (route, body) => realFetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
function mockServices({ memoryDown = false } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push([String(url), options]);
    if (memoryDown && String(url).includes('/memory/')) return new Response('{}', { status: 503 });
    const data = String(url).includes('/memory/bootstrap')
      ? { enabled: true, context: OLD_CONTEXT }
      : { name: 'authTokens/test', candidates: [{ content: { parts: [{ text: 'Bonjour.' }] } }] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('voice keeps memory after reset and marks the new conversation', async () => {
  for (const resetContext of [false, true]) {
    const calls = mockServices();
    const result = await post('/api/live-token', { lang: 'fr', resetContext });
    assert.equal(result.status, 200);
    const provider = calls.find(([url]) => url.includes('/auth_tokens'));
    const prompt = JSON.parse(provider[1].body).bidiGenerateContentSetup.systemInstruction.parts[0].text;
    assert.equal(prompt.includes(OLD_CONTEXT), true);
    assert.equal(prompt.includes('NOUVELLE CONVERSATION'), resetContext);
  }
});

for (const route of ['/api/gemini', '/api/copilot/turn']) {
  test(`${route} keeps memory after reset and retains the new message`, async () => {
    const calls = mockServices();
    const result = await post(route, {
      resetContext: true, systemInstruction: { parts: [{ text: 'Charly' }] },
      contents: [{ role: 'user', parts: [{ text: 'Créer une image' }] }]
    });
    assert.equal(result.status, 200);
    const provider = calls.find(([url]) => url.includes(':generateContent'));
    const body = JSON.parse(provider[1].body);
    assert.equal(JSON.stringify(body.systemInstruction).includes(OLD_CONTEXT), true);
    assert.equal(JSON.stringify(body.systemInstruction).includes('NOUVELLE CONVERSATION'), true);
    assert.equal(body.contents[0].parts[0].text, 'Créer une image');
  });
}

test('ordinary legacy text still receives personal memory', async () => {
  const calls = mockServices();
  assert.equal((await post('/api/gemini', {
    systemInstruction: { parts: [{ text: 'Charly' }] },
    contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }]
  })).status, 200);
  const provider = calls.find(([url]) => url.includes('/generateContent') || url.includes(':generateContent'));
  assert.equal(JSON.stringify(JSON.parse(provider[1].body).systemInstruction).includes(OLD_CONTEXT), true);
});

test('ADK accepts the boolean reset contract and rejects invalid values', () => {
  const input = {
    sessionId: '550e8400-e29b-41d4-a716-446655440001', message: 'Bonjour',
    source: 'text', locale: 'fr-FR', idempotencyKey: 'fresh-turn',
    page: { url: 'https://new.limova.ai/home', title: 'Accueil', contextVersion: 0, dom: '' }
  };
  for (const resetContext of [undefined, false, true]) {
    assert.equal(turnSchema.safeParse({ ...input, ...(resetContext !== undefined ? { resetContext } : {}) }).success, true);
  }
  assert.equal(turnSchema.safeParse({ ...input, resetContext: 'true' }).success, false);
});

test('ADK keeps memory after reset, marks the new conversation and persists new messages', async () => {
  for (const resetContext of [false, true]) {
    const instance = Object.create(CharlyAdkOrchestrator.prototype);
    let reads = 0, writes = 0, suppliedContext;
    instance.memoryRequest = async () => null;
    instance.sessionService = { getOrCreateSession: async () => ({}) };
    instance.persistMessage = async () => { writes++; };
    instance.personalContext = async () => { reads++; return { context: OLD_CONTEXT }; };
    instance.consumeEvents = async input => { suppliedContext = input.stateDelta['temp:personalContext']; return { type: 'message', content: 'Bonjour.' }; };
    instance.scrubEphemeralSession = () => {};
    await instance._turnInternal('test-user', {
      sessionId: '550e8400-e29b-41d4-a716-446655440001', resetContext,
      message: 'Créer une image', idempotencyKey: 'fresh-turn', page: {}, locale: 'fr-FR'
    }, 'reset-request');
    assert.equal(reads, 1);
    assert.equal(suppliedContext.endsWith(OLD_CONTEXT), true);
    assert.equal(suppliedContext.startsWith('NOUVELLE CONVERSATION'), resetContext);
    assert.equal(writes, 2);
  }
});

test('the first name is known even when the memory service is unavailable', async () => {
  let calls = mockServices({ memoryDown: true });
  // A distinct question keeps the earlier tests' cached memory out of the way.
  assert.equal((await post('/api/live-token', {
    lang: 'fr', resetContext: true, userFirstName: 'Camille',
    history: [{ role: 'user', content: 'Comment je m’appelle ?' }]
  })).status, 200);
  const voicePrompt = JSON.parse(calls.find(([url]) => url.includes('/auth_tokens'))[1].body)
    .bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert.equal(voicePrompt.includes('L’utilisateur s’appelle Camille'), true);
  assert.equal(voicePrompt.includes(OLD_CONTEXT), false);

  calls = mockServices({ memoryDown: true });
  assert.equal((await post('/api/gemini', {
    resetContext: true, userFirstName: 'Camille', systemInstruction: { parts: [{ text: 'Charly' }] },
    contents: [{ role: 'user', parts: [{ text: 'Comment je m’appelle ?' }] }],
    memoryTurn: { user: 'Comment je m’appelle ?', source: 'text', idempotencyKey: 'first-name-turn' }
  })).status, 200);
  const textPrompt = JSON.stringify(JSON.parse(calls.find(([url]) => url.includes(':generateContent'))[1].body).systemInstruction);
  assert.equal(textPrompt.includes('L’utilisateur s’appelle Camille'), true);
  assert.equal(textPrompt.includes(OLD_CONTEXT), false);

  assert.equal(turnSchema.safeParse({
    sessionId: '550e8400-e29b-41d4-a716-446655440001', message: 'Bonjour', source: 'text', locale: 'fr-FR',
    idempotencyKey: 'fresh-turn', resetContext: true, userFirstName: 'Camille',
    page: { url: 'https://new.limova.ai/home', title: 'Accueil', contextVersion: 0, dom: '' }
  }).success, true);
});
