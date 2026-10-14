import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepAgentVoiceSession } from '../../../src/sidebar/deep-agent-voice.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const track = { stop: vi.fn() }, stream = { getTracks: () => [track] };
  const live = { session: {}, stop: vi.fn(), cancel: vi.fn(), sendAudio: vi.fn() };
  const audio = { stop: vi.fn(), play: vi.fn(), interrupt: vi.fn(() => 45) };
  const options = { requestMicrophone: vi.fn(async () => stream), openSession: vi.fn(async () => live),
    openAudio: vi.fn(async () => audio), parameters: { conversationId: 'existing' },
    onState: vi.fn(), onStatus: vi.fn(), onNativeEvent: vi.fn(), validate: vi.fn(async () => {}), ...overrides };
  return { session: new DeepAgentVoiceSession(options), options, live, audio, track, stream };
}
afterEach(() => vi.useRealTimers());

describe('native voice lifecycle', () => {
  it('reserves the session while permission is pending and stops a late microphone', async () => {
    const pending = deferred(); const f = fixture({ requestMicrophone: () => pending.promise });
    const started = f.session.start();
    expect(f.session.active).toBe(true); expect(f.options.onState).toHaveBeenCalledWith(true);
    f.session.stop(); pending.resolve(f.stream); await started;
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.options.openSession).not.toHaveBeenCalled();
    expect(f.options.onState).toHaveBeenLastCalledWith(false);
  });
  it('closes a transport that resolves after cancellation', async () => {
    const pending = deferred(); const f = fixture({ openSession: () => pending.promise });
    const started = f.session.start(); await Promise.resolve(); f.session.stop();
    pending.resolve(f.live); await started;
    expect(f.live.stop).toHaveBeenCalledOnce(); expect(f.options.openAudio).not.toHaveBeenCalled();
  });
  it('preserves queued audio and interruption order while audio starts', async () => {
    const pending = deferred(); const f = fixture({ openAudio: () => pending.promise });
    const started = f.session.start(); await vi.waitFor(() => expect(f.options.openSession).toHaveBeenCalledOnce());
    const callbacks = f.options.openSession.mock.calls[0][0];
    const frame = { sequence: 0, audio: [0, 1] };
    callbacks.onEvent('assistant.audio.delta', frame);
    callbacks.onEvent('turn.interrupted', {});
    callbacks.onEvent('assistant.audio.delta', { ...frame, sequence: 1 });
    pending.resolve(f.audio); await started;
    expect(f.audio.play.mock.calls.map(([value]) => value.sequence)).toEqual([0, 1]);
    expect(f.audio.play.mock.invocationCallOrder[0]).toBeLessThan(f.audio.interrupt.mock.invocationCallOrder[0]);
    expect(f.audio.interrupt.mock.invocationCallOrder[0]).toBeLessThan(f.audio.play.mock.invocationCallOrder[1]);
    f.session.cancel(); expect(f.live.cancel).toHaveBeenCalledWith(45);
    f.session.stop(); callbacks.onNativeEvent({ content: 'late' });
    expect(f.options.onNativeEvent).not.toHaveBeenCalled();
  });
  it('stops audio and transport when authorization is revoked', async () => {
    vi.useFakeTimers(); const f = fixture({ validate: vi.fn(async () => { throw new Error('revoked'); }) });
    await f.session.start(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.session.active).toBe(false); expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.live.stop).toHaveBeenCalledOnce();
    expect(f.options.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: 'revoked' }));
    await vi.advanceTimersByTimeAsync(10000); expect(f.options.validate).toHaveBeenCalledOnce();
  });
  it('releases the microphone when the transport fails to open', async () => {
    const f = fixture({ openSession: async () => { throw new Error('unauthorized'); } });
    await f.session.start(); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.session.active).toBe(false); expect(f.options.openAudio).not.toHaveBeenCalled();
  });
  it('waits only for a requested response, renews on progress, then stops without replay', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    const callbacks = f.options.openSession.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.session.active).toBe(true);
    callbacks.onEvent('input.transcript.final', { text: 'Ouvre mon profil' });
    await vi.advanceTimersByTimeAsync(89_000);
    callbacks.onEvent('turn.deep_agent_stream.delta', { chunk: [1] });
    await vi.advanceTimersByTimeAsync(89_000);
    expect(f.session.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.session.active).toBe(false);
    expect(f.options.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', errorKey: 'voiceResponseTimeout' }));
    expect(f.audio.stop).toHaveBeenCalledOnce(); expect(f.live.stop).toHaveBeenCalledOnce();
    expect(f.options.openSession).toHaveBeenCalledOnce(); expect(f.live.sendAudio).not.toHaveBeenCalled();
    callbacks.onEvent('assistant.audio.delta', { audio: [0, 1], sequence: 0 });
    expect(f.audio.play).not.toHaveBeenCalled();
  });

  it.each(['assistant.audio.delta', 'assistant.transcript.final', 'turn.interrupted', 'turn.deep_agent_stream.interrupted'])('clears the response wait on %s', async event => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    const callbacks = f.options.openSession.mock.calls[0][0];
    callbacks.onEvent('turn.deep_agent_stream.started', {});
    await vi.advanceTimersByTimeAsync(89_000);
    callbacks.onEvent(event, { audio: [0, 1], text: 'Terminé' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.session.active).toBe(true);
    expect(f.options.onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    f.session.stop();
  });

  it('surfaces a native turn failure and ignores late audio without displaying server internals', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    const callbacks = f.options.openSession.mock.calls[0][0];
    callbacks.onEvent('turn.deep_agent_stream.started', {});
    callbacks.onEvent('turn.deep_agent_stream.failed', { error: 'PRIVATE_BACKEND_DETAIL' });
    expect(f.session.active).toBe(false);
    expect(f.options.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', errorKey: 'voiceTurnFailed' }));
    expect(JSON.stringify(f.options.onStatus.mock.calls)).not.toContain('PRIVATE_BACKEND_DETAIL');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.audio.stop).toHaveBeenCalledOnce(); expect(f.live.stop).toHaveBeenCalledOnce();
  });

  it('still bounds the wait for speech after the canonical agent answer completes', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    const callbacks = f.options.openSession.mock.calls[0][0];
    callbacks.onEvent('turn.deep_agent_stream.started', {});
    await vi.advanceTimersByTimeAsync(89_000);
    callbacks.onEvent('turn.deep_agent_stream.completed', {});
    await vi.advanceTimersByTimeAsync(89_000);
    expect(f.session.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.session.active).toBe(false);
    expect(f.options.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ errorKey: 'voiceResponseTimeout' }));
  });

});
