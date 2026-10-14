import { test, expect, APP } from './native-chat-fixture.js';

const turns = calls => calls.filter(call => /^\/message\/[^/]+$/.test(call.path) && !call.body.kind);
async function startFollowing(panel) {
  await panel.locator('#limovaNew').click();
  await expect(panel.locator('#limovaFollow')).toBeEnabled();
  await panel.locator('#limovaFollow').check();
  await expect(panel.locator('.message.assistant')).toHaveCount(1);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  await expect(panel.locator('#limovaFollow')).toBeChecked();
}

test('follows SPA and modal changes through observation-only Charly turns until unchecked', async ({ nativeChat }) => {
  const { panel, app, calls, state, legacy, errors } = nativeChat;
  state.browserActions = [{ operation: 'read_page' }, { operation: 'click', elementId: 1 }];
  await startFollowing(panel);
  await app.waitForTimeout(200);
  await app.evaluate(() => history.pushState({}, '', '/integrations?secret=PRIVATE_ROUTE'));
  await expect(panel.locator('.message.assistant')).toHaveCount(2);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  await app.goto(`${APP}/profile`);
  await expect(panel.locator('.message.assistant')).toHaveCount(3);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  await app.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" style="position:fixed;inset:100px;background:white"><h2>Connexion réussie</h2><button>Fermer</button></div>'));
  await expect(panel.locator('.message.assistant')).toHaveCount(4);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  expect(turns(calls)).toHaveLength(4);
  expect(await app.evaluate(() => window.clicks)).toBe(0);
  const receipts = calls.filter(call => call.body?.browserResult).map(call => call.body.browserResult);
  expect(receipts.filter(receipt => receipt.status === 'rejected')).toHaveLength(4);
  expect(receipts.some(receipt => receipt.observation.includes('Connexion réussie'))).toBe(true);
  expect(JSON.stringify(receipts)).not.toContain('PRIVATE_ROUTE');
  await panel.locator('#limovaFollow').uncheck();
  await app.evaluate(() => history.pushState({}, '', '/after-stop'));
  await app.waitForTimeout(2200);
  expect(turns(calls)).toHaveLength(4);
  expect(legacy).toEqual([]); expect(errors).toEqual([]);
});

for (const ending of ['other-tab', 'new-conversation', 'privacy', 'flag', 'session', 'panel-reload']) test(`automatic observation stops on ${ending}`, async ({ nativeChat }) => {
  const { panel, app, calls, context, worker, errors, state } = nativeChat;
  await startFollowing(panel);
  if (ending === 'other-tab') { const other = await context.newPage(); await other.goto('about:blank'); }
  if (ending === 'new-conversation') await panel.locator('#limovaNew').click();
  if (ending === 'privacy') await worker.evaluate(() => chrome.storage.local.set({ limova_ai_processing_consent_v1: false }));
  if (ending === 'flag' || ending === 'session') {
    if (ending === 'flag') state.enabled = false;
    else state.authenticated = false;
    await app.evaluate(() => history.pushState({}, '', '/trigger-verification'));
  }
  if (ending === 'panel-reload') await panel.reload();
  await expect(panel.locator('#limovaFollow')).not.toBeChecked();
  await app.bringToFront();
  await app.evaluate(() => history.pushState({}, '', '/profile'));
  await app.waitForTimeout(2200);
  expect(turns(calls)).toHaveLength(1);
  expect(errors).toEqual([]);
});
