import { createConversationView } from './conversation-view.js';

export function createLimovaPanel({ document, request, render, onBusy, onContextChange = () => {}, onBrowserTarget = () => {}, translate: translateText = (_key, fallback) => fallback }) {
  const translations = new Map();
  function translate(key, fallback) {
    const value = translateText(key, fallback);
    translations.set(value, key);
    return value;
  }
  const view = createConversationView();
  const element = id => document.getElementById(id);
  let context = null;
  let conversationId = null;
  let turnId = null;
  let generation = 0;
  let busy = false;
  let voiceBusy = false;
  let sending = false;
  let evaluationActive = false;
  let exporting = false;
  let catalog = new Map();
  let nextPage = null;
  let olderCursor = null;
  let catalogLoading = false;
  let historyLoading = false;
  let historyInitialized = false;

  function pagingControls() {
    const exportButton = element('limovaExport');
    if (exportButton) exportButton.disabled = !context || !conversationId || busy || evaluationActive || exporting;
    const more = element('limovaMoreConversations');
    const older = element('limovaOlderMessages');
    if (more) { more.hidden = !nextPage; more.disabled = busy || catalogLoading || evaluationActive; }
    if (older) { older.hidden = !olderCursor; older.disabled = busy || historyLoading; }
  }
  function history(page, prepend = false) {
    const cursor = page?.pagination?.hasMore === true ? page.pagination.nextCursor : null;
    if (prepend || !historyInitialized) olderCursor = typeof cursor === 'string' && cursor ? cursor : null;
    historyInitialized = true;
    view.history(page, { prepend });
    if (prepend) render(view.snapshot(), { showOlder: true });
    else render(view.snapshot());
    pagingControls();
  }

  async function call(type, fields = {}) {
    const response = await request({ type, ...fields });
    if (response?.error && ['LIMOVA_HTTP_5XX', 'LIMOVA_RATE_LIMITED'].includes(response.code)) {
      const message = response.code === 'LIMOVA_RATE_LIMITED'
        ? translate('limovaRateLimited', 'Limova reçoit trop de demandes. Réessaie plus tard.')
        : translate('limovaServiceUnavailable', 'Limova est temporairement indisponible.');
      const advice = ['LIMOVA_SEND_MESSAGE', 'LIMOVA_RESUME_BROWSER'].includes(type)
        ? ` ${translate('limovaCheckConversation', 'Vérifie l’historique et le résultat des actions avant de renvoyer une demande.')}` : '';
      throw new Error(`${message} (${response.code})${advice}`);
    }
    if (!response || response.error) throw new Error(response?.error || translate("limovaServiceUnavailable", 'Limova est temporairement indisponible.'));
    return response;
  }
  function setBusy(value) {
    value = value || voiceBusy;
    busy = value;
    element('limovaCancel').hidden = !value;
    element('limovaWorkspace').disabled = value || evaluationActive;
    element('limovaConversation').disabled = value || evaluationActive;
    element('limovaNew').disabled = value || !context || evaluationActive;
    if (element('limovaFollow')) element('limovaFollow').disabled = !element('limovaFollow').checked && (value || !conversationId || evaluationActive);
    if (element('limovaResume')) element('limovaResume').disabled = value || !context || !conversationId;
    pagingControls();
    onBusy(value);
  }
  function feedback(text) {
    ['authFeedback', 'limovaFeedback'].forEach(id => {
      element(id).textContent = text;
      if (translations.has(text)) element(id).dataset.i18n = translations.get(text);
      else delete element(id).dataset.i18n;
    });
  }
  function clear(resetCatalog = true) { if (resetCatalog) { catalog = new Map(); nextPage = null; } historyInitialized = false; olderCursor = null; catalogLoading = false; historyLoading = false; onContextChange(); voiceBusy = false; if (element('limovaBrowser')) element('limovaBrowser').checked = false; conversationId = null; turnId = null; sending = false; view.reset(); render(view.snapshot()); setBusy(false); }
  function options(select, items, placeholder) {
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = placeholder; select.append(empty);
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id; option.textContent = item.name; option.disabled = item.disabled === true;
      if (item.i18nKey) option.dataset.i18n = item.i18nKey;
      if (item.originalName) option.dataset.originalName = item.originalName;
      select.append(option);
    });
  }
  async function list(expectedGeneration = generation, pageNumber = 1) {
    catalogLoading = true; pagingControls();
    try {
      const page = await call('LIMOVA_LIST_CONVERSATIONS', { page: pageNumber });
      if (expectedGeneration !== generation) return;
      if (pageNumber === 1) catalog = new Map();
      (page.data ?? []).forEach(item => catalog.set(item.id, { id: item.id, name: item.title || translate("limovaConversationName", 'Conversation'), i18nKey: item.title ? null : 'limovaConversationName' }));
      const items = [...catalog.values()];
      if (conversationId && !catalog.has(conversationId)) items.unshift({ id: conversationId, name: translate("limovaCurrentConversation", 'Conversation actuelle'), i18nKey: 'limovaCurrentConversation' });
      options(element('limovaConversation'), items, translate("limovaChooseConversation", 'Reprendre une conversation'));
      element('limovaConversation').value = conversationId ?? '';
      nextPage = page.pagination?.hasNext === true ? pageNumber + 1 : null;
    } finally {
      if (expectedGeneration === generation) { catalogLoading = false; pagingControls(); }
    }
  }
  async function loadOlder() {
    if (!context || !conversationId || !olderCursor || busy || historyLoading) return;
    const current = generation, cursor = olderCursor;
    historyLoading = true; pagingControls();
    try {
      const page = await call('LIMOVA_GET_MESSAGES', { cursor });
      if (current !== generation) return;
      history(page, true);
      if (olderCursor === cursor) olderCursor = null;
      feedback('');
    } catch (error) { if (current === generation) feedback(error.message); }
    finally { if (current === generation) { historyLoading = false; pagingControls(); } }
  }
  async function refresh() {
    const current = ++generation;
    catalogLoading = false; historyLoading = false;
    feedback(translate("limovaChecking", 'Vérification de la session Limova…'));
    try {
      const state = await call('LIMOVA_GET_STATE');
      if (current !== generation) return;
      const changed = context?.userId !== state.context?.userId || context?.workspaceId !== state.context?.workspaceId || conversationId !== state.conversationId;
      if (changed || !state.authenticated) clear();
      context = state.context;
      evaluationActive = state.evaluationActive === true;
      document.documentElement.dataset.authState = state.authenticated ? 'authenticated' : 'required';
      element('authPanel').hidden = state.authenticated;
      element('limovaControls').hidden = !state.authenticated;
      options(element('limovaWorkspace'), (state.workspaces ?? []).map(item => ({ id: item.id, name: item.enabled ? item.name : `${item.name} — ${translate("limovaUnavailable", "extension indisponible")}`, disabled: !item.enabled, originalName: item.name })), translate("limovaChooseWorkspace", 'Choisir un espace'));
      element('limovaWorkspace').value = context?.workspaceId ?? '';
      conversationId = state.conversationId;
      turnId = state.activeTurnId;
      setBusy(Boolean(turnId));
      feedback(!state.authenticated ? translate("limovaLoginHint", 'Connecte-toi dans Limova, puis clique sur « Actualiser ma connexion ».')
        : !context ? translate("limovaWorkspaceHint", 'Choisis un espace activé pour l’extension.') : '');
      if (!context) return;
      await list(current);
      if (conversationId) {
        const page = await call('LIMOVA_GET_MESSAGES');
        if (current !== generation) return;
        history(page);
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
    clear(false); setBusy(true);
    try {
      const result = await call('LIMOVA_OPEN_CONVERSATION', { conversationId: id });
      if (current !== generation) return;
      conversationId = result.conversation.id;
      history(result.messages); feedback('');
    } catch (error) { if (current === generation) feedback(error.message); }
    finally { if (current === generation) setBusy(false); }
  }
  async function create(preserveBrowserConsent = false) {
    if (!context || busy) return;
    const browserConsent = preserveBrowserConsent && element('limovaBrowser')?.checked === true;
    const current = ++generation; clear(false);
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
  async function send(text, resume = false, observe = false, browserTabId) {
    if (!context || busy || (!resume && !text.trim())) return false;
    if (resume && (!conversationId || element('limovaBrowser')?.checked !== true)) { feedback(translate("limovaResumeConsent", 'Autorise le navigateur pour reprendre le tour interrompu.')); return false; }
    if (!conversationId) await create(true);
    if (!conversationId) return false;
    const current = generation;
    sending = true; setBusy(true); feedback('');
    try {
      const result = await call(resume ? 'LIMOVA_RESUME_BROWSER' : 'LIMOVA_SEND_MESSAGE', { ...(resume ? {} : { text }), browser: observe || element('limovaBrowser')?.checked === true, ...(observe ? { browserMode: 'observe' } : {}), ...(browserTabId !== undefined ? { browserTabId } : {}) });
      if (current !== generation) return false;
      if (result.browserState === 'uncertain') feedback(translate("limovaUncertain", 'Le résultat de l’action est incertain. Vérifie la page avant de poursuivre ; l’action ne sera pas répétée automatiquement.'));
      else if (result.browserState === 'waiting') feedback(translate("limovaWaiting", 'Le tour navigateur est en attente.'));
      else if (result.browserState === 'absent') feedback(translate("limovaNoPendingTurn", 'Aucun tour navigateur à reprendre.'));
      else if (result.browserState === 'cancelled') feedback(translate("limovaCancelled", 'Ce tour navigateur a été annulé.'));
      if (current !== generation) return false;
      const page = await call('LIMOVA_GET_MESSAGES');
      if (current !== generation) return false;
      history(page);
      return true;
    } catch (error) { if (current === generation) feedback(error.message); return false; }
    finally { if (current === generation) { sending = false; turnId = null; if (element('limovaBrowser')) element('limovaBrowser').checked = false; setBusy(false); } }
  }
  function handle(message) {
    if (message.type === 'LIMOVA_SESSION_CHANGED') { ++generation; context = null; clear(); void refresh(); return true; }
    if (!message.type?.startsWith('LIMOVA_')) return false;
    if (message.conversationId !== conversationId) return true;
    if (message.type === 'LIMOVA_BROWSER_TARGET' && message.turnId === turnId) onBrowserTarget(message.tabId);
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
  element('limovaMoreConversations')?.addEventListener('click', () => {
    if (!nextPage || busy || catalogLoading || evaluationActive) return;
    const current = generation;
    void list(current, nextPage).catch(error => { if (current === generation) feedback(error.message); });
  });
  element('limovaOlderMessages')?.addEventListener('click', () => { void loadOlder(); });
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
    nextStep() { return send(translate('limovaNextStepPrompt', 'Guide-moi pour la prochaine étape en tenant compte de notre conversation.')); },
    analyzePage(browserTabId) { return send(translate('limovaAnalyzePrompt', 'Analyse la page active et explique ce que tu observes. Utilise une capture si nécessaire. Ne clique pas, ne saisis rien et ne navigue pas.'), false, true, browserTabId); },
    relocalize() {
      const workspace = element('limovaWorkspace');
      if (workspace.options[0]) workspace.options[0].textContent = translate('limovaChooseWorkspace', 'Choisir un espace');
      const conversations = element('limovaConversation');
      if (conversations.options[0]) conversations.options[0].textContent = translate('limovaChooseConversation', 'Reprendre une conversation');
      [...workspace.options].forEach(option => {
        if (option.dataset.originalName) option.textContent = option.dataset.originalName
          + (option.disabled ? ` — ${translate('limovaUnavailable', 'extension indisponible')}` : '');
      });
    },
    async exportConversation() {
      if (!context || !conversationId || busy || evaluationActive || exporting) return null;
      const current = generation;
      exporting = true; pagingControls();
      feedback(translate('limovaExporting', 'Préparation de l’export…'));
      try {
        const file = await call('LIMOVA_EXPORT_CONVERSATION', { conversationId });
        if (current !== generation) return null;
        feedback('');
        return file;
      } catch (error) { if (current === generation) feedback(error.message); return null; }
      finally { exporting = false; pagingControls(); }
    },
    async openGeneratedFile(fileId) {
      if (!context || !conversationId) return;
      const current = generation;
      feedback(translate("limovaOpeningFile", 'Ouverture du fichier…'));
      try {
        await call('LIMOVA_OPEN_GENERATED_FILE', { conversationId, fileId });
        if (current === generation) feedback('');
      } catch (error) { if (current === generation) feedback(error.message); }
    },
    setVoiceBusy(active) { voiceBusy = active; setBusy(Boolean(turnId) || sending); },
    prepareTranscription() {
      if (!context || busy) throw new Error(translate("limovaWorkspaceRequired", 'Sélectionne un espace Limova disponible.'));
      return { context: { ...context }, conversationId };
    },
    async prepareVoice() {
      if (!context || busy) throw new Error(translate("limovaConversationRequired", 'Sélectionne une conversation Limova disponible.'));
      if (!conversationId) await create(true);
      if (!conversationId || !context) throw new Error(translate("limovaConversationUnavailable", 'Conversation Limova indisponible.'));
      const current = generation;
      const authorized = await call('LIMOVA_PREPARE_VOICE', { conversationId });
      if (current !== generation || !context) throw new Error(translate("limovaSessionChanged", 'La session Limova a changé.'));
      if (authorized.conversationId !== conversationId || authorized.context?.userId !== context.userId
        || authorized.context?.workspaceId !== context.workspaceId) throw new Error(translate("limovaSessionChanged", 'La session Limova a changé.'));
      return { ...(authorized.evaluationCode ? { evaluationCode: authorized.evaluationCode } : {}), context: { ...context }, conversationId, browserEnabled: element('limovaBrowser')?.checked === true,
        onNativeEvent(event) { if (current === generation) { view.event(event); render(view.snapshot()); } },
      };
    },
    async logout() {
    onContextChange();
    await call('LIMOVA_LOGOUT'); ++generation; context = null; clear(); await refresh();
  } };
}
