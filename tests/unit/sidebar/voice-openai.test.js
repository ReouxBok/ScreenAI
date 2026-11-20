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
  it.each(['Oui, tu peux enregistrer', 'Oui vas-y enregistre-le', 'C’est bon tu peux le faire', 'Je confirme', 'Tu peux enregistrer le rendez-vous maintenant'])('accepts natural spoken approval once: %s', text => {
    utterance('Crée un rendez-vous', 0);
    const revision = session.taskRevision;
    session.requestApproval({ actionId: 'save', label: 'Enregistrer' });
    utterance(text, 500);
    session.flushTranscript('user', false); session.flushTranscript('user');
    expect(session.taskRevision).toBe(revision);
    expect(chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'CONFIRM_ACTION')).toEqual([[{ type: 'CONFIRM_ACTION', actionId: 'save' }]]);
  });

  it('keeps the approval pending through ambiguous speech, a delegation and duplicate card delivery', () => {
    utterance('Crée un rendez-vous');
    const revision = session.taskRevision;
    const action = { actionId: 'save', label: 'Enregistrer' };
    session.requestApproval(action);
    utterance('Pourquoi tu me demandes de cliquer ?', 500);
    session.flushTranscript('user', false);
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'clarification' } });
    session.requestApproval(action);
    expect(session.pendingApproval).toBe(action);
    expect(session.taskRevision).toBe(revision);
    expect(chrome.runtime.sendMessage.mock.calls.some(([request]) => ['CONFIRM_ACTION', 'CANCEL_ACTION'].includes(request.type))).toBe(false);
    utterance('Oui, tu peux enregistrer', 5000); session.flushTranscript('user', false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'CONFIRM_ACTION', actionId: 'save' });
  });

  it('does not cancel or approve an incomplete yes-but before hearing the actual correction', () => {
    session.requestApproval({ actionId: 'save', label: 'Enregistrer' });
    utterance('Oui mais', 500);
    session.flushTranscript('user', false);
    expect(session.pendingApproval?.actionId).toBe('save');
    expect(chrome.runtime.sendMessage.mock.calls.some(([request]) => request.type === 'CONFIRM_ACTION')).toBe(false);
    utterance(' change la date', 600); session.flushTranscript('user', false);
    expect(session.pendingApproval).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'VOICE_TASK_UPDATE' }));
  });

  it('does not use assent from before the approval card as authorization', () => {
    utterance('Oui');
    session.requestApproval({ actionId: 'save', label: 'Enregistrer' });
    session.flushTranscript('user', false);
    expect(chrome.runtime.sendMessage.mock.calls.some(([request]) => request.type === 'CONFIRM_ACTION')).toBe(false);
  });

  it('retains the requested goal across a short clarification answer', () => {
    utterance('Crée un rendez-vous sport demain');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'initial' } });
    utterance('de quinze heures à seize heures', 5000);
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'clarified' } });
    expect(session.task.instruction).toBe('Crée un rendez-vous sport demain de quinze heures à seize heures');
  });

  it('fills a known form as one tool result, with fresh validation between fields', async () => {
    chrome.runtime.sendMessage.mockImplementation(async request => request.type === 'VOICE_TEXT_INPUT_REQUEST' ? { ok: true }
      : request.type === 'VOICE_CONTEXT_REQUEST' ? { ok: true, pageContext: 'Current form', contextVersion: 2 } : { ok: true });
    await session.handleToolCalls([{ id: 'form', name: 'fill_fields', args: { contextVersion: 1,
      fields: [{ elementId: 1, targetLabel: 'Titre', text: 'Sport' }, { elementId: 2, targetLabel: 'Début', text: '15:00' }] } }]);
    const writes = chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'VOICE_TEXT_INPUT_REQUEST');
    expect(writes.map(([request]) => request.elementId)).toEqual([1, 2]);
    const results = sent.filter(event => event.item?.call_id === 'form');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].item.output)).toMatchObject({ status: 'ok', completedFields: 2, fieldResults: [{ elementId: 1, ok: true }, { elementId: 2, ok: true }] });
    expect(chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'VOICE_CONTEXT_REQUEST' && request.capture)).toHaveLength(1);
  });

  it('stops a batch on a rejected field without writing the remaining fields', async () => {
    chrome.runtime.sendMessage.mockImplementation(async request => request.type === 'VOICE_TEXT_INPUT_REQUEST'
      ? request.elementId === 2 ? { ok: false, error: 'Champ sensible', failureCode: 'sensitive_field' } : { ok: true }
      : { ok: true, pageContext: 'Current form', contextVersion: 2 });
    await session.handleToolCalls([{ id: 'partial', name: 'fill_fields', args: { contextVersion: 1,
      fields: [1, 2, 3].map(elementId => ({ elementId, targetLabel: 'Champ', text: 'Value' })) } }]);
    expect(chrome.runtime.sendMessage.mock.calls.filter(([request]) => request.type === 'VOICE_TEXT_INPUT_REQUEST').map(([request]) => request.elementId)).toEqual([1, 2]);
    expect(JSON.parse(sent.find(event => event.item?.call_id === 'partial').item.output)).toMatchObject({ status: 'blocked', completedFields: 1 });
  });

  it.each([3000, 15000])('keeps the task and completed steps when the sentence resumes after %i ms', async pause => {
    utterance('Ouvre mon agenda');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    const revision = session.taskRevision;
    session.onToolResult({ name: 'open_page' }, { status: 'ok', contextVersion: 6 });
    utterance(' puis affiche demain', pause);
    session.handleToolCalls = vi.fn();
    call('next-step'); await session.toolQueue;
    expect(session.taskRevision).toBe(revision);
    expect(session.task.instruction).toContain('Ouvre mon agenda');
    expect(session.task.instruction).toContain('puis affiche demain');
    expect(session.task.steps).toEqual([{ tool: 'open_page', status: 'ok', contextVersion: 6 }]);
    expect(session.handleToolCalls).toHaveBeenCalledOnce();
    expect(sent.some(event => event.item?.call_id === 'next-step')).toBe(false);
  });

  it('supersedes previous work when Live delegates the new request, without guessing from a pause', async () => {
    utterance('Ouvre mon agenda');
    session.handleLiveEvent({ type: 'session.delegation.created', offset_ms: 100, delegation: { id: 'delegation-old' } });
    const revision = session.taskRevision;
    utterance('Ouvre plutôt ma messagerie', 5000);
    expect(session.taskRevision).toBe(revision);
    session.handleLiveEvent({ type: 'session.delegation.created', offset_ms: 5100, delegation: { id: 'delegation-new' } });
    expect(session.taskRevision).toBeGreaterThan(revision);
    session.handleToolCalls = vi.fn();
    call('old-request'); await session.toolQueue;
    expect(session.handleToolCalls).not.toHaveBeenCalled();
    session.handleLiveEvent({ type: 'response.event', delegation_id: 'delegation-new', event: {
      type: 'response.output_item.done', item: { type: 'function_call', call_id: 'new-request', name: 'inspect_current_page', arguments: '{}' }
    } });
    await session.toolQueue;
    expect(session.handleToolCalls).toHaveBeenCalledOnce();
    expect(session.task.instruction).toBe('Ouvre plutôt ma messagerie');
  });

  it('does not bind a late delegation for old audio to the corrected request', async () => {
    utterance('Ouvre mon agenda');
    utterance(', non, ouvre ma messagerie', 500);
    session.handleLiveEvent({ type: 'session.delegation.created', offset_ms: 100, delegation: { id: 'delegation-old' } });
    session.handleToolCalls = vi.fn();
    call('late-delegation'); await session.toolQueue;
    expect(session.handleToolCalls).not.toHaveBeenCalled();
    expect(JSON.parse(sent.find(event => event.item?.call_id === 'late-delegation').item.output).status).toBe('cancelled');
  });

  it('preserves the complete goal and completed steps when Live delegates its continuation', async () => {
    utterance('Ouvre mon agenda');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    session.onToolResult({ name: 'open_page' }, { status: 'ok' });
    utterance('puis affiche celui d’Anthony', 5000);
    session.handleLiveEvent({ type: 'session.delegation.created', offset_ms: 5100, delegation: { id: 'delegation-next' } });
    expect(session.task.instruction).toBe('Ouvre mon agenda puis affiche celui d’Anthony');
    expect(session.task.steps).toHaveLength(1);
    expect(session.delegations.get('delegation-old').revision).not.toBe(session.taskRevision);
    expect(session.delegations.get('delegation-next').revision).toBe(session.taskRevision);
  });

  it('accepts the first delegated task when delegation metadata precedes its transcript', async () => {
    session.handleLiveEvent({ type: 'session.delegation.created', offset_ms: 0, delegation: { id: 'delegation-old' } });
    utterance('Ouvre mon agenda');
    session.handleToolCalls = vi.fn(); call('first-request'); await session.toolQueue;
    expect(session.handleToolCalls).toHaveBeenCalledOnce();
  });

  it('does not revive an old task when delegation metadata is delivered twice', async () => {
    utterance('Ouvre mon agenda');
    const delegation = { type: 'session.delegation.created', delegation: { id: 'delegation-old' } };
    session.handleLiveEvent(delegation);
    utterance('Stop', 5000);
    session.handleLiveEvent(delegation);
    session.handleToolCalls = vi.fn(); call('duplicate-delegation'); await session.toolQueue;
    expect(session.handleToolCalls).not.toHaveBeenCalled();
  });

  it('returns only the completed action result when a correction arrives while its image is being sent', async () => {
    utterance('Ouvre mon agenda');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    session.sendVisualContext = vi.fn(async () => utterance('Non, arrête', 5000));
    session.handleToolCalls = vi.fn(async calls => {
      await session.socket.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: calls[0].id, response: { status: 'ok' } }] } }));
    });
    call('already-opened', 'open_page'); await session.toolQueue;
    const results = sent.filter(event => event.item?.call_id === 'already-opened');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].item.output).status).toBe('ok');
    expect(sent.filter(event => event.type === 'response.create')).toHaveLength(1);
  });

  it('submits one cancellation for an obsolete call, including repeated output attempts', async () => {
    utterance('Ouvre mon agenda');
    session.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'delegation-old' } });
    utterance('Stop', 5000);
    session.handleToolCalls = vi.fn(); call('cancel-once'); await session.toolQueue;
    await session.sendLegacy(JSON.stringify({ toolResponse: { functionResponses: [{ id: 'cancel-once', response: { status: 'cancelled' } }] } }));
    expect(sent.filter(event => event.item?.call_id === 'cancel-once')).toHaveLength(1);
    expect(sent.filter(event => event.type === 'response.create')).toHaveLength(1);
  });

  it('keeps audio active after a rejected command and logs technical metadata without the private message', () => {
    session.ready = true;
    session.sendEvent({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'result', output: 'private page' } });
    const client_event_id = sent[0].event_id;
    const fail = vi.spyOn(session, 'fail');
    session.handleLiveEvent({ type: 'error', error: { type: 'invalid_request_error', code: 'duplicate_output', client_event_id, message: 'private conversation and page data' } });
    expect(fail).not.toHaveBeenCalled();
    expect(session.ready).toBe(true);
    const diagnostic = chrome.runtime.sendMessage.mock.calls.find(([request]) => request.code === 'VOICE_COMMAND_ERROR')[0];
    expect(diagnostic.data).toMatchObject({ upstreamCode: 'duplicate_output', upstreamType: 'invalid_request_error', command: 'response.item.create', itemType: 'function_call_output' });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(JSON.stringify([...session.sentEvents.values()])).not.toContain('private');
  });

  it('still fails on a fatal session error and retains its technical cause', () => {
    session.stop = vi.fn();
    session.handleLiveEvent({ type: 'session.failed', error: { type: 'server_error', code: 'backend_unavailable', message: 'private message' } });
    expect(session.failed).toBe(true);
    expect(session.stop).toHaveBeenCalledWith(false, 'error');
    const diagnostic = chrome.runtime.sendMessage.mock.calls.find(([request]) => request.code === 'VOICE_SESSION_FAILED')[0];
    expect(diagnostic.data).toMatchObject({ upstreamCode: 'backend_unavailable', source: 'session' });
    expect(JSON.stringify(diagnostic)).not.toContain('private message');
  });

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
