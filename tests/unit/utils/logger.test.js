import { describe, it, expect, beforeEach } from 'vitest';
import Logger from '../../../src/utils/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    Logger.storageArea = null;
    Logger.metadata = {};
    Logger.clearLogs();
    Logger.DEBUG = false;
  });

  describe('log levels', () => {
    it('log() records an INFO entry', () => {
      Logger.log('test', 'hello', { foo: 'bar' });
      const logs = Logger.getLogs();
      expect(logs).toHaveLength(2); // clearLogs also emits one
      expect(logs[1].level).toBe('INFO');
      expect(logs[1].component).toBe('test');
      expect(logs[1].message).toBe('hello');
      expect(logs[1].data).toEqual({ foo: 'bar' });
    });

    it('error() records an ERROR entry and serializes Error instances', () => {
      const err = new Error('boom');
      Logger.error('api', 'failed', err);
      const entry = Logger.getLogs().at(-1);
      expect(entry.level).toBe('ERROR');
      expect(entry.data).toMatchObject({ name: 'Error', message: 'boom' });
      expect(typeof entry.data.stack).toBe('string');
    });

    it('warn() records a WARN entry', () => {
      Logger.warn('test', 'watch out');
      expect(Logger.getLogs().at(-1).level).toBe('WARN');
    });
  });

  describe('privacy-safe conversation metadata', () => {
    it('logTurnStart increments turn counter', () => {
      expect(Logger.conversationTurn).toBe(0);
      Logger.logTurnStart('url_change', { url: 'https://x.test' });
      expect(Logger.conversationTurn).toBe(1);
      Logger.logTurnStart('user_message');
      expect(Logger.conversationTurn).toBe(2);
    });

    it('records message length but never exports message contents', () => {
      Logger.logUserMessage('SECRET_SENTINEL Bonjour', 'https://new.limova.ai/home?token=private');
      const entry = Logger.getLogs().at(-1);
      expect(entry.component).toBe('conversation');
      expect(entry.data.messageLength).toBe(23);
      expect(entry.data.textIncluded).toBe(false);
      expect(JSON.stringify(entry)).not.toContain('SECRET_SENTINEL');
      expect(Logger.getLogsAsText()).not.toContain('SECRET_SENTINEL');
    });

    it('records response metadata without storing model output', () => {
      const long = `MODEL_SECRET_${'a'.repeat(500)}`;
      Logger.logGeminiResponse(long, { hasHighlight: true });
      const entry = Logger.getLogs().at(-1);
      expect(entry.data.responseLength).toBe(long.length);
      expect(entry.data.textIncluded).toBe(false);
      expect(entry.data.markers).toEqual({ hasHighlight: true });
      expect(JSON.stringify(entry)).not.toContain('MODEL_SECRET');
    });
  });

  describe('_sanitize (via log data)', () => {
    it('redacts Gemini API keys (AIza...)', () => {
      Logger.log('x', 'msg', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWX1234');
      const entry = Logger.getLogs().at(-1);
      expect(entry.data).toBe('[api-key-redacted]');
    });

    it('strips long base64 data strings', () => {
      const big = 'header:base64,' + 'A'.repeat(2000);
      Logger.log('x', 'msg', big);
      const entry = Logger.getLogs().at(-1);
      expect(entry.data).not.toContain('A'.repeat(100));
      expect(entry.data).toContain('[binary-data-redacted:');
    });

    it('redacts keys containing apikey / api_key', () => {
      Logger.log('x', 'msg', { apiKey: 'secret1234', api_key: 'xyz9876', ok: 'visible' });
      const entry = Logger.getLogs().at(-1);
      expect(entry.data.apiKey).toBe('[redacted]');
      expect(entry.data.api_key).toBe('[redacted]');
      expect(entry.data.ok).toBe('visible');
    });

    it('truncates object.data when it is a long string', () => {
      Logger.log('x', 'msg', { data: 'B'.repeat(2000), other: 42 });
      const entry = Logger.getLogs().at(-1);
      expect(entry.data.data).toContain('[truncated]');
      expect(entry.data.other).toBe(42);
    });

    it('redacts nested credentials, JWTs, emails, phones and URL queries', () => {
      const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
      Logger.log('x', 'msg', {
        nested: {
          authorization: `Bearer ${jwt}`,
          note: `Contact user@example.com au +33 6 12 34 56 78 ${jwt}`,
          url: 'https://new.limova.ai/home?token=secret'
        }
      });
      const serialized = JSON.stringify(Logger.getLogs().at(-1));
      expect(serialized).not.toContain(jwt);
      expect(serialized).not.toContain('user@example.com');
      expect(serialized).not.toContain('12 34 56 78');
      expect(serialized).not.toContain('token=secret');
    });

    it('does not mistake UUID segments for phone numbers', () => {
      const operationId = 'incident-ee901962-9049-4c88-9c20-43554f151a0f';
      Logger.log('diagnostics', operationId);
      expect(Logger.getLogs().at(-1).message).toBe(operationId);
    });
  });

  describe('buffer management', () => {
    it('_trim enforces maxLogs limit', () => {
      const original = Logger.maxLogs;
      Logger.maxLogs = 10;
      for (let i = 0; i < 50; i++) Logger.log('x', `msg ${i}`);
      expect(Logger.getLogs().length).toBeLessThanOrEqual(10);
      Logger.maxLogs = original;
    });

    it('clearLogs resets logs and turn counter', () => {
      Logger.logTurnStart('x');
      Logger.log('a', 'b');
      Logger.clearLogs();
      expect(Logger.conversationTurn).toBe(0);
      const logs = Logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].code).toBe('LOGS_CLEARED');
    });
  });

  describe('getLogsAsText', () => {
    it('produces a readable header and formatted entries', () => {
      Logger.logTurnStart('url_change', { url: 'https://x', historyLength: 2 });
      Logger.logUserMessage('Salut', 'https://x');
      Logger.logGeminiResponse('Bonjour !');
      Logger.logApiRequest({ model: 'gemini-2.5-flash', messageCount: 3 });
      Logger.logApiResponse({ success: true, responseTime: 420 });

      const text = Logger.getLogsAsText();
      expect(text).toContain('Limova AI');
      expect(text).toContain('Paquet de diagnostic sécurisé');
      expect(text).toContain('TURN_STARTED');
      expect(text).toContain('USER_MESSAGE_ACCEPTED');
      expect(text).toContain('GEMINI_RESPONSE_ACCEPTED');
      expect(text).toContain('API_REQUEST_STARTED');
      expect(text).toContain('API_REQUEST_SUCCEEDED');
      expect(text).toContain('gemini-2.5-flash');
    });

    it('formats API errors distinctly', () => {
      Logger.logApiResponse({ success: false, error: 'rate_limit', responseTime: 50 });
      expect(Logger.getLogsAsText()).toContain('API_REQUEST_FAILED');
      expect(Logger.getLogsAsText()).toContain('rate_limit');
    });
  });

  it('restores its bounded buffer from session storage after a service-worker restart', async () => {
    const values = new Map();
    const storageArea = {
      get: async key => values.has(key) ? { [key]: values.get(key) } : {},
      set: async object => { for (const [key, value] of Object.entries(object)) values.set(key, value); }
    };
    await Logger.initialize({ storageArea, metadata: { extensionVersion: '9.9.9' } });
    Logger.event('voice', 'LIVE_WS_CLOSED', { code: 1006 });
    await Logger.flush();

    Logger.logs = [];
    Logger.conversationTurn = 0;
    await Logger.initialize({ storageArea, metadata: { extensionVersion: '9.9.9' } });
    expect(Logger.getLogs().some(entry => entry.code === 'LIVE_WS_CLOSED')).toBe(true);
    expect(Logger.getSummary().bootsObserved).toBeGreaterThanOrEqual(1);
  });
});
