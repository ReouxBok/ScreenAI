import { test, expect } from './native-chat-fixture.js';

test('training microphone refusal offers permission recovery before contacting Studio', async ({ nativeChat }) => {
  const { panel, context, calls, legacy, errors } = nativeChat;
  const studioRequests = [];
  context.on('request', request => { if (new URL(request.url()).hostname === 'studio.limova.ai') studioRequests.push(request.url()); });
  await panel.locator('#menuBtn').click();
  await panel.locator('#trainingBtn').click();
  await panel.locator('#trainingToken').fill('training-permission-local-fixture-token');
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise(() => {}) },
    });
  });
  await panel.evaluate(() => {
    window.recordingAborts = 0;
    window.LimovaTrainingScreenRecorder = class {
      async start() { const error = new Error('Autorise le microphone.'); error.code = 'TRAINING_MIC_REQUIRED'; throw error; }
      abort() { window.recordingAborts++; }
    };
  });
  const permissionTabPromise = context.waitForEvent('page');
  await panel.locator('#trainingStart').click();
  const permissionTab = await permissionTabPromise;
  await permissionTab.waitForURL(/microphone-permission\.html/);
  await permissionTab.evaluate(() => chrome.runtime.sendMessage({ type: 'MICROPHONE_PERMISSION_RESULT', granted: true }));
  await expect(panel.locator('#trainingFeedback')).toContainText('Microphone autorisé');
  await expect(panel.locator('#trainingStart')).toBeEnabled();
  expect(await panel.evaluate(() => window.recordingAborts)).toBe(1);
  expect(calls.filter(call => call.method === 'POST')).toEqual([]);
  expect(studioRequests).toEqual([]);
  expect(legacy).toEqual([]); expect(errors).toEqual([]);
});
