// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('background privacy boundaries', () => {
  let chromeMock;
  let background;
  let originalOffsetParent;
  let originalRect;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));

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
    await chromeMock.storage.local.set({
      limova_ai_processing_consent_v1: true,
      charly_auth_session_v1: { token: 'test-charly-session-token-value', expiresAt: Date.now() + 60_000 }
    });
    document.head.innerHTML = '<title>Compte john.doe@example.com</title>';
    document.body.innerHTML = `
      <nav><a href="/documents/123456?token=url-secret">Documents</a></nav>
      <main>
        <h1>Bienvenue john.doe@example.com</h1>
        <form>
          <label for="email">Email</label>
          <input id="email" name="email" value="john.doe@example.com">
          <label for="password">Mot de passe</label>
          <input id="password" name="password" type="password" value="super-secret-password">
          <button type="submit">Sauvegarder</button>
        </form>
        <a href="https://third.example/private/john?secret=yes">Service externe</a>
        <div role="alert">Erreur pour john.doe@example.com au +33 6 12 34 56 78 avec eyJabcdefghijk.abcdefghijk.abcdefghijk</div>
      </main>
    `;
    window.history.replaceState({}, '', '/documents/123456?token=url-secret#private');
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: vi.fn(() => [
        {
          name: `${window.location.origin}/api/users/123456?token=network-secret`,
          initiatorType: 'fetch', responseStatus: 200, duration: 12.4
        },
        {
          name: 'https://third.example/private/john?email=john.doe@example.com',
          initiatorType: 'script', responseStatus: 204, duration: 42
        }
      ])
    });
    chromeMock.scripting.executeScript.mockImplementation(async ({ func, args = [] }) => [
      { result: await func(...args) }
    ]);
  });

  it('recaptures and locks a fresh Limova DOM map for voice even after session reset', async () => {
    chromeMock.tabs.query.mockResolvedValueOnce([{ id: 7, active: true, url: 'https://new.limova.ai/documents/123456' }]);

    const result = await background.getFreshVoiceContext();

    expect(result).toMatchObject({ ok: true, contextVersion: 1 });
    expect(result.elementCount).toBeGreaterThan(0);
    expect(result.pageContext).toContain('Bienvenue [email]');
    expect(result.pageContext).toContain('fetch /api/users/:id');
    expect(result.pageContext).not.toContain('super-secret-password');
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'SESSION_STATE', active: true });
  });

  it('captures only a prepared Limova viewport and always removes privacy overlays', async () => {
    chromeMock.tabs.get.mockResolvedValueOnce({ id: 7, windowId: 3, active: true, url: 'https://new.limova.ai/home' });
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'PREPARE_VISUAL_CAPTURE') return { ok: true, maskedCount: 2, markerCount: 4 };
      if (message.type === 'CLEAR_VISUAL_CAPTURE') return { ok: true };
      return undefined;
    });
    chromeMock.tabs.captureVisibleTab.mockResolvedValueOnce('data:image/jpeg;base64,QUJDRA==');

    const capture = await background.capturePageAnalysis(7);

    expect(capture).toEqual({ mimeType: 'image/jpeg', data: 'QUJDRA==' });
    expect(chromeMock.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 55 });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'CLEAR_VISUAL_CAPTURE' });
    chromeMock.tabs.sendMessage.mockResolvedValue(undefined);
  });

  it('returns useful DOM and network structure without secrets or direct identifiers', async () => {
    const context = await background.getPageContext(7);
    expect(context).toContain('input(password) "Mot de passe"');
    expect(context).toContain('= [filled] [sensitive]');
    expect(context).toContain('/documents/:id');
    expect(context).toContain('fetch /api/users/:id status:200 12ms');
    expect(context).toContain('script https://third.example status:204 42ms');
    expect(context).toContain('[email]');
    expect(context).toContain('[phone]');
    expect(context).toContain('[token]');

    expect(context).not.toContain('super-secret-password');
    expect(context).not.toContain('john.doe@example.com');
    expect(context).not.toContain('url-secret');
    expect(context).not.toContain('network-secret');
    expect(context).not.toContain('/private/john');
    expect(context).not.toContain('eyJabcdefghijk');
  });

  it('strips query strings, fragments and identifier-like path segments from URLs', () => {
    expect(background.privacySafeUrl('https://new.limova.ai/documents/123456?token=x#secret'))
      .toBe('https://new.limova.ai/documents/:id');
    expect(background.analyticsSafePath('https://new.limova.ai/workspaces/550e8400-e29b-41d4-a716-446655440000/settings'))
      .toBe('/workspaces/:id/settings');
  });

  it('redacts secrets and identifiers from diagnostic logs', () => {
    const sanitized = background.sanitizeDiagnostic(
      'Bearer abc.def.ghi email john@example.com phone +33612345678 https://api.test/path?token=secret api_key=abcd'
    );
    expect(sanitized).toContain('Bearer [redacted]');
    expect(sanitized).toContain('[email-redacted]');
    expect(sanitized).toContain('[phone-redacted]');
    expect(sanitized).toContain('https://api.test/path');
    expect(sanitized).toContain('api_key=[redacted]');
    expect(sanitized).not.toContain('john@example.com');
    expect(sanitized).not.toContain('token=secret');
  });

  it('classifies safe internal links and ordinary visible controls as low risk', () => {
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Ouvrir les documents', hrefPath: '/documents', external: false, inForm: false
    }).level).toBe('low');
    for (const element of [
      { type: 'clickable', text: 'Sauvegarder', inForm: true },
      { type: 'clickable', text: 'Supprimer', hrefPath: '/delete' },
      { type: 'clickable', text: 'Service externe', external: true },
      { type: 'clickable', text: 'Déconnecter Google Drive', buttonType: 'button', inForm: false },
      { type: 'clickable', text: 'Autoriser Google Drive', buttonType: 'button', inForm: false }
    ]) {
      expect(background.classifyActionRisk(element).level).toBe('sensitive');
    }
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Afficher', buttonType: 'button', inForm: false, external: false
    })).toMatchObject({ level: 'low', reason: 'visible_control' });
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Étape suivante', buttonType: 'button', inForm: true, external: false
    })).toMatchObject({ level: 'low', reason: 'visible_control' });
  });

  it('allows only the preparatory connection step outside forms', () => {
    for (const text of ['Connecter Google Drive', 'Reconnecter HubSpot', 'Configurer cette intégration']) {
      expect(background.classifyActionRisk({
        type: 'clickable', text, buttonType: 'button', inForm: false, external: false
      })).toMatchObject({ level: 'low', reason: 'connection_setup' });
    }
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Connecter Google Drive', buttonType: 'submit', inForm: true
    }).level).toBe('sensitive');
  });

  it('allows harmless visible controls autonomously and consequential ones only when explicitly requested', () => {
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Gmail', tag: 'div', inForm: false, external: false
    })).toMatchObject({ level: 'low', reason: 'visible_control' });
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Supprimer Gmail', tag: 'div', inForm: false, external: false
    }).level).toBe('sensitive');
    expect(background.classifyActionRisk({
      type: 'clickable', text: 'Supprimer Gmail', tag: 'div', inForm: false, external: false
    }, { explicitRequest: true })).toMatchObject({ level: 'low', reason: 'explicit_consequential_control' });
  });

  it('allows message sending only for the exact send target and an explicit send request', () => {
    const sendButton = {
      type: 'clickable', text: 'Envoyer le message', actionKind: 'message_send', inForm: false, external: false
    };
    expect(background.classifyActionRisk(sendButton, {
      explicitRequest: true,
      userMessage: 'Envoie le message'
    })).toMatchObject({ level: 'low', reason: 'explicit_message_send' });
    expect(background.classifyActionRisk(sendButton, {
      explicitRequest: true,
      userMessage: 'Clique quelque part'
    }).level).toBe('sensitive');
  });

  it('extracts the exact action label and integration name from a Limova tile', async () => {
    document.body.innerHTML = `
      <main>
        <div tabindex="0" class="integration-card">
          <div><img alt="Gmail"><h3>Gmail</h3><p>Connectez votre compte Gmail</p></div>
          <div><span>Connecter Gmail</span></div>
        </div>
      </main>
    `;

    const context = await background.getPageContext(7);

    expect(context).toContain('clickable(div) "Connecter Gmail"');
    expect(context).toContain('in:"Gmail"');
  });

  it('reconstructs a connection button purpose when the visible label is only the integration name', async () => {
    document.body.innerHTML = `
      <main>
        <article class="integration-card">
          <h3>Gmail</h3>
          <p>Connectez votre compte pour continuer</p>
          <div class="cursor-pointer" data-testid="connect-gmail"><span>Gmail</span></div>
        </article>
      </main>
    `;

    const context = await background.getPageContext(7);

    expect(context).toContain('clickable(div) "Connecter Gmail"');
    expect(context).toContain('in:"Gmail"');
    expect(context).not.toContain('data-testid');
  });

  it('keeps repeated generic buttons distinct by their surrounding card', async () => {
    document.body.innerHTML = `
      <main>
        <article class="integration-card"><h3>Gmail</h3><button>Ouvrir</button></article>
        <article class="integration-card"><h3>HubSpot</h3><button>Ouvrir</button></article>
      </main>
    `;

    const context = await background.getPageContext(7);

    expect(context.match(/clickable\(button\) "Ouvrir"/g)).toHaveLength(2);
    expect(context).toContain('in:"Gmail"');
    expect(context).toContain('in:"HubSpot"');
  });

  it('rejects invented element IDs and remaps a stale command only when unambiguous', () => {
    const original = new Map([[88, {
      type: 'input', text: 'Rechercher des intégrations', zone: 'main', section: 'Catalogue', inputType: 'search'
    }]]);
    const current = new Map([[4, {
      type: 'input', text: 'Rechercher des intégrations', zone: 'main', section: 'Catalogue', inputType: 'search'
    }]]);

    expect(background.resolveElementCommand(99, 5, original, 'highlight', 6, current)).toBeNull();
    expect(background.resolveElementCommand(88, 5, original, 'highlight', 6, current))
      .toEqual({ id: 4, contextVersion: 6 });

    current.set(7, { ...current.get(4) });
    expect(background.resolveElementCommand(88, 5, original, 'highlight', 6, current)).toBeNull();
  });

  it('uses the remote published revision for the live voice agent', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, active: true, url: 'https://new.limova.ai/integrations' }]);
    chromeMock.scripting.executeScript.mockResolvedValueOnce([{ result: { ok: true, status: 200, data: { accessToken: 'valid-access-token-for-tests-123', expiresIn: 300 } } }]);
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ revision: 'kb_test_42', results: [{
        id: 'article-gmail', title: 'Connecter Gmail', source: 'connecter-gmail', content: 'Ouvrez les intégrations puis cliquez sur Gmail.',
        actionHints: [{ order: 1, action: 'click', path: '/integrations', label: 'Connecter Gmail', target: { role: 'button', testId: 'connect-gmail', section: 'Gmail' }, expected: { path: '/integrations/accounts', network: ['POST /api/connect status:200'] } }]
      }] })
    });
    const result = await background.searchVoiceKnowledge('Comment connecter Gmail à Limova ?');
    expect(result.ok).toBe(true);
    expect(result.knowledge).toContain('Gmail');
    expect(result.knowledge).toContain('Ouvrez les intégrations');
    expect(result.knowledge).toContain('Empreintes d’action démontrées');
    expect(result.knowledge).toContain('test-id=connect-gmail');
    expect(result.knowledge).toContain('Page attendue : /integrations/accounts');
    expect(result.knowledge.length).toBeLessThanOrEqual(6_000);
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/knowledge/search'), expect.objectContaining({ method: 'POST' }));
  });

  it('does not resurrect retired embedded knowledge when the Studio is unavailable', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 7, active: true, url: 'https://new.limova.ai/integrations' }]);
    chromeMock.scripting.executeScript.mockResolvedValueOnce([{ result: { ok: true, status: 200, data: { accessToken: 'valid-access-token-for-fallback-123', expiresIn: 300 } } }]);
    globalThis.fetch.mockRejectedValueOnce(new Error('studio unavailable'));
    const result = await background.searchVoiceKnowledge('Comment connecter Gmail à Limova ?');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Aucun article pertinent');
  });
});
