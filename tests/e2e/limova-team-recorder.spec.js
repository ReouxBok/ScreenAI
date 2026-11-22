import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, expect } from '@playwright/test';

// TEAM-731: « Montrer à Limova » records a small form on a local page, in the REAL
// service worker, and the test reads the limova.recording.v1 it would upload.
// No Limova Team server is reached: *.team.limova.ai resolves to a closed local port
// (the device socket simply stays offline), and the worker's fetch is replaced to
// capture the upload.

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = process.env.EXTENSION_PATH ? path.resolve(process.env.EXTENSION_PATH) : path.resolve(here, '..', '..', 'build');

const FORM = `<!doctype html><html><head><title>Nouvelle facture</title></head><body>
  <main>
    <h2>Nouvelle facture</h2>
    <form action="/merci" method="post">
      <label for="client">Client</label><input id="client" name="customer" data-testid="customer">
      <label for="pw">Mot de passe</label><input id="pw" type="password" name="password">
      <label for="vat">TVA</label><select id="vat"><option>0 %</option><option>20 %</option></select>
      <label><input type="checkbox" id="cgv"> J’accepte</label>
      <button type="submit">Enregistrer</button>
    </form>
  </main>
</body></html>`;
const THANKS = '<!doctype html><html><head><title>Merci</title></head><body><div role="status">Facture créée, code 482913</div></body></html>';

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--enable-unsafe-extension-debugging',
        '--no-sandbox',
        '--host-resolver-rules=MAP *.team.limova.ai 127.0.0.1:9, MAP limova-proxy-479c7fb78ccf.herokuapp.com 127.0.0.1:9'
      ]
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  }
});

