import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrainingTranscriptionSession } from '../../../src/sidebar/training-transcription.js';
function fixture(overrides = {}) {
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  const audio = { stop: vi.fn() }, live = { stop: vi.fn(), sendAudio: vi.fn(), session: { inputSampleRate: 16000, maxAudioFrameBytes: 2560 } };
  const options = { parameters: {}, validate: vi.fn(async () => {}), requestMicrophone: vi.fn(async () => stream),
    openSession: vi.fn(async () => live), openAudio: vi.fn(async () => audio), saveNote: vi.fn(async () => {}), onState: vi.fn(), onStatus: vi.fn(), ...overrides };
  return { session: new TrainingTranscriptionSession(options), options, live, audio };
}
afterEach(() => vi.useRealTimers());
describe('training transcription', () => {
  it('treats partials as snapshots, records each final once and flushes the unfinished note on stop', async () => {
    const f = fixture(); await f.session.start(); const events = f.options.openSession.mock.calls[0][0].onEvent;
    await events('partial_transcript', { text: 'Bonjour' }); await events('partial_transcript', { text: 'Bonjour Charly' });
    await events('final_transcript', { text: 'Bonjour Charly.' });
    await events('partial_transcript', { text: 'Ensuite' }); await f.session.stop();
    expect(f.options.saveNote.mock.calls).toEqual([['Bonjour Charly.', false], ['Ensuite', true]]);
    await events('final_transcript', { text: 'Late' }); expect(f.options.saveNote).toHaveBeenCalledTimes(2);
    expect(f.audio.stop).toHaveBeenCalledOnce(); expect(f.live.stop).toHaveBeenCalledOnce();
  });
  it('does not request microphone permission after a cancelled context validation', async () => {
    let resolve; const f = fixture({ validate: () => new Promise(done => { resolve = done; }) });
    const start = f.session.start(); await f.session.stop(); resolve(); await start;
    expect(f.options.requestMicrophone).not.toHaveBeenCalled();
  });
  it('stops on revoked authorization without saving a partial', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    await f.options.openSession.mock.calls[0][0].onEvent('partial_transcript', { text: 'Private' });
    f.options.validate.mockRejectedValue(new Error('revoked')); await vi.advanceTimersByTimeAsync(5000);
    expect(f.session.active).toBe(false); expect(f.options.saveNote).not.toHaveBeenCalled();
  });
});
