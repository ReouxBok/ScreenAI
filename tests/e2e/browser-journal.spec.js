import { test, expect } from './fixtures.js';

async function journalPage(context, extensionId) {
  await context.route('https://api.new.limova.ai/**', route => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidebar/sidebar.html`);
  await page.evaluate(async () => {
    const { createBrowserJournal } = await import('../limova/browser-journal.js');
    window.createJournal = createBrowserJournal;
    window.scope = { userId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), conversationId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const journal = createBrowserJournal();
    scope.sessionId = await journal.getSession(scope);
    await journal.close();
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
  expect(Number.isFinite(Date.parse(result.receipt.observedAt))).toBe(true);
  expect(result.recovered.observedAt).toBe(result.receipt.observedAt);
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
    other.sessionId = await journal.getSession(other);
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
  expect(result.invalidated).toBe('Browser session revoked');
  expect(result.executed).toBe(1);
  expect(result.recovered.result.observation).toBe('Other account');
});

test('session creation is atomic, persistent and rotated on workspace revocation', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const one = createJournal(), two = createJournal();
    const sessions = await Promise.all([one.getSession(scope), two.getSession(scope)]);
    const before = scope.sessionId;
    await one.revokeSession(scope);
    let executed = 0, error;
    try { await two.run(scope, action, async () => { executed++; return { status: 'completed', observation: 'Forbidden' }; }); }
    catch (failure) { error = failure.message; }
    const after = await two.getSession(scope);
    await Promise.all([one.close(), two.close()]);
    const reopened = createJournal();
    const recovered = await reopened.getSession(scope);
    await reopened.close();
    return { sessions, before, after, recovered, executed, error };
  });
  expect(result.sessions).toEqual([result.before, result.before]);
  expect(result.after).not.toBe(result.before);
  expect(result.recovered).toBe(result.after);
  expect(result.executed).toBe(0);
  expect(result.error).toBe('Browser session revoked');
});

test('the continuation runner recovers a lost result response without repeating the persisted action', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const { createBrowserTurnRunner } = await import('../limova/browser-turn.js');
    const journal = createJournal();
    let executed = 0, messages = 0, submissions = 0, resumes = 0, authorizations = 0;
    const custom = data => ({ event: 'custom', data });
    async function* waiting() {
      yield custom(action);
      yield custom({ type: 'extension.turn_state', turnId: action.turnId, state: 'waiting' });
    }
    const client = {
      getConversation: async () => ({}),
      sendMessage: () => { messages++; return waiting(); },
      getBrowserTurn: async () => ({ turnId: action.turnId, status: 'open' }),
      resumeBrowserTurn: () => { resumes++; return waiting(); },
      sendBrowserResult: async function* () {
        submissions++;
        if (submissions === 1) throw new Error('Lost response');
        yield custom({ type: 'extension.turn_state', turnId: action.turnId, state: 'completed' });
      },
    };
    const makeRunner = () => createBrowserTurnRunner({ client, journal, readPage: async () => action.target,
      execute: async () => { executed++; return { status: 'completed', observation: 'Clicked once' }; },
      authorize: async () => { authorizations++; if (executed) throw new Error('Original page has changed'); }, notify: () => {} });
    let failure;
    try { await makeRunner().send(scope, scope.conversationId, 'Act'); } catch (error) { failure = error.message; }
    await journal.close();
    const resumed = await makeRunner().resume(scope, scope.conversationId);
    await journal.close();
    return { executed, messages, submissions, resumes, authorizations, failure, resumed };
  });
  expect(result.executed).toBe(1);
  expect(result.messages).toBe(1);
  expect(result.submissions).toBe(2);
  expect(result.resumes).toBe(1);
  expect(result.authorizations).toBe(1);
  expect(result.failure).toBe('Lost response');
  expect(result.resumed.state).toBe('completed');
});

test('context versions are atomic across connections and survive worker storage reopen', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const one = createJournal(), two = createJournal();
    const versions = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? one : two).allocateVersion(scope)));
    await Promise.all([one.close(), two.close()]);
    const reopened = createJournal();
    const next = await reopened.allocateVersion(scope);
    await reopened.close();
    return { versions: versions.sort((a, b) => a - b), next };
  });
  expect(result.versions).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(result.next).toBe(21);
});

test('revoked sessions cannot allocate context versions or resurrect their counter', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    await journal.allocateVersion(scope);
    await journal.revokeSession(scope);
    const sessionId = await journal.getSession(scope);
    let error;
    try { await journal.allocateVersion(scope); } catch (failure) { error = failure.message; }
    const next = await journal.allocateVersion({ ...scope, sessionId });
    await journal.close();
    return { error, next, rotated: sessionId !== scope.sessionId };
  });
  expect(result).toEqual({ error: 'Browser session revoked', next: 1, rotated: true });
});


test('a screenshot receipt preserves its file identity across reopen without uploading twice', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    action.input = { operation: 'screenshot' };
    const imageFileId = crypto.randomUUID();
    let uploads = 0;
    const first = createJournal();
    const receipt = await first.run(scope, action, async () => {
      uploads++;
      return { status: 'completed', observation: 'Masked screenshot', imageFileId };
    });
    await first.close();
    const second = createJournal();
    const recovered = await second.run(scope, action, async () => { uploads++; throw new Error('Must not upload again'); });
    await second.close();
    return { receipt, recovered, uploads, imageFileId };
  });
  expect(result.uploads).toBe(1);
  expect(result.recovered).toEqual(result.receipt);
  expect(result.receipt.result.imageFileId).toBe(result.imageFileId);
});

test('an invalid screenshot receipt remains uncertain and is never re-executed', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const journal = createJournal();
    const attempts = [
      { operation: 'screenshot', status: 'completed' },
      { operation: 'screenshot', status: 'completed', imageFileId: 'invalid' },
      { operation: 'screenshot', status: 'failed', imageFileId: crypto.randomUUID() },
      { operation: 'read_page', status: 'completed', imageFileId: crypto.randomUUID() },
    ];
    const outcomes = [];
    for (const [index, candidate] of attempts.entries()) {
      const command = { ...action, actionId: `invalid-${index}`, input: { operation: candidate.operation } };
      try {
        await journal.run(scope, command, async () => ({ ...candidate, observation: 'Invalid result' }));
      } catch (error) { outcomes.push(error.message); }
      outcomes.push((await journal.run(scope, command, async () => { throw new Error('No replay'); })).state);
    }
    await journal.close();
    return outcomes;
  });
  expect(result).toEqual(Array.from({ length: 4 }, () => ['Invalid screenshot receipt; execution must be inspected', 'uncertain']).flat());
});

test('observation policy survives reopening and refuses mutations with durable receipts', async ({ context, extensionId }) => {
  const page = await journalPage(context, extensionId);
  const result = await page.evaluate(async () => {
    const first = createJournal();
    await first.setTurnMode(scope, action.turnId, 'observe');
    await first.close();
    const journal = createJournal();
    let executed = 0;
    let escalation;
    try { await journal.setTurnMode(scope, action.turnId, 'act'); } catch (error) { escalation = error.message; }
    const receipts = [];
    for (const input of [
      { operation: 'click', elementId: 1 }, { operation: 'type_text', elementId: 1, text: 'test' },
      { operation: 'scroll', direction: 'down' }, { operation: 'navigate', url: 'https://example.com/next' },
      { operation: 'highlight', elementId: 1 },
    ]) {
      receipts.push(await journal.run(scope, { ...action, actionId: input.operation === 'click' ? 'policy' : input.operation, input }, async () => {
        executed++; return { status: 'completed', observation: 'Unexpected mutation' };
      }));
    }
    const mode = await journal.getTurnMode(scope, action.turnId);
    const read = await journal.run(scope, { ...action, actionId: 'read', input: { operation: 'read_page' } }, async () => {
      executed++; return { status: 'completed', observation: 'Page read' };
    });
    const screenshot = await journal.run(scope, { ...action, actionId: 'screenshot', input: { operation: 'screenshot' } }, async () => {
      executed++; return { status: 'completed', observation: 'Captured', imageFileId: crypto.randomUUID() };
    });
    const unknown = await journal.getTurnMode(scope, crypto.randomUUID());
    await journal.revokeSession(scope);
    let revoked;
    try { await journal.getTurnMode(scope, action.turnId); } catch (error) { revoked = error.message; }
    await journal.close();
    return { executed, escalation, mode, unknown, receipts, read, screenshot, revoked };
  });
  expect(result.executed).toBe(2);
  expect(result.escalation).toBe('Browser turn mode cannot change');
  expect(result.mode).toBe('observe');
  expect(result.unknown).toBe('observe');
  expect(result.receipts.every(receipt => receipt.state === 'completed' && receipt.result.status === 'rejected')).toBe(true);
  expect(result.read.result.status).toBe('completed');
  expect(result.screenshot.result.status).toBe('completed');
  expect(result.revoked).toBe('Browser session revoked');
});