let server;
let SITE;
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url.startsWith('/merci') ? THANKS : FORM);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  SITE = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test('records a small form into a limova.recording.v1 with secrets redacted', async ({ context, serviceWorker }) => {
  test.setTimeout(60_000);
  const extensionId = new URL(serviceWorker.url()).host;
  // A paired connection, as after « Se connecter ».
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ limova_home_product_v1: 'limova_team', limova_connections_v1: { version: 1, connections: { limova_team: {
      product: 'limova_team', environment: 'production', device_id: '3f8b2c1e-0000-4000-8000-000000000001',
      device_token: 'lmd_abcdefghijklmnopqrstuvwxyz012345', machine_id: '5d2c9a10-1111-4111-8111-111111111111',
      autonomy: 'full_access', paused: false } } } });
    await chrome.alarms.create('limova-team-reconnect', { when: Date.now() + 10 });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await expect(panel.locator('[data-product="limova_team"]')).toContainText('Limova Team');

  const site = await context.newPage();
  await site.goto(`${SITE}/factures/nouvelle?token=abc`);
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => (tab.url || '').startsWith(url))?.id, SITE);
  const started = await panel.evaluate(id => chrome.runtime.sendMessage({ type: 'TEAM_RECORD_START', productId: 'limova_team', tabId: id }), tabId);
  expect(started.ok).toBe(true);
  await expect(panel.locator('#teamRecordBar')).toContainText(/Limova regarde|Limova is watching/);
  const group = await panel.evaluate(async id => {
    const tab = await chrome.tabs.get(id);
    return tab.groupId >= 0 ? (await chrome.tabGroups.get(tab.groupId)).title : null;
  }, tabId);
  expect(group).toBe('Limova Team · Limova regarde');
  const badge = await serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
  expect(badge).toBe('REC');

  // The person does the task.
  await site.waitForTimeout(300);
  await site.locator('#client').click();
  await site.keyboard.type('ACME SAS');
  await site.locator('#pw').click();
  await site.keyboard.type('hunter2');
  // A real key press (Playwright's selectOption fires script events, which the recorder
  // ignores like any event the page makes itself): type-ahead picks « 20 % ».
  await site.locator('#vat').focus();
  await site.keyboard.press('2');
  await site.locator('#vat').evaluate(select => select.blur());
  await site.locator('#cgv').click();
  await site.locator('button[type="submit"]').click();
  await site.waitForURL(`${SITE}/merci`);
  await site.waitForTimeout(3800);

  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TEAM_RECORD_STOP' }));
  expect(stopped.ok).toBe(true);
  await expect(panel.locator('#teamRecordReview')).toBeVisible();
  const { review } = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TEAM_RECORD_GET' }));
  expect(review.steps.map(step => step.kind)).toEqual(['navigate', 'fill', 'fill', 'select', 'check', 'click', 'navigate']);
  expect(review.steps[2]).toEqual(expect.objectContaining({ redacted: 'password', value: null }));

  // The person names the task and marks the client as changing, then sends.
  await panel.locator('#teamRecordTitle').fill('Créer une facture');
  await serviceWorker.evaluate(() => {
    globalThis.__uploads = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/api/v1/devices/me/recordings')) {
        globalThis.__uploads.push({ url: String(url), auth: init.headers.Authorization, body: init.body });
        return new Response(JSON.stringify({ recording_id: JSON.parse(init.body).recording_id, procedure_id: 'p1', status: 'compiling', redacted: 0, duplicate: false }), { status: 201 });
      }
      return real(url, init);
    };
  });
  await panel.locator('#teamRecordReview').getByRole('button', { name: /Envoyer à Limova|Send to Limova/ }).click();
  // « Former Limova » opens (the dashboard host is unreachable here, so read Chrome's tab URL).
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.pendingUrl || tab.url)))
    .toContain('https://app.team.limova.ai/skills?tab=training');

  const uploads = await serviceWorker.evaluate(() => globalThis.__uploads);
  expect(uploads).toHaveLength(1);
  expect(uploads[0].url).toBe('https://api.team.limova.ai/api/v1/devices/me/recordings');
  expect(uploads[0].auth).toBe('Device lmd_abcdefghijklmnopqrstuvwxyz012345');
  const recording = JSON.parse(uploads[0].body);
  expect(uploads[0].body).not.toMatch(/hunter2|482913|token=abc|\?/);
  expect(recording).toEqual(expect.objectContaining({
    schema: 'limova.recording.v1',
    title: 'Créer une facture',
    recording_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    session: expect.objectContaining({ origins: [SITE], recorder: { surface: 'chrome_extension', app_version: expect.any(String) } })
  }));
  const steps = recording.steps;
  expect(steps.map(step => step.kind)).toEqual(['navigate', 'fill', 'fill', 'select', 'check', 'click', 'navigate']);
  expect(steps[0]).toEqual(expect.objectContaining({ tab: 1, url: `${SITE}/factures/nouvelle`, cause: 'typed' }));
  expect(steps[1]).toEqual(expect.objectContaining({
    value: 'ACME SAS', candidate_parameter: true, parameter_name: 'client',
    target: expect.objectContaining({ role: 'textbox', name: 'Client', label: 'Client', nearby: 'Nouvelle facture', hints: expect.objectContaining({ input_name: 'customer', testid: 'customer', landmark: 'main' }) })
  }));
  expect(steps[2]).toEqual(expect.objectContaining({ value: { redacted: 'password' }, sensitive: true }));
  expect(steps[3]).toEqual(expect.objectContaining({ option: '20 %', target: expect.objectContaining({ label: 'TVA' }) }));
  expect(steps[4]).toEqual(expect.objectContaining({ checked: true }));
  expect(steps[5].target).toEqual(expect.objectContaining({ role: 'button', name: 'Enregistrer' }));
  expect(steps[5].observed).toEqual(expect.objectContaining({ url_changed: true, url: `${SITE}/merci` }));
  expect(steps[6]).toEqual(expect.objectContaining({ url: `${SITE}/merci`, cause: 'link' }));
  for (const step of steps) expect(Object.keys(step.target || {})).not.toEqual(expect.arrayContaining(['selector', 'xpath', 'x', 'y']));
  const ts = steps.map(step => step.t);
  expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  expect(await serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).not.toBe('REC');
});
