import { test, expect } from './fixtures.js';

const PROXY = 'https://limova-proxy-479c7fb78ccf.herokuapp.com';
const OLD_SESSION = '550e8400-e29b-41d4-a716-446655440000';
const NEW_SESSION = '550e8400-e29b-41d4-a716-446655440001';

for (const serverOrchestration of [false, true]) {
  test(`reset isolates history and voice after reopening the packaged extension (ADK=${serverOrchestration})`, async ({ context, serviceWorker, extensionId }) => {
    const calls = { live: [], text: [], sessions: [] };
    await context.route('https://new.limova.ai/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Accueil Limova</title><main><h1>Accueil</h1><a href="/conversation">Conversation</a></main>'
    }));
    await context.route(`${PROXY}/**`, async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.method() === 'POST' ? request.postDataJSON() : {};
      let data = {};
      if (path === '/api/copilot/bootstrap') data = {
        available: true, enabled: true, serverOrchestration, sessionId: OLD_SESSION,
        recentMessages: [{ role: 'assistant', content: 'Reprenons votre audit SEO.' }],
        goals: [{ title: 'Audit SEO' }], greeting: 'Nous parlions de votre audit SEO.'
      };
      if (path === '/api/copilot/v2/sessions') { calls.sessions.push(body); data = { sessionId: NEW_SESSION }; }
      if (path === '/api/live-token') { calls.live.push(body); data = { token: 'authTokens/test', model: 'gemini-3.1-flash-live-preview', expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
      if (path === '/api/gemini') { calls.text.push(body); data = { candidates: [{ content: { parts: [{ text: 'Bonjour, quel est votre nouvel objectif ?' }] } }] }; }
      if (path === '/api/copilot/v2/turn') { calls.text.push(body); data = { type: 'message', sessionId: NEW_SESSION, content: 'Bonjour, quel est votre nouvel objectif ?' }; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await serviceWorker.evaluate(async oldSession => {
      await chrome.storage.local.set({
        charly_auth_session_v1: { token: 'e2e-test-session-token-value', expiresAt: Date.now() + 3_600_000 },
        limova_ai_processing_consent_v1: true,
        limova_onboarding_dismissed: true,
        limova_session: { remoteSessionId: oldSession, conversationHistory: [{ role: 'user', content: 'Nous parlions de mon audit SEO.' }] }
      });
    }, OLD_SESSION);
    // Restart to load persisted conversation state as a real installed extension does.
    const sidebar = await context.newPage();
    await sidebar.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const worker = targets.find(target => target.type === 'service_worker' && target.url === serviceWorker.url());
    await cdp.send('Target.closeTarget', { targetId: worker.targetId });
    await cdp.detach();
    await sidebar.reload();
    await sidebar.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
    await expect(sidebar.locator('#chatContainer')).toContainText('audit SEO');
    const limova = await context.newPage();
    await limova.goto('https://new.limova.ai/home');

    sidebar.once('dialog', dialog => dialog.accept());
    await sidebar.locator('#menuBtn').click();
    await sidebar.locator('#resetBtn').click();
    await expect(sidebar.locator('#chatContainer')).not.toContainText('audit SEO');
    await expect.poll(() => calls.sessions.length).toBe(1);
    expect(calls.sessions[0]).toEqual({ previousSessionId: OLD_SESSION, closePrevious: true });

    await sidebar.reload();
    await sidebar.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
    await expect(sidebar.locator('#chatContainer')).not.toContainText('audit SEO');
    const token = await sidebar.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_LIVE_TOKEN', context: {} }));
    expect(token.ok).toBe(true);
    expect(calls.live[0]).toMatchObject({ resetContext: true, sessionId: NEW_SESSION, history: [] });

    await sidebar.locator('#userInput').fill('Bonjour');
    await sidebar.locator('#sendBtn').click();
    await expect.poll(() => calls.text.length).toBe(1);
    expect(calls.text[0].resetContext).toBe(true);
    if (!serverOrchestration) expect(JSON.stringify(calls.text[0].contents)).not.toContain('audit SEO');
    await expect(sidebar.locator('#chatContainer')).toContainText('nouvel objectif');
  });
}
