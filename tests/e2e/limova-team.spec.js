import http from 'node:http';
import { test, expect } from './fixtures.js';

// TEAM-724: Limova Team connects to this browser as a device. These tests run the real
// engine in Chromium (tab group, isolated-world page map, actions) and the pairing and
// side-panel surfaces. No Limova Team server is contacted.

const FORM_PAGE = `<!doctype html><html><head><title>Contact</title></head><body>
  <form id="f" action="/merci" method="post">
    <label for="email">E-mail</label><input id="email" type="email">
    <label for="pw">Mot de passe</label><input id="pw" type="password" value="hunter2">
    <button type="submit" id="send">Envoyer</button>
  </form>
  <button id="plain" onclick="document.getElementById('out').textContent='Bouton cliqué'">Afficher</button>
  <button id="pay" onclick="document.getElementById('out').textContent='Payé'">Payer 49 €</button>
  <div role="status" id="out"></div>
  <a href="/other">Autre page</a>
</body></html>`;

// A real local server: Playwright's request interception does not reliably catch
// navigations of tabs the extension creates itself.
let server;
let SITE;
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url.startsWith('/other') ? '<!doctype html><title>Autre</title><p>Autre page</p>' : FORM_PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  SITE = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function routeSite(context) {
  await context.route(/^https:\/\/app\.team\.limova\.ai\//, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Pair</title><p>Dashboard</p>'
  }));
}

