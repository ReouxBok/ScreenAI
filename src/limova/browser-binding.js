import { browserDocumentCommand } from './browser-document.js';

// Chrome's document ID selects the document; the private token validates its registry.
export function createBrowserBinding({ scripting, allocateVersion }) {
  const bindings = new Map();
  async function inject(target, request, signal) {
    signal?.throwIfAborted();
    const results = await scripting.executeScript({ target, world: 'ISOLATED',
      func: browserDocumentCommand, args: [request] });
    signal?.throwIfAborted();
    if (results.length !== 1 || results[0].frameId !== 0 || !results[0].documentId
      || !results[0].result?.binding) throw new Error('Browser document unavailable');
    return results[0];
  }
  function remember(tabId, frame) {
    const binding = { ...frame.result.binding, tabId, chromeDocumentId: frame.documentId };
    bindings.set(tabId, binding);
    return { ...binding };
  }
  return {
    async bind(tabId, origin, signal) {
      const contextVersion = await allocateVersion(signal);
      const frame = await inject({ tabId, frameIds: [0] }, { operation: 'bind', origin, contextVersion }, signal);
      if (frame.result.status !== 'completed' || frame.result.binding.origin !== origin) throw new Error('Browser binding rejected');
      return remember(tabId, frame);
    },
    async inspect(tabId, signal) {
      const binding = bindings.get(tabId);
      if (!binding) throw new Error('Browser document not bound');
      const frame = await inject({ tabId, documentIds: [binding.chromeDocumentId] },
        { ...binding, operation: 'inspect' }, signal);
      if (frame.documentId !== binding.chromeDocumentId || frame.result.status !== 'completed'
        || frame.result.binding.documentId !== binding.documentId
        || frame.result.binding.contextVersion !== binding.contextVersion) throw new Error('Browser document changed');
      return { ...binding };
    },
    async readScreenshotGeometry(target, signal) {
      const binding = await this.inspect(target.tabId, signal);
      if (binding.origin !== target.origin || binding.contextVersion !== target.contextVersion) throw new Error('Browser page changed');
      const frame = await inject({ tabId: binding.tabId, documentIds: [binding.chromeDocumentId] },
        { ...binding, operation: 'screenshot_geometry' }, signal);
      if (frame.documentId !== binding.chromeDocumentId || frame.result.binding.documentId !== binding.documentId
        || frame.result.status !== 'completed' || frame.result.binding.contextVersion !== binding.contextVersion
        || !frame.result.geometry) throw new Error('Browser screenshot geometry unavailable');
      return structuredClone(frame.result.geometry);
    },
    async execute(target, operation, input, signal, beforeDispatch) {
      const binding = await this.inspect(target.tabId, signal);
      if (binding.origin !== target.origin || binding.contextVersion !== target.contextVersion) throw new Error('Browser page changed');
      const nextContextVersion = await allocateVersion(signal);
      if (!Number.isSafeInteger(nextContextVersion) || nextContextVersion <= binding.contextVersion) throw new Error('Browser version must advance');
      await beforeDispatch?.(signal);
      const frame = await inject({ tabId: binding.tabId, documentIds: [binding.chromeDocumentId] },
        { ...input, ...binding, operation, nextContextVersion }, signal);
      if (frame.documentId !== binding.chromeDocumentId || frame.result.binding.documentId !== binding.documentId) throw new Error('Browser document changed');
      remember(binding.tabId, frame);
      return { status: frame.result.status, observation: frame.result.observation };
    },
    forget(tabId) { bindings.delete(tabId); },
  };
}
