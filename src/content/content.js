/**
 * Limova AI - Content Script
 * Handles: page context extraction, modal detection, element highlighting,
 *          and DOM context extraction.
 */

let trainingCaptureActive = false;
let assistantSessionActive = false;
let assistantInteractionCaptureActive = false;
let assistantScrollTimer = null;
let suppressAssistantScrollUntil = 0;
const VISUAL_CAPTURE_OVERLAY_ID = 'limova-visual-capture-overlays';

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== 'limova-charly-page' || event.data?.type !== 'LIMOVA_PROFILE') return;
  const profile = event.data.profile;
  if (!profile || typeof profile !== 'object') return;
  chrome.runtime.sendMessage({ type: 'LIMOVA_PROFILE', profile }).catch(() => {});
});

function clearVisualCaptureOverlays() {
  document.getElementById(VISUAL_CAPTURE_OVERLAY_ID)?.remove();
}

function prepareVisualCapture(contextVersion) {
  clearVisualCaptureOverlays();
  if (document.documentElement.dataset.limovaContextVersion !== String(contextVersion)) {
    return { ok: false, error: 'La page a changé.' };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const visibleRect = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return null;
    return rect;
  };

  const privateSelectors = [
    'input', 'textarea', 'select', '[contenteditable="true"]',
    '[data-private]', '[data-sensitive]', '[data-limova-private]',
    '[autocomplete="one-time-code"]', '[autocomplete="cc-number"]'
  ].join(',');
  const masked = new Set();
  const masks = [];
  document.querySelectorAll(privateSelectors).forEach(element => {
    if (!(element instanceof HTMLElement) || masked.has(element)) return;
    const rect = visibleRect(element);
    if (!rect) return;
    masked.add(element);
    masks.push({
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left)),
      height: Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top))
    });
  });

  const markers = [];
  document.querySelectorAll('[data-lid]').forEach(element => {
    if (!(element instanceof HTMLElement) || markers.length >= 80) return;
    const id = Number(element.dataset.lid);
    const rect = visibleRect(element);
    if (!Number.isInteger(id) || !rect) return;
    markers.push({
      id,
      left: Math.max(2, Math.min(viewportWidth - 34, rect.left + 2)),
      top: Math.max(2, Math.min(viewportHeight - 20, rect.top + 2))
    });
  });

  // Only geometry leaves the page. Rendering happens on an OffscreenCanvas in
  // the service worker, so the user never sees masks, markers or a flash.
  return {
    ok: true,
    viewportWidth,
    viewportHeight,
    masks,
    markers,
    maskedCount: masks.length,
    markerCount: markers.length
  };
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'DIAGNOSTIC_PING') {
    sendResponse({
      ok: true,
      documentReadyState: document.readyState,
      modalObserverActive: Boolean(modalObserver),
      path: window.location.pathname
    });
  }

  if (request.type === 'GET_PAGE_CONTEXT') {
    sendResponse({
      title: document.title,
      url: `${window.location.origin}${window.location.pathname}`,
      hasErrors: checkForErrors()
    });
  }

  if (request.type === 'PREPARE_VISUAL_CAPTURE') {
    sendResponse(prepareVisualCapture(request.contextVersion));
  }

  if (request.type === 'CLEAR_VISUAL_CAPTURE') {
    clearVisualCaptureOverlays();
    sendResponse({ ok: true });
  }

  if (request.type === 'SESSION_STATE') {
    assistantSessionActive = request.active === true;
    refreshModalObserver();
    refreshAssistantInteractionCapture();
  }

  if (request.type === 'TRAINING_STATE') {
    setTrainingCapture(request.active === true);
    refreshModalObserver();
    sendResponse({ ok: true });
  }

  if (request.type === 'HIGHLIGHT_ELEMENT') {
    sendResponse(highlightElementById(request.id, request.contextVersion));
  }

  if (request.type === 'EXECUTE_ELEMENT_ACTION') {
    executeElementActionWithCursor(request.id, request.contextVersion)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'Le clic automatique a échoué.' }));
    return true;
  }

  if (request.type === 'TYPE_ELEMENT_TEXT') {
    executeElementTextInputWithCursor(request.id, request.contextVersion, request.text)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'La saisie automatique a échoué.' }));
    return true;
  }

  if (request.type === 'EXECUTE_PAGE_SCROLL') {
    executePageScroll(request)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'Le défilement automatique a échoué.' }));
    return true;
  }

  if (request.type === 'GET_PAGE_CONTENT') {
    const data = extractPageContent();
    sendResponse(data);
  }

});

// ============================================================================
// Page Content Extraction
// ============================================================================

