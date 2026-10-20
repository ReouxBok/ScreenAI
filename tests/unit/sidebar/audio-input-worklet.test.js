// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('microphone AudioWorklet processor', () => {
  afterEach(() => {
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
    vi.restoreAllMocks();
  });

  it('batches rendering frames and transfers raw PCM without persisting it', () => {
    let Processor;
    const postMessage = vi.fn();
    globalThis.AudioWorkletProcessor = class {
      constructor() {
        this.port = { postMessage };
      }
    };
    globalThis.registerProcessor = vi.fn((name, constructor) => {
      expect(name).toBe('limova-audio-input');
      Processor = constructor;
    });

    loadSidebarScript('src/sidebar/audio-input-worklet.js');
    const processor = new Processor();
    const frame = new Float32Array(128).fill(0.25);

    for (let index = 0; index < 15; index += 1) {
      expect(processor.process([[frame]], [[]], {})).toBe(true);
    }
    expect(postMessage).not.toHaveBeenCalled();

    processor.process([[frame]], [[]], {});
    expect(postMessage).toHaveBeenCalledOnce();
    const [emittedFrame, transfer] = postMessage.mock.calls[0];
    const { buffer } = emittedFrame;
    expect(emittedFrame).toMatchObject({ type: 'audio', epoch: 0 });
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(2048 * Float32Array.BYTES_PER_ELEMENT);
    expect(transfer).toEqual([buffer]);
    expect(new Float32Array(buffer)[0]).toBeCloseTo(0.25);
  });

  it('discards partial batches and emits only frames from the current unmuted epoch', () => {
    let Processor;
    const postMessage = vi.fn();
    globalThis.AudioWorkletProcessor = class {
      constructor() { this.port = { postMessage, onmessage: null }; }
    };
    globalThis.registerProcessor = vi.fn((_name, constructor) => { Processor = constructor; });
    loadSidebarScript('src/sidebar/audio-input-worklet.js');
    const processor = new Processor();
    const partialFrame = new Float32Array(128).fill(0.75);

    processor.process([[partialFrame]], [[]], {});
    processor.port.onmessage({ data: { type: 'set-muted', muted: true, epoch: 1 } });
    for (let index = 0; index < 20; index += 1) processor.process([[partialFrame]], [[]], {});
    expect(postMessage).not.toHaveBeenCalled();

    processor.port.onmessage({ data: { type: 'set-muted', muted: false, epoch: 2 } });
    const freshFrame = new Float32Array(128).fill(0.25);
    for (let index = 0; index < 16; index += 1) processor.process([[freshFrame]], [[]], {});

    expect(postMessage).toHaveBeenCalledOnce();
    const [emittedFrame] = postMessage.mock.calls[0];
    expect(emittedFrame).toMatchObject({ type: 'audio', epoch: 2 });
    expect(new Float32Array(emittedFrame.buffer)[0]).toBeCloseTo(0.25);
  });
});
