import { test as base, chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const environment = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');
export const APP = environment.appOrigin, API = environment.apiOrigin;
export const USER = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const AGENT = '33333333-3333-4333-8333-333333333333';
export const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const test = base.extend({
  nativeChat: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'limova-native-chat-'));
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=limova-native-chat'], { stdio: 'ignore' });
    const calls = [], history = [], legacy = [], errors = [];
    const state = { created: false, reply: 'Je retrouve le tableau de bord.', authenticated: true, enabled: true, browserActions: [{ operation: 'read_page' }] };
    let turnId, actionIndex = 0;
    let context;
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
      let raw = ''; request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const url = new URL(request.url, API);
        const headers = { 'content-type': 'application/json', 'access-control-allow-origin': APP,
          'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type,x-workspace-id,x-extension-session',
          'access-control-allow-methods': 'GET,POST,OPTIONS' };
        const json = (data, status = 200) => { response.writeHead(status, headers); response.end(JSON.stringify({ data })); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (request.headers.host === new URL(APP).host) {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><title>Limova</title><main><h1>Tableau de bord</h1><input type="password" value="NEVER_TRANSMIT_THIS_SECRET"><textarea aria-label="Brief">PRIVATE_FIELD_VALUE</textarea><button id="action">Continuer</button></main><script>window.inputEvents=0;document.querySelector("textarea").addEventListener("input",()=>window.inputEvents++);window.clicks=0;document.getElementById("action").onclick=()=>window.clicks++;</script>'); return;
        }
        if (url.pathname === '/fixture-login') {
          response.writeHead(200, { ...headers, 'set-cookie': 'native_chat=authenticated; Path=/; HttpOnly; Secure; SameSite=None; Partitioned' }); response.end('{}'); return;
        }
        const authenticated = state.authenticated && request.headers.cookie?.includes('native_chat=authenticated');
        const body = raw ? JSON.parse(raw) : undefined;
        calls.push({ path: url.pathname, method: request.method, body, authenticated, workspace: request.headers['x-workspace-id'] });
        if (!authenticated) return json({ error: 'auth' }, 401);
        if (url.pathname === '/users/me') return json({ id: USER });
        if (url.pathname === '/workspaces') return json([{ id: WORKSPACE, name: 'Native fixture', is_charly_extension_enabled: state.enabled }]);
        if (url.pathname === '/agent/by-slug/charly') return json({ id: AGENT, slug: 'charly' });
        if (url.pathname === '/conversation' && request.method === 'POST') { state.created = true; return json({ id: CONVERSATION }); }
        if (url.pathname === '/conversation') return json({ data: state.created ? [{ id: CONVERSATION, title: 'Discussion native' }] : [], pagination: { hasNext: false } });
        if (url.pathname === `/conversation/${CONVERSATION}`) return json({ id: CONVERSATION, engine: 'deep_agents', mainAgent: { id: AGENT, slug: 'charly' } });
        if (url.pathname === `/conversation/${CONVERSATION}/download`) {
          response.writeHead(200, { ...headers, 'content-type': 'text/csv; charset=utf-8' });
          response.end('Timestamp,Sender,Content\n2026-10-14,Charly,"Bonjour é"\n'); return;
        }
        if (url.pathname === `/conversation/${CONVERSATION}/messages`) return json({ data: history, pagination: { hasMore: false } });
        if (url.pathname === `/message/${CONVERSATION}`) {
          if (request.headers['x-workspace-id'] !== WORKSPACE) return json({ error: 'workspace' }, 403);
          response.writeHead(201, { ...headers, 'content-type': 'text/event-stream' });
          if (!body.kind) {
            history.push({ id: `human-${history.length}`, role: 'user', content: body.content });
            turnId = randomUUID(); actionIndex = 0;
          }
          if (body.browserContext && actionIndex < state.browserActions.length) {
            const step = state.browserActions[actionIndex++];
            const input = typeof step === 'function' ? step(body) : step;
            response.end(frame('custom', { type: 'extension.action_requested', protocolVersion: 1, turnId,
              actionId: `${turnId}:action-${actionIndex}`, toolCallId: `tool-${actionIndex}`, target: body.browserContext, input,
              expiresAt: new Date(Date.now() + 60000).toISOString() }) + frame('custom', { type: 'extension.turn_state', turnId, state: 'waiting' })); return;
          }
          history.push({ id: `assistant-${history.length}`, role: 'assistant', content: state.reply });
          response.end(frame('values', { messages: history }) + (body.browserContext ? frame('custom', { type: 'extension.turn_state', turnId, state: 'completed' }) : '')); return;
        }
        return json({ error: 'route' }, 404);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port, extension = path.resolve(process.env.EXTENSION_PATH ?? (process.env.LIMOVA_E2E_ENV === 'staging' ? 'build-staging' : 'build'));
      context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--ignore-certificate-errors',
          `--host-resolver-rules=MAP ${new URL(API).hostname} 127.0.0.1:${port}, MAP ${new URL(APP).hostname} 127.0.0.1:${port}, MAP * ~NOTFOUND`] });
      context.on('request', request => { if (/limova-proxy|generativelanguage|\/api\/copilot/.test(request.url())) legacy.push(request.url()); });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const app = await context.newPage(); await app.goto(`${APP}/dashboard?private_token=must-not-leak`);
      await app.evaluate(api => fetch(`${api}/fixture-login`, { credentials: 'include' }), API);
      await worker.evaluate(async ({ USER, WORKSPACE }) => chrome.storage.local.set({
        limova_deep_agent_context_v1: { userId: USER, workspaceId: WORKSPACE },
        limova_ai_processing_consent_v1: true, limova_onboarding_dismissed: true, limova_lang: 'fr',
      }), { USER, WORKSPACE });
      const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
      await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidebar/sidebar.html`);
      await panel.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
      await app.bringToFront();
      await use({ context, worker, app, panel, calls, history, legacy, errors, state });
    } finally {
      await context?.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
});
export const expect = test.expect;