function extractPageContent() {
  const selectors = 'h1,h2,h3,h4,nav a,button,[role="tab"],[role="menuitem"],label,.sidebar a,.sidebar span,th,td,[class*="title"],[class*="header"] span,[class*="menu"] a,[class*="nav"] a';
  const surface = getActiveModalSurface() || document;
  const elements = surface.querySelectorAll(selectors);
  const texts = new Set();
  elements.forEach(el => {
    const t = el.textContent.trim();
    if (t && t.length > 1 && t.length < 200) texts.add(t);
  });

  const activeEls = surface.querySelectorAll('[aria-selected="true"],[aria-current="page"],.active,.selected,[class*="active"]');
  const activeTexts = [];
  activeEls.forEach(el => {
    const t = el.textContent.trim();
    if (t && t.length < 200) activeTexts.push(t);
  });

  return {
    title: document.title || '',
    visibleElements: [...texts].slice(0, 60),
    activeElements: activeTexts.slice(0, 10)
  };
}

// ============================================================================
// Error Detection
// ============================================================================

function checkForErrors() {
  const errorSelectors = ['.error', '.alert-danger', '.alert-error', '[role="alert"]', '.notification-error'];
  const surface = getActiveModalSurface() || document;
  for (const selector of errorSelectors) {
    if (surface.querySelectorAll(selector).length > 0) return true;
  }
  return false;
}

// ============================================================================
// Modal / Popup Detection
// ============================================================================

let modalObserver = null;
let lastModalNotify = 0;
const MODAL_COOLDOWN = 5000;

const MODAL_SELECTORS = ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]'];
const MODAL_CLASS_PATTERNS = /(modal|dialog|overlay|popup|lightbox|drawer)/i;

function isVisiblyRendered(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && rect.width > 0
    && rect.height > 0
    && rect.right > 0
    && rect.bottom > 0
    && rect.left < window.innerWidth
    && rect.top < window.innerHeight;
}

function isLikelyModal(element) {
  if (!(element instanceof HTMLElement)) return false;

  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (element.getAttribute('aria-modal') === 'true') return true;
  if (element.tagName === 'DIALOG' && element.hasAttribute('open')) return true;

  if (MODAL_CLASS_PATTERNS.test(String(element.className || ''))) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) return true;
  }

  const style = window.getComputedStyle(element);
  if (style.position === 'fixed' && (Number.parseInt(style.zIndex, 10) || 0) >= 10) {
    const rect = element.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;
    const elementArea = rect.width * rect.height;
    const coversViewportCenter = rect.left <= window.innerWidth / 2
      && rect.right >= window.innerWidth / 2
      && rect.top <= window.innerHeight / 2
      && rect.bottom >= window.innerHeight / 2;
    if (coversViewportCenter && elementArea / viewportArea > 0.12) return true;
  }

  return false;
}

function getActiveModalSurface() {
  if (!document.body) return null;
  const signaled = document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], ' +
    '[class*="modal" i], [class*="dialog" i], [class*="overlay" i], [class*="popup" i], ' +
    '[class*="lightbox" i], [class*="drawer" i], [data-radix-portal] > *, [data-headlessui-portal] > *'
  );
  const shallow = [...document.body.children].flatMap(element => [element, ...element.children]);
  const candidates = [...new Set([...signaled, ...shallow])]
    .filter(element => isLikelyModal(element) && isVisiblyRendered(element));
  if (!candidates.length) return null;

  const score = element => {
    const rect = element.getBoundingClientRect();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const role = element.getAttribute('role');
    const semantic = role === 'dialog' || role === 'alertdialog' || element.getAttribute('aria-modal') === 'true' || element.tagName === 'DIALOG';
    const className = String(element.className || '');
    const modalClass = /(modal|dialog|popup|lightbox|drawer)/i.test(className);
    const zIndex = Number.parseInt(window.getComputedStyle(element).zIndex, 10) || 0;
    let depth = 0;
    for (let current = element; current && current !== document.body; current = current.parentElement) depth += 1;
    return (semantic ? 100000 : 0)
      + (modalClass ? 10000 : 0)
      + zIndex * 10
      + depth
      - (rect.width * rect.height / viewportArea) * 100;
  };
  return candidates.sort((left, right) => score(right) - score(left))[0];
}

function isElementOnActiveSurface(element, { allowOffscreen = false } = {}) {
  if (!(element instanceof HTMLElement)) return false;
  const surface = getActiveModalSurface();
  if (surface && !surface.contains(element)) return false;
  if (typeof document.elementFromPoint !== 'function') return true;
  const rect = element.getBoundingClientRect();
  const outsideViewport = rect.right <= 0
    || rect.bottom <= 0
    || rect.left >= window.innerWidth
    || rect.top >= window.innerHeight;
  // An action may legitimately target an element outside the viewport. Allow
  // only the pre-scroll lookup; the same target is checked again for real
  // occlusion after scrollIntoView has brought it onscreen.
  if (outsideViewport) return allowOffscreen;
  const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
  const topmost = document.elementFromPoint(x, y);
  return !topmost || topmost === element || element.contains(topmost);
}

