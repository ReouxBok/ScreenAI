import { evaluationGrant, EVALUATION_CODE_HEADER } from './evaluation-grant.js';
import { readDeepAgentEvents } from './sse.js';
import { LIMOVA_API_URL } from './environment.js';

export { LIMOVA_APP_URL, LIMOVA_API_URL } from './environment.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestFailureCode = status => status === 429 ? 'LIMOVA_RATE_LIMITED'
  : status >= 500 ? 'LIMOVA_HTTP_5XX' : 'LIMOVA_REQUEST_FAILED';

export class LimovaClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new LimovaClientError('INVALID_IDENTIFIER', 'Identifiant Limova invalide.');
  }
  return value;
}

function browserContext(browser) {
  id(browser?.sessionId);
  const page = browser?.page;
  let origin;
  try { origin = new URL(page?.origin); } catch { /* Validated below. */ }
  if (!page || !Number.isSafeInteger(page.tabId) || page.tabId < 0
    || !Number.isSafeInteger(page.contextVersion) || page.contextVersion < 0
    || !origin || origin.protocol !== 'https:' || origin.origin !== page.origin
    || page.origin.length > 2048) {
    throw new LimovaClientError('INVALID_BROWSER_CONTEXT', 'Contexte navigateur invalide.');
  }
  return { tabId: page.tabId, origin: page.origin, contextVersion: page.contextVersion };
}

function browserResult(result) {
  id(result?.turnId);
  if (result.imageFileId !== undefined) {
    id(result.imageFileId);
    if (result.status !== 'completed') throw new LimovaClientError('INVALID_BROWSER_RESULT', 'Résultat navigateur invalide.');
  }
  if (typeof result.actionId !== 'string' || !result.actionId || result.actionId.length > 256
    || typeof result.toolCallId !== 'string' || !result.toolCallId || result.toolCallId.length > 128
    || !Number.isSafeInteger(result.contextVersion) || result.contextVersion < 0
    || !['completed', 'rejected', 'failed'].includes(result.status)
    || typeof result.observation !== 'string' || result.observation.length > 32000) {
    throw new LimovaClientError('INVALID_BROWSER_RESULT', 'Résultat navigateur invalide.');
  }
  return { turnId: result.turnId, actionId: result.actionId, toolCallId: result.toolCallId,
    contextVersion: result.contextVersion, status: result.status, observation: result.observation,
    ...(result.imageFileId !== undefined ? { imageFileId: result.imageFileId } : {}) };
}

function unwrap(payload) {
  return payload && Object.hasOwn(payload, 'data') ? payload.data : payload;
}

export class LimovaDeepAgentClient {
  #fetch;
  #refreshPromise = null;
  #refreshGeneration = 0;

  constructor(fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.#fetch = fetchImpl;
  }

