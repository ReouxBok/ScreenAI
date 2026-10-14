import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextFollow } from '../../../src/limova/context-follow.js';

function setup() {
  vi.useFakeTimers();
  const events = {};
  const event = name => ({ addListener: listener => { events[name] = listener; } });
  const chrome = {
    tabs: { query: vi.fn(async () => [{ id: 1, windowId: 4, url: 'https://example.test/page', status: 'complete' }]),
      onActivated: event('activated'), onRemoved: event('removed') },
    windows: { onFocusChanged: event('focus') },
    permissions: { contains: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
  };
  const isBusy = vi.fn(() => false), isAllowed = vi.fn(async () => true);
  const observe = vi.fn(async () => true), cancel = vi.fn(async () => {}), onStop = vi.fn();
  const follow = createContextFollow({ chrome, isBusy, isAllowed, observe, cancel, onStop });
  return { chrome, events, follow, isBusy, isAllowed, observe, cancel };
}
afterEach(() => vi.useRealTimers());

describe('native context following', () => {
  it('does not treat a delayed initial baseline as a page change', async () => {
    const h = setup(); h.isBusy.mockReturnValue(true); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
    h.isBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(h.observe).not.toHaveBeenCalled(); h.follow.stop();
  });
  it('establishes a baseline and coalesces changes while another turn is busy', async () => {
    const h = setup(); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.observe).not.toHaveBeenCalled();
    h.isBusy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    h.isBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.observe).toHaveBeenCalledTimes(1);
    h.follow.stop();
  });
  it('does not start a turn from a late probe after the user stops following', async () => {
    const h = setup(); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(0);
    let resolve;
    h.chrome.scripting.executeScript.mockImplementation(() => new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(1500);
    h.follow.stop(); resolve([{ result: true }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.observe).not.toHaveBeenCalled();
  });
  it('cancels a running automatic turn once on focus loss and never restarts it', async () => {
    const h = setup(); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(0);
    let resolve;
    h.observe.mockImplementation(() => new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(1500);
    h.events.focus(8); h.follow.stop(); resolve(true);
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.observe).toHaveBeenCalledTimes(1);
  });
  it('keeps following when Chrome repeats focus for the target window', async () => {
    const h = setup(); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(0);
    h.events.focus(4);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.cancel).not.toHaveBeenCalled(); h.follow.stop();
  });
  it('stops before injecting when site access is revoked', async () => {
    const h = setup(); h.follow.start(1);
    await vi.advanceTimersByTimeAsync(0);
    h.chrome.permissions.contains.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(h.observe).not.toHaveBeenCalled();
  });
});
