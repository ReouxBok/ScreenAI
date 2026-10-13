import { describe, it, expect, vi } from 'vitest';
import { captureBrowserScreenshot, renderMaskedBrowserScreenshot } from '../../../src/limova/browser-screenshot.js';

const event = () => {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    emit: (...args) => listeners.forEach(listener => listener(...args)), listeners };
};
const setup = () => {
  const chrome = { tabs: { get: vi.fn(async () => ({ id: 7, windowId: 9 })),
    captureVisibleTab: vi.fn(async () => 'data:image/png;base64,YQ=='),
    onActivated: event(), onAttached: event(), onDetached: event(), onUpdated: event(), onRemoved: event(), onZoomChange: event() }, windows: { onFocusChanged: event() } };
  const geometry = { viewportWidth: 100, viewportHeight: 100, revision: 0, masks: [] };
  const binding = { readScreenshotGeometry: vi.fn(async () => structuredClone(geometry)) };
  const upload = vi.fn(async () => ({ fileId: 'owned-image' }));
  const masked = new Blob(['masked'], { type: 'image/png' });
  const render = vi.fn(async () => masked);
  const authorize = vi.fn(async () => {});
  const action = { target: { tabId: 7, origin: 'https://example.com', contextVersion: 1 } };
  return { chrome, binding, upload, render, masked, authorize, action };
};

describe('bound screenshot capture', () => {
  it('uploads only the masked blob after document and authority checks', async () => {
    const fixture = setup();
    expect(await captureBrowserScreenshot(fixture)).toMatchObject({ status: 'completed', imageFileId: 'owned-image' });
    expect(fixture.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(9, { format: 'png' });
    expect(fixture.binding.readScreenshotGeometry).toHaveBeenCalledTimes(2);
    expect(fixture.upload).toHaveBeenCalledWith(fixture.masked, undefined);
    expect(fixture.authorize).toHaveBeenCalledTimes(4);
    expect(fixture.chrome.tabs.onActivated.listeners.size).toBe(0);
  });

  it.each(['tab', 'document', 'focus', 'zoom', 'closed', 'moved'])('does not upload after a %s change during capture', async kind => {
    const fixture = setup();
    fixture.chrome.tabs.captureVisibleTab.mockImplementation(async () => {
      if (kind === 'tab') fixture.chrome.tabs.onActivated.emit({ tabId: 8 });
      if (kind === 'document') fixture.chrome.tabs.onUpdated.emit(7);
      if (kind === 'focus') fixture.chrome.windows.onFocusChanged.emit(10);
      if (kind === 'zoom') fixture.chrome.tabs.onZoomChange.emit({ tabId: 7 });
      if (kind === 'closed') fixture.chrome.tabs.onRemoved.emit(7);
      if (kind === 'moved') fixture.chrome.tabs.onDetached.emit(7);
      return 'raw';
    });
    expect((await captureBrowserScreenshot(fixture)).status).toBe('failed');
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(fixture.render).not.toHaveBeenCalled();
    expect(fixture.chrome.tabs.onActivated.listeners.size).toBe(0);
  });

  it('rejects a DOM revision change even if the geometry and tab return to their previous values', async () => {
    const fixture = setup();
    fixture.binding.readScreenshotGeometry.mockResolvedValueOnce({ revision: 1 }).mockResolvedValueOnce({ revision: 2 });
    expect((await captureBrowserScreenshot(fixture)).status).toBe('failed');
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it('never falls back to the raw image if masking fails', async () => {
    const fixture = setup();
    fixture.render.mockRejectedValue(new Error('Canvas unavailable'));
    expect((await captureBrowserScreenshot(fixture)).status).toBe('failed');
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous upload failure to the durable journal without retry', async () => {
    const fixture = setup();
    fixture.upload.mockRejectedValue(new Error('Response lost'));
    await expect(captureBrowserScreenshot(fixture)).rejects.toThrow('Response lost');
    expect(fixture.upload).toHaveBeenCalledTimes(1);
  });

  it('does not upload after cancellation during rendering', async () => {
    const fixture = setup();
    const controller = new AbortController();
    fixture.render.mockImplementation(async () => { controller.abort(); return fixture.masked; });
    await expect(captureBrowserScreenshot({ ...fixture, signal: controller.signal })).rejects.toThrow();
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it('rejects malformed geometry before attempting image decoding', async () => {
    for (const geometry of [null, { viewportWidth: 100, viewportHeight: 100, masks: [null] },
      { viewportWidth: 100, viewportHeight: 100, masks: [{ left: 99, top: 0, width: 2, height: 1 }] }]) {
      await expect(renderMaskedBrowserScreenshot('data:image/png;base64,YQ==', geometry)).rejects.toThrow('Invalid screenshot');
    }
  });
});
