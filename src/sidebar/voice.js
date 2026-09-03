/**
 * Explicit, ephemeral Gemini Live audio session.
 * Audio exists only in memory and is never persisted by the extension.
 */
class LimovaVoiceSession {
  constructor(options = {}) {
    this.trainingMode = options.trainingMode === true;
    this.socket = null;
    this.stream = null;
    this.inputContext = null;
    this.outputContext = null;
    this.captureNode = null;
    this.source = null;
    this.playingSources = new Set();
    this.nextPlaybackTime = 0;
    this.ready = false;
    this.tokenData = null;
    this.resumptionHandle = null;
    this.reconnecting = false;
    this.transcriptFlushTimer = null;
    this.starting = false;
    this.operationId = null;
    this.reconnectAttempts = 0;
    this.receivedFrameCount = 0;
    this.lastContextVersion = 0;
    this.pendingPageContext = null;
    this.pendingVisualCapture = null;
    this.currentTurnHasUserTranscript = false;
    this.currentTurnHasAssistantOutput = false;
    this.lastUserTranscriptAt = 0;
    this.lastAssistantOutputAt = 0;
    this.replyRecoveryTimer = null;
    this.replyRecoveryCount = 0;
    this.replyFallbackTurnAt = 0;
    this.localSpeechFrames = 0;
    this.localNoiseFloor = 0.012;
    this.lastLocalInterruptionAt = 0;
    this.lastPlaybackStartedAt = 0;
    this.localInterruptionPending = false;
    this.suppressPlaybackUntil = 0;
    this.modelTurnStreaming = false;
    this.toolCallsInFlight = 0;
    this.lastToolActivityAt = 0;
  }

  get active() {
    return Boolean(this.socket || this.stream);
  }

