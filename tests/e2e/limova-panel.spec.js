import { test, expect } from './fixtures.js';

test('mounts the Limova session panel and renders the existing Charly history', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async request => {
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
        { id: 'a', role: 'assistant', content: 'Bonjour, je retrouve ta conversation Limova.' },
      ], pagination: { hasMore: true, nextCursor: 'older-cursor' } };
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
  await expect(page.locator('.next-step-link')).toHaveCount(0);
  await page.locator('#limovaMoreConversations').click();
  await expect(page.locator('#limovaConversation option')).toHaveCount(3);
  await expect(page.locator('#limovaConversation')).toHaveValue('conversation');
  await expect(page.locator('#limovaMoreConversations')).toBeHidden();
  await page.locator('#limovaOlderMessages').click();
  await expect(page.locator('#chatContainer')).toContainText('Mon premier message historique');
  await expect(page.locator('#chatContainer .message').first()).toContainText('Mon premier message historique');
  await expect(page.locator('#limovaOlderMessages')).toBeHidden();
  expect(errors).toEqual([]);
  await page.close();
});
