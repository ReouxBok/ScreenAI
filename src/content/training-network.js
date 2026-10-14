// Privacy-safe network outcomes used only by Studio training capture.
(() => {
  if (window.__limova_training_network_installed) return;
  window.__limova_training_network_installed = true;
  window.__limova_network_events = [];

  function generalizedTarget(value) {
    try {
      const url = new URL(String(value || ''), window.location.href);
      if (url.origin !== window.location.origin) return url.origin;
      return url.pathname.split('/').map(segment =>
        /^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48 ? ':id' : segment
      ).join('/') || '/';
    } catch { return ''; }
  }

  function recordNetwork(method, target, status, startedAt) {
    const safeTarget = generalizedTarget(target);
    if (!safeTarget) return;
    window.__limova_network_events.push({
      method: String(method || 'GET').toUpperCase().slice(0, 10),
      target: safeTarget.slice(0, 300),
      status: Number(status) || 0,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timestamp: Date.now(),
    });
    if (window.__limova_network_events.length > 100) window.__limova_network_events = window.__limova_network_events.slice(-100);
  }

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) window.fetch = async function (input, init) {
    const startedAt = performance.now();
    const method = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
    const target = typeof input === 'string' || input instanceof URL ? input : input?.url;
    try {
      const response = await originalFetch(input, init);
      recordNetwork(method, target, response.status, startedAt);
      return response;
    } catch (error) {
      recordNetwork(method, target, 0, startedAt);
      throw error;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__limovaTrainingNetwork = { method, url };
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const startedAt = performance.now();
    this.addEventListener('loadend', () => {
      recordNetwork(this.__limovaTrainingNetwork?.method, this.__limovaTrainingNetwork?.url, this.status, startedAt);
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
