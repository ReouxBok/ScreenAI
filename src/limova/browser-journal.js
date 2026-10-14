const DATABASE = 'limova_browser_receipts_v1';
const STORE = 'receipts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['read_page', 'click', 'type_text', 'scroll', 'navigate', 'screenshot', 'highlight']);

function identifier(value) {
  return typeof value === 'string' && UUID.test(value);
}

function validInput(input) {
  if (!input || !OPERATIONS.has(input.operation)) return false;
  const fields = Object.keys(input).filter(key => key !== 'operation');
  const hasOnly = (...keys) => fields.length === keys.length && fields.every(key => keys.includes(key));
  const element = Number.isSafeInteger(input.elementId) && input.elementId >= 0;
  switch (input.operation) {
    case 'click':
    case 'highlight': return hasOnly('elementId') && element;
    case 'type_text': return hasOnly('elementId', 'text') && element && typeof input.text === 'string' && input.text.length <= 8000;
    case 'scroll': return hasOnly('direction') && ['up', 'down'].includes(input.direction);
    case 'navigate': {
      if (!hasOnly('url') || typeof input.url !== 'string' || input.url.length > 2048) return false;
      try {
        const url = new URL(input.url);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch { return false; }
    }
    default: return hasOnly();
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function validate(scope, action) {
  if (!scope || !['userId', 'workspaceId', 'conversationId', 'sessionId'].every(key => identifier(scope[key]))
    || action?.type !== 'extension.action_requested' || action.protocolVersion !== 1 || !identifier(action.turnId)
    || typeof action.actionId !== 'string' || !action.actionId || action.actionId.length > 256
    || typeof action.toolCallId !== 'string' || !action.toolCallId || action.toolCallId.length > 128
    || !validInput(action.input) || typeof action.expiresAt !== 'string' || !Number.isFinite(Date.parse(action.expiresAt))) throw new Error('Invalid browser action');
  const page = action.target;
  const origin = new URL(page?.origin);
  if (origin.protocol !== 'https:' || origin.origin !== page.origin || page.origin.length > 2048
    || !Number.isSafeInteger(page.tabId) || page.tabId < 0
    || !Number.isSafeInteger(page.contextVersion) || page.contextVersion < 0) throw new Error('Invalid browser target');
  return JSON.stringify([scope.userId, scope.workspaceId, scope.conversationId, scope.sessionId, action.turnId, action.actionId]);
}

function turnPolicyKey(scope, turnId) {
  if (!['userId', 'workspaceId', 'conversationId', 'sessionId'].every(key => identifier(scope?.[key]))
    || !identifier(turnId)) throw new Error('Invalid browser turn policy');
  return JSON.stringify([scope.userId, scope.workspaceId, scope.conversationId, scope.sessionId, turnId, 'policy', 'turn-mode']);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Browser receipt database blocked'));
  });
}

function sessionKey(scope) {
  if (!scope || !identifier(scope.userId) || !identifier(scope.workspaceId)) throw new Error('Invalid browser session context');
  return JSON.stringify([scope.userId, scope.workspaceId, 'session']);
}

function change(database, key, update, scope) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore(STORE);
    let answer;
    const fail = error => { reject(error); transaction.abort(); };
    const load = () => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const next = update(request.result);
          answer = next.answer;
          if (next.record !== undefined) store.put(next.record, key);
        } catch (error) { fail(error); }
      };
    };
    if (scope) {
      const session = store.get(sessionKey(scope));
      session.onsuccess = () => {
        if (session.result?.sessionId !== scope.sessionId) fail(new Error('Browser session revoked'));
        else load();
      };
    } else load();
    transaction.oncomplete = () => resolve(answer);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser receipt transaction aborted'));
  });
}

function clearPrefix(db, prefix) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const request = transaction.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser receipt cleanup aborted'));
  });
}

