/* GPT Live voice transport. Authentication and guarded browser tools stay in the service worker. */
class LimovaOpenAiVoiceSession extends window.LimovaVoiceSession {
  constructor(options = {}) {
    super(options);
    this.peer = null;
    this.events = null;
    this.audio = null;
    this.seenCalls = new Set();
    this.toolOutputs = new Set();
    this.sentEvents = new Map();
    this.transcripts = { user: null, assistant: null };
    this.transcriptSequence = 0;
    this.toolQueue = Promise.resolve();
    this.outgoingQueue = Promise.resolve();
    this.taskRevision = 0;
    this.delegations = new Map();
    this.task = null;
    this.userSegments = [];
    this.activeDelegation = null;
    this.taskChangedAt = null;
  }

  sendEvent(event) {
    if (this.events?.readyState !== 'open') return false;
    const outgoing = { event_id: crypto.randomUUID(), ...event };
    const payload = JSON.stringify(outgoing);
    if (new TextEncoder().encode(payload).byteLength > 48_000) throw new Error('Message vocal trop volumineux.');
    this.events.send(payload);
    // Keep command metadata only, never the audio, page or conversation.
    this.sentEvents.set(outgoing.event_id, { command: event.type, ...(event.item?.type ? { itemType: event.item.type } : {}) });
    if (this.sentEvents.size > 128) this.sentEvents.delete(this.sentEvents.keys().next().value);
    return true;
  }

