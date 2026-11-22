// page-snapshot.js — Functions injected in a tab to read it (TEAM-724, `browser.read_page`).
//
// Each exported function is passed to chrome.scripting.executeScript({func}) and runs in
// the extension's ISOLATED world of one frame of the tab: the top frame, or (TEAM-751,
// `browser.v2+frames`) a child frame the service worker targets by its documentId.
// Chrome serialises the function source, so every function here is SELF-CONTAINED: it
// must not use anything from this module's scope.
//
// The page map (element ids e1, e2… -> live elements) lives in that isolated world
// (`globalThis.__limovaBrowserMaps`), which persists per document and per extension.
// It is NEVER written as attributes on the page: the page can neither read the map nor
// move an id onto another element. A new read_page replaces the map; a navigation drops
// the isolated world, so an older snapshot_id answers `stale_snapshot`.
//
// Each frame keeps its own map in its own isolated world, with plain ids (`e3`); the
// service worker adds the frame prefix (`fr2.e3`) and remembers which frame and which
// document each prefix names, so a frame that navigated answers `stale_snapshot`.
//
// File inputs (TEAM-751, `browser.v2+upload`) are listed even when the page hides them
// behind a styled label or button, named after that label or button.
//
// Privacy: field values are never returned. A field only reports `state` (empty, filled
// or sensitive); a select its chosen option label; a checkbox its `checked`; a file
// input how many files it holds, never their names. Text typed in editable areas is cut
// out of the page text. URLs are origin + pathname only.

