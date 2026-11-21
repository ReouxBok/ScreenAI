// page-snapshot.js — Functions injected in a tab to read it (TEAM-724, `browser.read_page`).
//
// Each exported function is passed to chrome.scripting.executeScript({func}) and runs in
// the extension's ISOLATED world of the tab's top frame. Chrome serialises the function
// source, so every function here is SELF-CONTAINED: it must not use anything from this
// module's scope.
//
// The page map (element ids e1, e2… -> live elements) lives in that isolated world
// (`globalThis.__limovaBrowserMaps`), which persists per document and per extension.
// It is NEVER written as attributes on the page: the page can neither read the map nor
// move an id onto another element. A new read_page replaces the map; a navigation drops
// the isolated world, so an older snapshot_id answers `stale_snapshot`.
//
// Privacy: field values are never returned. A field only reports `state` (empty, filled
// or sensitive); a select its chosen option label; a checkbox its `checked`. Text typed
// in editable areas is cut out of the page text. URLs are origin + pathname only.

export function pageSnapshot(options) {
  const KIT_VERSION = 1;

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

    function describe(el) {
      const name = nameOf(el);
      const form = formOf(el);
      const rect = el.getBoundingClientRect();
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
        rendered: isRendered(el),
        submits: submitsForm(el),
        is_form: el instanceof HTMLFormElement,
        in_form: Boolean(form),
        form: formInfo(form),
        href: safeHref(el),
        download: el.hasAttribute?.('download') || false,
        in_viewport: inViewport(rect)
      };
    }

    return {
      version: KIT_VERSION,
      clean, normalize, isRendered, isDisabled, isEditable, isSensitive, fieldState, nameOf, roleOf,
      formOf, formInfo, submitsForm, safeHref, inViewport, pagePath, describe, inputType
    };
  }

  let kit = globalThis.__limovaBrowserKit;
  if (!kit || kit.version !== KIT_VERSION) {
    kit = buildKit();
    globalThis.__limovaBrowserKit = kit;
  }

  const productKey = String(options?.productKey || '');
  const snapshotId = String(options?.snapshotId || '');
  const maxText = Math.max(500, Math.min(20000, Number(options?.maxText) || 8000));
  const maxElements = Math.max(1, Math.min(400, Number(options?.maxElements) || 200));
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
    if (!kit.isRendered(el)) continue;
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
      sensitive: item.info.sensitive
    };
    if (item.info.editable || item.info.is_select || item.info.is_checkable) entry.state = kit.fieldState(item.el);
    if (item.info.is_checkable) entry.checked = item.el.checked === true;
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
  return {
    ok: true,
    element: info,
    page: { origin: location.origin, path: location.pathname, title: kit.clean(document.title, 300) }
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
      markers.push({ id: Number(id.slice(1)), label: `#${id}`, left: Math.max(0, rect.left), top: Math.max(0, rect.top - 14) });
    }
  }
  return { ok: true, viewportWidth, viewportHeight, masks, markers, maskedCount: masks.length, markerCount: markers.length };
}
