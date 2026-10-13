import { test, expect } from './fixtures.js';

test('captures negotiated PCM with the real worklet and releases the fake microphone', async ({ mediaContext, mediaExtensionId }) => {
  const page = await mediaContext.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/microphone-permission.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto(`chrome-extension://${mediaExtensionId}/src/sidebar/microphone-permission.html`);
  await page.evaluate(async () => {
    const { openNativeAudio } = await import(chrome.runtime.getURL('src/limova/native-audio.js'));
    globalThis.audioErrors = []; globalThis.frames = 0; globalThis.frameLengths = new Set(); globalThis.nonzero = false;
    globalThis.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    globalThis.audio = await openNativeAudio({ stream, session: { inputSampleRate: 16000, outputSampleRate: 24000, maxAudioFrameBytes: 2560 },
      onFrame: bytes => { frames += 1; frameLengths.add(bytes.length); nonzero ||= bytes.some(value => value !== 0); },
      onError: error => audioErrors.push(error.message),
    });
  });
  await expect.poll(() => page.evaluate(() => frames)).toBeGreaterThan(3);
  expect(await page.evaluate(() => [...frameLengths])).toEqual([640]);
  await expect.poll(() => page.evaluate(() => nonzero)).toBe(true);
  expect(await page.evaluate(() => audio.play({ sequence: 0, audio: Array(4800).fill(0) }))).toBe(true);
  await page.waitForTimeout(60);
  const played = await page.evaluate(() => audio.interrupt());
  expect(played).toBeGreaterThanOrEqual(0); expect(played).toBeLessThanOrEqual(100);
  await page.evaluate(() => audio.stop());
  expect(await page.evaluate(() => stream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  const count = await page.evaluate(() => frames);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => frames)).toBe(count);
  expect(await page.evaluate(() => audioErrors)).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});