export function pageSnapshot(options) {
  // 2: descriptor fields for recordings and read_page (TEAM-731).
  // 3: file inputs and their openers, frame paths (TEAM-751).
  const KIT_VERSION = 3;

  function buildKit() {
    const SENSITIVE_HINT = /(pass(?:word|wd|code|phrase)?\b|mot[ -]de[ -]passe|contrase|\bpin\b|\bcvv\d?\b|\bcvc\d?\b|\bcvn\b|security code|code de s[ée]curit|card.?num|num[ée]ro de carte|carte bancaire|credit.?card|\bcc.?num|\biban\b|\botp\b|one.?time|code de v[ée]rification|verification code|\b2fa\b|\bmfa\b|code (?:re[çc]u|sms)|\bsecret\b|api.?key|\btoken\b)/i;
    const TEXT_INPUT_TYPES = ['', 'text', 'email', 'tel', 'url', 'search', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time'];
    const CHECKABLE_TYPES = ['checkbox', 'radio'];
    const BUTTON_TYPES = ['submit', 'button', 'reset', 'image'];

    function clean(text, max) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim();
      return max && value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }

    function normalize(text) {
      return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[’'`´]/g, ' ').replace(/[^a-z0-9@]+/g, ' ').trim();
    }

    function inputType(el) {
      return el instanceof HTMLInputElement ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    }

    function editableRoot(el) {
      return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
    }

    function isEditable(el) {
      if (el instanceof HTMLTextAreaElement) return true;
      if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.includes(inputType(el));
      return editableRoot(el) || ['textbox', 'searchbox'].includes(el.getAttribute('role') || '') && el.isContentEditable;
    }

    function isRendered(el) {
      if (!el || !el.isConnected) return false;
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkVisibilityCSS: true })) return false;
      } else {
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
          if (node.hidden) return false;
        }
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isDisabled(el) {
      if (el.disabled === true) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      return Boolean(el.closest && el.closest('fieldset[disabled]') && (el.form !== undefined));
    }

    function roleOf(el) {
      const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'input') {
        const type = inputType(el);
        if (type === 'search') return 'searchbox';
        if (CHECKABLE_TYPES.includes(type)) return type;
        if (BUTTON_TYPES.includes(type) || type === 'file') return 'button';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    }

    // Text of a node without the form controls inside it (a textarea's text is its value).
    function textWithoutControls(node) {
      if (!node) return '';
      const clone = node.cloneNode(true);
      clone.querySelectorAll?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), script, style').forEach(child => child.remove());
      return clone.textContent || '';
    }

    function visibleText(el) {
      const text = typeof el.innerText === 'string' ? el.innerText : el.textContent;
      return text || '';
    }

    function nameOf(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => textWithoutControls(document.getElementById(id))).join(' ');
        if (clean(text)) return clean(text, 120);
      }
      const aria = el.getAttribute('aria-label');
      if (clean(aria)) return clean(aria, 120);
      const tag = el.tagName.toLowerCase();
      const isControl = tag === 'input' || tag === 'select' || tag === 'textarea';
      if (isControl) {
        const type = inputType(el);
        if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) {
          return clean(el.value || (type === 'submit' ? 'Envoyer' : type === 'reset' ? 'Réinitialiser' : ''), 120);
        }
        if (tag === 'input' && type === 'image') return clean(el.getAttribute('alt') || el.getAttribute('title') || 'Envoyer', 120);
        const labels = el.labels ? [...el.labels] : [];
        const labelText = clean(labels.map(textWithoutControls).join(' '));
        if (labelText) return clean(labelText, 120);
        if (type === 'file') {
          // A hidden file input is named after the button the person clicks (TEAM-751).
          const opener = fileOpenerOf(el);
          const openerName = opener ? nameOf(opener) : '';
          if (openerName) return openerName;
          if (clean(el.getAttribute('title'))) return clean(el.getAttribute('title'), 120);
          // A drop area's own words (« Glissez vos fichiers ici »), when they are short.
          const around = el.parentElement && !isRendered(el) ? clean(textWithoutControls(el.parentElement)) : '';
          if (around && around.length <= 80) return around;
          return clean(el.getAttribute('name') || 'Choisir un fichier', 120);
        }
        const fallback = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
        return clean(fallback, 120);
      }
      if (el.isContentEditable) {
        // Never the editable text itself: that is what the person typed.
        return clean(el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title') || 'Zone de texte', 120);
      }
      const text = clean(visibleText(el));
      if (text) return clean(text, 120);
      const img = el.querySelector?.('img[alt]');
      if (img && clean(img.getAttribute('alt'))) return clean(img.getAttribute('alt'), 120);
      const svgTitle = el.querySelector?.('svg title');
      if (svgTitle && clean(svgTitle.textContent)) return clean(svgTitle.textContent, 120);
      return clean(el.getAttribute('title') || '', 120);
    }

    function isSensitive(el, name) {
      if (!isEditable(el) && !(el instanceof HTMLSelectElement)) return false;
      if (inputType(el) === 'password') return true;
      const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      if (tokens.some(token => token.startsWith('cc-') || ['one-time-code', 'current-password', 'new-password'].includes(token))) return true;
      const hay = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), name ?? nameOf(el)]
        .filter(Boolean).join(' ');
      return SENSITIVE_HINT.test(hay);
    }

    function fieldState(el) {
      if (isSensitive(el)) return 'sensitive';
      if (el instanceof HTMLSelectElement) return el.selectedIndex >= 0 && el.value !== '' ? 'filled' : 'empty';
      if (el instanceof HTMLInputElement) {
        const type = inputType(el);
        if (CHECKABLE_TYPES.includes(type)) return el.checked ? 'filled' : 'empty';
        if (type === 'file') return el.files && el.files.length ? 'filled' : 'empty';
        return el.value !== '' ? 'filled' : 'empty';
      }
      if (el instanceof HTMLTextAreaElement) return el.value !== '' ? 'filled' : 'empty';
      if (el.isContentEditable) return clean(el.textContent) ? 'filled' : 'empty';
      return null;
    }

    function hostOf(url) {
      try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
    }

    function formInfo(form) {
      if (!form) return null;
      let actionOrigin = null;
      let external = false;
      try {
        const action = new URL(form.getAttribute('action') || location.href, location.href);
        if (action.protocol === 'http:' || action.protocol === 'https:') {
          actionOrigin = action.origin;
          external = hostOf(action.href) !== hostOf(location.href);
        }
      } catch (_) { /* invalid action: same page */ }
      const method = (form.getAttribute('method') || 'get').toLowerCase() === 'post' ? 'post' : (form.getAttribute('method') || 'get').toLowerCase() === 'dialog' ? 'dialog' : 'get';
      const passwords = form.querySelectorAll('input[type="password"]').length;
      return {
        method,
        action_origin: actionOrigin,
        external,
        has_password: passwords > 0,
        has_new_password: passwords > 1 || Boolean(form.querySelector('[autocomplete~="new-password"]')),
        has_card: Boolean(form.querySelector('[autocomplete^="cc-"], [autocomplete*=" cc-"]'))
          || [...form.querySelectorAll('input')].some(input => /card.?num|num[ée]ro de carte|\bcvv\b|\bcvc\b/i.test(`${input.name} ${input.id}`))
      };
    }

    function formOf(el) {
      if (el instanceof HTMLFormElement) return el;
      return el.form || el.closest?.('form') || null;
    }

    function submitsForm(el) {
      const form = formOf(el);
      if (!form || el instanceof HTMLFormElement) return false;
      if (el instanceof HTMLButtonElement) return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
      if (el instanceof HTMLInputElement) return ['submit', 'image'].includes(inputType(el));
      return false;
    }

    function safeHref(el) {
      if (!(el instanceof HTMLAnchorElement) || !el.href) return null;
      try {
        const url = new URL(el.href, location.href);
        return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null;
      } catch (_) { return null; }
    }

    function inViewport(rect) {
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    }

    function pagePath() {
      return `${location.origin}${location.pathname}`;
    }

    // ------------------------------------------------------------------ file inputs (TEAM-751)

    function isFileInput(el) {
      return el instanceof HTMLInputElement && inputType(el) === 'file';
    }

    function opensFiles(node) {
      if (!(node instanceof Element) || isFileInput(node)) return false;
      if (node instanceof HTMLLabelElement || node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return true;
      return ['button', 'link'].includes((node.getAttribute('role') || '').trim());
    }

    // The visible control a person clicks to open a hidden file input: its label, a
    // button whose aria-controls names it, the button right next to it, or a button-like
    // parent. Null when there is none, or none is shown.
    function fileOpenerOf(input) {
      const candidates = input.labels ? [...input.labels] : [];
      if (input.id) {
        for (const node of document.querySelectorAll('[aria-controls]')) {
          if ((node.getAttribute('aria-controls') || '').split(/\s+/).includes(input.id)) candidates.push(node);
        }
      }
      for (const sibling of [input.previousElementSibling, input.nextElementSibling]) {
        if (opensFiles(sibling)) candidates.push(sibling);
      }
      if (opensFiles(input.parentElement)) candidates.push(input.parentElement);
      return candidates.find(node => isRendered(node)) || null;
    }

    // A file input is listed when the person can reach it: shown, behind a shown opener,
    // or hidden inside a shown container (a drop area keeps its input display: none).
    function fileReachable(input) {
      if (isRendered(input)) return true;
      if (fileOpenerOf(input)) return true;
      const parent = input.parentElement;
      return Boolean(parent && isRendered(parent));
    }

    // The file input an upload names: the input itself, a label's control, a single file
    // input inside the element, its aria-controls, a file input right next to it, or
    // the only file input among its siblings. A neighbour only counts when it has no
    // other opener: a drop area next to another field's input is not that field.
    // Null: the element may be a drop area.
    function fileInputFor(el) {
      if (isFileInput(el)) return el;
      if (el instanceof HTMLLabelElement && isFileInput(el.control)) return el.control;
      const nested = [...(el.querySelectorAll?.('input') || [])].filter(isFileInput);
      if (nested.length === 1) return nested[0];
      for (const id of (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (isFileInput(node)) return node;
      }
      const owned = input => {
        const opener = fileOpenerOf(input);
        return !opener || opener === el;
      };
      for (const sibling of [el.nextElementSibling, el.previousElementSibling]) {
        if (isFileInput(sibling) && owned(sibling)) return sibling;
      }
      const siblings = el.parentElement ? [...el.parentElement.children].filter(isFileInput) : [];
      return siblings.length === 1 && owned(siblings[0]) ? siblings[0] : null;
    }

    function uploadTargetOf(el) {
      const input = fileInputFor(el);
      if (!input) return { kind: 'drop', accept: '', multiple: true, disabled: false };
      return {
        kind: 'input',
        accept: clean(input.getAttribute('accept') || '', 200),
        multiple: input.multiple === true,
        disabled: isDisabled(input)
      };
    }

    // ------------------------------------------------------------------ frames (TEAM-751)

    // This frame's index chain from the top frame (`[]` for the top frame), the way
    // read_page's `frames[].path` and a recording's `target.frame.path` say it. Indexes
    // are positions in the parent's window.frames, readable even across origins.
    function framePath() {
      const path = [];
      let win = window;
      for (let depth = 0; depth < 12 && win !== win.parent; depth += 1) {
        const parent = win.parent;
        let index = -1;
        try {
          for (let i = 0; i < parent.length; i += 1) {
            if (parent[i] === win) { index = i; break; }
          }
        } catch (_) { return null; }
        if (index < 0) return null;
        path.unshift(index);
        win = parent;
      }
      return path;
    }

    function frameOrigin() {
      const origin = typeof self.origin === 'string' ? self.origin : location.origin;
      return origin && origin !== 'null' ? origin : location.origin;
    }

    function describe(el) {
      const name = nameOf(el);
      const form = formOf(el);
      const file = isFileInput(el);
      // A hidden file input is placed where its opener (or its parent) is.
      const placed = file && !isRendered(el) ? (fileOpenerOf(el) || el.parentElement || el) : el;
      const rect = placed.getBoundingClientRect();
      return {
        name,
        role: roleOf(el),
        tag: el.tagName.toLowerCase(),
        type: el instanceof HTMLInputElement ? inputType(el) : null,
        editable: isEditable(el),
        is_select: el instanceof HTMLSelectElement,
        is_checkable: el instanceof HTMLInputElement && CHECKABLE_TYPES.includes(inputType(el)),
        sensitive: isSensitive(el, name),
        disabled: isDisabled(el),
        rendered: file ? fileReachable(el) : isRendered(el),
        is_file: file,
        multiline: el instanceof HTMLTextAreaElement || Boolean(el.isContentEditable),
        submits: submitsForm(el),
        is_form: el instanceof HTMLFormElement,
        in_form: Boolean(form),
        form: formInfo(form),
        href: safeHref(el),
        download: el.hasAttribute?.('download') || false,
        in_viewport: inViewport(rect)
      };
    }

    // ------------------------------------------------------------------ descriptors
    // TEAM-731 (docs/procedure-recording-format.md « target »): an element described the
    // way a person finds it again. Never a selector, an XPath, coordinates or a DOM
    // index, and never a field's value. Same limits as the server's TargetDescriptor.

    function labelOf(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = clean(labelledBy.split(/\s+/).map(id => textWithoutControls(document.getElementById(id))).join(' '));
        if (text) return clean(text, 200);
      }
      const labels = el.labels ? [...el.labels] : [];
      return clean(labels.map(textWithoutControls).join(' '), 200);
    }

    // Ids frameworks make up (`:r1f:`, `ember123`, hashes, long digit runs) change at
    // every build or render: useless, even misleading, to find the element again.
    function stableId(id) {
      const value = String(id || '');
      if (!value || value.length > 60) return '';
      if (/\d{4,}/.test(value) || /[:]/.test(value) || /[0-9a-f]{8,}/i.test(value)) return '';
      if (/^(?:ember|ext-gen|yui_|react-|mui-|radix-|headlessui-|downshift-|rc_select_|rc-tabs-|__next|j_id|ctl\d)/i.test(value)) return '';
      if (/^[a-z]{0,3}\d+$/i.test(value)) return '';
      return value;
    }

    function landmarkOf(el) {
      const dialog = el.closest?.('dialog, [role="dialog"], [role="alertdialog"]');
      if (dialog) return 'dialog';
      const pairs = [
        ['nav, [role="navigation"]', 'navigation'],
        ['[role="search"]', 'search'],
        ['main, [role="main"]', 'main'],
        ['aside, [role="complementary"]', 'complementary'],
        ['header, [role="banner"]', 'banner'],
        ['footer, [role="contentinfo"]', 'contentinfo']
      ];
      for (const [selector, name] of pairs) {
        if (el.closest?.(selector)) return name;
      }
      return '';
    }

    function headingText(node) {
      return clean(textWithoutControls(node), 300);
    }

    // The closest heading, legend, column header or card title; in a table row, the
    // row's first cell (the « Modifier » of the third line names that line).
    function nearbyOf(el) {
      const row = el.closest?.('tr, [role="row"]');
      if (row) {
        const first = row.querySelector('th, td, [role="cell"], [role="gridcell"], [role="rowheader"]');
        if (first && !first.contains(el)) {
          const text = headingText(first);
          if (text) return text;
        }
      }
      const fieldset = el.closest?.('fieldset');
      const legend = fieldset?.querySelector('legend');
      if (legend && !legend.contains(el) && headingText(legend)) return headingText(legend);
      const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption';
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const found = [...node.querySelectorAll(HEADINGS)]
          .filter(heading => !heading.contains(el) && (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        const nearest = found.at(-1);
        if (nearest && headingText(nearest)) return headingText(nearest);
      }
      return '';
    }

    function testIdOf(el) {
      for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
        const value = el.getAttribute(attribute);
        if (value) return clean(value, 100);
      }
      return '';
    }

    function hintsOf(el) {
      const hints = {};
      if (el instanceof HTMLInputElement) hints.input_type = clean(inputType(el), 30);
      const name = el.getAttribute('name');
      if (name && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement)) {
        hints.input_name = clean(name, 100);
      }
      const autocomplete = (el.getAttribute('autocomplete') || '').trim().toLowerCase();
      if (autocomplete && autocomplete !== 'on' && autocomplete !== 'off') hints.autocomplete = clean(autocomplete, 60);
      const testid = testIdOf(el);
      if (testid) hints.testid = testid;
      const id = stableId(el.id);
      if (id) hints.id_attr = id;
      const href = safeHref(el);
      if (href) hints.href_path = href.slice(0, 500);
      const landmark = landmarkOf(el);
      if (landmark) hints.landmark = landmark;
      return hints;
    }

    function formRefOf(form) {
      if (!form) return null;
      const info = formInfo(form);
      const heading = form.querySelector('h1, h2, h3, h4, legend');
      const name = clean(form.getAttribute('aria-label') || (form.getAttribute('aria-labelledby') && labelOf(form))
        || form.getAttribute('name') || (heading ? textWithoutControls(heading) : ''), 100);
      const ref = {};
      if (name) ref.name = name;
      if (info?.action_origin) ref.action_origin = info.action_origin;
      if (info?.method) ref.method = info.method;
      return Object.keys(ref).length ? ref : null;
    }

    // The fields read_page adds next to each element (browser.record.v1).
    function descriptorFields(el) {
      const out = {};
      const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
      if (isField) {
        const label = labelOf(el);
        if (label) out.label = label;
        const placeholder = clean(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '', 200);
        if (placeholder) out.placeholder = placeholder;
      }
      const nearby = nearbyOf(el);
      if (nearby) out.nearby = nearby;
      const hints = hintsOf(el);
      if (Object.keys(hints).length) out.hints = hints;
      return out;
    }

    // A recording `target`: role, name, tag, text, label, placeholder, nearby, hints,
    // form and ordinal (its rank among same-role, same-name elements, from 0).
    function targetOf(el) {
      const role = roleOf(el);
      const name = nameOf(el);
      const target = { role: clean(role, 40), name: clean(name, 200), tag: el.tagName.toLowerCase().slice(0, 20) };
      const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
      if (!isField) {
        const text = clean(visibleText(el), 200);
        if (text && normalize(text) !== normalize(name)) target.text = text;
      }
      Object.assign(target, descriptorFields(el));
      const form = formRefOf(formOf(el));
      if (form) target.form = form;
      if (name) {
        let ordinal = 0;
        let counted = 0;
        const wanted = normalize(name);
        for (const other of document.querySelectorAll('a[href], button, input, select, textarea, summary, [role], [contenteditable]:not([contenteditable="false"])')) {
          if (other === el) break;
          if (counted++ > 3000) { ordinal = null; break; }
          if (roleOf(other) === role && normalize(nameOf(other)) === wanted && isRendered(other)) ordinal += 1;
        }
        if (ordinal !== null) target.ordinal = Math.min(ordinal, 500);
      }
      for (const key of Object.keys(target)) {
        if (target[key] === '' || target[key] === null) delete target[key];
      }
      return target;
    }

    return {
      version: KIT_VERSION,
      clean, normalize, isRendered, isDisabled, isEditable, isSensitive, fieldState, nameOf, roleOf,
      formOf, formInfo, submitsForm, safeHref, inViewport, pagePath, describe, inputType,
      labelOf, nearbyOf, hintsOf, descriptorFields, targetOf, stableId, landmarkOf, visibleText,
      isFileInput, fileOpenerOf, fileReachable, fileInputFor, uploadTargetOf, framePath, frameOrigin
    };
  }

  let kit = globalThis.__limovaBrowserKit;
  if (!kit || kit.version !== KIT_VERSION) {
    kit = buildKit();
    globalThis.__limovaBrowserKit = kit;
  }

  // The recorder (page-recorder.js) only needs the kit in this document.
  if (options?.installOnly === true) return { ok: true, kit: kit.version };

  const productKey = String(options?.productKey || '');
  const snapshotId = String(options?.snapshotId || '');
  // A child frame (TEAM-751) gets what the frames before it left of the budgets, which
  // may be nothing at all.
  const inFrame = options?.frame === true;
  const maxText = inFrame
    ? Math.max(0, Math.min(20000, Math.floor(Number(options?.maxText) || 0)))
    : Math.max(500, Math.min(20000, Number(options?.maxText) || 8000));
  const maxElements = inFrame
    ? Math.max(0, Math.min(400, Math.floor(Number(options?.maxElements) || 0)))
    : Math.max(1, Math.min(400, Number(options?.maxElements) || 200));
  if (!productKey || !snapshotId) return { ok: false, code: 'invalid_args' };
  if (!document.documentElement) return { ok: false, code: 'page_unavailable' };

  // 1. Interactive elements, in document order; the visible ones first when cut.
  const SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="option"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="slider"]', '[role="treeitem"]'
  ].join(', ');
  const candidates = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (candidates.length >= 5000) break;
    if (seen.has(el)) continue;
    seen.add(el);
    if (el instanceof HTMLInputElement && kit.inputType(el) === 'hidden') continue;
    if (el.isContentEditable && el.parentElement?.isContentEditable) continue;
    // A file input hidden behind its label or button still counts (TEAM-751).
    if (kit.isFileInput(el) ? !kit.fileReachable(el) : !kit.isRendered(el)) continue;
    const info = kit.describe(el);
    if (!info.name && !info.editable && !info.is_select && !info.is_checkable) continue;
    candidates.push({ el, info });
  }
  const visible = candidates.filter(item => item.info.in_viewport);
  const offscreen = candidates.filter(item => !item.info.in_viewport);
  const picked = new Set([...visible, ...offscreen].slice(0, maxElements));
  const chosen = candidates.filter(item => picked.has(item));

  const formIds = new Map();
  const forms = [];
  const formMap = new Map();
  const elementMap = new Map();
  const elements = chosen.map((item, index) => {
    const id = `e${index + 1}`;
    elementMap.set(id, item.el);
    const form = kit.formOf(item.el);
    let formId = null;
    if (form) {
      if (!formIds.has(form)) {
        const fid = `f${formIds.size + 1}`;
        formIds.set(form, fid);
        formMap.set(fid, form);
        forms.push({ id: fid, ...kit.formInfo(form) });
      }
      formId = formIds.get(form);
    }
    const entry = {
      id,
      role: item.info.role,
      tag: item.info.tag,
      type: item.info.type,
      name: item.info.name,
      form: formId,
      in_viewport: item.info.in_viewport,
      disabled: item.info.disabled,
      submits: item.info.submits,
      href: item.info.href,
      sensitive: item.info.sensitive,
      // browser.record.v1: label, placeholder, nearby, hints. Never a value.
      ...kit.descriptorFields(item.el)
    };
    if (item.info.editable || item.info.is_select || item.info.is_checkable) entry.state = kit.fieldState(item.el);
    if (item.info.is_checkable) entry.checked = item.el.checked === true;
    if (item.info.is_file) {
      // How many files, never their names (TEAM-751).
      const count = item.el.files ? item.el.files.length : 0;
      entry.state = count ? 'filled' : 'empty';
      entry.files = count;
      entry.accept = kit.clean(item.el.getAttribute('accept') || '', 200);
      entry.multiple = item.el.multiple === true;
    }
    if (item.info.is_select && !item.info.sensitive) {
      const option = item.el.selectedOptions?.[0];
      entry.selected = option ? kit.clean(option.label || option.text, 80) : null;
      entry.options = [...item.el.options].slice(0, 25).map(opt => kit.clean(opt.label || opt.text, 80)).filter(Boolean);
    }
    return entry;
  });

  globalThis.__limovaBrowserMaps = globalThis.__limovaBrowserMaps || {};
  globalThis.__limovaBrowserMaps[productKey] = {
    snapshotId,
    path: kit.pagePath(),
    elements: elementMap,
    forms: formMap,
    createdAt: Date.now()
  };

  // 2. Visible text, without what the person typed in editable areas.
  const body = document.body;
  let text = body ? (typeof body.innerText === 'string' ? body.innerText : body.textContent || '') : '';
  for (const editable of document.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])')) {
    if (editable.isContentEditable && editable.parentElement?.isContentEditable) continue;
    const typed = (typeof editable.innerText === 'string' ? editable.innerText : editable.textContent || '').trim();
    if (typed.length >= 2) text = text.split(typed).join(' ');
  }
  text = text.replace(/\r/g, '').split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
  const textTruncated = text.length > maxText;
  if (textTruncated) text = text.slice(0, maxText);
  const path = kit.framePath();

  // 3. Text hidden from people that reads like instructions to an assistant.
  const INSTRUCTION = /(ignore[sz]? (?:all |any |the )?(?:previous|prior|above|earlier|preceding) (?:instructions|prompts?|messages)|ignore (?:tes|les|toutes les|vos) (?:instructions|consignes)|oublie (?:tes|les|toutes les) (?:instructions|consignes)|disregard (?:all |the |any )?(?:previous |prior |above )?(?:instructions|rules)|new instructions|nouvelles (?:instructions|consignes)|you are now|tu es maintenant|vous etes maintenant|vous êtes maintenant|system prompt|prompt syst[eè]me|\bassistant\s*:|\bsystem\s*:|as an ai (?:assistant|agent|model)|en tant qu.(?:ia|assistant)|(?:send|forward|email|envoie|envoyez|transf[eè]re|transmets)\b.{0,80}(?:to|à|a)\s+\S+@\S+|reveal (?:your|the) (?:instructions|prompt|secrets?)|r[ée]v[eè]le (?:tes|vos|les) (?:instructions|secrets?))/i;
  const suspicious = [];
  const flagged = new Set();
  function hiddenFromPeople(el) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (Number(style.opacity) < 0.05) return true;
    if (parseFloat(style.fontSize) > 0 && parseFloat(style.fontSize) < 3) return true;
    if (/rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/.test(style.clip || '')) return true;
    if (style.position === 'absolute' || style.position === 'fixed') {
      const rect = el.getBoundingClientRect();
      if (rect.right < -500 || rect.bottom < -500 || rect.left > innerWidth + 3000) return true;
    }
    return false;
  }
  let scanned = 0;
  for (const el of (body ? body.querySelectorAll('*') : [])) {
    if (suspicious.length >= 5 || scanned >= 4000) break;
    scanned += 1;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH'].includes(el.tagName.toUpperCase())) continue;
    let parent = el.parentElement;
    let insideFlagged = false;
    while (parent) {
      if (flagged.has(parent)) { insideFlagged = true; break; }
      parent = parent.parentElement;
    }
    if (insideFlagged) continue;
    const raw = el.textContent || '';
    if (raw.trim().length < 20) continue;
    if (!hiddenFromPeople(el)) continue;
    flagged.add(el);
    const content = kit.clean(raw).slice(0, 2000);
    if (INSTRUCTION.test(content)) suspicious.push({ kind: 'hidden_instructions', text: kit.clean(content, 300) });
  }

  return {
    ok: true,
    url: kit.pagePath(),
    title: kit.clean(document.title, 300),
    origin: kit.frameOrigin(),
    path,
    elements,
    forms,
    text,
    text_truncated: textTruncated,
    elements_truncated: candidates.length > chosen.length,
    suspicious
  };
}

