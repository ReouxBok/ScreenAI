import { describe, it, expect, vi } from 'vitest';
import { createLimovaAppLease } from '../../../src/limova/app-target.js';
import { LIMOVA_APP_URL } from '../../../src/limova/client.js';

function fixture() {
  const event = () => {
    const listeners = new Set();
    return { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
      fire: (...args) => listeners.forEach(callback => callback(...args)), listeners };
  };
  const tab = { id: 7, url: LIMOVA_APP_URL, active: false, status: 'complete' };
  const chrome = {
    tabs: { create: vi.fn(async () => ({ id: 7 })), get: vi.fn(async () => ({ ...tab })), remove: vi.fn(async () => {}),
      onActivated: event(), onUpdated: event(), onRemoved: event() },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: 'owned-document', url: LIMOVA_APP_URL })) },
    scripting: { executeScript: vi.fn(async () => []) },
  };
  return { tab, chrome, prepare: signal => createLimovaAppLease(chrome, 'voice-bridge.js', signal) };
}

describe('voice app tab lease', () => {
  it('creates an inactive owned document and removes only that document once', async () => {
    const { chrome, prepare } = fixture();
    const lease = await prepare();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: LIMOVA_APP_URL, active: false });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7, documentIds: ['owned-document'] }, world: 'ISOLATED', files: ['voice-bridge.js'] });
    await lease.release(); await lease.release();
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.tabs.onActivated.listeners.size).toBe(0);
  });
  it('keeps a tab claimed by the user even after they switch away', async () => {
    const { chrome, prepare } = fixture();
    const lease = await prepare();
    chrome.tabs.onActivated.fire({ tabId: 7 }); chrome.tabs.onActivated.fire({ tabId: 8 });
    await lease.release();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('keeps a tab whose document changed', async () => {
    const { chrome, prepare } = fixture();
    const lease = await prepare();
    chrome.webNavigation.getFrame.mockResolvedValue({ documentId: 'new-document', url: LIMOVA_APP_URL });
    await lease.release();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('does not close a tab activated during the final document check', async () => {
    const { chrome, prepare } = fixture();
    const lease = await prepare();
    chrome.webNavigation.getFrame.mockImplementation(async () => {
      chrome.tabs.onActivated.fire({ tabId: 7 });
      return { documentId: 'owned-document', url: LIMOVA_APP_URL };
    });
    await lease.release();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it('cancels loading promptly and cleans its inactive pending tab and listeners', async () => {
    const { tab, chrome, prepare } = fixture();
    Object.assign(tab, { status: 'loading', url: '', pendingUrl: LIMOVA_APP_URL });
    const abort = new AbortController();
    const pending = prepare(abort.signal);
    const rejection = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.listeners.size).toBe(1));
    abort.abort(new Error('cancelled'));
    await rejection;
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
    expect(chrome.tabs.onRemoved.listeners.size).toBe(0);
    expect(chrome.tabs.onActivated.listeners.size).toBe(0);
  });
  it('releases the owned tab when bridge injection fails', async () => {
    const { chrome, prepare } = fixture();
    chrome.scripting.executeScript.mockRejectedValue(new Error('injection failed'));
    await expect(prepare()).rejects.toThrow('injection failed');
    expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });
});
