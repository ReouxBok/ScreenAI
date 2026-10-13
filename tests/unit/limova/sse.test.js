import { describe, expect, it } from 'vitest';
import { readDeepAgentEvents } from '../../../src/limova/sse.js';

function body(chunks) {
  return new ReadableStream({ start(controller) {
    chunks.forEach(chunk => controller.enqueue(chunk));
    controller.close();
  } });
}
async function collect(stream, signal) {
  const result = [];
  for await (const event of readDeepAgentEvents(stream, signal)) result.push(event);
  return result;
}

describe('Deep Agent SSE', () => {
  it('decodes fragmented UTF-8, CRLF, comments and multiline JSON', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\nevent: values\r\nid: 1\r\ndata: {"text":\r\ndata: "écran"}\r\n\r\nevent: custom\ndata: {"files":[]}\n\n');
    const chunks = Array.from(bytes, byte => new Uint8Array([byte]));
    expect(await collect(body(chunks))).toEqual([
      { event: 'values', id: '1', data: { text: 'écran' } },
      { event: 'custom', id: undefined, data: { files: [] } },
    ]);
  });

  it('does not silently accept a truncated event', async () => {
    await expect(collect(body([new TextEncoder().encode('event: values\ndata: {"messages":[]')]))).rejects.toThrow('interrompu');
  });

  it('cancels a pending reader when the user interrupts', async () => {
    const controller = new AbortController();
    const pending = collect(new ReadableStream(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