// Live facts about one element of the current map, for the risk check and the
// `target` check at action time.
export function inspectPageElement(options) {
  const kit = globalThis.__limovaBrowserKit;
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (!kit || !map || map.snapshotId !== options?.snapshotId || map.path !== kit.pagePath()) {
    return { ok: false, code: 'stale_snapshot' };
  }
  const el = map.elements.get(String(options?.elementId || ''));
  if (!el || !el.isConnected) return { ok: false, code: 'element_not_found' };
  const info = kit.describe(el);
  if (!info.rendered || info.disabled) return { ok: false, code: 'element_not_found' };
  // `browser.upload` (TEAM-751): the file input this element opens, or a drop area.
  if (options?.upload === true) info.upload = kit.uploadTargetOf(el);
  return {
    ok: true,
    element: info,
    page: { origin: kit.frameOrigin(), path: location.pathname, title: kit.clean(document.title, 300) }
  };
}

// TEAM-751 (`browser.v2+frames`): where this frame sits, run in every frame before a
// read. It reads no page content: its index chain from the top, its origin, and, for
// each child frame, the frame element's title or name, whether it is shown and its
// content box in this frame's viewport (to place the child's elements and masks).
// A frame whose host is in `blockedHosts` returns its index chain and nothing else.
export function probeFrame(options) {
  function pathOf() {
    const path = [];
    let win = window;
    for (let depth = 0; depth < 12 && win !== win.parent; depth += 1) {
      const parent = win.parent;
      let index = -1;
      try {
        for (let i = 0; i < parent.length; i += 1) {
          if (parent[i] === win) { index = i; break; }
        }
      } catch (_) { return null; }
      if (index < 0) return null;
      path.unshift(index);
      win = parent;
    }
    return path;
  }
  const path = pathOf();
  const origin = typeof self.origin === 'string' && self.origin !== 'null' ? self.origin : location.origin;
  // A frame on a blocked site (LinkedIn, Limova itself) says where it is, nothing more.
  let host = '';
  try { host = new URL(origin).hostname.toLowerCase(); } catch (_) { host = String(location.hostname || '').toLowerCase(); }
  const blocked = (Array.isArray(options?.blockedHosts) ? options.blockedHosts : [])
    .some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  if (blocked) return { ok: true, path, blocked: true };
  function clean(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return max && value.length > max ? value.slice(0, max) : value;
  }
  const holders = [...document.querySelectorAll('iframe, frame')];
  const children = [];
  for (let index = 0; index < window.frames.length && index < 100; index += 1) {
    const win = window.frames[index];
    const holder = holders.find(node => {
      try { return node.contentWindow === win; } catch (_) { return false; }
    }) || null;
    const child = { index, title: '', rendered: false, rect: null, src_origin: null };
    if (holder) {
      child.title = clean(holder.getAttribute('title') || holder.getAttribute('name') || '', 100);
      const box = holder.getBoundingClientRect();
      const shown = typeof holder.checkVisibility === 'function'
        ? holder.checkVisibility({ checkVisibilityCSS: true })
        : getComputedStyle(holder).visibility !== 'hidden' && getComputedStyle(holder).display !== 'none';
      child.rendered = Boolean(shown && box.width > 1 && box.height > 1);
      const style = getComputedStyle(holder);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const left = box.left + (holder.clientLeft || 0) + padLeft;
      const top = box.top + (holder.clientTop || 0) + padTop;
      const width = Math.max(0, (holder.clientWidth || box.width) - padLeft - (parseFloat(style.paddingRight) || 0));
      const height = Math.max(0, (holder.clientHeight || box.height) - padTop - (parseFloat(style.paddingBottom) || 0));
      child.rect = { left, top, width, height };
      try {
        const src = holder.getAttribute('src');
        if (src) {
          const url = new URL(src, location.href);
          if (url.protocol === 'http:' || url.protocol === 'https:') child.src_origin = url.origin;
        }
      } catch (_) { /* no usable src */ }
    }
    children.push(child);
  }
  return {
    ok: true,
    path,
    origin,
    viewport: { width: innerWidth, height: innerHeight },
    children
  };
}

