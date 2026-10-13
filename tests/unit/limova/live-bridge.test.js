import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachLimovaLiveBridge, LIVE_PORT } from '../../../src/limova/live-bridge.js';
import { LIMOVA_API_URL } from '../../../src/limova/environment.js';

const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const start = { kind: 'start', userId, workspaceId, conversationId, languageCode: 'fr', userTimezone: 'Europe/Paris' };
const ready = { sessionId, userId, workspaceId, conversationId, clientSurface: 'chrome_extension', inputSampleRate: 16_000, outputSampleRate: 24_000, maxAudioFrameBytes: 2_560 };
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value)) }; };

function fixture(sender = 'own-extension') {
  vi.useFakeTimers();
  const runtime = { id: 'own-extension', onConnect: event() };
  const callbacks = new Map();
  const socket = {
    connected: true, sendBuffer: [], io: { engine: { writeBuffer: [] } },
    on: (name, callback) => callbacks.set(name, callback),
    emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn(),
  };
  const io = vi.fn(() => socket);
  const port = { name: LIVE_PORT, sender: { id: sender }, onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
  attachLimovaLiveBridge(runtime, io);
  runtime.onConnect.fire(port);
  const server = (name, value) => callbacks.get(name)?.(value);
  const open = () => { port.onMessage.fire(start); server('connect'); server('session.ready', ready); port.onMessage.fire({ kind: 'ack', sequence: 1 }); };
  return { port, socket, io, server, open };
}
afterEach(() => vi.useRealTimers());

describe('first-party live bridge', () => {
  it('only uses the configured Limova namespace, cookies and workspace auth', () => {
    const f = fixture(); f.open();
    expect(f.io).toHaveBeenCalledWith(`${LIMOVA_API_URL}/conversation/live`, expect.objectContaining({
      withCredentials: true, auth: { workspaceId }, transports: ['websocket'], reconnection: false, forceNew: true,
    }));
    expect(f.socket.emit).toHaveBeenCalledWith('session.start', { conversationId, languageCode: 'fr', userTimezone: 'Europe/Paris', clientSurface: 'chrome_extension', expectedUserId: userId });
    f.port.onMessage.fire({ kind: 'audio', sequence: 0, bytes: [0, 1] });
    expect(f.socket.emit).toHaveBeenCalledWith('audio.append', { sequence: 0, audio: new Uint8Array([0, 1]) });
    f.port.onMessage.fire({ kind: 'cancel', playedAudioMs: 123 });
    expect(f.socket.emit).toHaveBeenCalledWith('response.cancel', { playedAudioMs: 123 });
    f.port.onDisconnect.fire();
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(f.socket.emit).toHaveBeenLastCalledWith('session.stop');
  });

  it('ignores foreign extension ports', () => {
    const f = fixture('other-extension'); f.port.onMessage.fire(start);
    expect(f.io).not.toHaveBeenCalled();
  });

  it.each([
    { userId: workspaceId }, { workspaceId: userId }, { conversationId: userId },
    { clientSurface: undefined }, { inputSampleRate: 0 }, { maxAudioFrameBytes: 9_999 },
  ])('requires an extension-capable server bound to the expected identity: %j', mismatch => {
    const f = fixture(); f.port.onMessage.fire(start); f.server('session.ready', { ...ready, ...mismatch });
    expect(f.port.postMessage).toHaveBeenCalledWith({ kind: 'error', code: 'LIMOVA_LIVE_TRANSPORT_CLOSED' });
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'audio', sequence: 1, bytes: [0, 1] },
    { kind: 'audio', sequence: 0, bytes: [0] },
    { kind: 'audio', sequence: 0, bytes: [256, 0] },
    { kind: 'audio', sequence: 0, bytes: Array(2_562).fill(0) },
    { kind: 'cancel', playedAudioMs: -1 }, { kind: 'arbitrary', url: 'https://example.test' },
  ])('closes on invalid commands: %j', command => {
    const f = fixture(); f.open(); f.port.onMessage.fire(command);
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(f.socket.emit).not.toHaveBeenCalledWith('audio.append', expect.anything());
  });

  it('delivers binary output one frame at a time and times out a stalled consumer', () => {
    const f = fixture(); f.open();
    f.server('assistant.audio.delta', { sessionId, sequence: 0, audio: new Uint8Array([1, 2]) });
    f.server('assistant.audio.delta', { sessionId, sequence: 1, audio: new Uint8Array([3, 4]) });
    expect(f.port.postMessage).toHaveBeenLastCalledWith({ kind: 'event', sequence: 2, event: 'assistant.audio.delta', payload: { sessionId, sequence: 0, audio: [1, 2] } });
    f.port.onMessage.fire({ kind: 'ack', sequence: 2 });
    expect(f.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 3 }));
    vi.advanceTimersByTime(5_001);
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds output and transport buffers instead of replaying delayed audio', () => {
    const f = fixture(); f.open(); f.socket.io.engine.writeBuffer = Array(9).fill({});
    f.port.onMessage.fire({ kind: 'audio', sequence: 0, bytes: [0, 1] });
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
    const g = fixture(); g.open();
    Array.from({ length: 35 }).forEach(() => g.server('assistant.status', { sessionId, status: 'thinking' }));
    expect(g.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('never reconnects or accepts audio after a socket disconnect', () => {
    const f = fixture(); f.open(); f.socket.connected = false; f.server('disconnect');
    f.port.onMessage.fire({ kind: 'audio', sequence: 0, bytes: [0, 1] });
    vi.advanceTimersByTime(60_000);
    expect(f.io).toHaveBeenCalledTimes(1);
    expect(f.socket.emit).not.toHaveBeenCalledWith('audio.append', expect.anything());
  });

  it('refuses a second connection event instead of starting another session', () => {
    const f = fixture(); f.open(); f.server('connect');
    expect(f.socket.emit.mock.calls.filter(([name]) => name === 'session.start')).toHaveLength(1);
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes after the consumer acknowledges the terminal event', () => {
    const f = fixture(); f.open(); f.server('session.ended', { sessionId, reason: 'client_stopped' });
    expect(f.socket.disconnect).not.toHaveBeenCalled();
    f.port.onMessage.fire({ kind: 'ack', sequence: 2 });
    expect(f.socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
