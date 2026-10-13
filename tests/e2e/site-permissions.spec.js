import { test, expect } from './fixtures.js';

test('declares optional HTTPS access without granting all hosts and requests from a real panel click', async ({ context, extensionId }) => {
  await context.route('https://api.new.limova.ai/**', route => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  const permissions = await page.evaluate(async () => ({ manifest: chrome.runtime.getManifest(), granted: await chrome.permissions.getAll() }));
  expect(permissions.manifest.optional_host_permissions).toEqual(['https://*/*']);
  expect(permissions.granted.origins).not.toContain('https://*/*');
  await page.evaluate(() => { document.getElementById('authPanel').hidden = true; document.documentElement.dataset.authState = 'authenticated'; document.getElementById('limovaControls').hidden = false; });
  await page.getByText('Autoriser un autre site', { exact: true }).click();
  await page.locator('#limovaSiteOrigin').fill('https://new.limova.ai/a-path?private=value');
  await page.locator('#limovaSiteAllow').click();
  await expect(page.locator('#limovaSiteStatus')).toContainText('Accès autorisé à https://new.limova.ai.');
  const after = await page.evaluate(() => chrome.permissions.getAll());
  expect(after.origins).not.toContain('https://*/*');
});
