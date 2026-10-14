import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMOVA_APP_URL, LIMOVA_API_URL } from '../../../src/limova/environment.js';

const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value)) }; };
const code = 'private-staff-evaluation-code';
const conversation = '44444444-4444-4444-8444-444444444444';
async function fixture() {
  vi.resetModules();
  delete globalThis.__limovaAppSessionBridgeV1;
  const runtime = { id: 'own-extension', onConnect: event() };
  vi.stubGlobal('location', { origin: LIMOVA_APP_URL });
  vi.stubGlobal('chrome', { runtime });
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await import('../../../src/limova/app-session-bridge.entry.js');
  const port = { name: 'limova-app-session-v1', sender: { id: runtime.id }, onMessage: event(), onDisconnect: event(), postMessage: vi.fn() };
  runtime.onConnect.fire(port);
  return { fetch, port, send(path, method = 'POST', grant = code) {
    port.onMessage.fire({ kind: 'request', request: {
      url: `${LIMOVA_API_URL}${path}`, method, headers: { 'x-limova-evaluation-code': grant },
    } });
  } };
}
afterEach(() => { vi.unstubAllGlobals(); delete globalThis.__limovaAppSessionBridgeV1; });

describe('evaluation grant in the first-party HTTP bridge', () => {
  it.each(['/conversation', `/message/${conversation}`])('allows the grant on the authorized mutation %s', async path => {
    const f = await fixture(); f.send(path);
    await vi.waitFor(() => expect(f.port.postMessage).toHaveBeenCalledWith({ kind: 'end' }));
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0][1].headers.get('x-limova-evaluation-code')).toBe(code);
    expect(JSON.stringify(f.port.postMessage.mock.calls)).not.toContain(code);
  });
  it.each(['/auth/refresh-token', '/auth/logout', '/files', `/message/${conversation}/cancel`])('refuses the grant on unrelated mutation %s', async path => {
    const f = await fixture(); f.send(path);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.port.postMessage).toHaveBeenCalledWith({ kind: 'error' });
  });
  it('refuses grants on reads and malformed grants', async () => {
    const read = await fixture(); read.send('/conversation', 'GET');
    expect(read.fetch).not.toHaveBeenCalled();
    const invalid = await fixture(); invalid.send('/conversation', 'POST', 'short');
    expect(invalid.fetch).not.toHaveBeenCalled();
    expect(invalid.port.postMessage).toHaveBeenCalledWith({ kind: 'error' });
  });
});
