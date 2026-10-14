import { describe, it, expect, vi } from 'vitest';
import { createTabGuidance } from '../../../src/limova/tab-guidance.js';

function harness() {
  const listeners = {};
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const chrome = {
    tabs: { get: vi.fn(async id => ({ id, windowId: 4 })), query: vi.fn(async () => [{ id: 1 }]), update: vi.fn(async () => {}),
      onActivated: event('activated'), onRemoved: event('removed') },
    windows: { update: vi.fn(async () => {}), onFocusChanged: event('focused') },
  };
  const onChange = vi.fn();
  return { chrome, listeners, onChange, guide: createTabGuidance({ chrome, onChange }) };
}

describe('native tab return guidance', () => {
  it('warns after a switch and returns to the existing tab and window only on request', async () => {
    const { chrome, guide, onChange, listeners } = harness();
    guide.bind(1);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('current'));
    chrome.tabs.query.mockResolvedValue([{ id: 2 }]); listeners.activated();
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('away'));
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    await guide.returnToTarget();
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(4, { focused: true });
    expect(onChange).toHaveBeenLastCalledWith('current');
  });
  it('clears on target closure and never recreates a closed tab', async () => {
    const { chrome, guide, onChange, listeners } = harness();
    guide.bind(1); listeners.removed(1);
    await guide.returnToTarget();
    expect(onChange).toHaveBeenLastCalledWith('idle');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  it('does not restore a stale warning after a conversation reset', async () => {
    const { chrome, guide, onChange } = harness();
    let resolve;
    chrome.tabs.query.mockImplementation(() => new Promise(done => { resolve = done; }));
    guide.bind(1);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    guide.clear(); resolve([{ id: 2 }]);
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith('idle');
  });
  it('does not focus the previous target if reset happens while checking it', async () => {
    const { chrome, guide } = harness();
    guide.bind(1);
    await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
    let resolve;
    chrome.tabs.get.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = guide.returnToTarget();
    guide.clear(); resolve({ id: 1, windowId: 4 });
    await pending;
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});