async function enginePage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/team/approval.html?id=none`);
  return page;
}

test.describe('Limova Team browser device', () => {
  test('manifest declares only what the feature needs', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toEqual(expect.arrayContaining(['tabGroups', 'alarms']));
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('downloads');
    expect(manifest.permissions).not.toContain('identity');
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
    expect(manifest.web_accessible_resources).toEqual([{
      resources: ['src/team/pair-callback.html'],
      matches: ['https://app.team.limova.ai/*', 'https://staging.team.limova.ai/*']
    }]);
    expect(manifest.content_security_policy.extension_pages).toContain('wss://api.team.limova.ai');
    const alarm = await serviceWorker.evaluate(() => chrome.alarms.get('limova-team-reconnect'));
    expect(alarm?.periodInMinutes).toBe(1);
  });

  test('the engine reads and acts in its own tab group, with the map out of the page', async ({ context, extensionId }) => {
    await routeSite(context);
    const host = await enginePage(context, extensionId);
    const first = await host.evaluate(async site => {
      const { createBrowserEngine } = await import(chrome.runtime.getURL('src/team/browser-engine.js'));
      const { PRODUCTS } = await import(chrome.runtime.getURL('src/team/products.js'));
      const browser = createBrowserEngine({}).forProduct(PRODUCTS.limova_team);
      globalThis.teamBrowser = browser;
      const opened = await browser.openTab({ url: `${site}/form?token=secret`, active: true });
      const tabId = opened.data.tab.tab_id;
      const tab = await chrome.tabs.get(tabId);
      const group = await chrome.tabGroups.get(tab.groupId);
      const read = await browser.readPage({ tab_id: tabId });
      return { opened, group: { title: group.title, color: group.color }, read };
    }, SITE);
    expect(first.opened.data.tab.url).toBe(`${SITE}/form`);
    expect(first.read.error).toBeUndefined();
    expect(first.group).toEqual({ title: 'Limova Team', color: 'purple' });
    const read = first.read.data;
    const id = name => read.elements.find(element => element.name === name)?.id;
    expect(read.elements.find(element => element.name === 'Mot de passe').state).toBe('sensitive');
    expect(JSON.stringify(read)).not.toContain('hunter2');

    // The map lives in the extension's isolated world: the page sees nothing.
    const site = context.pages().find(page => page.url().startsWith(`${SITE}/form`));
    const pageView = await site.evaluate(() => ({
      maps: typeof window.__limovaBrowserMaps,
      kit: typeof window.__limovaBrowserKit,
      marked: document.querySelectorAll('[data-lid], [data-limova-id]').length
    }));
    expect(pageView).toEqual({ maps: 'undefined', kit: 'undefined', marked: 0 });

    const acted = await host.evaluate(async ({ site, snapshot, email, password, plain, tabId }) => {
      const browser = globalThis.teamBrowser;
      const fill = await browser.prepareAction('browser.fill', { tab_id: tabId, snapshot_id: snapshot, element_id: email, target: 'E-mail', value: 'marie@example.com' });
      const filled = await browser.executeAction(fill.plan);
      const sensitive = await browser.prepareAction('browser.fill', { tab_id: tabId, snapshot_id: snapshot, element_id: password, target: 'Mot de passe', value: 'x' });
      const click = await browser.prepareAction('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: plain, target: 'Afficher' });
      const clicked = await browser.executeAction(click.plan);
      // A tab the person opened themselves stays out of reach.
      const own = await chrome.tabs.create({ url: `${site}/other`, active: false });
      const notInGroup = (await browser.readPage({ tab_id: own.id })).error?.code;
      await chrome.tabs.remove(own.id);
      return { filled, sensitive: sensitive.error?.error.code, clicked, notInGroup };
    }, { site: SITE, snapshot: read.snapshot_id, email: id('E-mail'), password: id('Mot de passe'), plain: id('Afficher'), tabId: first.opened.data.tab.tab_id });
    expect(acted.filled.ok).toBe(true);
    expect(acted.filled.data.verification.field_state).toBe('filled');
    expect(await site.locator('#email').inputValue()).toBe('marie@example.com');
    expect(acted.sensitive).toBe('sensitive_field');
    expect(await site.locator('#pw').inputValue()).toBe('hunter2');
    expect(acted.clicked.ok).toBe(true);
    expect(acted.clicked.data.verification.messages).toContain('Bouton cliqué');
    expect(acted.notInGroup).toBe('not_in_group');

    // After a navigation the old ids answer stale_snapshot.
    const stale = await host.evaluate(async ({ site, snapshot, plain, tabId }) => {
      const browser = globalThis.teamBrowser;
      await browser.navigate({ tab_id: tabId, url: `${site}/other` });
      const again = await browser.prepareAction('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: plain, target: 'Afficher' });
      const blocked = await browser.navigate({ tab_id: tabId, url: 'https://www.linkedin.com/feed/' });
      return { again: again.error?.error.code, blocked: blocked.error?.code };
    }, { site: SITE, snapshot: read.snapshot_id, plain: id('Afficher'), tabId: first.opened.data.tab.tab_id });
    expect(stale).toEqual({ again: 'stale_snapshot', blocked: 'blocked_site' });
    await host.close();
  });

  test('the home screen asks « Limova » or « Limova Team » before any sign-in', async ({ context, extensionId }) => {
    await routeSite(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await expect(page.locator('#productPicker')).toBeVisible();
    await page.locator('#pickTeam').click();
    await expect(page.locator('#teamPanel')).toBeVisible();
    await expect(page.locator('#teamPanelClose')).toBeHidden();
    const card = page.locator('[data-product="limova_team"]');
    // Headless Chromium may run in English: accept either locale.
    await expect(card).toContainText(/Non connecté|Not connected/);
    // User builds: one button, no environment choice.
    await expect(card.locator('select')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveText([/Se connecter|Sign in/]);

    const pairTab = context.waitForEvent('page');
    await card.getByRole('button').click();
    const opened = await pairTab;
    await opened.waitForLoadState('domcontentloaded');
    const url = new URL(opened.url());
    expect(url.origin + url.pathname).toBe('https://app.team.limova.ai/desktop/pair');
    expect(url.searchParams.get('platform')).toBe('chrome');
    expect(url.searchParams.get('extension_id')).toBe(extensionId);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The choice is remembered; « Changer de produit » goes back, « Limova » is Charly as before.
    await page.reload();
    await expect(page.locator('#teamPanel')).toBeVisible();
    await page.locator('#teamSwitchProduct').click();
    await page.locator('#pickLimova').click();
    await expect(page.locator('#productPicker')).toBeHidden();
    await expect(page.locator('#authPanel')).toBeVisible();
    await page.locator('#authEmail').fill('prenom@entreprise.com');
    expect(errors).toEqual([]);

    // A callback with a state this browser did not create is refused, and pairs nothing.
    const callback = await context.newPage();
    await callback.goto(`chrome-extension://${extensionId}/src/team/pair-callback.html?code=abc&state=forged`);
    await expect(callback.locator('#title')).toHaveText('La connexion n’a pas abouti');
    expect(callback.url()).not.toContain('code=abc');
    await page.close();
  });

  test('browser.v2 end to end: no approval except paying, set_autonomy at once, include_page and batch', async ({ context, extensionId }) => {
    const host = await enginePage(context, extensionId);
    // The real service, controller, engine and approval windows run in this extension
    // page; only the server socket is a fake (Playwright cannot route a service
    // worker's WebSocket), with an in-memory storage area so the real worker is untouched.
    await host.evaluate(async () => {
      const { createTeamService } = await import(chrome.runtime.getURL('src/team/team-service.js'));
      const sent = [];
      let socket = null;
      class FakeWebSocket {
        constructor(url, protocols) {
          this.url = url;
          this.protocols = protocols;
          this.readyState = 0;
          socket = this;
          setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
        }
        send(data) { sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
      }
      const memory = new Map();
      const local = {
        get: async key => (memory.has(key) ? { [key]: structuredClone(memory.get(key)) } : {}),
        set: async values => { for (const [key, value] of Object.entries(values)) memory.set(key, structuredClone(value)); },
        remove: async key => { memory.delete(key); }
      };
      await local.set({ limova_connections_v1: { version: 1, connections: { limova_team: {
        product: 'limova_team', environment: 'production', device_id: '3f8b2c1e-0000-4000-8000-000000000001',
        device_token: 'lmd_abcdefghijklmnopqrstuvwxyz012345', machine_id: '5d2c9a10-1111-4111-8111-111111111111',
        autonomy: 'full_access', paused: false } } } });
      const api = Object.create(chrome);
      api.storage = { local, session: chrome.storage.session };
      const service = createTeamService({
        chromeApi: api,
        WebSocketImpl: FakeWebSocket,
        renderCapture: async () => null,
        fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ user: { email: 'founder@example.com' } }) })
      });
      await service.init();
      await new Promise(resolve => setTimeout(resolve, 20));
      globalThis.fakeServer = {
        service,
        sent,
        push: message => socket.onmessage({ data: JSON.stringify(message) }),
        async result(callId) {
          for (let i = 0; i < 400; i += 1) {
            const answer = sent.find(message => message.type === 'result' && message.call_id === callId);
            if (answer) return answer;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return null;
        },
        async popups() {
          return (await chrome.windows.getAll({ windowTypes: ['popup'] })).length;
        }
      };
      globalThis.fakeServer.push({ type: 'ready', device_id: '3f8b2c1e-0000-4000-8000-000000000001' });
    });

    const hello = await host.evaluate(() => globalThis.fakeServer.sent[0]);
    expect(hello.capabilities).toEqual(['browser.v1', 'browser.v2', 'autonomy.v1', 'browser_control.v1']);
    expect(hello.autonomy).toBe('full_access');

    // open_tab with include_page answers the page map at once.
    const opened = await host.evaluate(async site => {
      const server = globalThis.fakeServer;
      server.push({ type: 'call', call_id: 'c-open', tool: 'browser.open_tab', args: { url: `${site}/form`, include_page: true }, deadline_ms: Date.now() + 40_000 });
      return server.result('c-open');
    }, SITE);
    expect(opened.ok).toBe(true);
    const page = opened.data.page;
    const tabId = opened.data.tab.tab_id;
    expect(page.snapshot_id).toMatch(/^s\d+$/);
    const id = name => page.elements.find(element => element.name === name).id;

    // A risky click (« Envoyer » reads as send) runs at once, without a window.
    const before = await host.evaluate(() => globalThis.fakeServer.popups());
    const batch = await host.evaluate(async args => {
      const server = globalThis.fakeServer;
      server.push({ type: 'call', call_id: 'c-batch', tool: 'browser.batch', deadline_ms: Date.now() + 100_000, args });
      return server.result('c-batch');
    }, {
      tab_id: tabId, snapshot_id: page.snapshot_id, include_page: true, risk: 'risky', risk_reason: 'send',
      steps: [
        { action: 'fill', element_id: id('E-mail'), target: 'E-mail', value: 'camille@example.com' },
        { action: 'click', element_id: id('Afficher'), target: 'Afficher' }
      ]
    });
    expect(batch.ok).toBe(true);
    expect(batch.data.done).toBe(2);
    expect(batch.data.page.snapshot_id).not.toBe(page.snapshot_id);
    expect(await host.evaluate(() => globalThis.fakeServer.popups())).toBe(before);
    const site = context.pages().find(candidate => candidate.url().startsWith(`${SITE}/form`));
    expect(await site.locator('#email').inputValue()).toBe('camille@example.com');
    expect(await site.locator('#out').textContent()).toBe('Bouton cliqué');

    // A password field is still refused.
    const sensitive = await host.evaluate(async args => {
      const server = globalThis.fakeServer;
      server.push({ type: 'call', call_id: 'c-pw', tool: 'browser.fill', deadline_ms: Date.now() + 100_000, args });
      return server.result('c-pw');
    }, { tab_id: tabId, snapshot_id: batch.data.page.snapshot_id, element_id: batch.data.page.elements.find(e => e.name === 'Mot de passe').id, target: 'Mot de passe', value: 'x', risk: 'write', risk_reason: null });
    expect(sensitive.error.code).toBe('sensitive_field');

    // Paying still waits for the person, in a Chrome window, even though the server said « write ».
    const payId = batch.data.page.elements.find(e => e.name === 'Payer 49 €').id;
    await host.evaluate(args => {
      globalThis.fakeServer.push({ type: 'call', call_id: 'c-pay', tool: 'browser.click', deadline_ms: Date.now() + 100_000, args });
    }, { tab_id: tabId, snapshot_id: batch.data.page.snapshot_id, element_id: payId, target: 'Payer 49 €', risk: 'write', risk_reason: null });
    await expect.poll(() => host.evaluate(() => globalThis.fakeServer.sent.some(m => m.type === 'progress' && m.call_id === 'c-pay' && m.status === 'waiting_approval'))).toBe(true);
    await expect.poll(() => host.evaluate(() => globalThis.fakeServer.popups())).toBe(before + 1);
    expect(await site.locator('#out').textContent()).toBe('Bouton cliqué');
    // The person clicks « Autoriser » (decided here: the window talks to the real worker,
    // which does not know this page's approval).
    await host.evaluate(() => {
      const { approvals } = globalThis.fakeServer.service;
      return approvals.decide(approvals.ids()[0], 'approve');
    });
    const paid = await host.evaluate(() => globalThis.fakeServer.result('c-pay'));
    expect(paid.ok).toBe(true);
    expect(await site.locator('#out').textContent()).toBe('Payé');

    // set_autonomy applies at once, either way, sending state before its answer, with no window.
    const autonomy = await host.evaluate(async () => {
      const server = globalThis.fakeServer;
      const windows = await server.popups();
      const start = server.sent.length;
      server.push({ type: 'set_autonomy', request_id: 'r-down', autonomy: 'ask_every_time' });
      server.push({ type: 'set_autonomy', request_id: 'r-up', autonomy: 'full_access' });
      await new Promise(resolve => setTimeout(resolve, 300));
      return { windows, after: await server.popups(), messages: server.sent.slice(start).map(m => `${m.type}:${m.request_id || m.autonomy}:${m.status || ''}`) };
    });
    expect(autonomy.after).toBe(autonomy.windows);
    const at = text => autonomy.messages.indexOf(text);
    // Each change sends its own state before its own answer.
    expect(at('state:ask_every_time:')).toBeGreaterThanOrEqual(0);
    expect(at('state:ask_every_time:')).toBeLessThan(at('autonomy_result:r-down:applied'));
    expect(at('state:full_access:')).toBeLessThan(at('autonomy_result:r-up:applied'));
    expect(at('state:ask_every_time:')).toBeLessThan(at('state:full_access:'));
    await host.close();
  });
});
