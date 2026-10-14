// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ createMultipartUploader: vi.fn(), upload: vi.fn() }));
vi.mock('@vercel/blob/client', () => sdk);
import '../../../src/sidebar/training-recording-upload.entry.js';

const result = { pathname: 'training-recordings/session/recording.webm', url: 'https://fixture.private.blob.vercel-storage.com/recording.webm' };
let complete, uploadPart, fetchMock;
beforeEach(() => {
  complete = vi.fn().mockResolvedValue(result);
  uploadPart = vi.fn(async partNumber => ({ partNumber, etag: `part-${partNumber}` }));
  sdk.createMultipartUploader.mockResolvedValue({ complete, uploadPart });
  fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ clientToken: 'fixture-client-token' })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function recording() {
  const upload = await globalThis.LimovaTrainingMultipartUpload({ token: 'fixture-staff-token', sessionId: 'session' });
  await upload.uploadPart(1, new Blob(['recorded-video']));
  return upload;
}

it.each(['http', 'network'])('retries only Studio confirmation after %s failure, retaining the completed video', async failure => {
  const upload = await recording();
  if (failure === 'http') fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  else fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
  await expect(upload.complete({ durationMs: 2500 })).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await upload.complete({ durationMs: 2500 })).toEqual(result);
  expect(await upload.complete({ durationMs: 2500 })).toEqual(result);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(uploadPart).toHaveBeenCalledTimes(1);
  const confirmations = fetchMock.mock.calls.filter(([url]) => url.endsWith('/recording-confirm'));
  expect(confirmations).toHaveLength(2);
  expect(confirmations.map(([, init]) => JSON.parse(init.body))).toEqual([
    { sessionId: 'session', pathname: result.pathname, durationMs: 2500 },
    { sessionId: 'session', pathname: result.pathname, durationMs: 2500 },
  ]);
});

it('joins concurrent completion requests and keeps the successful result', async () => {
  const upload = await recording();
  const values = await Promise.all([upload.complete({ durationMs: 1000 }), upload.complete({ durationMs: 1000 })]);
  expect(values).toEqual([result, result]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/recording-confirm'))).toHaveLength(1);
});

it('allows explicit retry when storage completion itself failed without confirming a nonexistent result', async () => {
  const upload = await recording();
  complete.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(upload.complete({ durationMs: 1000 })).rejects.toThrow('Storage unavailable');
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/recording-confirm'))).toHaveLength(0);
  expect(await upload.complete({ durationMs: 1000 })).toEqual(result);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(uploadPart).toHaveBeenCalledTimes(1);
});

it.each(['http', 'network'])('retains a completed simple upload when Studio confirmation has a %s failure', async failure => {
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  sdk.upload.mockResolvedValue(result);
  const options = { blob: new Blob(['video'], { type: 'video/webm' }), token: 'staff', sessionId: 'session', durationMs: 1200 };
  if (failure === 'http') fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  else fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
  await expect(globalThis.LimovaTrainingRecordingUpload(options)).rejects.toThrow();
  expect(await globalThis.LimovaTrainingRecordingUpload(options)).toEqual(result);
  expect(await globalThis.LimovaTrainingRecordingUpload(options)).toEqual(result);
  expect(sdk.upload).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('deduplicates simple completion but does not reuse another session or token result', async () => {
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  sdk.upload.mockResolvedValue(result);
  const options = { blob: new Blob(['video']), token: 'staff', sessionId: 'session', durationMs: 1200 };
  await Promise.all([globalThis.LimovaTrainingRecordingUpload(options), globalThis.LimovaTrainingRecordingUpload(options)]);
  expect(sdk.upload).toHaveBeenCalledTimes(1);
  await globalThis.LimovaTrainingRecordingUpload({ ...options, sessionId: 'another-session' });
  await globalThis.LimovaTrainingRecordingUpload({ ...options, token: 'another-token' });
  expect(sdk.upload).toHaveBeenCalledTimes(3);
});
