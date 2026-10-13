import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { openNativeAudio } from '../../../src/limova/native-audio.js';

function processor(samples = 4) {
  let Processor;
  const sandbox = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: vi.fn() }; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; } };
  vm.runInNewContext(readFileSync(new URL('../../../src/limova/pcm-capture-worklet.js', import.meta.url), 'utf8'), sandbox);
  return new Processor({ processorOptions: { frameSamples: samples } });
}

function fixture() {
  const contexts = [], nodes = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() });
  class Context {
    constructor(options) { this.sampleRate = options.sampleRate; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }; contexts.push(this); }
    resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: {} });
    createBuffer = (_channels, length) => { const data = new Float32Array(length); return { getChannelData: () => data }; };
    createBufferSource = () => { const result = node(); nodes.push(result); return result; };
  }
  let capture;
  class Worklet {
    constructor() { Object.assign(this, node()); this.port = { close: vi.fn(), postMessage: vi.fn() }; capture = this; }
  }
  const track = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const onFrame = vi.fn(), onError = vi.fn();
  const start = options => openNativeAudio({ stream, onFrame, onError,
    session: { inputSampleRate: 16000, outputSampleRate: 24000, maxAudioFrameBytes: 2560 },
    AudioContextClass: Context, WorkletNodeClass: Worklet, ...options });
  return { contexts, nodes, track, start, onFrame, onError, capture: () => capture };
}

describe('native PCM audio', () => {
  it('encodes mono little-endian PCM across worklet blocks and clamps invalid samples', () => {
    const capture = processor();
    capture.process([[new Float32Array([-2, 0])]]);
    expect(capture.port.postMessage).not.toHaveBeenCalled();
    capture.process([[new Float32Array([2, NaN])]]);
    const view = new DataView(capture.port.postMessage.mock.calls[0][0].buffer);
    expect([0, 2, 4, 6].map(offset => view.getInt16(offset, true))).toEqual([-32768, 0, 32767, 0]);
  });

  it('bounds pending worklet messages and replenishes credits only on ACK', () => {
    const capture = processor(1);
    expect(capture.process([[new Float32Array(25)]])).toBe(true);
    capture.port.onmessage({ data: 'ack' });
    expect(capture.process([[new Float32Array(1)]])).toBe(true);
    expect(capture.process([[new Float32Array(1)]])).toBe(false);
    expect(capture.port.postMessage).toHaveBeenLastCalledWith({ type: 'overflow' });
  });

  it('acknowledges captured frames and releases microphone and contexts on abort', async () => {
    const h = fixture(), abort = new AbortController();
    await h.start({ signal: abort.signal });
    h.capture().port.onmessage({ data: { type: 'pcm', buffer: new Uint8Array([0, 1]).buffer } });
    await Promise.resolve();
    expect(h.onFrame).toHaveBeenCalledWith(new Uint8Array([0, 1]));
    expect(h.capture().port.postMessage).toHaveBeenCalledWith('ack');
    abort.abort();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.contexts.every(context => context.close.mock.calls.length === 1)).toBe(true);
  });

  it('decodes PCM in order and reports played duration when interrupted', async () => {
    const h = fixture(), audio = await h.start();
    const bytes = Array(4800).fill(0); bytes[1] = 128;
    expect(audio.play({ sequence: 0, audio: bytes })).toBe(true);
    expect(h.nodes[0].buffer.getChannelData(0)[0]).toBe(-1);
    h.contexts[1].currentTime = 0.06;
    expect(audio.interrupt()).toBe(50);
    expect(h.nodes[0].stop).toHaveBeenCalledTimes(1);
    expect(audio.play({ sequence: 1, audio: [0, 0] })).toBe(true);
    audio.stop();
  });

  it('closes cleanly when capture fails or playback arrives out of sequence', async () => {
    const h = fixture(), audio = await h.start();
    expect(audio.play({ sequence: 3, audio: [0, 0] })).toBe(false);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    audio.stop();
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it('cleans up when the negotiated rate is unsupported', async () => {
    const h = fixture();
    await expect(h.start({ session: { inputSampleRate: 48000 } })).rejects.toThrow('configuration');
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.contexts).toHaveLength(0);
  });
});
