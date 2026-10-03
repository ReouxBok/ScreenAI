/**
 * OpenAI GPT Live WebRTC session. Audio stays in browser memory.
 */
class LimovaVoiceSession {
  constructor(options = {}) {
    this.trainingMode = options.trainingMode === true;
    this.peer = null;
    this.channel = null;
    this.stream = null;
    this.remoteAudio = null;
    this.ready = false;
    this.starting = false;
    this.operationId = null;
    this.lastContextVersion = 0;
    this.pendingPageContext = null;
    this.pendingVisualCapture = null;
    this.completedToolCalls = new Set();
    this.sessionStarted = false;
    this.sessionStartedWaiters = [];
  }

  get active() { return Boolean(this.peer || this.stream || this.starting); }
  emit(name, detail = {}) { window.dispatchEvent(new CustomEvent(name, { detail })); }
  diagnostic(code, data = {}) {
    chrome.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', component: 'voice', code, operationId: this.operationId, data }).catch(() => {});
  }
  markBackgroundVoiceState(active) {
    chrome.runtime.sendMessage({ type: 'VOICE_SESSION_STATE', active, trainingMode: this.trainingMode }).catch(() => {});
  }
  send(event) {
    if (!this.ready || this.channel?.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(event));
    return true;
  }

  updatePageContext(pageContext, contextVersion, source = 'navigation', visualCapture = null) {
    if (this.trainingMode) return false;
    const version = Number(contextVersion || 0);
    const context = String(pageContext || '').slice(0, 12_000);
    if (!context || version <= this.lastContextVersion) return false;
    this.pendingPageContext = { context, version, source };
    this.queueVisualCapture(visualCapture, version, source);
    return this.flushPageContextUpdate();
  }
  queueVisualCapture(capture, contextVersion = 0, source = 'page') {
    if (!capture || !['image/jpeg', 'image/png'].includes(capture.mimeType)) return false;
    this.pendingVisualCapture = { mimeType: capture.mimeType, data: String(capture.data || ''), contextVersion: Number(contextVersion || 0), source };
    return true;
  }
  flushVisualCapture() { return false; }
  flushPageContextUpdate() {
    if (!this.pendingPageContext || !this.ready) return false;
    const update = this.pendingPageContext;
    const sent = this.send({
      type: 'session.thinking.append',
      event_id: `dom-context-${update.version}`,
      delegation_id: null,
      content: `Contexte d’interface privé. Version DOM: ${update.version}. Source: ${update.source}. ${update.context}`.slice(0, 2_000)
    });
    if (!sent) return false;
    this.pendingPageContext = null;
    this.lastContextVersion = update.version;
    this.diagnostic('VOICE_PAGE_CONTEXT_PUSHED', { contextVersion: update.version, characterCount: update.context.length, source: update.source });
    return true;
  }
  acknowledgePageContext(contextVersion) {
    const version = Number(contextVersion || 0);
    if (!version) return false;
    this.lastContextVersion = Math.max(this.lastContextVersion, version);
    if (this.pendingPageContext?.version <= version) this.pendingPageContext = null;
    if (this.pendingVisualCapture?.contextVersion <= version) this.pendingVisualCapture = null;
    return true;
  }

