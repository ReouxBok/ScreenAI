// Studio-only page capture. Deep Agent browser actions use browser-document.js.
let evaluationObservationRun = null;
let evaluationObservationEnabled = false;
let evaluationObservationPending = null;
let trainingCaptureActive = false;
let trainingModalObserver = null;
let lastTrainingModalAt = 0;
const MODAL_SELECTORS = ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]'];

function isLikelyModal(element) {
  if (!(element instanceof HTMLElement)) return false;
  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog' || element.getAttribute('aria-modal') === 'true') return true;
  if (element.tagName === 'DIALOG' && element.hasAttribute('open')) return true;
  if (!/(modal|dialog|overlay|popup|lightbox|drawer)/i.test(String(element.className || ''))) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 100 && rect.height > 100;
}

function describeModal(modal) {
  const heading = modal.querySelector('h1,h2,h3,[role="heading"]');
  const controls = [...modal.querySelectorAll('button,a[href],[role="button"],[role="tab"]')]
    .map(control => trainingSafeText(control.getAttribute('aria-label') || control.textContent, 120)).filter(Boolean).slice(0, 20);
  return {
    title: trainingSafeText(heading?.textContent || modal.getAttribute('aria-label') || 'Fenêtre Limova', 180),
    role: modal.getAttribute('role') || (modal.tagName === 'DIALOG' ? 'dialog' : 'popup'), controls,
  };
}

function notifyTrainingModal(modal) {
  if (!trainingCaptureActive || Date.now() - lastTrainingModalAt < 5_000) return;
  lastTrainingModalAt = Date.now();
  chrome.runtime.sendMessage({ type: 'MODAL_DETECTED', modal: describeModal(modal) }).catch(() => {});
}

function checkForTrainingModals(mutations) {
  for (const mutation of mutations) for (const node of mutation.addedNodes) {
    if (isLikelyModal(node)) { notifyTrainingModal(node); return; }
    if (!(node instanceof HTMLElement)) continue;
    const modal = MODAL_SELECTORS.map(selector => node.querySelector(selector)).find(Boolean)
      || [...node.querySelectorAll('*')].find(isLikelyModal);
    if (modal) { notifyTrainingModal(modal); return; }
  }
}

function setEvaluationObservation(runId) {
  evaluationObservationEnabled = Boolean(runId);
  if (evaluationObservationRun === runId) return;
  evaluationObservationRun = runId;
  evaluationObservationPending = null;
}

function captureEvaluationIntervention(event) {
  if (!evaluationObservationEnabled || !evaluationObservationRun || evaluationObservationPending || !event.isTrusted) return;
  if (event.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(event.key)) return;
  evaluationObservationPending = chrome.runtime.sendMessage({
    type: 'EVALUATION_MANUAL_INTERVENTION', runId: evaluationObservationRun,
  }).then(result => {
    if (!result?.ok) throw new Error('Intervention non enregistrée.');
  });
  evaluationObservationPending.catch(() => {});
}

function trainingSafeText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d(?:[ .()-]?\d){7,}/g, '[phone]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[token]')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function trainingLabel(element) {
  if (!(element instanceof HTMLElement)) return '';
  const described = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder');
  const label = element.id ? [...document.querySelectorAll('label[for]')].find(node => node.htmlFor === element.id)?.textContent : '';
  return trainingSafeText(label || described || element.textContent || element.getAttribute('name') || element.tagName, 240);
}

function trainingPath() { return `${location.origin}${location.pathname}`; }

