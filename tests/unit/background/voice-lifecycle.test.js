import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

let background, chromeMock;
const consentKey = 'limova_ai_processing_consent_v1';
const page = () => ({ title: 'Synthetic page', url: 'https://new.limova.ai/home', viewport: '800x600', elements: [
  { id: 1, type: 'input', inputType: 'textarea', text: 'Instructions', zone: 'main' },
  { id: 2, type: 'clickable', text: 'Documents', hrefPath: '/documents', zone: 'main' }
] });
const sender = () => ({ id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('src/sidebar/sidebar.html') });
const message = request => background.handleMessage(request, sender());
const mutationCalls = () => chromeMock.tabs.sendMessage.mock.calls.filter(([, request]) =>
  ['EXECUTE_PAGE_SCROLL', 'TYPE_ELEMENT_TEXT', 'EXECUTE_ELEMENT_ACTION'].includes(request.type));

beforeEach(async () => {
  chromeMock = installFullChromeMock();
  await chromeMock.storage.local.set({ [consentKey]: true });
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.resetModules();
  background = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  chromeMock.scripting.executeScript.mockImplementation(async () => [{ result: page() }]);
  chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true, moved: true });
  background.lockTab(17);
  await background.getPageContext(17);
  await message({ type: 'VOICE_SESSION_STATE', active: true });
  chromeMock.tabs.sendMessage.mockClear();
});

afterEach(() => { vi.useRealTimers(); uninstallFullChromeMock(); delete globalThis.fetch; });

function suspendConsent() {
  let release;
  const normalGet = chromeMock.storage.local.get.getMockImplementation();
  chromeMock.storage.local.get.mockImplementation(key => key === consentKey && !release
    ? new Promise(resolve => { release = resolve; }) : normalGet(key));
  return { wait: () => vi.waitFor(() => expect(release).toBeTypeOf('function')), release: () => release({ [consentKey]: true }) };
}

async function stopOrReset(reset) {
  if (reset) {
    await background.handleResetSession();
    background.lockTab(29);
    await background.getPageContext(29);
    await message({ type: 'VOICE_SESSION_STATE', active: true });
  } else await message({ type: 'VOICE_SESSION_STATE', active: false });
}

describe('already dispatched voice commands', () => {
  it.each([
    ['scroll after stop', false, { type: 'VOICE_SCROLL_REQUEST', direction: 'down', contextVersion: 1 }],
    ['scroll after reset on another tab', true, { type: 'VOICE_SCROLL_REQUEST', direction: 'down', contextVersion: 1 }],
    ['dictation after reset on another tab', true, { type: 'VOICE_TEXT_INPUT_REQUEST', elementId: 1, text: 'OLD DICTATION', contextVersion: 1 }]
  ])('discards %s while consent is pending', async (_label, reset, request) => {
    const gate = suspendConsent();
    const pending = message(request);
    await gate.wait();
    await stopOrReset(reset);
    gate.release();
    await pending;
    expect(mutationCalls()).toEqual([]);
  });

  it('does not retry dictation after reset during a failed first attempt', async () => {
    let release;
    chromeMock.tabs.sendMessage.mockImplementation((_tabId, request) => request.type === 'TYPE_ELEMENT_TEXT' && !release
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true }));
    const pending = message({ type: 'VOICE_TEXT_INPUT_REQUEST', elementId: 1, text: 'OLD DICTATION', contextVersion: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(true);
    release({ ok: false, error: 'La carte DOM a changé.' });
    await pending;
    expect(mutationCalls()).toHaveLength(1);
    expect(mutationCalls()[0][0]).toBe(17);
  });

  it('discards an old page refresh after reset and preserves the new DOM map', async () => {
    let release;
    chromeMock.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = message({ type: 'VOICE_TEXT_INPUT_REQUEST', elementId: 1, text: 'OLD DICTATION', contextVersion: 999 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(true);
    const oldPage = page(); oldPage.elements[0].text = 'OLD FIELD'; oldPage.elements[0].sensitive = true;
    release([{ result: oldPage }]);
    await pending;
    expect(mutationCalls()).toEqual([]);
    const current = await background.typeVoiceText(1, 'NEW DICTATION');
    expect(current.ok).toBe(true);
    expect(mutationCalls()[0][0]).toBe(29);
  });

  it('keeps current-session dictation and scroll working without a reset', async () => {
    await message({ type: 'VOICE_TEXT_INPUT_REQUEST', elementId: 1, text: 'CURRENT DICTATION', contextVersion: 1 });
    await message({ type: 'VOICE_SCROLL_REQUEST', direction: 'down' });
    expect(mutationCalls().map(([tab, request]) => [tab, request.type])).toEqual([
      [17, 'TYPE_ELEMENT_TEXT'], [17, 'EXECUTE_PAGE_SCROLL']
    ]);
  });

  it('discards a click stopped while the target tab lookup is pending', async () => {
    await message({ type: 'VOICE_TRANSCRIPT', role: 'user', text: 'Clique sur Documents' });
    let release;
    chromeMock.tabs.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = message({ type: 'VOICE_ACTION_REQUEST', elementId: 2, contextVersion: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(false);
    release({ id: 17, url: 'https://new.limova.ai/home' });
    await pending;
    expect(mutationCalls()).toEqual([]);
  });

  it('does not retry a click after reset during its failed first attempt', async () => {
    await message({ type: 'VOICE_TRANSCRIPT', role: 'user', text: 'Clique sur Documents' });
    let release;
    chromeMock.tabs.sendMessage.mockImplementation((_tabId, request) => request.type === 'EXECUTE_ELEMENT_ACTION' && !release
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true }));
    const pending = message({ type: 'VOICE_ACTION_REQUEST', elementId: 2, contextVersion: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(true);
    release({ ok: false, error: 'La carte DOM a changé.' });
    await pending;
    expect(mutationCalls()).toHaveLength(1);
    expect(mutationCalls()[0][0]).toBe(17);
  });

  it('discards a scroll stopped during a stale-context refresh', async () => {
    let release;
    chromeMock.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = message({ type: 'VOICE_SCROLL_REQUEST', direction: 'down', contextVersion: 999 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(false);
    release([{ result: page() }]);
    await pending;
    expect(mutationCalls()).toEqual([]);
  });

  it('does not revive a context request after stop while consent is pending', async () => {
    const gate = suspendConsent();
    const pending = message({ type: 'VOICE_CONTEXT_REQUEST' });
    await gate.wait();
    await stopOrReset(false);
    chromeMock.scripting.executeScript.mockClear();
    gate.release();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('keeps an in-flight command valid during a same-session active notification', async () => {
    const gate = suspendConsent();
    const pending = message({ type: 'VOICE_SCROLL_REQUEST', direction: 'down' });
    await gate.wait();
    await message({ type: 'VOICE_SESSION_STATE', active: true });
    gate.release();
    expect((await pending).ok).toBe(true);
    expect(mutationCalls()).toHaveLength(1);
    expect(mutationCalls()[0][0]).toBe(17);
  });

  it('does not resume a repaired dictation after reset', async () => {
    let release;
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    chromeMock.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = message({ type: 'VOICE_TEXT_INPUT_REQUEST', elementId: 1, text: 'OLD DICTATION', contextVersion: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await stopOrReset(true);
    release([]);
    await pending;
    expect(mutationCalls()).toHaveLength(1);
    expect(mutationCalls()[0][0]).toBe(17);
  });
});
