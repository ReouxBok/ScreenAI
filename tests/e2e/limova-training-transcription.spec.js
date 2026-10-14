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

for (const popupMode of ['sequential', 'overlapping']) test(`training preserves native PCM notes across ${popupMode} OAuth windows`, async () => {
  test.skip(environment.name === 'staging', 'The isolated staging package intentionally has no production Studio permission.');
  const directory = await mkdtemp(path.join(tmpdir(), 'limova-live-test-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=limova-live-test'], { stdio: 'ignore' });
  const notes = [], studioCalls = [], blobCalls = [], videoParts = [];
  let videoPath;
  let confirmationAttempts = 0;
  const training = { id: '88888888-8888-4888-8888-888888888888', title: 'Démonstration', agentKey: 'charly', startPath: '/' };
  const seen = { starts: 0, connected: 0, stopped: 0, disconnected: 0, pcm: null, cancelled: null, browserBinding: null, browserResult: null, results: [], action: null, httpChecks: [], cookie: false, origin: null };
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    if (request.headers.host === 'studio.limova.ai') {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const failedConfirmation = request.url.endsWith('/recording-confirm') && request.method === 'POST'
          && ++confirmationAttempts === 1 && popupMode === 'sequential';
        response.writeHead(failedConfirmation ? 503 : 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' });
        studioCalls.push({ path: request.url, method: request.method, body: body ? JSON.parse(body) : undefined, authorized: request.headers.authorization === 'Bearer local-training-fixture-token-no-secret' });
        if (request.url.endsWith('/recording-token') && request.method === 'POST') {
          const upload = JSON.parse(body);
          videoPath = upload.pathname;
          response.end(JSON.stringify({ clientToken: 'vercel_blob_client_fixture_localtoken' })); return;
        }
        if (request.url.endsWith('/events') && request.method === 'POST') notes.push(JSON.parse(body));
        response.end(JSON.stringify(request.url.endsWith('/connect') ? training : { ok: true }));
      }); return;
    }
    if (request.headers.host === new URL(APP).host) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<title>Live fixture</title><main>Browser knowledge fixture<button id="action">Connecter HubSpot<svg width="20" height="20"><circle cx="10" cy="10" r="8"></circle></svg></button><a id="safeNavigation" href="/profile">Ouvrir mon profil</a><textarea aria-label="Instructions">PRIVATE_FIELD_VALUE</textarea><input type="password" value="NEVER_TRANSMIT_THIS_SECRET"></main><script>window.clicks=0;document.getElementById("action").onclick=()=>window.clicks++;</script>'); return;
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
    if (request.url === `/conversation/${CONVERSATION}/messages`) data = { data: { data: [] } };
    if (request.url === '/users/me') data = { id: USER };
    if (request.url === '/workspaces') data = [{ id: WORKSPACE, is_charly_extension_enabled: true }];
    if (request.url === `/conversation/${CONVERSATION}`) data = { id: CONVERSATION, engine: 'deep_agents', mainAgent: { slug: 'charly' } };
    response.writeHead(authenticated ? 200 : 401, headers);
    response.end(JSON.stringify(data));
  });
  let transcriptionSocket;
  const io = new Server(server, { cors: { origin: APP, credentials: true }, transports: ['websocket'] });
  io.of('/voice/transcribe').on('connection', socket => {
    transcriptionSocket = socket;
    seen.connected += 1;
    seen.cookie = socket.handshake.headers.cookie?.includes('live_fixture=authenticated') === true;
    seen.origin = socket.handshake.headers.origin;
    socket.on('start_session', payload => {
      seen.starts += 1;
      seen.startPayload = payload;
      seen.browserBinding = { browserSession: payload.browserSession, browserContext: payload.browserContext };
      if (!seen.cookie || payload.expectedUserId !== USER || socket.handshake.auth.workspaceId !== WORKSPACE) return socket.disconnect();
      socket.emit('session_started', { sessionId: SESSION, userId: USER, workspaceId: WORKSPACE,
        clientSurface: 'chrome_extension', inputSampleRate: 16_000, maxAudioFrameBytes: 2_560 });
    });
    socket.on('audio_chunk', payload => {
      seen.pcm = { sequence: payload.sequence, length: Buffer.from(payload.audio, 'base64').length, sessionId: payload.sessionId };
      if (seen.action) return; seen.action = true;
      socket.emit('extension.action_requested', { input: { operation: 'click', elementId: 1 } });
      socket.emit('toolCall', { functionCalls: [{ name: 'request_page_action', args: { elementId: 1 } }] });
      socket.emit('partial_transcript', { text: 'Je sélectionne' });
      socket.emit('final_transcript', { text: 'Je sélectionne le compte HubSpot.' });
    });
    socket.on('response.cancel', payload => { seen.cancelled = payload.playedAudioMs; });
    socket.on('stop_session', () => { seen.stopped += 1; });
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
        `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP studio.limova.ai 127.0.0.1:${port}, MAP * ~NOTFOUND`],
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
    const errors = [], legacyRequests = [];
    extensionPage.on('pageerror', error => errors.push(error.message));
    context.on('request', request => { if (request.url().includes('/api/live-session')) legacyRequests.push(request.url()); });
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/sidebar.html`);
    await expect(extensionPage.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
    await expect(extensionPage.locator('#limovaConversation')).toHaveValue(CONVERSATION);
    await app.bringToFront();
    await extensionPage.locator('#menuBtn').click();
    await extensionPage.locator('#trainingBtn').click();
    await extensionPage.locator('#trainingToken').fill('local-training-fixture-token-no-secret');
    await context.route('https://vercel.com/api/blob/**', async route => {
      const request = route.request();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const action = request.headers()['x-mpu-action'];
      blobCalls.push(action);
      expect(new URL(request.url()).searchParams.get('pathname')).toBe(videoPath);
      expect(request.headers().authorization).toBe('Bearer vercel_blob_client_fixture_localtoken');
      if (action === 'create') return route.fulfill({ headers, body: JSON.stringify({ key: videoPath, uploadId: 'training-upload' }) });
      if (action === 'upload') {
        videoParts.push(request.postDataBuffer());
        return route.fulfill({ headers, body: JSON.stringify({ etag: 'training-part' }) });
      }
      expect(action).toBe('complete');
      expect(request.postDataJSON()).toEqual([{ partNumber: 1, etag: 'training-part' }]);
      return route.fulfill({ headers, body: JSON.stringify({ pathname: videoPath, url: `https://fixture.private.blob.vercel-storage.com/${videoPath}`, contentType: 'video/webm' }) });
    });
    // Substitute only OS display selection. Use the packaged recorder and Blob SDK.
    await extensionPage.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const drawing = canvas.getContext('2d'); let frame = 0;
      window.paintTraining = setInterval(() => {
        drawing.fillStyle = frame++ % 2 ? '#117744' : '#335588'; drawing.fillRect(0, 0, 320, 180);
      }, 50);
      window.trainingVideoStream = canvas.captureStream(12);
      navigator.mediaDevices.getDisplayMedia = async () => window.trainingVideoStream;
    });
    await extensionPage.locator('#trainingStart').click();
    await expect(extensionPage.locator('#trainingFeedback')).toContainText('mode passif');
    await extensionPage.locator('#trainingMic').click();
    await expect.poll(() => seen.starts).toBe(1);
    await expect.poll(() => seen.pcm?.length).toBe(640);
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
    expect(seen.browserBinding).toEqual({ browserSession: undefined, browserContext: undefined });
    expect(seen.cookie).toBe(true); expect(seen.origin).toBe(APP);
    expect(seen.startPayload).toMatchObject({ expectedUserId: USER, clientSurface: 'chrome_extension' });
    expect(seen.startPayload.conversationId).toBeUndefined();
    expect(seen.pcm.sessionId).toBe(SESSION);
    await expect.poll(() => notes.filter(note => note.kind === 'voice_note').map(note => note.label)).toEqual(['Je sélectionne le compte HubSpot.']);
    await expect(extensionPage.locator('#limovaConversation')).toBeDisabled();
    expect(await app.evaluate(() => window.clicks)).toBe(0);
    expect(seen.httpChecks.filter(call => call.method === 'POST')).toEqual([]);
    await expect(extensionPage.locator('.message.user, .message.assistant')).toHaveCount(0);
    expect(JSON.stringify(notes)).not.toMatch(/PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET/);
    await app.locator('textarea').fill('TRAINING_PRIVATE_TYPED_VALUE');
    await app.locator('textarea').blur();
    await app.locator('#action circle').click();
    await app.evaluate(() => fetch('/api/integrations/connect', { method: 'POST' }));
    await app.evaluate(() => {
      const modal = document.createElement('div'); modal.setAttribute('role', 'dialog');
      modal.innerHTML = '<h2>Connecter HubSpot</h2><button>Continuer</button>';
      document.body.append(modal);
    });
    await expect.poll(() => JSON.stringify(notes)).toContain('Popup Limova · Connecter HubSpot');
    await expect.poll(() => notes.some(note => note.label === 'Résultat après clic · Connecter HubSpot'
      && note.payload?.networkSummary?.includes('POST /api/integrations/connect status:200'))).toBe(true);
    expect(notes).toContainEqual(expect.objectContaining({ kind: 'click', label: 'Connecter HubSpot',
      payload: expect.objectContaining({ controlName: 'Connecter HubSpot', controlType: 'bouton', tag: 'button',
        clickedTag: 'circle', elementId: 'action', zone: 'main', occurrence: 1, gestureId: expect.stringMatching(/^[-a-z0-9]+$/i) }) }));
    await context.route('https://accounts.google.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<title>OAuth fixture</title><input type="password" value="OAUTH_PRIVATE_PASSWORD"><p>OAUTH_PRIVATE_CONTENT</p>',
    }));
    const openPopup = async name => {
      const opened = context.waitForEvent('page');
      await app.evaluate(name => window.open(
        `https://accounts.google.com/o/oauth2/v2/auth?state=OAUTH_PRIVATE_STATE&window=${name}`,
        name, 'popup,width=500,height=620'), name);
      const popup = await opened;
      await popup.waitForLoadState();
      await popup.bringToFront();
      return popup;
    };
    const firstPopup = await openPopup('first-account-chooser');
    await expect(extensionPage.locator('#trainingFeedback')).toContainText('Fenêtre de connexion externe ouverte');
    await expect(extensionPage.locator('#tabWarning')).toBeHidden();
    await expect(extensionPage.locator('#limovaReturnTab')).toBeHidden();
    if (popupMode === 'sequential') {
      await firstPopup.close();
      // Exercise Google's short gap between account chooser and consent window.
      await extensionPage.waitForTimeout(800);
    }
    expect(notes.filter(note => note.label === 'Fenêtre d’autorisation externe fermée')).toHaveLength(0);
    const secondPopup = await openPopup('second-consent');
    if (popupMode === 'overlapping') {
      await firstPopup.close();
      await expect(extensionPage.locator('#trainingFeedback')).toContainText('Fenêtre de connexion externe ouverte');
      expect(notes.filter(note => note.label === 'Fenêtre d’autorisation externe fermée')).toHaveLength(0);
    }
    await expect(extensionPage.locator('#tabWarning')).toBeHidden();
    await expect(extensionPage.locator('#limovaReturnTab')).toBeHidden();
    await secondPopup.close();
    await expect(extensionPage.locator('#trainingFeedback')).toContainText('Charly relit maintenant', { timeout: 6000 });
    await expect.poll(() => notes.filter(note => note.label === 'Fenêtre d’autorisation externe fermée').length).toBe(1);
    expect(notes.filter(note => note.label === 'Fenêtre d’autorisation externe ouverte')).toHaveLength(1);
    expect(notes.find(note => note.label === 'Fenêtre d’autorisation externe fermée')).toMatchObject({
      payload: { phase: 'closed', popupCount: 2 },
    });
    expect(JSON.stringify(notes)).not.toMatch(/OAUTH_PRIVATE|PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET/);
    expect(await extensionPage.evaluate(() => window.trainingVideoStream.getTracks().every(track => track.readyState === 'live'))).toBe(true);
    await app.locator('#safeNavigation').click();
    await expect.poll(() => JSON.stringify(notes)).toContain('Ouvrir mon profil');
    await expect(app).toHaveURL(`${APP}/profile`);
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
    expect((await worker.evaluate(async origin => chrome.tabs.query({ url: `${origin}/*` }), APP))).toHaveLength(2);
    const afterNavigationSequence = seen.pcm.sequence;
    await expect.poll(() => seen.pcm.sequence).toBeGreaterThan(afterNavigationSequence);
    expect(seen.disconnected).toBe(0);
    transcriptionSocket.emit('final_transcript', { text: 'Le profil est maintenant ouvert.' });
    await expect.poll(() => notes.filter(note => note.kind === 'voice_note').map(note => note.label))
      .toEqual(['Je sélectionne le compte HubSpot.', 'Le profil est maintenant ouvert.']);
    await worker.evaluate(() => chrome.storage.local.set({ limova_ai_processing_consent_v1: false }));
    await expect(extensionPage.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => seen.disconnected).toBe(1);
    await expect.poll(() => worker.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/*` })).length, APP)).toBe(1);
    await expect(extensionPage.locator('#limovaConversation')).toBeEnabled();
    const sequence = seen.pcm.sequence;
    await extensionPage.waitForTimeout(200);
    expect(seen.pcm.sequence).toBe(sequence);

    await extensionPage.locator('#trainingStop').click();
    if (popupMode === 'sequential') {
      await expect(extensionPage.locator('#trainingStop')).toHaveText('Réessayer l’envoi de la vidéo');
      await expect(extensionPage.locator('#trainingStop')).toBeEnabled();
      expect(studioCalls.filter(call => call.path.endsWith('/complete') && call.method === 'POST')).toHaveLength(0);
      expect(blobCalls).toEqual(['create', 'upload', 'complete']);
      await extensionPage.locator('#trainingStop').click();
    }
    await expect(extensionPage.locator('#trainingFeedback')).toContainText('Démonstration et vidéo enregistrées');
    expect(blobCalls).toEqual(['create', 'upload', 'complete']);
    expect(videoParts).toHaveLength(1);
    expect([...videoParts[0].subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    const confirmation = studioCalls.filter(call => call.path.endsWith('/recording-confirm') && call.method === 'POST');
    expect(confirmation).toHaveLength(popupMode === 'sequential' ? 2 : 1);
    if (popupMode === 'sequential') expect(confirmation[0].body).toEqual(confirmation[1].body);
    expect(confirmation[0].body).toMatchObject({ sessionId: training.id, pathname: videoPath });
    expect(confirmation[0].body.durationMs).toBeGreaterThan(1000);
    expect(videoPath).toMatch(new RegExp(`^training-recordings/${training.id}/`));
    expect(studioCalls.findIndex(call => call.path.endsWith('/recording-confirm') && call.method === 'POST'))
      .toBeLessThan(studioCalls.findIndex(call => call.path.endsWith('/complete') && call.method === 'POST'));
    expect(await extensionPage.evaluate(() => {
      clearInterval(window.paintTraining);
      return window.trainingVideoStream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }));
    })).toEqual(expect.arrayContaining([{ kind: 'video', state: 'ended' }, { kind: 'audio', state: 'ended' }]));
    const dimensions = await extensionPage.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      try {
        const video = document.createElement('video'); video.muted = true;
        const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
        video.src = url; await loaded;
        return [video.videoWidth, video.videoHeight];
      } finally { URL.revokeObjectURL(url); }
    }, videoParts[0].toString('base64'));
    expect(dimensions).toEqual([320, 180]);
    expect(JSON.stringify(notes)).not.toMatch(/OAUTH_PRIVATE|TRAINING_PRIVATE_TYPED_VALUE|PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET/);
    expect(notes.filter(note => note.kind === 'voice_note').map(note => note.label)).toEqual(['Je sélectionne le compte HubSpot.', 'Le profil est maintenant ouvert.']);
    expect(JSON.stringify(notes)).toContain('Instructions');
    expect(studioCalls.find(call => call.path.endsWith('/connect') && call.method === 'POST')?.body)
      .toEqual({ token: 'local-training-fixture-token-no-secret' });
    expect(studioCalls.filter(call => call.method === 'POST' && !call.path.endsWith('/connect')).every(call => call.authorized)).toBe(true);
    expect(studioCalls.filter(call => call.path.endsWith('/complete') && call.method === 'POST')).toHaveLength(1);
    expect(seen.connected).toBe(1); expect(legacyRequests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await new Promise(resolve => io.close(resolve));
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  }
});
