import { test, expect } from './fixtures.js';

async function journalPage(context, extensionId) {
  await context.route('https://api.new.limova.ai/**', route => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await page.evaluate(async () => {
    const { createBrowserJournal } = await import('../limova/browser-journal.js');
    window.createJournal = createBrowserJournal;
    window.scope = { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), conversationId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    window.action = { type: 'extension.action_requested', protocolVersion: 1, turnId: crypto.randomUUID(), actionId: 'action-1', toolCallId: 'call-1',
      target: { tabId: 17, origin: 'https://example.com', contextVersion: 1 }, input: { operation: 'click', elementId: 1 },
      expiresAt: new Date(Date.now() + 120000).toISOString() };
  });
  return page;
}

test('durable receipts survive closing the database and do not repeat execution', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    let executed = 0;
    const first = createJournal();
    const receipt = await first.run(scope, action, async () => { executed++; return { status: 'completed', observation: 'Clicked once' }; });
    await first.close();
    const second = createJournal();
    const recovered = await second.run(scope, action, async () => { executed++; throw new Error('Must not execute'); });
    await second.close();
    return { receipt, recovered, executed };
  });
  expect(result.executed).toBe(1);
  expect(result.recovered).toEqual(result.receipt);
  expect(result.receipt.result.observation).toBe('Clicked once');
});

test('atomic claims across independent connections allow only one action', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    let executed = 0;
    const one = createJournal(), two = createJournal();
    const execute = async () => { executed++; await new Promise(resolve => setTimeout(resolve, 50)); return { status: 'completed', observation: 'Clicked' }; };
    const receipts = await Promise.all([one.run(scope, action, execute), two.run(scope, action, execute)]);
    await Promise.all([one.close(), two.close()]);
    return { executed, states: receipts.map(receipt => receipt.state) };
  });
  expect(result.executed).toBe(1);
  expect(result.states).toContain('completed');
  expect(result.states.every(state => ['completed', 'uncertain'].includes(state))).toBe(true);
});

test('an interrupted action remains uncertain after reconnect and never retries itself', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    let executed = 0;
    const first = createJournal();
    await first.run(scope, action, async () => { executed++; throw new Error('Tab vanished after click'); });
    await first.close();
    const second = createJournal();
    const receipt = await second.run(scope, action, async () => { executed++; return { status: 'completed', observation: 'Repeated' }; });
    await second.close();
    return { receipt, executed };
  });
  expect(result).toEqual({ receipt: { state: 'uncertain', result: null }, executed: 1 });
});

test('receipt invalidation during execution prevents resurrection after account cleanup', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const error = await page.evaluate(async () => {
    const journal = createJournal();
    try {
      await journal.run(scope, action, async () => {
        await journal.clearScope(scope);
        return { status: 'completed', observation: 'Must not survive cleanup' };
      });
    } catch (error) { return error.message; }
    finally { await journal.close(); }
  });
  expect(error).toBe('Browser receipt was invalidated');
});

test('changed or expired actions fail before execution', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    let executed = 0;
    const execute = async () => { executed++; return { status: 'completed', observation: 'Once' }; };
    await journal.run(scope, action, execute);
    const errors = [];
    for (const candidate of [{ ...action, input: { operation: 'click', elementId: 2 } },
      { ...action, actionId: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() }]) {
      try { await journal.run(scope, candidate, execute); } catch (error) { errors.push(error.message); }
    }
    await journal.close();
    return { executed, errors };
  });
  expect(result.executed).toBe(1);
  expect(result.errors).toEqual(['Browser action changed after receipt', 'Browser action expired']);
});

test('storage failure before the durable claim prevents browser execution', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    const put = IDBObjectStore.prototype.put;
    let executed = 0;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Storage full', 'QuotaExceededError'); };
    try {
      await journal.run(scope, action, async () => { executed++; return { status: 'completed', observation: 'Unsafe' }; });
    } catch (error) { return { executed, error: error.name }; }
    finally { IDBObjectStore.prototype.put = put; await journal.close(); }
  });
  expect(result).toEqual({ executed: 0, error: 'QuotaExceededError' });
});

test('a failed result write never causes the executed browser action to repeat', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    const put = IDBObjectStore.prototype.put;
    let executed = 0;
    try {
      await journal.run(scope, action, async () => {
        executed++;
        IDBObjectStore.prototype.put = function () { throw new DOMException('Storage full', 'QuotaExceededError'); };
        return { status: 'completed', observation: 'Clicked before storage failure' };
      });
    } catch {} finally { IDBObjectStore.prototype.put = put; await journal.close(); }
    const reopened = createJournal();
    const receipt = await reopened.run(scope, action, async () => { executed++; return { status: 'completed', observation: 'Repeated' }; });
    await reopened.close();
    return { executed, receipt };
  });
  expect(result).toEqual({ executed: 1, receipt: { state: 'uncertain', result: null } });
});

test('an accepted receipt remains readable after expiry and JSON key reordering', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    action.expiresAt = new Date(Date.now() + 10000).toISOString();
    let executed = 0;
    const execute = async () => { executed++; return { status: 'completed', observation: 'Once' }; };
    const first = await journal.run(scope, action, execute);
    const now = Date.now;
    Date.now = () => now() + 20000;
    try {
      const reordered = Object.fromEntries(Object.entries(action).reverse());
      const receipt = await journal.run(scope, reordered, execute);
      return { first, receipt, executed };
    } finally { Date.now = now; await journal.close(); }
  });
  expect(result.executed).toBe(1);
  expect(result.receipt).toEqual(result.first);
});

test('account cleanup removes only that account and invalidates its in-flight receipt', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    const other = { ...scope, userId: crypto.randomUUID() };
    let executed = 0;
    const execute = async () => { executed++; return { status: 'completed', observation: 'Other account' }; };
    await journal.run(other, action, execute);
    let invalidated;
    try {
      await journal.run(scope, action, async () => {
        await journal.clearAccount(scope.userId);
        return { status: 'completed', observation: 'Removed account' };
      });
    } catch (error) { invalidated = error.message; }
    const recovered = await journal.run(other, action, execute);
    await journal.close();
    return { invalidated, executed, recovered };
  });
  expect(result.invalidated).toBe('Browser receipt was invalidated');
  expect(result.executed).toBe(1);
  expect(result.recovered.result.observation).toBe('Other account');
});