  emit(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  diagnostic(code, data = {}) {
    chrome.runtime.sendMessage({
      type: 'DIAGNOSTIC_EVENT',
      component: 'voice',
      code,
      operationId: this.operationId,
      data
    }).catch(() => {});
  }

  markBackgroundVoiceState(active) {
    chrome.runtime.sendMessage({ type: 'VOICE_SESSION_STATE', active, trainingMode: this.trainingMode }).catch(() => {});
  }

  updatePageContext(pageContext, contextVersion, source = 'navigation', visualCapture = null) {
    if (this.trainingMode) return false;
    const version = Number(contextVersion || 0);
    const context = String(pageContext || '').slice(0, 12_000);
    if (!context || version <= this.lastContextVersion) return false;
    this.pendingPageContext = { context, version, source };
    this.queueVisualCapture(visualCapture, version, source);
    const pushed = this.flushPageContextUpdate();
    this.flushVisualCapture();
    return pushed;
  }

  queueVisualCapture(capture, contextVersion = 0, source = 'page') {
    if (this.trainingMode || !capture || !['image/jpeg', 'image/png'].includes(capture.mimeType)) return false;
    const data = String(capture.data || '');
    if (!data || data.length > 1_500_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return false;
    this.pendingVisualCapture = {
      mimeType: capture.mimeType,
      data,
      contextVersion: Number(contextVersion || 0),
      source
    };
    return true;
  }

  flushVisualCapture() {
    if (!this.pendingVisualCapture || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.isOutputBusy()) return false;
    const capture = this.pendingVisualCapture;
    this.pendingVisualCapture = null;
    this.socket.send(JSON.stringify({
      realtimeInput: {
        video: { mimeType: capture.mimeType, data: capture.data }
      }
    }));
    this.diagnostic('VOICE_VISUAL_CONTEXT_PUSHED', {
      contextVersion: capture.contextVersion,
      encodedCharacters: capture.data.length,
      source: capture.source
    });
    return true;
  }

  flushPageContextUpdate() {
    if (!this.pendingPageContext || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.isOutputBusy()) return false;
    const update = this.pendingPageContext;
    this.pendingPageContext = null;
    this.socket.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{
            text: `[MISE À JOUR TECHNIQUE SILENCIEUSE — ne réponds pas à ce message seul]\nVersion DOM: ${update.version}\nSource: ${update.source}\n${update.context}`
          }]
        }],
        turnComplete: false
      }
    }));
    this.lastContextVersion = update.version;
    this.diagnostic('VOICE_PAGE_CONTEXT_PUSHED', {
      contextVersion: update.version,
      characterCount: update.context.length,
      source: update.source
    });
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
    if (this.active || this.starting) return;
    this.starting = true;
    this.reconnectAttempts = 0;
    this.operationId = `voice-${crypto.randomUUID()}`;
    this.diagnostic('VOICE_SESSION_STARTED');
    this.emit('limova-voice-status', { status: 'connecting' });
    try {
      this.stream = await this.requestMicrophone();

      const tokenData = await chrome.runtime.sendMessage({
        type: 'GET_LIVE_TOKEN',
        context: { trainingMode: this.trainingMode }
      });
      if (!tokenData?.ok || !tokenData.token) {
        if (tokenData?.consentRequired) this.emit('limova-voice-consent-required');
        throw new Error(tokenData?.error || 'Jeton vocal indisponible.');
      }
      this.tokenData = tokenData;
      this.lastContextVersion = Number(tokenData.contextVersion || 0);
      this.queueVisualCapture(tokenData.visualCapture, tokenData.contextVersion, 'session_start');
      this.diagnostic('VOICE_LIVE_TOKEN_RECEIVED', { model: tokenData.model || 'unknown' });
      await this.openSocket(tokenData);
      await this.startCapture();
      this.markBackgroundVoiceState(true);
    } catch (error) {
      const diagnosticCode = error.voiceDiagnosticCode || (error.voiceErrorKey
        ? String(error.voiceErrorKey).replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
        : 'VOICE_SESSION_FAILED');
      this.diagnostic(diagnosticCode, { name: error.name, message: error.message });
      this.stop(false);
      this.emit('limova-voice-status', {
        status: 'error',
        error: error.message,
        errorKey: error.voiceErrorKey
      });
      throw error;
    } finally {
      this.starting = false;
    }
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
        error.voiceErrorKey = /dismiss|cancel|clos/i.test(cause?.message || '')
          ? 'voiceMicDismissed'
          : 'voiceMicDenied';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        error.voiceErrorKey = 'voiceMicNotFound';
      } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        error.voiceErrorKey = 'voiceMicUnavailable';
      } else {
        error.voiceErrorKey = 'voiceMicUnavailable';
      }
      throw error;
    }
  }

  async ensureMicrophonePermission() {
    if (!navigator.permissions?.query || !chrome.tabs?.create || !chrome.runtime?.getURL) return;

    let permission;
    try {
      permission = await navigator.permissions.query({ name: 'microphone' });
    } catch (_) {
      return;
    }
    this.diagnostic('VOICE_MICROPHONE_PERMISSION_STATE', { state: permission.state });
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
      const timeout = setTimeout(() => finish(false, 'voiceMicDismissed'), 120_000);
      this.diagnostic('VOICE_PERMISSION_TAB_REQUESTED');

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
      const onMessage = message => {
        if (message?.type !== 'MICROPHONE_PERMISSION_RESULT') return;
        finish(Boolean(message.granted), message.errorKey || 'voiceMicDenied');
      };
      const onRemoved = tabId => {
        if (tabId === permissionTabId) finish(false, 'voiceMicDismissed');
      };

      chrome.runtime.onMessage.addListener(onMessage);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/sidebar/microphone-permission.html'),
        active: true
      }).then(tab => {
        permissionTabId = tab?.id ?? null;
        this.diagnostic('VOICE_PERMISSION_TAB_OPENED', { opened: permissionTabId !== null });
      }).catch(() => finish(false, 'voiceMicUnavailable'));
    });
  }

  openSocket(tokenData) {
    return new Promise((resolve, reject) => {
      const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
      const socket = new WebSocket(`${endpoint}?access_token=${encodeURIComponent(tokenData.token)}`);
      // Gemini may return JSON inside binary WebSocket frames. ArrayBuffer is
      // deterministic across Chrome versions and avoids Blob-only handling.
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.receivedFrameCount = 0;
      this.diagnostic('LIVE_WS_CONNECTING', { model: tokenData.model || 'unknown' });
      let setupSettled = false;
      const failSetup = (error, code, data = {}) => {
        if (setupSettled || this.ready) return;
        setupSettled = true;
        clearTimeout(timeout);
        error.voiceDiagnosticCode = code;
        this.diagnostic(code, data);
        reject(error);
      };
      const timeout = setTimeout(() => failSetup(
        new Error('Connexion vocale expirée.'),
        'LIVE_SETUP_TIMEOUT',
        { receivedFrameCount: this.receivedFrameCount }
      ), 12_000);

      socket.addEventListener('open', () => {
        this.diagnostic('LIVE_WS_OPENED');
        socket.send(JSON.stringify({
          setup: {
            model: `models/${tokenData.model}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
                endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                prefixPaddingMs: 160,
                silenceDurationMs: 1100
              },
              activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
              turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
            },
            sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
            contextWindowCompression: { slidingWindow: {} }
          }
        }));
      });
      socket.addEventListener('message', async event => {
        const frame = this.describeSocketData(event.data);
        this.receivedFrameCount += 1;
        let raw;
        try {
          raw = await this.decodeSocketData(event.data);
        } catch (cause) {
          failSetup(new Error('Réponse vocale illisible.'), 'LIVE_WS_FRAME_DECODE_FAILED', {
            ...frame,
            name: cause?.name || 'Error'
          });
          return;
        }
        let message;
        try {
          message = JSON.parse(raw);
        } catch (_) {
          failSetup(new Error('Réponse vocale invalide.'), 'LIVE_WS_FRAME_PARSE_FAILED', frame);
          return;
        }
        const keys = Object.keys(message).slice(0, 12);
        if (this.receivedFrameCount === 1 || message.setupComplete || message.error || message.goAway) {
          this.diagnostic('LIVE_WS_FRAME_RECEIVED', {
            ...frame,
            frameNumber: this.receivedFrameCount,
            keys
          });
        }
        if (message.error) {
          const error = new Error('Gemini Live a refusé la session vocale.');
          failSetup(error, 'LIVE_SERVER_ERROR', {
            serverCode: Number(message.error.code || 0),
            serverStatus: String(message.error.status || 'unknown').slice(0, 80)
          });
          return;
        }
        if (message.setupComplete && !this.ready) {
          clearTimeout(timeout);
          setupSettled = true;
          this.ready = true;
          this.diagnostic('LIVE_SETUP_COMPLETED');
          this.emit('limova-voice-status', { status: 'listening' });
          this.flushPageContextUpdate();
          this.flushVisualCapture();
          resolve();
        }
        this.handleServerMessage(message);
      });
      socket.addEventListener('error', () => {
        failSetup(new Error('Connexion vocale impossible.'), 'LIVE_WS_ERROR');
      });
      socket.addEventListener('close', event => {
        clearTimeout(timeout);
        this.diagnostic('LIVE_WS_CLOSED', { code: event.code, clean: event.wasClean, reasonLength: String(event.reason || '').length });
        if (socket !== this.socket) return;
        const wasActive = this.active;
        this.socket = null;
        this.ready = false;
        const tokenStillValid = new Date(this.tokenData?.expiresAt || 0).getTime() > Date.now();
        const unexpectedClose = !event.wasClean || ![1000, 1001].includes(event.code);
        if (unexpectedClose && wasActive && tokenStillValid && this.reconnectAttempts < 1) {
          this.reconnectAttempts += 1;
          this.diagnostic('LIVE_WS_AUTOMATIC_RECOVERY_SCHEDULED', { attempt: this.reconnectAttempts, code: event.code });
          this.emit('limova-voice-status', { status: 'connecting' });
          setTimeout(() => this.reconnect().catch(() => {}), 500);
          return;
        }
        this.markBackgroundVoiceState(false);
        this.cleanupMedia();
        if (wasActive) this.emit('limova-voice-status', { status: event.wasClean ? 'stopped' : 'error' });
      });
    });
  }

  describeSocketData(data) {
    if (typeof data === 'string') return { dataType: 'string', byteLength: new TextEncoder().encode(data).byteLength };
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return { dataType: 'ArrayBuffer', byteLength: data.byteLength };
    if (ArrayBuffer.isView(data)) return { dataType: data.constructor?.name || 'TypedArray', byteLength: data.byteLength };
    if (data && typeof data.text === 'function') return { dataType: data.constructor?.name || 'Blob', byteLength: Number(data.size || 0) };
    return { dataType: typeof data, byteLength: 0 };
  }

  async decodeSocketData(data) {
    if (typeof data === 'string') return data;
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new TextDecoder().decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (data && typeof data.text === 'function') return data.text();
    throw new TypeError('Unsupported WebSocket frame type');
  }

  async startCapture() {
    this.inputContext = new AudioContext();
    await this.inputContext.resume();
    if (!this.inputContext.audioWorklet || typeof AudioWorkletNode !== 'function') {
      const error = new Error('Le moteur audio moderne de Chrome est indisponible.');
      error.voiceDiagnosticCode = 'VOICE_AUDIO_WORKLET_UNAVAILABLE';
      throw error;
    }

    try {
      await this.inputContext.audioWorklet.addModule(
        chrome.runtime.getURL('src/sidebar/audio-input-worklet.js')
      );
      this.captureNode = new AudioWorkletNode(this.inputContext, 'limova-audio-input', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
    } catch (cause) {
      const error = new Error('Le moteur de capture audio n’a pas pu démarrer.');
      error.voiceDiagnosticCode = 'VOICE_AUDIO_WORKLET_FAILED';
      error.cause = cause;
      throw error;
    }

    this.source = this.inputContext.createMediaStreamSource(this.stream);
    this.captureNode.port.onmessage = event => {
      if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
      if (Object.prototype.toString.call(event.data) !== '[object ArrayBuffer]') return;
      const samples = new Float32Array(event.data);
      this.detectLocalInterruption(samples);
      const pcm = this.downsample(samples, this.inputContext.sampleRate, 16_000);
      this.socket.send(JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: this.pcmToBase64(pcm) }
        }
      }));
    };
    this.source.connect(this.captureNode);
    // The processor emits silence on its output, preventing microphone echo
    // while keeping Chrome's rendering graph active.
    this.captureNode.connect(this.inputContext.destination);
    this.diagnostic('VOICE_AUDIO_CAPTURE_STARTED', {
      engine: 'audio-worklet',
      inputSampleRate: this.inputContext.sampleRate,
      outputSampleRate: 16000,
      batchFrames: 2048
    });
  }

  handleServerMessage(message) {
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) this.resumptionHandle = resumption.newHandle;
    if (message.goAway && this.resumptionHandle) {
      this.reconnect().catch(() => {});
      return;
    }
    if (this.trainingMode && message.toolCall?.functionCalls?.length) {
      this.diagnostic('TRAINING_TOOL_CALL_IGNORED', { count: message.toolCall.functionCalls.length });
    } else if (message.toolCall?.functionCalls?.length) {
      this.handleToolCalls(message.toolCall.functionCalls).catch(() => {});
    }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) {
      this.modelTurnStreaming = false;
      this.localInterruptionPending = false;
      this.suppressPlaybackUntil = Math.max(this.suppressPlaybackUntil, Date.now() + 250);
      this.clearPlayback();
      this.diagnostic('VOICE_SERVER_INTERRUPTION_CONFIRMED');
    }
    const inputText = content.inputTranscription?.text;
    const outputText = content.outputTranscription?.text;
    if (inputText && this.emitSafeTranscript('user', inputText)) {
      if (this.playingSources.size > 0) {
        this.suppressPlaybackUntil = Math.max(this.suppressPlaybackUntil, Date.now() + 500);
        this.clearPlayback();
        this.emit('limova-voice-status', { status: 'listening' });
        this.diagnostic('VOICE_TRANSCRIPT_INTERRUPTED_PLAYBACK');
      }
      if (!this.currentTurnHasUserTranscript) {
        this.currentTurnHasAssistantOutput = false;
        this.replyRecoveryCount = 0;
        this.replyFallbackTurnAt = 0;
      }
      this.currentTurnHasUserTranscript = true;
      this.lastUserTranscriptAt = Date.now();
      clearTimeout(this.replyRecoveryTimer);
      this.replyRecoveryTimer = null;
    }
    if (!this.trainingMode && outputText && this.emitSafeTranscript('assistant', outputText)) {
      this.currentTurnHasAssistantOutput = true;
      this.lastAssistantOutputAt = Date.now();
      clearTimeout(this.replyRecoveryTimer);
      this.replyRecoveryTimer = null;
    }

    const modelParts = content.modelTurn?.parts || [];
    if (!this.trainingMode && modelParts.length > 0) {
      this.modelTurnStreaming = true;
      this.currentTurnHasAssistantOutput = true;
      this.lastAssistantOutputAt = Date.now();
      clearTimeout(this.replyRecoveryTimer);
      this.replyRecoveryTimer = null;
    }
    for (const part of this.trainingMode ? [] : modelParts) {
      const audio = part.inlineData || part.inline_data;
      if (audio?.data && String(audio.mimeType || audio.mime_type || '').startsWith('audio/pcm')) {
        this.playPcm(audio.data, 24_000);
      }
    }
    if (content.turnComplete) {
      this.modelTurnStreaming = false;
      this.localInterruptionPending = false;
      const unansweredUserAt = this.currentTurnHasUserTranscript && !this.currentTurnHasAssistantOutput
        ? this.lastUserTranscriptAt
        : 0;
      this.currentTurnHasUserTranscript = false;
      this.currentTurnHasAssistantOutput = false;
      clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = setTimeout(() => {
        this.emit('limova-voice-transcript', { role: 'user', text: '', final: true });
        if (!this.trainingMode) this.emit('limova-voice-transcript', { role: 'assistant', text: '', final: true });
      }, 350);
      if (!this.trainingMode && unansweredUserAt) this.scheduleReplyRecovery(unansweredUserAt);
      this.emit('limova-voice-status', { status: 'listening' });
      this.flushDeferredObservations();
    }
  }

  scheduleReplyRecovery(userTranscriptAt) {
    clearTimeout(this.replyRecoveryTimer);
    if (this.replyFallbackTurnAt === userTranscriptAt) return;
    const nextAttempt = this.replyRecoveryCount + 1;
    const isFallbackStage = nextAttempt > 2;
    // Live sometimes completes the transcription before the audio response is
    // scheduled. A slightly wider grace window avoids injecting a technical
    // recovery prompt into a response that is merely starting slowly.
    const delayMs = nextAttempt === 1 ? 3_500 : nextAttempt === 2 ? 5_000 : 3_500;
    this.replyRecoveryTimer = setTimeout(() => {
      this.replyRecoveryTimer = null;
      if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.lastUserTranscriptAt !== userTranscriptAt || this.lastAssistantOutputAt >= userTranscriptAt) return;
      // A completed tool from the previous turn must not suppress the answer
      // to a newer user utterance. Only tool activity belonging to this turn
      // (or a tool still running) can legitimately delay recovery.
      const toolActivityBelongsToCurrentTurn = this.lastToolActivityAt >= userTranscriptAt
        && Date.now() - this.lastToolActivityAt < 6_000;
      if (this.toolCallsInFlight > 0 || toolActivityBelongsToCurrentTurn) {
        this.diagnostic('VOICE_REPLY_RECOVERY_DEFERRED', {
          toolCallsInFlight: this.toolCallsInFlight,
          sinceLastToolMs: Math.max(0, Date.now() - this.lastToolActivityAt)
        });
        this.scheduleReplyRecovery(userTranscriptAt);
        return;
      }
      if (isFallbackStage) {
        this.replyFallbackTurnAt = userTranscriptAt;
        this.currentTurnHasAssistantOutput = true;
        this.lastAssistantOutputAt = Date.now();
        const lang = String(document.documentElement.lang || navigator.language || 'fr').toLowerCase();
        const fallbackText = lang.startsWith('en')
          ? 'I heard you, but the voice response did not arrive. Please repeat your request.'
          : lang.startsWith('es')
            ? 'Te he oído, pero la respuesta de voz no ha llegado. Repite tu solicitud.'
            : 'Je t’ai bien entendu, mais la réponse vocale n’est pas arrivée. Répète ta demande.';
        this.emitSafeTranscript('assistant', fallbackText);
        this.emit('limova-voice-transcript', { role: 'assistant', text: '', final: true });
        this.emit('limova-voice-status', { status: 'listening' });
        this.diagnostic('VOICE_REPLY_FALLBACK_SHOWN', {
          recoveryAttempts: this.replyRecoveryCount,
          delayMs
        });
        return;
      }
      this.replyRecoveryCount += 1;
      this.socket.send(JSON.stringify({
        clientContent: {
          turns: [{
            role: 'user',
            parts: [{
              text: '[RELANCE TECHNIQUE — réponds à la dernière demande utilisateur, sans mentionner cette relance. Si une action vient d’être exécutée, confirme son résultat oralement. Sinon réponds normalement.]'
            }]
          }],
          turnComplete: true
        }
      }));
      this.diagnostic('VOICE_REPLY_RECOVERY_SENT', { attempt: this.replyRecoveryCount, delayMs });
      this.scheduleReplyRecovery(userTranscriptAt);
    }, delayMs);
  }

  emitSafeTranscript(role, text) {
    const value = String(text || '');
    const lang = String(document.documentElement.lang || navigator.language || 'fr').toLowerCase();
    const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
    const hasCyrillic = /[\u0400-\u04ff]/u.test(value);
    const hasLatin = /[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(value);
    const unexpectedScript = (lang.startsWith('fr') || lang.startsWith('en') || lang.startsWith('es'))
      && (hasJapanese || hasCyrillic)
      && !hasLatin;
    if (unexpectedScript) {
      this.diagnostic('VOICE_TRANSCRIPT_LANGUAGE_MISMATCH', {
        role,
        characterCount: value.length,
        script: hasJapanese ? 'cjk' : 'cyrillic'
      });
      return false;
    }
    this.emit('limova-voice-transcript', { role, text: value, final: false });
    return true;
  }

  downsample(input, inputRate, outputRate) {
    if (inputRate === outputRate) return Int16Array.from(input, sample => Math.max(-1, Math.min(1, sample)) * 0x7fff);
    const ratio = inputRate / outputRate;
    const output = new Int16Array(Math.floor(input.length / ratio));
    for (let index = 0; index < output.length; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
      let total = 0;
      for (let cursor = start; cursor < end && cursor < input.length; cursor += 1) total += input[cursor];
      const sample = Math.max(-1, Math.min(1, total / (end - start)));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  async handleToolCalls(functionCalls) {
    this.toolCallsInFlight += 1;
    this.lastToolActivityAt = Date.now();
    clearTimeout(this.replyRecoveryTimer);
    this.replyRecoveryTimer = null;
    const functionResponses = [];
    try {
      for (const call of functionCalls) {
      let result = { ok: false, error: 'Fonction non autorisée.' };
      if (call.name === 'inspect_current_page' || call.name === 'verify_expected_result' || call.name === 'capture_current_view') {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_CONTEXT_REQUEST',
          toolName: call.name,
          ...(call.name === 'capture_current_view' ? { capture: true } : {})
        })
          .catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
        this.diagnostic(result?.ok ? 'VOICE_PAGE_INSPECTION_SUCCEEDED' : 'VOICE_PAGE_INSPECTION_FAILED', {
          contextVersion: Number(result?.contextVersion || 0),
          characterCount: String(result?.pageContext || '').length,
          elementCount: Number(result?.elementCount || 0)
        });
      } else if (call.name === 'search_knowledge_base' && typeof call.args?.query === 'string') {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_KB_SEARCH',
          query: call.args.query
        }).catch(() => ({ ok: false, error: 'La documentation Limova est indisponible.' }));
        this.diagnostic(result?.ok ? 'VOICE_KB_SEARCH_SUCCEEDED' : 'VOICE_KB_SEARCH_FAILED', {
          queryLength: call.args.query.length,
          resultCharacters: String(result?.knowledge || '').length
        });
      } else if ((call.name === 'fill_field' || call.name === 'type_text_into_page')
        && Number.isInteger(call.args?.elementId)
        && typeof call.args?.text === 'string') {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_TEXT_INPUT_REQUEST',
          elementId: call.args.elementId,
          contextVersion: call.args.contextVersion,
          targetLabel: typeof call.args?.targetLabel === 'string' ? call.args.targetLabel : '',
          text: call.args.text
        }).catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
        this.diagnostic(result?.ok ? 'VOICE_TEXT_INPUT_SUCCEEDED' : 'VOICE_TEXT_INPUT_FAILED', {
          elementId: call.args.elementId,
          characterCount: call.args.text.length,
          clarificationRequired: Boolean(result?.clarificationRequired),
          failureCode: result?.ok ? null : String(result?.failureCode || 'field_operation_failed').slice(0, 80),
          contextVersion: Number(result?.contextVersion || call.args?.contextVersion || 0),
          retryWithFreshContext: Boolean(result?.retryWithFreshContext)
        });
        if (result?.ok) {
          // Limova filters large integration grids with a short React debounce.
          // Wait for the filtered cards to replace the previous 3,237-item map.
          await new Promise(resolve => setTimeout(resolve, 550));
          const refreshed = await chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' })
            .catch(() => null);
          if (refreshed?.ok) result = { ...result, ...refreshed };
        }
      } else if (call.name === 'scroll_page' && ['up', 'down', 'top', 'bottom'].includes(call.args?.direction)) {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_SCROLL_REQUEST',
          direction: call.args.direction,
          amount: ['small', 'medium', 'large'].includes(call.args?.amount) ? call.args.amount : 'medium',
          ...(Number.isInteger(call.args?.elementId) ? { elementId: call.args.elementId } : {}),
          contextVersion: call.args?.contextVersion
        }).catch(() => ({ ok: false, error: 'La page Limova est indisponible.' }));
        if (result?.ok) {
          await new Promise(resolve => setTimeout(resolve, 180));
          const refreshed = await chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' }).catch(() => null);
          if (refreshed?.ok) result = { ...result, ...refreshed };
        }
      } else if (['click_element', 'navigate_internal', 'request_page_action'].includes(call.name) && Number.isInteger(call.args?.elementId)) {
        result = await chrome.runtime.sendMessage({
          type: 'VOICE_ACTION_REQUEST',
          toolName: call.name,
          elementId: call.args.elementId,
          contextVersion: call.args.contextVersion,
          explicitRequest: call.args?.explicitRequest === true,
          targetLabel: typeof call.args?.targetLabel === 'string' ? call.args.targetLabel : ''
        }).catch(() => ({ ok: false, error: 'Extension indisponible.' }));

        // A click can replace the whole SPA view. Return the post-action DOM
        // map in the same tool response so Gemini does not reason from stale
        // element IDs on its next step.
        if (result?.ok) {
          await new Promise(resolve => setTimeout(resolve, 300));
          const refreshed = await chrome.runtime.sendMessage({ type: 'VOICE_CONTEXT_REQUEST' })
            .catch(() => null);
          if (refreshed?.ok) result = { ...result, ...refreshed };
        }
      }
      const pageContext = String(result?.pageContext || '');
      if (pageContext) this.acknowledgePageContext(result?.contextVersion);
      if (result?.visualCapture) {
        this.queueVisualCapture(result.visualCapture, result.contextVersion, `tool:${call.name}`);
        this.flushVisualCapture();
      }
      const response = {
        status: result?.status === 'unexpected' || result?.verificationRequired
            ? 'unexpected'
            : result?.ok
              ? 'ok'
            : result?.clarificationRequired
              ? 'ambiguous'
              : 'blocked',
        contextVersion: Number(result?.contextVersion || call.args?.contextVersion || 0)
      };
      if (pageContext) {
        response.pageContext = pageContext;
        response.contextVersion = Number(result.contextVersion || 0);
        response.elementCount = Number(result.elementCount || 0);
        if (result?.technicalDiagnostics) {
          response.technicalDiagnostics = String(result.technicalDiagnostics).slice(0, 4_000);
        }
        if ((!result?.ok || result?.status === 'unexpected' || result?.verificationRequired) && result?.error) {
          response.reason = String(result.error).slice(0, 240);
          response.retryWithFreshContext = Boolean(result.retryWithFreshContext);
          if (result.verificationRequired) response.verificationRequired = true;
          if (result.clarificationRequired) response.clarificationRequired = true;
        }
      } else if (!result?.ok && result?.error) {
        response.reason = String(result.error).slice(0, 240);
        if (result.clarificationRequired) response.clarificationRequired = true;
      } else if (result?.knowledge) {
        response.knowledgeBase = String(result.knowledge).slice(0, 6_000);
      }
        functionResponses.push({
        id: call.id,
        name: call.name,
        response
      });
      }
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
      }
    } finally {
      this.toolCallsInFlight = Math.max(0, this.toolCallsInFlight - 1);
      this.lastToolActivityAt = Date.now();
      this.flushDeferredObservations();
    }
  }

  pcmToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async playPcm(base64, sampleRate) {
    if (this.localInterruptionPending || Date.now() < this.suppressPlaybackUntil) return false;
    this.outputContext ||= new AudioContext({ sampleRate });
    if (this.outputContext.state === 'suspended') await this.outputContext.resume();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const floats = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let index = 0; index < floats.length; index += 1) floats[index] = view.getInt16(index * 2, true) / 0x8000;
    const buffer = this.outputContext.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const source = this.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputContext.destination);
    const startAt = Math.max(this.outputContext.currentTime, this.nextPlaybackTime);
    if (this.playingSources.size === 0) this.lastPlaybackStartedAt = Date.now();
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playingSources.add(source);
    source.onended = () => {
      this.playingSources.delete(source);
      if (this.playingSources.size === 0) {
        this.emit('limova-voice-status', { status: 'listening' });
        this.flushDeferredObservations();
      }
    };
    this.emit('limova-voice-status', { status: 'speaking' });
  }

  detectLocalInterruption(samples) {
    if (!(samples instanceof Float32Array) || this.playingSources.size === 0) {
      this.localSpeechFrames = 0;
      return false;
    }
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) energy += samples[index] * samples[index];
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    const threshold = Math.max(0.06, this.localNoiseFloor * 2.8);
    if (rms < threshold) {
      this.localNoiseFloor = Math.max(0.004, Math.min(0.04, this.localNoiseFloor * 0.96 + rms * 0.04));
      this.localSpeechFrames = Math.max(0, this.localSpeechFrames - 1);
      return false;
    }
    if (Date.now() - this.lastPlaybackStartedAt < 300 || this.localInterruptionPending) return false;
    this.localSpeechFrames += 1;
    if (this.localSpeechFrames < 7 || Date.now() - this.lastLocalInterruptionAt < 1_500) return false;
    this.localSpeechFrames = 0;
    this.lastLocalInterruptionAt = Date.now();
    this.localInterruptionPending = true;
    this.suppressPlaybackUntil = Date.now() + 1_800;
    this.clearPlayback();
    this.emit('limova-voice-status', { status: 'listening' });
    this.diagnostic('VOICE_LOCAL_INTERRUPTION_DETECTED', { threshold: 'speech' });
    return true;
  }

  isOutputBusy() {
    const scheduledAudio = this.outputContext
      && this.nextPlaybackTime > this.outputContext.currentTime + 0.03;
    return this.toolCallsInFlight > 0 || this.modelTurnStreaming || this.playingSources.size > 0 || Boolean(scheduledAudio);
  }

  flushDeferredObservations() {
    if (this.isOutputBusy()) return false;
    const pagePushed = this.flushPageContextUpdate();
    const capturePushed = this.flushVisualCapture();
    return pagePushed || capturePushed;
  }

  clearPlayback() {
    for (const source of this.playingSources) {
      try { source.stop(); } catch (_) {}
    }
    this.playingSources.clear();
    this.nextPlaybackTime = 0;
  }

  cleanupMedia() {
    clearTimeout(this.transcriptFlushTimer);
    this.transcriptFlushTimer = null;
    clearTimeout(this.replyRecoveryTimer);
    this.replyRecoveryTimer = null;
    this.currentTurnHasUserTranscript = false;
    this.currentTurnHasAssistantOutput = false;
    this.replyRecoveryCount = 0;
    this.replyFallbackTurnAt = 0;
    this.localSpeechFrames = 0;
    this.localNoiseFloor = 0.012;
    this.localInterruptionPending = false;
    this.suppressPlaybackUntil = 0;
    this.modelTurnStreaming = false;
    this.toolCallsInFlight = 0;
    this.lastToolActivityAt = 0;
    this.clearPlayback();
    if (this.captureNode?.port) this.captureNode.port.onmessage = null;
    this.captureNode?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.inputContext?.close().catch(() => {});
    this.outputContext?.close().catch(() => {});
    this.captureNode = null;
    this.source = null;
    this.stream = null;
    this.inputContext = null;
    this.outputContext = null;
    this.pendingPageContext = null;
  }

  async reconnect() {
    if (this.reconnecting || !this.tokenData || new Date(this.tokenData.expiresAt).getTime() <= Date.now()) return;
    this.reconnecting = true;
    this.diagnostic('LIVE_WS_RECONNECT_STARTED');
    this.ready = false;
    this.emit('limova-voice-status', { status: 'connecting' });
    const previous = this.socket;
    try {
      const connection = this.openSocket(this.tokenData);
      previous?.close(1000, 'session-resumption');
      await connection;
      this.diagnostic('LIVE_WS_RECONNECT_SUCCEEDED');
    } catch (error) {
      this.diagnostic('LIVE_WS_RECONNECT_FAILED', { name: error.name, message: error.message });
      this.stop(false);
      this.emit('limova-voice-status', { status: 'error', error: error.message });
    } finally {
      this.reconnecting = false;
    }
  }

  stop(notify = true) {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.markBackgroundVoiceState(false);
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (_) {}
      socket.close(1000, 'user-stop');
    } else if (socket) {
      socket.close();
    }
    this.cleanupMedia();
    this.diagnostic('VOICE_SESSION_STOPPED', { notified: notify });
    if (notify) this.emit('limova-voice-status', { status: 'stopped' });
  }
}

window.LimovaVoiceSession = LimovaVoiceSession;
