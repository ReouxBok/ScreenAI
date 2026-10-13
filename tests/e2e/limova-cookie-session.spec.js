import { test as base, expect, chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = 'https://new.limova.ai';
const API = 'https://api.new.limova.ai';
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

const test = base.extend({
  sessionFixture: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'limova-cookie-test-'));
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=limova-cookie-test'], { stdio: 'ignore' });
    const observations = [];
    const state = { partitioned: true, expired: false, user: USER, enabled: true, refreshCount: 0,
      upload: null, stream: null, streamClosed: false, expireMessage: false, switchUserOnRefresh: false, userByToken: false,
      holdApp: false, appLoading: false };
    const cookie = (name, value, cookiePath = '/', clear = false) =>
      `${name}=${value}; Path=${cookiePath}; HttpOnly; Secure; SameSite=None${state.partitioned ? '; Partitioned' : ''}${clear ? '; Max-Age=0' : ''}`;
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
      const url = new URL(request.url, API);
      if (request.headers.host === 'new.limova.ai') {
        response.writeHead(200, { 'content-type': 'text/html' });
        if (state.holdApp) { state.appLoading = true; response.write('<!doctype html>'); return; }
        return response.end('<!doctype html><title>Limova cookie fixture</title>');
      }
      const firstAccess = request.headers.cookie?.split(';').map(part => part.trim())
        .find(part => part.startsWith('limova_prod_access_token='))?.split('=')[1];
      const access = firstAccess === 'fixture-access' || state.userByToken && firstAccess === 'fixture-other';
      const refresh = request.headers.cookie?.includes('limova_prod_refresh_token=fixture-refresh') ?? false;
      observations.push({ path: url.pathname, method: request.method, access, refresh });
      const headers = { 'access-control-allow-origin': APP, 'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type,x-workspace-id,x-extension-session',
        'content-type': 'application/json' };
      if (request.method === 'OPTIONS') { response.writeHead(204, headers); return response.end(); }
      if (url.pathname === '/fixture-login') {
        response.writeHead(200, { ...headers, 'set-cookie': [
          cookie('limova_prod_access_token', state.expired ? 'fixture-expired' : 'fixture-access'),
          cookie('limova_prod_refresh_token', 'fixture-refresh', '/auth'),
        ] });
        return response.end('{}');
      }
      if (url.pathname === '/auth/refresh-token') {
        state.refreshCount += 1;
        if (state.switchUserOnRefresh) state.user = AGENT;
        response.writeHead(refresh ? 200 : 401, { ...headers, ...(refresh ? { 'set-cookie': [
          cookie('limova_prod_access_token', 'fixture-access'),
          cookie('limova_prod_refresh_token', 'fixture-refresh', '/auth'),
        ] } : {}) });
        return response.end(JSON.stringify({ accessToken: 'must-not-cross-bridge', refreshToken: 'must-not-cross-bridge' }));
      }
      if (url.pathname === '/auth/logout') {
        response.writeHead(200, { ...headers, 'set-cookie': [
          cookie('limova_prod_access_token', '', '/', true),
          cookie('limova_prod_refresh_token', '', '/auth', true),
        ] });
        return response.end('{}');
      }
      if (!access || state.expireMessage && url.pathname === `/message/${CONVERSATION}`) {
        if (url.pathname === `/message/${CONVERSATION}`) state.expireMessage = false;
        response.writeHead(401, headers); return response.end('{}');
      }
      if (url.pathname === '/files') {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          state.upload = { body: Buffer.concat(chunks), contentType: request.headers['content-type'], query: url.search };
          response.writeHead(200, headers); response.end(JSON.stringify({ id: AGENT }));
        });
        return;
      }
      if (url.pathname === `/message/${CONVERSATION}`) {
        response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        response.write('event: messages\ndata: {"text":"Bonjour é 👋"}\n\n');
        state.stream = response;
        response.on('close', () => { state.streamClosed = true; });
        return;
      }
      let data = {};
      if (url.pathname === '/users/me') data = { id: state.userByToken && firstAccess === 'fixture-other' ? AGENT : state.user };
      if (url.pathname === '/workspaces') data = [{ id: WORKSPACE, is_charly_extension_enabled: state.enabled }];
      if (url.pathname === '/agent/by-slug/charly') data = { id: AGENT, slug: 'charly' };
      if (url.pathname === '/conversation' || url.pathname === `/conversation/${CONVERSATION}`)
        data = { id: CONVERSATION, engine: 'deep_agents', mainAgent: { id: AGENT, slug: 'charly' } };
      response.writeHead(200, headers); response.end(JSON.stringify(data));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const extensionPath = path.resolve(process.env.EXTENSION_PATH ?? 'build');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        '--no-proxy-server', '--ignore-certificate-errors',
        `--host-resolver-rules=MAP api.new.limova.ai 127.0.0.1:${port}, MAP new.limova.ai 127.0.0.1:${port}, MAP * ~NOTFOUND`,
      ],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/microphone-permission.html`);
      await use({ context, worker, page, observations, state });
    } finally {
      await context.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('measures whether the extension shares the app partitioned authentication cookies', async ({ sessionFixture }) => {
  const { context, worker, observations } = sessionFixture;
  const app = await context.newPage();
  await app.goto(APP);
  expect(await app.evaluate(async api => (await fetch(`${api}/fixture-login`, { credentials: 'include' })).status, API)).toBe(200);
  expect((await context.cookies(API)).filter(cookie => cookie.name.endsWith('access_token')).map(({ name, partitionKey }) => ({ name, partitionKey })))
    .toEqual([{ name: 'limova_prod_access_token', partitionKey: 'https://limova.ai' }]);
  expect(await app.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).status, API)).toBe(200);
  const direct = await worker.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).status, API);
  expect(direct).toBe(401);
  expect(observations.filter(item => item.path === '/users/me').map(item => item.access)).toEqual([true, false]);
});


test('the client authenticates through the app partition without copying cookies', async ({ sessionFixture }) => {
  const { context, worker, page, observations } = sessionFixture;
  const app = await context.newPage();
  await app.goto(APP);
  await app.evaluate(async api => (await fetch(`${api}/fixture-login`, { credentials: 'include' })).status, API);
  const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LIMOVA_GET_STATE' }));
  expect(result.user.id).toBe(USER);
  expect(result.workspaces).toEqual([{ id: WORKSPACE, name: '', enabled: true }]);
  expect(observations.filter(item => item.path === '/users/me').map(item => item.access)).toEqual([true]);
  expect((await context.cookies(API)).filter(cookie => cookie.name.endsWith('access_token')).map(({ name, partitionKey }) => ({ name, partitionKey })))
    .toEqual([{ name: 'limova_prod_access_token', partitionKey: 'https://limova.ai' }]);
  expect(await worker.evaluate(() => chrome.permissions.contains({ permissions: ['cookies'] }))).toBe(false);
});


async function login({ context }) {
  const app = await context.newPage();
  await app.goto(APP);
  await app.evaluate(async api => (await fetch(`${api}/fixture-login`, { credentials: 'include' })).status, API);
  return app;
}

async function prepareClient({ page }) {
  await page.evaluate(async () => {
    const { LimovaDeepAgentClient } = await import(chrome.runtime.getURL('src/limova/client.js'));
    const { createLimovaSessionFetch } = await import(chrome.runtime.getURL('src/limova/session-fetch.js'));
    globalThis.sessionFetch = createLimovaSessionFetch(chrome);
    globalThis.sessionClient = new LimovaDeepAgentClient(globalThis.sessionFetch);
  });
}

test('renews the app refresh cookie once for concurrent expired requests', async ({ sessionFixture }) => {
  sessionFixture.state.expired = true;
  await login(sessionFixture);
  await prepareClient(sessionFixture);
  const results = await sessionFixture.page.evaluate(() => Promise.all([
    sessionClient.bootstrap(), sessionClient.bootstrap(), sessionClient.bootstrap(),
  ]));
  expect(results.every(result => result.user.id === USER)).toBe(true);
  expect(sessionFixture.state.refreshCount).toBe(1);
  const refreshes = sessionFixture.observations.filter(item => item.path === '/auth/refresh-token');
  expect(refreshes).toEqual([{ path: '/auth/refresh-token', method: 'POST', access: false, refresh: true }]);
  expect(await sessionFixture.page.evaluate(async () => (await sessionFetch('https://api.new.limova.ai/auth/refresh-token',
    { method: 'POST', credentials: 'include' })).text())).toBe('');
});

test('reuses an ordinary cookie in the same first-party transport without another login', async ({ sessionFixture }) => {
  sessionFixture.state.partitioned = false;
  const app = await login(sessionFixture);
  await app.close();
  const initialPages = sessionFixture.context.pages().length;
  await prepareClient(sessionFixture);
  const result = await sessionFixture.page.evaluate(() => sessionClient.bootstrap());
  expect(result.user.id).toBe(USER);
  expect(sessionFixture.context.pages()).toHaveLength(initialPages + 1);
  expect(sessionFixture.state.refreshCount).toBe(0);
});

test('reopens an app tab in the background when the partitioned session tab was closed', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  await app.close();
  await prepareClient(sessionFixture);
  expect((await sessionFixture.page.evaluate(() => sessionClient.bootstrap())).user.id).toBe(USER);
  const tabs = await sessionFixture.worker.evaluate(() => chrome.tabs.query({ url: 'https://new.limova.ai/*' }));
  expect(tabs).toHaveLength(1);
  expect(tabs[0].active).toBe(false);
});

test('streams incrementally and uploads the masked image through the same app session', async ({ sessionFixture }) => {
  await login(sessionFixture);
  await prepareClient(sessionFixture);
  const { page, state } = sessionFixture;
  await page.evaluate(({ userId, workspaceId, conversationId }) => {
    globalThis.receivedEvents = [];
    globalThis.streamDone = (async () => {
      for await (const event of sessionClient.sendMessage({ userId, workspaceId }, conversationId, 'Bonjour')) receivedEvents.push(event);
    })();
  }, { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION });
  await expect.poll(() => page.evaluate(() => receivedEvents.length)).toBe(1);
  expect(await page.evaluate(() => receivedEvents[0].data.text)).toBe('Bonjour é 👋');
  state.stream.end(`event: messages\ndata: ${JSON.stringify({ text: 'é'.repeat(20_000) })}\n\n`);
  await page.evaluate(() => streamDone);
  expect(await page.evaluate(() => receivedEvents[1].data.text.length)).toBe(20_000);
  const result = await page.evaluate(({ userId, workspaceId, conversationId }) =>
    sessionClient.uploadBrowserScreenshot({ userId, workspaceId }, conversationId,
      new Blob(['masked-image-fixture'], { type: 'image/png' })),
  { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION });
  expect(result).toEqual({ fileId: AGENT });
  expect(state.upload.contentType).toContain('multipart/form-data; boundary=');
  expect(state.upload.body.toString()).toContain('masked-image-fixture');
  expect(state.upload.body.toString()).toContain('filename="browser-screenshot.png"');
  expect(state.upload.query).toBe('?isTemporary=true&useAsDefaultContext=false');
});

test('does not replay a message under another account after refresh', async ({ sessionFixture }) => {
  await login(sessionFixture);
  await prepareClient(sessionFixture);
  sessionFixture.state.expireMessage = true;
  sessionFixture.state.switchUserOnRefresh = true;
  const result = await sessionFixture.page.evaluate(async ({ userId, workspaceId, conversationId }) => {
    try {
      for await (const _event of sessionClient.sendMessage({ userId, workspaceId }, conversationId, 'Private question')) {}
      return 'unexpected';
    } catch (error) { return error.code; }
  }, { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION });
  expect(result).toBe('LIMOVA_ACCOUNT_CHANGED');
  expect(sessionFixture.observations.filter(item => item.path === `/message/${CONVERSATION}` && item.method === 'POST')).toHaveLength(1);
});

test('logout clears the app partition and the extension no longer authenticates', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  await prepareClient(sessionFixture);
  await sessionFixture.page.evaluate(async () => { await sessionClient.bootstrap(); await sessionClient.logout(); });
  expect(await app.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).status, API)).toBe(401);
  expect(await sessionFixture.page.evaluate(async () => {
    try { await sessionClient.bootstrap(); return 'unexpected'; } catch (error) { return error.code; }
  })).toBe('LIMOVA_LOGIN_REQUIRED');
});

test('closing the app during a stream stops the request without replaying it', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  await prepareClient(sessionFixture);
  const { page, state, observations } = sessionFixture;
  await page.evaluate(({ userId, workspaceId, conversationId }) => {
    globalThis.received = 0;
    globalThis.failure = null;
    globalThis.pendingStream = (async () => {
      try {
        for await (const _event of sessionClient.sendMessage({ userId, workspaceId }, conversationId, 'Bonjour')) received++;
      } catch (error) { failure = error.code; }
    })();
  }, { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION });
  await expect.poll(() => page.evaluate(() => received)).toBe(1);
  await app.close();
  await page.evaluate(() => pendingStream);
  expect(await page.evaluate(() => failure)).toBe('LIMOVA_APP_SESSION_UNAVAILABLE');
  await expect.poll(() => state.streamClosed).toBe(true);
  expect(observations.filter(item => item.path === `/message/${CONVERSATION}` && item.method === 'POST')).toHaveLength(1);
});

test('cancelling a stream aborts its app fetch', async ({ sessionFixture }) => {
  await login(sessionFixture);
  await prepareClient(sessionFixture);
  const { page, state } = sessionFixture;
  await page.evaluate(({ userId, workspaceId, conversationId }) => {
    globalThis.received = 0;
    globalThis.failure = null;
    globalThis.controller = new AbortController();
    globalThis.pendingStream = (async () => {
      try {
        for await (const _event of sessionClient.sendMessage({ userId, workspaceId }, conversationId, 'Bonjour', controller.signal)) received++;
      } catch (error) { failure = error.name; }
    })();
  }, { userId: USER, workspaceId: WORKSPACE, conversationId: CONVERSATION });
  await expect.poll(() => page.evaluate(() => received)).toBe(1);
  await page.evaluate(() => controller.abort());
  await page.evaluate(() => pendingStream);
  expect(await page.evaluate(() => failure)).toBe('AbortError');
  await expect.poll(() => state.streamClosed).toBe(true);
});

test('the app bridge rejects arbitrary destinations, cookie headers and non-allowlisted paths', async ({ sessionFixture }) => {
  await login(sessionFixture);
  await prepareClient(sessionFixture);
  await sessionFixture.page.evaluate(() => sessionClient.bootstrap());
  const count = sessionFixture.observations.length;
  for (const request of [
    { url: 'https://example.com/users/me', method: 'GET' },
    { url: `${API}/auth/login`, method: 'POST' },
    { url: `${API}/users/me`, method: 'GET', headers: { Cookie: 'injected' } },
    { url: `${API}/users/me`, method: 'DELETE' },
  ]) {
    const result = await sessionFixture.page.evaluate(async request => {
      const [tab] = await chrome.tabs.query({ url: 'https://new.limova.ai/*' });
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
      const port = chrome.tabs.connect(tab.id, { documentId: frame.documentId, name: 'limova-app-session-v1' });
      return new Promise(resolve => {
        port.onMessage.addListener(message => { port.disconnect(); resolve(message.kind); });
        port.postMessage({ kind: 'request', request });
      });
    }, request);
    expect(result).toBe('error');
  }
  expect(sessionFixture.observations).toHaveLength(count);
});

test('uses the open app identity when an ordinary cookie belongs to another account', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  sessionFixture.state.userByToken = true;
  await sessionFixture.context.addCookies([{ name: 'limova_prod_access_token', value: 'fixture-other',
    domain: 'api.new.limova.ai', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
  const appUser = await app.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).json(), API);
  const directUser = await sessionFixture.worker.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).json(), API);
  expect(appUser.id).toBe(USER);
  expect(directUser.id).toBe(AGENT);
  await prepareClient(sessionFixture);
  expect((await sessionFixture.page.evaluate(() => sessionClient.bootstrap())).user.id).toBe(appUser.id);
});

test('cancels while the app is loading before sending an authenticated request', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  await app.close();
  sessionFixture.state.holdApp = true;
  await prepareClient(sessionFixture);
  await sessionFixture.page.evaluate(() => {
    globalThis.controller = new AbortController();
    globalThis.failure = null;
    globalThis.pendingBootstrap = sessionClient.bootstrap(controller.signal).catch(error => { failure = error.name; });
  });
  await expect.poll(() => sessionFixture.state.appLoading).toBe(true);
  await sessionFixture.page.evaluate(() => controller.abort());
  await expect.poll(() => sessionFixture.page.evaluate(() => failure)).toBe('AbortError');
  expect(sessionFixture.observations.filter(item => item.path === '/users/me' && item.access)).toHaveLength(0);
});

test('keeps the first-party identity after its tab closes even when another ordinary session is valid', async ({ sessionFixture }) => {
  const app = await login(sessionFixture);
  sessionFixture.state.userByToken = true;
  await sessionFixture.context.addCookies([{ name: 'limova_prod_access_token', value: 'fixture-other',
    domain: 'api.new.limova.ai', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
  expect((await app.evaluate(async api => (await fetch(`${api}/users/me`, { credentials: 'include' })).json(), API)).id).toBe(USER);
  await app.close();
  await prepareClient(sessionFixture);
  expect((await sessionFixture.page.evaluate(() => sessionClient.bootstrap())).user.id).toBe(USER);
});

test('offers the existing app tab for login without creating a duplicate', async ({ sessionFixture }) => {
  const { page, worker } = sessionFixture;
  expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LIMOVA_GET_STATE' }))).authenticated).toBe(false);
  const before = await worker.evaluate(() => chrome.tabs.query({ url: 'https://new.limova.ai/*' }));
  expect(before).toHaveLength(1);
  expect(before[0].active).toBe(false);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LIMOVA_OPEN_APP' }));
  const after = await worker.evaluate(() => chrome.tabs.query({ url: 'https://new.limova.ai/*' }));
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before[0].id);
  expect(after[0].active).toBe(true);
});
