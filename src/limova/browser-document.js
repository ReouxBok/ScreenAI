export function browserDocumentCommand(request) {
  const key = '__limovaDeepAgentDocumentV1';
  if (!globalThis[key]) {
    let version;
    const documentId = crypto.randomUUID();
    let elements = new Map();
    const binding = () => ({ documentId, origin: location.origin, contextVersion: version });
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.isConnected && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && !element.closest('[hidden], [inert], [aria-hidden="true"]');
    };
    const sensitive = element => /password|passcode|secret|token|api.?key|credit|card|payment|iban|cvv/i.test(
      ['type', 'name', 'autocomplete', 'aria-label'].map(name => element.getAttribute(name) ?? '').join(' '));
    const fingerprint = element => JSON.stringify([
      element.tagName, ...['href', 'type', 'name', 'role', 'aria-label', 'placeholder'].map(name => element.getAttribute(name)),
      element.matches('input,textarea,[contenteditable="true"]') ? null : element.textContent,
    ]);
    const readText = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const parts = [];
      let size = 0, visited = 0, node;
      while (size < 16000 && visited++ < 10000 && (node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable="true"],[data-private],[data-sensitive]') || !visible(parent) || sensitive(parent)) continue;
        const text = node.textContent.trim().replace(/\s+/g, ' ').slice(0, 16000 - size);
        if (text) { parts.push(text); size += text.length + 1; }
      }
      return parts.join(' ');
    };
    const rejected = reason => ({ status: 'rejected', observation: reason, binding: binding() });
    const dispatch = input => {
      if (input?.origin !== location.origin || location.protocol !== 'https:') return rejected('Origin changed');
      if (input.operation === 'bind') {
        if (version === undefined) {
          if (!Number.isSafeInteger(input.contextVersion) || input.contextVersion < 0) return rejected('Invalid context version');
          version = input.contextVersion;
        }
        return { status: 'completed', binding: binding() };
      }
      if (version === undefined || input.documentId !== documentId || input.contextVersion !== version) return rejected('Document changed');
      if (input.operation === 'inspect') return { status: 'completed', binding: binding() };
      if (!Number.isSafeInteger(input.nextContextVersion) || input.nextContextVersion <= version) return rejected('Invalid next context version');
      if (input.operation === 'navigate') {
        let destination;
        try { destination = new URL(input.url); } catch { return rejected('Invalid navigation URL'); }
        if (typeof input.url !== 'string' || input.url.length > 2048 || destination.protocol !== 'https:'
          || destination.username || destination.password) return rejected('Navigation target not permitted');
        version = input.nextContextVersion;
        location.assign(destination.href);
        return { status: 'completed', observation: 'Navigation requested; read the destination page to verify loading.', binding: binding() };
      }
      if (input.operation === 'read_page') {
        elements = new Map();
        const candidates = [...document.querySelectorAll('button,a[href],input,textarea,select,[contenteditable="true"],[role="button"],[role="tab"]')]
          .filter(element => visible(element) && !sensitive(element) && !element.closest('[data-private],[data-sensitive]')).slice(0, 60);
        const descriptions = candidates.map((element, index) => {
          const id = index + 1;
          elements.set(id, { element, fingerprint: fingerprint(element) });
          return { elementId: id, tag: element.tagName.toLowerCase().slice(0, 50), role: element.getAttribute('role')?.slice(0, 80) ?? null,
            label: (element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.innerText ?? '').slice(0, 160) };
        });
        version = input.nextContextVersion;
        const observation = { title: document.title.slice(0, 200),
          url: (location.origin + location.pathname).slice(0, 2048), contextVersion: version, text: readText(), elements: descriptions };
        while (JSON.stringify(observation).length > 32000) {
          if (observation.text) observation.text = observation.text.slice(0, Math.floor(observation.text.length / 2));
          else elements.delete(observation.elements.pop().elementId);
        }
        return { status: 'completed', observation: JSON.stringify(observation), binding: binding() };
      }
      if (input.operation === 'scroll') {
        if (!['up', 'down'].includes(input.direction)) return rejected('Invalid scroll direction');
        const before = scrollY;
        window.scrollBy({ top: (input.direction === 'down' ? 1 : -1) * innerHeight * 0.65, behavior: 'instant' });
        version = input.nextContextVersion;
        return { status: 'completed', observation: JSON.stringify({ moved: scrollY !== before, scrollY, atStart: scrollY <= 0, atEnd: scrollY + innerHeight >= document.documentElement.scrollHeight }), binding: binding() };
      }
      if (!['click', 'type_text', 'highlight'].includes(input.operation)) return rejected('Unsupported document operation');
      const reference = elements.get(input.elementId);
      const element = reference?.element;
      if (!(element instanceof HTMLElement) || !visible(element) || sensitive(element) || reference.fingerprint !== fingerprint(element) || element.matches(':disabled,[aria-disabled="true"],[readonly]')) return rejected('Target unavailable');
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return rejected('Target outside viewport');
      const top = document.elementFromPoint(x, y);
      if (!top || (top !== element && !element.contains(top))) return rejected('Target covered');
      if (input.operation === 'type_text') {
        if (sensitive(element) || !element.matches('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]),textarea,[contenteditable="true"]')
          || typeof input.text !== 'string' || input.text.length > 8000) return rejected('Text target not permitted');
        element.focus();
        if (element.isContentEditable) element.textContent = input.text;
        else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, input.text);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (input.operation === 'click') element.click();
      else element.animate([{ outline: '3px solid #7c3aed' }, { outline: '3px solid transparent' }], { duration: 1000 });
      version = input.nextContextVersion;
      return { status: 'completed', observation: 'Action dispatched; read the page to verify its result.', binding: binding() };
    };
    Object.defineProperty(globalThis, key, { value: dispatch, configurable: false, writable: false });
  }
  return globalThis[key](request);
}
