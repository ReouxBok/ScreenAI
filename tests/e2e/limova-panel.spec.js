import { test, expect } from './fixtures.js';

test('mounts the Limova session panel and renders the existing Charly history', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.nativeRequests = [];
    chrome.runtime.sendMessage = async request => {
      if (request.type.startsWith('LIMOVA_')) window.nativeRequests.push(request.type);
      if (request.type === 'LIMOVA_GET_STATE') return {
        authenticated: true, user: { id: 'user' }, context: { userId: 'user', workspaceId: 'workspace' },
        workspaces: [{ id: 'workspace', name: 'Équipe de test', enabled: true }], conversationId: 'conversation', activeTurnId: null,
      };
      if (request.type === 'LIMOVA_LIST_CONVERSATIONS') return request.page === 2
        ? { data: [{ id: 'older-conversation', title: 'Ancienne discussion' }], pagination: { hasNext: false } }
        : { data: [{ id: 'conversation', title: 'Discussion partagée' }], pagination: { hasNext: true } };
      if (request.type === 'LIMOVA_GET_MESSAGES' && request.cursor === 'older-cursor') return {
        data: [{ id: 'old', role: 'user', content: 'Mon premier message historique' }], pagination: { hasMore: false }
      };
      if (request.type === 'LIMOVA_GET_MESSAGES') return { data: [
        { id: 'h', role: 'user', content: 'Bonjour Charly' },
        { id: 'a', role: 'assistant', content: 'Bonjour, je retrouve ta conversation Limova.',
          generatedVideos: [{ fileId: 'video', fileName: 'Présentation.mp4', mimeType: 'video/mp4', fileUrl: 'https://files.example/video.mp4' }] },
        { id: 'social', role: 'assistant', content: '', generatedCaption: { text: '<script>window.unsafeCaption=true</script>' },
          generatedCarousel: { slides: [
            { fileId: 'slide1', fileName: 'Première diapositive.png', mimeType: 'image/png', fileUrl: 'https://files.example/1.png' },
            { fileId: 'slide2', fileName: 'Deuxième diapositive.png', mimeType: 'image/png', fileUrl: 'https://files.example/2.png' },
          ] } },
      ], pagination: { hasMore: true, nextCursor: 'older-cursor' } };
      if (request.type === 'LIMOVA_OPEN_GENERATED_FILE') { window.openedGeneratedFile = request; return { ok: true }; }
      if (request.type === 'GET_PRIVACY_STATE') return { aiProcessing: true };
      if (request.type === 'LIMOVA_SEND_MESSAGE') { window.analysisRequest = request; return { ok: true }; }
      if (request.type === 'ANALYZE_PAGE' || request.type === 'NEXT_STEP') throw new Error('Legacy analysis called');
      if (request.type === 'GET_STATE') return { capabilities: {}, training: null, evaluation: null };
      return original(request);
    };
  });
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await expect(page.locator('html')).toHaveAttribute('data-sidebar-ready', 'true');
  await expect(page.locator('#authPanel')).toBeHidden();
  await expect(page.locator('#limovaWorkspace')).toHaveValue('workspace');
  await expect(page.locator('#chatContainer')).toContainText('je retrouve ta conversation Limova');
  await expect(page.locator('#authEmailForm')).toHaveCount(0);
  await expect(page.locator('.next-step-link')).toHaveCount(1);
  await expect(page.locator('.next-step-link')).toHaveAttribute('type', 'button');
  await expect(page.locator('.generated-file')).toHaveCount(3);
  await expect(page.locator('.generated-caption')).toHaveText('<script>window.unsafeCaption=true</script>');
  expect(await page.evaluate(() => window.unsafeCaption)).toBeUndefined();
  await page.locator('.generated-file').first().click();
  expect(await page.evaluate(() => window.openedGeneratedFile)).toEqual({ type: 'LIMOVA_OPEN_GENERATED_FILE', conversationId: 'conversation', fileId: 'video' });
  await expect(page.locator('.generated-file').first()).not.toHaveAttribute('href');
  expect(await page.locator('#chatContainer > .message').evaluateAll(nodes => nodes.map(node => node.textContent))).toEqual([
    expect.stringContaining('Bonjour Charly'), expect.stringContaining('je retrouve ta conversation'),
    'Présentation.mp4', '<script>window.unsafeCaption=true</script>', 'Première diapositive.png', 'Deuxième diapositive.png',
  ]);
  await page.locator('#limovaMoreConversations').click();
  await expect(page.locator('#limovaConversation option')).toHaveCount(3);
  await expect(page.locator('#limovaConversation')).toHaveValue('conversation');
  await expect(page.locator('#limovaMoreConversations')).toBeHidden();
  await page.locator('#limovaOlderMessages').click();
  await expect(page.locator('#chatContainer')).toContainText('Mon premier message historique');
  await expect(page.locator('#chatContainer .message').first()).toContainText('Mon premier message historique');
  await expect(page.locator('#limovaOlderMessages')).toBeHidden();
  await page.locator('#limovaBrowser').check();
  const requestCount = await page.evaluate(() => window.nativeRequests.length);
  for (const [lang, label, placeholder] of [
    ['en', 'New conversation', 'Resume a conversation'],
    ['es', 'Nueva conversación', 'Retomar una conversación'],
    ['fr', 'Nouvelle conversation', 'Reprendre une conversation'],
  ]) {
    await page.evaluate(lang => document.querySelector(`.lang-option[data-lang="${lang}"]`).click(), lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('#limovaNew')).toHaveText(label);
    await expect(page.locator('#limovaConversation option').first()).toHaveText(placeholder);
    await expect(page.locator('#limovaConversation')).toHaveValue('conversation');
    await expect(page.locator('#limovaBrowser')).toBeChecked();
    await expect(page.locator('#chatContainer')).toContainText('Mon premier message historique');
    expect(await page.evaluate(() => window.nativeRequests.length)).toBe(requestCount);
  }
  await page.locator('#limovaBrowser').uncheck();
  await page.locator('.next-step-link').click();
  await expect.poll(() => page.evaluate(() => window.analysisRequest)).toMatchObject({ type: 'LIMOVA_SEND_MESSAGE', browser: false });
  expect(await page.evaluate(() => window.analysisRequest.browserMode)).toBeUndefined();
  await page.locator('#screenshotBtn').click();
  await expect.poll(() => page.evaluate(() => window.analysisRequest)).toMatchObject({ type: 'LIMOVA_SEND_MESSAGE', browser: true, browserMode: 'observe' });
  await expect(page.locator('#limovaBrowser')).not.toBeChecked();
  expect(errors).toEqual([]);
  await page.close();
});