function checkForModals(mutations) {
  const now = Date.now();
  if (now - lastModalNotify < MODAL_COOLDOWN) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (isLikelyModal(node)) { notifyModalDetected(node); return; }
      if (node instanceof HTMLElement) {
        for (const selector of MODAL_SELECTORS) {
          const modal = node.querySelector(selector);
          if (modal) { notifyModalDetected(modal); return; }
        }
        for (const child of node.querySelectorAll('*')) {
          if (MODAL_CLASS_PATTERNS.test(child.className)) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 100) { notifyModalDetected(child); return; }
          }
        }
      }
    }
  }
}

function describeModal(modal) {
  if (!(modal instanceof HTMLElement)) return {};
  const heading = modal.querySelector('h1,h2,h3,[role="heading"]');
  const controls = [...modal.querySelectorAll('button,a[href],[role="button"],[role="tab"]')]
    .map(control => String(control.getAttribute('aria-label') || control.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 20);
  return {
    title: String(heading?.textContent || modal.getAttribute('aria-label') || 'Fenêtre Limova').replace(/\s+/g, ' ').trim().slice(0, 180),
    role: modal.getAttribute('role') || (modal.tagName === 'DIALOG' ? 'dialog' : 'popup'),
    controls
  };
}

function notifyModalDetected(modal) {
  lastModalNotify = Date.now();
  chrome.runtime.sendMessage({ type: 'MODAL_DETECTED', modal: describeModal(modal) }).catch(() => {});
}

function refreshModalObserver() {
  if (assistantSessionActive || trainingCaptureActive) startModalObserver();
  else stopModalObserver();
}

function startModalObserver() {
  if (modalObserver) return;
  modalObserver = new MutationObserver(checkForModals);
  modalObserver.observe(document.body, { childList: true, subtree: true });
}

function stopModalObserver() {
  if (modalObserver) {
    modalObserver.disconnect();
    modalObserver = null;
  }
}

// ============================================================================
// Element Highlighting (Visual Guidance)
// ============================================================================

let activeHighlights = [];

function clearHighlights() {
  activeHighlights.forEach(el => el.remove());
  activeHighlights = [];
}

function resolveHighlightTarget(element) {
  if (!(element instanceof HTMLElement)) return null;
  const exactControl = element.closest(
    'input, textarea, select, button, a[href], [contenteditable="true"], ' +
    '[role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="switch"], [tabindex="0"]'
  );
  return exactControl || element;
}

function highlightElementById(id, contextVersion) {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Identifiant invalide.' };
  if (document.documentElement.dataset.limovaContextVersion !== String(contextVersion)) {
    return { ok: false, error: 'La page a changé.' };
  }
  const target = resolveHighlightTarget(getElementByLid(id));
  if (!target) return { ok: false, error: 'Élément introuvable.' };
  if (!isElementOnActiveSurface(target)) return { ok: false, error: 'Une fenêtre au premier plan bloque cet élément.' };
  return highlightElement(target) ? { ok: true } : { ok: false, error: 'Élément non visible.' };
}

function highlightElement(domElement) {
  clearHighlights();
  const rect = domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const overlay = document.createElement('div');
  overlay.className = 'limova-element-highlight';
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top - 3}px;
    left: ${rect.left - 3}px;
    width: ${rect.width + 6}px;
    height: ${rect.height + 6}px;
    border: 2px solid #f59e0b;
    border-radius: 10px;
    background: rgba(245,158,11,0.035);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.16), 0 5px 18px rgba(120,53,15,0.12);
    z-index: 2147483645;
    pointer-events: none;
    animation: limova-highlight-attention 1.1s ease-in-out 2;
  `;

  // Add animation keyframes if not already present
  if (!document.getElementById('limova-highlight-styles')) {
    const style = document.createElement('style');
    style.id = 'limova-highlight-styles';
    style.textContent = `
      @keyframes limova-highlight-attention {
        0%, 100% { box-shadow: 0 0 0 3px rgba(245,158,11,0.16), 0 5px 18px rgba(120,53,15,0.12); }
        50% { box-shadow: 0 0 0 6px rgba(245,158,11,0.10), 0 7px 24px rgba(120,53,15,0.16); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);
  activeHighlights.push(overlay);

  suppressAssistantScrollUntil = Date.now() + 1_000;
  domElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Clear highlight on user click anywhere
  const clickHandler = () => {
    document.removeEventListener('click', clickHandler, true);
    fadeOutHighlight(overlay);
  };
  document.addEventListener('click', clickHandler, true);

  // Auto-clear after 3s
  setTimeout(() => {
    document.removeEventListener('click', clickHandler, true);
    fadeOutHighlight(overlay);
  }, 3000);
  return true;
}

function fadeOutHighlight(overlay) {
  if (!overlay.parentElement) return;
  overlay.style.transition = 'opacity 0.3s';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.remove(); activeHighlights = activeHighlights.filter(h => h !== overlay); }, 300);
}

// ============================================================================
// Container Detection (walk up DOM to find the visual card/button container)
// ============================================================================

