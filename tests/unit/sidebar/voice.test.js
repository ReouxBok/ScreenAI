// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

class FakeDataChannel {
  constructor() {
    this.readyState = 'connecting';
    this.sent = [];
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }
  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }
  open() {
    this.readyState = 'open';
    this.emit('open');
  }
  receive(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }
  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  static instances = [];
  constructor() {
    this.iceGatheringState = 'complete';
    this.channel = new FakeDataChannel();
    this.addTrack = vi.fn();
    this.close = vi.fn();
    this.setLocalDescription = vi.fn(async description => {
      this.localDescription = { ...description, sdp: 'v=0\r\na=offer\r\n' };
    });
    this.setRemoteDescription = vi.fn(async description => { this.remoteDescription = description; });
    this.createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0\r\na=offer\r\n' }));
    FakePeerConnection.instances.push(this);
  }
  createDataChannel(label) {
    this.label = label;
    return this.channel;
  }
  addEventListener() {}
  removeEventListener() {}
}

describe('OpenAI GPT Live WebRTC voice protocol', () => {
  let chromeMock;
  let VoiceSession;
  let mediaTrack;

  beforeEach(() => {
    FakePeerConnection.instances = [];
    globalThis.RTCPeerConnection = FakePeerConnection;
    window.RTCPeerConnection = FakePeerConnection;
    globalThis.MediaStream = class MediaStream {
      constructor(tracks) { this.tracks = tracks; }
    };
    mediaTrack = { stop: vi.fn() };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [mediaTrack],
          getAudioTracks: () => [mediaTrack]
        }))
      }
    });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'granted' })) }
    });
    chromeMock = installChromeMock();
    chromeMock.tabs = {
      create: vi.fn(async () => ({ id: 42 })),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() }
    };
    chromeMock.runtime.getURL = vi.fn(path => `chrome-extension://test/${path}`);
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request?.type === 'GET_LIVE_SESSION') {
        return { ok: true, sdp: 'v=0\r\na=answer\r\n', model: 'gpt-live-1', contextVersion: 7 };
      }
      if (request?.type === 'VOICE_CONTEXT_REQUEST') {
        return { ok: true, contextVersion: 8, pageContext: 'Page: Réglages', elementCount: 2 };
      }
      return { ok: true };
    });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    loadSidebarScript('src/sidebar/voice.js');
    VoiceSession = window.LimovaVoiceSession;
  });

  afterEach(() => {
    delete window.LimovaVoiceSession;
    delete globalThis.RTCPeerConnection;
    delete globalThis.MediaStream;
    delete navigator.permissions;
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  async function startConnected() {
    const session = new VoiceSession();
    const started = session.start();
    await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
    const peer = FakePeerConnection.instances[0];
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.channel.open();
    peer.channel.receive({ type: 'session.started', session: { id: 'live_test' } });
    await started;
    return { session, peer, channel: peer.channel };
  }

  it('negotiates GPT Live over WebRTC after microphone permission', async () => {
    const { peer } = await startConnected();
    expect(peer.label).toBe('oai-events');
    expect(peer.addTrack).toHaveBeenCalledWith(mediaTrack, expect.anything());
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'GET_LIVE_SESSION',
      context: { trainingMode: false, sdp: 'v=0\r\na=offer\r\n' }
    });
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\na=answer\r\n' });
  });

  it('pushes a newer DOM map as silent GPT Live context', async () => {
    const { session, channel } = await startConnected();
    expect(session.updatePageContext('Page: Intégrations', 9, 'navigation')).toBe(true);
    expect(channel.sent.at(-1)).toMatchObject({
      type: 'session.thinking.append',
      delegation_id: null
    });
    expect(channel.sent.at(-1).content).toContain('Version DOM: 9');
  });

  it('emits OpenAI input and output transcripts', async () => {
    const events = [];
    window.addEventListener('limova-voice-transcript', event => events.push(event.detail));
    const { channel } = await startConnected();
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Bonjour', start_ms: 0, end_ms: 300 });
    channel.receive({ type: 'session.output_transcript.delta', delta: 'Comment puis-je aider ?', start_ms: 400, end_ms: 900 });
    expect(events).toEqual(expect.arrayContaining([
      { role: 'user', text: 'Bonjour', final: false },
      { role: 'assistant', text: 'Comment puis-je aider ?', final: false }
    ]));
  });

  it('executes one current DOM action and returns a verified tool output', async () => {
    const { channel } = await startConnected();
    chromeMock.runtime.sendMessage.mockImplementation(async request => {
      if (request.type === 'VOICE_ACTION_REQUEST') return { ok: true, contextVersion: 7 };
      if (request.type === 'VOICE_CONTEXT_REQUEST') return {
        ok: true, contextVersion: 8, pageContext: 'Page: Intégrations', elementCount: 3
      };
      return { ok: true };
    });
    channel.receive({
      type: 'response.event',
      delegation_id: 'delegation-1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call', call_id: 'call-1', name: 'click_element',
          arguments: JSON.stringify({ elementId: 4, contextVersion: 7, targetLabel: 'Intégrations', explicitRequest: true })
        }
      }
    });
    await vi.waitFor(() => expect(channel.sent.some(event => event.item?.type === 'function_call_output')).toBe(true));
    const outputEvent = channel.sent.find(event => event.item?.type === 'function_call_output');
    expect(JSON.parse(outputEvent.item.output)).toEqual(expect.objectContaining({
      status: 'ok',
      actionVerified: true,
      contextVersion: 8
    }));
    expect(channel.sent.at(-1)).toEqual({ type: 'response.create' });
  });

  it('deduplicates repeated completion events for the same tool call', async () => {
    const { channel } = await startConnected();
    const call = {
      type: 'response.event',
      delegation_id: 'delegation-duplicate',
      event: {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call-duplicate', name: 'inspect_current_page', arguments: '{}' }
      }
    };
    channel.receive(call);
    channel.receive(call);
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage.mock.calls
      .filter(([request]) => request.type === 'VOICE_CONTEXT_REQUEST')).toHaveLength(1));
  });

  it('keeps trainer mode free from assistant transcripts', async () => {
    const session = new VoiceSession({ trainingMode: true });
    const transcripts = [];
    window.addEventListener('limova-voice-transcript', event => transcripts.push(event.detail));
    session.handleServerMessage({ type: 'session.output_transcript.delta', delta: 'Ne pas afficher' });
    session.handleServerMessage({ type: 'session.input_transcript.delta', delta: 'Démonstration' });
    expect(transcripts).toEqual([{ role: 'user', text: 'Démonstration', final: false }]);
  });

  it('closes WebRTC and releases the microphone on stop', async () => {
    const { session, peer, channel } = await startConnected();
    session.stop();
    expect(channel.readyState).toBe('closed');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
  });
});
