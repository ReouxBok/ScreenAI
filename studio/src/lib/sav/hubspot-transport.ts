import "server-only";

export const SAV_CRM_TRANSPORT_REVISION = "sav-crm-read-2026-10-16.v1";
/** POST is retryable only for these documented read operations. */
export function isSavHubspotRead(path: string, method = "GET") {
  if (method.toUpperCase() === "GET") return true;
  return method.toUpperCase() === "POST" && /^\/crm\/v3\/objects\/(contacts|tickets|emails)\/(search|batch\/read)$/.test(path);
}

export function createSavHubspotTransport(network: typeof fetch = fetch) {
  let active = 0, nextSearchAt = 0;
  const queue: Array<{ resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  async function acquire() {
    if (active < 3) { active++; return; }
    if (queue.length >= 64) throw new Error("SAV_HUBSPOT_READ_QUEUE_FULL");
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject: () => reject(new Error("SAV_HUBSPOT_READ_QUEUE_TIMEOUT")), timer: undefined as unknown as ReturnType<typeof setTimeout> };
      entry.timer = setTimeout(() => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); entry.reject(); }, 20_000);
      queue.push(entry);
    });
  }
  function release() { const entry = queue.shift(); if (entry) { clearTimeout(entry.timer); entry.resolve(); } else active--; }
  return async function request<T>(path: string, init: RequestInit, summarize: (status: number, payload: unknown) => string): Promise<T> {
    const read = isSavHubspotRead(path, init.method), started = Date.now(), deadline = started + 20_000;
    if (read) await acquire();
    let attempts = 0, status = 0;
    try {
      for (;;) {
        if (init.signal?.aborted) throw new Error("SAV_HUBSPOT_READ_CANCELLED");
        if (path.endsWith("/search") && read) {
          const scheduled = Math.max(Date.now(), nextSearchAt); nextSearchAt = scheduled + 250;
          if (scheduled >= deadline) throw new Error("SAV_HUBSPOT_READ_QUEUE_TIMEOUT");
          if (scheduled > Date.now()) await new Promise(r => setTimeout(r, scheduled - Date.now()));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("SAV_HUBSPOT_READ_TIMEOUT");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(remaining, read ? 12_000 : 20_000));
        const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
        attempts++;
        let retryAfter = 0;
        try {
          const response = await network(`https://api.hubapi.com${path}`, { ...init, signal });
          status = response.status;
          if (!response.ok) {
            const header = response.headers?.get("retry-after");
            if (header) retryAfter = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
            if (!Number.isFinite(retryAfter)) retryAfter = 0;
            const payload = await response.json().catch(() => null);
            throw new Error(summarize(status, payload));
          }
          if (response.status === 204) return undefined as T;
          try { return await response.json() as T; }
          catch { throw new Error("SAV_HUBSPOT_INVALID_RESPONSE"); }
        } catch (error) {
          const code = controller.signal.aborted ? "SAV_HUBSPOT_READ_TIMEOUT" : error instanceof Error && /^(HUBSPOT_HTTP_\d{3}|SAV_HUBSPOT_INVALID_RESPONSE)/.test(error.message) ? error.message : "SAV_HUBSPOT_READ_UNAVAILABLE";
          const transient = /^(HUBSPOT_HTTP_(429|502|503|504)|SAV_HUBSPOT_READ_(TIMEOUT|UNAVAILABLE))/.test(code);
          const delay = Math.max(200, retryAfter) + Math.floor(Math.random() * 100);
          if (!read || !transient || attempts >= 2 || init.signal?.aborted || deadline - Date.now() <= delay + 100) throw new Error(code);
          clearTimeout(timer);
          await new Promise(r => setTimeout(r, delay));
        } finally { clearTimeout(timer); }
      }
    } finally {
      if (read) release();
      console.info("sav_hubspot_transport", { revision: SAV_CRM_TRANSPORT_REVISION, operation: read ? path.endsWith("/search") ? "search" : path.endsWith("/batch/read") ? "batch_read" : "get" : "mutation", attempts, status, durationMs: Date.now() - started });
    }
  };
}

// Resolve fetch at call time so the same boundary can be exercised with fixtures.
export const requestSavHubspot = createSavHubspotTransport((...args) => fetch(...args));
