// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimovaPanel } from '../../../src/limova/panel.js';

const state = { authenticated: true, user: { id: 'u' }, context: { userId: 'u', workspaceId: 'w' },
  workspaces: [{ id: 'w', name: 'Mon espace', enabled: true }], conversationId: 'c', activeTurnId: null };
const element = id => document.getElementById(id);

function setup(overrides = {}) {
  const request = vi.fn(async ({ type }) => {
    if (overrides[type]) return overrides[type]();
    if (type === 'LIMOVA_GET_STATE') return state;
    if (type === 'LIMOVA_LIST_CONVERSATIONS') return { data: [{ id: 'c', title: 'Mon chat' }] };
    if (type === 'LIMOVA_GET_MESSAGES') return { data: [{ id: 'h', role: 'user', content: 'Bonjour' }] };
    return { ok: true };
  });
  const render = vi.fn();
  const onBusy = vi.fn();
  const panel = createLimovaPanel({ document, request, render, onBusy });
  return { panel, request, render, onBusy };
}

beforeEach(() => {
  document.body.innerHTML = '<input id="limovaBrowser" type="checkbox">' + ['authPanel', 'limovaControls', 'authFeedback', 'limovaFeedback'].map(id => `<div id="${id}"></div>`).join('')
    + ['limovaWorkspace', 'limovaConversation'].map(id => `<select id="${id}"></select>`).join('')
    + ['limovaLogin', 'limovaRefresh', 'limovaRefreshSession', 'limovaNew', 'limovaCancel', 'limovaResume'].map(id => `<button id="${id}"></button>`).join('');
});

describe('Limova panel session and turn boundaries', () => {
  it('binds voice to the selected chat, locks selection and drops events after logout', async () => {
    const { panel, render } = setup({ LIMOVA_GET_STATE: () => state });
    await panel.refresh();
    const voice = await panel.prepareVoice();
    expect(voice).toMatchObject({ context: state.context, conversationId: 'c', browserEnabled: false });
    panel.setVoiceBusy(true);
    expect(element('limovaConversation').disabled).toBe(true);
    await expect(panel.prepareVoice()).rejects.toThrow();
    panel.setVoiceBusy(false);
    expect(element('limovaConversation').disabled).toBe(false);
    await panel.logout(); render.mockClear();
    voice.onNativeEvent({ event: 'messages', data: [{ id: 'late', type: 'ai', content: 'obsolete' }, {}] });
    expect(render).not.toHaveBeenCalled();
  });

  it('restores the authorized workspace and history using Limova only', async () => {
    const { panel, render, request } = setup();
    await panel.refresh();
    expect(element('authPanel').hidden).toBe(true);
    expect(element('limovaWorkspace').value).toBe('w');
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [{ id: 'h', role: 'user', content: 'Bonjour' }] }));
    expect(request.mock.calls.every(([request]) => request.type.startsWith('LIMOVA_'))).toBe(true);
  });

  it('opens the app for login without requesting an OTP', async () => {
    const { panel, request } = setup({ LIMOVA_GET_STATE: () => ({ authenticated: false, workspaces: [], context: null }) });
    await panel.refresh();
    expect(element('authPanel').hidden).toBe(false);
    element('limovaLogin').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_OPEN_APP' }));
  });

  it('ignores events for another conversation or an obsolete turn', async () => {
    const { panel, render } = setup();
    await panel.refresh();
    panel.handle({ type: 'LIMOVA_TURN_STARTED', conversationId: 'c', turnId: 't' });
    render.mockClear();
    panel.handle({ type: 'LIMOVA_STREAM_EVENT', conversationId: 'other', turnId: 't', event: { event: 'error' } });
    panel.handle({ type: 'LIMOVA_STREAM_EVENT', conversationId: 'c', turnId: 'old', event: { event: 'error' } });
    expect(render).not.toHaveBeenCalled();
    panel.handle({ type: 'LIMOVA_STREAM_EVENT', conversationId: 'c', turnId: 't', event: { event: 'messages', data: [{ id: 'a', type: 'ai', content: 'Salut' }, {}] } });
    expect(render.mock.lastCall[0].messages.at(-1).content).toBe('Salut');
  });

  it('does not restore old history when a pending send finishes after logout', async () => {
    let finish;
    let loggedOut = false;
    const { panel, render, request } = setup({
      LIMOVA_SEND_MESSAGE: () => new Promise(resolve => { finish = resolve; }),
      LIMOVA_LOGOUT: () => { loggedOut = true; return { authenticated: false }; },
      LIMOVA_GET_STATE: () => loggedOut ? { authenticated: false, workspaces: [], context: null } : state,
    });
    await panel.refresh();
    const sending = panel.send('Bonjour');
    await panel.logout();
    const calls = request.mock.calls.length;
    finish({ ok: true });
    expect(await sending).toBe(false);
    expect(request.mock.calls.length).toBe(calls);
    expect(render.mock.lastCall[0].messages).toEqual([]);
  });

  it('surfaces background errors instead of claiming a message was sent', async () => {
    const { panel } = setup({ LIMOVA_SEND_MESSAGE: () => ({ error: 'Espace désactivé' }) });
    await panel.refresh();
    expect(await panel.send('Bonjour')).toBe(false);
    expect(element('limovaFeedback').textContent).toBe('Espace désactivé');
    expect(element('limovaCancel').hidden).toBe(true);
  });
});


it('requires a fresh browser opt-in and surfaces uncertainty without automatic replay', async () => {
  const { panel, request } = setup({ LIMOVA_SEND_MESSAGE: () => ({ ok: true, browserState: 'uncertain' }) });
  await panel.refresh();
  element('limovaBrowser').checked = true;
  await panel.send('Lis cette page');
  expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_SEND_MESSAGE', text: 'Lis cette page', browser: true });
  expect(element('limovaBrowser').checked).toBe(false);
  expect(element('limovaFeedback').textContent).toContain('incertain');
  expect(request.mock.calls.filter(([request]) => request.type === 'LIMOVA_SEND_MESSAGE')).toHaveLength(1);
});


it('resumes explicitly without resending user text', async () => {
  const { panel, request } = setup({ LIMOVA_RESUME_BROWSER: () => ({ ok: true, browserState: 'completed' }) });
  await panel.refresh();
  element('limovaResume').click();
  expect(element('limovaFeedback').textContent).toContain('Autorise');
  expect(request.mock.calls.some(([request]) => request.type === 'LIMOVA_RESUME_BROWSER')).toBe(false);
  element('limovaBrowser').checked = true;
  element('limovaResume').click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_RESUME_BROWSER', browser: true }));
  await vi.waitFor(() => expect(element('limovaBrowser').checked).toBe(false));
  expect(request.mock.calls.some(([request]) => request.type === 'LIMOVA_SEND_MESSAGE')).toBe(false);
});


it('preserves explicit consent while creating the conversation for the first message', async () => {
  const { panel, request } = setup({
    LIMOVA_GET_STATE: () => ({ ...state, conversationId: null }),
    LIMOVA_CREATE_CONVERSATION: () => ({ id: 'new-conversation' }),
  });
  await panel.refresh();
  element('limovaBrowser').checked = true;
  await panel.send('Lis la page');
  expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_SEND_MESSAGE', text: 'Lis la page', browser: true });
  expect(element('limovaBrowser').checked).toBe(false);
});
