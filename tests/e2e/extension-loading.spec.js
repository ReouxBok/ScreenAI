import { test, expect } from './fixtures.js';

test.describe('Extension — loading and bootstrap', () => {
  test('the service worker registers and exposes a chrome-extension:// URL', async ({ serviceWorker, extensionId }) => {
    expect(serviceWorker).toBeTruthy();
    // The packaged public key keeps local builds on the same origin accepted
    // by the production proxy and assigned by the Chrome Web Store.
    expect(extensionId).toBe('fpkgfhhomlijmhbgcpbpjnfafdedfccj');
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

  test('host permissions are limited to the Limova app and proxy', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.host_permissions.some(h => h.includes('new.limova.ai'))).toBe(true);
    expect(manifest.host_permissions).not.toContain('https://api.new.limova.ai/*');
    expect(manifest.host_permissions.some(h => h.includes('limova-proxy'))).toBe(true);
    expect(manifest.host_permissions).toContain('https://vercel.com/*');
    expect(manifest.content_security_policy.extension_pages).toContain('https://vercel.com');
  });

  test('content script matches are configured for Limova only', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.content_scripts.length).toBeGreaterThan(0);
    for (const cs of manifest.content_scripts) {
      expect(cs.matches).toEqual(['https://new.limova.ai/*']);
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

  test('GET_SETTINGS returns hasApiKey: true (server-side keys)', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
    );
    expect(result).toEqual({ hasApiKey: true });
    await page.close();
  });
});
