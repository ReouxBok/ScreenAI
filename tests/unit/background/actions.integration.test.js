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

  it('never creates a pending confirmation for a sensitive action', async () => {
    const result = await background.proposeOrExecuteAction(2, 'Sauvegarde');
    expect(result.status).toBe('blocked');
    expect(sidebarMessages.some(message => message.type === 'ACTION_PROPOSAL')).toBe(false);
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
