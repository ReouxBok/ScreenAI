import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = process.env.EXTENSION_PATH
  ? path.resolve(process.env.EXTENSION_PATH)
  : path.resolve(here, '..', '..', 'build');

/**
 * Playwright fixture that launches a persistent Chromium with the Limova
 * extension loaded in --disable-extensions-except mode. Exposes:
 *   - context: the BrowserContext
 *   - extensionId: the MV3 extension ID (parsed from the service worker URL)
 *   - serviceWorker: the extension service worker (already registered)
 */
export const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--enable-unsafe-extension-debugging',
        '--use-fake-device-for-media-stream',
        '--no-sandbox'
      ]
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },

  mediaContext: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--enable-unsafe-extension-debugging',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--no-sandbox'
      ]
    });
    await use(context);
    await context.close();
  },

  mediaExtensionId: async ({ mediaContext }, use) => {
    let [worker] = mediaContext.serviceWorkers();
    if (!worker) worker = await mediaContext.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  }
});

export const expect = test.expect;
