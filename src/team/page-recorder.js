// page-recorder.js — Functions injected in a recorded tab (TEAM-731, « Montrer à Limova »).
//
// docs/procedure-recording-format.md. Like page-snapshot.js, each function is passed to
// chrome.scripting.executeScript and runs in the extension's ISOLATED world of the top
// frame; each is SELF-CONTAINED. They rely on the page kit that
// `pageSnapshot({installOnly: true})` installs just before (descriptors, names, the
// sensitive-field rule), so recorded targets and read_page elements are described by
// the same code.
//
// `startPageRecorder` only adds capture-phase listeners and one MutationObserver in the
// isolated world. It never changes the page: no node, attribute, global or event the
// page can see. It turns what the person does into semantic steps and sends each to
// the service worker (`TEAM_RECORD_EVENT`):
// - click on an interactive element (not empty space); download for a link that
//   downloads; check for checkboxes, radios, switches; select for a <select> or an
//   ARIA option;
// - fill: ONE event per field, when it loses focus or its form is submitted, with the
//   final value (never one per key press). A field that is plainly secret (password,
//   card, one-time code, the read_page `sensitive` rule) never sends its value at all;
//   the service worker applies the full redaction rules to the rest;
// - key: Enter and Escape pressed for their effect (Tab only moves between fields and
//   is not recorded);
// - upload: file names, types and sizes, never their bytes.
// About 600 ms to 3 s after each action it reports what changed (`TEAM_RECORD_OBSERVED`:
// DOM changed, new alerts/toasts, URL path, title). Events the page fires itself
// (`isTrusted` false) are ignored: only what the person did is recorded. While paused
// it records nothing.

