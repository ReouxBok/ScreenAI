import { test, expect, AGENT, CONVERSATION, WORKSPACE } from './native-chat-fixture.js';

test('native chat reads the page through the app session and keeps history in the same Charly conversation', async ({ nativeChat }) => {
  const { panel, app, calls, worker, legacy, errors } = nativeChat;
  await panel.evaluate(() => {
    document.getElementById('limovaBrowser').checked = true;
    document.getElementById('userInput').value = 'Aide-moi à comprendre cette page';
    document.getElementById('sendBtn').click();
  });
  await expect(panel.locator('.message.assistant .message-content')).toHaveText('Je retrouve le tableau de bord.');
  await expect(panel.locator('.message.user .message-content')).toContainText('Aide-moi');
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  const creations = calls.filter(call => call.path === '/conversation' && call.method === 'POST');
  expect(creations).toHaveLength(1);
  expect(creations[0]).toMatchObject({ authenticated: true, workspace: WORKSPACE,
    body: { botAgentId: AGENT, type: 'general', engine: 'deep_agents', disableFirstMessage: true } });
  const turns = calls.filter(call => call.path === `/message/${CONVERSATION}`);
  expect(turns).toHaveLength(2);
  expect(turns.every(call => call.authenticated && call.workspace === WORKSPACE)).toBe(true);
  expect(turns[0].body).toMatchObject({ clientSurface: 'chrome_extension', content: 'Aide-moi à comprendre cette page' });
  expect(turns[1].body).toMatchObject({ kind: 'browser_tool_result', browserResult: { status: 'completed' } });
  expect(turns[1].body.browserResult.observation).toContain('Tableau de bord');
  const serialized = JSON.stringify(calls);
  for (const secret of ['NEVER_TRANSMIT_THIS_SECRET', 'PRIVATE_FIELD_VALUE', 'private_token', 'must-not-leak']) expect(serialized).not.toContain(secret);
  expect(await app.evaluate(() => window.clicks)).toBe(0);
  await expect(panel.locator('#limovaBrowser')).not.toBeChecked();
  await panel.locator('.next-step-link').click();
  await expect(panel.locator('.message.assistant')).toHaveCount(2);
  const last = calls.filter(call => call.path === `/message/${CONVERSATION}`).at(-1);
  expect(last.body.content).toContain('prochaine étape');
  expect(last.body.browserContext).toBeUndefined();
  expect(calls.filter(call => call.path === '/conversation' && call.method === 'POST')).toHaveLength(1);
  await panel.reload();
  await expect(panel.locator('#limovaConversation')).toHaveValue(CONVERSATION);
  await expect(panel.locator('.message.assistant')).toHaveCount(2);
  const storage = await worker.evaluate(() => chrome.storage.local.get(null));
  expect(storage.limova_deep_agent_context_v1.conversationId).toBe(CONVERSATION);
  expect(storage.charly_auth_session_v1).toBeUndefined();
  expect(JSON.stringify(storage)).not.toContain('native_chat=authenticated');
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

test('native assistant markdown cannot inject executable HTML or unsafe links', async ({ nativeChat }) => {
  const { panel, state, legacy, errors } = nativeChat;
  state.reply = '<img src=x onerror="document.body.dataset.xss=\'yes\'"> [Piège](javascript:alert(1)) **Texte sûr**';
  await panel.locator('#userInput').fill('Affiche la réponse');
  await panel.locator('#sendBtn').click();
  const response = panel.locator('.message.assistant .message-content');
  await expect(response).toContainText('<img src=x');
  await expect(response.locator('img')).toHaveCount(0);
  await expect(response.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(response.locator('strong')).toHaveText('Texte sûr');
  expect(await panel.evaluate(() => document.body.dataset.xss)).toBeUndefined();
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});

for (const reason of ['session', 'flag']) test(`native chat refuses a turn after ${reason} revocation without a legacy fallback`, async ({ nativeChat }) => {
  const { panel, state, calls, legacy } = nativeChat;
  if (reason === 'session') state.authenticated = false;
  else state.enabled = false;
  await panel.locator('#userInput').fill('Ne pas envoyer sans autorisation');
  await panel.locator('#sendBtn').click();
  await expect(panel.locator('#limovaFeedback')).toContainText(reason === 'session' ? 'Connecte-toi dans Limova' : 'pas activée');
  expect(calls.filter(call => call.method === 'POST' && (call.path === '/conversation' || call.path.startsWith('/message/')))).toHaveLength(0);
  expect(legacy).toEqual([]);
  if (reason === 'session') {
    expect(calls.filter(call => call.path === '/auth/refresh-token')).toHaveLength(1);
    await panel.reload();
    await expect(panel.locator('#authPanel')).toBeVisible();
    await expect(panel.locator('#limovaLogin')).toBeVisible();
    await expect(panel.locator('#authEmail')).toHaveCount(0);
  }
});


test('downloads the selected conversation as CSV through the first-party app bridge', async ({ nativeChat }) => {
  const { panel, calls, legacy } = nativeChat;
  await panel.locator('#userInput').fill('Bonjour');
  await panel.locator('#sendBtn').click();
  await expect(panel.locator('.message.assistant')).toHaveCount(1);
  await expect(panel.locator('#sendBtn')).toBeEnabled();
  await panel.locator('#menuBtn').click();
  await expect(panel.locator('#limovaExport')).toBeEnabled();
  const downloaded = panel.waitForEvent('download');
  await panel.locator('#limovaExport').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`limova-conversation-${CONVERSATION}.csv`);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf8')).toBe('Timestamp,Sender,Content\n2026-10-14,Charly,"Bonjour é"\n');
  expect(calls.filter(call => call.path.endsWith('/download'))).toEqual([
    expect.objectContaining({ path: `/conversation/${CONVERSATION}/download`, authenticated: true, workspace: WORKSPACE, method: 'GET' }),
  ]);
  expect(legacy).toEqual([]);
});
