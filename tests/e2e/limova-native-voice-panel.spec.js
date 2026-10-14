import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const environment = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');
const APP = environment.appOrigin;
const API = environment.apiOrigin;
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const VOICE_TURN = '55555555-5555-4555-8555-555555555555';
const BROWSER_TURN = '66666666-6666-4666-8666-666666666666';
const BROWSER_SESSION = '77777777-7777-4777-8777-777777777777';
const PAGE = { tabId: 7, origin: 'https://example.com', contextVersion: 1 };

for (const ending of ['consent', 'disconnect', 'startup-timeout', 'permission-dismissed', 'turn-failed', 'response-timeout', 'manual-context', 'manual-other-tab', 'playback-interruption']) test(`native voice handles ${ending} without replaying a turn`, async () => {
  test.setTimeout(40_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'limova-live-test-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=limova-live-test'], { stdio: 'ignore' });
  const history = [];
  const seen = { starts: 0, connected: 0, stopped: 0, disconnected: 0, pcm: null, cancelled: null, browserBinding: null, browserResult: null, results: [], action: null, httpChecks: [], cookie: false, origin: null };
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    if (request.headers.host === new URL(APP).host) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(`<title>Live fixture</title><main>Browser knowledge fixture<input type="password" value="NEVER_TRANSMIT_THIS_SECRET"><textarea>PRIVATE_FIELD_VALUE</textarea><button id="manual">Connecter HubSpot</button></main><script>window.manualClicks=0;manual.onclick=()=>{window.manualClicks++;history.pushState({},'', '/integrations?private_token=PRIVATE_ROUTE');const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.textContent='HubSpot connecté';document.body.append(dialog);};</script>`); return;
    }
    const headers = { 'access-control-allow-origin': APP, 'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'x-workspace-id,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    if (request.url === '/fixture-login') {
      response.writeHead(200, { ...headers, 'set-cookie': 'live_fixture=authenticated; Path=/; HttpOnly; Secure; SameSite=None; Partitioned' });
      response.end('{}'); return;
    }
    const authenticated = request.headers.cookie?.includes('live_fixture=authenticated') === true;
    seen.httpChecks.push({ method: request.method, path: request.url, authenticated, workspaceId: request.headers['x-workspace-id'] });
    let data = {};
    if (request.url.startsWith('/conversation?')) data = { data: { data: [{ id: CONVERSATION, title: 'Conversation vocale' }] } };
    if (request.url === `/conversation/${CONVERSATION}/messages`) data = { data: { data: history } };
    if (request.url === '/users/me') data = { id: USER };
    if (request.url === '/workspaces') data = [{ id: WORKSPACE, is_charly_extension_enabled: true }];
    if (request.url === `/conversation/${CONVERSATION}`) data = { id: CONVERSATION, engine: 'deep_agents', mainAgent: { slug: 'charly' } };
    response.writeHead(authenticated ? 200 : 401, headers);
    response.end(JSON.stringify(data));
  });
  let activeSocket;
  const io = new Server(server, { cors: { origin: APP, credentials: true }, transports: ['websocket'] });
  io.of('/conversation/live').on('connection', socket => {
    const socketSessionId = randomUUID();
    activeSocket = socket;
    seen.sessionId = socketSessionId;
    seen.connected += 1;
    seen.cookie = socket.handshake.headers.cookie?.includes('live_fixture=authenticated') === true;
    seen.origin = socket.handshake.headers.origin;
    socket.on('session.start', payload => {
      seen.starts += 1;
      seen.startPayload = payload;
      seen.browserBinding = { browserSession: payload.browserSession, browserContext: payload.browserContext };
      seen.initialBrowserBinding = structuredClone(seen.browserBinding);
      if (!seen.cookie || payload.expectedUserId !== USER || socket.handshake.auth.workspaceId !== WORKSPACE) return socket.disconnect();
      if (ending === 'startup-timeout') return;
      socket.emit('session.ready', { sessionId: socketSessionId, conversationId: CONVERSATION, userId: USER, workspaceId: WORKSPACE,
        clientSurface: 'chrome_extension', inputSampleRate: 16_000, outputSampleRate: 24_000, maxAudioFrameBytes: 2_560 });
    });
    socket.on('audio.append', payload => {
      seen.pcm = { sequence: payload.sequence, length: payload.audio.length };
      if (ending.startsWith('manual-') || ending === 'playback-interruption') return;
      if (seen.action) return;
      seen.action = true;
      socket.emit('turn.deep_agent_stream.started', { sessionId: socketSessionId, turnId: VOICE_TURN });
      if (ending === 'turn-failed') {
        socket.emit('turn.deep_agent_stream.failed', { sessionId: socketSessionId, turnId: VOICE_TURN, error: 'PRIVATE_BACKEND_DETAIL' });
        return;
      }
      if (ending === 'response-timeout') {
        socket.emit('input.transcript.final', { sessionId: socketSessionId, turnId: VOICE_TURN, text: 'Question vocale sans réponse' });
        socket.emit('turn.deep_agent_stream.delta', { sessionId: socketSessionId, turnId: VOICE_TURN,
          chunk: Buffer.from(`event: values\ndata: ${JSON.stringify({ messages: [{ id: USER, role: 'user', content: 'Question vocale sans réponse' }] })}\n\n`) });
        return;
      }
      socket.emit('assistant.audio.delta', { sessionId: socketSessionId, sequence: 0, audio: Buffer.alloc(4800) });
      socket.emit('turn.deep_agent_stream.completed', { sessionId: socketSessionId, turnId: VOICE_TURN });
    });
    socket.on('turn.browser_context', payload => {
      seen.contextReply = payload;
      seen.browserBinding.browserContext = payload.browserContext;
      socket.emit('turn.deep_agent_stream.started', { sessionId: socketSessionId, turnId: VOICE_TURN });
      const action = { type: 'extension.action_requested', protocolVersion: 1, turnId: BROWSER_TURN,
        actionId: 'manual-context-read', toolCallId: 'manual-context-tool', target: payload.browserContext,
        input: { operation: 'read_page' }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const frames = [action, { type: 'extension.turn_state', state: 'waiting', turnId: BROWSER_TURN }];
      socket.emit('turn.deep_agent_stream.delta', { sessionId: socketSessionId, turnId: VOICE_TURN,
        chunk: Buffer.from(frames.map(data => `event: custom\ndata: ${JSON.stringify(data)}\n\n`).join('')) });
    });
    socket.on('turn.browser_continue', payload => {
      seen.results.push(payload);
      const values = { messages: [{ id: USER, role: 'user', content: 'Que vois-tu ?' }, { id: WORKSPACE, role: 'assistant', content: 'HubSpot connecté.' }] };
      socket.emit('turn.deep_agent_stream.delta', { sessionId: socketSessionId, turnId: VOICE_TURN,
        chunk: Buffer.from(`event: values\ndata: ${JSON.stringify(values)}\n\nevent: custom\ndata: ${JSON.stringify({ type: 'extension.turn_state', state: 'completed', turnId: BROWSER_TURN })}\n\n`) });
      socket.emit('turn.deep_agent_stream.completed', { sessionId: socketSessionId, turnId: VOICE_TURN });
      socket.emit('assistant.transcript.final', { sessionId: socketSessionId, turnId: VOICE_TURN, text: 'HubSpot connecté.' });
    });
    socket.on('response.cancel', payload => { seen.cancelled = payload.playedAudioMs; });
    socket.on('session.stop', () => { seen.stopped += 1; });
    socket.on('disconnect', () => { seen.disconnected += 1; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let context;
  try {
    const extension = path.resolve(process.env.EXTENSION_PATH ?? (environment.name === 'staging' ? 'build-staging' : 'build'));
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--ignore-certificate-errors', ...(ending === 'permission-dismissed' ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']),
        `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP * ~NOTFOUND`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const app = await context.newPage(); await app.goto(APP);
    await app.evaluate(api => fetch(`${api}/fixture-login`, { credentials: 'include' }), API);
    await worker.evaluate(async ({ USER, WORKSPACE, CONVERSATION }) => {
      await chrome.storage.local.set({
        limova_deep_agent_context_v1: { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION },
        limova_ai_processing_consent_v1: true,
      });
    }, { USER, WORKSPACE, CONVERSATION });
    const extensionPage = await context.newPage();
    const errors = [], legacyRequests = [], deprecatedAudioWarnings = [];
    extensionPage.on('console', message => {
      if (/ScriptProcessorNode|createScriptProcessor/i.test(message.text())) deprecatedAudioWarnings.push(message.text());
    });
    extensionPage.on('pageerror', error => errors.push(error.message));
    context.on('request', request => { if (/limova-proxy|generativelanguage|\/api\/live-session/.test(request.url())) legacyRequests.push(request.url()); });
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/sidebar.html`);
    await expect(extensionPage.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
    await expect(extensionPage.locator('#limovaConversation')).toHaveValue(CONVERSATION);
    if (ending === 'playback-interruption') await extensionPage.evaluate(() => {
      const NativeAudioContext = window.AudioContext;
      window.audioInspection = { contexts: [], starts: [], stops: 0 };
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) { super(...args); window.audioInspection.contexts.push(this); }
        createBufferSource() {
          const node = super.createBufferSource();
          const start = node.start.bind(node), stop = node.stop.bind(node);
          node.start = (...args) => {
            window.audioInspection.starts.push({ sampleRate: node.buffer.sampleRate,
              samples: [...node.buffer.getChannelData(0).slice(0, 2)], duration: node.buffer.duration });
            return start(...args);
          };
          node.stop = (...args) => { window.audioInspection.stops++; return stop(...args); };
          return node;
        }
      };
    });
    if (ending === 'response-timeout') await extensionPage.clock.install();
    if (ending.startsWith('manual-')) {
      await app.bringToFront();
      await extensionPage.evaluate(() => { document.getElementById('limovaBrowser').checked = true; document.getElementById('voiceBtn').click(); });
    } else await extensionPage.locator('#voiceBtn').click();
    if (ending === 'permission-dismissed') {
      await expect.poll(() => context.pages().some(page => page.url().endsWith('/microphone-permission.html'))).toBe(true);
      const permissionPage = context.pages().find(page => page.url().endsWith('/microphone-permission.html'));
      await expect(permissionPage.locator('#allowMicrophone')).toBeVisible();
      expect(seen.connected).toBe(0); expect(seen.starts).toBe(0);
      await permissionPage.close();
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
      await expect(extensionPage.locator('.message.error .message-content').last()).not.toBeEmpty();
      await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
      expect(seen.connected).toBe(0); expect(seen.pcm).toBeNull();
      expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
      expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
      return;
    }
    await expect.poll(() => seen.starts).toBe(1);
    if (ending === 'startup-timeout') {
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });
      await expect(extensionPage.locator('.message.error .message-content').last()).not.toBeEmpty();
      await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
      await expect.poll(() => seen.disconnected).toBe(1);
      expect(seen.pcm).toBeNull();
      await extensionPage.waitForTimeout(1_200);
      expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
      expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
      expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
      return;
    }
    await expect.poll(() => seen.pcm?.length).toBe(640);
    if (ending === 'playback-interruption') {
      expect(seen.startPayload).toMatchObject({ conversationId: CONVERSATION, expectedUserId: USER, clientSurface: 'chrome_extension' });
      expect(seen.cookie).toBe(true); expect(seen.origin).toBe(APP);
      const sessionId = seen.sessionId;
      activeSocket.emit('turn.deep_agent_stream.started', { sessionId, turnId: VOICE_TURN });
      const pcm = Buffer.alloc(48000);
      for (let offset = 0; offset < pcm.length; offset += 4) { pcm.writeInt16LE(-32768, offset); pcm.writeInt16LE(32767, offset + 2); }
      activeSocket.emit('assistant.audio.delta', { sessionId, sequence: 0, audio: pcm });
      activeSocket.emit('assistant.audio.delta', { sessionId, sequence: 1, audio: pcm });
      await expect.poll(() => extensionPage.evaluate(() => window.audioInspection.starts.length)).toBe(2);
      expect(await extensionPage.evaluate(() => window.audioInspection.starts)).toEqual([
        { sampleRate: 24000, samples: [-1, 32767 / 32768], duration: 1 },
        { sampleRate: 24000, samples: [-1, 32767 / 32768], duration: 1 },
      ]);
      activeSocket.emit('turn.interrupted', { sessionId, turnId: VOICE_TURN });
      await expect.poll(() => extensionPage.evaluate(() => window.audioInspection.stops)).toBe(2);
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
      const resumedTurn = randomUUID();
      history.push({ id: USER, role: 'user', content: 'Question vocale conservée' },
        { id: WORKSPACE, role: 'assistant', content: 'Réponse canonique conservée' });
      activeSocket.emit('input.transcript.final', { sessionId, turnId: resumedTurn, text: 'Question vocale conservée' });
      activeSocket.emit('turn.deep_agent_stream.started', { sessionId, turnId: resumedTurn });
      activeSocket.emit('turn.deep_agent_stream.delta', { sessionId, turnId: resumedTurn,
        chunk: Buffer.from(`event: values\ndata: ${JSON.stringify({ messages: history })}\n\n`) });
      activeSocket.emit('turn.deep_agent_stream.completed', { sessionId, turnId: resumedTurn });
      activeSocket.emit('assistant.audio.delta', { sessionId, sequence: 2, audio: Buffer.alloc(4800) });
      activeSocket.emit('assistant.transcript.final', { sessionId, turnId: resumedTurn, text: 'Réponse canonique conservée' });
      await expect.poll(() => extensionPage.evaluate(() => window.audioInspection.starts.length)).toBe(3);
      await expect(extensionPage.locator('.message.user .message-content')).toHaveText('Question vocale conservée');
      await expect(extensionPage.locator('.message.assistant .message-content')).toHaveText('Réponse canonique conservée');
      await extensionPage.locator('#voiceBtn').click();
      await expect.poll(() => seen.disconnected).toBe(1);
      await expect.poll(() => extensionPage.evaluate(() => window.audioInspection.contexts.map(context => context.state))).toEqual(['closed', 'closed']);
      const lastSequence = seen.pcm.sequence;
      await extensionPage.waitForTimeout(300);
      expect(seen.pcm.sequence).toBe(lastSequence);
      await extensionPage.reload();
      await expect(extensionPage.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
      await expect(extensionPage.locator('#limovaConversation')).toHaveValue(CONVERSATION);
      await expect(extensionPage.locator('.message.user .message-content')).toHaveText('Question vocale conservée');
      await expect(extensionPage.locator('.message.assistant .message-content')).toHaveText('Réponse canonique conservée');
      expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
      expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
      expect(deprecatedAudioWarnings).toEqual([]); expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
      return;
    }
    if (ending.startsWith('manual-')) {
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
      await app.locator('#manual').click();
      await expect(app.locator('[role="dialog"]')).toHaveText('HubSpot connecté');
      expect(seen.results).toHaveLength(0);
      if (ending === 'manual-other-tab') {
        const other = await context.newPage();
        await other.goto(`${APP}/other-tab`);
        await other.bringToFront();
      }
      activeSocket.emit('turn.browser_context_requested', { sessionId: seen.sessionId, turnId: VOICE_TURN, requestId: USER });
      if (ending === 'manual-other-tab') {
        await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
        await expect.poll(() => seen.disconnected).toBe(1);
        await expect(extensionPage.locator('.message.error .message-content').last()).not.toBeEmpty();
        await expect(extensionPage.locator('#limovaReturnTab')).toBeVisible();
        await extensionPage.evaluate(() => document.getElementById('limovaReturnTab').click());
        await expect(extensionPage.locator('#limovaReturnTab')).toBeHidden();
        await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
        expect(seen.contextReply).toBeUndefined();
        expect(seen.results).toEqual([]);
        expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
        expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
        expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
        return;
      }

      await expect.poll(() => seen.results.length).toBe(1);
      const receipt = seen.results[0].browserResult;
      expect(receipt.status).toBe('completed');
      const page = JSON.parse(receipt.observation);
      expect(page.url).toBe(`${APP}/integrations`);
      expect(page.text).toContain('HubSpot connecté');
      expect(seen.contextReply.browserContext.contextVersion).toBeGreaterThan(seen.initialBrowserBinding.browserContext.contextVersion);
      expect(seen.contextReply.browserContext.tabId).toBe(seen.initialBrowserBinding.browserContext.tabId);
      expect(JSON.stringify(seen.results)).not.toMatch(/NEVER_TRANSMIT_THIS_SECRET|PRIVATE_FIELD_VALUE|PRIVATE_ROUTE/);
      await expect(extensionPage.locator('.message.assistant .message-content')).toHaveText('HubSpot connecté.');
      expect(await app.evaluate(() => window.manualClicks)).toBe(1);
      const diagnostics = await extensionPage.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_LOGS' }));
      expect(diagnostics.logs).not.toMatch(/NEVER_TRANSMIT_THIS_SECRET|PRIVATE_FIELD_VALUE|PRIVATE_ROUTE/);
      await extensionPage.evaluate(() => document.getElementById('voiceBtn').click());
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => seen.disconnected).toBe(1);
      expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
      expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
      expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
      return;
    }
    if (['turn-failed', 'response-timeout'].includes(ending)) {
      if (ending === 'response-timeout') {
        await expect(extensionPage.locator('.message.user .message-content')).toHaveText('Question vocale sans réponse');
        await extensionPage.clock.fastForward(90_001);
      }
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
      await expect(extensionPage.locator('.message.error .message-content').last()).toContainText(/historique|history|historial/i);
      await expect(extensionPage.locator('.message.error .message-content').last()).not.toContainText('PRIVATE_BACKEND_DETAIL');
      await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
      await expect.poll(() => seen.disconnected).toBe(1);
      const sequence = seen.pcm.sequence;
      await extensionPage.waitForTimeout(1_200);
      expect(seen.pcm.sequence).toBe(sequence);
      expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
      expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
      expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
      return;
    }
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
    expect(seen.browserBinding).toEqual({ browserSession: undefined, browserContext: undefined });
    expect(seen.cookie).toBe(true); expect(seen.origin).toBe(APP);
    expect(seen.startPayload).toMatchObject({ conversationId: CONVERSATION, expectedUserId: USER, clientSurface: 'chrome_extension' });
    await expect(extensionPage.locator('#limovaConversation')).toBeDisabled();
    if (ending === 'consent') await worker.evaluate(() => chrome.storage.local.set({ limova_ai_processing_consent_v1: false }));
    else activeSocket.disconnect(true);
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => seen.disconnected).toBe(1);
    await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
    const sequence = seen.pcm.sequence;
    await extensionPage.waitForTimeout(1_200);
    expect(seen.pcm.sequence).toBe(sequence);
    expect(seen.connected).toBe(1); expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
    expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
    if (ending === 'disconnect') {
      await expect(extensionPage.locator('.message.error .message-content').last()).not.toBeEmpty();
      await extensionPage.locator('#voiceBtn').click();
      await expect.poll(() => seen.starts).toBe(2);
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
      expect(seen.startPayload.conversationId).toBe(CONVERSATION);
      await extensionPage.locator('#voiceBtn').click();
      await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => seen.disconnected).toBe(2);
    }

  } finally {
    await context?.close();
    await new Promise(resolve => io.close(resolve));
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
});
