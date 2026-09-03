/**
 * Privacy-first diagnostic logger.
 *
 * Logs contain operational metadata only: never conversation text, page
 * contents, form values, audio, credentials, request bodies or auth headers.
 * A bounded copy is kept in chrome.storage.session so MV3 service-worker
 * restarts do not erase the evidence needed by support.
 */

const STORAGE_KEY = 'limova_diagnostic_logs_v2';
const SENSITIVE_KEY = /(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|audio|base64|body|contents?|prompt|transcript|fullmessage|fullresponse)/i;

function randomId(prefix = 'evt') {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${value}`;
}

function sanitizeText(value, maxLength = 800) {
  let text = String(value ?? '');
  if (text.length > 1000 && /(?:base64|data:)/i.test(text)) return `[binary-data-redacted:${text.length}]`;
  text = text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[api-key-redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt-redacted]')
    .replace(/([?&](?:token|code|key|secret|password|signature|auth)\s*=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/\+?\d(?:[ .()-]?\d){7,}/g, (candidate, offset, source) => {
      const before = source[offset - 1] || '';
      const after = source[offset + candidate.length] || '';
      if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(after)) return candidate;
      const digitCount = candidate.replace(/\D/g, '').length;
      return digitCount >= 8 && digitCount <= 15 ? '[phone-redacted]' : candidate;
    })
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"')]+/gi, raw => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[url-redacted]';
      }
    });
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
}

function sanitizeValue(value, key = '', seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return null;
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (depth > 5) return '[max-depth]';
  if (typeof value !== 'object') return sanitizeText(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeValue(item, key, seen, depth + 1));
  }

  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1);
  }
  return sanitized;
}

const Logger = {
  DEBUG: false,
  logs: [],
  maxLogs: 1000,
  conversationTurn: 0,
  storageArea: null,
  metadata: {},
  bootId: randomId('boot'),
  bootStartedAt: new Date().toISOString(),
  _persistPromise: Promise.resolve(),

  async initialize({ storageArea = null, metadata = {} } = {}) {
    this.storageArea = storageArea;
    this.metadata = sanitizeValue(metadata);
    if (storageArea?.get) {
      try {
        const stored = await storageArea.get(STORAGE_KEY);
        const snapshot = stored?.[STORAGE_KEY];
        if (Array.isArray(snapshot?.logs)) this.logs = sanitizeValue(snapshot.logs).slice(-this.maxLogs);
        if (Number.isInteger(snapshot?.conversationTurn)) this.conversationTurn = snapshot.conversationTurn;
      } catch (_) {
        // Diagnostics must never prevent the extension from booting.
      }
    }
    this.record('INFO', 'service_worker', 'SERVICE_WORKER_STARTED', 'Service worker started', {
      bootId: this.bootId,
      previousEntries: this.logs.length,
      ...this.metadata
    });
  },

  createOperationId(kind = 'operation') {
    return randomId(String(kind).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'operation');
  },

  record(level, component, code, message, data = null, operationId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: sanitizeText(component, 80),
      code: sanitizeText(code || 'UNSPECIFIED', 100),
      message: sanitizeText(message, 300),
      operationId: operationId ? sanitizeText(operationId, 100) : null,
      bootId: this.bootId,
      turn: this.conversationTurn || undefined,
      data: sanitizeValue(data)
    };
    this.logs.push(entry);
    this._trim();
    this._persist();
    if (this.DEBUG) console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](`[${entry.component}] ${entry.code}: ${entry.message}`, entry.data || '');
    return entry;
  },

  log(component, message, data = null) {
    return this.record('INFO', component, 'INFO', message, data);
  },

  event(component, code, data = null, operationId = null, message = code) {
    return this.record('INFO', component, code, message, data, operationId);
  },

  error(component, message, error = null, code = 'UNEXPECTED_ERROR', operationId = null) {
    const details = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack, code: error.code }
      : error;
    return this.record('ERROR', component, code || error?.code || 'UNEXPECTED_ERROR', message, details, operationId);
  },

  warn(component, message, data = null, code = 'WARNING', operationId = null) {
    return this.record('WARN', component, code, message, data, operationId);
  },

  logTurnStart(trigger, context = {}) {
    this.conversationTurn += 1;
    return this.record('INFO', 'conversation', 'TURN_STARTED', 'Conversation turn started', {
      trigger,
      path: context.url || 'unknown',
      hasPageContext: Boolean(context.hasPageContext),
      step: context.step || 'none',
      historyLength: Number(context.historyLength || 0)
    }, context.operationId || null);
  },

  logUserMessage(message, url, operationId = null) {
    return this.record('INFO', 'conversation', 'USER_MESSAGE_ACCEPTED', 'User message accepted', {
      messageLength: String(message || '').length,
      path: url || 'unknown',
      textIncluded: false
    }, operationId);
  },

  logGeminiResponse(response, markers = {}, operationId = null) {
    return this.record('INFO', 'gemini', 'GEMINI_RESPONSE_ACCEPTED', 'Gemini response accepted', {
      responseLength: String(response || '').length,
      markers,
      textIncluded: false
    }, operationId);
  },

  logApiRequest(details = {}) {
    return this.record('INFO', 'gemini_api', 'API_REQUEST_STARTED', 'API request started', {
      model: details.model || 'unknown',
      messageCount: Number(details.messageCount || 0),
      hasPageContext: Boolean(details.hasPageContext),
      systemPromptLength: Number(details.systemPromptLength || 0),
      attempt: Number(details.attempt || 1)
    }, details.operationId || null);
  },

  logApiResponse(details = {}) {
    const success = details.success !== false;
    return this.record(success ? 'INFO' : 'ERROR', 'gemini_api', details.code || (success ? 'API_REQUEST_SUCCEEDED' : 'API_REQUEST_FAILED'), success ? 'API request succeeded' : 'API request failed', {
      success,
      status: Number(details.status || 0),
      responseTime: Number(details.responseTime || 0),
      error: details.error || null,
      attempt: Number(details.attempt || 1)
    }, details.operationId || null);
  },

  getSummary() {
    const errors = this.logs.filter(entry => entry.level === 'ERROR');
    const warnings = this.logs.filter(entry => entry.level === 'WARN');
    return {
      totalEntries: this.logs.length,
      errors: errors.length,
      warnings: warnings.length,
      lastErrorCode: errors.at(-1)?.code || null,
      bootsObserved: new Set(this.logs.map(entry => entry.bootId).filter(Boolean)).size
    };
  },

  getLogsAsText(diagnostic = null) {
    const summary = this.getSummary();
    const lines = [
      '='.repeat(80),
      'Limova AI - Paquet de diagnostic sécurisé',
      `Généré: ${new Date().toISOString()}`,
      `Schéma: 2`,
      `Extension: ${this.metadata.extensionVersion || 'unknown'}`,
      `Incident: ${diagnostic?.incidentId || randomId('incident')}`,
      `Entrées: ${summary.totalEntries} | Erreurs: ${summary.errors} | Avertissements: ${summary.warnings}`,
      `Redémarrages observés du service worker: ${summary.bootsObserved}`,
      'Confidentialité: conversations, valeurs de formulaire, audio et identifiants sont exclus.',
      '='.repeat(80)
    ];

    if (diagnostic) {
      lines.push('', 'DIAGNOSTIC LOCAL');
      for (const check of diagnostic.checks || []) {
        lines.push(`- [${String(check.status || 'unknown').toUpperCase()}] ${check.name}: ${sanitizeText(check.detail || '', 240)}`);
      }
      if (diagnostic.probableCause) lines.push(`Cause probable: ${sanitizeText(diagnostic.probableCause, 300)}`);
    }

    lines.push('', 'ÉVÉNEMENTS');
    for (const entry of this.logs) {
      const operation = entry.operationId ? ` [op=${entry.operationId}]` : '';
      const data = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : '';
      lines.push(`[${entry.timestamp}] [${entry.level}] [${entry.component}] [${entry.code}]${operation} ${entry.message}${data}`);
    }
    return lines.join('\n');
  },

  clearLogs() {
    this.logs = [];
    this.conversationTurn = 0;
    this.record('INFO', 'logger', 'LOGS_CLEARED', 'Diagnostic logs cleared');
  },

  getLogs() {
    return this.logs.map(entry => sanitizeValue(entry));
  },

  async flush() {
    await this._persistPromise;
  },

  _trim() {
    if (this.logs.length > this.maxLogs) this.logs = this.logs.slice(-this.maxLogs);
  },

  _sanitize(data) {
    return sanitizeValue(data);
  },

  _persist() {
    if (!this.storageArea?.set) return;
    const snapshot = {
      schema: 2,
      conversationTurn: this.conversationTurn,
      logs: this.logs.slice(-this.maxLogs)
    };
    this._persistPromise = this._persistPromise
      .catch(() => {})
      .then(() => this.storageArea.set({ [STORAGE_KEY]: snapshot }))
      .catch(() => {});
  }
};

export default Logger;
