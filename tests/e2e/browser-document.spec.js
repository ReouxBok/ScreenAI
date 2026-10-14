import { test, expect } from './fixtures.js';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const { appOrigin: APP, apiOrigin: API } = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');

async function setup(context, extensionId) {
  await context.route(`${API}/**`, route => route.abort());
  await context.route(`${APP}/driver-fixture`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <h1>Account settings</h1><button id="original">Save</button><button id="decoy">Delete</button>
    <input id="name" aria-label="Name"><input type="password" value="SECRET_PASSWORD">
    <div data-private>PRIVATE_CONTENT</div><script>window.saved=0;window.deleted=0;
    original.onclick=()=>window.saved++;decoy.onclick=()=>window.deleted++;</script></body></html>` }));
  const site = await context.newPage();
  await site.goto(`${APP}/driver-fixture`);
  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await controller.evaluate(async APP => {
    window.APP = APP;
    const { browserDocumentCommand } = await import('../limova/browser-document.js');
    const [tab] = await chrome.tabs.query({ url: `${APP}/driver-fixture` });
    window.invokeDocument = async request => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: browserDocumentCommand, args: [request] });
      return result.result;
    };
    window.binding = (await invokeDocument({ operation: 'bind', origin: APP, contextVersion: 1 })).binding;
    window.snapshot = await invokeDocument({ ...binding, operation: 'read_page', nextContextVersion: 2 });
    window.binding = snapshot.binding;
  }, APP);
  return { site, controller };
}

test('uses private element references despite page-controlled data attributes', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => { original.dataset.lid = '999'; decoy.dataset.lid = '1'; document.documentElement.dataset.limovaContextVersion = '999'; });
  const result = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }));
  expect(result.status).toBe('completed');
  expect(await site.evaluate(() => ({ saved, deleted, exposed: typeof globalThis.__limovaDeepAgentDocumentV1 }))).toEqual({ saved: 1, deleted: 0, exposed: 'undefined' });
});

for (const operation of ['click', 'highlight']) test(`rejects a detached ${operation} reference instead of targeting a replacement with the same ID`, async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => { const replacement = original.cloneNode(true); replacement.onclick = () => window.deleted++; original.replaceWith(replacement); });
  const result = await controller.evaluate(operation => invokeDocument({ ...binding, operation, elementId: 1, nextContextVersion: 3 }), operation);
  expect(result.status).toBe('rejected');
  expect(await site.evaluate(() => deleted)).toBe(0);
});

test('rejects changed target semantics and stale document versions', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => { original.textContent = 'Delete account'; });
  expect((await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }))).status).toBe('rejected');
  expect((await controller.evaluate(() => invokeDocument({ ...binding, contextVersion: 0, operation: 'click', elementId: 2, nextContextVersion: 3 }))).status).toBe('rejected');
});

test('reads visible text without input values or explicitly private content', async ({ context, extensionId }) => {
  const { controller } = await setup(context, extensionId);
  const observation = await controller.evaluate(() => snapshot.observation);
  expect(observation).toContain('Account settings');
  expect(observation).not.toContain('SECRET_PASSWORD');
  expect(observation).not.toContain('PRIVATE_CONTENT');
});

test('reads the foreground modal and rejects background references even when uncovered', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => {
    const modal = document.createElement('div');
    modal.id = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.style.cssText = 'position:fixed;left:200px;top:180px;width:280px;height:220px;background:white;z-index:20';
    modal.innerHTML = '<h2>Connexion Gmail</h2><button id="confirm">Confirmer</button><input type="password" value="PRIVATE_MODAL_PASSWORD"><div data-private>PRIVATE_MODAL_CONTENT</div>';
    window.confirmed = 0;
    modal.querySelector('button').onclick = () => window.confirmed++;
    document.body.append(modal);
  });
  const stale = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }));
  expect(stale.status).toBe('rejected');
  expect(await site.evaluate(() => saved)).toBe(0);
  const result = await controller.evaluate(async () => {
    snapshot = await invokeDocument({ ...binding, operation: 'read_page', nextContextVersion: 4 });
    binding = snapshot.binding;
    const observation = JSON.parse(snapshot.observation);
    return { observation, click: await invokeDocument({ ...binding, operation: 'click',
      elementId: observation.elements.find(item => item.label === 'Confirmer').elementId, nextContextVersion: 5 }) };
  });
  expect(result.observation.surface).toBe('modal');
  expect(result.observation.text).toContain('Connexion Gmail');
  expect(JSON.stringify(result.observation)).not.toMatch(/Account settings|Save|Delete|PRIVATE_/);
  expect(result.click.status).toBe('completed');
  expect(await site.evaluate(() => confirmed)).toBe(1);
});

test('refreshes modal scope after nesting and closing without reusing old controls', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="outer" role="dialog" style="position:fixed;inset:100px;background:white;z-index:10"><button>Outer control</button><div id="inner" role="dialog" style="position:fixed;inset:150px;background:white;z-index:11"><button>Inner control</button></div></div>');
  });
  const read = version => controller.evaluate(async version => {
    snapshot = await invokeDocument({ ...binding, operation: 'read_page', nextContextVersion: version });
    binding = snapshot.binding;
    return JSON.parse(snapshot.observation);
  }, version);
  expect((await read(3)).elements.map(item => item.label)).toEqual(['Inner control']);
  await site.evaluate(() => document.getElementById('inner').remove());
  expect((await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 4 }))).status).toBe('rejected');
  expect((await read(5)).elements.map(item => item.label)).toEqual(['Outer control']);
  await site.evaluate(() => document.getElementById('outer').hidden = true);
  expect((await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 6 }))).status).toBe('rejected');
  const page = await read(7);
  expect(page.surface).toBe('page');
  expect(page.text).toContain('Account settings');
  expect(page.text).not.toContain('Outer control');
});

test('scrolls the active modal without scrolling the background page', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => {
    document.body.style.height = '3000px';
    document.body.insertAdjacentHTML('beforeend', '<div id="modal" role="dialog" style="position:fixed;left:150px;top:100px;width:280px;height:180px;overflow:auto;background:white;z-index:20"><div style="height:800px">Modal steps</div></div>');
  });
  const result = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'scroll', direction: 'down', nextContextVersion: 3 }));
  expect(result.status).toBe('completed');
  expect(JSON.parse(result.observation)).toMatchObject({ surface: 'modal', moved: true, atStart: false, atEnd: false });
  expect(await site.evaluate(() => scrollY)).toBe(0);
  expect(await site.locator('#modal').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('types through a private reference and advances the document version', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  const result = await controller.evaluate(() => {
    const field = JSON.parse(snapshot.observation).elements.find(item => item.label === 'Name');
    return invokeDocument({ ...binding, operation: 'type_text', elementId: field.elementId, text: 'Alice', nextContextVersion: 3 });
  });
  expect(result.status).toBe('completed');
  expect(result.binding.contextVersion).toBe(3);
  expect(await site.locator('#name').inputValue()).toBe('Alice');
  expect((await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }))).status).toBe('rejected');
});

test('refuses a field changed into a sensitive input after the snapshot', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.locator('#name').evaluate(element => { element.type = 'password'; });
  const result = await controller.evaluate(() => {
    const field = JSON.parse(snapshot.observation).elements.find(item => item.label === 'Name');
    return invokeDocument({ ...binding, operation: 'type_text', elementId: field.elementId, text: 'Never write', nextContextVersion: 3 });
  });
  expect(result.status).toBe('rejected');
  expect(await site.locator('#name').inputValue()).toBe('');
});

test('refuses a target hidden behind a new overlay', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => { const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:white'; document.body.append(overlay); });
  expect((await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }))).status).toBe('rejected');
  expect(await site.evaluate(() => saved)).toBe(0);
});

test('keeps a large escaped observation valid JSON within the backend limit', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.textContent = '\\'.repeat(30000);
    paragraph.style.cssText = 'overflow-wrap:anywhere;width:100px';
    document.body.prepend(paragraph);
  });
  const result = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'read_page', nextContextVersion: 3 }));
  expect(result.status).toBe('completed');
  expect(result.observation.length).toBeLessThanOrEqual(32000);
  expect(JSON.parse(result.observation).contextVersion).toBe(3);
});

test('reports actual scroll movement and document version', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(() => { document.body.style.minHeight = '5000px'; });
  const result = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'scroll', direction: 'down', nextContextVersion: 3 }));
  expect(JSON.parse(result.observation).moved).toBe(true);
  expect(result.binding.contextVersion).toBe(3);
  expect(await site.evaluate(() => scrollY)).toBeGreaterThan(0);
});

test('highlights a private target without triggering its click handler', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  const result = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'highlight', elementId: 1, nextContextVersion: 3 }));
  expect(result.status).toBe('completed');
  expect(await site.evaluate(() => saved)).toBe(0);
});

test('Chrome document binding refuses an action after page reload and allocates a newer context', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await controller.evaluate(async () => {
    const { createBrowserBinding } = await import('../limova/browser-binding.js');
    const { createBrowserJournal } = await import('../limova/browser-journal.js');
    window.driverJournal = createBrowserJournal();
    const scope = { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    scope.sessionId = await driverJournal.getSession(scope);
    // The fixture has already initialized document versions 1 and 2.
    await driverJournal.allocateVersion(scope);
    await driverJournal.allocateVersion(scope);
    window.driver = createBrowserBinding({ scripting: chrome.scripting,
      allocateVersion: () => driverJournal.allocateVersion(scope) });
    const [tab] = await chrome.tabs.query({ url: `${APP}/driver-fixture` });
    window.driverPage = await driver.bind(tab.id, APP);
    await driver.execute(driverPage, 'read_page', {});
    window.driverPage = await driver.inspect(tab.id);
  });
  const before = await controller.evaluate(() => driverPage);
  await site.reload();
  const result = await controller.evaluate(async () => {
    let rejected = false;
    try { await driver.execute(driverPage, 'click', { elementId: 1 }); } catch { rejected = true; }
    const next = await driver.bind(driverPage.tabId, driverPage.origin);
    await driverJournal.close();
    return { rejected, next };
  });
  expect(result.rejected).toBe(true);
  expect(result.next.chromeDocumentId).not.toBe(before.chromeDocumentId);
  expect(result.next.documentId).not.toBe(before.documentId);
  expect(result.next.contextVersion).toBeGreaterThan(before.contextVersion);
  expect(await site.evaluate(() => saved)).toBe(0);
});

test('assembled driver reads and clicks the active page with real Chrome permission checks', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await controller.evaluate(async () => {
    const { createBrowserDriver } = await import('../limova/browser-driver.js');
    const { createBrowserJournal } = await import('../limova/browser-journal.js');
    window.assembledJournal = createBrowserJournal();
    const scope = { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    scope.sessionId = await assembledJournal.getSession(scope);
    await assembledJournal.allocateVersion(scope);
    await assembledJournal.allocateVersion(scope);
    window.assembled = createBrowserDriver({ chrome, journal: assembledJournal, scope, hasConsent: async () => true });
  });
  await site.bringToFront();
  const result = await controller.evaluate(async () => {
    const first = await assembled.readPage();
    const snapshot = await assembled.execute({ target: first, input: { operation: 'read_page' } });
    const target = await assembled.readPage();
    const button = JSON.parse(snapshot.observation).elements.find(element => element.label === 'Save');
    return assembled.execute({ target, input: { operation: 'click', elementId: button.elementId } });
  });
  expect(result.status).toBe('completed');
  expect(await site.evaluate(() => saved)).toBe(1);
  await controller.bringToFront();
  const refused = await controller.evaluate(async () => {
    try { await assembled.readPage(); return false; } catch { return true; }
    finally { await assembledJournal.close(); }
  });
  expect(refused).toBe(true);
});

test('navigates from the bound document and rejects stale navigation without leaving the page', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await context.route(`${APP}/driver-destination`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Destination reached</h1>' }));
  const refused = await controller.evaluate(() => invokeDocument({ ...binding, contextVersion: 0,
    operation: 'navigate', url: `${APP}/driver-destination`, nextContextVersion: 3 }));
  expect(refused.status).toBe('rejected');
  expect(site.url()).toBe(`${APP}/driver-fixture`);
  const [result] = await Promise.all([
    controller.evaluate(() => invokeDocument({ ...binding, operation: 'navigate', url: `${APP}/driver-destination`, nextContextVersion: 3 })),
    site.waitForURL(`${APP}/driver-destination`),
  ]);
  expect(result.status).toBe('completed');
  await expect(site.locator('h1')).toHaveText('Destination reached');
});

test('waits for a real in-progress Chrome navigation before returning the destination tab', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  let release;
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  await context.route(`${APP}/driver-slow`, async route => {
    markRequested();
    await response;
    await route.fulfill({ contentType: 'text/html', body: '<h1>Loaded</h1>' });
  });
  const navigating = site.goto(`${APP}/driver-slow`);
  await requested;
  await controller.evaluate(async () => {
    const { waitForBrowserReady } = await import('../limova/browser-ready.js');
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.pendingUrl?.includes('/driver-slow') || tab.url?.includes('/driver-'));
    window.readySettled = false;
    window.readyResult = waitForBrowserReady(chrome.tabs, tab.id).then(result => { readySettled = true; return result; });
  });
  expect(await controller.evaluate(() => readySettled)).toBe(false);
  release();
  await navigating;
  const result = await controller.evaluate(() => readyResult);
  expect(result.status).toBe('complete');
  expect(result.url).toBe(`${APP}/driver-slow`);
});

test('native action pointer clears on scroll and does not block screenshot geometry', async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  const result = await controller.evaluate(async () => {
    const clicked = await invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 });
    return invokeDocument({ ...clicked.binding, operation: 'screenshot_geometry' });
  });
  expect(result.status).toBe('completed');
  await expect(site.locator('[data-limova-native-pointer]')).toHaveCount(1);
  await site.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await expect(site.locator('[data-limova-native-pointer]')).toHaveCount(0);
  expect(await site.evaluate(() => saved)).toBe(1);
});

for (const navigation of ['push', 'replace', 'hash']) test(`invalidates element references after ${navigation} navigation in the same document`, async ({ context, extensionId }) => {
  const { site, controller } = await setup(context, extensionId);
  await site.evaluate(navigation => {
    if (navigation === 'hash') location.hash = 'PRIVATE_ROUTE';
    else history[navigation === 'push' ? 'pushState' : 'replaceState']({}, '', '/driver-fixture?account=PRIVATE_ROUTE');
  }, navigation);
  const stale = await controller.evaluate(() => invokeDocument({ ...binding, operation: 'click', elementId: 1, nextContextVersion: 3 }));
  expect(stale.status).toBe('rejected');
  expect(await site.evaluate(() => saved)).toBe(0);
  const result = await controller.evaluate(async () => {
    const rebound = await invokeDocument({ operation: 'bind', origin: APP, contextVersion: 4 });
    const oldReference = await invokeDocument({ ...rebound.binding, operation: 'click', elementId: 1, nextContextVersion: 5 });
    const fresh = await invokeDocument({ ...rebound.binding, operation: 'read_page', nextContextVersion: 6 });
    const click = await invokeDocument({ ...fresh.binding, operation: 'click', elementId: 1, nextContextVersion: 7 });
    return { rebound, oldReference, fresh, click };
  });
  expect(result.oldReference.status).toBe('rejected');
  expect(result.fresh.status).toBe('completed');
  expect(result.click.status).toBe('completed');
  expect(result.rebound.binding.contextVersion).toBe(4);
  expect(await site.evaluate(() => saved)).toBe(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ROUTE');
});
