export async function openNativeAudio({ stream, session, onFrame, onError, signal,
  AudioContextClass = globalThis.AudioContext, WorkletNodeClass = globalThis.AudioWorkletNode,
  workletUrl = new URL('./pcm-capture-worklet.js', import.meta.url).href }) {
  let input, output, source, capture, muted, closed = false, sequence = 0;
  let nextTime = 0, completedSeconds = 0;
  const playing = new Set();
  const ended = () => fail(new Error('Microphone disconnected'));
  const interrupt = () => {
    const now = output?.currentTime ?? 0;
    const played = completedSeconds + [...playing].reduce((sum, item) => sum + Math.max(0, Math.min(item.duration, now - item.start)), 0);
    playing.forEach(item => { item.node.onended = null; item.node.stop(); item.node.disconnect(); });
    playing.clear(); nextTime = now; completedSeconds = 0;
    return Math.round(played * 1000);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', stop);
    stream?.getTracks().forEach(track => { track.removeEventListener('ended', ended); track.stop(); });
    interrupt(); source?.disconnect(); capture?.disconnect(); muted?.disconnect();
    if (capture) { capture.port.onmessage = null; capture.port.close(); }
    void input?.close().catch(() => {}); void output?.close().catch(() => {});
  };
  const fail = error => { if (!closed) { stop(); onError(error); } };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    if (![16000, 24000].includes(session.inputSampleRate) || ![16000, 24000, 48000].includes(session.outputSampleRate)
      || !Number.isInteger(session.maxAudioFrameBytes) || session.maxAudioFrameBytes < 2
      || session.maxAudioFrameBytes > 8192 || session.maxAudioFrameBytes % 2
      || !stream?.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('Invalid native audio configuration');
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', ended, { once: true }));
    input = new AudioContextClass({ sampleRate: session.inputSampleRate, latencyHint: 'interactive' });
    output = new AudioContextClass({ sampleRate: session.outputSampleRate, latencyHint: 'interactive' });
    if (input.sampleRate !== session.inputSampleRate || output.sampleRate !== session.outputSampleRate) throw new Error('Audio sample rate unavailable');
    await Promise.all([input.resume(), output.resume(), input.audioWorklet.addModule(workletUrl)]);
    signal?.throwIfAborted();
    if (closed) throw new Error('Audio session closed');
    capture = new WorkletNodeClass(input, 'limova-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 1, channelCountMode: 'explicit', processorOptions: { frameSamples: Math.min(session.inputSampleRate / 50, session.maxAudioFrameBytes / 2) } });
    capture.onprocessorerror = () => fail(new Error('Microphone processor failed'));
    capture.port.onmessage = ({ data }) => {
      if (closed) return;
      if (data?.type !== 'pcm' || !(data.buffer instanceof ArrayBuffer)
        || !data.buffer.byteLength || data.buffer.byteLength % 2 || data.buffer.byteLength > session.maxAudioFrameBytes) {
        fail(new Error('Microphone queue exceeded')); return;
      }
      try {
        void Promise.resolve(onFrame(new Uint8Array(data.buffer))).then(() => {
          if (!closed) capture.port.postMessage('ack');
        }).catch(fail);
      } catch (error) { fail(error); }
    };
    source = input.createMediaStreamSource(stream);
    muted = input.createGain(); muted.gain.value = 0;
    source.connect(capture); capture.connect(muted); muted.connect(input.destination);
    return {
      interrupt,
      stop,
      play(payload) {
        if (closed) return false;
        try {
          const bytes = payload?.audio;
          if (payload?.sequence !== sequence || !Array.isArray(bytes) || !bytes.length || bytes.length % 2
            || bytes.length > 65536 || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Invalid playback frame');
          const duration = bytes.length / 2 / output.sampleRate;
          const start = Math.max(output.currentTime + 0.01, nextTime);
          if (start + duration - output.currentTime > 30) throw new Error('Playback queue exceeded');
          const buffer = output.createBuffer(1, bytes.length / 2, output.sampleRate);
          const channel = buffer.getChannelData(0), view = new DataView(Uint8Array.from(bytes).buffer);
          channel.forEach((_, index) => { channel[index] = view.getInt16(index * 2, true) / 32768; });
          const node = output.createBufferSource(); node.buffer = buffer; node.connect(output.destination);
          const item = { node, start, duration }; playing.add(item);
          node.onended = () => { if (playing.delete(item)) completedSeconds += duration; node.disconnect(); };
          node.start(start); nextTime = start + duration; sequence += 1;
          return true;
        } catch (error) { fail(error); return false; }
      },
    };
  } catch (error) { stop(); throw error; }
}
