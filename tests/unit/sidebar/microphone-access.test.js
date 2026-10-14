import { describe, expect, it, vi } from 'vitest';
import { requestMicrophone, requestMicrophonePermissionInTab } from '../../../src/sidebar/microphone-access.js';

function chromeFixture() {
  const messageListeners = new Set(), removedListeners = new Set();
  return {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: fn => messageListeners.add(fn), removeListener: fn => messageListeners.delete(fn) },
    },
    tabs: {
      create: vi.fn(async () => ({ id: 7 })),
      onRemoved: { addListener: fn => removedListeners.add(fn), removeListener: fn => removedListeners.delete(fn) },
    },
    emitMessage(message, sender = { tab: { id: 7 } }) { for (const listener of messageListeners) listener(message, sender); },
    emitRemoved(tabId) { for (const listener of removedListeners) listener(tabId); },
  };
}

describe('microphone access', () => {
  it('uses getUserMedia directly when permission is already granted', async () => {
    const stream = { getTracks: () => [] };
    const navigator = { permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
      mediaDevices: { getUserMedia: vi.fn(async () => stream) } };
    await expect(requestMicrophone(chromeFixture(), navigator)).resolves.toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
  });

  it('maps a denied browser permission to the stable voice error', async () => {
    const navigator = { permissions: { query: vi.fn(async () => ({ state: 'denied' })) },
      mediaDevices: { getUserMedia: vi.fn() } };
    await expect(requestMicrophone(chromeFixture(), navigator)).rejects.toMatchObject({ voiceErrorKey: 'voiceMicDenied' });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('resolves the first-party permission tab result', async () => {
    const chrome = chromeFixture();
    const pending = requestMicrophonePermissionInTab(chrome);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
    chrome.emitMessage({ type: 'MICROPHONE_PERMISSION_RESULT', granted: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects when the permission tab is closed', async () => {
    const chrome = chromeFixture();
    const pending = requestMicrophonePermissionInTab(chrome);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
    chrome.emitRemoved(7);
    await expect(pending).rejects.toMatchObject({ voiceErrorKey: 'voiceMicDismissed' });
  });
});
