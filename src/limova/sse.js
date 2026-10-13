// Decode the native Deep Agent SSE wire format without logging model content.
export async function* readDeepAgentEvents(body, signal) {
  if (!body) throw new Error('Flux Deep Agent absent.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];
  let eventSize = 0;
  let id;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const consumeLine = (line) => {
    if (!line) {
      const raw = data.join('\n');
      let result = null;
      try {
        result = data.length ? { event, id, data: raw === '[DONE]' ? null : JSON.parse(raw) } : null;
      } catch {
        throw new Error('Événement Deep Agent invalide.');
      }
      event = 'message';
      data = [];
      eventSize = 0;
      id = undefined;
      return result;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') {
      eventSize += value.length;
      if (eventSize > 4_000_000) throw new Error('Événement Deep Agent trop volumineux.');
      data.push(value);
    }
    if (field === 'id' && !value.includes('\0')) id = value;
    return null;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4_000_000) throw new Error('Événement Deep Agent trop volumineux.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const frame = consumeLine(line);
        if (frame) yield frame;
      }
      if (done) {
        // An unterminated frame is not proof of a completed turn.
        if (buffer || data.length) throw new Error('Le flux Deep Agent a été interrompu.');
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
