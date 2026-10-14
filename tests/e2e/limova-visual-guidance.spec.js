import { test, expect, CONVERSATION, WORKSPACE } from './native-chat-fixture.js';

test.use({ nativeViewport: true });

test('native page analysis uploads masked pixels, highlights the exact field and rejects a destructive click', async ({ nativeChat }) => {
  const { panel, app, context, worker, state, calls, legacy, errors } = nativeChat;
  await app.evaluate(() => {
    document.body.style.cssText = 'margin:0;background:white';
    document.querySelector('main').style.paddingTop = '180px';
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute;left:20px;top:20px;width:30px;height:30px;background:blue';
    document.body.append(marker);
    document.querySelector('input').style.cssText = 'position:absolute;left:80px;top:20px;width:80px;height:30px;background:red';
    const field = document.querySelector('textarea');
    field.style.cssText = 'position:absolute;left:80px;top:80px;width:160px;height:40px;background:red';
    const privateRegion = document.createElement('div');
    privateRegion.dataset.private = 'true';
    privateRegion.textContent = 'PRIVATE_REGION';
    privateRegion.style.cssText = 'position:absolute;left:280px;top:20px;width:80px;height:30px;background:red';
    document.body.append(privateRegion);
    document.querySelector('#action').textContent = 'Supprimer le brouillon';
    window.guidanceTargets = [];
    window.guidanceObserver = setInterval(() => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect?.target;
        if (target && !window.guidanceTargets.includes(target)) window.guidanceTargets.push(target);
      }
    }, 10);
  });
  await app.bringToFront();
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const targetInfo = targetInfos.find(target => target.url === app.url());
  expect(targetInfo).toBeTruthy();
  await browserCdp.send('Extensions.triggerAction', { id: new URL(worker.url()).host, targetId: targetInfo.targetId });
  let previousSize, stableSince = Date.now();
  await expect.poll(async () => {
    const size = await app.evaluate(() => `${innerWidth}x${innerHeight}`);
    if (size !== previousSize) { previousSize = size; stableSince = Date.now(); }
    return Date.now() - stableSince;
  }, { intervals: [100], timeout: 5000 }).toBeGreaterThan(300);
  const viewport = await app.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  let fieldId, destructiveId;
  state.reply = 'Écris ton brief ici. La suppression reste bloquée en mode analyse.';
  state.browserActions = [
    { operation: 'read_page' },
    body => {
      const elements = JSON.parse(body.browserResult.observation).elements;
      fieldId = elements.find(item => item.label === 'Brief')?.elementId;
      destructiveId = elements.find(item => item.label === 'Supprimer le brouillon')?.elementId;
      return { operation: 'screenshot' };
    },
    () => ({ operation: 'highlight', elementId: fieldId }),
    { operation: 'highlight', elementId: 999999 },
    () => ({ operation: 'click', elementId: destructiveId }),
  ];
  await panel.evaluate(() => document.getElementById('screenshotBtn').click());
  await expect(panel.locator('.message.assistant .message-content')).toHaveText(state.reply);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0]).toMatchObject({ name: 'browser-screenshot.png', type: 'image/png', query: '?isTemporary=true&useAsDefaultContext=false' });
  const pixels = await panel.evaluate(async ({ upload, viewport }) => {
    const bytes = Uint8Array.from(atob(upload.data), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: upload.type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0);
    const pixel = (x, y) => [...drawing.getImageData(Math.floor(x * bitmap.width / viewport.width), Math.floor(y * bitmap.height / viewport.height), 1, 1).data];
    const result = { public: pixel(30, 30), password: pixel(100, 30), field: pixel(100, 100), private: pixel(300, 30) };
    bitmap.close(); return result;
  }, { upload: state.uploads[0], viewport });
  expect(pixels).toEqual({ public: [0, 0, 255, 255], password: [229, 231, 235, 255], field: [229, 231, 235, 255], private: [229, 231, 235, 255] });
  expect(await app.evaluate(() => {
    clearInterval(window.guidanceObserver);
    return { targets: window.guidanceTargets.length, exact: window.guidanceTargets[0] === document.querySelector('textarea'), clicks: window.clicks, inputs: window.inputEvents };
  })).toEqual({ targets: 1, exact: true, clicks: 0, inputs: 0 });
  const messages = calls.filter(call => call.path === `/message/${CONVERSATION}`);
  const receipts = messages.slice(1).map(call => call.body.browserResult);
  expect(receipts.map(receipt => receipt.status)).toEqual(['completed', 'completed', 'completed', 'rejected', 'rejected']);
  expect(receipts[1].imageFileId).toBe('77777777-7777-4777-8777-777777777777');
  expect(new Set(receipts.map(receipt => receipt.turnId)).size).toBe(1);
  expect(calls.filter(call => call.path === '/files')).toEqual([expect.objectContaining({ authenticated: true, workspace: WORKSPACE })]);
  expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_FIELD_VALUE|NEVER_TRANSMIT_THIS_SECRET|PRIVATE_REGION|base64/);
  await expect(panel.locator('.action-card')).toHaveCount(0);
  await expect(panel.locator('.screenshot-bubble')).toHaveCount(0);
  await expect(app.locator('#limova-visual-capture-overlays')).toHaveCount(0);
  await expect(panel.locator('#limovaBrowser')).not.toBeChecked();
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});
