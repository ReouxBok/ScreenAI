import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const extensionId = key => [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join('');

test('production and staging install together with separate permissions and storage', async () => {
  const paths = ['build', 'build-staging'].map(directory => path.resolve(directory));
  const manifests = await Promise.all(paths.map(directory => readFile(path.join(directory, 'manifest.json'), 'utf8').then(JSON.parse)));
  const ids = manifests.map(manifest => extensionId(manifest.key));
  expect(ids[0]).not.toBe(ids[1]);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${paths.join(',')}`, `--load-extension=${paths.join(',')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'],
  });
  try {
    await expect.poll(() => context.serviceWorkers().length).toBe(2);
    const workers = ids.map(id => context.serviceWorkers().find(worker => new URL(worker.url()).host === id));
    expect(workers.every(Boolean)).toBe(true);
    await Promise.all(workers.map((worker, index) => worker.evaluate(async index => {
      await chrome.storage.local.set({ environmentIsolation: index });
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('environment-isolation', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('values');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('values', 'readwrite');
        transaction.objectStore('values').put(index, 'same-key');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    }, index)));
    const values = await Promise.all(workers.map(worker => worker.evaluate(async () => {
      const local = (await chrome.storage.local.get('environmentIsolation')).environmentIsolation;
      const database = await new Promise(resolve => { const request = indexedDB.open('environment-isolation', 1); request.onsuccess = () => resolve(request.result); });
      const indexed = await new Promise(resolve => { const request = database.transaction('values').objectStore('values').get('same-key'); request.onsuccess = () => resolve(request.result); });
      database.close();
      return { local, indexed };
    })));
    expect(values).toEqual([{ local: 0, indexed: 0 }, { local: 1, indexed: 1 }]);
    expect(await workers[1].evaluate(() => chrome.permissions.contains({ origins: ['https://api.new.limova.ai/*'] }))).toBe(false);
    expect(await workers[0].evaluate(() => chrome.permissions.contains({ origins: ['https://api.staging.new.limova.ai/*'] }))).toBe(false);
    expect(await workers[1].evaluate(() => chrome.permissions.contains({ origins: ['https://api.staging.new.limova.ai/*'] }))).toBe(true);
  } finally { await context.close(); }
});
