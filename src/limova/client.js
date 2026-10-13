import { readDeepAgentEvents } from './sse.js';

export const LIMOVA_APP_URL = 'https://new.limova.ai';
export const LIMOVA_API_URL = 'https://api.new.limova.ai';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      }).then(response => {
        if (!response.ok) throw new LimovaClientError(
          response.status === 401 || response.status === 403 ? 'LIMOVA_LOGIN_REQUIRED' : 'LIMOVA_REQUEST_FAILED',
          response.status === 401 || response.status === 403 ? 'Connecte-toi dans Limova pour utiliser l’extension.' : 'Limova est temporairement indisponible.', response.status);
        this.#refreshGeneration += 1;
      }).finally(() => { this.#refreshPromise = null; });
    }
    return this.#refreshPromise;
  }

  async #request(path, { method = 'GET', body, workspaceId, signal, stream = false } = {}) {
    if (!signal && !stream) signal = AbortSignal.timeout(30_000);
    const generation = this.#refreshGeneration;
    const headers = { Accept: stream ? 'text/event-stream' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (workspaceId) headers['x-workspace-id'] = id(workspaceId);
    const options = { method, headers, credentials: 'include', cache: 'no-store', signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    let response = await this.#fetch(`${LIMOVA_API_URL}${path}`, options);
    if (response.status === 401) {
      if (generation === this.#refreshGeneration) await this.#refresh();
      signal?.throwIfAborted();
      response = await this.#fetch(`${LIMOVA_API_URL}${path}`, options);
    }
    if (!response.ok) {
      const code = response.status === 401 ? 'LIMOVA_LOGIN_REQUIRED'
        : response.status === 403 ? 'LIMOVA_ACCESS_DENIED' : 'LIMOVA_REQUEST_FAILED';
      throw new LimovaClientError(code, response.status === 401
        ? 'Connecte-toi dans Limova pour utiliser l’extension.' : 'La requête Limova n’a pas abouti.', response.status);
    }
    if (stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
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

  async #assertContext(context, signal) {
    id(context?.userId);
    id(context?.workspaceId);
    const current = await this.bootstrap(signal);
    if (current.user.id !== context.userId) throw new LimovaClientError('LIMOVA_ACCOUNT_CHANGED', 'Le compte Limova a changé. Sélectionne de nouveau ton espace.');
    const workspace = current.workspaces.find(item => item.id === context.workspaceId);
    if (!workspace?.enabled) throw new LimovaClientError('LIMOVA_EXTENSION_DISABLED', 'L’extension n’est pas activée pour cet espace.');
  }

  async createConversation(context, title = 'Discussion avec Charly', signal) {
    await this.#assertContext(context, signal);
    const agent = await this.#request('/agent/by-slug/charly', { workspaceId: context.workspaceId, signal });
    if (agent?.slug !== 'charly') throw new LimovaClientError('INVALID_AGENT', 'L’agent principal Limova est indisponible.');
    const conversation = await this.#request('/conversation', { method: 'POST', workspaceId: context.workspaceId, signal,
      body: { title: String(title).slice(0, 200), type: 'general', engine: 'deep_agents', botAgentId: id(agent.id), disableFirstMessage: true } });
    id(conversation?.id);
    return conversation;
  }

  async listConversations(context, page = 1, signal) {
    await this.#assertContext(context, signal);
    if (!Number.isInteger(page) || page < 1) throw new LimovaClientError('INVALID_PAGE', 'Page invalide.');
    return this.#request(`/conversation?engine=deep_agents&type=general&page=${page}&limit=20`, { workspaceId: context.workspaceId, signal });
  }

  async getConversation(context, conversationId, signal) {
    await this.#assertContext(context, signal);
    const conversation = await this.#request(`/conversation/${id(conversationId)}`, { workspaceId: context.workspaceId, signal });
    if (conversation?.engine !== 'deep_agents' || conversation?.mainAgent?.slug !== 'charly') {
      throw new LimovaClientError('INVALID_CONVERSATION', 'Sélectionne une conversation Deep Agent avec Charly.');
    }
    return conversation;
  }

  async getMessages(context, conversationId, cursor, signal) {
    await this.getConversation(context, conversationId, signal);
    const query = cursor ? `?before=${encodeURIComponent(id(cursor))}` : '';
    return this.#request(`/conversation/${id(conversationId)}/messages${query}`, { workspaceId: context.workspaceId, signal });
  }

  async *sendMessage(context, conversationId, content, signal) {
    await this.getConversation(context, conversationId, signal);
    if (typeof content !== 'string' || !content.trim() || content.length > 8000) {
      throw new LimovaClientError('INVALID_MESSAGE', 'Message vide ou trop long.');
    }
    const response = await this.#request(`/message/${id(conversationId)}`, {
      method: 'POST', workspaceId: context.workspaceId, signal, stream: true,
      body: { content, clientSurface: 'chrome_extension', userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    yield* readDeepAgentEvents(response.body, signal);
  }

  async cancel(context, conversationId, signal) {
    // Cancellation remains possible after the rollout is disabled.
    return this.#request(`/message/${id(conversationId)}/cancel`, { method: 'POST', workspaceId: id(context.workspaceId), signal });
  }

  async logout(signal) {
    await this.#request('/auth/logout', { method: 'POST', signal });
  }
}
