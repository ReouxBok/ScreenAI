import { test, expect } from './native-chat-fixture.js';

test('training microphone refusal offers permission recovery before contacting Studio', async ({ nativeChat }) => {
  const { panel, context, calls, legacy, errors } = nativeChat;
  const studioRequests = [];
  context.on('request', request => { if (new URL(request.url()).hostname === 'studio.limova.ai') studioRequests.push(request.url()); });
  await panel.locator('#menuBtn').click();
  await panel.locator('#trainingBtn').click();
  await panel.locator('#trainingToken').fill('training-permission-local-fixture-token');
  await panel.evaluate(() => {
    window.trainingPermissionRequests = 0;
    window.recordingAborts = 0;
    window.LimovaTrainingScreenRecorder = class {
      async start() { const error = new Error('Autorise le microphone.'); error.code = 'TRAINING_MIC_REQUIRED'; throw error; }
      abort() { window.recordingAborts++; }
    };
    window.LimovaVoiceSession = class {
      async requestMicrophonePermissionInTab() { window.trainingPermissionRequests++; }
    };
  });
  await panel.locator('#trainingStart').click();
  await expect(panel.locator('#trainingFeedback')).toContainText('Microphone autorisé');
  await expect(panel.locator('#trainingStart')).toBeEnabled();
  expect(await panel.evaluate(() => ({ permissions: window.trainingPermissionRequests, aborted: window.recordingAborts })))
    .toEqual({ permissions: 1, aborted: 1 });
  expect(calls.filter(call => call.method === 'POST')).toEqual([]);
  expect(studioRequests).toEqual([]);
  expect(legacy).toEqual([]); expect(errors).toEqual([]);
});