  async start() {
    if (this.active) return;
    this.starting = true;
    this.operationId = `voice-${crypto.randomUUID()}`;
    this.diagnostic('VOICE_SESSION_STARTED', { transport: 'webrtc', provider: 'openai' });
    this.emit('limova-voice-status', { status: 'connecting' });
    try {
      this.stream = await this.requestMicrophone();
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.remoteAudio = document.createElement('audio');
      this.remoteAudio.autoplay = true;
      this.remoteAudio.setAttribute('aria-hidden', 'true');
      peer.ontrack = event => {
        this.remoteAudio.srcObject = event.streams?.[0] || new MediaStream([event.track]);
        this.remoteAudio.play?.().catch(() => {});
      };
      const audioTracks = this.stream.getAudioTracks();
      if (!audioTracks.length) throw new Error('Aucune piste audio active n’est disponible.');
      audioTracks.forEach(track => peer.addTransceiver(track, { direction: 'sendrecv', streams: [this.stream] }));
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.addEventListener('message', event => this.handleDataEvent(event));
      channel.addEventListener('close', () => {
        if (!this.ready) return;
        this.stop(false);
        this.emit('limova-voice-status', { status: 'error', error: 'La session vocale a été interrompue.' });
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.waitForIceGathering(peer);
      const localSdp = String(peer.localDescription?.sdp || offer.sdp || '').trimEnd() + '\r\n';
      if (!localSdp.startsWith('v=0') || !localSdp.includes('\nm=audio ') || !localSdp.includes('\nm=application ')) {
        const error = new Error('Chrome n’a pas produit une offre WebRTC audio complète. Réessaie après avoir vérifié l’autorisation du microphone.');
        error.voiceDiagnosticCode = 'VOICE_SDP_INCOMPLETE';
        throw error;
      }
      const session = await chrome.runtime.sendMessage({
        type: 'GET_LIVE_SESSION',
        context: { trainingMode: this.trainingMode, sdp: localSdp }
      });
      if (!session?.ok || !session.sdp) {
        if (session?.consentRequired) this.emit('limova-voice-consent-required');
        throw new Error(session?.error || 'Session vocale indisponible.');
      }
      this.lastContextVersion = Number(session.contextVersion || 0);
      this.queueVisualCapture(session.visualCapture, session.contextVersion, 'session_start');
      this.diagnostic('VOICE_LIVE_SESSION_RECEIVED', { model: session.model || 'unknown' });
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
      await this.waitForChannel(channel);
      await this.waitForSessionStarted();
      this.ready = true;
      this.markBackgroundVoiceState(true);
      this.emit('limova-voice-status', { status: 'listening' });
      this.flushPageContextUpdate();
    } catch (error) {
      const diagnosticCode = error.voiceDiagnosticCode || (error.voiceErrorKey
        ? String(error.voiceErrorKey).replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
        : 'VOICE_SESSION_FAILED');
      this.diagnostic(diagnosticCode, { name: error.name, message: error.message });
      this.stop(false);
      this.emit('limova-voice-status', { status: 'error', error: error.message, errorKey: error.voiceErrorKey });
      throw error;
    } finally {
      this.starting = false;
    }
  }

  waitForIceGathering(peer) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('La négociation WebRTC a expiré.')); }, 8_000);
      const onChange = () => {
        if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        peer.removeEventListener?.('icegatheringstatechange', onChange);
      };
      peer.addEventListener('icegatheringstatechange', onChange);
    });
  }
  waitForChannel(channel) {
    if (channel.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Le canal vocal GPT Live ne répond pas.')); }, 12_000);
      const onOpen = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('Le canal vocal GPT Live s’est fermé.')); };
      const cleanup = () => {
        clearTimeout(timeout);
        channel.removeEventListener?.('open', onOpen);
        channel.removeEventListener?.('close', onClose);
      };
      channel.addEventListener('open', onOpen);
      channel.addEventListener('close', onClose);
    });
  }
  waitForSessionStarted() {
    if (this.sessionStarted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.sessionStartedWaiters = this.sessionStartedWaiters.filter(waiter => waiter.resolve !== resolve);
        reject(new Error('GPT Live n’a pas confirmé le démarrage de la session.'));
      }, 12_000);
      this.sessionStartedWaiters.push({
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject
      });
    });
  }

  async requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone API unavailable.');
      error.voiceErrorKey = 'voiceMicUnsupported';
      throw error;
    }
    try {
      await this.ensureMicrophonePermission();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this.diagnostic('VOICE_MICROPHONE_ACQUIRED', { trackCount: stream.getAudioTracks?.().length || 0 });
      return stream;
    } catch (cause) {
      if (cause?.voiceErrorKey) throw cause;
      const error = new Error(cause?.message || 'Microphone unavailable.');
      const name = cause?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        error.voiceErrorKey = /dismiss|cancel|clos/i.test(cause?.message || '') ? 'voiceMicDismissed' : 'voiceMicDenied';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        error.voiceErrorKey = 'voiceMicNotFound';
      } else {
        error.voiceErrorKey = 'voiceMicUnavailable';
      }
      throw error;
    }
  }
  async ensureMicrophonePermission() {
    if (!navigator.permissions?.query || !chrome.tabs?.create || !chrome.runtime?.getURL) return;
    let permission;
    try { permission = await navigator.permissions.query({ name: 'microphone' }); } catch (_) { return; }
    if (permission.state === 'granted') return;
    if (permission.state === 'denied') {
      const error = new Error('Microphone permission denied.');
      error.voiceErrorKey = 'voiceMicDenied';
      throw error;
    }
    await this.requestMicrophonePermissionInTab();
  }
  requestMicrophonePermissionInTab() {
    return new Promise((resolve, reject) => {
      let permissionTabId = null;
      let settled = false;
      const finish = (granted, errorKey) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(onMessage);
        chrome.tabs.onRemoved?.removeListener(onRemoved);
        if (granted) resolve();
        else {
          const error = new Error('Microphone permission was not granted.');
          error.voiceErrorKey = errorKey;
          reject(error);
        }
      };
      const onMessage = (message, sender) => {
        if (message?.type !== 'MICROPHONE_PERMISSION_RESULT') return;
        if (permissionTabId && sender?.tab?.id && sender.tab.id !== permissionTabId) return;
        finish(message.granted === true, message.errorKey || 'voiceMicDismissed');
      };
      const onRemoved = tabId => { if (tabId === permissionTabId) finish(false, 'voiceMicDismissed'); };
      const timeout = setTimeout(() => finish(false, 'voiceMicDismissed'), 120_000);
      chrome.runtime.onMessage.addListener(onMessage);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      chrome.tabs.create({ url: chrome.runtime.getURL('src/sidebar/microphone-permission.html'), active: true })
        .then(tab => { permissionTabId = tab?.id || null; })
        .catch(() => finish(false, 'voiceMicDismissed'));
    });
  }

  handleDataEvent(event) {
    try { this.handleServerMessage(JSON.parse(event.data)); }
    catch (_) { this.diagnostic('VOICE_EVENT_INVALID_JSON'); }
  }
  handleServerMessage(message) {
    const type = String(message?.type || '');
    if (type === 'session.started') {
      this.sessionStarted = true;
      this.diagnostic('VOICE_OPENAI_SESSION_STARTED');
      for (const waiter of this.sessionStartedWaiters.splice(0)) waiter.resolve();
      return;
    }
    if (type === 'session.delegation.created') {
      this.diagnostic('VOICE_DELEGATION_CREATED', {
        target: message.delegation?.target || 'unknown',
        delegationId: message.delegation?.id || null
      });
    }
    if (type === 'error') {
      this.diagnostic('VOICE_OPENAI_ERROR', { code: message.error?.code, type: message.error?.type });
      return;
    }
    if (type === 'session.input_transcript.delta') this.emit('limova-voice-status', { status: 'listening' });
    if (type === 'session.output_transcript.delta') this.emit('limova-voice-status', { status: 'speaking' });

    const transcript = (
      type === 'session.input_transcript.delta'
        ? { role: 'user', text: message.delta, final: false }
        : type === 'session.output_transcript.delta'
          ? { role: 'assistant', text: message.delta, final: false }
          : null
    );
    if (transcript && (!this.trainingMode || transcript.role === 'user')) {
      if (transcript.text) this.emitSafeTranscript(transcript.role, transcript.text);
      if (transcript.final) {
        this.emit('limova-voice-transcript', { role: transcript.role, text: '', final: true });
        this.emit('limova-voice-status', { status: 'listening' });
      }
    }

    const responseEvent = type === 'response.event' ? message.event : null;
    const call = responseEvent?.type === 'response.output_item.done' && responseEvent.item?.type === 'function_call'
      ? {
          id: responseEvent.item.call_id || responseEvent.item.id,
          name: responseEvent.item.name,
          args: this.parseArguments(responseEvent.item.arguments)
        }
      : null;
    if (call?.id && !this.completedToolCalls.has(call.id)) {
      this.completedToolCalls.add(call.id);
      this.diagnostic('VOICE_TOOL_CALL_RECEIVED', { name: call.name, callId: call.id });
      this.handleToolCalls([call]).catch(() => {});
    }
  }
  parseArguments(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
  }
  emitSafeTranscript(role, text) {
    const value = String(text || '');
    if (!value) return false;
    const lang = String(document.documentElement.lang || navigator.language || 'fr').toLowerCase();
    const unexpectedScript = (lang.startsWith('fr') || lang.startsWith('en') || lang.startsWith('es'))
      && (/[぀-ヿ㐀-鿿Ѐ-ӿ]/u.test(value))
      && !/[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(value);
    if (unexpectedScript) return false;
    this.emit('limova-voice-transcript', { role, text: value, final: false });
    return true;
  }

  async waitForStablePage(previousVersion = 0) {
    let latest = null;
    let previousSignature = '';
    let stableReads = 0;
    for (const delay of [80, 140, 220, 320, 450]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const current = await chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' }).catch(() => null);
      if (!current?.ok) continue;
      latest = current;
      const signature = `${current.contextVersion || 0}:${String(current.pageContext || '').slice(0, 8000)}`;
      stableReads = signature === previousSignature ? stableReads + 1 : 0;
      previousSignature = signature;
      if ((Number(current.contextVersion || 0) > Number(previousVersion || 0) && stableReads >= 1) || stableReads >= 2) break;
    }
    return latest;
  }

  async handleToolCalls(functionCalls) {
    for (const call of functionCalls) {
      const args = call.args || {};
      let result = { ok: false, error: 'Fonction non autorisée.' };
      if (['inspect_current_page', 'verify_expected_result', 'capture_current_view'].includes(call.name)) {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_CONTEXT_REQUEST',
          toolName: call.name,
          ...(call.name === 'capture_current_view' ? { capture: true } : {})
        }).catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
      } else if (call.name === 'search_knowledge_base' && typeof args.query === 'string') {
        result = await chrome.runtime.sendMessage({ type: 'VOICE_KB_SEARCH', query: args.query })
          .catch(() => ({ ok: false, error: 'La documentation Limova est indisponible.' }));
      } else if (call.name === 'fill_field' && Number.isInteger(args.elementId) && typeof args.text === 'string') {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_TEXT_INPUT_REQUEST', elementId: args.elementId, contextVersion: args.contextVersion,
          targetLabel: args.targetLabel || '', text: args.text
        }).catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
        if (result?.ok) result = { ...result, ...(await this.waitForStablePage(result.contextVersion || args.contextVersion) || {}) };
      } else if (call.name === 'scroll_page' && ['up', 'down', 'top', 'bottom'].includes(args.direction)) {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_SCROLL_REQUEST', direction: args.direction,
          amount: ['small', 'medium', 'large'].includes(args.amount) ? args.amount : 'medium',
          ...(Number.isInteger(args.elementId) ? { elementId: args.elementId } : {}),
          contextVersion: args.contextVersion
        }).catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
        if (result?.ok) result = { ...result, ...(await this.waitForStablePage(result.contextVersion || args.contextVersion) || {}) };
      } else if (['click_element', 'navigate_internal'].includes(call.name) && Number.isInteger(args.elementId)) {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_ACTION_REQUEST', toolName: call.name, elementId: args.elementId,
          contextVersion: args.contextVersion, explicitRequest: args.explicitRequest === true,
          targetLabel: args.targetLabel || ''
        }).catch(() => ({ ok: false, error: 'Extension indisponible.' }));
        if (result?.ok) {
          const stable = await this.waitForStablePage(result.contextVersion || args.contextVersion);
          result = stable?.ok ? { ...result, ...stable, actionVerified: true } : { ...result, verificationRequired: true };
        }
      }

      const pageContext = String(result?.pageContext || '');
      if (pageContext) this.acknowledgePageContext(result.contextVersion);
      const output = {
        status: result?.status === 'unexpected' || result?.verificationRequired ? 'unexpected'
          : result?.ok ? 'ok' : result?.clarificationRequired ? 'ambiguous' : 'blocked',
        contextVersion: Number(result?.contextVersion || args.contextVersion || 0),
        ...(result?.actionVerified ? { actionVerified: true } : {}),
        ...(pageContext ? { pageContext, elementCount: Number(result.elementCount || 0) } : {}),
        ...(result?.knowledge ? { knowledgeBase: String(result.knowledge).slice(0, 6_000) } : {}),
        ...(result?.error ? { reason: String(result.error).slice(0, 240), retryWithFreshContext: Boolean(result.retryWithFreshContext) } : {})
      };
      this.diagnostic('VOICE_TOOL_CALL_COMPLETED', { name: call.name, callId: call.id, status: output.status });
      this.send({
        type: 'response.item.create',
        event_id: `tool-result-${call.id}`,
        item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(output) }
      });
    }
    this.send({ type: 'response.create' });
  }

  cleanupMedia() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause?.();
      this.remoteAudio.srcObject = null;
    }
    this.remoteAudio = null;
  }
  stop(notify = true) {
    const channel = this.channel;
    const peer = this.peer;
    this.channel = null;
    this.peer = null;
    this.ready = false;
    this.sessionStarted = false;
    for (const waiter of this.sessionStartedWaiters.splice(0)) waiter.reject?.(new Error('Session vocale arrêtée.'));
    this.starting = false;
    this.markBackgroundVoiceState(false);
    try { channel?.close(); } catch (_) {}
    try { peer?.close(); } catch (_) {}
    this.cleanupMedia();
    this.pendingPageContext = null;
    this.pendingVisualCapture = null;
    this.diagnostic('VOICE_SESSION_STOPPED', { notified: notify });
    if (notify) this.emit('limova-voice-status', { status: 'stopped' });
  }
}
window.LimovaVoiceSession = LimovaVoiceSession;
