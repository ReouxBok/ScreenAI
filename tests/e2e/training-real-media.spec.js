import { test, expect } from './fixtures.js';

const SESSION = '88888888-8888-4888-8888-888888888888';

test('real MediaRecorder and Blob SDK retain a video when Studio confirmation must be retried', async ({ mediaContext: context, mediaExtensionId: extensionId }) => {
  const requests = [], parts = [], confirmations = [];
  let pathname;
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  await context.route('https://api.new.limova.ai/**', route => route.abort());
  await context.route('https://studio.limova.ai/api/training/sessions/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON();
    expect(request.headers().authorization).toBe('Bearer local-training-token');
    if (request.url().endsWith('/recording-token')) {
      expect(body.sessionId).toBe(SESSION);
      pathname = body.pathname;
      return route.fulfill({ headers, body: JSON.stringify({ clientToken: 'vercel_blob_client_fixture_localtoken' }) });
    }
    expect(request.url()).toContain('/recording-confirm');
    confirmations.push(body);
    return route.fulfill({ status: confirmations.length === 1 ? 503 : 200, headers, body: '{}' });
  });
  await context.route('https://vercel.com/api/blob/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const action = request.headers()['x-mpu-action'];
    requests.push(action);
    expect(new URL(request.url()).searchParams.get('pathname')).toBe(pathname);
    expect(request.headers().authorization).toBe('Bearer vercel_blob_client_fixture_localtoken');
    if (action === 'create') return route.fulfill({ headers, body: JSON.stringify({ key: pathname, uploadId: 'fixture-upload' }) });
    if (action === 'upload') {
      parts.push(request.postDataBuffer());
      return route.fulfill({ headers, body: JSON.stringify({ etag: 'fixture-part' }) });
    }
    expect(action).toBe('complete');
    expect(request.postDataJSON()).toEqual([{ partNumber: 1, etag: 'fixture-part' }]);
    return route.fulfill({ headers, body: JSON.stringify({ pathname, url: `https://fixture.private.blob.vercel-storage.com/${pathname}`, contentType: 'video/webm' }) });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const drawing = canvas.getContext('2d');
    let frame = 0;
    window.paintRecording = setInterval(() => {
      drawing.fillStyle = frame++ % 2 ? '#227744' : '#332288'; drawing.fillRect(0, 0, 320, 180);
    }, 50);
    window.videoStream = canvas.captureStream(12);
    // Canvas replaces screen selection; Chromium records fake microphone audio.
    // The packaged recorder and Blob SDK run against intercepted HTTP responses.
    window.trainingRecorder = new window.LimovaTrainingScreenRecorder({ mediaDevices: {
      getDisplayMedia: async () => window.videoStream,
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    } });
    await window.trainingRecorder.start();
    await window.trainingRecorder.beginProgressiveUpload({ token: 'local-training-token', sessionId: '88888888-8888-4888-8888-888888888888' });
  });
  await expect.poll(() => page.evaluate(() => Date.now() - window.trainingRecorder.startedAt)).toBeGreaterThan(1200);
  const first = await page.evaluate(async () => {
    try { await window.trainingRecorder.stopAndUpload({ token: 'local-training-token', sessionId: '88888888-8888-4888-8888-888888888888' }); }
    catch (error) { return error.code; }
  });
  expect(first).toBe('TRAINING_RECORDING_CONFIRMATION_FAILED');
  expect(parts).toHaveLength(1);
  expect(parts[0].length).toBeGreaterThan(100);
  expect([...parts[0].subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  const saved = await page.evaluate(async () => {
    const options = { token: 'local-training-token', sessionId: '88888888-8888-4888-8888-888888888888' };
    const result = await window.trainingRecorder.stopAndUpload(options);
    const repeated = await window.trainingRecorder.stopAndUpload(options);
    clearInterval(window.paintRecording);
    return { result, repeated, active: window.trainingRecorder.active, tracks: window.trainingRecorder.stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState })) };
  });
  expect(saved.result).toEqual(saved.repeated);
  expect(saved.result.size).toBe(parts[0].length);
  expect(saved.active).toBe(false);
  expect(saved.tracks).toEqual(expect.arrayContaining([{ kind: 'video', state: 'ended' }, { kind: 'audio', state: 'ended' }]));
  expect(requests).toEqual(['create', 'upload', 'complete']);
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0]).toEqual(confirmations[1]);
  expect(confirmations[0]).toMatchObject({ sessionId: SESSION, pathname });
  const dimensions = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    try {
      const video = document.createElement('video'); video.muted = true;
      const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
      video.src = url; await loaded;
      return { width: video.videoWidth, height: video.videoHeight };
    } finally { URL.revokeObjectURL(url); }
  }, parts[0].toString('base64'));
  expect(dimensions).toEqual({ width: 320, height: 180 });
});
