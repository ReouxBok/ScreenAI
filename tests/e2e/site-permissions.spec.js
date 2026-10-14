import { test, expect, APP } from './native-chat-fixture.js';

for (const [language, allowedText, invalidText] of [
  ['fr', 'Accès autorisé à', 'Indique une adresse HTTPS valide'],
  ['en', 'Access allowed to', 'Enter a valid HTTPS address'],
  ['es', 'Acceso autorizado a', 'Introduce una dirección HTTPS válida'],
]) test(`site permission controls preserve origin scope and per-turn consent in ${language}`, async ({ nativeChat }) => {
  const { panel } = nativeChat;
  await expect(panel.locator('#authPanel')).toBeHidden();
  await panel.locator('#menuBtn').click();
  await panel.locator(`.lang-option[data-lang="${language}"]`).click();
  await expect(panel.locator('html')).toHaveAttribute('lang', language);
  const before = await panel.evaluate(async () => {
    const original = chrome.permissions.request.bind(chrome.permissions);
    window.requestedOrigins = [];
    chrome.permissions.request = request => { window.requestedOrigins.push(request); return original(request); };
    return { manifest: chrome.runtime.getManifest(), granted: await chrome.permissions.getAll() };
  });
  expect(before.manifest.optional_host_permissions).toEqual(['https://*/*']);
  expect(before.granted.origins).not.toContain('https://*/*');
  await panel.locator('[data-i18n="limovaOtherSite"]').click();
  await panel.locator('#limovaSiteOrigin').fill(`${APP}/a-path?private=must-not-forward#fragment`);
  await panel.locator('#limovaSiteAllow').click();
  await expect(panel.locator('#limovaSiteStatus')).toContainText(`${allowedText} ${APP}.`);
  expect(await panel.evaluate(() => window.requestedOrigins)).toEqual([{ origins: [`${APP}/*`] }]);
  await expect(panel.locator('#limovaBrowser')).not.toBeChecked();
  expect((await panel.evaluate(() => chrome.permissions.getAll())).origins).not.toContain('https://*/*');
  for (const invalid of ['http://example.test', 'https://user:secret@example.test', 'https://*.example.test', 'https://%2a.example.test']) {
    await panel.locator('#limovaSiteOrigin').fill(invalid);
    await panel.locator('#limovaSiteAllow').click();
    await expect(panel.locator('#limovaSiteStatus')).toContainText(invalidText);
  }
  expect(await panel.evaluate(() => window.requestedOrigins)).toHaveLength(1);
});
