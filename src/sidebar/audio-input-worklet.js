/**
 * Batches microphone frames on Chrome's audio rendering thread.
 * Raw audio is transferred to the extension page only; it is never stored.
 */
class LimovaAudioInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.offset = 0;
    this.muted = false;
    this.epoch = 0;
    this.port.onmessage = event => {
      if (event.data?.type !== 'set-muted') return;
      this.muted = event.data.muted === true;
      this.epoch = Number.isInteger(event.data.epoch) ? event.data.epoch : this.epoch + 1;
      this.discardBatch();
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (this.muted) {
      this.discardBatch();
      return true;
    }
    if (!channel?.length) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const copyLength = Math.min(channel.length - sourceOffset, this.batch.length - this.offset);
      this.batch.set(channel.subarray(sourceOffset, sourceOffset + copyLength), this.offset);
      this.offset += copyLength;
      sourceOffset += copyLength;

      if (this.offset === this.batch.length) {
        const completeBatch = this.batch;
        this.port.postMessage({ type: 'audio', epoch: this.epoch, buffer: completeBatch.buffer }, [completeBatch.buffer]);
        this.batch = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }

  discardBatch() {
    this.batch.fill(0);
    this.offset = 0;
  }
}

registerProcessor('limova-audio-input', LimovaAudioInputProcessor);