function findClickableContainer(el) {
  const containerSelectors = 'a, button, [role="button"], [role="menuitem"], [role="tab"], [class*="card"], [class*="item"], [class*="tile"], li';
  let current = el;
  let best = el;

  while (current && current !== document.body) {
    // If this ancestor matches a container pattern and is reasonably sized, prefer it
    if (current.matches && current.matches(containerSelectors)) {
      const rect = current.getBoundingClientRect();
      // Don't go too big (avoid wrapping entire sections)
      if (rect.width < window.innerWidth * 0.8 && rect.height < window.innerHeight * 0.6) {
        best = current;
      }
    }
    // Also check for click handlers or cursor pointer
    if (current.onclick || current.style?.cursor === 'pointer') {
      const rect = current.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.8 && rect.height < window.innerHeight * 0.6) {
        best = current;
      }
    }
    current = current.parentElement;
  }

  return best;
}

// ============================================================================
// Element Lookup (ID-based via data-lid attribute)
// ============================================================================

function getElementByLid(id) {
  return document.querySelector(`[data-lid="${id}"]`);
}

function resolveElementAction(id, contextVersion, options = {}) {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Identifiant invalide.' };
  if (document.documentElement.dataset.limovaContextVersion !== String(contextVersion)) {
    return { ok: false, error: 'La page a changé.' };
  }

  const element = getElementByLid(id);
  if (!(element instanceof HTMLElement)) return { ok: false, error: 'Élément introuvable.' };
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const disabled = element.matches(':disabled, [aria-disabled="true"]');
  const actionable = element.matches(
    'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="link"], ' +
    'input[type="submit"], input[type="button"], [tabindex="0"], [class*="btn"], ' +
    '[onclick], [class*="cursor-pointer"], [class*="clickable"]'
  );
  if (!actionable || disabled || style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) {
    return { ok: false, error: 'Élément non disponible.' };
  }
  if (!isElementOnActiveSurface(element, options)) {
    return { ok: false, status: 'unexpected', error: 'Une fenêtre au premier plan bloque cet élément.' };
  }

  return { ok: true, element };
}

function executeElementAction(id, contextVersion) {
  const resolved = resolveElementAction(id, contextVersion);
  if (!resolved.ok) return resolved;
  resolved.element.click();
  return { ok: true };
}

function resolveTextInput(id, contextVersion, options = {}) {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Identifiant invalide.' };
  if (document.documentElement.dataset.limovaContextVersion !== String(contextVersion)) {
    return { ok: false, error: 'La page a changé.' };
  }

  const element = getElementByLid(id);
  if (!(element instanceof HTMLElement)) return { ok: false, error: 'Champ introuvable.' };
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const supported = element.matches(
    'textarea, [contenteditable="true"], ' +
    'input:not([type="password"]):not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])'
  );
  const sensitiveDescriptor = `${element.getAttribute('type') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('autocomplete') || ''} ${element.getAttribute('aria-label') || ''}`;
  const sensitive = /password|passcode|secret|token|api.?key|credit|card|payment|iban|cvv/i.test(sensitiveDescriptor);
  if (!supported || sensitive || element.matches(':disabled, [aria-disabled="true"], [readonly]')
    || style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) {
    return { ok: false, error: sensitive ? 'Champ sensible interdit.' : 'Champ non disponible.' };
  }
  if (!isElementOnActiveSurface(element, options)) {
    return { ok: false, status: 'unexpected', error: 'Une fenêtre au premier plan bloque ce champ.' };
  }
  return { ok: true, element };
}

function setElementText(id, contextVersion, rawText) {
  const resolved = resolveTextInput(id, contextVersion);
  if (!resolved.ok) return resolved;
  const text = String(rawText || '').trim();
  if (!text) return { ok: false, clarificationRequired: true, error: 'Texte manquant.' };
  const element = resolved.element;
  if (Number.isInteger(element.maxLength) && element.maxLength >= 0 && text.length > element.maxLength) {
    return { ok: false, clarificationRequired: true, error: `Le texte dépasse la limite de ${element.maxLength} caractères.` };
  }

  element.focus();
  if (element instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, text);
  } else if (element instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, text);
  } else {
    element.textContent = text;
  }
  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    : new Event('input', { bubbles: true });
  element.dispatchEvent(inputEvent);
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

function waitForPointerFrame() {
  const nextFrame = window.requestAnimationFrame || (callback => setTimeout(callback, 16));
  return new Promise(resolve => nextFrame(() => nextFrame(resolve)));
}

function waitForPointerDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function dispatchCompletePointerClick(element, clientX, clientY) {
  if (!(element instanceof HTMLElement)) return { ok: false, error: 'Cible de clic invalide.' };
  const pointTarget = document.elementFromPoint?.(clientX, clientY);
  const eventTarget = pointTarget instanceof HTMLElement && element.contains(pointTarget)
    ? pointTarget
    : element;
  const shared = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    detail: 1
  };
  const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  const pointer = type => eventTarget.dispatchEvent(new PointerCtor(type, {
    ...shared,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  }));
  const mouse = (type, overrides = {}) => eventTarget.dispatchEvent(new MouseEvent(type, {
    ...shared,
    ...overrides
  }));

  // Several Limova controls (Radix/headless components and clickable divs)
  // listen on pointerdown/mousedown rather than on click alone. Reproduce the
  // browser event order, then issue one native HTMLElement.click() so React's
  // delegated onClick handler still receives exactly one click event.
  pointer('pointerover');
  pointer('pointerenter');
  mouse('mouseover');
  mouse('mouseenter');
  pointer('pointerdown');
  mouse('mousedown');
  try { eventTarget.focus({ preventScroll: true }); } catch (_) { eventTarget.focus?.(); }
  pointer('pointerup');
  mouse('mouseup', { buttons: 0 });
  eventTarget.click();

  return {
    ok: true,
    retargetedToChild: eventTarget !== element,
    targetTag: eventTarget.tagName.toLowerCase(),
    sequence: 'pointer-mouse-click'
  };
}

