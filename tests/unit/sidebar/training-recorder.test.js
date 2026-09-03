// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

class FakeTrack extends EventTarget {
  constructor(displaySurface, kind = 'video') {
    super();
    this.displaySurface = displaySurface;
    this.kind = kind;
    this.stopped = false;
  }
  getSettings() { return { displaySurface: this.displaySurface }; }
  stop() { this.stopped = true; }
}

class FakeStream {
  constructor(displaySurface, kind = 'video') { this.tracks = [new FakeTrack(displaySurface, kind)]; this.track = this.tracks[0]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getTracks() { return this.tracks; }
  addTrack(track) { this.tracks.push(track); }
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type) { return type.startsWith('video/webm'); }
  constructor(stream, options = {}) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType || 'video/webm';
    this.state = 'inactive';
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.dispatchEvent(new MessageEvent('dataavailable', { data: new Blob(['screen-video'], { type: 'video/webm' }) }));
    this.dispatchEvent(new Event('stop'));
  }
}

describe('full-screen training recorder', () => {
  beforeAll(async () => {
    await import('../../../src/sidebar/training-recorder.js');
  });

  it('refuses a tab or window capture instead of producing an incomplete flow video', async () => {
    const stream = new FakeStream('browser');
    const recorder = new window.LimovaTrainingScreenRecorder({
      mediaDevices: { getDisplayMedia: vi.fn(async () => stream) },
      MediaRecorderClass: FakeMediaRecorder,
      uploader: vi.fn()
    });

    await expect(recorder.start()).rejects.toMatchObject({ code: 'FULL_SCREEN_REQUIRED' });
    expect(stream.track.stopped).toBe(true);
  });

  it('records the monitor without system audio and uploads the completed WebM privately', async () => {
    const stream = new FakeStream('monitor');
    const microphoneStream = new FakeStream(undefined, 'audio');
    const getDisplayMedia = vi.fn(async () => stream);
    const getUserMedia = vi.fn(async () => microphoneStream);
    const uploader = vi.fn(async () => ({ pathname: 'training-recordings/session/video.webm' }));
    const recorder = new window.LimovaTrainingScreenRecorder({
      mediaDevices: { getDisplayMedia, getUserMedia },
      MediaRecorderClass: FakeMediaRecorder,
      uploader
    });

    await recorder.start();
    const result = await recorder.stopAndUpload({
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      onProgress: vi.fn()
    });

    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true }),
      video: false
    }));
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(uploader).toHaveBeenCalledWith(expect.objectContaining({
      blob: expect.any(Blob),
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      durationMs: expect.any(Number)
    }));
    expect(result.size).toBeGreaterThan(0);
    expect(stream.track.stopped).toBe(true);
    expect(microphoneStream.track.stopped).toBe(true);
  });

  it('does not start a silent tutorial when microphone access is unavailable', async () => {
    const stream = new FakeStream('monitor');
    const recorder = new window.LimovaTrainingScreenRecorder({
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => stream),
        getUserMedia: vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); })
      },
      MediaRecorderClass: FakeMediaRecorder,
      uploader: vi.fn()
    });

    await expect(recorder.start()).rejects.toMatchObject({ code: 'TRAINING_MIC_REQUIRED' });
    expect(stream.track.stopped).toBe(true);
  });

  it('uploads recording parts progressively instead of retaining the full video in memory', async () => {
    const stream = new FakeStream('monitor');
    const microphoneStream = new FakeStream(undefined, 'audio');
    const uploadPart = vi.fn(async (partNumber, blob) => ({ partNumber, size: blob.size }));
    const complete = vi.fn(async () => ({ pathname: 'training-recordings/session/progressive.webm' }));
    const multipartFactory = vi.fn(async () => ({ uploadPart, complete }));
    const recorder = new window.LimovaTrainingScreenRecorder({
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => stream),
        getUserMedia: vi.fn(async () => microphoneStream)
      },
      MediaRecorderClass: FakeMediaRecorder,
      uploader: vi.fn(),
      multipartFactory
    });

    await recorder.start();
    await recorder.beginProgressiveUpload({
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000'
    });
    const result = await recorder.stopAndUpload({
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000'
    });

    expect(multipartFactory).toHaveBeenCalledOnce();
    expect(uploadPart).toHaveBeenCalledWith(1, expect.any(Blob));
    expect(complete).toHaveBeenCalledWith({ durationMs: expect.any(Number) });
    expect(recorder.recordingBlob).toBeNull();
    expect(result.size).toBeGreaterThan(0);
  });

  it('does not upload or complete the same recording twice when finalization is retried', async () => {
    const stream = new FakeStream('monitor');
    const microphoneStream = new FakeStream(undefined, 'audio');
    const uploadPart = vi.fn(async () => ({ ok: true }));
    const complete = vi.fn(async () => ({ pathname: 'training-recordings/session/retry.webm' }));
    const recorder = new window.LimovaTrainingScreenRecorder({
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => stream),
        getUserMedia: vi.fn(async () => microphoneStream)
      },
      MediaRecorderClass: FakeMediaRecorder,
      uploader: vi.fn(),
      multipartFactory: vi.fn(async () => ({ uploadPart, complete }))
    });

    await recorder.start();
    await recorder.beginProgressiveUpload({
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000'
    });
    const options = {
      token: 'training-token-that-is-long-enough',
      sessionId: '550e8400-e29b-41d4-a716-446655440000'
    };

    const first = await recorder.stopAndUpload(options);
    const retry = await recorder.stopAndUpload(options);

    expect(retry).toEqual(first);
    expect(uploadPart).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
