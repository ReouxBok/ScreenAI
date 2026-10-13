import { openNativeAudio } from '../limova/native-audio.js';

export class TrainingTranscriptionSession {
  constructor({ parameters, openSession, requestMicrophone, saveNote, validate, onState, onStatus, openAudio = openNativeAudio }) {
    Object.assign(this, { parameters, openSession, requestMicrophone, saveNote, validate, onState, onStatus, openAudio });
    this.native = true; this.trainingMode = true; this.pending = Promise.resolve(); this.partial = '';
  }
  get active() { return Boolean(this.abort); }
  enqueue(text, partial = false) {
    this.pending = this.pending.then(() => this.saveNote(text, partial));
    return this.pending;
  }
  async stop(flush = true) {
    if (!this.abort) return this.pending.catch(() => {});
    clearInterval(this.timer); this.abort.abort(); this.abort = null;
    this.audio?.stop(); this.stream?.getTracks().forEach(track => track.stop()); this.live?.stop();
    this.audio = this.stream = this.live = null;
    const partial = this.partial; this.partial = '';
    this.onState(false);
    try {
      if (flush && partial.trim()) await this.enqueue(partial, true); else await this.pending;
      this.onStatus({ status: 'stopped' });
    } catch (error) { this.onStatus({ status: 'error', error: error.message }); }
  }
  async start() {
    if (this.active) return;
    const abort = new AbortController(); this.abort = abort;
    const fail = error => {
      if (this.abort !== abort) return;
      void this.stop(false).then(() => this.onStatus({ status: 'error', error: error.message }));
    };
    this.onState(true); this.onStatus({ status: 'connecting' });
    try {
      await this.validate(abort.signal);
      abort.signal.throwIfAborted();
      const stream = await this.requestMicrophone();
      if (abort.signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const live = await this.openSession({ ...this.parameters, signal: abort.signal, onError: fail,
        onEvent: async (event, payload) => {
          if (abort.signal.aborted) return;
          if (event === 'partial_transcript') this.partial = payload.text;
          if (event === 'final_transcript') { this.partial = ''; await this.enqueue(payload.text); }
          if (event === 'session_ended') await this.stop();
        },
      });
      if (abort.signal.aborted) { live.stop(); return; }
      this.live = live;
      const audio = await this.openAudio({ stream, session: { ...live.session, outputSampleRate: live.session.inputSampleRate }, signal: abort.signal,
        onFrame: bytes => live.sendAudio(bytes), onError: fail });
      if (abort.signal.aborted) { audio.stop(); return; }
      this.audio = audio;
      let checking = false;
      this.timer = setInterval(() => {
        if (checking || abort.signal.aborted) return;
        checking = true;
        void this.validate(abort.signal).catch(fail).finally(() => { checking = false; });
      }, 5000);
      this.onStatus({ status: 'listening' });
    } catch (error) { fail(error); }
  }
}
