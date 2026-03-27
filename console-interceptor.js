// console-interceptor.js — Intercepts console logs for Limova AI diagnostics
// Runs in MAIN world to access the page's real console object

(() => {
  if (window.__limova_console_intercepted) return;
  window.__limova_console_intercepted = true;

  // Store up to 100 recent log entries
  const MAX_LOGS = 100;
  window.__limova_console_logs = [];

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
          message: message.substring(0, 500), // Limit message length
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
        message: `Uncaught ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
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
        message: `Unhandled Promise Rejection: ${reason}`,
        timestamp: Date.now()
      });
      if (window.__limova_console_logs.length > MAX_LOGS) {
        window.__limova_console_logs = window.__limova_console_logs.slice(-MAX_LOGS);
      }
    } catch { /* silent */ }
  });
})();
