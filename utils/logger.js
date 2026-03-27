/**
 * Debug logging utility for Limova AI Onboarding Assistant
 * Captures logs for troubleshooting and support
 */

const Logger = {
  DEBUG: true,
  logs: [],
  maxLogs: 5000,
  conversationTurn: 0,

  log(component, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      component,
      message,
      data: this._sanitize(data)
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.log(`[${component}] ${message}`, data || '');
  },

  error(component, message, error = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      component,
      message,
      data: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : this._sanitize(error)
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.error(`[${component}] ${message}`, error || '');
  },

  warn(component, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      component,
      message,
      data: this._sanitize(data)
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.warn(`[${component}] ${message}`, data || '');
  },

  logTurnStart(trigger, context = {}) {
    this.conversationTurn++;
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'CONVERSATION',
      component: 'turn_start',
      turn: this.conversationTurn,
      trigger,
      message: `=== TOUR ${this.conversationTurn} DÉBUT (${trigger}) ===`,
      data: {
        url: context.url || 'unknown',
        hasScreenshot: context.hasScreenshot || false,
        step: context.step || 'none',
        historyLength: context.historyLength || 0
      }
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) {
      console.log(`\n${'='.repeat(50)}\nTOUR ${this.conversationTurn} - ${trigger}\n${'='.repeat(50)}`);
    }
  },

  logUserMessage(message, url) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'CONVERSATION',
      component: 'user',
      turn: this.conversationTurn,
      message: message ? `USER: ${message}` : 'USER: [Navigation automatique]',
      data: {
        fullMessage: message || '[Navigation automatique]',
        url,
        messageLength: message ? message.length : 0
      }
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.log(`[USER] ${message || '[Navigation automatique]'}`);
  },

  logGeminiResponse(response, markers = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'CONVERSATION',
      component: 'gemini',
      turn: this.conversationTurn,
      message: `GEMINI RESPONSE (${response.length} chars)`,
      data: {
        fullResponse: response,
        responseLength: response.length,
        markers
      }
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) {
      console.log(`[GEMINI] ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`);
    }
  },

  logApiRequest(details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'API',
      component: 'gemini_api',
      turn: this.conversationTurn,
      message: 'API Request',
      data: {
        model: details.model || 'unknown',
        messageCount: details.messageCount || 0,
        hasScreenshot: details.hasScreenshot || false,
        systemPromptLength: details.systemPromptLength || 0
      }
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.log(`[API] Request: model=${details.model}, messages=${details.messageCount}`);
  },

  logApiResponse(details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'API',
      component: 'gemini_api',
      turn: this.conversationTurn,
      message: 'API Response',
      data: {
        success: details.success !== false,
        status: details.status || 200,
        responseTime: details.responseTime || 0,
        error: details.error || null
      }
    };
    this.logs.push(entry);
    this._trim();
    if (this.DEBUG) console.log(`[API] Response: success=${details.success !== false}, time=${details.responseTime}ms`);
  },

  getLogsAsText() {
    const header = [
      '='.repeat(80),
      'Limova AI - Assistant Onboarding - Logs de debug',
      `Généré: ${new Date().toISOString()}`,
      `Total entrées: ${this.logs.length}`,
      `Tours de conversation: ${this.conversationTurn}`,
      '='.repeat(80),
      ''
    ].join('\n');

    const logLines = this.logs.map(entry => {
      if (entry.level === 'CONVERSATION') return this._formatConversationEntry(entry);
      if (entry.level === 'API') return this._formatApiEntry(entry);
      const dataStr = entry.data ? `\n    Data: ${JSON.stringify(entry.data)}` : '';
      return `[${entry.timestamp}] [${entry.level}] [${entry.component}] ${entry.message}${dataStr}`;
    });

    return header + logLines.join('\n');
  },

  _formatConversationEntry(entry) {
    const lines = [];
    const time = entry.timestamp.split('T')[1].split('.')[0];

    if (entry.component === 'turn_start') {
      lines.push('');
      lines.push('─'.repeat(80));
      lines.push(`[${time}] ${entry.message}`);
      lines.push(`    URL: ${entry.data?.url || 'unknown'}`);
      lines.push(`    Screenshot: ${entry.data?.hasScreenshot ? 'oui' : 'non'}`);
      lines.push(`    Historique: ${entry.data?.historyLength || 0} messages`);
      lines.push('─'.repeat(80));
    } else if (entry.component === 'user') {
      lines.push('');
      lines.push(`[${time}] USER:`);
      lines.push(this._indent(entry.data?.fullMessage || entry.message, 4));
    } else if (entry.component === 'gemini') {
      lines.push('');
      lines.push(`[${time}] CHARLY:`);
      lines.push(this._indent(entry.data?.fullResponse || entry.message, 4));
    }

    return lines.join('\n');
  },

  _formatApiEntry(entry) {
    const time = entry.timestamp.split('T')[1].split('.')[0];
    if (entry.message === 'API Request') {
      return `[${time}] API REQUEST: model=${entry.data?.model}, messages=${entry.data?.messageCount}, screenshot=${entry.data?.hasScreenshot ? 'oui' : 'non'}`;
    } else if (entry.message === 'API Response') {
      if (entry.data?.error) return `[${time}] API ERROR: ${entry.data.error} (${entry.data?.responseTime}ms)`;
      return `[${time}] API RESPONSE: success=${entry.data?.success}, time=${entry.data?.responseTime}ms`;
    }
    return `[${time}] [API] ${entry.message}`;
  },

  _indent(text, spaces) {
    if (!text) return '';
    const indent = ' '.repeat(spaces);
    return text.split('\n').map(line => indent + line).join('\n');
  },

  clearLogs() {
    this.logs = [];
    this.conversationTurn = 0;
    this.log('Logger', 'Logs effacés');
  },

  getLogs() { return [...this.logs]; },

  _trim() {
    if (this.logs.length > this.maxLogs) this.logs = this.logs.slice(-this.maxLogs);
  },

  _sanitize(data) {
    if (data === null || data === undefined) return null;
    if (typeof data === 'string') {
      if (data.length > 1000 && data.includes('base64')) return `[base64 data, ${data.length} chars]`;
      if (data.startsWith('AIza')) return 'AIza***' + data.slice(-4);
      return data;
    }
    if (typeof data === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === 'data' && typeof value === 'string' && value.length > 1000) {
          sanitized[key] = `[base64 data, ${value.length} chars]`;
        } else if (key.toLowerCase().includes('apikey') || key.toLowerCase().includes('api_key')) {
          sanitized[key] = typeof value === 'string' ? '***' + value.slice(-4) : '[redacted]';
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }
    return data;
  }
};

export default Logger;
