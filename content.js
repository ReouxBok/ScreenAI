/**
 * Limova AI - Content Script
 * Handles: page context extraction, modal detection, element highlighting,
 *          and voice recognition (SpeechRecognition in visible page context)
 */

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_PAGE_CONTEXT') {
    sendResponse({
      title: document.title,
      url: window.location.href,
      hasErrors: checkForErrors()
    });
  }

  if (request.type === 'SESSION_STATE') {
    if (request.active) {
      startModalObserver();
    } else {
      stopModalObserver();
    }
  }

  if (request.type === 'HIGHLIGHT_ELEMENT') {
    const raw = request.id ? getElementByLid(request.id) : findElementByText(request.text);
    if (raw) highlightElement(findClickableContainer(raw));
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
  const elements = document.querySelectorAll(selectors);
  const texts = new Set();
  elements.forEach(el => {
    const t = el.textContent.trim();
    if (t && t.length > 1 && t.length < 200) texts.add(t);
  });

  const activeEls = document.querySelectorAll('[aria-selected="true"],[aria-current="page"],.active,.selected,[class*="active"]');
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
  for (const selector of errorSelectors) {
    if (document.querySelectorAll(selector).length > 0) return true;
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
const MODAL_CLASS_PATTERNS = /\b(modal|dialog|overlay|popup|lightbox|drawer)\b/i;

function isLikelyModal(element) {
  if (!(element instanceof HTMLElement)) return false;

  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (element.getAttribute('aria-modal') === 'true') return true;
  if (element.tagName === 'DIALOG' && element.hasAttribute('open')) return true;

  if (MODAL_CLASS_PATTERNS.test(element.className)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) return true;
  }

  const style = window.getComputedStyle(element);
  if ((style.position === 'fixed' || style.position === 'absolute') && parseInt(style.zIndex) > 100) {
    const rect = element.getBoundingClientRect();
    const viewportArea = window.innerWidth * window.innerHeight;
    const elementArea = rect.width * rect.height;
    if (elementArea / viewportArea > 0.15) return true;
  }

  return false;
}

function checkForModals(mutations) {
  const now = Date.now();
  if (now - lastModalNotify < MODAL_COOLDOWN) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (isLikelyModal(node)) { notifyModalDetected(); return; }
      if (node instanceof HTMLElement) {
        for (const selector of MODAL_SELECTORS) {
          if (node.querySelector(selector)) { notifyModalDetected(); return; }
        }
        for (const child of node.querySelectorAll('*')) {
          if (MODAL_CLASS_PATTERNS.test(child.className)) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 100) { notifyModalDetected(); return; }
          }
        }
      }
    }
  }
}

function notifyModalDetected() {
  lastModalNotify = Date.now();
  chrome.runtime.sendMessage({ type: 'MODAL_DETECTED' }).catch(() => {});
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

function highlightElement(domElement) {
  clearHighlights();
  const rect = domElement.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top - 4}px;
    left: ${rect.left - 4}px;
    width: ${rect.width + 8}px;
    height: ${rect.height + 8}px;
    border: 2px solid #22c55e;
    border-radius: 6px;
    box-shadow: 0 0 0 4px rgba(34,197,94,0.2), 0 0 20px rgba(34,197,94,0.15);
    z-index: 2147483645;
    pointer-events: none;
    animation: limova-highlight-pulse 1.5s ease-in-out infinite;
  `;

  // Add animation keyframes if not already present
  if (!document.getElementById('limova-highlight-styles')) {
    const style = document.createElement('style');
    style.id = 'limova-highlight-styles';
    style.textContent = `
      @keyframes limova-highlight-pulse {
        0%, 100% { box-shadow: 0 0 0 4px rgba(34,197,94,0.2), 0 0 20px rgba(34,197,94,0.15); }
        50% { box-shadow: 0 0 0 8px rgba(34,197,94,0.1), 0 0 30px rgba(34,197,94,0.2); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);
  activeHighlights.push(overlay);

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

// Fallback: text-based search (for HIGHLIGHT_ELEMENT without ID)
function findElementByText(searchText) {
  const lower = searchText.toLowerCase();
  const candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], nav a, .sidebar a, input[type="submit"], h1, h2, h3, h4, label, span, p');
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
// Voice Recognition (runs in visible page context — mic access works here)
// ============================================================================

let recognition = null;
let isRecording = false;
let finalTranscript = '';

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.interimResults = true;
  rec.continuous = true;

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', text: finalTranscript + interim }).catch(() => {});
  };

  rec.onend = () => {
    isRecording = false;
    chrome.runtime.sendMessage({ type: 'VOICE_ENDED' }).catch(() => {});
    finalTranscript = '';
  };

  rec.onerror = (event) => {
    isRecording = false;
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      chrome.runtime.sendMessage({ type: 'VOICE_ERROR', error: event.error }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ type: 'VOICE_ENDED' }).catch(() => {});
    }
    finalTranscript = '';
  };

  return rec;
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'VOICE_START') {
    if (!recognition) recognition = initRecognition();
    if (!recognition) {
      chrome.runtime.sendMessage({ type: 'VOICE_ERROR', error: 'not-supported' }).catch(() => {});
      return;
    }
    if (isRecording) return;
    isRecording = true;
    finalTranscript = '';
    // In voice conversation mode: non-continuous (auto-stops after pause)
    // In dictation mode: continuous (user manually stops)
    recognition.continuous = !request.voiceMode;
    recognition.lang = request.lang || 'fr-FR';
    recognition.start();
  }

  if (request.type === 'VOICE_STOP') {
    if (recognition && isRecording) recognition.stop();
  }
});

// ============================================================================
// Auto-start: check if session is active
// ============================================================================

chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }).then(response => {
  if (response?.active) startModalObserver();
}).catch(() => {});
