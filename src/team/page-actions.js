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
//
// TEAM-751 adds two actions:
// - `key` (`browser.press_key`). A key event a script creates (`isTrusted: false`) has
//   no default action: a synthetic Tab moves no focus, a synthetic Backspace deletes
//   nothing. So the page gets keydown, keypress (Enter, Space) and keyup, as a person's
//   key would, and when it did not cancel them the action performs what the browser
//   would have done (move the focus, submit, click, edit the text, pick the next option,
//   scroll, close a dialog). Without an element the key goes to the focused element.
// - `upload` (`browser.upload`). The files come as base64 and become `File`s in a
//   `DataTransfer`, assigned to the file input (`input` and `change` follow), or dropped
//   on a drop area (`dragenter`, `dragover`, `drop`). Nothing of them is kept here.

export function performPageAction(options) {
  const kit = globalThis.__limovaBrowserKit;
  const action = options?.action;
  // A key without an element goes to whatever has the focus in this frame.
  const focusedOnly = action === 'key' && !options?.elementId;
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (!kit) return { ok: false, code: 'stale_snapshot' };
  if (!focusedOnly && (!map || map.snapshotId !== options?.snapshotId || map.path !== kit.pagePath())) {
    return { ok: false, code: 'stale_snapshot' };
  }
  function deepActive() {
    let node = document.activeElement;
    while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
    return node;
  }
  let el;
  if (focusedOnly) {
    el = deepActive() || document.body || document.documentElement;
  } else {
    el = map.elements.get(String(options?.elementId || ''));
    // A hidden file input is reachable through its label or button (TEAM-751).
    const shown = el && (action === 'upload' && kit.isFileInput(el) ? kit.fileReachable(el) : kit.isRendered(el));
    if (!el || !el.isConnected || !shown || kit.isDisabled(el)) return { ok: false, code: 'element_not_found' };
    if (kit.normalize(kit.nameOf(el)) !== kit.normalize(options?.expectName)) return { ok: false, code: 'stale_snapshot' };
  }

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

  // ------------------------------------------------------------------ keys (TEAM-751)

  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    // The DOM calls the space bar ' ' (KeyboardEvent.key) and 'Space' (code).
    Space: { key: ' ', code: 'Space', keyCode: 32 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
  };
  const NO_SELECTION_TYPES = ['email', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range'];

  function textControl(node) {
    return node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && kit.isEditable(node));
  }

  function editableRootOf(node) {
    if (!node?.isContentEditable) return null;
    let root = node;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  function hasSelection(node) {
    if (node instanceof HTMLInputElement && NO_SELECTION_TYPES.includes(kit.inputType(node))) return false;
    try { return typeof node.selectionStart === 'number'; } catch (_) { return false; }
  }

  function setNativeValue(node, value) {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(node, value); else node.value = value;
  }

  function inputEvent(node, type, inputType, data) {
    const Ctor = typeof InputEvent === 'function' ? InputEvent : Event;
    return node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, inputType, data }));
  }

  // Replace [start, end) of a text field with `text`, the way typing does: beforeinput
  // (the page may refuse), the change, then input.
  function editText(node, text, start, end, inputType) {
    if (node.readOnly) return false;
    if (!inputEvent(node, 'beforeinput', inputType, text || null)) return false;
    if (hasSelection(node)) {
      if (text && node.maxLength > 0 && node.value.length - (end - start) + text.length > node.maxLength) return false;
      node.setRangeText(text, start, end, 'end');
    } else {
      // email, number…: no caret to read, so edit at the end.
      const value = String(node.value || '');
      const next = text ? value + text : value.slice(0, Math.max(0, value.length - (end - start)));
      if (text && node.maxLength > 0 && next.length > node.maxLength) return false;
      setNativeValue(node, next);
    }
    inputEvent(node, 'input', inputType, text || null);
    return true;
  }

  function caretRange(node) {
    if (!hasSelection(node)) {
      const length = String(node.value || '').length;
      return { start: length, end: length };
    }
    return { start: node.selectionStart, end: node.selectionEnd };
  }

  function moveCaret(node, to, extend) {
    if (!hasSelection(node)) return;
    const length = node.value.length;
    const position = Math.max(0, Math.min(length, to));
    if (!extend) {
      node.setSelectionRange(position, position);
      return;
    }
    const anchor = node.selectionDirection === 'backward' ? node.selectionEnd : node.selectionStart;
    if (position < anchor) node.setSelectionRange(position, anchor, 'backward');
    else node.setSelectionRange(anchor, position, 'forward');
  }

  function focusPoint(node) {
    if (!hasSelection(node)) return 0;
    return node.selectionDirection === 'backward' ? node.selectionStart : node.selectionEnd;
  }

  function modifySelection(extend, direction, granularity) {
    const selection = document.getSelection?.();
    if (selection && typeof selection.modify === 'function') selection.modify(extend ? 'extend' : 'move', direction, granularity);
  }

  function scrollerOf(node) {
    for (let current = node instanceof Element ? node : null; current && current !== document.body && current !== document.documentElement; current = current.parentElement) {
      const style = getComputedStyle(current);
      const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY || '') && current.scrollHeight > current.clientHeight + 1;
      const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX || '') && current.scrollWidth > current.clientWidth + 1;
      if (scrollsY || scrollsX) return current;
    }
    return null;
  }

  function scrollBy(node, dx, dy) {
    const box = scrollerOf(node);
    if (box) box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    else window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  }

  function scrollEdge(node, toEnd) {
    const box = scrollerOf(node);
    if (box) box.scrollTo({ top: toEnd ? box.scrollHeight : 0, behavior: 'instant' });
    else window.scrollTo({ top: toEnd ? (document.scrollingElement || document.documentElement).scrollHeight : 0, behavior: 'instant' });
  }

  function viewportOf(node) {
    const box = scrollerOf(node);
    return box ? box.clientHeight : innerHeight;
  }

  function radioGroup(node) {
    if (!(node instanceof HTMLInputElement) || kit.inputType(node) !== 'radio' || !node.name) return null;
    const scope = node.form || node.getRootNode?.() || document;
    return [...scope.querySelectorAll('input[type="radio"]')]
      .filter(radio => radio.name === node.name && (radio.form || null) === (node.form || null) && !kit.isDisabled(radio) && kit.isRendered(radio));
  }

  function stepRadio(node, forward) {
    const group = radioGroup(node);
    if (!group || group.length < 2) return false;
    const index = group.indexOf(node);
    const next = group[(index + (forward ? 1 : group.length - 1)) % group.length];
    next.focus({ preventScroll: true });
    // A click checks it and fires input and change, as the arrow key would.
    next.click();
    return true;
  }

  function stepSelect(node, how) {
    if (!(node instanceof HTMLSelectElement) || node.multiple) return false;
    const options = [...node.options];
    const enabled = options.map((option, index) => ({ option, index })).filter(item => !item.option.disabled);
    if (!enabled.length) return false;
    let target;
    if (how === 'first') target = enabled[0];
    else if (how === 'last') target = enabled.at(-1);
    else if (how === 'next') target = enabled.find(item => item.index > node.selectedIndex);
    else target = [...enabled].reverse().find(item => item.index < node.selectedIndex);
    if (!target || target.index === node.selectedIndex) return false;
    node.selectedIndex = target.index;
    node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Tab order: shown, enabled, tabindex >= 0; positive tabindex first (ascending), then
  // document order; one radio per group; inside an open modal dialog when there is one.
  // Frames are skipped: Limova acts in each frame by its own ids.
  function tabbables(current) {
    let scope = document;
    try {
      const modal = [...document.querySelectorAll('dialog[open]')].filter(node => node.matches(':modal')).at(-1);
      if (modal) scope = modal;
    } catch (_) { /* no :modal support */ }
    const nodes = scope.querySelectorAll('a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])');
    const list = [];
    const radios = new Map();
    for (const node of nodes) {
      if (node instanceof HTMLInputElement && kit.inputType(node) === 'hidden') continue;
      if (node.isContentEditable && node.parentElement?.isContentEditable) continue;
      if (node.tabIndex < 0 || node.disabled || node.closest?.('[inert]')) continue;
      if (!kit.isRendered(node)) continue;
      if (node instanceof HTMLInputElement && kit.inputType(node) === 'radio' && node.name) {
        const key = `${node.form ? 'form' : 'doc'}:${node.name}`;
        const chosen = radios.get(key);
        if (!chosen) {
          radios.set(key, node);
          list.push(node);
        } else if ((node.checked || node === current) && !chosen.checked && chosen !== current) {
          list[list.indexOf(chosen)] = node;
          radios.set(key, node);
        }
        continue;
      }
      list.push(node);
    }
    const positive = list.filter(node => node.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...list.filter(node => node.tabIndex === 0)];
  }

  function moveFocus(current, backwards) {
    const order = tabbables(current);
    if (!order.length) return null;
    let index = order.indexOf(current);
    if (index < 0) {
      // Not tabbable itself (the body, a div): continue from where it sits in the page.
      const after = order.findIndex(node => current && current !== document.body
        && (current.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
      index = backwards ? (after < 0 ? order.length : after) : (after < 0 ? -1 : after - 1);
    }
    const next = order[(index + (backwards ? -1 : 1) + order.length) % order.length];
    next.focus();
    if (next instanceof HTMLInputElement && hasSelection(next)) next.select();
    return next;
  }

  function defaultButton(form) {
    for (const control of form.elements) {
      if (kit.submitsForm(control)) return control;
    }
    return null;
  }

  // What a browser does with Enter in a form field: click the default button, or
  // submit when the form has none and only one field that blocks implicit submission.
  function implicitSubmit(field) {
    const form = field.form;
    if (!form) return false;
    const button = defaultButton(form);
    if (button) {
      if (!kit.isDisabled(button)) button.click();
      return true;
    }
    const blocking = [...form.elements].filter(control => control instanceof HTMLInputElement
      && ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(kit.inputType(control)));
    if (blocking.length > 1) return false;
    if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
    return true;
  }

  function enterActivates(node) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement || node instanceof HTMLElement && node.tagName === 'SUMMARY') return true;
    if (node instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image'].includes(kit.inputType(node))) return true;
    return ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'].includes((node.getAttribute?.('role') || '').trim());
  }

  function spaceActivates(node) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLElement && node.tagName === 'SUMMARY') return true;
    if (node instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(kit.inputType(node))) return true;
    return ['button', 'checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes((node.getAttribute?.('role') || '').trim());
  }

  function closeDialog(node) {
    let dialog = null;
    try {
      dialog = [...document.querySelectorAll('dialog[open]')].filter(item => item.matches(':modal')).at(-1) || null;
    } catch (_) { dialog = null; }
    dialog = dialog || node?.closest?.('dialog[open]') || null;
    if (dialog) {
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
      return true;
    }
    try {
      const popover = [...document.querySelectorAll('[popover]')].filter(item => item.matches(':popover-open')
        && (item.getAttribute('popover') || 'auto') !== 'manual').at(-1);
      if (popover) {
        popover.hidePopover();
        return true;
      }
    } catch (_) { /* no popover support */ }
    return false;
  }

  function focusedFacts() {
    const node = deepActive();
    if (!node || node === document.body || node === document.documentElement) return null;
    return { role: kit.roleOf(node), name: kit.clean(kit.nameOf(node), 120) };
  }

  // The browser's own action for the key, run only when the page did not cancel it.
  function keyDefault(node, key, shift) {
    const field = textControl(node) ? node : null;
    const rich = field ? null : editableRootOf(node);
    switch (key) {
      case 'Tab':
        moveFocus(node, shift);
        return;
      case 'Enter':
        if (node instanceof HTMLTextAreaElement) {
          const { start, end } = caretRange(node);
          editText(node, '\n', start, end, 'insertLineBreak');
        } else if (rich) {
          if (!document.execCommand?.('insertParagraph')) document.execCommand?.('insertLineBreak');
        } else if (field) {
          implicitSubmit(field);
        } else if (enterActivates(node)) {
          node.click();
        }
        return;
      case 'Space':
        if (field) {
          const { start, end } = caretRange(field);
          editText(field, ' ', start, end, 'insertText');
        } else if (rich) {
          document.execCommand?.('insertText', false, ' ');
        }
        // A button or a checkbox is clicked after keyup (below), as a browser does.
        return;
      case 'Backspace':
      case 'Delete': {
        const backward = key === 'Backspace';
        if (field) {
          const { start, end } = caretRange(field);
          const value = String(field.value || '');
          if (start !== end) {
            editText(field, '', start, end, backward ? 'deleteContentBackward' : 'deleteContentForward');
          } else if (backward && start > 0) {
            const width = start > 1 && /[\uDC00-\uDFFF]/.test(value[start - 1]) && /[\uD800-\uDBFF]/.test(value[start - 2]) ? 2 : 1;
            editText(field, '', start - width, start, 'deleteContentBackward');
          } else if (!backward && end < value.length && hasSelection(field)) {
            const width = /[\uD800-\uDBFF]/.test(value[end]) && /[\uDC00-\uDFFF]/.test(value[end + 1] || '') ? 2 : 1;
            editText(field, '', end, end + width, 'deleteContentForward');
          }
        } else if (rich) {
          document.execCommand?.(backward ? 'delete' : 'forwardDelete');
        }
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const down = key === 'ArrowDown';
        if (node instanceof HTMLSelectElement) stepSelect(node, down ? 'next' : 'previous');
        else if (radioGroup(node)) stepRadio(node, down);
        else if (field) moveCaret(field, down ? field.value.length : 0, shift);
        else if (rich) modifySelection(shift, down ? 'forward' : 'backward', 'line');
        else scrollBy(node, 0, down ? 40 : -40);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const right = key === 'ArrowRight';
        if (node instanceof HTMLSelectElement) return;
        if (radioGroup(node)) stepRadio(node, right);
        else if (field) {
          const { start, end } = caretRange(field);
          if (!shift && start !== end) moveCaret(field, right ? end : start, false);
          else moveCaret(field, focusPoint(field) + (right ? 1 : -1), shift);
        } else if (rich) modifySelection(shift, right ? 'forward' : 'backward', 'character');
        else scrollBy(node, right ? 40 : -40, 0);
        return;
      }
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown': {
        const toEnd = key === 'End' || key === 'PageDown';
        if (node instanceof HTMLSelectElement) {
          if (key === 'Home' || key === 'End') stepSelect(node, toEnd ? 'last' : 'first');
        } else if (field) moveCaret(field, toEnd ? field.value.length : 0, shift);
        else if (rich) modifySelection(shift, toEnd ? 'forward' : 'backward', key.startsWith('Page') ? 'documentboundary' : 'lineboundary');
        else if (key === 'Home' || key === 'End') scrollEdge(node, toEnd);
        else scrollBy(node, 0, (toEnd ? 1 : -1) * viewportOf(node));
        return;
      }
      case 'Escape':
        closeDialog(node);
        return;
      default:
    }
  }

  function pressKey(target) {
    const spec = KEYS[options?.key];
    if (!spec) return { ok: false, code: 'invalid_args', message: 'Touche inconnue.' };
    const shift = options?.shift === true;
    // Deleting or typing a space edits the field: never in a password, card or code field.
    if (['Backspace', 'Delete', 'Space'].includes(options.key) && kit.isSensitive(target)) {
      return { ok: false, code: 'sensitive_field' };
    }
    if (!focusedOnly) {
      target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      if (deepActive() !== target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
    startWatch();
    const init = {
      key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode,
      shiftKey: shift, bubbles: true, cancelable: true, composed: true
    };
    let cancelled = !target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (options.key === 'Enter' || options.key === 'Space') {
      if (!target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: spec.keyCode }))) cancelled = true;
    }
    if (!cancelled && target.isConnected) keyDefault(target, options.key, shift);
    // keyup goes where the focus is now (after a Tab, the next field), as with a real key.
    const upTarget = deepActive() && deepActive() !== document.body ? deepActive() : target;
    const upCancelled = !upTarget.dispatchEvent(new KeyboardEvent('keyup', init));
    if (options.key === 'Space' && !cancelled && !upCancelled && target.isConnected && spaceActivates(target)
      && !textControl(target) && !editableRootOf(target)) {
      target.click();
    }
    const fieldNode = textControl(target) || editableRootOf(target) ? target : null;
    return {
      ok: true,
      cancelled,
      focused: focusedFacts(),
      field_state: fieldNode && fieldNode.isConnected ? kit.fieldState(fieldNode) : null
    };
  }

  // ------------------------------------------------------------------ files (TEAM-751)

  function uploadFiles(target) {
    const list = Array.isArray(options?.files) ? options.files : [];
    if (!list.length || list.length > 10) return { ok: false, code: 'invalid_args', message: 'Entre 1 et 10 fichiers.' };
    const input = kit.fileInputFor(target);
    if (input && (kit.isDisabled(input) || !input.isConnected)) return { ok: false, code: 'element_not_found' };
    if (input && list.length > 1 && !input.multiple) {
      return { ok: false, code: 'invalid_args', message: 'Ce champ n’accepte qu’un seul fichier.' };
    }
    const transfer = new DataTransfer();
    for (const item of list) {
      const binary = atob(String(item?.data || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], String(item?.name || 'fichier'), { type: String(item?.mime || '') }));
      // The base64 copy is not needed any more.
      if (item && typeof item === 'object') item.data = null;
    }
    const held = [...transfer.files].map(file => ({ name: file.name, size: file.size }));
    if (input) {
      startWatch();
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const now = [...(input.files || [])].map(file => ({ name: file.name, size: file.size }));
      return { ok: true, files: now, field_state: now.length ? 'filled' : 'empty' };
    }
    // A drop area: it says it takes files by cancelling dragenter or dragover.
    const rect = target.getBoundingClientRect();
    const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const drag = type => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...point });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    startWatch();
    const entered = drag('dragenter');
    const over = drag('dragover');
    if (!entered && !over) {
      drag('dragleave');
      return { ok: false, code: 'invalid_args', message: 'Cet élément ne prend pas de fichiers : ni champ de fichier, ni zone de dépôt.' };
    }
    drag('drop');
    return { ok: true, files: held, field_state: null };
  }

  try {
    if (action === 'key') return pressKey(el);
    if (action === 'upload') return uploadFiles(el);

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

// `browser.fill_secret` (TEAM-729, docs/login-vault.md): type a saved login into the
// mapped fields. This is the ONE path that types into a password field; the generic
// `fill` above keeps refusing sensitive fields. The service worker already opened the
// seal and checked the tab's origin from Chrome; this function checks again, in the
// page, right before typing:
//   1. the LIVE top-frame origin (location.origin now) is `expectedOrigin` and one of
//      the sealed `origins`                                         -> origin_mismatch
//   2. the map is the asked snapshot of this very page               -> stale_snapshot
//   3. every id is in the map, connected, visible, enabled, editable,
//      in this top document                                         -> element_not_found
//      and of the right kind (password: <input type=password>; username: <input>
//      text/email/tel; otp: <input> text/tel/number/password)       -> invalid_args
//   4. each field's form posts to this origin, one of `origins`, or the login's
//      `site` (a button's own `formaction` counts too)              -> origin_mismatch
// Page scripts run during the focus/input/change events of one field, so each field is
// checked once more just before its value is set. Values are never returned, stored
// or written anywhere but the field itself.
export function fillSecretInPage(options) {
  const kit = globalThis.__limovaBrowserKit;
  const origins = Array.isArray(options?.origins) ? options.origins : [];
  const site = String(options?.site || '').toLowerCase();
  const values = options?.values || {};
  const fields = options?.fields || {};
  const ORDER = ['username', 'password', 'otp'];
  const KINDS = {
    username: ['text', 'email', 'tel'],
    password: ['password'],
    otp: ['text', 'tel', 'number', 'password']
  };
  // Read through the prototypes: a form's named controls (an <input name="action">,
  // name="getAttribute"…) shadow its own properties, so `form.action` can lie.
  const getAttr = (node, name) => Element.prototype.getAttribute.call(node, name);
  const hasAttr = (node, name) => Element.prototype.hasAttribute.call(node, name);
  const formElements = form => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form);

  function liveOriginOk() {
    return window.top === window
      && location.origin === options?.expectedOrigin
      && origins.includes(location.origin);
  }

  function allowedTarget(raw) {
    // No action: the form posts to this page.
    if (raw === null || String(raw).trim() === '') return true;
    let url;
    try {
      url = new URL(String(raw), document.baseURI);
    } catch (_) {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.origin === location.origin || origins.includes(url.origin)) return true;
    const host = url.hostname.toLowerCase();
    return Boolean(site) && (host === site || host.endsWith(`.${site}`));
  }

  function formOk(el) {
    const form = el.form;
    if (!form) return true;
    const method = String(getAttr(form, 'method') || '').toLowerCase();
    if (method !== 'dialog' && !allowedTarget(getAttr(form, 'action'))) return false;
    for (const control of formElements(form)) {
      if (hasAttr(control, 'formaction') && !allowedTarget(getAttr(control, 'formaction'))) return false;
    }
    return true;
  }

  function checkField(role, el) {
    if (!el || !el.isConnected || el.ownerDocument !== document) return 'element_not_found';
    if (!kit.isRendered(el) || kit.isDisabled(el)) return 'element_not_found';
    if (!(el instanceof HTMLInputElement)) return 'invalid_args';
    if (!KINDS[role].includes(el.type)) return 'invalid_args';
    if (el.readOnly) return 'element_not_found';
    if (!formOk(el)) return 'origin_mismatch';
    return null;
  }

  function fail(code) {
    return { ok: false, code };
  }

  // 1. The live origin first: nothing else is looked at on the wrong page.
  if (!liveOriginOk()) return fail('origin_mismatch');
  // 2. The snapshot.
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (!kit || !map || map.snapshotId !== options?.snapshotId || map.path !== kit.pagePath()) return fail('stale_snapshot');
  // 3 and 4. Every field, before typing anything.
  const targets = [];
  const used = new Set();
  for (const role of ORDER) {
    const id = fields[role];
    if (id === undefined || id === null) continue;
    const el = map.elements.get(String(id));
    if (!el) return fail('element_not_found');
    if (used.has(el)) return fail('invalid_args');
    used.add(el);
    const code = checkField(role, el);
    if (code) return fail(code);
    if (typeof values[role] !== 'string') return fail('invalid_args');
    targets.push({ role, el });
  }
  if (!targets.length) return fail('invalid_args');

  // The same watcher performPageAction starts, so the verification sees the changes.
  try { globalThis.__limovaBrowserWatch?.observer?.disconnect(); } catch (_) { /* ignore */ }
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

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const InputEventCtor = typeof InputEvent === 'function' ? InputEvent : Event;
  const filled = { username: false, password: false, otp: false };
  try {
    for (const { role, el } of targets) {
      // Page scripts ran during the previous field's events: check again.
      if (!liveOriginOk()) return { ok: false, code: 'origin_mismatch', filled };
      const code = checkField(role, el);
      if (code) return { ok: false, code, filled };
      el.scrollIntoView?.({ block: 'center' });
      el.focus({ preventScroll: true });
      setter.call(el, values[role]);
      // The event carries no `data`: a page's input listener gets the event, not the text.
      el.dispatchEvent(new InputEventCtor('input', { bubbles: true, composed: true, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      values[role] = null;
      filled[role] = true;
    }
  } catch (_) {
    return { ok: false, code: 'internal', filled };
  } finally {
    for (const role of ORDER) values[role] = null;
  }
  return { ok: true, filled };
}

// `browser.press_key` without an element (TEAM-751): which frame has the focus? Run in
// every frame; each says its own index chain and whether its focused element is a child
// frame (and which), so the service worker follows the chain from the top. Nothing of
// the page is read but the focused element's tag.
export function probeFocus(options) {
  const path = [];
  let win = window;
  for (let depth = 0; depth < 12 && win !== win.parent; depth += 1) {
    const parent = win.parent;
    let index = -1;
    try {
      for (let i = 0; i < parent.length; i += 1) {
        if (parent[i] === win) { index = i; break; }
      }
    } catch (_) { return { ok: true, path: null, child: null }; }
    if (index < 0) return { ok: true, path: null, child: null };
    path.unshift(index);
    win = parent;
  }
  // A frame on a blocked site is never looked into.
  let host = '';
  try { host = new URL(self.origin && self.origin !== 'null' ? self.origin : location.href).hostname.toLowerCase(); } catch (_) { host = ''; }
  if ((Array.isArray(options?.blockedHosts) ? options.blockedHosts : []).some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    return { ok: true, path, child: null, blocked: true };
  }
  const active = document.activeElement;
  let child = null;
  if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) {
    for (let i = 0; i < window.frames.length; i += 1) {
      try {
        if (window.frames[i] === active.contentWindow) { child = i; break; }
      } catch (_) { /* ignore */ }
    }
  }
  return { ok: true, path, child };
}
