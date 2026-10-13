class LimovaPcmCapture extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.samples = processorOptions.frameSamples;
    if (!Number.isInteger(this.samples) || this.samples < 1 || this.samples > 4096) throw new Error('Invalid PCM frame');
    this.credits = 25;
    this.offset = 0;
    this.bytes = new ArrayBuffer(this.samples * 2);
    this.view = new DataView(this.bytes);
    this.port.onmessage = ({ data }) => { if (data === 'ack') this.credits = Math.min(25, this.credits + 1); };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.view.setInt16(this.offset++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      if (this.offset === this.samples) {
        if (!this.credits) { this.port.postMessage({ type: 'overflow' }); return false; }
        this.credits -= 1;
        this.port.postMessage({ type: 'pcm', buffer: this.bytes }, [this.bytes]);
        this.bytes = new ArrayBuffer(this.samples * 2);
        this.view = new DataView(this.bytes);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('limova-pcm-capture', LimovaPcmCapture);
