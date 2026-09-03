// console-interceptor.js — Intercepts console logs for Limova AI diagnostics
// Runs in MAIN world to access the page's real console object

(() => {
  if (window.__limova_console_intercepted) return;
  window.__limova_console_intercepted = true;

  // Store up to 100 recent log entries
  const MAX_LOGS = 100;
  window.__limova_console_logs = [];
  window.__limova_network_events = [];

  function sanitizeConsoleMessage(value) {
    return String(value || '')
      .replace(/https?:\/\/[^\s"']+/gi, raw => {
        try {
          const url = new URL(raw);
          return `${url.origin}${url.pathname}`;
        } catch {
          return '[url]';
        }
      })
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt-redacted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
      .replace(/("?(?:api[_-]?key|token|secret|password|passcode|otp)"?\s*[:=]\s*)"?[^\s,;}\]]+/gi, '$1[redacted]')
      .slice(0, 500);
  }

  function isProfileEndpoint(value) {
    try {
      return new URL(String(value || ''), window.location.href).pathname.replace(/\/$/, '') === '/users/me';
    } catch {
      return false;
    }
  }

  function sanitizeProfile(raw) {
    const root = raw?.data?.user || raw?.data || raw?.user || raw;
    if (!root || typeof root !== 'object') return null;
    const clean = (value, max) => typeof value === 'string'
      ? value.replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
      : '';
    const profile = {
      firstName: clean(root.firstName || root.first_name || root.firstname, 80),
      lastName: clean(root.lastName || root.last_name || root.lastname, 100),
      limovaUserId: clean(root.id || root.userId || root.user_id, 200),
      locale: clean(root.locale || root.language, 12),
      timezone: clean(root.timezone || root.timeZone || root.time_zone, 80)
    };
    Object.keys(profile).forEach(key => { if (!profile[key]) delete profile[key]; });
    return Object.keys(profile).length ? profile : null;
  }

  function publishProfile(raw) {
    const profile = sanitizeProfile(raw);
    if (!profile) return;
    window.postMessage({ source: 'limova-charly-page', type: 'LIMOVA_PROFILE', profile }, window.location.origin);
  }

  function generalizedTarget(value) {
    try {
      const url = new URL(String(value || ''), window.location.href);
      if (url.origin !== window.location.origin) return url.origin;
      const path = url.pathname.split('/').map(segment => {
        if (/^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48) return ':id';
        return segment;
      }).join('/');
      return path || '/';
    } catch {
      return '';
    }
  }

  function recordNetwork(method, target, status, startedAt) {
    const safeTarget = generalizedTarget(target);
    if (!safeTarget) return;
    window.__limova_network_events.push({
      method: String(method || 'GET').toUpperCase().slice(0, 10),
      target: safeTarget.slice(0, 300),
      status: Number(status) || 0,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timestamp: Date.now()
    });
    if (window.__limova_network_events.length > 100) {
      window.__limova_network_events = window.__limova_network_events.slice(-100);
    }
  }

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = async function (input, init) {
      const startedAt = performance.now();
      const method = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
      const target = typeof input === 'string' || input instanceof URL ? input : input?.url;
      try {
        const response = await originalFetch(input, init);
        recordNetwork(method, target, response.status, startedAt);
        if (response.ok && isProfileEndpoint(target)) {
          response.clone().json().then(publishProfile).catch(() => {});
        }
        return response;
      } catch (error) {
        recordNetwork(method, target, 0, startedAt);
        throw error;
      }
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__limovaNetworkMeta = { method, url };
    return originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const startedAt = performance.now();
    this.addEventListener('loadend', () => {
      recordNetwork(this.__limovaNetworkMeta?.method, this.__limovaNetworkMeta?.url, this.status, startedAt);
      if (this.status >= 200 && this.status < 300 && isProfileEndpoint(this.__limovaNetworkMeta?.url)) {
        try { publishProfile(JSON.parse(this.responseText)); } catch { /* response may not be JSON */ }
      }
    }, { once: true });
    return originalXhrSend.apply(this, args);
  };

  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const originalConsole = {};

  levels.forEach(level => {
    originalConsole[level] = console[level].bind(console);

    console[level] = function (...args) {
      // Call the original console method
      originalConsole[level](...args);

      // Store the log entry
      try {
        const message = args.map(arg => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(' ');

        window.__limova_console_logs.push({
          level: level,
          message: sanitizeConsoleMessage(message),
          timestamp: Date.now()
        });

        // Keep only the most recent entries
        if (window.__limova_console_logs.length > MAX_LOGS) {
          window.__limova_console_logs = window.__limova_console_logs.slice(-MAX_LOGS);
        }
      } catch {
        // Never break page functionality
      }
    };
  });

  // Also capture unhandled errors
  window.addEventListener('error', (event) => {
    try {
      window.__limova_console_logs.push({
        level: 'error',
        message: sanitizeConsoleMessage(`Uncaught ${event.message} (${event.filename}:${event.lineno}:${event.colno})`),
        timestamp: Date.now()
      });
      if (window.__limova_console_logs.length > MAX_LOGS) {
        window.__limova_console_logs = window.__limova_console_logs.slice(-MAX_LOGS);
      }
    } catch { /* silent */ }
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason ? (event.reason.message || String(event.reason)) : 'Unknown';
      window.__limova_console_logs.push({
        level: 'error',
        message: sanitizeConsoleMessage(`Unhandled Promise Rejection: ${reason}`),
        timestamp: Date.now()
      });
      if (window.__limova_console_logs.length > MAX_LOGS) {
        window.__limova_console_logs = window.__limova_console_logs.slice(-MAX_LOGS);
      }
    } catch { /* silent */ }
  });
})();
