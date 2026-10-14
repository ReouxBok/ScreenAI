import { test, expect } from './fixtures.js';

const PROXY_ORIGIN = 'https://limova-proxy-479c7fb78ccf.herokuapp.com';
const LIMOVA_ORIGIN = 'https://new.limova.ai';

const limovaFixture = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <title>Tableau de bord Limova</title>
    <style>
      body { font: 16px sans-serif; margin: 40px; }
      button, a, input { display: block; width: 260px; height: 42px; margin: 12px 0; }
      button svg { width: 16px; height: 16px; }
      [role="dialog"] { position: fixed; inset: 20% 25%; z-index: 200; background: white; border: 2px solid #555; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tableau de bord</h1>
      <p>Bienvenue dans votre espace Limova.</p>
      <label for="privateField">Clé privée</label>
      <input id="privateField" type="password" value="NEVER_TRANSMIT_THIS_SECRET">
      <label for="briefField">Instructions</label>
      <textarea id="briefField" placeholder="Décris la tâche"></textarea>
      <button id="sensitiveAction" type="button" onclick="this.dataset.clicked='true'">Supprimer le brouillon</button>
      <button id="connectHubspot" type="button" onclick="this.dataset.clicked='true'"><svg aria-hidden="true" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg><span class="button-label">Connecter HubSpot</span></button>
      <a id="safeNavigation" href="/profil">Ouvrir mon profil</a>
      <section id="composer">
        <textarea id="composerField" aria-label="Écris à Charly"></textarea>
        <button id="attachmentButton" type="button" aria-label="Ajouter une pièce jointe"><svg></svg></button>
        <button id="composerMic" type="button" title="Cliquez pour parler"><svg></svg></button>
        <button id="sendMessage" type="button" onclick="this.dataset.clicked='true'"><svg></svg></button>
      </section>
      <div aria-hidden="true" style="height: 1800px"></div>
    </main>
  </body>
</html>`;

async function stubTrainingScreenRecording(sidebar) {
  await sidebar.evaluate(() => {
    window.LimovaTrainingScreenRecorder = class {
      async start() { return { displaySurface: 'monitor' }; }
      async beginProgressiveUpload() {}
      async stopAndUpload({ onProgress }) {
        onProgress?.({ percentage: 100 });
        return { size: 1024, durationMs: 2_000 };
      }
      abort() {}
    };
  });
}

async function installExternalContracts(context, {
  geminiReply,
  geminiStatuses = [],
  serverOrchestration = false,
  adkTurn
} = {}) {
  const calls = { gemini: [], adkTurns: [], adkResults: [], copilotSessions: [], liveToken: [], health: [], training: [], evaluations: [], onboardingTemplate: [], bootstrap: [] };
  const copilotSessionId = '550e8400-e29b-41d4-a716-446655440000';

  await context.route(`${LIMOVA_ORIGIN}/**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: limovaFixture
  }));

  await context.route('https://oauth.hubspot.test/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Autoriser HubSpot</title><h1>Autorisation HubSpot</h1><button>Continuer</button>'
  }));

  await context.route('https://accounts.google.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Autoriser Gmail</title><h1>Autorisation Gmail</h1><button>Continuer</button>'
  }));

  await context.route('https://studio.limova.ai/api/training/sessions/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    calls.training.push(request);
    if (pathname.endsWith('/connect')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'training-e2e', title: 'Campagne sociale', goal: 'Créer un premier brouillon', agentKey: 'charly', startPath: '/dashboard' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await context.route('https://studio.limova.ai/api/evaluations/runs/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    calls.evaluations.push(request);
    if (pathname.endsWith('/connect')) return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: { id: 'evaluation-run-e2e', status: 'running' },
        case: { id: 'evaluation-case-e2e', kind: 'live_action', title: 'Connecter HubSpot', prompt: 'Connecte HubSpot' },
        content: { id: 'evaluation-content-e2e', versionId: 'evaluation-version-e2e', title: 'Connecter HubSpot' }
      })
    });
    if (pathname.endsWith('/complete')) return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ run: { id: 'evaluation-run-e2e', status: 'passed', score: 100 }, suite: { status: 'passed', score: 100 } })
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await context.route(`${PROXY_ORIGIN}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/healthz') {
      calls.health.push(request);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', service: 'limova-proxy' })
      });
    }
    if (pathname === '/api/live-token') {
      calls.liveToken.push(request);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'auth_tokens/e2e-voice-token',
          model: 'gemini-3.1-flash-live-preview',
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })
      });
    }
    if (pathname === '/api/onboarding/template') {
      calls.onboardingTemplate.push(request);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          revision: 'onboarding_e2e',
          version: 1,
          name: 'Trame Charly E2E',
          openingPrompt: 'Demande le sujet que le membre veut traiter.',
          fallbackPrompt: 'Propose un parcours adapté sans forcer.',
          steps: [{ id: 'start-e2e', contentItemId: 'content-e2e', name: 'Premier parcours E2E', depth: 0, trigger: 'quand le membre veut commencer', optional: false, expectedUrls: ['/dashboard'], kbQueries: ['premier parcours'], successCriteria: ['Parcours lancé'], description: 'Guider le membre sur son premier parcours.', completionHint: 'Le parcours est lancé.' }]
        })
      });
    }
    if (pathname === '/api/copilot/bootstrap') {
      calls.bootstrap.push(request);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          enabled: true,
          serverOrchestration,
          sessionId: copilotSessionId,
          sessionRevision: `session_${copilotSessionId}_1`,
          promptRevision: 'prompt_e2e',
          recentMessages: [],
          goals: [],
          memories: [],
          greeting: null
        })
      });
    }
    if (pathname === '/api/copilot/v2/sessions') {
      calls.copilotSessions.push(request);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: copilotSessionId, sessionRevision: `session_${copilotSessionId}_2`, promptRevision: 'prompt_e2e' })
      });
    }
    if (pathname === '/api/copilot/v2/turn') {
      const body = request.postDataJSON();
      calls.adkTurns.push(request);
      const payload = typeof adkTurn === 'function'
        ? adkTurn({ phase: 'turn', body, index: calls.adkTurns.length - 1 })
        : { type: 'message', sessionId: copilotSessionId, content: 'Réponse ADK E2E reçue.' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (/^\/api\/copilot\/v2\/runs\/[^/]+\/result$/.test(pathname)) {
      const body = request.postDataJSON();
      calls.adkResults.push(request);
      const payload = typeof adkTurn === 'function'
        ? adkTurn({ phase: 'result', body, index: calls.adkResults.length - 1 })
        : { type: 'message', sessionId: copilotSessionId, content: 'Action ADK vérifiée.' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (pathname === '/api/gemini') {
      const index = calls.gemini.length;
      calls.gemini.push(request);
      const body = request.postDataJSON();
      const status = geminiStatuses[index] || 200;
      if (status !== 200) {
        return route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: status === 401 ? 'Expired token' : 'Service IA indisponible' } })
        });
      }
      const text = typeof geminiReply === 'function'
        ? geminiReply({ body, index })
        : (geminiReply || 'Réponse Gemini E2E reçue.');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
      });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });

  return calls;
}

async function openExtensionHarness(context, extensionId, options) {
  const calls = await installExternalContracts(context, options);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async ({ token, expiresAt }) => {
    await chrome.storage.local.set({
      charly_auth_session_v1: { token, expiresAt }
    });
  }, {
    token: `e2e-${'x'.repeat(48)}`,
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  const limova = await context.newPage();
  await limova.goto(`${LIMOVA_ORIGIN}/dashboard?private_token=must-not-leak`);
  const browserSession = await context.browser().newBrowserCDPSession();
  const targets = (await browserSession.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
  const limovaTarget = targets.find(target => target.url.startsWith(LIMOVA_ORIGIN));
  if (!limovaTarget) throw new Error('Limova tab target missing');
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: limovaTarget.targetId });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pageTargets = (await browserSession.send('Target.getTargets')).targetInfos;
    if (pageTargets.some(target => target.url === `chrome-extension://${extensionId}/src/sidebar/sidebar.html`)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await browserSession.detach();
  const sidebar = await context.newPage();
  await sidebar.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await sidebar.waitForFunction(() => document.documentElement.lang !== '');
  await limova.bringToFront();
  return { calls, limova, sidebar };
}

async function grantAIConsent(sidebar) {
  const result = await sidebar.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'AI_PROCESSING_CONSENT', granted: true })
  );
  expect(result).toEqual({ ok: true });
}

test.describe('Packaged extension — complete user flows', () => {

  test('a contributor evaluates a draft in the real extension before review', async ({ context, extensionId }) => {
    const evaluationCode = 'evaluation-code-e2e-that-is-long-enough';
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId, {
      serverOrchestration: true,
      adkTurn: ({ phase, body, index }) => {
        if (phase === 'turn') {
          const elementId = Number(body.page.dom.match(/\[(\d+)\] clickable\(button\) "Connecter HubSpot"/)?.[1]);
          return {
            type: 'tool_call', sessionId: body.sessionId, runId: 'db0e8400-e29b-41d4-a716-446655440000', expiresAt: new Date(Date.now() + 60_000).toISOString(),
            call: { id: 'evaluation-click', name: 'click_element', args: { elementId, contextVersion: body.page.contextVersion, targetLabel: 'Connecter HubSpot' } }
          };
        }
        if (index === 0) return {
          type: 'tool_call', sessionId: '550e8400-e29b-41d4-a716-446655440000', runId: 'eb0e8400-e29b-41d4-a716-446655440000', expiresAt: new Date(Date.now() + 60_000).toISOString(),
          call: { id: 'evaluation-verify', name: 'verify_expected_result', args: { expectation: 'Le bouton HubSpot a été activé', contextVersion: body.contextVersion } }
        };
        return { type: 'message', sessionId: '550e8400-e29b-41d4-a716-446655440000', content: 'Le parcours brouillon a été exécuté et vérifié.' };
      }
    });
    await grantAIConsent(sidebar);
    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#evaluationBtn').click();
    await sidebar.locator('#evaluationToken').fill(evaluationCode);
    await sidebar.locator('#evaluationStart').click();
    await expect(sidebar.locator('.message.system .message-content')).toContainText('Test réel actif');

    const evaluationLiveToken = await sidebar.evaluate(() => chrome.runtime.sendMessage({
      type: 'GET_LIVE_TOKEN',
      context: { trainingMode: false }
    }));
    expect(evaluationLiveToken).toMatchObject({ ok: true, token: 'auth_tokens/e2e-voice-token' });
    expect(calls.liveToken.at(-1).postDataJSON()).toMatchObject({ evaluationCode, history: [] });
    expect(calls.liveToken.at(-1).postDataJSON()).not.toHaveProperty('sessionId');

    await sidebar.locator('#userInput').fill('Connecte HubSpot');
    await sidebar.locator('#sendBtn').click();
    await expect(limova.locator('#connectHubspot')).toHaveAttribute('data-clicked', 'true');
    await expect(sidebar.locator('.message.assistant .message-content')).toContainText('exécuté et vérifié');
    expect(calls.adkTurns[0].postDataJSON()).toMatchObject({ evaluationCode });
    expect(calls.adkResults).toHaveLength(2);

    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#evaluationBtn').click();
    await sidebar.locator('#evaluationCorrect').click();
    await expect(sidebar.locator('#evaluationFeedback')).toContainText('Test réussi · 100/100');
    const evaluationPaths = calls.evaluations.map(request => new URL(request.url()).pathname);
    expect(evaluationPaths).toContain('/api/evaluations/runs/connect');
    expect(evaluationPaths).toContain('/api/evaluations/runs/events');
    expect(evaluationPaths).toContain('/api/evaluations/runs/complete');
  });

  test('training mode records useful controls but never field or password values', async ({ context, extensionId }) => {
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId);
    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#trainingBtn').click();
    await expect(sidebar.locator('#trainingPanel')).toBeVisible();
    await sidebar.locator('#trainingToken').fill('training-token-e2e-that-is-long-enough');
    await stubTrainingScreenRecording(sidebar);
    await sidebar.locator('#trainingStart').click();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Écran entier enregistré');
    await expect(sidebar.locator('#trainingMic')).toBeVisible();
    await grantAIConsent(sidebar);
    await sidebar.evaluate(() => chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', role: 'user', text: 'Je montre comment préparer la campagne.' }));

    await limova.locator('#briefField').fill('UNE VALEUR PRIVÉE À NE JAMAIS ENVOYER');
    await limova.locator('#briefField').blur();
    await limova.locator('#connectHubspot circle').click();
    await limova.evaluate(() => fetch('/api/integrations/connect', { method: 'POST' }));

    await limova.evaluate(() => {
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.innerHTML = '<h2>Connecter HubSpot</h2><button type="button">Continuer</button>';
      document.body.appendChild(modal);
    });
    await expect.poll(() => calls.training
      .filter(request => request.url().endsWith('/events'))
      .map(request => request.postData() || '')
      .join('\n')).toContain('Popup Limova · Connecter HubSpot');

    const popupPromise = context.waitForEvent('page');
    await limova.evaluate(() => window.open(
      'https://oauth.hubspot.test/authorize',
      'hubspot-oauth',
      'popup,width=500,height=600'
    ));
    const oauthPopup = await popupPromise;
    await oauthPopup.waitForLoadState();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Fenêtre de connexion externe ouverte');
    await expect(sidebar.locator('#tabWarning')).toBeHidden();

    const transientPopupPromise = context.waitForEvent('page');
    await limova.evaluate(() => window.open(
      'https://oauth.hubspot.test/intermediate',
      'hubspot-oauth-intermediate',
      'popup,width=480,height=580'
    ));
    const transientPopup = await transientPopupPromise;
    await transientPopup.waitForLoadState();
    await oauthPopup.close();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Fenêtre de connexion externe ouverte');
    await expect(sidebar.locator('#tabWarning')).toBeHidden();
    await transientPopup.close();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Charly relit maintenant');

    await limova.locator('#safeNavigation').click();
    await expect.poll(() => calls.training.filter(request => request.url().endsWith('/events')).length).toBeGreaterThanOrEqual(8);

    await sidebar.locator('#trainingStop').click();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Démonstration et vidéo enregistrées');
    const trainingEvents = calls.training
      .filter(request => request.url().endsWith('/events'))
      .map(request => request.postDataJSON());
    const eventBodies = trainingEvents.map(event => JSON.stringify(event)).join('\n');
    expect(eventBodies).toContain('Instructions');
    expect(eventBodies).toContain('Connecter HubSpot');
    expect(eventBodies).toContain('Ouvrir mon profil');
    expect(eventBodies).toContain('Je montre comment préparer la campagne.');
    expect(eventBodies).toContain('Fenêtre d’autorisation externe ouverte');
    expect(eventBodies).toContain('Fenêtre d’autorisation externe fermée');
    expect(eventBodies).not.toContain('UNE VALEUR PRIVÉE');
    expect(eventBodies).not.toContain('NEVER_TRANSMIT_THIS_SECRET');
    expect(calls.training.some(request => request.url().endsWith('/complete'))).toBe(true);
    expect(trainingEvents.filter(event => event.label === 'Fenêtre d’autorisation externe ouverte')).toHaveLength(1);
    expect(trainingEvents.filter(event => event.label === 'Fenêtre d’autorisation externe fermée')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ popupCount: 2 }) })
    ]);

    const clickEvents = trainingEvents.filter(event => event.kind === 'click');
    expect(clickEvents).toContainEqual(expect.objectContaining({
      label: 'Connecter HubSpot',
      payload: expect.objectContaining({
        controlName: 'Connecter HubSpot',
        controlType: 'bouton',
        tag: 'button',
        clickedTag: 'circle',
        elementId: 'connectHubspot',
        zone: 'main',
        occurrence: 1,
        gestureId: expect.stringMatching(/^[-a-z0-9]+$/i)
      })
    }));
    expect(trainingEvents).toContainEqual(expect.objectContaining({
      kind: 'page_context',
      label: 'Résultat après clic · Connecter HubSpot',
      payload: expect.objectContaining({
        phase: 'after_click',
        networkSummary: expect.stringContaining('POST /api/integrations/connect status:200')
      })
    }));
  });

  test('sequential Gmail OAuth windows stay one stable flow without a wrong-tab warning', async ({ context, extensionId }) => {
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId);
    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#trainingBtn').click();
    await sidebar.locator('#trainingToken').fill('training-token-gmail-oauth-e2e-long-enough');
    await stubTrainingScreenRecording(sidebar);
    await sidebar.locator('#trainingStart').click();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Écran entier enregistré');

    const firstPopupPromise = context.waitForEvent('page');
    await limova.evaluate(() => window.open(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=redacted',
      'gmail-oauth-first',
      'popup,width=500,height=620'
    ));
    const firstPopup = await firstPopupPromise;
    await firstPopup.waitForLoadState();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Fenêtre de connexion externe ouverte');
    await expect(sidebar.locator('#tabWarning')).toBeHidden();
    await firstPopup.close();

    // Google can replace a short-lived account chooser with a second window.
    // The three-second grace period must keep both tabs in one OAuth lifecycle.
    await new Promise(resolve => setTimeout(resolve, 800));
    const secondPopupPromise = context.waitForEvent('page');
    await limova.evaluate(() => window.open(
      'https://accounts.google.com/signin/oauth/consent?client_id=redacted',
      'gmail-oauth-second',
      'popup,width=500,height=620'
    ));
    const secondPopup = await secondPopupPromise;
    await secondPopup.waitForLoadState();
    await expect(sidebar.locator('#tabWarning')).toBeHidden();
    await secondPopup.close();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Charly relit maintenant', { timeout: 6_000 });

    await sidebar.locator('#trainingStop').click();
    await expect(sidebar.locator('#trainingFeedback')).toContainText('Démonstration et vidéo enregistrées');
    const trainingEvents = calls.training
      .filter(request => request.url().endsWith('/events'))
      .map(request => request.postDataJSON());
    expect(trainingEvents.filter(event => event.label === 'Fenêtre d’autorisation externe ouverte')).toHaveLength(1);
    expect(trainingEvents.filter(event => event.label === 'Fenêtre d’autorisation externe fermée')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ popupCount: 2 }) })
    ]);
  });



  test('a safe action displays a computer-use cursor and clicks without confirmation', async ({ context, extensionId }) => {
    const { limova, sidebar } = await openExtensionHarness(context, extensionId, {
      geminiReply: ({ body }) => {
        const prompt = body.systemInstruction.parts[0].text;
        const profileId = prompt.match(/\[(\d+)\] clickable\(a\) "Ouvrir mon profil"/)?.[1];
        return `J’ouvre ton profil. {{ACTION:${profileId}}}`;
      }
    });
    await grantAIConsent(sidebar);
    await sidebar.locator('#screenshotBtn').click();

    await expect(sidebar.locator('.action-card')).toHaveCount(0);
    await expect(limova.locator('#limova-computer-use-pointer')).toBeVisible();
    await expect(limova).toHaveURL(`${LIMOVA_ORIGIN}/profil`);
  });

  test('SPA navigation and a newly opened modal each trigger automatic contextual analysis', async ({ context, extensionId }) => {
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId, {
      geminiReply: ({ index }) => `Analyse automatique ${index + 1}`
    });
    await grantAIConsent(sidebar);
    await sidebar.locator('#userInput').fill('Commence le parcours');
    await sidebar.locator('#sendBtn').click();
    await expect.poll(() => calls.gemini.length).toBe(1);

    await limova.evaluate(() => {
      setTimeout(() => history.pushState({}, '', '/integrations'), 2200);
    });
    await expect.poll(() => calls.gemini.length, { timeout: 8_000 }).toBe(2);

    await limova.evaluate(() => {
      setTimeout(() => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.textContent = 'Connexion réussie';
        document.body.appendChild(dialog);
      }, 2200);
    });
    await expect.poll(() => calls.gemini.length, { timeout: 8_000 }).toBe(3);
    await expect(sidebar.locator('.message.assistant .message-content').last()).toContainText('Analyse automatique 3');
  });

  test('voice obtains its constrained token, connects through Gemini Live and stores the transcript', async ({ mediaContext, mediaExtensionId }) => {
    const context = mediaContext;
    const extensionId = mediaExtensionId;
    const socketMessages = [];
    let liveSocket;
    await context.routeWebSocket(/generativelanguage\.googleapis\.com\/ws\//, socket => {
      liveSocket = socket;
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        socketMessages.push(message);
        if (message.setup) socket.send(Buffer.from(JSON.stringify({ setupComplete: {} })));
      });
    });
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId);
    const deprecatedAudioWarnings = [];
    sidebar.on('console', message => {
      if (/ScriptProcessorNode|createScriptProcessor/i.test(message.text())) {
        deprecatedAudioWarnings.push(message.text());
      }
    });
    await grantAIConsent(sidebar);

    await sidebar.locator('#voiceBtn').click();

    await expect.poll(() => calls.liveToken.length).toBe(1);
    await expect(sidebar.locator('#statusBadge')).toContainText(/Listening|écoute|escucho/i);
    expect(socketMessages[0].setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(socketMessages[0].setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    const voiceDiagnostics = await sidebar.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_LOGS' }));
    expect(voiceDiagnostics.logs).not.toContain('VISUAL_CAPTURE_READY');
    expect(socketMessages.some(message => message.realtimeInput?.video)).toBe(false);
    await expect.poll(() => socketMessages.some(message =>
      message.realtimeInput?.audio?.mimeType === 'audio/pcm;rate=16000'
      && message.realtimeInput.audio.data.length > 0
    )).toBe(true);
    expect(deprecatedAudioWarnings).toEqual([]);
    expect(calls.liveToken[0].headers().authorization).toBe(`Bearer e2e-${'x'.repeat(48)}`);
    const liveTokenPayload = calls.liveToken[0].postDataJSON();
    expect(liveTokenPayload.pageContext).toContain('Tableau de bord');
    expect(liveTokenPayload.pageContext).toMatch(/\[\d+\] clickable\(a\) "Ouvrir mon profil"/);
    const profileElementId = Number(liveTokenPayload.pageContext.match(/\[(\d+)\] clickable\(a\) "Ouvrir mon profil"/)?.[1]);
    const briefElementId = Number(liveTokenPayload.pageContext.match(/\[(\d+)\] input\(textarea\) "Instructions"/)?.[1]);
    const attachmentElementId = Number(liveTokenPayload.pageContext.match(/\[(\d+)\] clickable\(button\) "Ajouter une pièce jointe"/)?.[1]);
    const sendElementId = Number(liveTokenPayload.pageContext.match(/\[(\d+)\] clickable\(button\) "Envoyer le message"/)?.[1]);
    expect(profileElementId).toBeGreaterThan(0);
    expect(briefElementId).toBeGreaterThan(0);
    expect(attachmentElementId).toBeGreaterThan(0);
    expect(sendElementId).toBeGreaterThan(0);
    expect(liveTokenPayload.pageContext).not.toContain('NEVER_TRANSMIT_THIS_SECRET');
    expect(liveTokenPayload.pageContext).not.toContain('private_token');

    await sidebar.locator('#screenshotBtn').click();
    await expect.poll(() => socketMessages.some(message =>
      message.realtimeInput?.video?.mimeType === 'image/jpeg'
    )).toBe(true);
    expect(calls.gemini).toHaveLength(0);
    await expect(sidebar.locator('.screenshot-bubble')).toHaveCount(0);
    const visualFramesAfterManualInspection = socketMessages.filter(message => message.realtimeInput?.video).length;

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{ id: 'inspect-e2e', name: 'inspect_current_page', args: {} }]
      }
    }));
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'inspect-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({
      status: 'ok',
      elementCount: expect.any(Number)
    });
    const inspected = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'inspect-e2e'
    ).toolResponse.functionResponses[0].response;
    expect(inspected.pageContext).toContain('Tableau de bord');
    expect(inspected.pageContext).not.toContain('NEVER_TRANSMIT_THIS_SECRET');
    expect(socketMessages.filter(message => message.realtimeInput?.video)).toHaveLength(visualFramesAfterManualInspection);

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'scroll-e2e',
          name: 'scroll_page',
          args: {
            direction: 'down',
            amount: 'medium',
            contextVersion: inspected.contextVersion
          }
        }]
      }
    }));
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'scroll-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({ status: 'ok' });
    await expect.poll(() => limova.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const scrolled = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'scroll-e2e'
    ).toolResponse.functionResponses[0].response;

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'kb-e2e',
          name: 'search_knowledge_base',
          args: { query: 'Comment connecter Gmail à Limova ?' }
        }]
      }
    }));
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'kb-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({
      status: 'blocked'
    });
    const knowledgeResponse = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'kb-e2e'
    ).toolResponse.functionResponses[0].response;
    expect(knowledgeResponse.reason).toContain('Aucun article pertinent');
    expect(JSON.stringify(knowledgeResponse)).not.toContain('Connecter Gmail');

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'type-e2e',
          name: 'fill_field',
          args: {
            elementId: briefElementId,
            contextVersion: scrolled.contextVersion,
            text: 'Prépare un résumé concis'
          }
        }]
      }
    }));
    await expect(limova.locator('#limova-computer-use-pointer')).toBeVisible();
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'type-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({ status: 'ok' });
    await expect(limova.locator('#briefField')).toHaveValue('Prépare un résumé concis');
    const typed = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'type-e2e'
    ).toolResponse.functionResponses[0].response;
    expect(typed.pageContext).toContain(`[${briefElementId}] input(textarea) "Instructions" = [filled]`);
    expect(typed.pageContext).not.toContain('Prépare un résumé concis');

    liveSocket.send(JSON.stringify({
      serverContent: {
        inputTranscription: { text: 'Envoie le message' },
        turnComplete: true
      }
    }));
    await expect(sidebar.locator('.message.user .message-content').last()).toContainText('Envoie le message');
    await expect.poll(() => socketMessages.some(message =>
      message.clientContent?.turnComplete === true
      && message.clientContent.turns?.[0]?.parts?.[0]?.text?.includes('[RELANCE TECHNIQUE')
    )).toBe(true);

    const visualFramesBeforeBlockedAction = socketMessages.filter(message => message.realtimeInput?.video).length;
    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'wrong-send-e2e',
          name: 'click_element',
          args: {
            elementId: attachmentElementId,
            contextVersion: typed.contextVersion,
            targetLabel: 'Ajouter une pièce jointe',
            explicitRequest: true
          }
        }]
      }
    }));
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'wrong-send-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({
      status: 'ambiguous',
      clarificationRequired: true,
      retryWithFreshContext: true,
      contextVersion: expect.any(Number)
    });
    await expect.poll(() => socketMessages.filter(message =>
      message.realtimeInput?.video?.mimeType === 'image/jpeg'
    ).length).toBeGreaterThan(visualFramesBeforeBlockedAction);
    await expect(limova.locator('#attachmentButton')).not.toHaveAttribute('data-clicked', 'true');
    await expect(limova.locator('#limova-visual-capture-overlays')).toHaveCount(0);
    await expect(sidebar.getByText(/capture (effectuée|prise)/i)).toHaveCount(0);

    const rejected = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'wrong-send-e2e'
    ).toolResponse.functionResponses[0].response;

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'send-e2e',
          name: 'click_element',
          args: {
            elementId: sendElementId,
            contextVersion: rejected.contextVersion,
            targetLabel: 'Envoyer le message',
            explicitRequest: true
          }
        }]
      }
    }));
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'send-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({ status: 'ok' });
    await expect(limova.locator('#sendMessage')).toHaveAttribute('data-clicked', 'true');

    const sent = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'send-e2e'
    ).toolResponse.functionResponses[0].response;

    liveSocket.send(JSON.stringify({
      serverContent: { outputTranscription: { text: 'Le message a bien été envoyé.' }, turnComplete: true }
    }));
    await expect(sidebar.locator('.message.assistant .message-content').last()).toContainText('Le message a bien été envoyé.');

    liveSocket.send(JSON.stringify({
      serverContent: { outputTranscription: { text: 'Je peux ouvrir mon profil maintenant.' }, turnComplete: true }
    }));
    await expect(sidebar.locator('.message.assistant .message-content').last()).toContainText('Je peux ouvrir mon profil');

    liveSocket.send(JSON.stringify({
      serverContent: {
        inputTranscription: { text: 'Vas-y' },
        turnComplete: true
      }
    }));
    await expect(sidebar.locator('.message.user .message-content').last()).toContainText('Vas-y');

    liveSocket.send(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: 'action-e2e',
          name: 'navigate_internal',
          args: {
            elementId: profileElementId,
            contextVersion: sent.contextVersion,
            targetLabel: 'Ouvrir mon profil'
          }
        }]
      }
    }));
    await expect(limova).toHaveURL(`${LIMOVA_ORIGIN}/profil`);
    await expect.poll(() => socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'action-e2e'
    )?.toolResponse.functionResponses[0].response).toMatchObject({ status: 'ok' });
    const postAction = socketMessages.find(message =>
      message.toolResponse?.functionResponses?.[0]?.id === 'action-e2e'
    ).toolResponse.functionResponses[0].response;
    expect(postAction.pageContext).toContain('/profil');
    expect(postAction.pageContext).not.toContain('NEVER_TRANSMIT_THIS_SECRET');
    expect(postAction.contextVersion).toBeGreaterThan(sent.contextVersion);
    expect(calls.gemini).toHaveLength(0);

    liveSocket.send(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Réponse vocale E2E' },
        turnComplete: true
      }
    }));
    await expect(sidebar.locator('.message.assistant .message-content').last()).toContainText('Réponse vocale E2E');

    await limova.locator('#connectHubspot').click();
    await expect.poll(() => socketMessages.some(message => {
      const text = message.clientContent?.turns?.[0]?.parts?.[0]?.text || '';
      return text.includes('Source: user_click') && text.includes('Connecter HubSpot');
    })).toBe(true);

    await sidebar.locator('#voiceBtn').click();
    await expect.poll(() => socketMessages.some(message => message.realtimeInput?.audioStreamEnd === true)).toBe(true);
    await expect(sidebar.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
  });

  test('language, onboarding state, next-step request, log download and reset work from the real UI', async ({ context, extensionId }) => {
    const { calls, limova, sidebar } = await openExtensionHarness(context, extensionId, {
      geminiReply: ({ index }) => `Réponse de parcours ${index + 1}`
    });

    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('.lang-option[data-lang="fr"]').click();
    await expect(sidebar.locator('#userInput')).toHaveAttribute('placeholder', 'Écris à Charly...');
    await sidebar.reload();
    await expect(sidebar.locator('#userInput')).toHaveAttribute('placeholder', 'Écris à Charly...');
    await limova.bringToFront();
    await grantAIConsent(sidebar);

    await sidebar.locator('#userInput').fill('Démarre mon onboarding');
    await sidebar.locator('#sendBtn').click();
    await expect(sidebar.locator('.message.assistant .message-content')).toContainText('Réponse de parcours 1');
    await expect(sidebar.locator('#stepInfo')).toBeVisible();
    await expect(sidebar.locator('#stepProgress')).toContainText('1 /');
    const onboardingPrompt = calls.gemini[0].postDataJSON().systemInstruction.parts[0].text;
    expect(onboardingPrompt).toContain('Demande le sujet que le membre veut traiter.');
    expect(onboardingPrompt).toContain('Propose un parcours adapté sans forcer.');
    expect(onboardingPrompt).toContain('Révision de trame : onboarding_e2e');
    expect(onboardingPrompt).toContain('Premier parcours E2E');

    await sidebar.evaluate(() => chrome.runtime.sendMessage({ type: 'RESET_SESSION' }));
    await sidebar.locator('.next-step-link').click();
    await expect.poll(() => calls.gemini.length).toBe(2);
    await expect(sidebar.locator('.message.assistant .message-content').last()).toContainText('Réponse de parcours 2');

    await sidebar.locator('#diagnoseBtn').click();
    await expect(sidebar.locator('#diagnosticResult')).toHaveAttribute('data-status', 'healthy');
    await expect(sidebar.locator('#diagnosticText')).toContainText('opérationnel');
    expect(calls.health).toHaveLength(1);

    const downloadPromise = sidebar.waitForEvent('download');
    await sidebar.locator('#downloadLogsBtn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^limova-ai-logs-\d{4}-\d{2}-\d{2}\.txt$/);
    const stream = await download.createReadStream();
    let logText = '';
    for await (const chunk of stream) logText += chunk.toString();
    expect(logText).toContain('Limova AI - Paquet de diagnostic sécurisé');
    expect(logText).toContain('DIAGNOSTIC_COMPLETED');
    expect(logText).toContain('API_REQUEST_SUCCEEDED');
    expect(logText).not.toContain('Démarre mon onboarding');
    expect(logText).not.toContain('Réponse de parcours');
    expect(logText).not.toContain('NEVER_TRANSMIT_THIS_SECRET');
    expect(logText).not.toContain(`e2e-${'x'.repeat(48)}`);
    expect(logText).not.toContain('auth_tokens/');

    sidebar.once('dialog', dialog => dialog.accept());
    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#resetBtn').click();
    await expect(sidebar.locator('#welcomeScreen')).toBeVisible();
    await expect(sidebar.locator('#chatContainer')).toBeEmpty();
    const state = await sidebar.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    expect(state.conversationHistory).toEqual([]);
    expect(state.isActive).toBe(false);
  });

  test('tab locking warns on another tab and returns the user to the Limova session', async ({ context, extensionId }) => {
    await context.route('https://outside.example/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Autre onglet</h1>'
    }));
    const { limova, sidebar } = await openExtensionHarness(context, extensionId);
    await grantAIConsent(sidebar);
    await sidebar.locator('#userInput').fill('Verrouille cette session');
    await sidebar.locator('#sendBtn').click();
    await expect(sidebar.locator('.message.assistant .message-content')).toBeVisible();

    const outside = await context.newPage();
    await outside.goto('https://outside.example/');
    await outside.bringToFront();
    await expect(sidebar.locator('#tabWarning')).toBeVisible();

    await sidebar.locator('#tabWarning').click();
    await expect.poll(() => limova.evaluate(() => document.hasFocus())).toBe(true);
    await expect(sidebar.locator('#tabWarning')).toBeHidden();
  });
});