function resolveTrainingClickTarget(origin) {
  if (!(origin instanceof Element)) return null;
  const semantic = origin.closest(
    'button,a[href],input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],' +
    '[role="button"],[role="tab"],[role="menuitem"],[role="link"],[role="option"],[role="switch"],' +
    '[onclick],[tabindex]:not([tabindex="-1"])'
  );
  if (semantic instanceof HTMLElement) return semantic;
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
  if (!trainingCaptureActive || !event.isTrusted || !(event.target instanceof Element)) return;
  const target = resolveTrainingClickTarget(event.target);
  if (!target) return;
  const controlName = trainingLabel(target);
  chrome.runtime.sendMessage({ type: 'TRAINING_EVENT', event: {
    kind: 'click', path: trainingPath(), label: controlName || `Contrôle ${trainingControlType(target)}`,
    payload: {
      controlName, controlType: trainingControlType(target), tag: target.tagName.toLowerCase(), role: target.getAttribute('role') || '',
      elementId: safeElementIdentifier(target.id), testId: safeElementIdentifier(target.getAttribute('data-testid')),
      hrefPath: target instanceof HTMLAnchorElement ? target.pathname : '', ariaLabel: trainingSafeText(target.getAttribute('aria-label'), 160),
      title: trainingSafeText(target.getAttribute('title'), 160), zone: trainingZone(target), section: trainingSection(target),
      occurrence: trainingOccurrence(target, controlName), gestureId: crypto.randomUUID?.() || `gesture-${Date.now()}`,
      capturedAt: Date.now(), clickedTag: event.target.tagName.toLowerCase(), source: 'trainer', trusted: true,
    },
  } }).catch(() => {});
}

function captureTrainingInput(event) {
  if (!trainingCaptureActive || !(event.target instanceof HTMLElement)) return;
  const target = event.target.closest('input,textarea,select,[contenteditable="true"]');
  if (!target || target.matches('input[type="password"],input[type="hidden"],input[type="file"]')) return;
  const descriptor = `${target.getAttribute('name') || ''} ${target.getAttribute('autocomplete') || ''} ${trainingLabel(target)}`;
  if (/password|secret|token|api.?key|credit|card|iban|cvv/i.test(descriptor)) return;
  chrome.runtime.sendMessage({ type: 'TRAINING_EVENT', event: {
    kind: 'input', path: trainingPath(), label: trainingLabel(target), payload: {
      tag: target.tagName.toLowerCase(), inputType: target.getAttribute('type') || target.tagName.toLowerCase(),
      role: target.getAttribute('role') || '', elementId: safeElementIdentifier(target.id),
      testId: safeElementIdentifier(target.getAttribute('data-testid')), ariaLabel: trainingSafeText(target.getAttribute('aria-label'), 160),
      title: trainingSafeText(target.getAttribute('title'), 160), zone: trainingZone(target), section: trainingSection(target), filled: true,
    },
  } }).catch(() => {});
}

function setTrainingCapture(active) {
  if (trainingCaptureActive === active) return;
  trainingCaptureActive = active;
  document[active ? 'addEventListener' : 'removeEventListener']('click', captureTrainingClick, true);
  document[active ? 'addEventListener' : 'removeEventListener']('change', captureTrainingInput, true);
  if (active && !trainingModalObserver) {
    trainingModalObserver = new MutationObserver(checkForTrainingModals);
    trainingModalObserver.observe(document.body, { childList: true, subtree: true });
  } else if (!active && trainingModalObserver) {
    trainingModalObserver.disconnect(); trainingModalObserver = null;
  }
}

function handleBackgroundMessage(request, _sender, sendResponse) {
  if (request.type === 'DIAGNOSTIC_PING') {
    sendResponse({ ok: true, documentReadyState: document.readyState, path: window.location.pathname });
  } else if (request.type === 'EVALUATION_OBSERVATION') {
    setEvaluationObservation(request.runId || null); sendResponse({ ok: true });
  } else if (request.type === 'FLUSH_EVALUATION_OBSERVATION') {
    if (request.runId !== evaluationObservationRun) { sendResponse({ ok: false }); return false; }
    evaluationObservationEnabled = false;
    Promise.resolve(evaluationObservationPending).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  } else if (request.type === 'TRAINING_STATE') {
    setTrainingCapture(request.active === true); sendResponse({ ok: true });
  }
  return false;
}

if (!globalThis.__limovaStudioCaptureInstalled) {
  globalThis.__limovaStudioCaptureInstalled = true;
  for (const type of ['pointerdown', 'keydown', 'wheel'])
    document.addEventListener(type, captureEvaluationIntervention, { capture: true, passive: true });
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }).then(response => {
    setEvaluationObservation(response?.evaluationRunId || null);
    setTrainingCapture(response?.training === true);
  }).catch(() => {});
}
