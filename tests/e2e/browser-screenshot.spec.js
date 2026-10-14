import { test, expect } from './fixtures.js';
import { extensionEnvironment } from '../../scripts/extension-environments.mjs';

const { appOrigin: APP, apiOrigin: API } = extensionEnvironment(process.env.LIMOVA_E2E_ENV ?? 'production');

test.use({ nativeViewport: true });

async function controllerPage(context, extensionId) {
  await context.route(`${API}/**`, route => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  return page;
}

test('masks every supplied region in real OffscreenCanvas without a 120-region truncation', async ({ context, extensionId }) => {
  const page = await controllerPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const { renderMaskedBrowserScreenshot } = await import('../limova/browser-screenshot.js');
    const source = document.createElement('canvas');
    source.width = 600; source.height = 40;
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(0, 0, 600, 40);
    const masks = Array.from({ length: 121 }, (_, index) => ({ left: index * 2, top: 0, width: 1, height: 10 }));
    const output = await renderMaskedBrowserScreenshot(source.toDataURL(), { viewportWidth: 300, viewportHeight: 20, masks });
    const bitmap = await createImageBitmap(output);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const lastMask = [...context.getImageData(480, 2, 1, 1).data];
    const publicPixel = [...context.getImageData(590, 30, 1, 1).data];
    bitmap.close();
    return { lastMask, publicPixel, type: output.type };
  });
  expect(result).toEqual({ lastMask: [229, 231, 235, 255], publicPixel: [0, 0, 255, 255], type: 'image/png' });
});

test('rejects changed aspect ratio rather than masking the wrong pixels', async ({ context, extensionId }) => {
  const page = await controllerPage(context, extensionId);
  const error = await page.evaluate(async () => {
    const { renderMaskedBrowserScreenshot } = await import('../limova/browser-screenshot.js');
    const source = document.createElement('canvas'); source.width = 200; source.height = 100;
    try { await renderMaskedBrowserScreenshot(source.toDataURL(), { viewportWidth: 100, viewportHeight: 100, masks: [] }); }
    catch (error) { return error.message; }
  });
  expect(error).toBe('Screenshot viewport changed');
});

test('captures a real active tab and delivers only masked pixels through the assembled driver', async ({ context, extensionId }) => {
  await context.route(`${APP}/capture-fixture`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0;background:white">
    <div style="position:absolute;left:20px;top:20px;width:30px;height:30px;background:blue"></div>
    <input value="SECRET_VALUE" style="position:absolute;left:80px;top:20px;width:80px;height:30px;background:red">
    <div data-private style="position:absolute;left:80px;top:80px;width:80px;height:30px;background:red">PRIVATE</div>
    <secret-box style="position:absolute;left:20px;top:150px;display:block;width:10px;height:10px"></secret-box>
    <script>document.querySelector('secret-box').attachShadow({mode:'closed'}).innerHTML='<input value="SHADOW_SECRET" style="width:180px;height:30px;background:red">';</script>
  </body></html>` }));
  const site = await context.newPage();
  await site.goto(`${APP}/capture-fixture`);
  const controller = await controllerPage(context, extensionId);
  await site.bringToFront();
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const targetInfo = targetInfos.find(target => target.url === site.url());
  expect(targetInfo).toBeTruthy();
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo.targetId });
  await expect.poll(() => site.evaluate(() => document.readyState)).toBe('complete');
  let previousSize, stableSince = Date.now();
  await expect.poll(async () => {
    const size = await site.evaluate(() => `${innerWidth}x${innerHeight}`);
    if (size !== previousSize) { previousSize = size; stableSince = Date.now(); }
    return Date.now() - stableSince;
  }, { intervals: [100], timeout: 5000 }).toBeGreaterThan(300);
  const viewport = await site.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const result = await controller.evaluate(async viewport => {
    const { createBrowserDriver } = await import('../limova/browser-driver.js');
    let version = 0, uploads = 0, pixels;
    const driver = createBrowserDriver({ chrome, scope: {}, hasConsent: async () => true,
      journal: { allocateVersion: async () => ++version },
      uploadScreenshot: async image => {
        uploads++;
        const bitmap = await createImageBitmap(image);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const pixel = (x, y) => [...context.getImageData(Math.floor(x * bitmap.width / viewport.width), Math.floor(y * bitmap.height / viewport.height), 1, 1).data];
        pixels = { public: pixel(30, 30), input: pixel(100, 30), private: pixel(100, 90), shadow: pixel(130, 165) };
        bitmap.close();
        return { fileId: '77777777-7777-4777-8777-777777777777' };
      } });
    const target = await driver.readPage();
    const outcome = await driver.execute({ target, input: { operation: 'screenshot' } });
    return { outcome, uploads, pixels };
  }, viewport);
  expect(result.outcome.status).toBe('completed');
  expect(result.uploads).toBe(1);
  expect(result.pixels).toEqual({ public: [0, 0, 255, 255], input: [229, 231, 235, 255], private: [229, 231, 235, 255], shadow: [229, 231, 235, 255] });
  expect(await site.locator('input').inputValue()).toBe('SECRET_VALUE');
  expect(await site.locator('[data-private]').textContent()).toBe('PRIVATE');
  await browserCdp.detach();
});


test('binds masking geometry to the document and observes private-region changes', async ({ context, extensionId }) => {
  await context.route(`${APP}/geometry-fixture`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <input value="SECRET"><svg width="40" height="40" data-private><text>SECRET_SVG</text></svg>
    <secret-box style="display:block;width:50px;height:50px"></secret-box>
    <script>document.querySelector('secret-box').attachShadow({mode:'closed'}).innerHTML='<input value="SHADOW_SECRET">';</script>
  </body></html>` }));
  const site = await context.newPage(); await site.goto(`${APP}/geometry-fixture`);
  const controller = await controllerPage(context, extensionId);
  const before = await controller.evaluate(async APP => {
    const { createBrowserBinding } = await import('../limova/browser-binding.js');
    let version = 0;
    window.screenshotBinding = createBrowserBinding({ scripting: chrome.scripting, allocateVersion: async () => ++version });
    const [tab] = await chrome.tabs.query({ url: `${APP}/geometry-fixture` });
    window.screenshotTarget = await screenshotBinding.bind(tab.id, APP);
    return screenshotBinding.readScreenshotGeometry(screenshotTarget);
  }, APP);
  expect(before.masks.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(before)).not.toContain('SECRET');
  await site.evaluate(() => { const privateRegion = document.createElement('div'); privateRegion.dataset.private = ''; privateRegion.style.cssText = 'width:40px;height:40px'; privateRegion.textContent = 'NEW_SECRET'; document.body.append(privateRegion); });
  const after = await controller.evaluate(() => screenshotBinding.readScreenshotGeometry(screenshotTarget));
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.masks.length).toBeGreaterThan(before.masks.length);
  await site.evaluate(() => { const input = document.querySelector('input'); input.setAttribute('data-transient', 'changed'); input.removeAttribute('data-transient'); });
  const restored = await controller.evaluate(() => screenshotBinding.readScreenshotGeometry(screenshotTarget));
  expect(restored.masks).toEqual(after.masks);
  expect(restored.revision).toBeGreaterThan(after.revision);
  await site.reload();
  const error = await controller.evaluate(async () => {
    try { await screenshotBinding.readScreenshotGeometry(screenshotTarget); } catch (error) { return error.message; }
  });
  expect(error).toBeTruthy();
});
