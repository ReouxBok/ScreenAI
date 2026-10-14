import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const environment = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');
const APP = environment.appOrigin, API = environment.apiOrigin;
const id = n => `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) + '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12);
const USER = id(1), WORKSPACE = id(2), AGENT = id(3), PERSONAL = id(4), EVALUATION = id(5), TURN = id(6);
const CODE = 'local-studio-evaluation-fixture-code';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

for (const scenario of ['success', 'verification_failure', 'manual_voice', 'manual_delivery_failure']) test(`Studio native evaluation ${scenario}`, async () => {
  const verificationUnavailable = scenario === 'verification_failure';
  const manual = scenario.startsWith('manual_');
  const manualUnavailable = scenario === 'manual_delivery_failure';
  test.skip(environment.name === 'staging', 'Staging intentionally has no production Studio permission.');
  const directory = await mkdtemp(path.join(tmpdir(), 'limova-evaluation-test-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=limova-evaluation-test'], { stdio: 'ignore' });
  const evidence = [], mutations = [], errors = [], legacy = [];
  let actionCount = 0, elementId, completed = false, completionRequests = 0, context;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': request.headers.origin || APP,
        'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type,authorization,x-workspace-id,x-extension-session,x-limova-evaluation-code',
        'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const json = (data, status = 200) => { response.writeHead(status, headers); response.end(JSON.stringify(data)); };
      if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
      const body = raw ? JSON.parse(raw) : {};
      if (request.headers.host === 'studio.limova.ai') {
        if (request.headers.authorization !== `Bearer ${CODE}`) return json({ error: 'grant' }, 403);
        if (request.url.endsWith('/connect')) return json({ run: { id: TURN }, case: { kind: 'live_action', title: 'Connect', prompt: 'Connect the integration' }, content: { id: AGENT, title: 'Connection', versionId: TURN } });
        if (request.url.endsWith('/events')) { evidence.push(body); return json({ ok: !verificationUnavailable }, (verificationUnavailable && body.kind === 'native_verification') || (manualUnavailable && body.kind === 'manual_intervention') ? 503 : 200); }
        if (request.url.endsWith('/complete')) {
          completionRequests += 1;
          completed = evidence.some(item => item.kind === 'native_verification' && item.observation.text.includes('Connection status: Connected'))
            && evidence.some(item => item.kind === 'response' && item.status === 'ok');
          return json({ run: { status: completed && !evidence.some(item => item.manualIntervention) ? 'passed' : 'failed', score: completed ? 100 : 0 }, suite: {} });
        }
        return json({ error: 'route' }, 404);
      }
      if (request.headers.host === new URL(APP).host) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<title>Integration settings</title><main><p id="status">Connection status: Disconnected</p><button id="connect">Connect integration</button></main><script>window.clicks=0;document.getElementById("connect").onclick=()=>{window.clicks++;document.getElementById("status").textContent="Connection status: Connected"}</script>'); return;
      }
      if (request.url === '/fixture-login') {
        response.writeHead(200, { ...headers, 'set-cookie': 'evaluation_fixture=authenticated; Path=/; HttpOnly; Secure; SameSite=None; Partitioned' }); response.end('{}'); return;
      }
      if (!request.headers.cookie?.includes('evaluation_fixture=authenticated')) return json({ error: 'auth' }, 401);
      const wrapped = data => json({ data });
      if (request.url === '/users/me') return wrapped({ id: USER });
      if (request.url === '/workspaces') return wrapped([{ id: WORKSPACE, name: 'Fixture', is_charly_extension_enabled: true }]);
      if (request.url === '/agent/by-slug/charly') return wrapped({ id: AGENT, slug: 'charly' });
      if (request.url === '/conversation' && request.method === 'POST') {
        mutations.push({ body, code: request.headers['x-limova-evaluation-code'] });
        return wrapped({ id: EVALUATION });
      }
      if (request.url.startsWith('/conversation?')) return wrapped({ data: [PERSONAL, EVALUATION].map(id => ({ id, title: id === PERSONAL ? 'Personal' : 'Evaluation' })) });
      if (request.url.endsWith('/messages')) return wrapped({ data: [], pagination: {} });
      if (request.url.startsWith('/conversation/')) return wrapped({ id: request.url.split('/')[2], engine: 'deep_agents', mainAgent: { id: AGENT, slug: 'charly' } });
      if (request.url.endsWith('/cancel')) return wrapped({ cancelled: true });
      if (request.url === `/message/${EVALUATION}`) {
        mutations.push({ body, code: request.headers['x-limova-evaluation-code'] });
        if (request.headers['x-limova-evaluation-code'] !== CODE) return json({ error: 'grant' }, 403);
        const input = actionCount === 1 ? { operation: 'click', elementId } : { operation: 'read_page' };
        if (actionCount === 1) {
          const observed = JSON.parse(body.browserResult.observation);
          elementId = observed.elements.find(item => item.label === 'Connect integration')?.elementId;
          input.elementId = elementId;
        }
        response.writeHead(201, { ...headers, 'content-type': 'text/event-stream' });
        if (actionCount < 3) {
          actionCount += 1;
          response.end(frame('custom', { type: 'extension.action_requested', protocolVersion: 1, turnId: TURN,
            actionId: `${TURN}:tool-${actionCount}`, toolCallId: `tool-${actionCount}`, target: body.browserContext,
            input, expiresAt: new Date(Date.now() + 60_000).toISOString() })
            + frame('custom', { type: 'extension.turn_state', turnId: TURN, state: 'waiting' }));
        } else response.end(frame('values', { messages: [{ id: 'human', type: 'human', content: 'Connect integration' }, { id: 'answer', type: 'ai', content: 'The integration is connected.', tool_calls: [] }] })
          + frame('custom', { type: 'extension.turn_state', turnId: TURN, state: 'completed' }));
        return;
      }
      return json({ error: 'route' }, 404);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port, extension = path.resolve(process.env.EXTENSION_PATH ?? 'build');
    context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--ignore-certificate-errors',
        `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP studio.limova.ai 127.0.0.1:${port}, MAP * ~NOTFOUND`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const app = await context.newPage(); await app.goto(`${APP}/settings`);
    await app.evaluate(api => fetch(`${api}/fixture-login`, { credentials: 'include' }), API);
    await worker.evaluate(async ({ USER, WORKSPACE, PERSONAL }) => {
      await chrome.storage.local.set({ limova_deep_agent_context_v1: { userId: USER, workspaceId: WORKSPACE, conversationId: PERSONAL }, limova_ai_processing_consent_v1: true, limova_onboarding_dismissed: true });
    }, { USER, WORKSPACE, PERSONAL });
    const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
    context.on('request', request => { if (request.url().includes('/api/copilot') || request.url().includes('/api/live-session')) legacy.push(request.url()); });
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/sidebar.html`);
    await expect(panel.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
    await expect(panel.locator('#limovaConversation')).toHaveValue(PERSONAL);
    await app.bringToFront();
    await panel.evaluate(code => { document.getElementById('evaluationToken').value = code; document.getElementById('evaluationStart').click(); }, CODE);
    await expect(panel.locator('body')).toHaveClass(/evaluation-active/);
    await expect(panel.locator('#limovaConversation')).toHaveValue(EVALUATION);
    await panel.evaluate(() => { document.getElementById('limovaBrowser').checked = true; document.getElementById('userInput').value = 'Connect integration'; document.getElementById('sendBtn').click(); });
    await expect.poll(() => evidence.some(item => item.kind === (verificationUnavailable ? 'native_verification' : 'response')), { timeout: 12_000 }).toBe(true);
    await expect(panel.locator('#sendBtn')).toBeEnabled();
    expect(await app.evaluate(() => window.clicks)).toBe(1);
    expect(evidence.some(item => item.kind === 'native_verification' && item.observation.text.includes('Connection status: Connected'))).toBe(true);
    expect(evidence.some(item => item.manualIntervention)).toBe(false);
    if (manual) {
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'VOICE_SESSION_STATE', active: true, engine: 'deep_agents' }));
      expect(await panel.evaluate(runId => chrome.runtime.sendMessage({ type: 'EVALUATION_MANUAL_INTERVENTION', runId }), TURN)).toEqual({ ok: false });
      expect(evidence.some(item => item.manualIntervention)).toBe(false);
      await app.locator('#connect').click();
      await app.locator('#connect').click();
      await expect.poll(() => evidence.filter(item => item.manualIntervention).length).toBe(1);
      expect(evidence.find(item => item.manualIntervention)).toEqual({ kind: 'manual_intervention', status: 'unexpected', manualIntervention: true });
    }
    await panel.evaluate(() => document.getElementById('evaluationCorrect').click());
    if (manualUnavailable) {
      await expect(panel.locator('#evaluationFeedback')).toContainText('intervention manuelle');
      expect(completionRequests).toBe(0);
      await expect(panel.locator('#limovaConversation')).toHaveValue(EVALUATION);
    } else if (verificationUnavailable) {
      await expect(panel.locator('#evaluationFeedback')).toContainText('preuve d’exécution');
      expect(completionRequests).toBe(0);
      expect(evidence.some(item => item.kind === 'response')).toBe(false);
      await expect(panel.locator('#limovaConversation')).toHaveValue(EVALUATION);
    } else {
      await expect.poll(() => completed).toBe(true);
      await expect(panel.locator('#limovaConversation')).toHaveValue(PERSONAL);
      if (manual) await expect(panel.locator('#evaluationFeedback')).toContainText(/échou|Échou|failed|corriger/i);
    }
    expect(mutations[0]).toMatchObject({ code: CODE, body: { botAgentId: AGENT, engine: 'deep_agents', type: 'general' } });
    expect(mutations.every(item => item.code === CODE && !JSON.stringify(item.body).includes(CODE))).toBe(true);
    expect(await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)))).not.toContain(CODE);
    expect(await worker.evaluate(async () => (await chrome.storage.session.get('charly_evaluation_active')).charly_evaluation_active)).toBeUndefined();
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
