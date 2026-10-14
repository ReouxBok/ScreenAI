import { openNativeAudio } from '../limova/native-audio.js';

export class DeepAgentVoiceSession {
  constructor({ openSession, parameters, requestMicrophone, onStatus, onNativeEvent, onState, validate = async () => {},
    openAudio = openNativeAudio }) {
    Object.assign(this, { openSession, parameters, requestMicrophone, onStatus, onNativeEvent, onState, validate, openAudio });
    this.trainingMode = false;
    this.native = true;
  }

  get active() { return Boolean(this.abort); }

  stop(notify = true) {
    if (!this.abort) return;
    clearInterval(this.guardTimer);
    clearTimeout(this.responseTimer); this.responseTimer = undefined;
    this.abort.abort(); this.abort = null;
    if (this.audio) this.audio.stop();
    else this.stream?.getTracks().forEach(track => track.stop());
    this.live?.stop();
    this.audio = this.live = this.stream = null;
    this.onState(false);
    if (notify) this.onStatus({ status: 'stopped' });
  }

  async flushEvidence() {
    await this.evidence?.();
  }

  cancel() {
    if (this.live) this.live.cancel(this.audio?.interrupt() ?? 0);
  }

  async start() {
    if (this.active) return;
    const abort = new AbortController(); this.abort = abort;
    let queued = [], queuedBytes = 0;
    const fail = error => {
      if (this.abort !== abort) return;
      this.stop(false);
      this.onStatus({ status: 'error', error: error.message, errorKey: error.voiceErrorKey });
    };
    const clearResponseWait = () => {
      clearTimeout(this.responseTimer);
      this.responseTimer = undefined;
    };
    const waitForResponse = () => {
      clearResponseWait();
      this.responseTimer = setTimeout(() => {
        const error = new Error('Native voice response timed out');
        error.voiceErrorKey = 'voiceResponseTimeout';
        fail(error);
      }, 90_000);
    };
    this.onStatus({ status: 'connecting' });
    try {
      this.onState(true);
      const stream = await this.requestMicrophone();
      if (abort.signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const live = await this.openSession({ ...this.parameters, signal: abort.signal, onError: fail,
        onNativeEvent: event => { if (!abort.signal.aborted) this.onNativeEvent(event); },
        onEvent: (event, payload) => {
          if (abort.signal.aborted) return;
          if (event === 'turn.deep_agent_stream.failed') {
            const error = new Error('Native voice turn failed');
            error.voiceErrorKey = 'voiceTurnFailed';
            fail(error);
            return;
          }
          if ((event === 'input.transcript.final' && payload.text?.trim()) || ['turn.deep_agent_stream.started', 'turn.deep_agent_stream.completed'].includes(event)) waitForResponse();
          else if (this.responseTimer !== undefined && ['turn.deep_agent_stream.delta', 'assistant.transcript.delta'].includes(event)) waitForResponse();
          else if (['assistant.audio.delta', 'assistant.transcript.final', 'turn.interrupted', 'turn.deep_agent_stream.interrupted'].includes(event)) clearResponseWait();
          if (event === 'assistant.audio.delta') {
            if (this.audio) this.audio.play(payload);
            else {
              queuedBytes += payload.audio.length;
              if (queuedBytes > 256_000) { fail(new Error('Audio startup queue exceeded')); return; }
              queued.push(payload);
            }
            this.onStatus({ status: 'speaking' });
          } else if (['turn.interrupted', 'turn.deep_agent_stream.interrupted', 'turn.deep_agent_stream.started'].includes(event)) {
            if (this.audio) this.audio.interrupt();
            else {
              if (queued.length >= 256) { fail(new Error('Audio startup queue exceeded')); return; }
              queued.push({ interrupt: true });
            }
          } else if (event === 'assistant.status' && payload.status === 'listening') {
            this.onStatus({ status: 'listening' });
          } else if (event === 'session.ended') this.stop();
        },
      });
      if (abort.signal.aborted) { live.stop(); return; }
      this.live = live;
      this.evidence = live.flushEvidence?.bind(live);
      const audio = await this.openAudio({ stream, session: this.live.session, signal: abort.signal,
        onFrame: bytes => this.live.sendAudio(bytes), onError: fail });
      if (abort.signal.aborted) { audio.stop(); return; }
      this.audio = audio;
      queued.forEach(frame => frame.interrupt ? audio.interrupt() : audio.play(frame)); queued = [];
      if (abort.signal.aborted) return;
      let checking = false;
      this.guardTimer = setInterval(() => {
        if (checking || abort.signal.aborted) return;
        checking = true;
        void this.validate(abort.signal).catch(fail).finally(() => { checking = false; });
      }, 5000);
      this.onStatus({ status: 'listening' });
    } catch (error) { fail(error); }
  }
}
