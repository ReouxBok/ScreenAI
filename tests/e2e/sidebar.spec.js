import { test, expect } from './fixtures.js';

test.describe('Sidebar UI', () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await serviceWorker.evaluate(async ({ token, expiresAt }) => {
      await chrome.storage.local.set({
        charly_auth_session_v1: { token, expiresAt }
      });
    }, {
      token: `e2e-${'x'.repeat(48)}`,
      expiresAt: Date.now() + 60 * 60 * 1000
    });
    await context.route('https://limova-proxy-479c7fb78ccf.herokuapp.com/api/copilot/bootstrap', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, enabled: true, recentMessages: [], goals: [], memories: [], greeting: null })
    }));
  });

  test('renders the main layout with greeting and CTA', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    // Wait for i18n.js to finish applying translations
    await page.waitForFunction(() => document.querySelector('h1, .greeting, [data-i18n="title"]'));

    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);

    // Critical elements are present
    await expect(page.locator('[data-i18n="title"]').first()).toBeVisible();
    await expect(page.locator('[data-i18n-placeholder="inputPlaceholder"]').first()).toBeVisible();

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
    await page.close();
  });

  test('never flashes sign-in while a valid persistent session is restoring', async ({ context, extensionId }) => {
    await context.unroute('https://limova-proxy-479c7fb78ccf.herokuapp.com/api/copilot/bootstrap');
    await context.route('https://limova-proxy-479c7fb78ccf.herokuapp.com/api/copilot/bootstrap', async route => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true, enabled: true, recentMessages: [], greeting: null })
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#authPanel')).toBeHidden();
    await page.waitForTimeout(350);
    await expect(page.locator('#authPanel')).toBeHidden();
    await page.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
    await expect(page.locator('#authPanel')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-auth-state', 'authenticated');
    await page.close();
  });

  test('keeps the mounted sidebar stable when the MV3 service worker restarts', async ({ context, extensionId, serviceWorker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
    await page.evaluate(() => { window.__limovaSidebarMount = crypto.randomUUID(); });
    const mountId = await page.evaluate(() => window.__limovaSidebarMount);

    const browserSession = await context.browser().newBrowserCDPSession();
    const targets = (await browserSession.send('Target.getTargets')).targetInfos;
    const workerTarget = targets.find(target => target.type === 'service_worker' && target.url === serviceWorker.url());
    expect(workerTarget).toBeTruthy();
    await browserSession.send('Target.closeTarget', { targetId: workerTarget.targetId });
    await browserSession.detach();
    await page.waitForTimeout(1_500);

    expect(await page.evaluate(() => window.__limovaSidebarMount)).toBe(mountId);
    await expect(page.locator('#authPanel')).toBeHidden();
    const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }));
    expect(state).toEqual(expect.objectContaining({ active: expect.any(Boolean) }));
    await page.close();
  });

  test('quick links contain the approved destinations without Nouveautés', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    // announcements.js injects quick links into #quickLinks on DOMContentLoaded
    await page.waitForFunction(() => {
      const el = document.getElementById('quickLinks');
      return el && el.querySelectorAll('.quick-link-item').length > 0;
    }, { timeout: 5000 });

    const count = await page.locator('#quickLinks .quick-link-item').count();
    expect(count).toBe(2);
    await expect(page.locator('#quickLinks')).not.toContainText('Nouveautés');
    await expect(page.locator('#quickLinks button')).toHaveCount(0);
    await expect(page.locator('#quickLinks a[href="https://bienvenue.limova.ai/"]')).toHaveCount(1);
    await page.close();
  });

  test('opens without any cookie, analytics or AI consent popup', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await expect(page.locator('#aiConsentPanel')).toBeHidden();
    await expect(page.locator('#consentBanner')).toHaveCount(0);
    await expect(page.locator('text=/cookie/i')).toHaveCount(0);
    await expect(page.locator('#voiceBtn')).toBeVisible();
    await page.close();
  });

  test('runs an inline degraded diagnostic without opening a popup', async ({ context, extensionId }) => {
    await context.route('https://limova-proxy-479c7fb78ccf.herokuapp.com/healthz', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'unavailable' })
    }));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    const pageCountBeforeDiagnostic = context.pages().length;
    await page.locator('#diagnoseBtn').click();

    await expect(page.locator('#diagnosticResult')).toBeVisible();
    await expect(page.locator('#diagnosticResult')).toHaveAttribute('data-status', 'degraded');
    await expect(page.locator('#diagnosticText')).toContainText(/problème|problem|problema/i);
    expect(context.pages()).toHaveLength(pageCountBeforeDiagnostic);
    await page.close();
  });

  for (const action of [
    { name: 'message', prepare: async page => page.locator('#userInput').fill('Bonjour Charly'), target: '#sendBtn' },
    { name: 'page analysis', target: '#screenshotBtn' },
    { name: 'voice', target: '#voiceBtn' }
  ]) {
    test(`requests the single AI consent only when starting ${action.name}`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
      if (action.prepare) await action.prepare(page);
      await page.locator(action.target).click();
      await expect(page.locator('#aiConsentPanel')).toBeVisible();
      await expect(page.locator('#aiConsentPanel')).toContainText('Google Gemini');
      await expect(page.locator('#aiConsentPanel a[href*="politique-de-confidentialite"]')).toHaveCount(1);
      await page.close();
    });
  }

  test('remembers AI consent and never asks again after acceptance', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.locator('#userInput').fill('Bonjour Charly');
    await page.locator('#sendBtn').click();
    await expect(page.locator('#aiConsentPanel')).toBeVisible();
    await page.locator('#aiConsentAccept').click();
    await expect(page.locator('#aiConsentPanel')).toBeHidden();

    const privacyState = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' })
    );
    expect(privacyState).toEqual(expect.objectContaining({ aiProcessing: true, aiProcessingDecided: true }));

    await page.reload();
    await expect(page.locator('#aiConsentPanel')).toBeHidden();
    await page.locator('#screenshotBtn').click();
    await expect(page.locator('#aiConsentPanel')).toBeHidden();
    await page.close();
  });

  test('keeps AI disabled after consent refusal and sends no AI request', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const externalRequests = [];
    page.on('request', request => {
      if (/limova-proxy|generativelanguage\.googleapis\.com/.test(request.url())) {
        externalRequests.push(request.url());
      }
    });

    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.locator('#userInput').fill('Ne transmets pas ce message');
    await page.locator('#sendBtn').click();
    await expect(page.locator('#aiConsentPanel')).toBeVisible();
    await page.locator('#aiConsentDecline').click();
    await expect(page.locator('#aiConsentPanel')).toBeHidden();
    await expect(page.locator('.message.system .message-content').last()).toBeVisible();

    const privacyState = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' })
    );
    expect(privacyState).toEqual(expect.objectContaining({ aiProcessing: false, aiProcessingDecided: true }));
    expect(externalRequests).toEqual([]);
    await page.close();
  });

  test('i18n applies to static elements (lang attribute set)', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.waitForFunction(() => document.documentElement.lang !== '');
    const lang = await page.evaluate(() => document.documentElement.lang);
    expect(['fr', 'en', 'es']).toContain(lang);
    await page.close();
  });

  test('supports keyboard operation and exposes accessible names for icon buttons', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.waitForFunction(() => document.documentElement.lang !== '');

    await expect(page.locator('#screenshotBtn')).toHaveAttribute('aria-label', /.+/);
    await expect(page.locator('#voiceBtn')).toHaveAttribute('aria-label', /.+/);
    await expect(page.locator('#sendBtn')).toHaveAttribute('aria-label', /.+/);
    await page.locator('#userInput').focus();
    expect(await page.locator('#userInput').evaluate(element => element.matches(':focus-visible'))).toBe(true);

    await page.locator('#userInput').fill('Test clavier');
    await page.locator('#userInput').press('Enter');
    await expect(page.locator('#aiConsentPanel')).toBeVisible();
    await expect(page.locator('#aiConsentAccept')).toBeFocused();
    await page.close();
  });

  test('turns a dismissed native microphone prompt into localized inline guidance', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
    await page.waitForFunction(() => document.documentElement.dataset.sidebarReady === 'true');
    const language = await page.evaluate(() => document.documentElement.lang);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('limova-voice-status', {
      detail: {
        status: 'error',
        error: 'Permission dismissed',
        errorKey: 'voiceMicDismissed'
      }
    })));

    const expected = {
      fr: 'L’autorisation du micro n’a pas été terminée.',
      en: 'Microphone authorization was not completed.',
      es: 'No se completó la autorización del micrófono.'
    }[language];
    await expect(page.locator('.message.error .message-content').last()).toContainText(expected);
    await expect(page.locator('.message.error .message-content').last()).not.toContainText('Permission dismissed');
    await page.close();
  });

  test('provides a dedicated full-tab microphone authorization screen', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/sidebar/microphone-permission.html`);

    await expect(page.locator('#permissionTitle')).toBeVisible();
    await expect(page.locator('#allowMicrophone')).toBeVisible();
    await expect(page.locator('#permissionDescription')).toContainText(/Chrome/i);
    await expect(page.locator('text=/cookie|analytics/i')).toHaveCount(0);
    await page.close();
  });

  test('CSP allows extension scripts but blocks inline scripts', async ({ serviceWorker }) => {
    const csp = await serviceWorker.evaluate(() => {
      const m = chrome.runtime.getManifest();
      return m.content_security_policy?.extension_pages;
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
