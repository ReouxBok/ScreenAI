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
    const [buffer, transfer] = postMessage.mock.calls[0];
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(2048 * Float32Array.BYTES_PER_ELEMENT);
    expect(transfer).toEqual([buffer]);
    expect(new Float32Array(buffer)[0]).toBeCloseTo(0.25);
  });
});
