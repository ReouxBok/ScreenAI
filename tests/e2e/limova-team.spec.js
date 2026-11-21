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

  test('the side panel offers the Limova Team connection, even before Charly sign-in', async ({ context, extensionId }) => {
    await routeSite(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await expect(page.locator('#authPanel')).toBeVisible();
    await page.locator('#authTeamConnections').click();
    await expect(page.locator('#teamPanel')).toBeVisible();
    const card = page.locator('[data-product="limova_team"]');
    await expect(card).toContainText('Limova Team');
    await expect(card.locator('select option')).toHaveCount(2);

    const pairTab = context.waitForEvent('page');
    await card.getByRole('button').first().click();
    const opened = await pairTab;
    await opened.waitForLoadState('domcontentloaded');
    const url = new URL(opened.url());
    expect(url.origin + url.pathname).toBe('https://app.team.limova.ai/desktop/pair');
    expect(url.searchParams.get('platform')).toBe('chrome');
    expect(url.searchParams.get('extension_id')).toBe(extensionId);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(errors).toEqual([]);

    // A callback with a state this browser did not create is refused, and pairs nothing.
    const callback = await context.newPage();
    await callback.goto(`chrome-extension://${extensionId}/src/team/pair-callback.html?code=abc&state=forged`);
    await expect(callback.locator('#title')).toHaveText('La connexion n’a pas abouti');
    expect(callback.url()).not.toContain('code=abc');
    await page.close();
  });
});