export function startPageRecorder(options) {
  const kit = globalThis.__limovaBrowserKit;
  if (!kit || typeof kit.targetOf !== 'function') return { ok: false, code: 'no_kit' };
  if (window.top !== window) return { ok: false, code: 'not_top_frame' };
  const recordingId = String(options?.recordingId || '');
  if (!recordingId) return { ok: false, code: 'invalid_args' };
  const existing = globalThis.__limovaRecorder;
  if (existing && existing.recordingId === recordingId) {
    existing.paused = options?.paused === true;
    return { ok: true, installed: false, paused: existing.paused };
  }
  if (existing) existing.uninstall();

  const OBSERVE_MIN_MS = 600;
  const OBSERVE_MAX_MS = 3000;
  const OBSERVE_QUIET_MS = 400;
  const HEARTBEAT_MS = 20_000;
  const FILE_EXTENSIONS = /\.(pdf|csv|xlsx?|docx?|pptx?|zip|txt|json|xml|png|jpe?g|gif|ics|odt|ods)$/i;
  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="tab"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]', '[role="row"]',
    '[role="treeitem"]', '[role="gridcell"]', '[role="combobox"]'
  ].join(', ');
  const acceptUntrusted = options?.acceptUntrusted === true;

  const state = {
    recordingId,
    paused: options?.paused === true,
    seq: 0,
    dirty: new Set(),
    mutations: 0,
    lastChangeAt: 0,
    observer: null,
    heartbeat: null,
    listeners: [],
    uninstall: null
  };
  globalThis.__limovaRecorder = state;

  function pagePath() {
    return `${location.origin}${location.pathname}`;
  }

  function alertTexts() {
    const texts = [];
    for (const node of document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="status"], [aria-live]:not([aria-live="off"]), output')) {
      if (texts.length >= 20) break;
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkVisibilityCSS: true })) continue;
      const text = kit.clean(typeof node.innerText === 'string' ? node.innerText : node.textContent, 200);
      if (text && !texts.includes(text)) texts.push(text);
    }
    return texts;
  }

  function send(type, payload) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage({ type, recording_id: recordingId, ...payload }))
        .then(response => {
          // The service worker no longer records this tab (stopped, or it restarted).
          if (response && response.recording === false) state.uninstall();
          return response;
        })
        .catch(() => null);
    } catch (_) {
      state.uninstall();
      return Promise.resolve(null);
    }
  }

  function observe(seq, before) {
    const startMutations = state.mutations;
    const startedAt = Date.now();
    const check = () => {
      // Stopped or replaced meanwhile: this observation belongs to nobody now.
      if (globalThis.__limovaRecorder !== state) return;
      const elapsed = Date.now() - startedAt;
      const quiet = Date.now() - Math.max(state.lastChangeAt, startedAt);
      if (elapsed < OBSERVE_MAX_MS && (elapsed < OBSERVE_MIN_MS || quiet < OBSERVE_QUIET_MS)) {
        setTimeout(check, 150);
        return;
      }
      const now = alertTexts();
      send('TEAM_RECORD_OBSERVED', {
        observed: {
          seq,
          url: pagePath(),
          title: kit.clean(document.title, 200),
          dom_changed: state.mutations > startMutations,
          messages: now.filter(text => !before.includes(text)).slice(0, 5)
        }
      });
    };
    setTimeout(check, OBSERVE_MIN_MS);
  }

  function emit(event, { watch = true } = {}) {
    if (state.paused) return;
    state.seq += 1;
    const seq = state.seq;
    const before = watch ? alertTexts() : [];
    send('TEAM_RECORD_EVENT', {
      event: {
        seq,
        at: Date.now(),
        last_change_at: state.lastChangeAt || null,
        page: { url: pagePath(), title: kit.clean(document.title, 200) },
        ...event
      }
    });
    if (watch) observe(seq, before);
  }

  // A field whose value must never leave the page, whatever the service worker decides.
  function secretKind(el) {
    if (el instanceof HTMLInputElement && (el.getAttribute('type') || '').toLowerCase() === 'password') return 'password';
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some(token => token === 'current-password' || token === 'new-password')) return 'password';
    if (tokens.includes('one-time-code')) return 'otp';
    if (tokens.some(token => token === 'cc-number' || token === 'cc-csc' || token.startsWith('cc-exp'))) return 'card';
    if (kit.isSensitive(el)) return 'secret';
    return null;
  }

  function fieldValue(el) {
    if (el.isContentEditable) return (typeof el.innerText === 'string' ? el.innerText : el.textContent || '').trim();
    return String(el.value ?? '');
  }

  function flush(el) {
    if (!state.dirty.has(el)) return null;
    state.dirty.delete(el);
    if (!el.isConnected && !(el instanceof HTMLElement)) return null;
    const secret = secretKind(el);
    const event = {
      kind: 'fill',
      target: kit.targetOf(el),
      ...(secret ? { value_withheld: true, secret_kind: secret } : { value: fieldValue(el).slice(0, 5000) }),
      sensitive: Boolean(secret) || kit.isSensitive(el)
    };
    return event;
  }

  function flushInto(list, scope) {
    for (const el of [...state.dirty]) {
      if (scope && !(scope === el || scope.contains(el) || el.form === scope)) continue;
      const event = flush(el);
      if (event) list.push(event);
    }
    return list;
  }

  function emitFlushed(scope) {
    for (const event of flushInto([], scope)) emit(event, { watch: false });
  }

  function editableRoot(node) {
    if (!(node instanceof Element)) return null;
    if (node instanceof HTMLTextAreaElement) return node;
    if (node instanceof HTMLInputElement) return kit.isEditable(node) ? node : null;
    if (node.isContentEditable) {
      let root = node;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return null;
  }

  function trusted(event) {
    return acceptUntrusted || event.isTrusted;
  }

  function originalTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.find(node => node instanceof Element) || event.target;
  }

  function on(target, type, handler) {
    const wrapped = event => {
      if (state.paused || !trusted(event)) return;
      try { handler(event); } catch (_) { /* never break the page */ }
    };
    target.addEventListener(type, wrapped, true);
    state.listeners.push([target, type, wrapped]);
  }

  function ownerOfOption(option) {
    const list = option.closest('[role="listbox"], [role="menu"], [role="tree"], [role="grid"]');
    if (list?.id) {
      const escape = globalThis.CSS?.escape || (value => String(value).replace(/["\\\]\[]/g, '\\$&'));
      const owner = document.querySelector(`[aria-controls~="${escape(list.id)}"], [aria-owns~="${escape(list.id)}"]`);
      if (owner) return owner;
    }
    return list || option;
  }

  function downloadFile(el) {
    const link = el.closest('a[href]');
    if (!link) return null;
    let url;
    try { url = new URL(link.href, location.href); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol) && !link.hasAttribute('download')) return null;
    const named = link.getAttribute('download');
    const base = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (link.hasAttribute('download')) return { name: kit.clean(named || base || 'fichier', 200) };
    if (FILE_EXTENSIONS.test(url.pathname)) return { name: kit.clean(base, 200) };
    return null;
  }

  // ------------------------------------------------------------------ listeners

  on(document, 'input', event => {
    const field = editableRoot(originalTarget(event));
    if (field) state.dirty.add(field);
  });

  on(document, 'focusout', event => {
    const field = editableRoot(originalTarget(event));
    if (!field) return;
    const flushed = flush(field);
    if (flushed) emit(flushed, { watch: false });
  });

  on(document, 'submit', event => {
    emitFlushed(event.target instanceof HTMLFormElement ? event.target : null);
  });

  on(document, 'change', event => {
    const el = originalTarget(event);
    if (el instanceof HTMLSelectElement) {
      state.dirty.delete(el);
      const labels = [...el.selectedOptions].map(option => kit.clean(option.label || option.text, 200)).filter(Boolean);
      if (!labels.length) return;
      emit({ kind: 'select', target: kit.targetOf(el), option: labels.join(', ').slice(0, 200) });
      return;
    }
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        emit({ kind: 'check', target: kit.targetOf(el), checked: el.checked === true });
        return;
      }
      if (type === 'file') {
        const files = [...(el.files || [])].slice(0, 20).map(file => ({
          name: kit.clean(file.name, 200) || 'fichier',
          ...(file.type ? { mime: String(file.type).slice(0, 120) } : {}),
          ...(Number.isFinite(file.size) ? { size: file.size } : {})
        }));
        if (files.length) emit({ kind: 'upload', target: kit.targetOf(el), files });
      }
    }
  });

  on(document, 'drop', event => {
    const files = [...(event.dataTransfer?.files || [])].slice(0, 20).map(file => ({
      name: kit.clean(file.name, 200) || 'fichier',
      ...(file.type ? { mime: String(file.type).slice(0, 120) } : {}),
      ...(Number.isFinite(file.size) ? { size: file.size } : {})
    }));
    if (!files.length) return;
    const zone = originalTarget(event).closest?.('[aria-label], [role], label, form, section, div') || originalTarget(event);
    emit({ kind: 'upload', target: kit.targetOf(zone), files });
  });

  on(document, 'keydown', event => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    if (event.isComposing) return;
    const focused = originalTarget(event);
    if (event.key === 'Enter') {
      // Enter in a text area types a new line; on a button or link it clicks (recorded as a click).
      if (focused instanceof HTMLTextAreaElement || focused?.isContentEditable) return;
      if (focused instanceof Element && focused.closest('button, a[href], [role="button"], [role="link"], summary, select')) return;
      const field = editableRoot(focused);
      if (field) {
        const flushed = flush(field);
        if (flushed) emit(flushed, { watch: false });
      }
    }
    const target = focused instanceof Element && focused !== document.body && focused !== document.documentElement ? kit.targetOf(focused) : undefined;
    emit({ kind: 'key', key: event.key, ...(target ? { target } : {}) });
  });

  on(document, 'click', event => {
    const origin = originalTarget(event);
    const el = origin instanceof Element ? origin.closest(INTERACTIVE) : null;
    if (!el || !kit.isRendered(el)) return;
    if (el instanceof HTMLLabelElement) {
      // The label's own control gets its own click (or focus): record that instead.
      if (el.control) return;
    }
    if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return;
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      // Checkboxes, radios and files are recorded on change; text fields on blur.
      if (!['submit', 'button', 'reset', 'image'].includes(type)) return;
    }
    if (el.isContentEditable) return;
    const role = el.getAttribute('role') || '';
    if (role === 'option') {
      emit({ kind: 'select', target: kit.targetOf(ownerOfOption(el)), option: kit.clean(kit.nameOf(el), 200) || '?' });
      return;
    }
    if (['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const target = kit.targetOf(el);
      setTimeout(() => emit({ kind: 'check', target, checked: el.getAttribute('aria-checked') === 'true' }), 0);
      return;
    }
    // A click that submits: its form's fields are final now.
    if (kit.submitsForm(el)) emitFlushed(kit.formOf(el));
    const file = downloadFile(el);
    if (file) {
      emit({ kind: 'download', target: kit.targetOf(el), file });
      return;
    }
    emit({ kind: 'click', target: kit.targetOf(el) });
  });

  const onPageHide = () => emitFlushed(null);
  window.addEventListener('pagehide', onPageHide, true);

  state.observer = new MutationObserver(records => {
    state.mutations += records.length;
    state.lastChangeAt = Date.now();
  });
  state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  // Keeps the service worker awake while the person is reading, and notices a stop.
  state.heartbeat = setInterval(() => send('TEAM_RECORD_PING', {}), HEARTBEAT_MS);

  state.uninstall = () => {
    for (const [target, type, handler] of state.listeners) target.removeEventListener(type, handler, true);
    state.listeners = [];
    window.removeEventListener('pagehide', onPageHide, true);
    try { state.observer?.disconnect(); } catch (_) { /* ignore */ }
    clearInterval(state.heartbeat);
    if (globalThis.__limovaRecorder === state) globalThis.__limovaRecorder = null;
  };
  state.flushAll = () => flushInto([], null);
  return { ok: true, installed: true, paused: state.paused };
}

// « Arrêter »: hand back the fields still being typed in (their final value), then
// remove every listener. The service worker adds them as the last fill steps.
export function stopPageRecorder(options) {
  const state = globalThis.__limovaRecorder;
  if (!state || (options?.recordingId && state.recordingId !== options.recordingId)) return { ok: true, events: [] };
  const events = options?.flush === false ? [] : state.flushAll();
  state.uninstall();
  return { ok: true, events };
}

// Pause or resume without reinstalling. Pausing hands back what was typed before the
// pause (it happened while recording); nothing typed during the pause is kept.
export function pausePageRecorder(options) {
  const state = globalThis.__limovaRecorder;
  if (!state || state.recordingId !== options?.recordingId) return { ok: false, events: [] };
  const events = options?.paused === true && !state.paused ? state.flushAll() : [];
  state.paused = options?.paused === true;
  state.dirty.clear();
  return { ok: true, paused: state.paused, events };
}
