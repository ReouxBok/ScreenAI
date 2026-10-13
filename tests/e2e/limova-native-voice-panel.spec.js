import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:https';
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
const SESSION = '44444444-4444-4444-8444-444444444444';
const VOICE_TURN = '55555555-5555-4555-8555-555555555555';
const BROWSER_TURN = '66666666-6666-4666-8666-666666666666';
const BROWSER_SESSION = '77777777-7777-4777-8777-777777777777';
const PAGE = { tabId: 7, origin: 'https://example.com', contextVersion: 1 };

test('sidebar microphone uses the selected native conversation and stops on consent revocation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'limova-live-test-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=limova-live-test'], { stdio: 'ignore' });
  const seen = { starts: 0, connected: 0, stopped: 0, disconnected: 0, pcm: null, cancelled: null, browserBinding: null, browserResult: null, results: [], action: null, httpChecks: [], cookie: false, origin: null };
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    if (request.headers.host === new URL(APP).host) {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Live fixture</title><main>Browser knowledge fixture</main>'); return;
    }
    const headers = { 'access-control-allow-origin': APP, 'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'x-workspace-id,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    if (request.url === '/fixture-login') {
      response.writeHead(200, { ...headers, 'set-cookie': 'live_fixture=authenticated; Path=/; HttpOnly; Secure; SameSite=None; Partitioned' });
      response.end('{}'); return;
    }
    const authenticated = request.headers.cookie?.includes('live_fixture=authenticated') === true;
    seen.httpChecks.push({ path: request.url, authenticated, workspaceId: request.headers['x-workspace-id'] });
    let data = {};
    if (request.url.startsWith('/conversation?')) data = { data: { data: [{ id: CONVERSATION, title: 'Conversation vocale' }] } };
    if (request.url === `/conversation/${CONVERSATION}/messages`) data = { data: { data: [] } };
    if (request.url === '/users/me') data = { id: USER };
    if (request.url === '/workspaces') data = [{ id: WORKSPACE, is_charly_extension_enabled: true }];
    if (request.url === `/conversation/${CONVERSATION}`) data = { id: CONVERSATION, engine: 'deep_agents', mainAgent: { slug: 'charly' } };
    response.writeHead(authenticated ? 200 : 401, headers);
    response.end(JSON.stringify(data));
  });
  const io = new Server(server, { cors: { origin: APP, credentials: true }, transports: ['websocket'] });
  io.of('/conversation/live').on('connection', socket => {
    seen.connected += 1;
    seen.cookie = socket.handshake.headers.cookie?.includes('live_fixture=authenticated') === true;
    seen.origin = socket.handshake.headers.origin;
    socket.on('session.start', payload => {
      seen.starts += 1;
      seen.startPayload = payload;
      seen.browserBinding = { browserSession: payload.browserSession, browserContext: payload.browserContext };
      if (!seen.cookie || payload.expectedUserId !== USER || socket.handshake.auth.workspaceId !== WORKSPACE) return socket.disconnect();
      socket.emit('session.ready', { sessionId: SESSION, conversationId: CONVERSATION, userId: USER, workspaceId: WORKSPACE,
        clientSurface: 'chrome_extension', inputSampleRate: 16_000, outputSampleRate: 24_000, maxAudioFrameBytes: 2_560 });
    });
    socket.on('audio.append', payload => {
      seen.pcm = { sequence: payload.sequence, length: payload.audio.length };
      if (seen.action) return;
      seen.action = true;
      socket.emit('turn.deep_agent_stream.started', { sessionId: SESSION, turnId: VOICE_TURN });
      socket.emit('assistant.audio.delta', { sessionId: SESSION, sequence: 0, audio: Buffer.alloc(4800) });
      socket.emit('turn.deep_agent_stream.completed', { sessionId: SESSION, turnId: VOICE_TURN });
    });
    socket.on('response.cancel', payload => { seen.cancelled = payload.playedAudioMs; });
    socket.on('session.stop', () => { seen.stopped += 1; });
    socket.on('disconnect', () => { seen.disconnected += 1; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let context;
  try {
    const extension = path.resolve(process.env.EXTENSION_PATH ?? 'build');
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--ignore-certificate-errors', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP * ~NOTFOUND`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const app = await context.newPage(); await app.goto(APP);
    await app.evaluate(api => fetch(`${api}/fixture-login`, { credentials: 'include' }), API);
    await worker.evaluate(async ({ USER, WORKSPACE, CONVERSATION }) => {
      await chrome.storage.local.set({
        limova_deep_agent_context_v1: { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION },
        limova_ai_processing_consent_v1: true, limova_onboarding_dismissed: true,
      });
    }, { USER, WORKSPACE, CONVERSATION });
    const extensionPage = await context.newPage();
    const errors = [], legacyRequests = [];
    extensionPage.on('pageerror', error => errors.push(error.message));
    context.on('request', request => { if (request.url().includes('/api/live-session')) legacyRequests.push(request.url()); });
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/sidebar.html`);
    await expect(extensionPage.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
    await expect(extensionPage.locator('#limovaConversation')).toHaveValue(CONVERSATION);
    await extensionPage.locator('#voiceBtn').click();
    await expect.poll(() => seen.starts).toBe(1);
    await expect.poll(() => seen.pcm?.length).toBe(640);
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
    expect(seen.browserBinding).toEqual({ browserSession: undefined, browserContext: undefined });
    expect(seen.cookie).toBe(true); expect(seen.origin).toBe(APP);
    expect(seen.startPayload).toMatchObject({ conversationId: CONVERSATION, expectedUserId: USER, clientSurface: 'chrome_extension' });
    await expect(extensionPage.locator('#limovaConversation')).toBeDisabled();
    await worker.evaluate(() => chrome.storage.local.set({ limova_ai_processing_consent_v1: false }));
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => seen.disconnected).toBe(1);
    await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
    const sequence = seen.pcm.sequence;
    await extensionPage.waitForTimeout(200);
    expect(seen.pcm.sequence).toBe(sequence);
    expect(seen.connected).toBe(1); expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await new Promise(resolve => io.close(resolve));
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
});