function ensurePointerStyles() {
  if (document.getElementById('limova-computer-use-styles')) return;
  const style = document.createElement('style');
  style.id = 'limova-computer-use-styles';
  style.textContent = `
    #limova-computer-use-pointer {
      position: fixed;
      left: 0;
      top: 0;
      width: 34px;
      height: 34px;
      z-index: 2147483647;
      pointer-events: none;
      filter: drop-shadow(0 3px 4px rgba(0, 0, 0, .35));
      transition: transform 600ms cubic-bezier(.22,.8,.25,1), opacity 180ms ease;
    }
    #limova-computer-use-pointer svg { display: block; width: 30px; height: 30px; }
    .limova-computer-use-ripple {
      position: fixed;
      width: 18px;
      height: 18px;
      margin: -9px 0 0 -9px;
      z-index: 2147483646;
      pointer-events: none;
      border: 3px solid #7c3aed;
      border-radius: 999px;
      animation: limova-computer-use-click 420ms ease-out forwards;
    }
    @keyframes limova-computer-use-click {
      from { transform: scale(.35); opacity: 1; }
      to { transform: scale(2.2); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

async function executeElementActionWithCursor(id, contextVersion) {
  let resolved = resolveElementAction(id, contextVersion, { allowOffscreen: true });
  if (!resolved.ok) return resolved;
  const target = resolved.element;
  suppressAssistantScrollUntil = Date.now() + 1_000;
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  await waitForPointerDelay(220);

  resolved = resolveElementAction(id, contextVersion);
  if (!resolved.ok) return resolved;
  const rect = resolved.element.getBoundingClientRect();
  const targetX = Math.round(rect.left + rect.width / 2 - 4);
  const targetY = Math.round(rect.top + rect.height / 2 - 3);
  const startX = Math.max(12, window.innerWidth - 48);
  const startY = Math.max(12, window.innerHeight - 48);

  ensurePointerStyles();
  document.getElementById('limova-computer-use-pointer')?.remove();
  const pointer = document.createElement('div');
  pointer.id = 'limova-computer-use-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.5v22.8l6.5-6.2 4.2 8.4 4.1-2-4.1-8.1 8.8-.9L5 3.5Z" fill="#fff" stroke="#18181b" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  pointer.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
  document.body.appendChild(pointer);
  await waitForPointerFrame();
  pointer.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
  await waitForPointerDelay(650);

  resolved = resolveElementAction(id, contextVersion);
  if (!resolved.ok) {
    pointer.remove();
    return resolved;
  }
  const clickRect = resolved.element.getBoundingClientRect();
  const ripple = document.createElement('div');
  ripple.className = 'limova-computer-use-ripple';
  ripple.style.left = `${Math.round(clickRect.left + clickRect.width / 2)}px`;
  ripple.style.top = `${Math.round(clickRect.top + clickRect.height / 2)}px`;
  document.body.appendChild(ripple);
  const click = dispatchCompletePointerClick(
    resolved.element,
    Math.round(clickRect.left + clickRect.width / 2),
    Math.round(clickRect.top + clickRect.height / 2)
  );
  if (!click.ok) {
    pointer.remove();
    ripple.remove();
    return click;
  }
  pointer.style.opacity = '0';
  setTimeout(() => pointer.remove(), 200);
  setTimeout(() => ripple.remove(), 450);
  return {
    ok: true,
    visualized: true,
    clickDispatched: true,
    interactionMode: click.sequence,
    retargetedToChild: click.retargetedToChild,
    targetTag: click.targetTag
  };
}

async function executeElementTextInputWithCursor(id, contextVersion, text) {
  let resolved = resolveTextInput(id, contextVersion, { allowOffscreen: true });
  if (!resolved.ok) return resolved;
  suppressAssistantScrollUntil = Date.now() + 1_000;
  resolved.element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  await waitForPointerDelay(220);

  resolved = resolveTextInput(id, contextVersion);
  if (!resolved.ok) return resolved;
  const rect = resolved.element.getBoundingClientRect();
  const targetX = Math.round(rect.left + Math.min(rect.width / 2, 30));
  const targetY = Math.round(rect.top + rect.height / 2 - 3);
  const startX = Math.max(12, window.innerWidth - 48);
  const startY = Math.max(12, window.innerHeight - 48);

  ensurePointerStyles();
  document.getElementById('limova-computer-use-pointer')?.remove();
  const pointer = document.createElement('div');
  pointer.id = 'limova-computer-use-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.5v22.8l6.5-6.2 4.2 8.4 4.1-2-4.1-8.1 8.8-.9L5 3.5Z" fill="#fff" stroke="#18181b" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  pointer.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
  document.body.appendChild(pointer);
  await waitForPointerFrame();
  pointer.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
  await waitForPointerDelay(650);

  const result = setElementText(id, contextVersion, text);
  if (!result.ok) {
    pointer.remove();
    return result;
  }
  const inputRect = getElementByLid(id).getBoundingClientRect();
  const ripple = document.createElement('div');
  ripple.className = 'limova-computer-use-ripple';
  ripple.style.left = `${Math.round(inputRect.left + Math.min(inputRect.width / 2, 30))}px`;
  ripple.style.top = `${Math.round(inputRect.top + inputRect.height / 2)}px`;
  document.body.appendChild(ripple);
  pointer.style.opacity = '0';
  setTimeout(() => pointer.remove(), 200);
  setTimeout(() => ripple.remove(), 450);
  await waitForPointerDelay(80);
  const verified = resolveTextInput(id, contextVersion);
  if (!verified.ok) return verified;
  const currentText = verified.element instanceof HTMLInputElement || verified.element instanceof HTMLTextAreaElement
    ? verified.element.value
    : verified.element.textContent;
  if (String(currentText || '').trim() !== String(text || '').trim()) {
    return { ok: false, error: 'La page a annulé la saisie.' };
  }
  return { ok: true, visualized: true, inputVerified: true };
}

function scrollableAncestor(element) {
  let current = element instanceof HTMLElement ? element : null;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY)
      && current.scrollHeight > current.clientHeight + 8) return current;
    current = current.parentElement;
  }
  return null;
}

function primaryScrollContainer() {
  const surface = getActiveModalSurface() || document;
  const candidates = [...surface.querySelectorAll('main,[role="main"],[class*="content"],[class*="scroll"],section,div')]
    .filter(element => element instanceof HTMLElement)
    .filter(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return /(auto|scroll|overlay)/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 8
        && rect.width > 120 && rect.height > 120;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
  if (candidates[0]) return candidates[0];
  if (surface instanceof HTMLElement) return surface;
  return document.scrollingElement || document.documentElement;
}

async function executePageScroll(request = {}) {
  const direction = ['up', 'down', 'top', 'bottom'].includes(request.direction) ? request.direction : '';
  const amount = ['small', 'medium', 'large'].includes(request.amount) ? request.amount : 'medium';
  const contextVersion = Number(request.contextVersion);
  if (!direction) return { ok: false, error: 'Direction de défilement invalide.' };
  if (Number.isInteger(contextVersion)
    && document.documentElement.dataset.limovaContextVersion !== String(contextVersion)) {
    return { ok: false, status: 'unexpected', error: 'La page a changé.' };
  }

  const targetElement = Number.isInteger(request.elementId) ? getElementByLid(request.elementId) : null;
  const container = scrollableAncestor(targetElement) || primaryScrollContainer();
  if (!(container instanceof HTMLElement)) return { ok: false, error: 'Aucune zone défilable trouvée.' };

  const before = Number(container.scrollTop || 0);
  const maximum = Math.max(0, Number(container.scrollHeight || 0) - Number(container.clientHeight || 0));
  const viewport = Math.max(120, Number(container.clientHeight || window.innerHeight || 600));
  const factor = amount === 'small' ? 0.3 : amount === 'large' ? 0.9 : 0.62;
  const target = direction === 'top'
    ? 0
    : direction === 'bottom'
      ? maximum
      : Math.max(0, Math.min(maximum, before + (direction === 'down' ? 1 : -1) * viewport * factor));

  suppressAssistantScrollUntil = Date.now() + 1_000;
  if (typeof container.scrollTo === 'function') container.scrollTo({ top: target, behavior: 'smooth' });
  else container.scrollTop = target;
  await waitForPointerDelay(420);
  const after = Number(container.scrollTop || 0);
  return {
    ok: Math.abs(after - before) >= 1 || (direction === 'top' && before === 0) || (direction === 'bottom' && before === maximum),
    moved: Math.abs(after - before) >= 1,
    atStart: after <= 1,
    atEnd: maximum <= 1 || after >= maximum - 1
  };
}

// Fallback: text-based search (for HIGHLIGHT_ELEMENT without ID)
function findElementByText(searchText) {
  const lower = searchText.toLowerCase();
  const surface = getActiveModalSurface() || document;
  const candidates = surface.querySelectorAll('button, a, [role="button"], [role="menuitem"], nav a, .sidebar a, input[type="submit"], h1, h2, h3, h4, label, span, p');
  let bestMatch = null;
  let bestScore = 0;

  candidates.forEach(el => {
    const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().toLowerCase();
    if (!text || text.length > 100 || text.length < 2) return;
    if (text === lower && text.length >= bestScore) {
      bestMatch = el;
      bestScore = text.length + 1000;
    } else if (lower.includes(text) && text.length > bestScore) {
      bestMatch = el;
      bestScore = text.length;
    }
  });

  return bestMatch;
}

// ============================================================================
// Auto-start: check if session is active
// ============================================================================

chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }).then(response => {
  assistantSessionActive = response?.active === true;
  setTrainingCapture(response?.training === true);
  refreshModalObserver();
  refreshAssistantInteractionCapture();
}).catch(() => {});

function trainingLabel(element) {
  if (!(element instanceof HTMLElement)) return '';
  const labelled = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder');
  const label = element.id ? [...document.querySelectorAll('label[for]')].find(node => node.htmlFor === element.id)?.textContent : '';
  return trainingSafeText(label || labelled || element.textContent || element.getAttribute('name') || element.tagName, 240);
}

function trainingSafeText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d(?:[ .()-]?\d){7,}/g, '[phone]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function trainingPath() {
  return `${location.origin}${location.pathname}`;
}

function resolveTrainingClickTarget(origin) {
  if (!(origin instanceof Element)) return null;
  const semantic = origin.closest(
    'button,a[href],input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],' +
    '[role="button"],[role="tab"],[role="menuitem"],[role="link"],[role="option"],[role="switch"],' +
    '[onclick],[tabindex]:not([tabindex="-1"])'
  );
  if (semantic instanceof HTMLElement) return semantic;

  // Some Limova cards are React click targets without a semantic role. Limit
  // this fallback to the nearest visible ancestor that explicitly uses the
  // pointer cursor so a click on ordinary page text is never recorded as a button.
  let candidate = origin instanceof HTMLElement ? origin : origin.parentElement;
  let pointerTarget = null;
  for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
    if (candidate === document.body) break;
    if (window.getComputedStyle(candidate).cursor === 'pointer') pointerTarget = candidate;
    else if (pointerTarget) break;
  }
  return pointerTarget;
}

function trainingControlType(target) {
  if (target instanceof HTMLButtonElement) return 'bouton';
  if (target instanceof HTMLAnchorElement) return 'lien';
  if (target instanceof HTMLInputElement) return target.type || 'champ';
  return target.getAttribute('role') || 'contrôle cliquable';
}

function safeElementIdentifier(value) {
  const identifier = String(value || '').trim();
  return /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(identifier) ? identifier : '';
}

function trainingZone(target) {
  if (target.closest('[role="dialog"],[aria-modal="true"],dialog,[class*="modal"]')) return 'modal';
  if (target.closest('nav,[role="navigation"],[class*="sidebar"],[class*="nav"]')) return 'nav';
  if (target.closest('header,[class*="header"],[class*="topbar"]')) return 'header';
  if (target.closest('form,[class*="form"]')) return 'form';
  if (target.closest('footer')) return 'footer';
  return 'main';
}

function trainingSection(target) {
  const scope = target.closest('article,[role="listitem"],li,tr,section,fieldset,[class*="card"],[class*="panel"],[class*="group"]');
  if (!scope) return '';
  const heading = scope.querySelector('h1,h2,h3,h4,legend,[data-title],[class*="title"]');
  return heading && heading !== target ? trainingSafeText(heading.textContent, 160) : '';
}

function trainingOccurrence(target, controlName) {
  const candidates = [...document.querySelectorAll(
    'button,a[href],input[type="button"],input[type="submit"],[role="button"],[role="tab"],[role="menuitem"],[role="link"],[role="option"],[role="switch"],[onclick],[tabindex]:not([tabindex="-1"])'
  )].filter(candidate => trainingLabel(candidate) === controlName && trainingControlType(candidate) === trainingControlType(target));
  const index = candidates.indexOf(target);
  return index >= 0 ? index + 1 : 1;
}

function captureTrainingClick(event) {
  // Only learn from a real trainer gesture. Programmatic clicks produced by
  // Charly or the application must never become demonstration steps.
  if (!trainingCaptureActive || !event.isTrusted || !(event.target instanceof Element)) return;
  const target = resolveTrainingClickTarget(event.target);
  if (!target) return;
  const controlName = trainingLabel(target);
  const gestureId = crypto.randomUUID?.() || `gesture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  chrome.runtime.sendMessage({
    type: 'TRAINING_EVENT',
    event: {
      kind: 'click',
      path: trainingPath(),
      label: controlName || `Contrôle ${trainingControlType(target)}`,
      payload: {
        controlName,
        controlType: trainingControlType(target),
        tag: target.tagName.toLowerCase(),
        role: target.getAttribute('role') || '',
        elementId: safeElementIdentifier(target.id),
        testId: safeElementIdentifier(target.getAttribute('data-testid')),
        hrefPath: target instanceof HTMLAnchorElement ? target.pathname : '',
        ariaLabel: trainingSafeText(target.getAttribute('aria-label'), 160),
        title: trainingSafeText(target.getAttribute('title'), 160),
        zone: trainingZone(target),
        section: trainingSection(target),
        occurrence: trainingOccurrence(target, controlName),
        gestureId,
        capturedAt: Date.now(),
        clickedTag: event.target.tagName.toLowerCase(),
        source: 'trainer',
        trusted: true
      }
    }
  }).catch(() => {});
}