  async sendBackendItem(item, lifecycle = this.lifecycleId) {
    const dc = this.events;
    if (!dc || lifecycle !== this.lifecycleId || dc.readyState !== 'open') return false;
    if (dc.bufferedAmount > 64_000) {
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', done); };
        const done = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Transmission du contexte vocal expirée.')); }, 10_000);
        dc.bufferedAmountLowThreshold = 32_000;
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
        if (dc.bufferedAmount <= 32_000) done();
      });
    }
    return lifecycle === this.lifecycleId && dc === this.events && this.sendEvent({ type: 'response.item.create', item });
  }

  async sendBackendContext(text, lifecycle = this.lifecycleId) {
    // WebRTC messages have a byte limit. Split the complete map into ordered
    // text items; no control or tail of the page is silently discarded.
    const parts = [];
    let chunk = '', bytes = 0;
    const encoder = new TextEncoder();
    for (const character of text) {
      const size = encoder.encode(JSON.stringify(character)).byteLength - 2;
      if (bytes + size > 24_000) { parts.push(chunk); chunk = ''; bytes = 0; }
      chunk += character; bytes += size;
    }
    if (chunk) parts.push(chunk);
    for (let index = 0; index < parts.length; index++) {
      const value = parts.length === 1 ? parts[index] : `[Contexte technique ${index + 1}/${parts.length} — attends la fin de la carte avant d’agir]\n${parts[index]}`;
      if (!(await this.sendBackendItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] }, lifecycle))) return false;
    }
    return true;
  }

  async sendLegacy(raw) {
    const lifecycle = this.lifecycleId;
    const message = JSON.parse(raw);
    if (message.toolResponse) {
      let submitted = false;
      for (const result of message.toolResponse.functionResponses) {
        // An action can finish before a spoken correction arrives, while its
        // image is still being sent. Never replace its result with a second
        // cancellation output for the same call_id.
        const outputs = this.toolOutputs;
        if (outputs.has(result.id)) continue;
        outputs.add(result.id);
        let delivered = false;
        try {
          let output = JSON.stringify(result.response);
          if (new TextEncoder().encode(output).byteLength > 24_000 && result.response.pageContext) {
            await this.sendBackendContext(`Carte DOM courante, version ${result.response.contextVersion}. Source : résultat ${result.name || 'outil'}.\n${result.response.pageContext}`, lifecycle);
            output = JSON.stringify({ ...result.response, pageContext: 'Carte complète transmise dans les messages techniques précédents.' });
          }
          delivered = await this.sendBackendItem({ type: 'function_call_output', call_id: result.id, output }, lifecycle);
          if (!delivered) return;
          submitted = true;
        } finally {
          if (!delivered) outputs.delete(result.id);
        }
      }
      if (!submitted) return;
      await this.sendVisualContext();
      if (lifecycle === this.lifecycleId) this.sendEvent({ type: 'response.create' });
    } else if (message.clientContent) {
      const text = message.clientContent.turns.flatMap(t => t.parts.map(p => p.text || '')).join('\n');
      this.sendEvent({ type: 'session.thinking.append', delegation_id: null, content: text.slice(0, 350) });
      await this.sendBackendContext(text, lifecycle);
      this.diagnostic('VOICE_BACKEND_CONTEXT_QUEUED', { characterCount: text.length });
    }
  }

  async start() {
    if (this.active || this.starting) return;
    const lifecycle = ++this.lifecycleId;
    this.starting = true;
    this.failed = false;
    this.operationId = `gpt-live-${crypto.randomUUID()}`;
    this.seenCalls.clear();
    this.toolOutputs.clear();
    this.sentEvents.clear();
    this.transcripts = { user: null, assistant: null };
    this.toolQueue = Promise.resolve();
    this.outgoingQueue = Promise.resolve();
    this.delegations.clear();
    this.task = null;
    this.userSegments = [];
    this.activeDelegation = null;
    this.taskChangedAt = null;
    this.emit('limova-voice-status', { status: 'connecting' });
    let timeout;
    try {
      // Remember the panel's window and its web tab before microphone consent
      // opens a temporary extension tab (possibly stealing window focus).
      const panelWindow = await chrome.windows.getCurrent();
      this.contextWindowId = panelWindow.id;
      const [initialTab] = await chrome.tabs.query({ active: true, windowId: panelWindow.id });
      const initialContext = await chrome.runtime.sendMessage({ type: 'GET_VOICE_PAGE_CONTEXT', windowId: panelWindow.id, initialTabId: initialTab?.id });
      if (lifecycle !== this.lifecycleId) return;
      if (!initialContext?.ok) {
        if (initialContext?.consentRequired) this.emit('limova-voice-consent-required');
        const error = new Error(initialContext?.error || 'Ouvre une page web dans cette fenêtre avant de démarrer Charly.');
        error.voiceDiagnosticCode = initialContext?.code || (initialContext?.consentRequired ? 'VOICE_CONSENT_REQUIRED' : 'VOICE_CONTEXT_UNAVAILABLE');
        throw error;
      }
      const task = await chrome.runtime.sendMessage({ type: 'VOICE_TASK_BEGIN' });
      this.taskRevision = task.revision;
      this.taskUpdate = Promise.resolve(task);
      this.microphonePermissionTabId = null;
      const stream = await this.requestMicrophone(lifecycle);
      if (lifecycle !== this.lifecycleId) return;
      this.stream = stream;
      stream.getAudioTracks().forEach(track => { track.enabled = !this.microphoneMuted; });
      // Close only the permission helper opened by this session, after grant.
      // Until it closes, Chrome still considers that helper the active tab.
      if (this.microphonePermissionTabId != null) await chrome.tabs.remove(this.microphonePermissionTabId).catch(() => {});
      if (lifecycle !== this.lifecycleId) return;
      const peer = this.peer = new RTCPeerConnection();
      const audio = this.audio = new Audio();
      audio.autoplay = true;
      audio.controls = false;
      audio.hidden = true;
      audio.setAttribute('aria-label', 'Voix française GPT Live');
      document.body.append(audio);
      peer.addEventListener('track', event => {
        if (lifecycle !== this.lifecycleId) return;
        audio.srcObject = new MediaStream([event.track]);
        audio.play().catch(() => {
          if (lifecycle !== this.lifecycleId) return;
          audio.controls = true; audio.hidden = false;
          this.emit('limova-voice-status', { status: 'listening', error: 'Appuie sur lecture pour écouter GPT Live.' });
        });
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
            if (!this.ready) rejectReady(this.liveError(event));
            else this.handleLiveEvent(event);
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
      if (!result?.ok || !result.sdp) {
        const error = new Error(result?.error || 'GPT Live indisponible.');
        error.voiceDiagnosticCode = result?.code || 'LIVE_SESSION_SERVICE_FAILED';
        throw error;
      }
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
      this.diagnostic('LIVE_SETUP_COMPLETED', { model: 'gpt-live-1', voice: 'marin', lang: 'fr-FR', autonomyMode: result.autonomyMode || 'unknown' });
    } catch (error) {
      if (lifecycle !== this.lifecycleId) return;
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (lifecycle === this.lifecycleId) this.starting = false;
    }
  }

  setAutonomyMode(mode) {
    const label = { ask: 'Demander une approbation', balanced: 'Approuver pour moi', full: 'Accès complet' }[mode];
    if (!label || !this.ready) return;
    this.socket?.send(JSON.stringify({ clientContent: { turns: [{ parts: [{ text: `[RÉGLAGE UTILISATEUR — aucune nouvelle tâche] Niveau d’autonomie : ${label}. L’application applique ce choix ; les approbations déjà affichées attendent toujours la décision du membre.` }] }] } }));
  }

  requestApproval(action) {
    if (this.pendingApproval?.actionId === action.actionId) return;
    // The answer to this card must not be appended to the request that
    // triggered it, even when the member answers in less than two seconds.
    this.flushTranscript('user');
    this.transcripts.user = null;
    this.pendingApproval = action;
    this.sendEvent({ type: 'session.thinking.append', delegation_id: null,
      content: `Une approbation attend pour l’action ${JSON.stringify(action.label)}. Rien n’est encore exécuté. Demande une confirmation courte. L’utilisateur peut cliquer sur le bouton du panneau ou dire oui ; l’application exécutera cette action une seule fois après son accord. Ne relance pas cette action avec un autre outil.` });
  }

  resolveSpokenApproval(segment) {
    if (!segment.approvalId || segment.approvalHandled || this.pendingApproval?.actionId !== segment.approvalId) return;
    const text = segment.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const no = /^(?:non|no|annule|annuler|stop|arrete|cancel)\b/.test(text);
    const correction = /\b(?:change|changer|modifie|modifier|remplace|remplacer|decale|deplace|plutot|instead|autre|cree|ajoute|mets)\b/.test(text);
    const qualified = /\b(?:mais|sauf|avant|apres|but|except|si)\b|\bne\b.*\bpas\b/.test(text);
    const startsYes = /^(?:oui|ouais|yes|ok|okay|d accord|c est bon|vas y|go|je confirme|je valide|tu peux|vous pouvez|confirme|valide|enregistre|autorise|approuve)\b/.test(text);
    const allowed = new Set(('oui ouais yes ok okay d accord c est bon vas y go je confirme valide tu peux vous pouvez on peut le la l les ce cet cette ces faire fais enregistrer enregistre sauvegarder sauvegarde valider confirmer autoriser approuver maintenant merci s il te vous plait stp please do it proceed save rendez vous evenement formulaire modifications changements').split(' '));
    const label = String(this.pendingApproval.label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const word of label.split(' ')) allowed.add(word);
    const yes = startsYes && !qualified && !correction && text.split(' ').every(word => allowed.has(word));
    if (yes || (no && !correction)) {
      segment.approvalHandled = true;
      segment.approvalDecision = yes ? 'approved' : 'cancelled';
      this.pendingApproval = null;
      chrome.runtime.sendMessage({ type: yes ? 'CONFIRM_ACTION' : 'CANCEL_ACTION', actionId: segment.approvalId }).catch(() => {});
      this.diagnostic('VOICE_APPROVAL_DECIDED', { decision: yes ? 'approved' : 'cancelled', source: 'speech' });
    } else if (correction) {
      // A changed instruction cancels the pending decision instead of treating
      // a partial "oui, mais…" as approval of the old action.
      this.pendingApproval = null;
      segment.approvalHandled = true;
      this.replaceTask(segment, 'approval_changed');
      for (const delegation of this.delegations.values()) if (delegation.user?.id === segment.id) delegation.revision = this.taskRevision;
    } else {
      // An incomplete or ambiguous reply is not a cancellation. Keep the
      // same card and accept further speech or a click on its buttons.
      this.diagnostic('VOICE_APPROVAL_WAITING', { reason: 'ambiguous_speech', characterCount: text.length });
    }
  }

  replaceTask(segment, reason, offset = segment?.start, continuation = false) {
    const utterances = continuation ? [...(this.task?.utterances || [])] : [];
    if (segment && !utterances.includes(segment)) utterances.push(segment);
    const steps = continuation ? [...(this.task?.steps || [])] : [];
    this.taskRevision += 1;
    if (reason !== 'first_request' && Number.isFinite(offset)) this.taskChangedAt = offset;
    if (segment) segment.revision = this.taskRevision;
    this.task = { revision: this.taskRevision, utteranceId: segment?.id, instruction: utterances.map(part => part.text).join(' '), phase: 'listening', steps, utterances };
    this.currentUserTurnText = this.task.instruction.slice(-4000);
    this.taskUpdate = chrome.runtime.sendMessage({ type: 'VOICE_TASK_UPDATE', revision: this.taskRevision });
    this.diagnostic('VOICE_TASK_REPLACED', { taskRevision: this.taskRevision, reason });
  }

  liveError(event) {
    const error = new Error(event.error?.message || 'La session GPT Live a échoué.');
    const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_.]{0,79}$/i.test(value) ? value : 'unknown';
    error.voiceErrorDetails = {
      source: event.type === 'session.failed' ? 'session' : 'command',
      upstreamCode: safeCode(event.error?.code),
      upstreamType: safeCode(event.error?.type),
      ...(this.sentEvents.get(event.error?.client_event_id || event.client_event_id) || {})
    };
    return error;
  }

  handleLiveEvent(event) {
    if (event.type === 'error' || event.type === 'session.failed') {
      const error = this.liveError(event);
      if (event.type === 'error' && event.error?.type === 'invalid_request_error') {
        this.diagnostic('VOICE_COMMAND_ERROR', error.voiceErrorDetails);
        if (this.task) this.task.phase = 'needs_attention';
        chrome.runtime.sendMessage({ type: 'VOICE_TASK_PROGRESS', taskRevision: this.taskRevision,
          phase: 'needs_attention', stepCount: this.task?.steps.length || 0 }).catch(() => {});
        // A rejected command is not a failed audio connection. Do not replay
        // an action: the member can clarify or retry in the existing session.
        this.emit('limova-voice-status', { status: 'listening', error: 'Une étape n’a pas abouti. La conversation vocale reste active.' });
      } else this.fail(error);
      return;
    }
    if (event.type === 'session.delegation.created') {
      const id = event.delegation?.id || event.delegation_id;
      if (!id || this.delegations.has(id)) return;
      const user = Number.isFinite(event.offset_ms)
        ? [...this.userSegments].reverse().find(segment => segment.start <= event.offset_ms)
        : this.transcripts.user;
      const outdated = Number.isFinite(event.offset_ms) && this.taskChangedAt !== null && event.offset_ms < this.taskChangedAt;
      // Speech fragments have no turn-completed event. Their two-second gap
      // is a caption boundary only. Supersede old work when Live actually
      // delegates the newer request, or immediately on an explicit correction.
      if (!outdated && user && user.revision === this.taskRevision && this.activeDelegation?.revision === this.taskRevision
          && this.activeDelegation.user?.id !== user.id && !user.approvalId && !this.pendingApproval) {
        const normalized = user.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const continuation = /^(?:et|puis|ensuite|and|then|y|luego)\b/.test(normalized)
          || (this.task?.phase !== 'verified' && /^(?:oui|ouais|ok|okay|d accord|c est bon|vas y|yes|demain|pour|avec|a|de|du|le|la|[0-9]+)\b/.test(normalized));
        this.replaceTask(user, continuation ? 'continuation_delegation' : 'new_delegation', event.offset_ms ?? user.start, continuation);
      }
      const delegation = { revision: outdated ? -1 : user?.revision ?? this.taskRevision, user };
      this.delegations.set(id, delegation);
      if (delegation.revision === this.taskRevision) this.activeDelegation = delegation;
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
        segment = this.transcripts[role] = { id: `${this.operationId}:${role}:${++this.transcriptSequence}`, role, text: '', start: at, end: at, timer: null, revision: this.taskRevision };
        if (role === 'user' && !this.trainingMode && this.pendingApproval) segment.approvalId = this.pendingApproval.actionId;
        if (role === 'user' && !this.trainingMode && !segment.approvalId) {
          if (!this.task) this.replaceTask(segment, 'first_request');
          if (this.activeDelegation && !this.activeDelegation.user && this.userSegments.length === 0) {
            this.activeDelegation.user = segment;
            this.activeDelegation.revision = this.taskRevision;
          }
        }
        if (role === 'user') {
          this.userSegments.push(segment);
          if (this.userSegments.length > 100) this.userSegments.shift();
        }
      }
      segment.text += String(event.delta || '').replace(/\uFFFD/g, '');
      segment.end = Number.isFinite(event.end_ms) ? event.end_ms : at;
      if (role === 'user') {
        if (!segment.approvalId && !segment.interrupted && /(?:^|[.!?,]\s*)(?:non\b|arrête\b|arrete\b|stop\b|annule\b)/iu.test(segment.text)) {
          segment.interrupted = true;
          this.replaceTask(segment, 'spoken_correction', at);
          this.task.phase = 'corrected';
        }
        if (this.task) {
          if (!this.task.utterances.includes(segment)) this.task.utterances.push(segment);
          this.task.instruction = this.task.utterances.map(part => part.text).join(' ');
        }
        this.currentUserTurnText = (this.task?.instruction || segment.text).slice(-4000);
      }
      if (this.trainingMode) this.emitSafeTranscript(role, event.delta || '');
      else this.emit('limova-gpt-transcript', { role, text: segment.text, utteranceId: segment.id, final: false });
      clearTimeout(segment.timer);
      segment.timer = setTimeout(() => this.flushTranscript(role, false), 2500);
    } else if (event.type === 'response.event' && event.event?.type === 'response.output_item.done') {
      const call = event.event.item;
      if (call?.type !== 'function_call' || this.seenCalls.has(call.call_id)) return;
      this.seenCalls.add(call.call_id);
      let args;
      try { args = JSON.parse(call.arguments || '{}'); }
      catch { args = {}; }
      const lifecycle = this.lifecycleId;
      const delegation = this.delegations.get(event.delegation_id) || (event.delegation_id ? { revision: -1 } : { revision: this.taskRevision, user: this.transcripts.user });
      let revision = delegation.revision;
      const user = delegation.user;
      const isCurrent = () => lifecycle === this.lifecycleId && revision === this.taskRevision;
      const cancelled = () => {
        if (lifecycle !== this.lifecycleId) return;
        if (this.toolOutputs.has(call.call_id)) return;
        this.diagnostic('VOICE_TOOL_CANCELLED', { tool: call.name, taskRevision: revision });
        return this.socket?.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: call.call_id,
          response: { status: 'cancelled', reason: 'La demande a changé. Relis la dernière consigne avant toute action.' } }] } }));
      };
      this.toolQueue = this.toolQueue.then(async () => {
        revision = delegation.revision;
        await this.taskUpdate;
        if (user?.approvalDecision && !['inspect_current_page', 'capture_current_view', 'verify_expected_result'].includes(call.name)) return cancelled();
        if (!isCurrent()) return cancelled();
        if (user?.text.trim()) {
          await chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', role: 'user', text: user.text, utteranceId: user.id,
            taskInstruction: this.task?.instruction || user.text, final: false, taskRevision: revision });
        }
        if (!isCurrent()) return cancelled();
        if (this.task) this.task.phase = 'executing';
        chrome.runtime.sendMessage({ type: 'VOICE_TASK_PROGRESS', taskRevision: revision, phase: 'executing', stepCount: this.task?.steps.length || 0 }).catch(() => {});
        await this.handleToolCalls([{ id: call.call_id, name: call.name, args }], { isCurrent, taskRevision: revision });
        if (!isCurrent()) await cancelled();
      }).catch(error => { if (lifecycle === this.lifecycleId) this.fail(error); });
    }
  }

  flushTranscript(role, persist = true) {
    for (const speaker of role ? [role] : ['user', 'assistant']) {
      const segment = this.transcripts[speaker];
      if (!segment) continue;
      if (speaker === 'user') this.resolveSpokenApproval(segment);
      clearTimeout(segment.timer);
      segment.timer = null;
      if (segment.finalizedText === segment.text && (!persist || segment.persisted)) continue;
      if (persist) segment.persisted = true;
      segment.finalizedText = segment.text;
      if (this.trainingMode) this.emit('limova-voice-transcript', { role: speaker, text: '', final: true });
      else this.emit('limova-gpt-transcript', { role: speaker, text: segment.text, utteranceId: segment.id, final: true, persist });
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
    if (this.failed) return;
    this.failed = true;
    const code = error.voiceDiagnosticCode || 'VOICE_SESSION_FAILED';
    this.diagnostic(code, { name: error.name, ...error.voiceErrorDetails });
    if (!['VOICE_MIC_DISMISSED', 'VOICE_CONSENT_REQUIRED'].includes(code)) this.trackEvent('voice_session_failed', { code });
    this.stop(false, 'error');
    this.emit('limova-voice-status', { status: 'error', error: error.message });
  }

  stop(notify = true, reason = 'user_stop') {
    const dc = this.events;
    const peer = this.peer;
    const audio = this.audio;
    this.pendingApproval = null;
    this.flushTranscript();
    // Stop microphone immediately; keep the transport briefly for final usage.
    this.sendEvent({ type: 'session.close' });
    this.events = null;
    this.peer = null;
    this.audio = null;
    audio?.pause();
    if (audio) { audio.srcObject = null; audio.remove(); }
    const cleanup = () => { clearTimeout(timer); dc?.close(); peer?.close(); };
    const timer = dc || peer ? setTimeout(cleanup, 15_000) : null;
    dc?.addEventListener('message', ({ data }) => { try { if (JSON.parse(data).type === 'session.closed') cleanup(); } catch {} });
    super.stop(notify, reason);
  }
}
window.LimovaVoiceSession = LimovaOpenAiVoiceSession;