export function createBrowserJournal() {
  let database;
  const getDatabase = () => database ??= openDatabase();
  return {
    async setTurnMode(scope, turnId, mode) {
      scope = Object.freeze(structuredClone(scope));
      if (!['observe', 'act'].includes(mode)) throw new Error('Invalid browser mode');
      return change(await getDatabase(), turnPolicyKey(scope, turnId), current => {
        if (current && current.mode !== mode) throw new Error('Browser turn mode cannot change');
        return { record: { mode }, answer: mode };
      }, scope);
    },
    async getTurnMode(scope, turnId) {
      scope = Object.freeze(structuredClone(scope));
      return change(await getDatabase(), turnPolicyKey(scope, turnId), current => ({ answer: current?.mode === 'act' ? 'act' : 'observe' }), scope);
    },
    async getSession(scope) {
      const key = sessionKey(scope);
      return change(await getDatabase(), key, current => {
        if (identifier(current?.sessionId)) return { answer: current.sessionId };
        const sessionId = crypto.randomUUID();
        return { record: { sessionId }, answer: sessionId };
      });
    },
    async allocateVersion(scope) {
      scope = Object.freeze(structuredClone(scope));
      const key = sessionKey(scope);
      if (!identifier(scope.sessionId)) throw new Error('Invalid browser session');
      return change(await getDatabase(), key, current => {
        const previous = current.contextVersion ?? 0;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error('Browser context version exhausted');
        const contextVersion = previous + 1;
        return { record: { ...current, contextVersion }, answer: contextVersion };
      }, scope);
    },
    async revokeSession(scope) {
      sessionKey(scope);
      const prefix = JSON.stringify([scope.userId, scope.workspaceId]).slice(0, -1) + ',';
      await clearPrefix(await getDatabase(), prefix);
    },
    async run(scope, action, execute) {
      scope = Object.freeze(structuredClone(scope));
      action = structuredClone(action);
      const key = validate(scope, action);
      Object.freeze(action.target);
      Object.freeze(action.input);
      Object.freeze(action);
      const encoded = new TextEncoder().encode(JSON.stringify(canonical(action)));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), byte => byte.toString(16).padStart(2, '0')).join('');
      const owner = crypto.randomUUID();
      const db = await getDatabase();
      const claim = await change(db, key, current => {
        if (current) {
          if (current.digest !== digest) throw new Error('Browser action changed after receipt');
          return { answer: current.state === 'completed'
            ? { state: 'completed', result: current.result, observedAt: current.observedAt }
            : { state: 'uncertain', result: null } };
        }
        if (Date.parse(action.expiresAt) <= Date.now()) throw new Error('Browser action expired');
        return { record: { digest, owner, state: 'started' }, answer: { state: 'execute' } };
      }, scope);
      if (claim.state !== 'execute') return claim;
      let observation;
      try {
        const mode = await change(db, turnPolicyKey(scope, action.turnId), current => ({ answer: current?.mode }), scope);
        observation = mode !== undefined && mode !== 'act' && !['read_page', 'screenshot', 'highlight'].includes(action.input.operation)
          ? { status: 'rejected', observation: 'This turn only permits page observation, not browser actions.' }
          : await execute(action);
      } catch { return { state: 'uncertain', result: null }; }
      if (!['completed', 'rejected', 'failed'].includes(observation?.status)
        || typeof observation.observation !== 'string' || observation.observation.length > 32000) {
        throw new Error('Invalid browser observation; execution must be inspected');
      }
      const expectsImage = action.input.operation === 'screenshot' && observation.status === 'completed';
      if (expectsImage !== (observation.imageFileId !== undefined)
        || (expectsImage && !identifier(observation.imageFileId))) {
        throw new Error('Invalid screenshot receipt; execution must be inspected');
      }
      const result = { turnId: action.turnId, actionId: action.actionId, toolCallId: action.toolCallId,
        contextVersion: action.target.contextVersion, status: observation.status, observation: observation.observation,
        ...(expectsImage ? { imageFileId: observation.imageFileId } : {}) };
      const observedAt = new Date().toISOString();
      return change(db, key, current => {
        if (current?.owner !== owner || current.digest !== digest || current.state !== 'started') throw new Error('Browser receipt was invalidated');
        return { record: { ...current, state: 'completed', result, observedAt }, answer: { state: 'completed', result, observedAt } };
      }, scope);
    },
    async clearScope(scope) {
      if (!scope || !['userId', 'workspaceId', 'conversationId', 'sessionId'].every(key => identifier(scope[key]))) throw new Error('Invalid browser scope');
      const prefix = JSON.stringify([scope.userId, scope.workspaceId, scope.conversationId, scope.sessionId]).slice(0, -1) + ',';
      const db = await getDatabase();
      await clearPrefix(db, prefix);
    },
    async clearAccount(userId) {
      if (!identifier(userId)) throw new Error('Invalid browser account');
      const prefix = JSON.stringify([userId]).slice(0, -1) + ',';
      await clearPrefix(await getDatabase(), prefix);
    },
    async close() {
      if (database) (await database).close();
      database = undefined;
    },
  };
}
