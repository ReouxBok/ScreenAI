// page-actions.js — Functions injected in a tab to act on it (TEAM-724).
//
// Like page-snapshot.js, each function is passed to chrome.scripting.executeScript and
// runs in the extension's ISOLATED world; each is SELF-CONTAINED. They act only on an
// element of the map that `pageSnapshot` stored in that world, named by its id and
// snapshot id. No selector, script or coordinate ever comes from the server: clicks
// target the mapped element itself, at its own centre.
//
// Before acting, `performPageAction` re-checks that the map is the asked snapshot, that
// the page did not navigate, that the element is still there, visible and enabled, and
// that its name is still the one the service worker approved. It then starts a
// MutationObserver so `collectPageVerification` can say whether the page changed.

export function performPageAction(options) {
  const kit = globalThis.__limovaBrowserKit;
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (!kit || !map || map.snapshotId !== options?.snapshotId || map.path !== kit.pagePath()) {
    return { ok: false, code: 'stale_snapshot' };
  }
  const el = map.elements.get(String(options?.elementId || ''));
  if (!el || !el.isConnected || !kit.isRendered(el) || kit.isDisabled(el)) return { ok: false, code: 'element_not_found' };
  if (kit.normalize(kit.nameOf(el)) !== kit.normalize(options?.expectName)) return { ok: false, code: 'stale_snapshot' };
  const action = options?.action;

  function startWatch() {
    const previous = globalThis.__limovaBrowserWatch;
    // A batch keeps one watcher across its steps, so the final verification sees
    // every change, not only the last step's.
    if (options?.keepWatch && previous?.observer) return;
    try { previous?.observer?.disconnect(); } catch (_) { /* ignore */ }
    const before = new Set();
    document.querySelectorAll('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])').forEach(node => {
      const text = kit.clean(node.textContent);
      if (text) before.add(text);
    });
    const watch = { mutations: 0, structural: 0, lastAt: 0, startedAt: Date.now(), before, observer: null };
    watch.observer = new MutationObserver(records => {
      watch.mutations += records.length;
      for (const record of records) {
        if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length)) watch.structural += 1;
      }
      watch.lastAt = Date.now();
    });
    watch.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    globalThis.__limovaBrowserWatch = watch;
  }

  function fire(target, type, init = {}) {
    const rect = target.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...init
    };
    if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } else if (!type.startsWith('pointer')) {
      target.dispatchEvent(new MouseEvent(type, base));
    }
  }

  function clickElement(target) {
    target.scrollIntoView?.({ block: 'center', inline: 'center' });
    fire(target, 'pointerdown');
    fire(target, 'mousedown');
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    fire(target, 'pointerup');
    fire(target, 'mouseup');
    target.click();
  }

  function dispatchValueEvents(target, data) {
    const InputEventCtor = typeof InputEvent === 'function' ? InputEvent : Event;
    target.dispatchEvent(new InputEventCtor('input', { bubbles: true, composed: true, inputType: 'insertText', data }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  try {
    if (action === 'click' || action === 'download') {
      startWatch();
      clickElement(el);
      return { ok: true, field_state: kit.isEditable(el) ? kit.fieldState(el) : null };
    }

    if (action === 'fill') {
      if (kit.isSensitive(el)) return { ok: false, code: 'sensitive_field' };
      if (!kit.isEditable(el)) return { ok: false, code: 'invalid_args', message: 'Cet élément n’est pas un champ de saisie.' };
      const value = String(options?.value ?? '');
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.readOnly) return { ok: false, code: 'element_not_found', message: 'Ce champ est en lecture seule.' };
        if (el.maxLength > 0 && value.length > el.maxLength) {
          return { ok: false, code: 'invalid_args', message: `Ce champ accepte au plus ${el.maxLength} caractères.` };
        }
        startWatch();
        el.scrollIntoView?.({ block: 'center' });
        el.focus({ preventScroll: true });
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        dispatchValueEvents(el, value);
      } else {
        startWatch();
        el.scrollIntoView?.({ block: 'center' });
        el.focus({ preventScroll: true });
        const selection = document.getSelection?.();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
        if (!inserted) {
          el.textContent = value;
          dispatchValueEvents(el, value);
        }
      }
      return { ok: true, field_state: kit.fieldState(el) };
    }

    if (action === 'select') {
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, code: 'invalid_args', message: 'Cet élément n’est pas une liste de choix ; utilise un clic.' };
      }
      const wanted = kit.normalize(options?.option);
      const all = [...el.options];
      const option = all.find(opt => kit.normalize(opt.label || opt.text) === wanted)
        || all.find(opt => wanted && kit.normalize(opt.label || opt.text).includes(wanted))
        || all.find(opt => opt.value === options?.option);
      if (!option) return { ok: false, code: 'invalid_args', message: 'Option introuvable dans cette liste.' };
      if (option.disabled) return { ok: false, code: 'invalid_args', message: 'Cette option est désactivée.' };
      startWatch();
      el.focus({ preventScroll: true });
      option.selected = true;
      dispatchValueEvents(el, null);
      return { ok: true, field_state: kit.fieldState(el), selected: kit.clean(option.label || option.text, 80) };
    }

    if (action === 'check') {
      const want = options?.checked === true;
      const native = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(kit.inputType(el));
      const role = el.getAttribute('role') || '';
      if (!native && !['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
        return { ok: false, code: 'invalid_args', message: 'Cet élément n’est pas une case à cocher.' };
      }
      const read = () => (native ? el.checked : el.getAttribute('aria-checked') === 'true');
      if (!want && (native ? kit.inputType(el) === 'radio' : role === 'radio' || role === 'menuitemradio') && read()) {
        return { ok: false, code: 'invalid_args', message: 'Un bouton radio se décoche en choisissant une autre option.' };
      }
      startWatch();
      if (read() !== want) clickElement(el);
      if (read() !== want) return { ok: false, code: 'internal', message: 'La case n’a pas changé d’état.' };
      return { ok: true, field_state: kit.fieldState(el) ?? (want ? 'filled' : 'empty') };
    }

    if (action === 'submit') {
      const form = kit.formOf(el);
      if (!form) return { ok: false, code: 'invalid_args', message: 'Cet élément n’appartient à aucun formulaire.' };
      startWatch();
      const submitter = kit.submitsForm(el) ? el : undefined;
      if (typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit(submitter);
        } catch (_) {
          form.requestSubmit();
        }
      } else if (submitter) {
        submitter.click();
      } else {
        form.submit();
      }
      return { ok: true, field_state: null };
    }
  } catch (error) {
    return { ok: false, code: 'internal', message: String(error?.message || 'action failed').slice(0, 200) };
  }
  return { ok: false, code: 'invalid_args' };
}

