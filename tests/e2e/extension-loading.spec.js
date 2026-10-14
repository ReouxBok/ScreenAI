import { test, expect } from './fixtures.js';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const environment = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');

test.describe('Extension — loading and bootstrap', () => {
  test('the service worker registers and exposes a chrome-extension:// URL', async ({ serviceWorker, extensionId }) => {
    expect(serviceWorker).toBeTruthy();
    // The packaged public key keeps local builds on the same origin accepted
    // by the production proxy and assigned by the Chrome Web Store.
    expect(extensionId).toBe(environment.name === 'staging' ? 'nfdhginlmmnfaglcbhoiecpjpaopbjjg' : 'fpkgfhhomlijmhbgcpbpjnfafdedfccj');
    expect(serviceWorker.url()).toContain(extensionId);
    expect(serviceWorker.url()).toMatch(/background\.js$/);
  });

  test('the manifest is valid and exposes the expected entry points', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(114);
    expect(manifest.name).toContain('Limova');
    expect(manifest.background.service_worker).toBe('src/background.js');
    expect(manifest.background.type).toBe('module');
    expect(manifest.side_panel.default_path).toBe('src/sidebar/sidebar.html');
  });

  test('required permissions are declared', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['activeTab', 'sidePanel', 'storage', 'scripting', 'webNavigation'])
    );
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('cookies');
  });

  test('host permissions match the target environment and optional sites stay ungranted', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    const origins = [environment.apiOrigin, environment.appOrigin];
    if (environment.name === 'production') origins.push('https://studio.limova.ai', 'https://vercel.com',
      'https://pihloilpc5svuzjv.private.blob.vercel-storage.com');
    expect(manifest.host_permissions).toEqual(origins.map(origin => `${origin}/*`));
    expect(manifest.optional_host_permissions).toEqual(['https://*/*']);
    expect(await serviceWorker.evaluate(() => chrome.permissions.contains({ origins: ['https://*/*'] }))).toBe(false);
    expect(manifest.content_security_policy.extension_pages).toContain(`connect-src ${environment.apiOrigin}`);
    if (environment.name === 'staging') {
      expect(manifest.content_security_policy.extension_pages).not.toContain('https://api.new.limova.ai');
      expect(manifest.content_security_policy.extension_pages).not.toContain('https://studio.limova.ai');
    }
  });

  test('content script matches are configured for Limova only', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.content_scripts.length).toBeGreaterThan(0);
    for (const cs of manifest.content_scripts) {
      expect(cs.matches).toEqual([`${environment.appOrigin}/*`]);
    }
  });
});

test.describe('Extension — messaging', () => {
  test('GET_SESSION_STATE reaches the background and returns a boolean', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' })
    );
    expect(result).toEqual(expect.objectContaining({ active: expect.any(Boolean) }));
    await page.close();
  });

  test('GET_LOGS message returns formatted logs via the sidebar → background round-trip', async ({ context, extensionId }) => {
    const page = await context.newPage();
    // Load the sidebar HTML so chrome.runtime is available from a page with extension origin
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_LOGS' })
    );
    expect(result).toHaveProperty('logs');
    expect(typeof result.logs).toBe('string');
    expect(result.logs).toContain('Limova');
    await page.close();
  });

  test('legacy settings routes are no longer exposed', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    );
    expect(result).toEqual({ error: 'Unknown message type' });
    await page.close();
  });
});