function captureTrainingInput(event) {
  if (!trainingCaptureActive || !(event.target instanceof HTMLElement)) return;
  const target = event.target.closest('input,textarea,select,[contenteditable="true"]');
  if (!target || target.matches('input[type="password"],input[type="hidden"],input[type="file"]')) return;
  const descriptor = `${target.getAttribute('name') || ''} ${target.getAttribute('autocomplete') || ''} ${trainingLabel(target)}`;
  if (/password|secret|token|api.?key|credit|card|iban|cvv/i.test(descriptor)) return;
  chrome.runtime.sendMessage({ type: 'TRAINING_EVENT', event: { kind: 'input', path: trainingPath(), label: trainingLabel(target), payload: {
    tag: target.tagName.toLowerCase(),
    inputType: target.getAttribute('type') || target.tagName.toLowerCase(),
    role: target.getAttribute('role') || '',
    elementId: safeElementIdentifier(target.id),
    testId: safeElementIdentifier(target.getAttribute('data-testid')),
    ariaLabel: trainingSafeText(target.getAttribute('aria-label'), 160),
    title: trainingSafeText(target.getAttribute('title'), 160),
    zone: trainingZone(target),
    section: trainingSection(target),
    filled: true
  } } }).catch(() => {});
}

function setTrainingCapture(active) {
  if (trainingCaptureActive === active) return;
  trainingCaptureActive = active;
  document[active ? 'addEventListener' : 'removeEventListener']('click', captureTrainingClick, true);
  document[active ? 'addEventListener' : 'removeEventListener']('change', captureTrainingInput, true);
  refreshAssistantInteractionCapture();
}

