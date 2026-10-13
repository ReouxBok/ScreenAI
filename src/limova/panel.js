import { createConversationView } from './conversation-view.js';

export function createLimovaPanel({ document, request, render, onBusy }) {
  const view = createConversationView();
  const element = id => document.getElementById(id);
  let context = null;
  let conversationId = null;
  let turnId = null;
  let generation = 0;
  let busy = false;
  let sending = false;

  async function call(type, fields = {}) {
    const response = await request({ type, ...fields });
    if (!response || response.error) throw new Error(response?.error || 'Limova est temporairement indisponible.');
    return response;
  }
  function setBusy(value) {
    busy = value;
    element('limovaCancel').hidden = !value;
    element('limovaWorkspace').disabled = value;
    element('limovaConversation').disabled = value;
    element('limovaNew').disabled = value || !context;
    onBusy(value);
  }
  function feedback(text) { element('authFeedback').textContent = text; element('limovaFeedback').textContent = text; }
  function clear() { conversationId = null; turnId = null; sending = false; view.reset(); render(view.snapshot()); setBusy(false); }
  function options(select, items, placeholder) {
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = placeholder; select.append(empty);
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id; option.textContent = item.name; option.disabled = item.disabled === true;
      select.append(option);
    });
  }
  async function list(expectedGeneration = generation) {
    const page = await call('LIMOVA_LIST_CONVERSATIONS');
    if (expectedGeneration !== generation) return;
    options(element('limovaConversation'), (page.data ?? []).map(item => ({ id: item.id, name: item.title || 'Conversation' })), 'Reprendre une conversation');
    element('limovaConversation').value = conversationId ?? '';
  }
  async function refresh() {
    const current = ++generation;
    feedback('Vérification de la session Limova…');
    try {
      const state = await call('LIMOVA_GET_STATE');
      if (current !== generation) return;
      const changed = context?.userId !== state.context?.userId || context?.workspaceId !== state.context?.workspaceId || conversationId !== state.conversationId;
      if (changed || !state.authenticated) clear();
      context = state.context;
      document.documentElement.dataset.authState = state.authenticated ? 'authenticated' : 'required';
      element('authPanel').hidden = state.authenticated;
      element('limovaControls').hidden = !state.authenticated;
      options(element('limovaWorkspace'), (state.workspaces ?? []).map(item => ({ id: item.id, name: item.enabled ? item.name : `${item.name} — extension indisponible`, disabled: !item.enabled })), 'Choisir un espace');
      element('limovaWorkspace').value = context?.workspaceId ?? '';
      conversationId = state.conversationId;
      turnId = state.activeTurnId;
      setBusy(Boolean(turnId));
      feedback(!state.authenticated ? 'Connecte-toi dans Limova, puis clique sur « Actualiser ma connexion ».'
        : !context ? 'Choisis un espace activé pour l’extension.' : '');
      if (!context) return;
      await list(current);
      if (conversationId) {
        const page = await call('LIMOVA_GET_MESSAGES');
        if (current !== generation) return;
        view.history(page);
        render(view.snapshot());
      }
    } catch (error) {
      if (current !== generation) return;
      if (!context) {
        element('authPanel').hidden = false;
        document.documentElement.dataset.authState = 'required';
      }
      feedback(error.message);
    }
  }
  async function open(id) {
    const current = ++generation;
    clear(); setBusy(true);
    try {
      const result = await call('LIMOVA_OPEN_CONVERSATION', { conversationId: id });
      if (current !== generation) return;
      conversationId = result.conversation.id;
      view.history(result.messages); render(view.snapshot()); feedback('');
    } catch (error) { if (current === generation) feedback(error.message); }
    finally { if (current === generation) setBusy(false); }
  }
  async function create() {
    if (!context || busy) return;
    const current = ++generation; clear(); setBusy(true);
    try {
      const conversation = await call('LIMOVA_CREATE_CONVERSATION');
      if (current !== generation) return;
      conversationId = conversation.id;
      await list(current); feedback('');
    } catch (error) { if (current === generation) feedback(error.message); }
    finally { if (current === generation) setBusy(false); }
  }
  async function send(text) {
    if (!context || busy || !text.trim()) return false;
    if (!conversationId) await create();
    if (!conversationId) return false;
    const current = generation;
    sending = true; setBusy(true); feedback('');
    try {
      await call('LIMOVA_SEND_MESSAGE', { text });
      if (current !== generation) return false;
      const page = await call('LIMOVA_GET_MESSAGES');
      if (current !== generation) return false;
      view.history(page); render(view.snapshot());
      return true;
    } catch (error) { if (current === generation) feedback(error.message); return false; }
    finally { if (current === generation) { sending = false; turnId = null; setBusy(false); } }
  }
  function handle(message) {
    if (message.type === 'LIMOVA_SESSION_CHANGED') { ++generation; context = null; clear(); void refresh(); return true; }
    if (!message.type?.startsWith('LIMOVA_')) return false;
    if (message.conversationId !== conversationId) return true;
    if (message.type === 'LIMOVA_TURN_STARTED') { turnId = message.turnId; setBusy(true); }
    if (message.type === 'LIMOVA_STREAM_EVENT' && message.turnId === turnId) { view.event(message.event); render(view.snapshot()); }
    if (message.type === 'LIMOVA_TURN_ENDED' && message.turnId === turnId) { turnId = null; if (!sending) setBusy(false); }
    return true;
  }
  function listen(id, event, action) {
    element(id).addEventListener(event, () => { void Promise.resolve().then(action).catch(error => feedback(error.message)); });
  }
  listen('limovaLogin', 'click', () => call('LIMOVA_OPEN_APP'));
  listen('limovaRefresh', 'click', refresh);
  listen('limovaRefreshSession', 'click', refresh);
  listen('limovaWorkspace', 'change', async () => {
    const workspaceId = element('limovaWorkspace').value;
    ++generation; context = null; clear();
    if (!workspaceId) return;
    await call('LIMOVA_SELECT_WORKSPACE', { workspaceId }); await refresh();
  });
  listen('limovaConversation', 'change', () => { const id = element('limovaConversation').value; if (id) return open(id); });
  listen('limovaNew', 'click', create);
  listen('limovaCancel', 'click', () => call('LIMOVA_CANCEL'));
  return { refresh, send, create, handle, async logout() {
    await call('LIMOVA_LOGOUT'); ++generation; context = null; clear(); await refresh();
  } };
}
