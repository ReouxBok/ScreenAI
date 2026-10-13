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

for (const browserDriver of [false, true]) {
test(`live transport ${browserDriver ? 'with real DOM driver and journal' : 'wire contract'} uses first-party cookies and stops when the app closes`, async () => {
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
      seen.browserBinding = { browserSession: payload.browserSession, browserContext: payload.browserContext };
      if (!seen.cookie || payload.expectedUserId !== USER || socket.handshake.auth.workspaceId !== WORKSPACE) return socket.disconnect();
      socket.emit('session.ready', { sessionId: SESSION, conversationId: CONVERSATION, userId: USER, workspaceId: WORKSPACE,
        clientSurface: 'chrome_extension', inputSampleRate: 16_000, outputSampleRate: 24_000, maxAudioFrameBytes: 2_560 });
    });
    const startNativeTurn = () => {
      socket.emit('turn.deep_agent_stream.started', { sessionId: SESSION, turnId: VOICE_TURN });
      seen.action = { type: 'extension.action_requested', protocolVersion: 1, turnId: BROWSER_TURN, actionId: 'action-1', toolCallId: 'tool-1', target: seen.browserBinding.browserContext, input: { operation: 'read_page' }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const frames = [...(browserDriver ? [seen.action] : []), { type: 'extension.turn_state', state: 'waiting', turnId: BROWSER_TURN }];
      socket.emit('turn.deep_agent_stream.delta', { sessionId: SESSION, turnId: VOICE_TURN, chunk: Buffer.from(frames.map(data => `event: custom\ndata: ${JSON.stringify(data)}\n\n`).join('')) });
      socket.emit('assistant.audio.delta', { sessionId: SESSION, sequence: 0, audio: Buffer.from([0, 128, 255, 127]) });
    };
    socket.on('audio.append', payload => {
      seen.pcm = { sequence: payload.sequence, bytes: Array.from(payload.audio) };
      if (browserDriver) socket.emit('turn.browser_context_requested', { sessionId: SESSION, turnId: VOICE_TURN, requestId: USER });
      else startNativeTurn();
    });
    socket.on('turn.browser_context', payload => {
      seen.contextReply = payload;
      if (payload.sessionId !== SESSION || payload.turnId !== VOICE_TURN || payload.requestId !== USER) return socket.disconnect();
      seen.browserBinding.browserContext = payload.browserContext;
      startNativeTurn();
    });
    socket.on('turn.browser_continue', payload => {
      seen.browserResult = payload;
      seen.results.push(payload);
      if (browserDriver && seen.results.length === 1) {
        const frames = [seen.action, { type: 'extension.turn_state', state: 'waiting', turnId: BROWSER_TURN }];
        socket.emit('turn.deep_agent_stream.delta', { sessionId: SESSION, turnId: VOICE_TURN, chunk: Buffer.from(frames.map(data => `event: custom\ndata: ${JSON.stringify(data)}\n\n`).join('')) });
        return;
      }
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
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--ignore-certificate-errors',
        `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP * ~NOTFOUND`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/microphone-permission.html`);
    const app = await context.newPage(); await app.goto(APP);
    await app.evaluate(api => fetch(`${api}/fixture-login`, { credentials: 'include' }), API);
    await extensionPage.evaluate(async ({ USER, WORKSPACE, CONVERSATION, BROWSER_SESSION, PAGE, browserDriver }) => {
      const { createLimovaLiveTransport } = await import(chrome.runtime.getURL('src/limova/live-transport.js'));
      globalThis.liveEvents = []; globalThis.liveErrors = [];
      let start = createLimovaLiveTransport(chrome);
      if (browserDriver) {
        const { createBrowserLiveSession } = await import(chrome.runtime.getURL('src/limova/live-browser-session.js'));
        const { createBrowserJournal } = await import(chrome.runtime.getURL('src/limova/browser-journal.js'));
        const { createBrowserDriver } = await import(chrome.runtime.getURL('src/limova/browser-driver.js'));
        const { LimovaDeepAgentClient } = await import(chrome.runtime.getURL('src/limova/client.js'));
        const { createLimovaSessionFetch } = await import(chrome.runtime.getURL('src/limova/session-fetch.js'));
        globalThis.executions = 0;
        start = createBrowserLiveSession({ openTransport: start, journal: createBrowserJournal(),
          client: new LimovaDeepAgentClient(createLimovaSessionFetch(chrome)),
          createDriver: options => {
            const driver = createBrowserDriver({ ...options, chrome, hasConsent: async () => true });
            const execute = driver.execute;
            driver.execute = (...args) => { globalThis.executions += 1; return execute(...args); };
            return driver;
          },
        });
      }
      globalThis.live = await start({ context: { userId: USER, workspaceId: WORKSPACE },
        browserSession: BROWSER_SESSION, browserContext: PAGE,
        conversationId: CONVERSATION, languageCode: 'fr', userTimezone: 'Europe/Paris',
        onEvent: (event, payload) => { globalThis.liveEvents.push({ event, payload }); },
        onError: error => { globalThis.liveErrors.push(error.message); },
      });
      globalThis.live.sendAudio(new Uint8Array([0, 128, 255, 127]));
    }, { USER, WORKSPACE, CONVERSATION, BROWSER_SESSION, PAGE, browserDriver });
    await expect.poll(() => seen.pcm).toEqual({ sequence: 0, bytes: [0, 128, 255, 127] });
    await expect.poll(() => extensionPage.evaluate(() => globalThis.liveEvents.some(item => item.event === 'turn.deep_agent_stream.delta'))).toBe(true);
    if (!browserDriver) expect(seen.browserBinding).toEqual({ browserSession: BROWSER_SESSION, browserContext: PAGE });
    const continuation = { turnId: VOICE_TURN, kind: 'browser_tool_result', browserContext: PAGE,
      browserResult: { turnId: BROWSER_TURN, actionId: 'action-1', toolCallId: 'tool-1', contextVersion: 1, status: 'completed', observation: 'Page inspectée' } };
    if (!browserDriver) {
      await extensionPage.evaluate(payload => globalThis.live.continueBrowser(payload), continuation);
      await expect.poll(() => seen.browserResult).toEqual({ sessionId: SESSION, ...continuation });
    } else {
      await expect.poll(() => seen.results.length).toBe(2);
      expect(seen.contextReply).toMatchObject({ sessionId: SESSION, turnId: VOICE_TURN, requestId: USER, browserContext: seen.browserBinding.browserContext });
      expect(seen.results[0].browserResult).toEqual(seen.results[1].browserResult);
      expect(seen.browserResult).toMatchObject({ sessionId: SESSION, turnId: VOICE_TURN,
        browserResult: { turnId: BROWSER_TURN, actionId: 'action-1', status: 'completed' } });
      expect(seen.browserResult.browserResult.observation).toContain('Browser knowledge fixture');
      expect(await extensionPage.evaluate(() => globalThis.executions)).toBe(1);
      expect(seen.httpChecks.length).toBeGreaterThanOrEqual(6);
      expect(seen.httpChecks.every(check => check.authenticated)).toBe(true);
      expect(seen.httpChecks.filter(check => check.path.startsWith('/conversation/')).every(check => check.workspaceId === WORKSPACE)).toBe(true);
    }
    await expect.poll(() => extensionPage.evaluate(() => globalThis.liveEvents.some(item => item.event === 'turn.deep_agent_stream.completed'))).toBe(true);
    await extensionPage.evaluate(() => globalThis.live.cancel(120));
    await expect.poll(() => seen.cancelled).toBe(120);
    expect(seen.cookie).toBe(true); expect(seen.origin).toBe(APP);
    await expect.poll(() => extensionPage.evaluate(() => globalThis.liveEvents.find(item => item.event === 'assistant.audio.delta')?.payload.audio)).toEqual([0, 128, 255, 127]);
    await app.close();
    await expect.poll(() => seen.disconnected).toBe(1);
    await expect.poll(() => extensionPage.evaluate(() => globalThis.liveErrors.length)).toBe(1);
    expect(await extensionPage.evaluate(() => {
      try { globalThis.live.sendAudio(new Uint8Array([0, 0])); return false; } catch { return true; }
    })).toBe(true);
    expect(seen.starts).toBe(1); expect(seen.connected).toBe(1);
  } finally {
    await context?.close();
    await new Promise(resolve => io.close(resolve));
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
});

}
