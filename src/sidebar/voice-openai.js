/* Loaded only by scripts/local/build-gpt-live.mjs. Reuses Charly's guarded tools. */
class LimovaOpenAiVoiceSession extends window.LimovaVoiceSession {
  constructor(options = {}) {
    super(options);
    this.peer = null;
    this.events = null;
    this.audio = null;
    this.seenCalls = new Set();
    this.transcripts = { user: null, assistant: null };
    this.transcriptSequence = 0;
    this.toolQueue = Promise.resolve();
    this.outgoingQueue = Promise.resolve();
    this.taskRevision = 0;
    this.delegations = new Map();
    this.task = null;
  }

  sendEvent(event) {
    if (this.events?.readyState !== 'open') return false;
    this.events.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event }));
    return true;
  }

  // Adapter for the existing tool execution and context refresh code.
  async sendLegacy(raw) {
    const message = JSON.parse(raw);
    if (message.toolResponse) {
      for (const result of message.toolResponse.functionResponses) {
        this.sendEvent({ type: 'response.item.create', item: {
          type: 'function_call_output', call_id: result.id, output: JSON.stringify(result.response)
        } });
      }
      await this.sendVisualContext();
      this.sendEvent({ type: 'response.create' });
    } else if (message.clientContent) {
      const text = message.clientContent.turns.flatMap(t => t.parts.map(p => p.text || '')).join('\n');
      this.sendEvent({ type: 'session.thinking.append', delegation_id: null, content: text.slice(0, 350) });
      this.sendEvent({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      this.diagnostic('VOICE_BACKEND_CONTEXT_QUEUED', { characterCount: text.length });
    }
  }

  async start() {
    if (this.active || this.starting) return;
    const lifecycle = ++this.lifecycleId;
    this.starting = true;
    this.operationId = `gpt-live-${crypto.randomUUID()}`;
    this.seenCalls.clear();
    this.transcripts = { user: null, assistant: null };
    this.toolQueue = Promise.resolve();
    this.outgoingQueue = Promise.resolve();
    this.delegations.clear();
    this.emit('limova-voice-status', { status: 'connecting' });
    let timeout;
    try {
      // Remember the panel's window and its web tab before microphone consent
      // opens a temporary extension tab (possibly stealing window focus).
      const panelWindow = await chrome.windows.getCurrent();
      const [initialTab] = await chrome.tabs.query({ active: true, windowId: panelWindow.id });
      const initialContext = await chrome.runtime.sendMessage({ type: 'GET_LOCAL_VOICE_PAGE_CONTEXT', windowId: panelWindow.id, initialTabId: initialTab?.id });
      if (lifecycle !== this.lifecycleId) return;
      if (!initialContext?.ok) throw new Error(initialContext?.error || 'Ouvre une page web dans cette fenêtre avant de démarrer Charly.');
      const task = await chrome.runtime.sendMessage({ type: 'VOICE_TASK_BEGIN' });
      this.taskRevision = task.revision;
      this.taskUpdate = Promise.resolve(task);
      this.microphonePermissionTabId = null;
      const stream = await this.requestMicrophone(lifecycle);
      if (lifecycle !== this.lifecycleId) return;
      this.stream = stream;
      // Close only the permission helper opened by this session, after grant.
      // Until it closes, Chrome still considers that helper the active tab.
      if (this.microphonePermissionTabId != null) await chrome.tabs.remove(this.microphonePermissionTabId).catch(() => {});
      if (lifecycle !== this.lifecycleId) return;
      const peer = this.peer = new RTCPeerConnection();
      const audio = this.audio = new Audio();
      audio.autoplay = true;
      audio.controls = true;
      audio.setAttribute('aria-label', 'Voix française GPT Live');
      document.body.append(audio);
      peer.addEventListener('track', event => {
        if (lifecycle !== this.lifecycleId) return;
        audio.srcObject = new MediaStream([event.track]);
        audio.play().catch(() => this.emit('limova-voice-status', { status: 'listening', error: 'Appuie sur lecture pour écouter GPT Live.' }));
      });
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const dc = this.events = peer.createDataChannel('oai-events');
      this.socket = { readyState: WebSocket.OPEN, send: raw => {
        this.outgoingQueue = this.outgoingQueue.then(() => this.sendLegacy(raw));
        return this.outgoingQueue;
      }, close() {} };
      let resolveReady, rejectReady;
      const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // Attach a handler immediately, even while the HTTP offer is pending.
      started.catch(() => {});
      this.cancelSocketSetup = () => rejectReady(new Error('Session annulée.'));
      timeout = setTimeout(() => rejectReady(new Error('Connexion GPT Live expirée.')), 40_000);
      dc.addEventListener('message', ({ data }) => {
        if (lifecycle !== this.lifecycleId) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'session.started') {
            this.ready = true;
            resolveReady();
          } else if (event.type === 'error' || event.type === 'session.failed') {
            const error = new Error(event.error?.message || 'La session GPT Live a échoué.');
            if (!this.ready) rejectReady(error);
            else this.fail(error);
          } else if (event.type === 'session.closed') {
            this.stop(false, 'other');
            this.emit('limova-voice-status', { status: 'stopped' });
          } else this.handleLiveEvent(event);
        } catch (error) { this.fail(error); }
      });
      dc.addEventListener('close', () => {
        if (lifecycle !== this.lifecycleId) return;
        if (!this.ready) rejectReady(new Error('Connexion GPT Live fermée.'));
        else this.fail(new Error('Connexion GPT Live interrompue. Relance la voix.'));
      });
      peer.addEventListener('connectionstatechange', () => {
        if (lifecycle === this.lifecycleId && peer.connectionState === 'failed') this.fail(new Error('Connexion audio interrompue.'));
      });
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Négociation audio expirée.')); }, 10_000);
        const cleanup = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); };
        const check = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
        peer.addEventListener('icegatheringstatechange', check);
        check();
      });
      if (lifecycle !== this.lifecycleId) return;
      const result = await chrome.runtime.sendMessage({ type: 'GET_LIVE_SESSION', sdp: peer.localDescription.sdp, context: {
        trainingMode: this.trainingMode, windowId: panelWindow.id, initialTabId: initialTab?.id, permissionTabId: this.microphonePermissionTabId
      } });
      if (lifecycle !== this.lifecycleId) return;
      if (!result?.ok || !result.sdp) throw new Error(result?.error || 'GPT Live indisponible.');
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      await started;
      if (lifecycle !== this.lifecycleId) return;
      this.cancelSocketSetup = null;
      this.lastContextVersion = result.contextVersion || 0;
      this.markBackgroundVoiceState(true);
      // GPT Live's speech frontend also needs page context. The full DOM stays
      // in the delegated tool result; provide only a short, silent orientation.
      const current = await chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' });
      if (lifecycle !== this.lifecycleId) return;
      if (current?.ok) this.updatePageContext(current.pageContext, current.contextVersion, 'session_start');
      this.emit('limova-voice-status', { status: 'listening' });
      this.diagnostic('LIVE_SETUP_COMPLETED', { model: 'gpt-live-1', voice: 'marin', lang: 'fr-FR' });
    } catch (error) {
      if (lifecycle !== this.lifecycleId) return;
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (lifecycle === this.lifecycleId) this.starting = false;
    }
  }

  handleLiveEvent(event) {
    if (event.type === 'session.delegation.created') {
      const id = event.delegation?.id || event.delegation_id;
      if (id) this.delegations.set(id, { revision: this.taskRevision, user: this.transcripts.user });
      while (this.delegations.size > 100) this.delegations.delete(this.delegations.keys().next().value);
      this.diagnostic('VOICE_DELEGATION_STARTED', { taskRevision: this.taskRevision });
      return;
    }
    if (['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type)) {
      const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
      const at = Number.isFinite(event.start_ms) ? event.start_ms : Date.now();
      let segment = this.transcripts[role];
      if (!segment || at - segment.end > 2000) {
        this.flushTranscript(role);
        segment = this.transcripts[role] = { id: `${this.operationId}:${role}:${++this.transcriptSequence}`, role, text: '', end: at, timer: null };
        if (role === 'user' && !this.trainingMode) {
          this.taskRevision += 1;
          this.task = { revision: this.taskRevision, utteranceId: segment.id, instruction: '', phase: 'listening', steps: [] };
          this.taskUpdate = chrome.runtime.sendMessage({ type: 'VOICE_TASK_UPDATE', revision: this.taskRevision });
        }
      }
      segment.text += event.delta || '';
      segment.end = Number.isFinite(event.end_ms) ? event.end_ms : at;
      if (role === 'user') {
        this.currentUserTurnText = segment.text.slice(-4000);
        if (this.task) this.task.instruction = this.currentUserTurnText;
        if (!segment.interrupted && /(?:^|[.!?,]\s*)(?:non\b|arrête\b|arrete\b|stop\b|annule\b)/iu.test(segment.text)) {
          segment.interrupted = true;
          this.taskRevision += 1;
          if (this.task) { this.task.revision = this.taskRevision; this.task.phase = 'corrected'; }
          this.taskUpdate = chrome.runtime.sendMessage({ type: 'VOICE_TASK_UPDATE', revision: this.taskRevision });
        }
      }
      if (this.trainingMode) this.emitSafeTranscript(role, event.delta || '');
      else this.emit('limova-gpt-transcript', { role, text: segment.text, utteranceId: segment.id, final: false });
      clearTimeout(segment.timer);
      segment.timer = setTimeout(() => this.flushTranscript(role), 2500);
    } else if (event.type === 'response.event' && event.event?.type === 'response.output_item.done') {
      const call = event.event.item;
      if (call?.type !== 'function_call' || this.seenCalls.has(call.call_id)) return;
      this.seenCalls.add(call.call_id);
      let args;
      try { args = JSON.parse(call.arguments || '{}'); }
      catch { args = {}; }
      const lifecycle = this.lifecycleId;
      const delegation = this.delegations.get(event.delegation_id) || { revision: this.taskRevision, user: this.transcripts.user };
      const revision = delegation.revision;
      const user = delegation.user;
      const isCurrent = () => lifecycle === this.lifecycleId && revision === this.taskRevision;
      const cancelled = () => {
        if (lifecycle !== this.lifecycleId) return;
        this.diagnostic('VOICE_TOOL_CANCELLED', { tool: call.name, taskRevision: revision });
        return this.socket?.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: call.call_id,
          response: { status: 'cancelled', reason: 'La demande a changé. Relis la dernière consigne avant toute action.' } }] } }));
      };
      this.toolQueue = this.toolQueue.then(async () => {
        await this.taskUpdate;
        if (!isCurrent()) return cancelled();
        if (user?.text.trim()) {
          await chrome.runtime.sendMessage({ type: 'LOCAL_VOICE_TRANSCRIPT', role: 'user', text: user.text, utteranceId: user.id });
        }
        if (!isCurrent()) return cancelled();
        if (this.task) this.task.phase = 'executing';
        chrome.runtime.sendMessage({ type: 'VOICE_TASK_PROGRESS', taskRevision: revision, phase: 'executing', stepCount: this.task?.steps.length || 0 }).catch(() => {});
        await this.handleToolCalls([{ id: call.call_id, name: call.name, args }], { isCurrent, taskRevision: revision });
        if (!isCurrent()) await cancelled();
      }).catch(error => { if (lifecycle === this.lifecycleId) this.fail(error); });
    }
  }

  flushTranscript(role) {
    for (const speaker of role ? [role] : ['user', 'assistant']) {
      const segment = this.transcripts[speaker];
      if (!segment) continue;
      clearTimeout(segment.timer);
      segment.timer = null;
      if (segment.finalizedText === segment.text) continue;
      segment.finalizedText = segment.text;
      if (this.trainingMode) this.emit('limova-voice-transcript', { role: speaker, text: '', final: true });
      else this.emit('limova-gpt-transcript', { role: speaker, text: segment.text, utteranceId: segment.id, final: true });
    }
  }

  onToolResult(call, response) {
    if (!this.task) return;
    this.task.steps.push({ tool: call.name, status: response.status, contextVersion: response.contextVersion });
    this.task.steps = this.task.steps.slice(-100);
    this.task.phase = response.verification?.status === 'confirmed' ? 'verified' : response.status === 'ok' ? 'continuing' : 'needs_attention';
    this.diagnostic('VOICE_TASK_PROGRESS', { taskRevision: this.task.revision, stepCount: this.task.steps.length, phase: this.task.phase });
    chrome.runtime.sendMessage({ type: 'VOICE_TASK_PROGRESS', taskRevision: this.task.revision, phase: this.task.phase, stepCount: this.task.steps.length }).catch(() => {});
  }

  queueVisualCapture(capture, contextVersion = 0, source = 'page') {
    return super.queueVisualCapture(capture, contextVersion, source);
  }

  async sendVisualContext() {
    const capture = this.pendingVisualCapture;
    this.pendingVisualCapture = null;
    if (!capture || capture.contextVersion < this.lastContextVersion || this.events?.readyState !== 'open') return false;
    const lifecycle = this.lifecycleId;
    const revision = this.taskRevision;
    try {
      const bytes = Uint8Array.from(atob(capture.data), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: capture.mimeType }));
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 960 / bitmap.width);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let url = canvas.toDataURL('image/jpeg', 0.65);
      for (let i = 0; url.length > 40_000 && i < 5; i++) {
        const smaller = document.createElement('canvas'); smaller.width = Math.max(1, Math.round(canvas.width * 0.75)); smaller.height = Math.max(1, Math.round(canvas.height * 0.75));
        smaller.getContext('2d').drawImage(canvas, 0, 0, smaller.width, smaller.height);
        canvas.width = smaller.width; canvas.height = smaller.height; canvas.getContext('2d').drawImage(smaller, 0, 0);
        url = canvas.toDataURL('image/jpeg', 0.6);
      }
      if (url.length > 40_000 || lifecycle !== this.lifecycleId || revision !== this.taskRevision) return false;
      const sent = this.sendEvent({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: `Capture masquée de la page, version DOM ${capture.contextVersion}. Utilise les identifiants DOM pour agir.` },
        { type: 'input_image', image_url: url }
      ] } });
      if (sent) this.diagnostic('VOICE_VISUAL_CONTEXT_PUSHED', { contextVersion: capture.contextVersion, encodedCharacters: url.length, source: capture.source });
      return sent;
    } catch (_) {
      this.diagnostic('VOICE_VISUAL_CONTEXT_UNAVAILABLE', { contextVersion: capture.contextVersion });
      return false;
    }
  }
  flushVisualCapture() { return false; }
  primeVisualContext() {}
  isOutputBusy() { return this.toolCallsInFlight > 0; }

  fail(error) {
    this.stop(false, 'error');
    this.emit('limova-voice-status', { status: 'error', error: error.message });
  }

  stop(notify = true, reason = 'user_stop') {
    const dc = this.events;
    const peer = this.peer;
    const audio = this.audio;
    this.flushTranscript();
    // Stop microphone immediately; keep the transport briefly for final usage.
    this.sendEvent({ type: 'session.close' });
    this.events = null;
    this.peer = null;
    this.audio = null;
    audio?.pause();
    if (audio) { audio.srcObject = null; audio.remove(); }
    const cleanup = () => { clearTimeout(timer); dc?.close(); peer?.close(); };
    const timer = setTimeout(cleanup, 15_000);
    dc?.addEventListener('message', ({ data }) => { try { if (JSON.parse(data).type === 'session.closed') cleanup(); } catch {} });
    super.stop(notify, reason);
  }
}
window.LimovaVoiceSession = LimovaOpenAiVoiceSession;
