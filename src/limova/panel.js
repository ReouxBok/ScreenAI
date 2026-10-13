import { createConversationView } from './conversation-view.js';

export function createLimovaPanel({ document, request, render, onBusy, onContextChange = () => {} }) {
  const view = createConversationView();
  const element = id => document.getElementById(id);
  let context = null;
  let conversationId = null;
  let turnId = null;
  let generation = 0;
  let busy = false;
  let voiceBusy = false;
  let sending = false;

  async function call(type, fields = {}) {
    const response = await request({ type, ...fields });
    if (!response || response.error) throw new Error(response?.error || 'Limova est temporairement indisponible.');
    return response;
  }
  function setBusy(value) {
    value = value || voiceBusy;
    busy = value;
    element('limovaCancel').hidden = !value;
    element('limovaWorkspace').disabled = value;
    element('limovaConversation').disabled = value;
    element('limovaNew').disabled = value || !context;
    if (element('limovaResume')) element('limovaResume').disabled = value || !context || !conversationId;
    onBusy(value);
  }
  function feedback(text) { element('authFeedback').textContent = text; element('limovaFeedback').textContent = text; }
  function clear() { onContextChange(); voiceBusy = false; if (element('limovaBrowser')) element('limovaBrowser').checked = false; conversationId = null; turnId = null; sending = false; view.reset(); render(view.snapshot()); setBusy(false); }
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
  async function create(preserveBrowserConsent = false) {
    if (!context || busy) return;
    const browserConsent = preserveBrowserConsent && element('limovaBrowser')?.checked === true;
    const current = ++generation; clear();
    if (element('limovaBrowser')) element('limovaBrowser').checked = browserConsent;
    setBusy(true);
    try {
      const conversation = await call('LIMOVA_CREATE_CONVERSATION');
      if (current !== generation) return;
      conversationId = conversation.id;
      await list(current); feedback('');
    } catch (error) { if (current === generation) feedback(error.message); }
    finally { if (current === generation) setBusy(false); }
  }
  async function send(text, resume = false) {
    if (!context || busy || (!resume && !text.trim())) return false;
    if (resume && (!conversationId || element('limovaBrowser')?.checked !== true)) { feedback('Autorise le navigateur pour reprendre le tour interrompu.'); return false; }
    if (!conversationId) await create(true);
    if (!conversationId) return false;
    const current = generation;
    sending = true; setBusy(true); feedback('');
    try {
      const result = await call(resume ? 'LIMOVA_RESUME_BROWSER' : 'LIMOVA_SEND_MESSAGE', { ...(resume ? {} : { text }), browser: element('limovaBrowser')?.checked === true });
      if (current !== generation) return false;
      if (result.browserState === 'uncertain') feedback('Le résultat de l’action est incertain. Vérifie la page avant de poursuivre ; l’action ne sera pas répétée automatiquement.');
      else if (result.browserState === 'waiting') feedback('Le tour navigateur est en attente.');
      else if (result.browserState === 'absent') feedback('Aucun tour navigateur à reprendre.');
      else if (result.browserState === 'cancelled') feedback('Ce tour navigateur a été annulé.');
      if (current !== generation) return false;
      const page = await call('LIMOVA_GET_MESSAGES');
      if (current !== generation) return false;
      view.history(page); render(view.snapshot());
      return true;
    } catch (error) { if (current === generation) feedback(error.message); return false; }
    finally { if (current === generation) { sending = false; turnId = null; if (element('limovaBrowser')) element('limovaBrowser').checked = false; setBusy(false); } }
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
  element('limovaBrowser')?.addEventListener('change', () => { if (!element('limovaBrowser').checked && busy) { onContextChange(); void call('LIMOVA_CANCEL').catch(error => feedback(error.message)); } });
  element('limovaResume')?.addEventListener('click', () => { void send('', true); });
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
  listen('limovaCancel', 'click', () => { onContextChange(); return call('LIMOVA_CANCEL'); });
  return { refresh, send, create, handle,
    setVoiceBusy(active) { voiceBusy = active; setBusy(Boolean(turnId) || sending); },
    async prepareVoice() {
      if (!context || busy) throw new Error('Sélectionne une conversation Limova disponible.');
      if (!conversationId) await create(true);
      if (!conversationId || !context) throw new Error('Conversation Limova indisponible.');
      const current = generation;
      return { context: { ...context }, conversationId, browserEnabled: element('limovaBrowser')?.checked === true,
        onNativeEvent(event) { if (current === generation) { view.event(event); render(view.snapshot()); } },
      };
    },
    async logout() {
    onContextChange();
    await call('LIMOVA_LOGOUT'); ++generation; context = null; clear(); await refresh();
  } };
}
