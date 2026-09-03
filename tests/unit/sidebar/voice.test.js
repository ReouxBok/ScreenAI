// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  receive(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  receiveRaw(data) {
    this.emit('message', { data });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeArgs = { code, reason };
  }
}

function makeAudioContext() {
  const mediaSource = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: 48_000,
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => mediaSource),
    createScriptProcessor: vi.fn(),
    createBuffer: vi.fn((_channels, length, rate) => ({
      duration: length / rate,
      copyToChannel: vi.fn()
    })),
    createBufferSource: vi.fn(() => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null
    })),
    _mediaSource: mediaSource
  };
  return context;
}

class FakeAudioWorkletNode {
  static instances = [];

  constructor(context, name, options) {
    this.context = context;
    this.name = name;
    this.options = options;
    this.connect = vi.fn();
    this.disconnect = vi.fn();
    this.port = { onmessage: null };
    FakeAudioWorkletNode.instances.push(this);
  }

  emit(data) {
    this.port.onmessage?.({ data });
  }
}

describe('Gemini Live voice protocol', () => {
  let chromeMock;
  let audioContexts;
  let mediaTrack;
  let VoiceSession;
  let runtimeMessageListeners;
  let tabRemovedListeners;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeAudioWorkletNode.instances = [];
    globalThis.WebSocket = FakeWebSocket;
    window.WebSocket = FakeWebSocket;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode;
    window.AudioWorkletNode = FakeAudioWorkletNode;
    audioContexts = [];
    globalThis.AudioContext = vi.fn(function AudioContextMock() {
      const context = makeAudioContext();
      audioContexts.push(context);
      return context;
    });
    window.AudioContext = globalThis.AudioContext;
    mediaTrack = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [mediaTrack] })) }
    });
    chromeMock = installChromeMock();
    runtimeMessageListeners = new Set();
    tabRemovedListeners = new Set();
    chromeMock.runtime.getURL = vi.fn(path => `chrome-extension://test-extension/${path}`);
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => runtimeMessageListeners.add(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => runtimeMessageListeners.delete(listener));
    chromeMock.tabs = {
      create: vi.fn(async () => ({ id: 42 })),
      onRemoved: {
        addListener: vi.fn(listener => tabRemovedListeners.add(listener)),
        removeListener: vi.fn(listener => tabRemovedListeners.delete(listener))
      }
    };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'granted' })) }
    });
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'DIAGNOSTIC_EVENT'
      ? { ok: true }
      : {
          ok: true,
          token: 'auth_tokens/test value',
          model: 'gemini-3.1-flash-live-preview',
          contextVersion: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
    loadSidebarScript('src/sidebar/voice.js');
    VoiceSession = window.LimovaVoiceSession;
  });

  afterEach(() => {
    delete window.LimovaVoiceSession;
    delete globalThis.WebSocket;
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
    delete navigator.permissions;
    uninstallChromeMock();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function startConnectedSession(session = new VoiceSession()) {
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ setupComplete: {} });
    await starting;
    return { session, socket };
  }

  it('uses the constrained endpoint and sends a current audio-only setup', async () => {
    const statuses = [];
    window.addEventListener('limova-voice-status', event => statuses.push(event.detail.status), { once: false });
    const { socket } = await startConnectedSession();
    expect(socket.url).toContain('BidiGenerateContentConstrained?access_token=auth_tokens%2Ftest%20value');
    expect(socket.sent[0]).toEqual({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
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
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} }
      }
    });
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('listening');
  });

  it('decodes setupComplete from an ArrayBuffer frame returned by Gemini', async () => {
    const session = new VoiceSession();
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receiveRaw(new TextEncoder().encode(JSON.stringify({ setupComplete: {} })).buffer);

    await starting;

    expect(socket.binaryType).toBe('arraybuffer');
    expect(session.ready).toBe(true);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'LIVE_WS_FRAME_RECEIVED',
      data: expect.objectContaining({ dataType: 'ArrayBuffer', keys: ['setupComplete'] })
    }));
  });

  it('pushes each newer DOM context into the active Live session without creating a user turn', async () => {
    const { session, socket } = await startConnectedSession();

    expect(session.updatePageContext(
      'Page: Catalogue — /integrations/catalog\n[main]\n  [4] input(search) "Rechercher des intégrations"',
      2,
      'navigation'
    )).toBe(true);
    expect(session.updatePageContext('ancien contexte', 1, 'navigation')).toBe(false);

    const update = socket.sent.at(-1);
    expect(update.clientContent.turnComplete).toBe(false);
    expect(update.clientContent.turns[0]).toMatchObject({ role: 'user' });
    expect(update.clientContent.turns[0].parts[0].text).toContain('Version DOM: 2');
    expect(update.clientContent.turns[0].parts[0].text).toContain('/integrations/catalog');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_PAGE_CONTEXT_PUSHED',
      data: { contextVersion: 2, characterCount: expect.any(Number), source: 'navigation' }
    }));
  });

  it('defers DOM and visual observations until Charly finishes speaking', async () => {
    const { session, socket } = await startConnectedSession();
    const queuedAudio = { stop: vi.fn() };
    session.playingSources.add(queuedAudio);
    const sentBefore = socket.sent.length;

    expect(session.updatePageContext('Page mise à jour après un clic', 2, 'user_click', {
      mimeType: 'image/jpeg', data: 'QUJDRA=='
    })).toBe(false);
    expect(socket.sent).toHaveLength(sentBefore);

    session.playingSources.clear();
    session.handleServerMessage({ serverContent: { turnComplete: true } });

    expect(socket.sent.slice(sentBefore)).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientContent: expect.objectContaining({ turnComplete: false }) }),
      { realtimeInput: { video: { mimeType: 'image/jpeg', data: 'QUJDRA==' } } }
    ]));
  });

  it('sends an ephemeral visual frame after setup and keeps it out of diagnostics', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'DIAGNOSTIC_EVENT'
      ? { ok: true }
      : {
          ok: true,
          token: 'auth_tokens/test value',
          model: 'gemini-3.1-flash-live-preview',
          contextVersion: 3,
          visualCapture: { mimeType: 'image/jpeg', data: 'QUJDRA==' },
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });

    const { socket } = await startConnectedSession();

    expect(socket.sent[1]).toEqual({
      realtimeInput: { video: { mimeType: 'image/jpeg', data: 'QUJDRA==' } }
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_VISUAL_CONTEXT_PUSHED',
      data: {
        contextVersion: 3,
        encodedCharacters: 8,
        source: 'session_start'
      }
    }));
    expect(JSON.stringify(chromeMock.runtime.sendMessage.mock.calls)).not.toContain('QUJDRA==');
  });

  it('queues a page update until Live setup is complete', async () => {
    const session = new VoiceSession();
    session.lastContextVersion = 3;
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(session.updatePageContext('Page: Profil', 4, 'navigation')).toBe(false);
    expect(socket.sent).toHaveLength(1);
    socket.receive({ setupComplete: {} });
    await starting;

    expect(socket.sent.at(-1).clientContent.turns[0].parts[0].text).toContain('Page: Profil');
  });

  it('decodes setupComplete from a Blob-like frame', async () => {
    const session = new VoiceSession();
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receiveRaw({
      size: 20,
      text: vi.fn(async () => JSON.stringify({ setupComplete: {} }))
    });

    await starting;
    expect(session.ready).toBe(true);
  });

  it('fails immediately and records metadata for an invalid server frame', async () => {
    const session = new VoiceSession();
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receiveRaw(new TextEncoder().encode('not-json').buffer);

    await expect(starting).rejects.toThrow('Réponse vocale invalide.');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'LIVE_WS_FRAME_PARSE_FAILED',
      data: expect.objectContaining({ dataType: 'ArrayBuffer', byteLength: 8 })
    }));
  });

  it('surfaces a structured Gemini server error without waiting for timeout', async () => {
    const session = new VoiceSession();
    const starting = session.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'private upstream detail' } });

    await expect(starting).rejects.toThrow('Gemini Live a refusé la session vocale.');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'LIVE_SERVER_ERROR',
      data: { serverCode: 400, serverStatus: 'INVALID_ARGUMENT' }
    }));
  });

  it('requests microphone access before provisioning a short-lived token', async () => {
    const order = [];
    navigator.mediaDevices.getUserMedia.mockImplementationOnce(async () => {
      order.push('microphone');
      return { getTracks: () => [mediaTrack] };
    });
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request?.type === 'DIAGNOSTIC_EVENT' || request?.type === 'VOICE_SESSION_STATE') return { ok: true };
      order.push('token');
      return {
        ok: true,
        token: 'auth_tokens/test value',
        model: 'gemini-3.1-flash-live-preview',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    });

    const starting = new VoiceSession().start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive({ setupComplete: {} });
    await starting;

    expect(order).toEqual(['microphone', 'token']);
  });

  it('opens a full extension tab for the first microphone authorization', async () => {
    navigator.permissions.query.mockResolvedValueOnce({ state: 'prompt' });
    const session = new VoiceSession();
    const starting = session.start();

    await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-extension/src/sidebar/microphone-permission.html',
      active: true
    }));
    for (const listener of runtimeMessageListeners) {
      listener({ type: 'MICROPHONE_PERMISSION_RESULT', granted: true });
    }
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive({ setupComplete: {} });
    await starting;

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_LIVE_TOKEN', context: { trainingMode: false } });
  });

  it('does not open an authorization tab when Chrome has blocked the microphone', async () => {
    navigator.permissions.query.mockResolvedValueOnce({ state: 'denied' });
    const statuses = [];
    window.addEventListener('limova-voice-status', event => statuses.push(event.detail));

    await expect(new VoiceSession().start()).rejects.toThrow('Microphone permission denied.');

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ status: 'error', errorKey: 'voiceMicDenied' });
  });

  it('reports an unfinished authorization when the permission tab is closed', async () => {
    navigator.permissions.query.mockResolvedValueOnce({ state: 'prompt' });
    const statuses = [];
    window.addEventListener('limova-voice-status', event => statuses.push(event.detail));
    const starting = new VoiceSession().start();
    await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalledOnce());

    for (const listener of tabRemovedListeners) listener(42);
    await expect(starting).rejects.toThrow('Microphone permission was not granted.');

    expect(statuses.at(-1)).toMatchObject({ status: 'error', errorKey: 'voiceMicDismissed' });
  });

  it.each([
    ['NotAllowedError', 'Permission dismissed', 'voiceMicDismissed'],
    ['NotAllowedError', 'Permission denied', 'voiceMicDenied'],
    ['NotFoundError', 'Requested device not found', 'voiceMicNotFound'],
    ['NotReadableError', 'Could not start audio source', 'voiceMicUnavailable']
  ])('maps %s microphone failures to %s guidance', async (name, message, errorKey) => {
    const statuses = [];
    window.addEventListener('limova-voice-status', event => statuses.push(event.detail));
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(Object.assign(new Error(message), { name }));
    const session = new VoiceSession();

    await expect(session.start()).rejects.toThrow(message);

    expect(statuses.at(-1)).toMatchObject({ status: 'error', errorKey });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_LIVE_TOKEN' }));
    expect(session.active).toBe(false);
  });

  it('reports unsupported microphone access without requesting a token', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const statuses = [];
    window.addEventListener('limova-voice-status', event => statuses.push(event.detail));

    await expect(new VoiceSession().start()).rejects.toThrow('Microphone API unavailable.');

    expect(statuses.at(-1)).toMatchObject({ status: 'error', errorKey: 'voiceMicUnsupported' });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_LIVE_TOKEN' }));
  });

  it('releases the microphone when token provisioning fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'DIAGNOSTIC_EVENT'
      ? { ok: true }
      : { ok: false, error: 'Jeton vocal indisponible.' });

    await expect(new VoiceSession().start()).rejects.toThrow('Jeton vocal indisponible.');

    expect(mediaTrack.stop).toHaveBeenCalledOnce();
  });

  it('streams 16 kHz PCM through AudioWorklet without the deprecated ScriptProcessorNode', async () => {
    const { socket } = await startConnectedSession();
    expect(audioContexts[0].audioWorklet.addModule).toHaveBeenCalledWith(
      'chrome-extension://test-extension/src/sidebar/audio-input-worklet.js'
    );
    expect(audioContexts[0].createScriptProcessor).not.toHaveBeenCalled();
    const captureNode = FakeAudioWorkletNode.instances[0];
    expect(captureNode.name).toBe('limova-audio-input');
    captureNode.emit(new Float32Array(2048).fill(0.25).buffer);
    const audioMessage = socket.sent.at(-1);
    expect(audioMessage.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(audioMessage.realtimeInput.audio.data.length).toBeGreaterThan(0);
    expect(audioMessage.realtimeInput).not.toHaveProperty('mediaChunks');
  });

  it('immediately clears queued playback when the server reports interruption', () => {
    const session = new VoiceSession();
    const playing = { stop: vi.fn() };
    session.playingSources.add(playing);
    session.nextPlaybackTime = 12;
    session.handleServerMessage({ serverContent: { interrupted: true } });
    expect(playing.stop).toHaveBeenCalledOnce();
    expect(session.playingSources.size).toBe(0);
    expect(session.nextPlaybackTime).toBe(0);
  });

  it('ignores speaker echo and locally stops only after sustained user speech', () => {
    const session = new VoiceSession();
    const playing = { stop: vi.fn() };
    session.playingSources.add(playing);
    session.lastPlaybackStartedAt = Date.now() - 1_000;
    const echo = new Float32Array(2048).fill(0.045);
    const speech = new Float32Array(2048).fill(0.08);

    for (let frame = 0; frame < 12; frame += 1) {
      expect(session.detectLocalInterruption(echo)).toBe(false);
    }
    for (let frame = 0; frame < 6; frame += 1) {
      expect(session.detectLocalInterruption(speech)).toBe(false);
    }
    expect(session.detectLocalInterruption(speech)).toBe(true);

    expect(playing.stop).toHaveBeenCalledOnce();
    expect(session.playingSources.size).toBe(0);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT', code: 'VOICE_LOCAL_INTERRUPTION_DETECTED'
    }));
  });

  it('suppresses a spurious Japanese transcript in the French interface', () => {
    document.documentElement.lang = 'fr';
    const session = new VoiceSession();
    const transcripts = [];
    window.addEventListener('limova-voice-transcript', event => transcripts.push(event.detail));

    session.handleServerMessage({
      serverContent: { inputTranscription: { text: 'てなっちまうと' } }
    });

    expect(transcripts).toEqual([]);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_TRANSCRIPT_LANGUAGE_MISMATCH',
      data: { role: 'user', characterCount: 'てなっちまうと'.length, script: 'cjk' }
    }));
  });

  it('keeps a French transcript in the French interface', () => {
    document.documentElement.lang = 'fr';
    const session = new VoiceSession();
    const transcripts = [];
    window.addEventListener('limova-voice-transcript', event => transcripts.push(event.detail));

    session.handleServerMessage({
      serverContent: { inputTranscription: { text: 'Ouvre les intégrations' } }
    });

    expect(transcripts).toContainEqual({ role: 'user', text: 'Ouvre les intégrations', final: false });
  });

  it('keeps trainer voice capture passive and ignores assistant tools and output', async () => {
    const session = new VoiceSession({ trainingMode: true });
    const { socket } = await startConnectedSession(session);
    const transcripts = [];
    window.addEventListener('limova-voice-transcript', event => transcripts.push(event.detail));
    vi.useFakeTimers();

    session.handleServerMessage({
      toolCall: { functionCalls: [{ id: 'forbidden-training-action', name: 'request_page_action', args: { elementId: 1 } }] },
      serverContent: {
        inputTranscription: { text: 'Je montre comment connecter HubSpot.' },
        outputTranscription: { text: 'Je vais cliquer à votre place.' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
        turnComplete: true
      }
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'GET_LIVE_TOKEN',
      context: { trainingMode: true }
    });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'VOICE_ACTION_REQUEST' }));
    expect(transcripts).toContainEqual({ role: 'user', text: 'Je montre comment connecter HubSpot.', final: false });
    expect(transcripts).toContainEqual({ role: 'user', text: '', final: true });
    expect(transcripts.some(transcript => transcript.role === 'assistant')).toBe(false);
    expect(socket.sent.some(message => message.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('[RELANCE TECHNIQUE'))).toBe(false);
    expect(audioContexts).toHaveLength(1);
  });

  it('asks Gemini to recover when recognized speech completes without any assistant output', async () => {
    const { session, socket } = await startConnectedSession();
    vi.useFakeTimers();

    session.handleServerMessage({
      serverContent: {
        inputTranscription: { text: 'Envoie le message' },
        turnComplete: true
      }
    });
    await vi.advanceTimersByTimeAsync(3_500);

    expect(socket.sent.at(-1).clientContent).toMatchObject({
      turnComplete: true,
      turns: [{ role: 'user' }]
    });
    expect(socket.sent.at(-1).clientContent.turns[0].parts[0].text).toContain('[RELANCE TECHNIQUE');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_REPLY_RECOVERY_SENT',
      data: { attempt: 1, delayMs: 3500 }
    }));
  });

  it('does not let a completed tool from the previous turn suppress a newer voice reply', async () => {
    const { session, socket } = await startConnectedSession();
    vi.useFakeTimers();
    session.lastToolActivityAt = Date.now() - 100;

    session.handleServerMessage({
      serverContent: {
        inputTranscription: { text: 'Envoie le message' },
        turnComplete: true
      }
    });
    await vi.advanceTimersByTimeAsync(3_500);

    expect(socket.sent.some(message =>
      message.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('[RELANCE TECHNIQUE')
    )).toBe(true);
  });

  it('retries twice then shows a visible localized fallback when Live stays silent', async () => {
    document.documentElement.lang = 'fr';
    const { session, socket } = await startConnectedSession();
    const transcripts = [];
    window.addEventListener('limova-voice-transcript', event => transcripts.push(event.detail));
    vi.useFakeTimers();

    session.handleServerMessage({
      serverContent: {
        inputTranscription: { text: 'Ouvre les intégrations' },
        turnComplete: true
      }
    });
    await vi.advanceTimersByTimeAsync(3_500 + 5_000 + 3_500);

    const recoveries = socket.sent.filter(message =>
      message.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('[RELANCE TECHNIQUE')
    );
    expect(recoveries).toHaveLength(2);
    expect(transcripts).toContainEqual(expect.objectContaining({
      role: 'assistant',
      text: expect.stringContaining('réponse vocale n’est pas arrivée'),
      final: false
    }));
    expect(transcripts).toContainEqual({ role: 'assistant', text: '', final: true });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_REPLY_FALLBACK_SHOWN',
      data: { recoveryAttempts: 2, delayMs: 3500 }
    }));
  });

  it('keeps the latest resumption handle and reconnects after GoAway', async () => {
    const { session, socket: firstSocket } = await startConnectedSession();
    session.handleServerMessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'resume-42' } });
    session.handleServerMessage({ goAway: { timeLeft: '1s' } });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumedSocket = FakeWebSocket.instances[1];
    resumedSocket.open();
    expect(resumedSocket.sent[0].setup.sessionResumption).toEqual({ handle: 'resume-42' });
    resumedSocket.receive({ setupComplete: {} });
    await vi.waitFor(() => expect(session.ready).toBe(true));
    expect(firstSocket.closeArgs.reason).toBe('session-resumption');
  });

  it('attempts one automatic recovery after an abnormal socket close without releasing the microphone', async () => {
    const { session, socket } = await startConnectedSession();
    vi.useFakeTimers();

    socket.emit('close', { code: 1006, wasClean: false, reason: '' });
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(mediaTrack.stop).not.toHaveBeenCalled();
    const recovered = FakeWebSocket.instances[1];
    recovered.open();
    recovered.receive({ setupComplete: {} });
    await Promise.resolve();
    expect(session.ready).toBe(true);
  });

  it('routes only the packaged voice action and returns a tool response', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, status: 'executed' });
    await session.handleToolCalls([
      { id: 'call-1', name: 'click_element', args: { elementId: 7, contextVersion: 1 } },
      { id: 'call-2', name: 'remote_eval', args: { code: 'alert(1)' } }
    ]);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'VOICE_ACTION_REQUEST',
      toolName: 'click_element',
      elementId: 7,
      contextVersion: 1,
      explicitRequest: false,
      targetLabel: ''
    });
    expect(socket.sent[0].toolResponse.functionResponses).toEqual([
      { id: 'call-1', name: 'click_element', response: { status: 'ok', contextVersion: 1 } },
      { id: 'call-2', name: 'remote_eval', response: { status: 'blocked', contextVersion: 0, reason: 'Fonction non autorisée.' } }
    ]);
  });

  it('does not inject a duplicate navigation turn while a tool already returns the fresh DOM', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    session.ready = true;
    let releaseInspection;
    chromeMock.runtime.sendMessage.mockImplementation(request => {
      if (request?.type === 'VOICE_CONTEXT_REQUEST') {
        return new Promise(resolve => { releaseInspection = resolve; });
      }
      return Promise.resolve({ ok: true });
    });

    const toolRun = session.handleToolCalls([{ id: 'inspect-pending', name: 'inspect_current_page', args: {} }]);
    await vi.waitFor(() => expect(releaseInspection).toBeTypeOf('function'));
    expect(session.updatePageContext('Page: Intégrations', 2, 'navigation')).toBe(false);
    expect(socket.sent.some(message => message.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('MISE À JOUR TECHNIQUE'))).toBe(false);

    releaseInspection({ ok: true, pageContext: 'Page: Intégrations', contextVersion: 2, elementCount: 4 });
    await toolRun;

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].toolResponse.functionResponses[0]).toMatchObject({
      id: 'inspect-pending',
      response: { status: 'ok', contextVersion: 2 }
    });
  });

  it('defers voice recovery prompts while a page tool is still running', async () => {
    const { session, socket } = await startConnectedSession();
    vi.useFakeTimers();
    session.toolCallsInFlight = 1;

    session.handleServerMessage({
      serverContent: {
        inputTranscription: { text: 'Recherche Gmail' },
        turnComplete: true
      }
    });
    await vi.advanceTimersByTimeAsync(3_500);

    expect(socket.sent.some(message => message.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes('[RELANCE TECHNIQUE'))).toBe(false);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_REPLY_RECOVERY_DEFERRED'
    }));
  });

  it('routes the scroll tool and returns the refreshed page context', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request?.type === 'VOICE_SCROLL_REQUEST') return { ok: true, moved: true };
      if (request?.type === 'VOICE_CONTEXT_REQUEST') return {
        ok: true, pageContext: 'Page: Campagnes\n[main]\n  [4] clickable(button) "Suivant"', contextVersion: 9, elementCount: 4
      };
      return { ok: true };
    });

    await session.handleToolCalls([{
      id: 'scroll-1', name: 'scroll_page',
      args: { direction: 'down', amount: 'medium', contextVersion: 8 }
    }]);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'VOICE_SCROLL_REQUEST', direction: 'down', amount: 'medium', contextVersion: 8
    });
    expect(socket.sent[0].toolResponse.functionResponses[0]).toMatchObject({
      id: 'scroll-1', name: 'scroll_page',
      response: { status: 'ok', contextVersion: 9, elementCount: 4 }
    });
  });

  it('lets Gemini refresh the private DOM map through the packaged inspection tool', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request?.type === 'VOICE_CONTEXT_REQUEST') {
        return {
          ok: true,
          pageContext: 'Page: Tableau de bord\n[main]\n  [2] clickable(a) "Ouvrir mon profil"',
          contextVersion: 4,
          elementCount: 2
        };
      }
      return { ok: true };
    });

    await session.handleToolCalls([
      { id: 'inspect-1', name: 'inspect_current_page', args: {} }
    ]);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'VOICE_CONTEXT_REQUEST',
      toolName: 'inspect_current_page'
    });
    expect(socket.sent[0].toolResponse.functionResponses).toEqual([{
      id: 'inspect-1',
      name: 'inspect_current_page',
      response: {
        status: 'ok',
        pageContext: 'Page: Tableau de bord\n[main]\n  [2] clickable(a) "Ouvrir mon profil"',
        contextVersion: 4,
        elementCount: 2
      }
    }]);
  });

  it('lets Charly search product documentation without putting the query in diagnostics', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'VOICE_KB_SEARCH'
      ? { ok: true, knowledge: '# Connecter Gmail\nOuvrez le catalogue des intégrations.' }
      : { ok: true });

    await session.handleToolCalls([{
      id: 'kb-1',
      name: 'search_knowledge_base',
      args: { query: 'Comment connecter Gmail ?' }
    }]);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'VOICE_KB_SEARCH',
      query: 'Comment connecter Gmail ?'
    });
    expect(socket.sent[0].toolResponse.functionResponses[0]).toEqual({
      id: 'kb-1',
      name: 'search_knowledge_base',
      response: {
        status: 'ok',
        contextVersion: 0,
        knowledgeBase: '# Connecter Gmail\nOuvrez le catalogue des intégrations.'
      }
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_KB_SEARCH_SUCCEEDED',
      data: { queryLength: 25, resultCharacters: 55 }
    }));
  });

  it('types dictated text into the selected field and returns the refreshed DOM without echoing values in diagnostics', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request?.type === 'VOICE_TEXT_INPUT_REQUEST') return { ok: true };
      if (request?.type === 'VOICE_CONTEXT_REQUEST') {
        return {
          ok: true,
          pageContext: '[main]\n  [5] input(textarea) "Instructions" = [filled]',
          contextVersion: 6,
          elementCount: 5
        };
      }
      return { ok: true };
    });

    await session.handleToolCalls([{
      id: 'type-1',
      name: 'fill_field',
      args: { elementId: 5, contextVersion: 6, text: 'Prépare un résumé concis' }
    }]);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'VOICE_TEXT_INPUT_REQUEST',
      elementId: 5,
      contextVersion: 6,
      targetLabel: '',
      text: 'Prépare un résumé concis'
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'DIAGNOSTIC_EVENT',
      code: 'VOICE_TEXT_INPUT_SUCCEEDED',
      data: expect.objectContaining({ elementId: 5, characterCount: 24, clarificationRequired: false, failureCode: null })
    }));
    expect(socket.sent[0].toolResponse.functionResponses[0]).toEqual({
      id: 'type-1',
      name: 'fill_field',
      response: {
        status: 'ok',
        pageContext: '[main]\n  [5] input(textarea) "Instructions" = [filled]',
        contextVersion: 6,
        elementCount: 5
      }
    });
  });

  it('reports a dispatched click as unexpected until its effect is verified', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'VOICE_ACTION_REQUEST'
      ? {
          ok: true,
          status: 'unexpected',
          verificationRequired: true,
          error: 'Le clic a été déclenché, mais son effet reste à vérifier.',
          pageContext: '[main]\n  [7] clickable(button) "Continuer"',
          contextVersion: 8,
          elementCount: 7
        }
      : { ok: true });

    await session.handleToolCalls([{
      id: 'click-unverified',
      name: 'click_element',
      args: { elementId: 7, contextVersion: 8, targetLabel: 'Continuer', explicitRequest: true }
    }]);

    expect(socket.sent[0].toolResponse.functionResponses[0].response).toMatchObject({
      status: 'unexpected',
      verificationRequired: true,
      contextVersion: 8
    });
  });

  it('instructs Gemini to clarify an ambiguous text-field request', async () => {
    const session = new VoiceSession();
    const socket = new FakeWebSocket('wss://test');
    socket.readyState = FakeWebSocket.OPEN;
    session.socket = socket;
    chromeMock.runtime.sendMessage.mockImplementation(async request => request?.type === 'VOICE_TEXT_INPUT_REQUEST'
      ? { ok: false, clarificationRequired: true, error: 'Plusieurs champs correspondent à cette demande.' }
      : { ok: true });

    await session.handleToolCalls([{
      id: 'type-ambiguous',
      name: 'fill_field',
      args: { elementId: 5, contextVersion: 6, text: 'Texte' }
    }]);

    expect(socket.sent[0].toolResponse.functionResponses[0].response).toEqual({
      status: 'ambiguous',
      contextVersion: 6,
      reason: 'Plusieurs champs correspondent à cette demande.',
      clarificationRequired: true
    });
  });

  it('stops the microphone and signals audioStreamEnd on explicit stop', async () => {
    const { session, socket } = await startConnectedSession();
    session.stop();
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(socket.closeArgs).toEqual({ code: 1000, reason: 'user-stop' });
  });
});
