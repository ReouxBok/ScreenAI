import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTranscriptionBridge, TRANSCRIPTION_PORT } from '../../../src/limova/transcription-bridge.js';
import { LIMOVA_API_URL } from '../../../src/limova/environment.js';
const USER = '11111111-1111-4111-8111-111111111111', WORKSPACE = '22222222-2222-4222-8222-222222222222', SESSION = '33333333-3333-4333-8333-333333333333';
const event = () => { const callbacks = []; return { addListener: fn => callbacks.push(fn), fire: value => callbacks.forEach(fn => fn(value)) }; };
function fixture() {
  vi.useFakeTimers();
  const callbacks = new Map();
  const socket = { connected: true, sendBuffer: [], io: { engine: { writeBuffer: [] } }, on: (event, fn) => callbacks.set(event, fn), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() };
  const io = vi.fn(() => socket), runtime = { id: 'extension', onConnect: event() };
  const port = { name: TRANSCRIPTION_PORT, sender: { id: 'extension' }, onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
  attachTranscriptionBridge(runtime, io); runtime.onConnect.fire(port);
  const server = (event, payload) => callbacks.get(event)?.(payload);
  const ready = { sessionId: SESSION, userId: USER, workspaceId: WORKSPACE, clientSurface: 'chrome_extension', inputSampleRate: 16000, maxAudioFrameBytes: 2560 };
  const start = () => { port.onMessage.fire({ kind: 'start', userId: USER, workspaceId: WORKSPACE, languageCode: 'fr' }); server('connect'); };
  const open = () => { start(); server('session_started', ready); port.onMessage.fire({ kind: 'ack', sequence: 1 }); };
  return { port, socket, io, server, ready, start, open };
}
afterEach(() => vi.useRealTimers());
describe('first-party transcription bridge', () => {
  it('uses the fixed namespace, confirms identity and binds sequenced PCM to its session', () => {
    const f = fixture(); f.open();
    expect(f.io).toHaveBeenCalledWith(`${LIMOVA_API_URL}/voice/transcribe`, expect.objectContaining({ withCredentials: true, reconnection: false, auth: { workspaceId: WORKSPACE } }));
    f.port.onMessage.fire({ kind: 'audio', sequence: 0, bytes: [0, 128, 255, 127] });
    expect(f.socket.emit).toHaveBeenCalledWith('audio_chunk', { sessionId: SESSION, sequence: 0, audio: 'AID/fw==' });
    f.server('final_transcript', { text: 'Une note' });
    expect(f.port.postMessage).toHaveBeenLastCalledWith({ kind: 'event', sequence: 2, event: 'final_transcript', payload: { text: 'Une note', sessionId: SESSION } });
    f.port.onMessage.fire({ kind: 'ack', sequence: 2 }); f.port.onDisconnect.fire();
    expect(f.socket.emit).toHaveBeenLastCalledWith('stop_session');
  });
  it.each([{ userId: WORKSPACE }, { workspaceId: USER }, { inputSampleRate: 24000 }])('rejects a mismatched ready response: %j', patch => {
    const f = fixture(); f.start(); f.server('session_started', { ...f.ready, ...patch });
    expect(f.socket.disconnect).toHaveBeenCalledOnce();
  });
  it('stops on missing consumer acknowledgement and never reconnects', () => {
    const f = fixture(); f.open(); f.server('partial_transcript', { text: 'Partiel' });
    vi.advanceTimersByTime(5001); expect(f.socket.disconnect).toHaveBeenCalledOnce();
    expect(f.socket.connect).toHaveBeenCalledOnce();
  });
  it.each([{ sequence: 1, bytes: [0, 0] }, { sequence: 0, bytes: [0] }, { sequence: 0, bytes: [0, 256] }])('rejects invalid audio: %j', frame => {
    const f = fixture(); f.open(); f.port.onMessage.fire({ kind: 'audio', ...frame });
    expect(f.socket.emit.mock.calls.some(([event]) => event === 'audio_chunk')).toBe(false);
    expect(f.socket.disconnect).toHaveBeenCalledOnce();
  });
});
