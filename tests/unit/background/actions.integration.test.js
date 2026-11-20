// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('controlled page actions', () => {
  let background;
  let chromeMock;
  let sidebarMessages;
  let originalOffsetParent;
  let originalRect;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    chromeMock.tabs.query.mockImplementation(async query => query?.active ? [{ id: 17, windowId: 1, url: 'https://new.limova.ai/home', active: true }] : []);
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));

    sidebarMessages = [];
    const port = {
      name: 'sidebar',
      postMessage: vi.fn(message => sidebarMessages.push(message)),
      onDisconnect: { addListener: vi.fn() }
    };
    chromeMock._listeners.runtime.onConnect[0](port);

    originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() { return document.body; }
    });
    HTMLElement.prototype.getBoundingClientRect = () => ({
      left: 10, top: 10, right: 110, bottom: 42,
      width: 100, height: 32, x: 10, y: 10
    });
  });

  afterAll(() => {
    if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  beforeEach(async () => {
    background.handleResetSession();
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'full' });
    sidebarMessages.length = 0;
    chromeMock.tabs.sendMessage.mockReset();
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    document.body.innerHTML = `
      <a href="/documents">Documents</a>
      <form><button type="submit">Sauvegarder</button></form>
      <button type="button">Connecter Google Drive</button>
      <button type="button">Autoriser Google Drive</button>
      <label for="brief">Instructions</label><textarea id="brief"></textarea>
      <label for="password">Mot de passe</label><input id="password" type="password">
    `;
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: vi.fn(() => [])
    });
    chromeMock.scripting.executeScript.mockImplementation(async ({ func, args = [] }) => [
      { result: await func(...args) }
    ]);
    await background.getPageContext(17);
    background.lockTab(17);
    chromeMock.tabs.sendMessage.mockClear();
    sidebarMessages.length = 0;
  });

  it('names icon-only links so a request like “va à l’accueil” finds the logo', async () => {
    document.body.innerHTML = `
      <a href="/" class="brand-logo"><svg viewBox="0 0 10 10"></svg></a>
      <a href="/settings/billing"><svg viewBox="0 0 10 10"></svg></a>
    `;

    const context = await background.getPageContext(17);

    expect(context).toContain('Accueil (logo)');
    expect(context).toContain('Lien vers /settings/billing');
  });

  it('executes a low-risk internal navigation only after an explicit command', async () => {
    const result = await background.proposeOrExecuteAction(1, 'Clique sur Documents');
    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 1
    }));
    expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(false);
  });

  it('repairs a missing content script once before executing an action', async () => {
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValueOnce({ ok: true });
    chromeMock.scripting.executeScript.mockImplementationOnce(async options => {
      expect(options).toEqual({ target: { tabId: 17 }, files: ['src/content/content.js'] });
      return [{ result: null }];
    });

    const result = await background.proposeOrExecuteAction(1, 'Clique sur Documents');

    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chromeMock.scripting.executeScript.mock.invocationCallOrder[0])
      .toBeLessThan(chromeMock.tabs.sendMessage.mock.invocationCallOrder[1]);
  });

  it('never replays a mutating command until the repaired DOM target has been remapped', async () => {
    const sendOrder = [];
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'EXECUTE_ELEMENT_ACTION') sendOrder.push(`click:${message.id}:v${message.contextVersion}`);
      if (sendOrder.length === 1) throw new Error('Receiving end does not exist');
      return { ok: true };
    });

    const result = await background.proposeOrExecuteAction(1, 'Clique sur Documents');

    expect(result.ok).toBe(true);
    expect(sendOrder).toEqual(['click:1:v1', 'click:1:v2']);
  });

  it.each([
    ['chrome://settings/', 'Cannot access contents of the page', 'restricted_browser_page'],
    ['https://chromewebstore.google.com/detail/example', 'Cannot access contents of the page', 'restricted_browser_page'],
    ['https://private.example/document', 'Missing host permission for the tab', 'host_permission_denied'],
    ['https://private.example/document', 'Frame with ID 0 was removed', 'navigation_race']
  ])('categorizes a repair failure on %s without sending the URL or message to analytics', async (url, errorMessage, reason) => {
    const track = vi.spyOn(background.analytics, 'trackError');
    chromeMock.tabs.get.mockResolvedValue({ id: 17, url, active: true });
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    chromeMock.scripting.executeScript.mockRejectedValue(new Error(errorMessage));
    try {
      const result = await background.proposeOrExecuteAction(1, 'Clique sur Documents');
      expect(result.ok).toBe(false);
      if (reason === 'navigation_race') expect(track).not.toHaveBeenCalledWith('content_script', 'CONTENT_SCRIPT_REPAIR_FAILED', expect.anything());
      else expect(track).toHaveBeenCalledWith('content_script', 'CONTENT_SCRIPT_REPAIR_FAILED', {
        errorType: 'Error', failureReason: reason
      });
      expect(JSON.stringify(track.mock.calls)).not.toContain('private.example');
      expect(JSON.stringify(track.mock.calls)).not.toContain(errorMessage);
    } finally {
      track.mockRestore();
      chromeMock.tabs.get.mockResolvedValue({ id: 17, windowId: 1, url: 'https://new.limova.ai/home', active: true });
    }
  });

  async function showOnlyExternalLink() {
    document.body.innerHTML = '<a href="https://www.instagram.com/p/abc" target="_blank">Voir la publication Instagram</a>';
    await background.getPageContext(17);
    background.lockTab(17);
    chromeMock.tabs.sendMessage.mockClear();
    sidebarMessages.length = 0;
  }

  it('opens a link to another site when the user explicitly asks for it', async () => {
    await showOnlyExternalLink();
    const result = await background.proposeOrExecuteAction(1, 'Ouvre la publication Instagram');
    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 1
    }));
  });

  async function cancelApproval(operation) {
    await vi.waitFor(() => expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(true));
    const proposal = sidebarMessages.find(message => message.type === 'ACTION_PROPOSAL');
    await background.handleMessage({ type: 'CANCEL_ACTION', actionId: proposal.actionId });
    return operation;
  }

  it('keeps a link to another site blocked when the user did not ask for it', async () => {
    await showOnlyExternalLink();
    const result = await cancelApproval(background.proposeOrExecuteAction(1, 'Que contient cette page ?'));
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION'
    }));
  });

  it.each([
    ['while the click is dispatched', 0],
    ['while the click effect settles', 100]
  ])('reports a link that opened a followed new tab as executed (%s)', async (_label, followDelayMs) => {
    await showOnlyExternalLink();
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type !== 'EXECUTE_ELEMENT_ACTION') return { ok: true };
      const follow = () => {
        chromeMock._listeners.tabs.onCreated.forEach(listener => listener({ id: 18, openerTabId: 17, windowId: 1 }));
        background.lockTab(18);
      };
      if (followDelayMs) setTimeout(follow, followDelayMs);
      else follow();
      return { ok: true, clickDispatched: true };
    });
    try {
      const result = await background.proposeOrExecuteAction(1, 'Ouvre la publication Instagram');
      expect(result).toMatchObject({ ok: true, effectObserved: true, effectEvidence: { newTabOpened: true } });
      expect(result.cancelled).toBeUndefined();
      expect(sidebarMessages).toContainEqual(expect.objectContaining({ type: 'ACTION_RESULT', ok: true }));
    } finally {
      background.lockTab(17);
    }
  });

  it('still cancels a click when Charly moves to a tab the click did not open', async () => {
    await showOnlyExternalLink();
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'EXECUTE_ELEMENT_ACTION') background.lockTab(19);
      return { ok: true, clickDispatched: true };
    });
    try {
      const result = await background.proposeOrExecuteAction(1, 'Ouvre la publication Instagram');
      expect(result).toMatchObject({ ok: false, cancelled: true });
    } finally {
      background.lockTab(17);
    }
  });

  async function showPage(html) {
    document.body.innerHTML = html;
    const context = await background.getPageContext(17);
    background.lockTab(17);
    chromeMock.tabs.sendMessage.mockClear();
    sidebarMessages.length = 0;
    return label => Number(context.match(new RegExp(`\\[(\\d+)\\] clickable\\([a-z]+\\) "${label}"`))?.[1]);
  }

  const clicked = id => expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
    type: 'EXECUTE_ELEMENT_ACTION', id
  }));
  const notClicked = () => expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({
    type: 'EXECUTE_ELEMENT_ACTION'
  }));

  it.each(['Envoie le formulaire', 'Envoie le message', 'Clique sur Envoyer', 'Envoie'])(
    'sends a form of another site on an explicit request: %s',
    async wording => {
      const idOf = await showPage('<form><label for="m">Message</label><textarea id="m"></textarea><button type="submit">Envoyer</button></form>');
      const result = await background.proposeOrExecuteAction(idOf('Envoyer'), wording);
      expect(result).toMatchObject({ ok: true });
      clicked(idOf('Envoyer'));
    }
  );

  it('asks which form to send when the page holds several send buttons', async () => {
    const idOf = await showPage(`
      <form><input aria-label="Email newsletter"><button type="submit">S’abonner</button></form>
      <form><textarea aria-label="Message"></textarea><button type="submit">Envoyer</button></form>
    `);
    const result = await background.proposeOrExecuteAction(idOf('Envoyer'), 'Envoie le formulaire');
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    notClicked();
  });

  it('never sends a form the user did not ask to send', async () => {
    const idOf = await showPage('<form><textarea aria-label="Message"></textarea><button type="submit">Envoyer</button></form>');
    const result = await cancelApproval(background.proposeOrExecuteAction(idOf('Envoyer'), 'Que contient cette page ?'));
    expect(result).toMatchObject({ ok: false, cancelled: true });
    notClicked();
  });

  it('does not treat a bare "clique" as explicit for a consequential button', async () => {
    const idOf = await showPage('<button type="button">Supprimer le brouillon</button>');
    const vague = await cancelApproval(background.proposeOrExecuteAction(idOf('Supprimer le brouillon'), 'Clique'));
    expect(vague).toMatchObject({ ok: false, cancelled: true });
    notClicked();
    const named = await background.proposeOrExecuteAction(idOf('Supprimer le brouillon'), 'Clique sur Supprimer le brouillon');
    expect(named.ok).toBe(true);
  });

  it('persists the selected autonomy mode and requires approval for a safe click in ask mode', async () => {
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'ask' });
    expect((await background.handleMessage({ type: 'GET_SETTINGS' })).autonomyMode).toBe('ask');
    expect((await chromeMock.storage.local.get('charly_autonomy_mode_v1')).charly_autonomy_mode_v1).toBe('ask');
    const pending = background.proposeOrExecuteAction(1, 'Clique sur Documents');
    await vi.waitFor(() => expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(true));
    notClicked();
    const { actionId } = sidebarMessages.find(message => message.type === 'ACTION_PROPOSAL');
    await background.handleMessage({ type: 'CONFIRM_ACTION', actionId });
    const approved = await pending;
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
    clicked(1);
    const clicks = chromeMock.tabs.sendMessage.mock.calls.filter(([, msg]) => msg.type === 'EXECUTE_ELEMENT_ACTION').length;
    await background.handleMessage({ type: 'CONFIRM_ACTION', actionId });
    expect(chromeMock.tabs.sendMessage.mock.calls.filter(([, msg]) => msg.type === 'EXECUTE_ELEMENT_ACTION')).toHaveLength(clicks);
  });

  it('cancels an approval if its target page changes', async () => {
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'ask' });
    const pending = background.proposeOrExecuteAction(1, 'Clique sur Documents');
    await vi.waitFor(() => expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(true));
    const { actionId } = sidebarMessages.find(message => message.type === 'ACTION_PROPOSAL');
    chromeMock.tabs.get.mockResolvedValueOnce({ id: 17, url: 'https://different.example/', windowId: 1 });
    await background.handleMessage({ type: 'CONFIRM_ACTION', actionId });
    expect(await pending).toMatchObject({ cancelled: true });
    notClicked();
  });

  it('waits for approval before writing text in ask mode and resumes after confirmation', async () => {
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'ask' });
    const pending = background.typeVoiceText(5, 'Texte approuvé', undefined, 'Instructions');
    await vi.waitFor(() => expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(true));
    expect(chromeMock.tabs.sendMessage.mock.calls.some(([, msg]) => msg.type === 'TYPE_ELEMENT_TEXT')).toBe(false);
    const proposal = sidebarMessages.find(message => message.type === 'ACTION_PROPOSAL');
    expect(proposal.detail).toBe('Texte approuvé');
    await background.handleMessage({ type: 'CONFIRM_ACTION', actionId: proposal.actionId });
    const approved = await pending;
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
  });

  it.each([
    'Crée un rendez-vous demain de 15h à 16h',
    'Ajoute une réunion à mon agenda',
    'Modifie ce rendez-vous pour demain à 10h',
    'Schedule a meeting tomorrow at 3pm',
    'Enregistre les modifications'
  ])('saves the requested calendar task through a div role=button: %s', async request => {
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'balanced' });
    const idOf = await showPage('<main><h1>Calendrier — Nouvel événement</h1><div role="dialog"><h2>Nouvel événement</h2><input aria-label="Titre"><div role="button" tabindex="0">Enregistrer</div></div></main>');
    const result = await background.proposeOrExecuteAction(idOf('Enregistrer'), request, {
      toolExplicitRequest: true, targetLabel: 'Enregistrer'
    });
    expect(result.ok).toBe(true);
    clicked(idOf('Enregistrer'));
  });

  it.each([
    'Analyse cet événement',
    'Comment créer un rendez-vous ?',
    'Explique comment cliquer sur Enregistrer',
    'Crée un rendez-vous mais ne l’enregistre pas',
    'Crée un rendez-vous mais ne pas enregistrer',
    'Crée un rendez-vous sans l’enregistrer',
    'Crée un rendez-vous mais attends avant d’enregistrer',
    'Ne crée pas de rendez-vous',
    "Don't create an event"
  ])('does not infer permission to save from an information request or a withheld save: %s', async request => {
    const idOf = await showPage('<main><h1>Calendrier — Nouvel événement</h1><div role="dialog"><div role="button" tabindex="0">Enregistrer</div></div></main>');
    const pending = background.proposeOrExecuteAction(idOf('Enregistrer'), request, {
      toolExplicitRequest: true, targetLabel: 'Enregistrer'
    });
    const result = /sans|ne |attends|don.t/i.test(request) ? await pending : await cancelApproval(pending);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    notClicked();
  });

  it('does not use a calendar request to authorize a different resource or a payment save', async () => {
    const idOf = await showPage('<main><h1>Facturation</h1><button type="submit">Enregistrer</button></main>');
    expect((await cancelApproval(background.proposeOrExecuteAction(idOf('Enregistrer'), 'Crée un rendez-vous demain', {
      toolExplicitRequest: true, targetLabel: 'Enregistrer'
    }))).cancelled).toBe(true);
    notClicked();
    expect(background.classifyActionRisk({ type: 'clickable', text: 'Enregistrer', section: 'Paiement par carte bancaire' }, {
      userMessage: 'Crée un rendez-vous', pageContext: 'Calendrier'
    }).level).toBe('sensitive');
  });

  it('accepts a voice tool click on a consequential button only after a real request', async () => {
    const idOf = await showPage('<button type="button">Payer maintenant</button>');
    const question = await cancelApproval(background.proposeOrExecuteAction(idOf('Payer maintenant'), 'C’est quoi ce bouton ?', {
      toolExplicitRequest: true, targetLabel: 'Payer maintenant'
    }));
    expect(question).toMatchObject({ ok: false, cancelled: true });
    notClicked();
    const confirmation = await background.proposeOrExecuteAction(idOf('Payer maintenant'), 'Oui vas-y', {
      toolExplicitRequest: true, targetLabel: 'Payer maintenant'
    });
    expect(confirmation.ok).toBe(true);
  });

  it('executes a safe action marker without showing a confirmation card', async () => {
    const result = await background.proposeOrExecuteAction(1, 'Que contient cette page ?');
    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(false);
  });

  it('executes a consequential action when the user names it explicitly, without a confirmation card', async () => {
    const result = await background.proposeOrExecuteAction(2, 'Clique sur Sauvegarder');
    expect(result.ok).toBe(true);
    expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(false);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 2
    }));
  });

  it('opens a preparatory integration connection with the visual action path', async () => {
    const result = await background.proposeOrExecuteAction(3, 'Clique sur Connecter Google Drive');

    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 3
    }));
    expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(false);
  });

  it.each([
    'Sélectionne Connecter Google Drive',
    'Choisis Connecter Google Drive',
    'Vas sur Connecter Google Drive',
    'Continue avec Connecter Google Drive'
  ])('recognizes natural action wording: %s', async wording => {
    const result = await background.proposeOrExecuteAction(3, wording);
    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 3
    }));
  });

  it('rejects an explicit command when the chosen DOM target does not match it', async () => {
    const result = await background.proposeOrExecuteAction(3, 'Choisis Documents');
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      clarificationRequired: true,
      retryWithFreshContext: true,
      visualCapture: { mimeType: expect.stringMatching(/^image\//), data: expect.any(String) }
    });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION'
    }));
  });

  it('allows a named safe navigation as an intermediate step toward the requested goal', () => {
    const intent = background.resolveActionIntent(
      'Je veux connecter mon compte Gmail, emmène-moi là où je peux le faire.',
      { type: 'clickable', text: 'Intégrations', hrefPath: '/integrations/catalog', external: false, inForm: false, disabled: false },
      'Je vais d’abord ouvrir Intégrations pour chercher Gmail.'
    );
    expect(intent).toMatchObject({
      explicit: true,
      kind: 'direct',
      targetMatched: false,
      assistantMatched: true,
      safeIntermediateNavigation: true
    });
  });

  it('does not use the intermediate-step exception for a mismatched final button', () => {
    const intent = background.resolveActionIntent(
      'Connecte Gmail',
      { type: 'clickable', text: 'Connecter HubSpot', hrefPath: null, external: false, inForm: false, disabled: false },
      'Je vais connecter HubSpot.'
    );
    expect(intent).toMatchObject({
      explicit: false,
      targetMatched: false,
      safeIntermediateNavigation: false
    });
  });

  it('matches a poorly labelled button through its semantic aliases and card title', () => {
    const intent = background.resolveActionIntent(
      'Clique sur le bouton pour connecter Gmail',
      {
        type: 'clickable',
        text: 'Gmail',
        aliases: ['Connecter Gmail', 'connect gmail'],
        section: 'Gmail',
        actionKind: 'connection_setup',
        disabled: false
      },
      ''
    );

    expect(intent).toMatchObject({ explicit: true, targetMatched: true, kind: 'direct' });
  });

  it('derives a useful label from a generic control, card title and technical attributes', async () => {
    document.body.innerHTML = `
      <article class="integration-card">
        <h3>Notifications</h3>
        <button type="button" data-action="open-settings">Ouvrir</button>
      </article>
    `;
    const context = await background.getPageContext(17);

    expect(context).toContain('"Ouvrir"');
    expect(context).toContain('"Ouvrir Notifications"');
    expect(context).toContain('open settings');
  });

  it('maps only controls from the active modal and ignores the covered page', async () => {
    document.body.innerHTML = `
      <main><h1>Connexions</h1><button type="button">Tester l’agent</button></main>
      <section role="dialog" aria-modal="true">
        <h2>Connecter l’agent à mon site internet</h2>
        <button type="button">Copier</button>
      </section>
    `;

    const context = await background.getPageContext(17);

    expect(context).toContain('Surface active: fenêtre au premier plan uniquement');
    expect(context).toContain('Connecter l’agent à mon site internet');
    expect(context).toContain('"Copier"');
    expect(context).not.toContain('Connexions');
    expect(context).not.toContain('Tester l’agent');
  });

  it('executes an ordinary internal control selected by the agent even when the wording is implicit', async () => {
    document.body.innerHTML = '<button type="button">Afficher</button>';
    const context = await background.getPageContext(17);
    const buttonId = Number(context.match(/\[(\d+)\] clickable\(button\) "Afficher"/)?.[1]);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.proposeOrExecuteAction(buttonId, 'Montre-moi la suite', {
      targetLabel: 'Afficher'
    });

    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: buttonId
    }));
  });

  it.each(['Fais-le', 'Vas-y', 'Go ahead', 'Hazlo'])(
    'accepts a referential command only when the previous assistant turn names the target: %s',
    wording => {
      const element = { text: 'Connecter Gmail', hrefPath: null, actionKind: 'connection_setup' };
      expect(background.resolveActionIntent(wording, element, 'Je peux maintenant cliquer sur Connecter Gmail.')).toMatchObject({
        explicit: true,
        kind: 'referential',
        assistantMatched: true
      });
      expect(background.resolveActionIntent(wording, element, 'Je peux ouvrir une autre page.')).toMatchObject({
        explicit: false,
        kind: 'referential',
        assistantMatched: false
      });
    }
  );

  it('executes the consequential authorization step when the user names it explicitly', async () => {
    const result = await background.proposeOrExecuteAction(4, 'Clique sur Autoriser Google Drive');

    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: 4
    }));
  });

  it('infers the unlabeled composer send button and rejects a mismatched target', async () => {
    document.body.innerHTML = `
      <section id="composer">
        <textarea aria-label="Écris à Charly"></textarea>
        <button type="button" aria-label="Ajouter une pièce jointe"><svg></svg></button>
        <button type="button" title="Cliquez pour parler"><svg></svg></button>
        <button id="sendMessage" type="button"><svg></svg></button>
      </section>
    `;
    const context = await background.getPageContext(17);
    const attachmentId = Number(context.match(/\[(\d+)\] clickable\(button\) "Ajouter une pièce jointe"/)?.[1]);
    const sendId = Number(context.match(/\[(\d+)\] clickable\(button\) "Envoyer le message"/)?.[1]);
    expect(attachmentId).toBeGreaterThan(0);
    expect(sendId).toBeGreaterThan(0);
    chromeMock.tabs.sendMessage.mockClear();

    const wrongTarget = await background.proposeOrExecuteAction(attachmentId, 'Envoie le message');
    expect(wrongTarget).toMatchObject({
      ok: false,
      status: 'blocked',
      clarificationRequired: true,
      retryWithFreshContext: true
    });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION'
    }));

    const exactTarget = await background.proposeOrExecuteAction(sendId, 'Envoie le message');
    expect(exactTarget.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: sendId
    }));
  });

  it('recognises the Limova 3 arrow named "Envoyer" as the chat send button, only on Limova', async () => {
    const limova3Composer = `
      <div id="composer">
        <textarea placeholder="Dis-moi ce que tu as en tête..."></textarea>
        <button type="button" aria-label="Ajouter une pièce jointe" title="Ajouter une pièce jointe"><svg></svg></button>
        <button title="Cliquez pour parler"><svg></svg></button>
        <button type="button" aria-label="Envoyer"><svg></svg></button>
      </div>
    `;
    const previousUrl = window.location.href;
    try {
      jsdom.reconfigure({ url: 'https://staging.new.limova.ai/organizations/o/workspaces/w/chat/new' });
      document.body.innerHTML = limova3Composer;
      const context = await background.getPageContext(17);
      const sendId = Number(context.match(/\[(\d+)\] clickable\(button\) "Envoyer le message"/)?.[1]);
      expect(sendId).toBeGreaterThan(0);
      expect(context).not.toMatch(/clickable\(button\) "Envoyer"(?! le message)/);
      chromeMock.tabs.sendMessage.mockClear();

      const result = await background.proposeOrExecuteAction(sendId, 'Envoie le message');
      expect(result.ok).toBe(true);
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
        type: 'EXECUTE_ELEMENT_ACTION', id: sendId
      }));

      jsdom.reconfigure({ url: 'https://outside.example/contact' });
      document.body.innerHTML = limova3Composer;
      const outsideContext = await background.getPageContext(17);
      expect(outsideContext).toMatch(/clickable\(button\) "Envoyer"/);
      expect(outsideContext).not.toMatch(/"Envoyer le message"/);
    } finally {
      jsdom.reconfigure({ url: previousUrl });
    }
  });

  it('honors an indirect voice confirmation when the tool names the exact send target', async () => {
    document.body.innerHTML = `
      <section id="composer">
        <textarea aria-label="Écris à Charly"></textarea>
        <button type="button" aria-label="Ajouter une pièce jointe"><svg></svg></button>
        <button id="sendMessage" type="button"><svg></svg></button>
      </section>
    `;
    const context = await background.getPageContext(17);
    const sendId = Number(context.match(/\[(\d+)\] clickable\(button\) "Envoyer le message"/)?.[1]);
    expect(sendId).toBeGreaterThan(0);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.proposeOrExecuteAction(sendId, 'Oui, fais-le maintenant', {
      toolExplicitRequest: true,
      targetLabel: 'Envoyer le message'
    });

    expect(result.ok).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: sendId
    }));
  });

  it('routes an unambiguous voice text request to the current field without logging its value', async () => {
    const result = await background.typeVoiceText(5, 'Prépare un résumé concis');

    expect(result).toEqual({ ok: true, clarificationRequired: false, error: undefined });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: 'TYPE_ELEMENT_TEXT',
      id: 5,
      contextVersion: 1,
      text: 'Prépare un résumé concis'
    });
  });

  it('does not type after a text tool is superseded while checking consent', async () => {
    let finishConsent;
    const get = chromeMock.storage.local.get.getMockImplementation();
    chromeMock.storage.local.get.mockImplementation(key => key === 'limova_ai_processing_consent_v1'
      ? new Promise(resolve => { finishConsent = resolve; }) : get(key));
    const controller = new AbortController();
    try {
      const pending = background.executeCopilotTool({
        id: 'superseded-fill', name: 'fill_field', args: { elementId: 5, contextVersion: 1, text: 'Old instruction', targetLabel: 'Instructions' }
      }, 'Remplis Instructions', 'old-turn', controller.signal);
      await vi.waitFor(() => expect(finishConsent).toBeTypeOf('function'));
      controller.abort();
      finishConsent({ limova_ai_processing_consent_v1: true });
      expect(await pending).toMatchObject({ cancelled: true });
      expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({ type: 'TYPE_ELEMENT_TEXT' }));
    } finally {
      chromeMock.storage.local.get.mockImplementation(get);
    }
  });

  it('refreshes and remaps a field once when the SPA replaced the original DOM node', async () => {
    let attempts = 0;
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type !== 'TYPE_ELEMENT_TEXT') return { ok: true };
      attempts += 1;
      if (attempts === 1) {
        document.body.innerHTML = `
          <button type="button">Nouveau contrôle</button>
          <label for="replacement">Instructions</label><textarea id="replacement"></textarea>
        `;
        return { ok: false, error: 'Champ introuvable.' };
      }
      return { ok: true, inputVerified: true };
    });

    const result = await background.typeVoiceText(5, 'Prépare un résumé concis', 1);

    expect(result).toMatchObject({
      ok: true,
      clarificationRequired: false,
      error: undefined,
      resolvedElementId: 2,
      retargeted: true
    });
    const attemptsSent = chromeMock.tabs.sendMessage.mock.calls
      .map(([, message]) => message)
      .filter(message => message.type === 'TYPE_ELEMENT_TEXT');
    expect(attemptsSent).toHaveLength(2);
    expect(attemptsSent[0]).toMatchObject({ id: 5, contextVersion: 1 });
    expect(attemptsSent[1]).toMatchObject({ id: 2, contextVersion: 2 });
  });

  it('recovers a fill request that selected a button when the page has one writable field', async () => {
    document.body.innerHTML = `
      <label for="search">Rechercher des intégrations</label>
      <input id="search" type="search">
      <button type="button">Connecter Gmail</button>
    `;
    const context = await background.getPageContext(17);
    const searchId = Number(context.match(/\[(\d+)\] input\(search\) "Rechercher des intégrations"/)?.[1]);
    const buttonId = Number(context.match(/\[(\d+)\] clickable\(button\) "Connecter Gmail"/)?.[1]);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.typeVoiceText(buttonId, 'Gmail', 2);

    expect(result).toMatchObject({ ok: true, resolvedElementId: searchId, retargeted: true });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: 'TYPE_ELEMENT_TEXT', id: searchId, contextVersion: 2, text: 'Gmail'
    });
  });

  it('remaps a stale fill request from its preserved DOM snapshot', async () => {
    document.body.innerHTML = `
      <button type="button">Nouveau contrôle</button>
      <label for="replacement">Instructions</label><textarea id="replacement"></textarea>
    `;
    await background.getPageContext(17);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.typeVoiceText(5, 'Prépare un résumé concis', 1, 'Instructions');

    expect(result).toMatchObject({ ok: true, retargeted: true, resolvedElementId: 2 });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'TYPE_ELEMENT_TEXT', id: 2, text: 'Prépare un résumé concis'
    }));
  });

  it('keeps observing manual page interactions while a voice session is active', async () => {
    await background.handleMessage({ type: 'VOICE_SESSION_STATE', active: true }, {});

    const result = await background.handleMessage({
      type: 'USER_PAGE_INTERACTION',
      interaction: { kind: 'input', label: 'Instructions', zone: 'form' }
    }, { tab: { id: 17 } });

    expect(result).toMatchObject({ ok: true, contextVersion: expect.any(Number) });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, { type: 'SESSION_STATE', active: true });
  });

  it('marks a dispatched click as unverified when the page exposes no observable effect', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 17, active: true, windowId: 4, title: 'Limova', url: 'https://new.limova.ai/' });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue('data:image/jpeg;base64,QUJDRA==');
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'EXECUTE_ELEMENT_ACTION') return { ok: true, clickDispatched: true };
      if (message.type === 'PREPARE_VISUAL_CAPTURE') return { ok: true, maskedCount: 0, markerCount: 0 };
      return { ok: true };
    });

    const result = await background.proposeOrExecuteAction(1, 'Clique sur Documents');

    expect(result).toMatchObject({
      ok: true,
      status: 'unexpected',
      verificationRequired: true,
      effectObserved: false,
      visualCapture: { mimeType: 'image/jpeg', data: 'QUJDRA==' }
    });
  });

  it('executes the typed ADK fill tool on the exact current DOM field', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 17, active: true, windowId: 4, title: 'Limova', url: 'https://new.limova.ai/' });
    const result = await background.executeCopilotTool({
      id: 'call-fill-1',
      name: 'fill_field',
      args: { elementId: 5, contextVersion: 1, text: 'Prépare un résumé concis' }
    }, 'Écris un résumé concis dans Instructions', 'op-test');

    expect(result).toMatchObject({ callId: 'call-fill-1', status: 'ok' });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: 'TYPE_ELEMENT_TEXT', id: 5, contextVersion: 1, text: 'Prépare un résumé concis'
    });
    expect(JSON.stringify(sidebarMessages)).not.toMatch(/capture effectuée|screenshot/i);
  });

  it('accepts an exact low-risk voice tool target when the transcript wording is indirect', async () => {
    document.body.innerHTML = '<button type="button">Afficher</button>';
    const context = await background.getPageContext(17);
    const buttonId = Number(context.match(/\[(\d+)\] clickable\(button\) "Afficher"/)?.[1]);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.executeCopilotTool({
      id: 'call-indirect-1',
      name: 'click_element',
      args: { elementId: buttonId, contextVersion: 2, targetLabel: 'Afficher', explicitRequest: true }
    }, 'Celui-là s’il te plaît', 'op-indirect');

    expect(result).toMatchObject({ callId: 'call-indirect-1', status: 'ok' });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: buttonId
    }));
  });

  it('trusts the exact typed tool target when the spoken wording describes it differently', async () => {
    document.body.innerHTML = '<button type="button">Préférences</button>';
    const context = await background.getPageContext(17);
    const buttonId = Number(context.match(/\[(\d+)\] clickable\(button\) "Préférences"/)?.[1]);
    chromeMock.tabs.sendMessage.mockClear();

    const result = await background.executeCopilotTool({
      id: 'call-paraphrase-1',
      name: 'click_element',
      args: { elementId: buttonId, contextVersion: 2, targetLabel: 'Préférences', explicitRequest: true }
    }, 'Clique sur le deuxième choix', 'op-paraphrase');

    expect(result).toMatchObject({ callId: 'call-paraphrase-1', status: 'ok' });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, expect.objectContaining({
      type: 'EXECUTE_ELEMENT_ACTION', id: buttonId
    }));
  });

  it('executes a typed scroll and refreshes the DOM map', async () => {
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => message.type === 'EXECUTE_PAGE_SCROLL'
      ? { ok: true, moved: true, atStart: false, atEnd: false }
      : { ok: true });

    const result = await background.scrollVoicePage('down', 'medium', undefined, 1);

    expect(result).toMatchObject({ ok: true, moved: true, contextVersion: 2 });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: 'EXECUTE_PAGE_SCROLL', direction: 'down', amount: 'medium', contextVersion: 1
    });
  });

  it('uses the camera as a voice context refresh without starting legacy Gemini', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 17, active: true, windowId: 4, title: 'Limova', url: 'https://new.limova.ai/' });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue('data:image/jpeg;base64,QUJDRA==');
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => message.type === 'PREPARE_VISUAL_CAPTURE'
      ? { ok: true, maskedCount: 0, markerCount: 0 }
      : { ok: true });
    await background.handleMessage({ type: 'VOICE_SESSION_STATE', active: true }, {});
    globalThis.fetch.mockClear();

    const result = await background.handleTakeScreenshot();

    expect(result).toMatchObject({ ok: true, voiceSessionActive: true });
    expect(sidebarMessages).toContainEqual(expect.objectContaining({
      type: 'VOICE_PAGE_CONTEXT', source: 'manual_inspection'
    }));
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/gemini'), expect.anything());
  });

  it('keeps an autonomous recovery capture silent in the sidebar', async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 17, active: true, windowId: 4, title: 'Limova', url: 'https://new.limova.ai/' });
    chromeMock.tabs.captureVisibleTab.mockResolvedValueOnce('data:image/jpeg;base64,QUJDRA==');
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'PREPARE_VISUAL_CAPTURE') return { ok: true, maskedCount: 0, markerCount: 0 };
      return { ok: true };
    });

    const result = await background.executeCopilotTool({
      id: 'call-capture-1', name: 'capture_current_view', args: { reason: 'Cible ambiguë' }
    }, 'Clique dessus', 'op-capture');

    expect(result).toMatchObject({
      callId: 'call-capture-1', status: 'ok', capture: { mimeType: 'image/jpeg', data: 'QUJDRA==' }
    });
    expect(sidebarMessages).toEqual([]);
    expect(document.querySelector('#limova-visual-capture-overlays')).toBeNull();
  });

  it('refuses sensitive fields and asks for clarification when labels are duplicated', async () => {
    expect(await background.typeVoiceText(6, 'secret')).toMatchObject({ ok: false });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({ type: 'TYPE_ELEMENT_TEXT' }));

    document.body.innerHTML = `
      <label for="first">Instructions</label><textarea id="first"></textarea>
      <label for="second">Instructions</label><textarea id="second"></textarea>
    `;
    await background.getPageContext(17);
    chromeMock.tabs.sendMessage.mockClear();

    const ambiguous = await background.typeVoiceText(1, 'Texte');
    expect(ambiguous).toMatchObject({ ok: false, clarificationRequired: true });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(17, expect.objectContaining({ type: 'TYPE_ELEMENT_TEXT' }));
  });

  it('asks for approval for a sensitive action instead of refusing it', async () => {
    await background.handleMessage({ type: 'SET_AUTONOMY_MODE', mode: 'balanced' });
    const idOf = await showPage('<button type="button">Payer maintenant</button>');
    const pending = background.proposeOrExecuteAction(idOf('Payer maintenant'), 'Clique sur Payer maintenant');
    await vi.waitFor(() => expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(true));
    const proposal = sidebarMessages.find(message => message.type === 'ACTION_PROPOSAL');
    expect(sidebarMessages.some(message => message.code === 'ACTION_SENSITIVE_BLOCKED')).toBe(false);
    await background.handleMessage({ type: 'CONFIRM_ACTION', actionId: proposal.actionId });
    const approved = await pending;
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
  });

  it('does not claim success when no Limova tab is locked', async () => {
    background.handleResetSession();
    const result = await background.proposeOrExecuteAction(1, 'Clique');
    expect(result).toEqual({ ok: false, error: 'Aucun onglet Limova actif.' });
  });

  it('marks repeated action failures and OAuth popup churn as diagnostic failures', () => {
    const now = Date.now();
    const logs = [
      { timestamp: new Date(now - 5_000).toISOString(), component: 'action', code: 'ACTION_INTENT_MISMATCH' },
      { timestamp: new Date(now - 4_000).toISOString(), component: 'action', code: 'ACTION_SENSITIVE_BLOCKED' },
      { timestamp: new Date(now - 3_000).toISOString(), component: 'popup', code: 'EXTERNAL_AUTH_POPUP_OPENED' },
      { timestamp: new Date(now - 2_000).toISOString(), component: 'popup', code: 'EXTERNAL_AUTH_POPUP_OPENED' },
      { timestamp: new Date(now - 1_000).toISOString(), component: 'popup', code: 'EXTERNAL_AUTH_POPUP_CLOSED', data: { popupCount: 2 } }
    ];
    expect(background.summarizeRecentOperationalIssues(logs, now)).toMatchObject({
      blockedActionCount: 2,
      popupOpenedCount: 2,
      popupClosedCount: 1,
      maxPopupCount: 2,
      popupChurn: true
    });
  });
});