  async #refresh() {
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#fetch(`${LIMOVA_API_URL}/auth/refresh-token`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }).then(async response => {
        await response.body?.cancel();
        if (!response.ok) throw new LimovaClientError(
          response.status === 401 || response.status === 403 ? 'LIMOVA_LOGIN_REQUIRED' : requestFailureCode(response.status),
          response.status === 401 || response.status === 403 ? 'Connecte-toi dans Limova pour utiliser l’extension.' : 'Limova est temporairement indisponible.', response.status);
        this.#refreshGeneration += 1;
      }).finally(() => { this.#refreshPromise = null; });
    }
    return this.#refreshPromise;
  }

  async #request(path, { method = 'GET', body, workspaceId, signal, stream = false, download = false, browserSession, evaluationCode, expectedContext, requireEnabled = true } = {}) {
    if (!signal && !stream) signal = AbortSignal.timeout(30_000);
    const generation = this.#refreshGeneration;
    const headers = { Accept: download ? 'text/csv' : stream ? 'text/event-stream' : 'application/json' };
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
    if (workspaceId) headers['x-workspace-id'] = id(workspaceId);
    if (browserSession !== undefined) headers['x-extension-session'] = id(browserSession);
    if (evaluationCode !== undefined) headers[EVALUATION_CODE_HEADER] = evaluationGrant(evaluationCode);
    const options = { method, headers, credentials: 'include', cache: 'no-store', signal,
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}) };
    let response = await this.#fetch(`${LIMOVA_API_URL}${path}`, options);
    if (response.status === 401) {
      await response.body?.cancel();
      if (generation === this.#refreshGeneration) await this.#refresh();
      signal?.throwIfAborted();
      if (expectedContext) await this.#assertContext(expectedContext, signal, requireEnabled);
      response = await this.#fetch(`${LIMOVA_API_URL}${path}`, options);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status === 401 ? 'LIMOVA_LOGIN_REQUIRED'
        : response.status === 403 ? 'LIMOVA_ACCESS_DENIED' : requestFailureCode(response.status);
      throw new LimovaClientError(code, response.status === 401
        ? 'Connecte-toi dans Limova pour utiliser l’extension.' : 'La requête Limova n’a pas abouti.', response.status);
    }
    if (download) return response;
    if (stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new LimovaClientError('INVALID_STREAM', 'Le serveur n’a pas renvoyé de flux Deep Agent.');
      }
      return response;
    }
    return unwrap(await response.json());
  }

  async bootstrap(signal) {
    const user = await this.#request('/users/me', { signal });
    id(user?.id);
    const workspaces = await this.#request('/workspaces', { signal });
    if (!Array.isArray(workspaces)) throw new LimovaClientError('INVALID_RESPONSE', 'Espaces Limova indisponibles.');
    return { user: { id: user.id, name: user.firstName ?? user.name ?? '' }, workspaces: workspaces.map(workspace => ({
      id: id(workspace.id), name: String(workspace.name ?? ''), organizationId: workspace.organizationId,
      enabled: workspace.is_charly_extension_enabled === true,
    })) };
  }

  async #assertContext(context, signal, requireEnabled = true) {
    id(context?.userId);
    id(context?.workspaceId);
    const current = await this.bootstrap(signal);
    if (current.user.id !== context.userId) throw new LimovaClientError('LIMOVA_ACCOUNT_CHANGED', 'Le compte Limova a changé. Sélectionne de nouveau ton espace.');
    const workspace = current.workspaces.find(item => item.id === context.workspaceId);
    if (!workspace || requireEnabled && !workspace.enabled) throw new LimovaClientError('LIMOVA_EXTENSION_DISABLED', 'L’extension n’est pas activée pour cet espace.');
  }

  async validateContext(context, signal) { await this.#assertContext(context, signal); }

  async getMainAgent(context, signal) {
    await this.#assertContext(context, signal);
    const agent = await this.#request('/agent/by-slug/charly', { workspaceId: context.workspaceId, signal, expectedContext: { ...context } });
    if (agent?.slug !== 'charly') throw new LimovaClientError('INVALID_AGENT', 'L’agent principal Limova est indisponible.');
    id(agent.id);
    return agent;
  }

  async createConversation(context, title = 'Discussion avec Charly', signal, evaluationCode) {
    evaluationGrant(evaluationCode);
    const agent = await this.getMainAgent(context, signal);
    const conversation = await this.#request('/conversation', { evaluationCode, method: 'POST', workspaceId: context.workspaceId, signal,
      expectedContext: { ...context },
      body: { title: String(title).slice(0, 200), type: 'general', engine: 'deep_agents', botAgentId: id(agent.id), disableFirstMessage: true } });
    id(conversation?.id);
    return conversation;
  }

  async exportConversation(context, conversationId, signal = AbortSignal.timeout(30_000)) {
    context = Object.freeze({ ...context });
    await this.getConversation(context, conversationId, signal);
    const response = await this.#request(`/conversation/${id(conversationId)}/download`, {
      workspaceId: context.workspaceId, signal, expectedContext: context, download: true,
    });
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/csv') {
      await response.body?.cancel();
      throw new LimovaClientError('INVALID_EXPORT', 'Le serveur n’a pas renvoyé un export CSV.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new LimovaClientError('INVALID_EXPORT', 'Export indisponible.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10 * 1024 * 1024) throw new LimovaClientError('EXPORT_TOO_LARGE', 'L’export dépasse 10 Mo. Télécharge-le depuis l’app Limova.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const content = await new Blob(chunks).text();
    await this.#assertContext(context, signal);
    return { content, mimeType: 'text/csv;charset=utf-8', filename: `limova-conversation-${conversationId}.csv` };
  }

  async listConversations(context, page = 1, signal) {
    await this.#assertContext(context, signal);
    if (!Number.isInteger(page) || page < 1) throw new LimovaClientError('INVALID_PAGE', 'Page invalide.');
    return this.#request(`/conversation?engine=deep_agents&type=general&page=${page}&limit=20`, { workspaceId: context.workspaceId, signal, expectedContext: { ...context } });
  }

  async getConversation(context, conversationId, signal, browserSession) {
    await this.#assertContext(context, signal);
    const conversation = await this.#request(`/conversation/${id(conversationId)}`, { workspaceId: context.workspaceId, signal, browserSession, expectedContext: { ...context } });
    if (conversation?.engine !== 'deep_agents' || conversation?.mainAgent?.slug !== 'charly') {
      throw new LimovaClientError('INVALID_CONVERSATION', 'Sélectionne une conversation Deep Agent avec Charly.');
    }
    return conversation;
  }

  async getMessages(context, conversationId, cursor, signal) {
    await this.getConversation(context, conversationId, signal);
    const query = cursor ? `?before=${encodeURIComponent(id(cursor))}` : '';
    return this.#request(`/conversation/${id(conversationId)}/messages${query}`, { workspaceId: context.workspaceId, signal, expectedContext: { ...context } });
  }

  async resolveGeneratedFile(context, conversationId, fileId, signal = AbortSignal.timeout(30_000)) {
    id(fileId);
    const visited = new Set();
    let cursor;
    while (true) {
      signal.throwIfAborted();
      const page = await this.getMessages(context, conversationId, cursor, signal);
      const attached = (Array.isArray(page?.data) ? page.data : [])
        .filter(message => message?.toShow !== false && ['assistant', 'ai', 'user', 'human'].includes(message.role ?? message.type))
        .flatMap(message => [message.generatedFiles, message.generatedImages, message.generatedVideos, message.generatedCarousel?.slides]
          .flatMap(items => Array.isArray(items) ? items : []));
      const files = [...attached, ...(Array.isArray(page?.unanchoredGeneratedFiles) ? page.unanchoredGeneratedFiles : [])];
      const file = files.find(item => item?.fileId === fileId);
      if (file) {
        let url;
        try { url = new URL(file.fileUrl); } catch { /* Invalid URLs are rejected below. */ }
        if (!url || url.protocol !== 'https:' || url.username || url.password)
          throw new LimovaClientError('INVALID_FILE_URL', 'Le lien du fichier est invalide.');
        await this.#assertContext(context, signal);
        return { fileId, url: url.href };
      }
      if (page?.pagination?.hasMore !== true) break;
      const next = id(page.pagination.nextCursor);
      if (visited.has(next)) throw new LimovaClientError('INVALID_PAGINATION', 'Impossible de parcourir cet historique.');
      visited.add(next);
      cursor = next;
    }
    throw new LimovaClientError('FILE_NOT_FOUND', 'Ce fichier n’est plus disponible dans cette conversation.');
  }

  async uploadBrowserScreenshot(context, conversationId, image, signal) {
    if (!(image instanceof Blob) || !['image/png', 'image/jpeg'].includes(image.type)
      || image.size === 0 || image.size > 5 * 1024 * 1024) {
      throw new LimovaClientError('INVALID_SCREENSHOT', 'Capture invalide ou trop volumineuse.');
    }
    await this.getConversation(context, conversationId, signal);
    const body = new FormData();
    body.append('file', image, image.type === 'image/png' ? 'browser-screenshot.png' : 'browser-screenshot.jpg');
    const file = await this.#request('/files?isTemporary=true&useAsDefaultContext=false', {
      method: 'POST', body, workspaceId: context.workspaceId, signal, expectedContext: { ...context },
    });
    return { fileId: id(file?.id) };
  }

  async *sendMessage(context, conversationId, content, signal, browser, evaluationCode) {
    evaluationGrant(evaluationCode);
    const page = browser === undefined ? undefined : browserContext(browser);
    await this.getConversation(context, conversationId, signal);
    if (typeof content !== 'string' || !content.trim() || content.length > 8000) {
      throw new LimovaClientError('INVALID_MESSAGE', 'Message vide ou trop long.');
    }
    const response = await this.#request(`/message/${id(conversationId)}`, {
      method: 'POST', workspaceId: context.workspaceId, signal, stream: true,
      expectedContext: { ...context },
      browserSession: browser?.sessionId, evaluationCode,
      body: { content, clientSurface: 'chrome_extension', userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(page ? { browserContext: page } : {}) },
    });
    yield* readDeepAgentEvents(response.body, signal);
  }

  async getBrowserTurn(context, conversationId, browserSession, signal) {
    const session = id(browserSession);
    const conversation = await this.getConversation(context, conversationId, signal, session);
    const turn = conversation.browserTurn;
    if (turn === null || turn === undefined) return null;
    id(turn.turnId);
    if (!['open', 'completed', 'cancelled'].includes(turn.status)) {
      throw new LimovaClientError('INVALID_BROWSER_TURN', 'État du tour navigateur invalide.');
    }
    return { turnId: turn.turnId, status: turn.status };
  }

  async *sendBrowserResult(context, conversationId, browser, result, signal, evaluationCode) {
    evaluationGrant(evaluationCode);
    const page = browserContext(browser);
    const receipt = browserResult(result);
    yield* this.#continueBrowser(context, conversationId, browser.sessionId, {
      kind: 'browser_tool_result', browserContext: page, browserResult: receipt,
    }, signal, evaluationCode);
  }

  async *resumeBrowserTurn(context, conversationId, browser, turnId, signal, evaluationCode) {
    evaluationGrant(evaluationCode);
    const page = browserContext(browser);
    yield* this.#continueBrowser(context, conversationId, browser.sessionId, {
      kind: 'browser_resume', browserContext: page, browserTurnId: id(turnId),
    }, signal, evaluationCode);
  }

  async *#continueBrowser(context, conversationId, browserSession, body, signal, evaluationCode) {
    await this.getConversation(context, conversationId, signal);
    const response = await this.#request(`/message/${id(conversationId)}`, {
      method: 'POST', workspaceId: context.workspaceId, signal, stream: true, browserSession, evaluationCode,
      expectedContext: { ...context },
      body: { ...body, clientSurface: 'chrome_extension' },
    });
    yield* readDeepAgentEvents(response.body, signal);
  }

  async cancel(context, conversationId, signal) {
    // Cancellation remains possible after the rollout is disabled.
    await this.#assertContext(context, signal, false);
    return this.#request(`/message/${id(conversationId)}/cancel`, { method: 'POST', workspaceId: id(context.workspaceId), signal,
      expectedContext: { ...context }, requireEnabled: false });
  }

  async logout(signal) {
    await this.#request('/auth/logout', { method: 'POST', signal });
  }
}
