// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

let session, sent;
beforeEach(() => {
  installChromeMock();
  chrome.runtime.sendMessage.mockResolvedValue({ ok: true });
  loadSidebarScript('src/sidebar/voice.js');
  loadSidebarScript('src/sidebar/voice-openai.js');
  session = new window.LimovaVoiceSession();
  session.operationId = 'gpt-live-test';
  sent = [];
  session.events = { readyState: 'open', send: raw => sent.push(JSON.parse(raw)) };
  session.socket = { readyState: WebSocket.OPEN, send: raw => session.sendLegacy(raw) };
});
afterEach(() => { session.flushTranscript(); uninstallChromeMock(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const utterance = (text, start_ms = 0) => session.handleLiveEvent({ type: 'session.input_transcript.delta', delta: text, start_ms, end_ms: start_ms + 100 });
const call = (id, name = 'click_element', args = {}) => session.handleLiveEvent({ type: 'response.event', delegation_id: 'delegation-old', event: {
  type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
} });

describe('GPT Live browser task contract', () => {
  it('cancels a queued old call instead of binding it to a correction', async () => {
    utterance('Clique agenda A');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    let release; session.toolQueue = new Promise(resolve => { release = resolve; });
    session.handleToolCalls = vi.fn();
    call('old-call');
    utterance('Non, arrête, je veux agenda B', 5000);
    release(); await session.toolQueue;
    expect(session.handleToolCalls).not.toHaveBeenCalled();
    expect(sent.find(event => event.item?.call_id === 'old-call').item.output).toContain('cancelled');
    expect(chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'VOICE_TRANSCRIPT')).toEqual([]);
  });

  it('does not revive an old delegation when its tool arrives after a correction', async () => {
    utterance('Clique agenda A');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    utterance('Non, agenda B', 5000);
    session.handleToolCalls = vi.fn(); call('late-call'); await session.toolQueue;
    expect(session.handleToolCalls).not.toHaveBeenCalled();
  });

  it('preserves scroll boundary evidence and stops recommending the same scroll', async () => {
    chrome.runtime.sendMessage.mockImplementation(async request => request.type === 'VOICE_SCROLL_REQUEST'
      ? { ok: true, moved: false, atEnd: true, contextVersion: 1 }
      : request.type === 'VOICE_CONTEXT_REQUEST' ? { ok: true, pageContext: 'Bottom', contextVersion: 2 } : {});
    await session.handleToolCalls([{ id: 'scroll', name: 'scroll_page', args: { direction: 'down' } }]);
    const output = JSON.parse(sent.find(event => event.item?.call_id === 'scroll').item.output);
    expect(output).toMatchObject({ moved: false, atEnd: true });
    expect(output.nextStep).toContain('Ne répète pas');
  });

  it('does not claim verification from a successful page read', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, pageContext: 'Unrelated page', contextVersion: 1 });
    await session.handleToolCalls([{ id: 'verify', name: 'verify_expected_result', args: { expectation: 'Impossible' } }]);
    const output = JSON.parse(sent.find(event => event.item?.call_id === 'verify').item.output);
    expect(output.status).toBe('unexpected');
  });

  it('queues full context for the tool backend without starting unsolicited work', async () => {
    const text = 'x'.repeat(15000) + 'TAIL';
    await session.sendLegacy(JSON.stringify({ clientContent: { turns: [{ parts: [{ text }] }] } }));
    expect(sent.find(event => event.type === 'response.item.create').item.content[0].text).toBe(text);
    expect(sent.some(event => event.type === 'response.create')).toBe(false);
  });

  it('preserves a stale context retry hint even without a returned page', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false, status: 'unexpected', error: 'Page changed', retryWithFreshContext: true });
    await session.handleToolCalls([{ id: 'stale', name: 'click_element', args: { elementId: 1 } }]);
    expect(JSON.parse(sent.find(event => event.item?.call_id === 'stale').item.output)).toMatchObject({ status: 'unexpected', retryWithFreshContext: true });
  });

  it('returns tool results and image context before continuing the backend', async () => {
    session.sendVisualContext = vi.fn(async () => sent.push({ type: 'image-sent' }));
    await session.sendLegacy(JSON.stringify({ toolResponse: { functionResponses: [{ id: 'call', response: { status: 'ok' } }] } }));
    expect(sent.map(event => event.type)).toEqual(['response.item.create', 'image-sent', 'response.create']);
  });

  it('decodes masked image bytes locally and sends a backend image item', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async blob => {
      expect(blob.type).toBe('image/jpeg');
      return { width: 800, height: 600, close: vi.fn() };
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA==');
    session.queueVisualCapture({ mimeType: 'image/jpeg', data: 'AA==' }, 1, 'qa');
    expect(await session.sendVisualContext()).toBe(true);
    expect(sent[0].item.content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AA==' });
  });
  it('splits a dense unicode page without losing its last target or exceeding WebRTC messages', async () => {
    const text = 'Élément 👋 '.repeat(18000) + 'TARGET_AT_THE_END';
    await session.sendLegacy(JSON.stringify({ clientContent: { turns: [{ parts: [{ text }] }] } }));
    const messages = sent.filter(event => event.type === 'response.item.create');
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.at(-1).item.content[0].text).toContain('TARGET_AT_THE_END');
    expect(messages.map(message => message.item.content[0].text.replace(/^\[Contexte technique[^\n]*\n/, '')).join('')).toBe(text);
    expect(sent.every(event => new TextEncoder().encode(JSON.stringify(event)).byteLength <= 48000)).toBe(true);
  });

  it('sends the full large tool map before its compact output and next backend step', async () => {
    const context = 'contrôle '.repeat(10000) + 'FINAL_CONTROL';
    await session.sendLegacy(JSON.stringify({ toolResponse: { functionResponses: [{ id: 'dense', name: 'inspect_current_page', response: { status: 'ok', contextVersion: 7, pageContext: context } }] } }));
    const outputIndex = sent.findIndex(event => event.item?.call_id === 'dense');
    expect(sent.slice(0, outputIndex).some(event => event.item?.content?.[0]?.text.includes('FINAL_CONTROL'))).toBe(true);
    expect(JSON.parse(sent[outputIndex].item.output).contextVersion).toBe(7);
    expect(sent.at(-1).type).toBe('response.create');
  });

  it('persists the complete utterance only when sealed, including deltas after an idle preview', () => {
    const events = []; const listener = event => events.push(event.detail);
    window.addEventListener('limova-gpt-transcript', listener);
    utterance('Ouvre mon agenda');
    session.flushTranscript('user', false);
    utterance(' puis cherche demain', 500);
    session.flushTranscript('user');
    expect(events.filter(event => event.final && event.persist)).toEqual([
      expect.objectContaining({ text: 'Ouvre mon agenda puis cherche demain', persist: true })
    ]);
    window.removeEventListener('limova-gpt-transcript', listener);
  });

  it('resumes the same voice task after a spoken approval without authorizing twice', () => {
    session.taskRevision = 4;
    session.pendingApproval = { actionId: 'approve-save', label: 'Enregistrer' };
    utterance('Oui, enregistre');
    session.flushTranscript('user', false);
    session.flushTranscript('user');
    expect(session.taskRevision).toBe(4);
    expect(chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'CONFIRM_ACTION')).toEqual([
      [{ type: 'CONFIRM_ACTION', actionId: 'approve-save' }]
    ]);
  });

  it('does not treat an interrupted yes as approval of the previous action', () => {
    session.pendingApproval = { actionId: 'old-save', label: 'Enregistrer' };
    utterance('Oui mais change la date');
    session.flushTranscript('user', false);
    expect(chrome.runtime.sendMessage.mock.calls.some(([request]) => request.type === 'CONFIRM_ACTION')).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'VOICE_TASK_UPDATE' }));
  });

  it('does not approve an unsealed yes when the user stops the session', () => {
    session.pendingApproval = { actionId: 'old-save', label: 'Enregistrer' };
    utterance('Oui');
    session.events.addEventListener = vi.fn(); session.events.close = vi.fn(); session.socket.close = vi.fn();
    session.stop();
    expect(chrome.runtime.sendMessage.mock.calls.some(([request]) => request.type === 'CONFIRM_ACTION')).toBe(false);
  });

});
