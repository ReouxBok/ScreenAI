const MAX_SOURCE_CHARACTERS = 40 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export async function renderMaskedBrowserScreenshot(dataUrl, geometry, signal) {
  signal?.throwIfAborted();
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_SOURCE_CHARACTERS
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error('Invalid screenshot image');
  const { viewportWidth, viewportHeight, masks } = geometry ?? {};
  if (!Number.isSafeInteger(viewportWidth) || !Number.isSafeInteger(viewportHeight)
    || viewportWidth <= 0 || viewportHeight <= 0 || viewportWidth > 16384 || viewportHeight > 16384
    || !Array.isArray(masks) || masks.length > 1000) throw new Error('Invalid screenshot geometry');
  for (const mask of masks) {
    if (!mask || ![mask.left, mask.top, mask.width, mask.height].every(Number.isFinite)
      || mask.left < 0 || mask.top < 0 || mask.width <= 0 || mask.height <= 0
      || mask.left + mask.width > viewportWidth || mask.top + mask.height > viewportHeight) throw new Error('Invalid screenshot mask');
  }
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > 32 * 1024 * 1024 || bitmap.width <= 0 || bitmap.height <= 0
      || Math.abs(bitmap.width / viewportWidth - bitmap.height / viewportHeight) > 0.01) throw new Error('Screenshot viewport changed');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Screenshot masking unavailable');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#e5e7eb';
    const scaleX = bitmap.width / viewportWidth, scaleY = bitmap.height / viewportHeight;
    for (const mask of masks) {
      const left = Math.floor(mask.left * scaleX), top = Math.floor(mask.top * scaleY);
      context.fillRect(left, top, Math.ceil((mask.left + mask.width) * scaleX) - left,
        Math.ceil((mask.top + mask.height) * scaleY) - top);
    }
    const output = await canvas.convertToBlob({ type: 'image/png' });
    signal?.throwIfAborted();
    if (!output.size || output.size > MAX_OUTPUT_BYTES) throw new Error('Masked screenshot too large');
    return output;
  } finally { bitmap.close(); }
}

export async function captureBrowserScreenshot({ chrome, binding, action, authorize, upload, signal,
  render = renderMaskedBrowserScreenshot }) {
  if (typeof upload !== 'function') throw new Error('Screenshot upload unavailable');
  signal?.throwIfAborted();
  const tab = await chrome.tabs.get(action.target.tabId);
  if (!Number.isInteger(tab?.windowId) || (tab.splitViewId !== undefined && tab.splitViewId !== -1)) throw new Error('Screenshot window unavailable');
  let changed = false;
  let uploadStarted = false;
  const subscriptions = [
    [chrome.tabs.onActivated, info => { if (info.tabId !== tab.id) changed = true; }],
    [chrome.tabs.onUpdated, id => { if (id === tab.id) changed = true; }],
    [chrome.tabs.onDetached, id => { if (id === tab.id) changed = true; }],
    [chrome.tabs.onAttached, id => { if (id === tab.id) changed = true; }],
    [chrome.tabs.onRemoved, id => { if (id === tab.id) changed = true; }],
    [chrome.tabs.onZoomChange, info => { if (info.tabId === tab.id) changed = true; }],
    [chrome.windows.onFocusChanged, id => { if (id !== tab.windowId) changed = true; }],
  ];
  const check = async () => {
    signal?.throwIfAborted();
    if (changed) throw new Error('Browser changed during screenshot');
    await authorize();
    const current = await chrome.tabs.get(tab.id);
    if (current.windowId !== tab.windowId) throw new Error('Browser window changed during screenshot');
    signal?.throwIfAborted();
    if (changed) throw new Error('Browser changed during screenshot');
  };
  subscriptions.forEach(([event, listener]) => event.addListener(listener));
  try {
    await check();
    const before = await binding.readScreenshotGeometry(action.target, signal);
    await check();
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await check();
    const after = await binding.readScreenshotGeometry(action.target, signal);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Page changed during screenshot');
    const masked = await render(raw, before, signal);
    await check();
    uploadStarted = true;
    const file = await upload(masked, signal);
    return { status: 'completed', observation: 'Masked viewport screenshot captured. Form fields, private regions and embedded content are hidden.', imageFileId: file.fileId };
  } catch (error) {
    if (uploadStarted || signal?.aborted) throw error;
    return { status: 'failed', observation: 'Screenshot was not delivered: browser permission, page stability or masking validation failed. Recheck the selected tab before retrying.' };
  } finally { subscriptions.forEach(([event, listener]) => event.removeListener(listener)); }
}