function assistantInteractionPayload(kind, target = null) {
  const control = target instanceof Element ? resolveTrainingClickTarget(target) || target.closest('input,textarea,select,[contenteditable="true"]') : null;
  return {
    kind,
    path: trainingPath(),
    contextVersion: Number(document.documentElement.dataset.limovaContextVersion || 0),
    label: control instanceof HTMLElement ? trainingLabel(control) : '',
    controlType: control instanceof HTMLElement ? trainingControlType(control) : '',
    zone: control instanceof HTMLElement ? trainingZone(control) : '',
    filled: kind === 'input' ? true : undefined
  };
}

function captureAssistantClick(event) {
  if (!assistantSessionActive || trainingCaptureActive || !event.isTrusted || !(event.target instanceof Element)) return;
  const target = resolveTrainingClickTarget(event.target);
  if (!target) return;
  chrome.runtime.sendMessage({
    type: 'USER_PAGE_INTERACTION',
    interaction: assistantInteractionPayload('click', target)
  }).catch(() => {});
}

function captureAssistantInput(event) {
  if (!assistantSessionActive || trainingCaptureActive || !event.isTrusted || !(event.target instanceof Element)) return;
  const target = event.target.closest('input,textarea,select,[contenteditable="true"]');
  if (!target || target.matches('input[type="password"],input[type="hidden"],input[type="file"]')) return;
  chrome.runtime.sendMessage({
    type: 'USER_PAGE_INTERACTION',
    interaction: assistantInteractionPayload('input', target)
  }).catch(() => {});
}

function captureAssistantScroll(event) {
  if (!assistantSessionActive || trainingCaptureActive || Date.now() < suppressAssistantScrollUntil) return;
  if (event?.isTrusted === false) return;
  clearTimeout(assistantScrollTimer);
  assistantScrollTimer = setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'USER_PAGE_INTERACTION',
      interaction: assistantInteractionPayload('scroll')
    }).catch(() => {});
  }, 180);
}

function refreshAssistantInteractionCapture() {
  const active = assistantSessionActive && !trainingCaptureActive;
  if (assistantInteractionCaptureActive === active) return;
  assistantInteractionCaptureActive = active;
  document[active ? 'addEventListener' : 'removeEventListener']('click', captureAssistantClick, true);
  document[active ? 'addEventListener' : 'removeEventListener']('input', captureAssistantInput, true);
  window[active ? 'addEventListener' : 'removeEventListener']('scroll', captureAssistantScroll, true);
  if (!active) {
    clearTimeout(assistantScrollTimer);
    assistantScrollTimer = null;
  }
}