// Geometry for a masked screenshot: grey boxes over every field, `#eN` labels on the
// latest snapshot's elements. The page is never touched; the service worker draws
// both in an OffscreenCanvas.
export function preparePageCapture(options) {
  const viewportWidth = innerWidth;
  const viewportHeight = innerHeight;
  function rectOf(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) return null;
    return rect;
  }
  function shown(el) {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  const masks = [];
  const fields = document.querySelectorAll('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  for (const el of fields) {
    if (masks.length >= 120) break;
    if (el instanceof HTMLInputElement && ['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color'].includes((el.getAttribute('type') || 'text').toLowerCase())) continue;
    if (el instanceof HTMLSelectElement) continue;
    if (el.isContentEditable && el.parentElement?.isContentEditable) continue;
    if (!shown(el)) continue;
    const rect = rectOf(el);
    if (!rect) continue;
    masks.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  const markers = [];
  const kit = globalThis.__limovaBrowserKit;
  const map = globalThis.__limovaBrowserMaps?.[String(options?.productKey || '')];
  if (kit && map && map.path === kit.pagePath()) {
    for (const [id, el] of map.elements) {
      if (markers.length >= 80) break;
      if (!el.isConnected || !shown(el)) continue;
      const rect = rectOf(el);
      if (!rect) continue;
      // A child frame's labels carry its prefix (`#fr1.e3`, TEAM-751).
      const prefix = typeof options?.labelPrefix === 'string' && /^fr\d{1,2}\.$/.test(options.labelPrefix) ? options.labelPrefix : '';
      markers.push({ id: Number(id.slice(1)), label: `#${prefix}${id}`, left: Math.max(0, rect.left), top: Math.max(0, rect.top - 14) });
    }
  }
  return { ok: true, viewportWidth, viewportHeight, masks, markers, maskedCount: masks.length, markerCount: markers.length };
}
