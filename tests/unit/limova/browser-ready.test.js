import { describe, it, expect, vi } from 'vitest';
import { waitForBrowserReady } from '../../../src/limova/browser-ready.js';

function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    emit: id => listeners.forEach(listener => listener(id)), size: () => listeners.size };
}
function fixture() {
  return { get: vi.fn().mockResolvedValue({ id: 1, status: 'loading' }), onUpdated: event(), onRemoved: event() };
}

describe('browser readiness', () => {
  it('waits for completion and removes listeners', async () => {
    const tabs = fixture();
    const result = waitForBrowserReady(tabs, 1);
    await Promise.resolve();
    tabs.get.mockResolvedValue({ id: 1, status: 'complete' });
    tabs.onUpdated.emit(1);
    expect(await result).toEqual({ id: 1, status: 'complete' });
    expect(tabs.onUpdated.size() + tabs.onRemoved.size()).toBe(0);
  });
  it('does not accept a complete status while a navigation is pending', async () => {
    const tabs = fixture();
    tabs.get.mockResolvedValue({ id: 1, status: 'complete', pendingUrl: 'https://example.com' });
    const controller = new AbortController();
    const result = waitForBrowserReady(tabs, 1, controller.signal);
    await Promise.resolve();
    expect(tabs.onUpdated.size()).toBe(1);
    controller.abort(new Error('Cancelled'));
    await expect(result).rejects.toThrow('Cancelled');
    expect(tabs.onUpdated.size()).toBe(0);
  });
  it('stops on tab closure', async () => {
    const tabs = fixture();
    const result = waitForBrowserReady(tabs, 1);
    tabs.onRemoved.emit(1);
    await expect(result).rejects.toThrow('closed');
  });
  it('times out without retrying navigation', async () => {
    const tabs = fixture();
    await expect(waitForBrowserReady(tabs, 1, undefined, 5)).rejects.toThrow('timed out');
    expect(tabs.get).toHaveBeenCalledTimes(1);
    expect(tabs.onUpdated.size()).toBe(0);
  });
});