// What the page shows after an action. Works on a new document too (after a
// navigation the map and the watcher are gone; messages are still read).
export function collectPageVerification(options) {
  function clean(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return max && value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }
  function shown(el) {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  const watch = globalThis.__limovaBrowserWatch || null;
  const fresh = [];
  const old = [];
  for (const node of document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="status"], [aria-live]:not([aria-live="off"]), output')) {
    if (fresh.length + old.length >= 20) break;
    if (!shown(node)) continue;
    const text = clean(typeof node.innerText === 'string' ? node.innerText : node.textContent, 200);
    if (!text) continue;
    if (fresh.includes(text) || old.includes(text)) continue;
    (watch?.before?.has(clean(node.textContent)) ? old : fresh).push(text);
  }
  const messages = [...fresh, ...old].slice(0, 5);
  let fieldState = null;
  const kit = globalThis.__limovaBrowserKit;
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (kit && map && options?.elementId) {
    const el = map.elements.get(String(options.elementId));
    if (el && el.isConnected) fieldState = kit.fieldState(el);
  }
  const result = {
    ok: true,
    same_document: Boolean(watch),
    mutations: watch ? watch.mutations : 0,
    structural: watch ? watch.structural : 0,
    quiet_ms: watch ? Date.now() - (watch.lastAt || watch.startedAt) : null,
    messages,
    field_state: fieldState,
    title: clean(document.title, 300),
    path: `${location.origin}${location.pathname}`
  };
  if (options?.finish && watch) {
    try { watch.observer?.disconnect(); } catch (_) { /* ignore */ }
    globalThis.__limovaBrowserWatch = null;
  }
  return result;
}

// Scroll the window, or one mapped element (a scrollable list, or into view).
export function scrollPage(options) {
  const direction = options?.direction;
  if (!['down', 'up', 'top', 'bottom'].includes(direction)) return { ok: false, code: 'invalid_args' };
  let target = null;
  if (options?.elementId || options?.snapshotId) {
    const kit = globalThis.__limovaBrowserKit;
    const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
    if (!kit || !map || map.snapshotId !== options?.snapshotId || map.path !== kit.pagePath()) {
      return { ok: false, code: 'stale_snapshot' };
    }
    target = map.elements.get(String(options?.elementId || ''));
    if (!target || !target.isConnected || !kit.isRendered(target)) return { ok: false, code: 'element_not_found' };
  }

  const previous = globalThis.__limovaBrowserWatch;
  try { previous?.observer?.disconnect(); } catch (_) { /* ignore */ }
  const watch = { mutations: 0, structural: 0, lastAt: 0, startedAt: Date.now(), before: new Set(), observer: null };
  watch.observer = new MutationObserver(records => {
    watch.mutations += records.length;
    for (const record of records) {
      if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length)) watch.structural += 1;
    }
    watch.lastAt = Date.now();
  });
  watch.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  globalThis.__limovaBrowserWatch = watch;

  function scrollBox(box, isWindow) {
    const height = isWindow ? innerHeight : box.clientHeight;
    const max = isWindow
      ? (document.scrollingElement || document.documentElement).scrollHeight - innerHeight
      : box.scrollHeight - box.clientHeight;
    const before = isWindow ? scrollY : box.scrollTop;
    let next = before;
    if (direction === 'down') next = before + height * 0.85;
    if (direction === 'up') next = before - height * 0.85;
    if (direction === 'top') next = 0;
    if (direction === 'bottom') next = max;
    next = Math.max(0, Math.min(Math.max(0, max), next));
    if (isWindow) scrollTo({ top: next, behavior: 'instant' }); else box.scrollTop = next;
    const after = isWindow ? scrollY : box.scrollTop;
    return { moved: Math.abs(after - before) >= 1, at_top: after <= 1, at_bottom: after >= max - 1 };
  }

  if (target) {
    const style = getComputedStyle(target);
    const scrollable = target.scrollHeight > target.clientHeight + 1 && /(auto|scroll|overlay)/.test(style.overflowY || '');
    if (scrollable) return { ok: true, ...scrollBox(target, false) };
    target.scrollIntoView({ block: 'center' });
    return { ok: true, moved: true, at_top: scrollY <= 1, at_bottom: false };
  }
  return { ok: true, ...scrollBox(null, true) };
}
