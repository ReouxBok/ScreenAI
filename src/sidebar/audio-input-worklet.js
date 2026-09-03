/**
 * Batches microphone frames on Chrome's audio rendering thread.
 * Raw audio is transferred to the extension page only; it is never stored.
 */
class LimovaAudioInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const copyLength = Math.min(channel.length - sourceOffset, this.batch.length - this.offset);
      this.batch.set(channel.subarray(sourceOffset, sourceOffset + copyLength), this.offset);
      this.offset += copyLength;
      sourceOffset += copyLength;

      if (this.offset === this.batch.length) {
        const completeBatch = this.batch;
        this.port.postMessage(completeBatch.buffer, [completeBatch.buffer]);
        this.batch = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('limova-audio-input', LimovaAudioInputProcessor);
