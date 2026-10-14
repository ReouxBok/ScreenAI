import { test, expect, APP, CONVERSATION } from './native-chat-fixture.js';

for (const ending of ['return', 'closed', 'new-conversation', 'permission-off']) {
  test(`native tab guidance: ${ending}`, async ({ nativeChat }) => {
    const { panel, app, context, worker, calls, legacy, errors } = nativeChat;
    await panel.evaluate(() => document.getElementById('screenshotBtn').click());
    await expect(panel.locator('.message.assistant .message-content')).toBeVisible();
    await expect(panel.locator('#sendBtn')).toBeEnabled();
    const count = calls.filter(call => call.path === `/message/${CONVERSATION}`).length;
    const outside = await context.newPage();
    await outside.goto(`${APP}/another-tab?private_token=OTHER_TAB_SECRET`);
    await outside.bringToFront();
    await expect(panel.locator('#limovaReturnTab')).toBeVisible();
    if (ending === 'return') {
      await panel.evaluate(() => document.getElementById('limovaReturnTab').click());
      await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url)).toBe(app.url());
      await expect(panel.locator('#limovaReturnTab')).toBeHidden();
    } else if (ending === 'closed') {
      await app.close();
      await expect(panel.locator('#limovaReturnTab')).toBeHidden();
    } else if (ending === 'new-conversation') {
      await panel.evaluate(() => document.getElementById('limovaNew').click());
      await expect(panel.locator('#limovaReturnTab')).toBeHidden();
      await expect(panel.locator('.message.assistant .message-content')).toHaveCount(0);
    } else {
      await panel.evaluate(() => {
        const checkbox = document.getElementById('limovaBrowser');
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
      });
      await expect(panel.locator('#limovaReturnTab')).toBeHidden();
    }
    expect(calls.filter(call => call.path === `/message/${CONVERSATION}`)).toHaveLength(count);
    expect(JSON.stringify(calls)).not.toContain('OTHER_TAB_SECRET');
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  });
}
