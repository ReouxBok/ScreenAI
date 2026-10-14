// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimovaPanel } from '../../../src/limova/panel.js';

const state = { authenticated: true, user: { id: 'u' }, context: { userId: 'u', workspaceId: 'w' },
  workspaces: [{ id: 'w', name: 'Mon espace', enabled: true }], conversationId: 'c', activeTurnId: null };
const element = id => document.getElementById(id);

function setup(overrides = {}) {
  const request = vi.fn(async (input) => {
    const { type } = input;
    if (overrides[type]) return overrides[type](input);
    if (type === 'LIMOVA_GET_STATE') return state;
    if (type === 'LIMOVA_PREPARE_VOICE') return { context: state.context, conversationId: state.conversationId };
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
    + ['limovaMoreConversations', 'limovaOlderMessages', 'limovaLogin', 'limovaRefresh', 'limovaRefreshSession', 'limovaNew', 'limovaCancel', 'limovaResume'].map(id => `<button id="${id}"></button>`).join('');
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

  it('clears browser consent when the New button creates a conversation', async () => {
    const { panel, request } = setup({ LIMOVA_CREATE_CONVERSATION: () => ({ id: 'new-chat' }) });
    await panel.refresh();
    element('limovaBrowser').checked = true;
    element('limovaNew').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_CREATE_CONVERSATION' }));
    expect(element('limovaBrowser').checked).toBe(false);
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


it('locks evaluation selection and obtains its voice grant without rendering it', async () => {
  const code = 'private-staff-evaluation-code';
  const { panel, render } = setup({
    LIMOVA_GET_STATE: () => ({ ...state, evaluationActive: true }),
    LIMOVA_PREPARE_VOICE: () => ({ context: state.context, conversationId: state.conversationId, evaluationCode: code }),
  });
  await panel.refresh();
  expect(element('limovaWorkspace').disabled).toBe(true);
  expect(element('limovaConversation').disabled).toBe(true);
  expect(element('limovaNew').disabled).toBe(true);
  expect((await panel.prepareVoice()).evaluationCode).toBe(code);
  expect(JSON.stringify(render.mock.calls)).not.toContain(code);
});


it('paginates conversations without losing the selected chat or duplicating entries', async () => {
  const { panel, request } = setup({ LIMOVA_LIST_CONVERSATIONS: ({ page }) => page === 1
    ? { data: [{ id: 'a', title: 'First' }], pagination: { hasNext: true } }
    : { data: [{ id: 'a', title: 'Renamed' }, { id: 'c', title: 'Current' }], pagination: { hasNext: false } } });
  await panel.refresh();
  expect(element('limovaConversation').value).toBe('c');
  element('limovaMoreConversations').click();
  await vi.waitFor(() => expect(element('limovaMoreConversations').hidden).toBe(true));
  expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_LIST_CONVERSATIONS', page: 2 });
  expect([...element('limovaConversation').options].map(item => item.value)).toEqual(['', 'a', 'c']);
  expect(element('limovaConversation').value).toBe('c');
});

it('prepends older messages and ignores duplicate clicks while loading', async () => {
  let resolve;
  const { panel, request, render } = setup({ LIMOVA_GET_MESSAGES: ({ cursor }) => cursor
    ? new Promise(done => { resolve = done; })
    : { data: [{ id: 'h', role: 'user', content: 'Recent' }], pagination: { hasMore: true, nextCursor: 'before-h' } } });
  await panel.refresh();
  element('limovaOlderMessages').click(); element('limovaOlderMessages').click();
  expect(request.mock.calls.filter(([input]) => input.cursor).length).toBe(1);
  resolve({ data: [{ id: 'old', role: 'user', content: 'Earlier' }, { id: 'h', role: 'user', content: 'Stale' }], pagination: { hasMore: false } });
  await vi.waitFor(() => expect(element('limovaOlderMessages').hidden).toBe(true));
  expect(render.mock.lastCall[0].messages.map(item => item.content)).toEqual(['Earlier', 'Recent']);
});

it('drops an older page when the user opens another conversation', async () => {
  let resolve;
  const { panel, render } = setup({
    LIMOVA_GET_MESSAGES: ({ cursor }) => cursor ? new Promise(done => { resolve = done; })
      : { data: [], pagination: { hasMore: true, nextCursor: 'old-cursor' } },
    LIMOVA_OPEN_CONVERSATION: () => ({ conversation: { id: 'other' }, messages: { data: [{ id: 'new', role: 'user', content: 'Other chat' }] } }),
  });
  await panel.refresh(); element('limovaOlderMessages').click();
  element('limovaConversation').append(new Option('Other', 'other'));
  element('limovaConversation').value = 'other'; element('limovaConversation').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(render.mock.lastCall[0].messages[0]?.content).toBe('Other chat'));
  resolve({ data: [{ id: 'secret', role: 'user', content: 'Old chat' }] });
  await new Promise(done => setTimeout(done, 0));
  expect(render.mock.lastCall[0].messages.map(item => item.content)).toEqual(['Other chat']);
});


it('keeps the older cursor available after a failed read and preserves it after a new answer', async () => {
  let failures = 1;
  const { panel, request } = setup({ LIMOVA_GET_MESSAGES: ({ cursor }) => {
    if (cursor && failures-- > 0) throw new Error('Network unavailable');
    if (cursor) return { data: [], pagination: { hasMore: true, nextCursor: 'earliest' } };
    return { data: [], pagination: { hasMore: true, nextCursor: 'recent' } };
  } });
  await panel.refresh(); element('limovaOlderMessages').click();
  await vi.waitFor(() => expect(element('limovaFeedback').textContent).toBe('Network unavailable'));
  expect(element('limovaOlderMessages').hidden).toBe(false);
  element('limovaOlderMessages').click();
  await vi.waitFor(() => expect(element('limovaOlderMessages').disabled).toBe(false));
  await panel.send('New question');
  element('limovaOlderMessages').click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_GET_MESSAGES', cursor: 'earliest' }));
});


it('releases pagination after refreshing while an older request is pending', async () => {
  let resolve;
  const { panel, render } = setup({ LIMOVA_GET_MESSAGES: ({ cursor }) => cursor
    ? new Promise(done => { resolve = done; })
    : { data: [], pagination: { hasMore: true, nextCursor: 'older' } } });
  await panel.refresh(); element('limovaOlderMessages').click();
  expect(element('limovaOlderMessages').disabled).toBe(true);
  await panel.refresh();
  expect(element('limovaOlderMessages').disabled).toBe(false);
  resolve({ data: [{ id: 'late', role: 'user', content: 'Discarded' }] });
  await new Promise(done => setTimeout(done, 0));
  expect(render.mock.lastCall[0].messages).toEqual([]);
});


it('relocalizes selectors without interrupting an active native voice session', async () => {
  const { panel, request, render } = setup();
  await panel.refresh(); panel.setVoiceBusy(true); request.mockClear(); render.mockClear();
  panel.relocalize();
  expect(element('limovaConversation').disabled).toBe(true);
  expect(element('limovaCancel').hidden).toBe(false);
  expect(element('limovaConversation').value).toBe('c');
  expect(request).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

 it('analyzes through a native observation turn without granting general browser actions', async () => {
   const { panel, request } = setup();
   await panel.refresh();
   await panel.analyzePage();
   expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIMOVA_SEND_MESSAGE', browser: true, browserMode: 'observe' }));
   expect(element('limovaBrowser').checked).toBe(false);
   request.mockClear();
   panel.setVoiceBusy(true);
   await panel.analyzePage();
   expect(request).not.toHaveBeenCalled();
 });

 it('continues the selected conversation and honors per-turn browser consent', async () => {
   const { panel, request } = setup();
   await panel.refresh();
   await panel.nextStep();
   expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_SEND_MESSAGE', text: 'Guide-moi pour la prochaine étape en tenant compte de notre conversation.', browser: false });
   expect(request.mock.calls.some(([input]) => input.type === 'LIMOVA_CREATE_CONVERSATION')).toBe(false);
   element('limovaBrowser').checked = true;
   await panel.nextStep();
   expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIMOVA_SEND_MESSAGE', browser: true }));
   expect(element('limovaBrowser').checked).toBe(false);
   request.mockClear();
   panel.setVoiceBusy(true);
   await panel.nextStep();
   expect(request).not.toHaveBeenCalled();
 });

it('does not send a second next-step message while the first is pending', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { panel, request } = setup({ LIMOVA_SEND_MESSAGE: () => pending });
  await panel.refresh();
  const first = panel.nextStep();
  await panel.nextStep();
  expect(request.mock.calls.filter(([input]) => input.type === 'LIMOVA_SEND_MESSAGE')).toHaveLength(1);
  finish({ ok: true });
  await first;
});

it('exports only the selected conversation, rejects duplicate exports and drops stale results', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { panel, request } = setup({ LIMOVA_EXPORT_CONVERSATION: () => pending });
  await panel.refresh();
  const first = panel.exportConversation();
  expect(await panel.exportConversation()).toBeNull();
  expect(request).toHaveBeenCalledWith({ type: 'LIMOVA_EXPORT_CONVERSATION', conversationId: 'c' });
  await panel.refresh();
  finish({ content: 'old private data', filename: 'old.csv' });
  expect(await first).toBeNull();
  panel.setVoiceBusy(true);
  expect(await panel.exportConversation()).toBeNull();
});
