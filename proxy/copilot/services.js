const { BaseSessionService, createEvent, createSession } = require('@google/adk');

const APP_NAME = 'charly_copilot';

function eventFromMessage(message) {
  const isAssistant = message.role === 'assistant';
  return createEvent({
    id: message.id,
    author: isAssistant ? APP_NAME : 'user',
    timestamp: Date.parse(message.createdAt) || Date.now(),
    content: {
      role: isAssistant ? 'model' : 'user',
      parts: [{ text: String(message.content || '').slice(0, 8_000) }]
    }
  });
}

class CharlySessionService extends BaseSessionService {
  constructor({ memoryRequest, promptRevision }) {
    super();
    this.memoryRequest = memoryRequest;
    this.promptRevision = promptRevision;
    this.sessions = new Map();
  }

  key(userId, sessionId) {
    return `${userId}:${sessionId}`;
  }

  async createSession(request) {
    const result = await this.memoryRequest('/api/internal/memory/sessions', {
      body: {
        userKey: request.userId,
        action: 'open',
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        promptRevision: this.promptRevision,
        state: request.state || {}
      }
    });
    if (!result?.response?.ok || !result.data?.id) throw new Error('SESSION_CREATE_FAILED');
    const session = createSession({
      id: result.data.id,
      appName: request.appName || APP_NAME,
      userId: request.userId,
      state: request.state || {},
      events: [],
      lastUpdateTime: result.data.lastUpdateTime || Date.now()
    });
    this.sessions.set(this.key(request.userId, session.id), session);
    return session;
  }

  async getSession(request) {
    const cached = this.sessions.get(this.key(request.userId, request.sessionId));
    if (cached) return cached;
    const result = await this.memoryRequest('/api/internal/memory/sessions', {
      body: { userKey: request.userId, action: 'get', sessionId: request.sessionId }
    });
    if (result?.response?.status === 404) return undefined;
    if (!result?.response?.ok || !result.data?.id || result.data.status !== 'active') return undefined;
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    const session = createSession({
      id: result.data.id,
      appName: request.appName || APP_NAME,
      userId: request.userId,
      state: result.data.state || {},
      events: messages.map(eventFromMessage),
      lastUpdateTime: result.data.lastUpdateTime || Date.now()
    });
    this.sessions.set(this.key(request.userId, request.sessionId), session);
    return session;
  }

  async listSessions(request) {
    const sessions = [...this.sessions.values()].filter(session => session.userId === request.userId && session.appName === request.appName);
    const ordered = request.order === 'asc'
      ? sessions.sort((a, b) => a.lastUpdateTime - b.lastUpdateTime)
      : sessions.sort((a, b) => b.lastUpdateTime - a.lastUpdateTime);
    const offset = Math.max(0, request.offset || 0);
    const limit = Math.max(1, request.limit || ordered.length || 1);
    const pageSessions = ordered.slice(offset, offset + limit);
    return { sessions: pageSessions, page: Math.floor(offset / limit) + 1, limit, totalItems: ordered.length, totalPages: Math.ceil(ordered.length / limit) };
  }

  async deleteSession(request) {
    await this.memoryRequest('/api/internal/memory/sessions', {
      body: { userKey: request.userId, action: 'close', sessionId: request.sessionId, reason: 'deleted_by_runner' }
    });
    this.sessions.delete(this.key(request.userId, request.sessionId));
  }

  async appendEvent({ session, event }) {
    const appended = await super.appendEvent({ session, event });
    session.lastUpdateTime = Date.now();
    const evaluationContext = event.actions?.stateDelta?.['temp:evaluationContext']
      || session.state?.['temp:evaluationContext']
      || session.state?.get?.('temp:evaluationContext');
    if (!evaluationContext && event.actions?.stateDelta && Object.keys(event.actions.stateDelta).length) {
      await this.memoryRequest('/api/internal/memory/sessions', {
        body: { userKey: session.userId, action: 'update_state', sessionId: session.id, state: session.state }
      }).catch(() => null);
    }
    return appended;
  }
}

class CharlyMemoryService {
  constructor({ memoryRequest }) {
    this.memoryRequest = memoryRequest;
  }

  async addSessionToMemory() {
    // Messages are persisted before/after each completed turn by the orchestrator.
  }

  async searchMemory(request) {
    const result = await this.memoryRequest('/api/internal/memory/bootstrap', {
      body: { userKey: request.userId, query: String(request.query || '').slice(0, 2_000) }
    });
    if (!result?.response?.ok) return { memories: [] };
    const data = result.data || {};
    const values = [
      ...(Array.isArray(data.memories) ? data.memories.map(item => item.statement) : []),
      ...(Array.isArray(data.goals) ? data.goals.map(item => `Objectif: ${item.title}${item.nextStep ? ` — ${item.nextStep}` : ''}`) : []),
      ...(data.continuity ? [data.continuity] : [])
    ].filter(Boolean).slice(0, 10);
    return {
      memories: values.map(value => ({
        author: 'memory',
        content: { role: 'user', parts: [{ text: String(value).slice(0, 4_000) }] },
        timestamp: new Date().toISOString()
      }))
    };
  }
}

module.exports = { APP_NAME, CharlyMemoryService, CharlySessionService };
