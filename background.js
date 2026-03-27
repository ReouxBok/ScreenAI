// background.js — Central hub for Limova AI Onboarding Assistant
// Handles: Gemini API, auto-screenshots, URL change detection, tab locking,
//          modal detection, and sidebar communication.
// SECURITY: API keys are stored on the proxy server, never in the extension.

import Logger from './utils/logger.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { searchKB } from './knowledge-base/kb-search.js';
import { createOnboardingPlan, advanceStep } from './prompts/onboarding-plan.js';

// ============================================================================
// Config
// ============================================================================

const LIMOVA_DOMAIN = 'https://new.limova.ai';
const PROXY_URL = 'https://limova-proxy-479c7fb78ccf.herokuapp.com'; // TODO: Replace with your Heroku app URL
const ELEVENLABS_VOICE_ID = 'YxrwjAKoUKULGd0g8K9Y';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MIN_API_INTERVAL = 2000;
const URL_CHANGE_DEBOUNCE = 500;
const BROWSER_LANG = (chrome.i18n.getUILanguage() || 'en').split('-')[0].toLowerCase();

// ============================================================================
// Session State
// ============================================================================

let sessionState = {
  conversationHistory: [],
  onboardingDocs: null,
  onboardingPlan: null,
  isActive: false,
  lastUrl: null,
  lastAnalysisTime: 0,
  lockedTabId: null,
  voiceMode: false
};

let urlChangeTimeout = null;
let activeAbortController = null;

// ============================================================================
// Initialization
// ============================================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  Logger.log('background', 'Extension installed/updated');
});

// ============================================================================
// URL Change Detection (Auto-screenshots)
// ============================================================================

// Detect full page loads
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!sessionState.isActive) return;
  if (sessionState.lockedTabId && tabId !== sessionState.lockedTabId) return;
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith(LIMOVA_DOMAIN)) return;

  if (urlChangeTimeout) clearTimeout(urlChangeTimeout);
  urlChangeTimeout = setTimeout(() => handleUrlChange(tabId, tab.url), URL_CHANGE_DEBOUNCE);
});

// Detect SPA navigation (pushState / replaceState) — critical for Limova which is a SPA
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!sessionState.isActive) return;
  if (details.frameId !== 0) return; // main frame only
  if (sessionState.lockedTabId && details.tabId !== sessionState.lockedTabId) return;
  if (!details.url.startsWith(LIMOVA_DOMAIN)) return;

  if (urlChangeTimeout) clearTimeout(urlChangeTimeout);
  urlChangeTimeout = setTimeout(() => handleUrlChange(details.tabId, details.url), URL_CHANGE_DEBOUNCE);
});

async function handleUrlChange(tabId, url) {
  if (url === sessionState.lastUrl) return;
  sessionState.lastUrl = url;

  Logger.logTurnStart('url_change', {
    url,
    hasScreenshot: true,
    historyLength: sessionState.conversationHistory.length
  });

  if (activeAbortController) activeAbortController.abort();

  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Nouvelle page détectée...', ponderingText: 'ponderingNewPage' });

  try {
    const screenshot = await captureScreenshot(tabId);
    const pageContext = await getPageContext(tabId);
    const consoleLogs = await getConsoleLogs(tabId);

    await sendToGemini({
      screenshot,
      url,
      pageContext,
      consoleLogs,
      trigger: 'url_change'
    });
  } catch (error) {
    Logger.error('background', 'URL change handling failed', error);
    broadcastToSidebar({ type: 'ERROR', content: `Erreur d'analyse : ${error.message}` });
  }
}

// ============================================================================
// Tab Locking
// ============================================================================

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!sessionState.lockedTabId) return;
  if (tabId === sessionState.lockedTabId) {
    broadcastToSidebar({ type: 'CORRECT_TAB' });
  } else {
    broadcastToSidebar({ type: 'WRONG_TAB' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionState.lockedTabId) {
    sessionState.lockedTabId = null;
    broadcastToSidebar({ type: 'LOCKED_TAB_CLOSED' });
  }
});

function lockTab(tabId) {
  sessionState.lockedTabId = tabId;
  sessionState.isActive = true;
  chrome.tabs.sendMessage(tabId, { type: 'SESSION_STATE', active: true }).catch(() => {});
  Logger.log('background', `Tab locked: ${tabId}`);
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch(err => {
    Logger.error('background', 'Message handler error', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(request, sender) {
  switch (request.type) {
    case 'USER_MESSAGE':
      return handleUserMessage(request.text);

    case 'TAKE_SCREENSHOT':
      return handleTakeScreenshot();

    case 'NEXT_STEP':
      return handleNextStep();

    case 'MODAL_DETECTED':
      return handleModalDetected(sender);

    case 'GET_STATE':
      return {
        conversationHistory: sessionState.conversationHistory,
        isActive: sessionState.isActive,
        onboardingPlan: sessionState.onboardingPlan
      };

    case 'GET_SESSION_STATE':
      return { active: sessionState.isActive };

    case 'GET_SETTINGS':
      return { hasApiKey: true }; // Keys are on the proxy server

    case 'SAVE_SETTINGS':
      return { ok: true }; // Keys are managed server-side now

    case 'GET_LOGS':
      return { logs: Logger.getLogsAsText() };

    case 'RESET_SESSION':
      return handleResetSession();

    case 'SWITCH_TO_LOCKED_TAB':
      if (sessionState.lockedTabId) {
        await chrome.tabs.update(sessionState.lockedTabId, { active: true });
      }
      return { ok: true };

    // Voice recognition — relay between sidebar and content script
    case 'VOICE_START':
      return handleVoiceStart(request);

    case 'VOICE_STOP':
      return handleVoiceStop();

    // Relay from content script → sidebar
    case 'VOICE_TRANSCRIPT':
    case 'VOICE_ENDED':
    case 'VOICE_ERROR':
      broadcastToSidebar(request);
      return { ok: true };

    case 'TOGGLE_VOICE_MODE':
      sessionState.voiceMode = !sessionState.voiceMode;
      Logger.log('background', `Voice mode: ${sessionState.voiceMode ? 'ON' : 'OFF'}`);
      return { voiceMode: sessionState.voiceMode };

    default:
      return { error: 'Unknown message type' };
  }
}

// ============================================================================
// Voice Recognition (via content script in active tab)
// ============================================================================

async function handleVoiceStart(request) {
  // User started speaking — interrupt any ongoing TTS
  abortTTS();
  broadcastToSidebar({ type: 'TTS_STOP' });

  const tab = await getActiveLimovaTab();
  if (!tab) {
    broadcastToSidebar({ type: 'VOICE_ERROR', error: 'no-tab' });
    return { ok: false };
  }
  const lang = request.lang || 'fr-FR';
  const voiceMsg = { type: 'VOICE_START', lang, voiceMode: !!request.voiceMode };
  try {
    await chrome.tabs.sendMessage(tab.id, voiceMsg);
  } catch (_) {
    // Content script not loaded — inject it and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, voiceMsg);
    } catch (e) {
      broadcastToSidebar({ type: 'VOICE_ERROR', error: 'content-script-unavailable' });
    }
  }
  return { ok: true };
}

async function handleVoiceStop() {
  const tab = await getActiveLimovaTab();
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'VOICE_STOP' }).catch(() => {});
  }
  return { ok: true };
}

// ============================================================================
// User Message Handler
// ============================================================================

async function handleUserMessage(text) {
  // Interrupt any ongoing TTS when user speaks
  abortTTS();
  broadcastToSidebar({ type: 'TTS_STOP' });

  const tab = await getActiveLimovaTab();
  if (tab && !sessionState.lockedTabId) lockTab(tab.id);

  Logger.logTurnStart('user_message', {
    url: tab?.url || 'unknown',
    hasScreenshot: !!tab,
    historyLength: sessionState.conversationHistory.length
  });
  Logger.logUserMessage(text, tab?.url);

  // Initialize onboarding plan on first interaction
  if (!sessionState.onboardingPlan && sessionState.conversationHistory.length === 0) {
    sessionState.onboardingPlan = createOnboardingPlan();
    const current = sessionState.onboardingPlan.steps[0];
    broadcastToSidebar({ type: 'STEP_UPDATE', step: current.name, progress: `1 / ${sessionState.onboardingPlan.steps.length}` });
    Logger.log('background', 'Onboarding plan initialized');
  }

  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Analyse...' });

  try {
    let screenshot = null;
    let pageContext = '';
    let consoleLogs = '';

    if (tab) {
      screenshot = await captureScreenshot(tab.id);
      pageContext = await getPageContext(tab.id);
      consoleLogs = await getConsoleLogs(tab.id);
    }

    await sendToGemini({
      screenshot,
      url: tab?.url || '',
      userMessage: text,
      pageContext,
      consoleLogs,
      trigger: sessionState.conversationHistory.length === 0 ? 'doc_load' : 'user_message'
    });
  } catch (error) {
    Logger.error('background', 'User message handling failed', error);
    broadcastToSidebar({ type: 'ERROR', content: `Erreur : ${error.message}` });
  }

  return { ok: true };
}

// ============================================================================
// Screenshot Handlers
// ============================================================================

async function handleTakeScreenshot() {
  const tab = await getActiveLimovaTab();
  if (!tab) {
    broadcastToSidebar({ type: 'ERROR', content: 'Ouvre new.limova.ai pour capturer une page.' });
    return { ok: false };
  }

  if (!sessionState.lockedTabId) lockTab(tab.id);

  Logger.logTurnStart('screenshot_button', { url: tab.url, hasScreenshot: true });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Capture...', ponderingText: 'ponderingCapture' });

  try {
    const screenshot = await captureScreenshot(tab.id);
    const pageContext = await getPageContext(tab.id);
    const consoleLogs = await getConsoleLogs(tab.id);

    await sendToGemini({
      screenshot,
      url: tab.url,
      pageContext,
      consoleLogs,
      trigger: 'screenshot_button'
    });
  } catch (error) {
    Logger.error('background', 'Screenshot handling failed', error);
    broadcastToSidebar({ type: 'ERROR', content: `Erreur de capture : ${error.message}` });
  }

  return { ok: true };
}

async function handleNextStep() {
  const tab = await getActiveLimovaTab();
  if (!tab) return { ok: false };

  Logger.logTurnStart('next_step', { url: tab.url, hasScreenshot: true });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Étape suivante...' });

  try {
    const screenshot = await captureScreenshot(tab.id);
    const pageContext = await getPageContext(tab.id);
    const consoleLogs = await getConsoleLogs(tab.id);

    await sendToGemini({
      screenshot,
      url: tab.url,
      userMessage: "Continue avec la prochaine étape.",
      pageContext,
      consoleLogs,
      trigger: 'user_message'
    });
  } catch (error) {
    broadcastToSidebar({ type: 'ERROR', content: error.message });
  }
  return { ok: true };
}

// ============================================================================
// Modal Detection
// ============================================================================

async function handleModalDetected(sender) {
  if (!sessionState.isActive) return { ok: false };
  const tabId = sender?.tab?.id || sessionState.lockedTabId;
  if (!tabId) return { ok: false };

  const now = Date.now();
  if (now - sessionState.lastAnalysisTime < MIN_API_INTERVAL) return { ok: false };

  Logger.logTurnStart('modal_detected', { url: sessionState.lastUrl, hasScreenshot: true });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Popup détecté...', ponderingText: 'ponderingPopup' });

  try {
    const screenshot = await captureScreenshot(tabId);
    const pageContext = await getPageContext(tabId);

    await sendToGemini({
      screenshot,
      url: sessionState.lastUrl || '',
      pageContext,
      trigger: 'modal_detected'
    });
  } catch (error) {
    Logger.error('background', 'Modal detection handling failed', error);
  }

  return { ok: true };
}

// ============================================================================
// ElevenLabs TTS (Streaming)
// ============================================================================

let ttsAbortController = null;

function abortTTS() {
  if (ttsAbortController) {
    ttsAbortController.abort();
    ttsAbortController = null;
    Logger.log('background', 'TTS aborted (user interrupted)');
  }
}

function cleanTextForTTS(text) {
  return text
    .replace(/\*\*/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#{1,3}\s/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function synthesizeVoiceStream(text) {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) {
    Logger.warn('background', 'TTS skipped: empty text after cleanup');
    broadcastToSidebar({ type: 'TTS_AUDIO', audioData: null });
    return;
  }

  // Abort any previous TTS stream
  abortTTS();
  ttsAbortController = new AbortController();

  Logger.log('background', `TTS stream request: voice=${ELEVENLABS_VOICE_ID}, text=${cleanText.substring(0, 80)}...`);

  try {
    const response = await fetch(`${PROXY_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: cleanText,
        voiceId: ELEVENLABS_VOICE_ID,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      }),
      signal: ttsAbortController.signal
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(no body)');
      Logger.error('background', `ElevenLabs TTS HTTP ${response.status}: ${errorBody.substring(0, 300)}`);
      broadcastToSidebar({ type: 'TTS_AUDIO', audioData: null });
      return;
    }

    // Signal sidebar to prepare for streaming audio
    broadcastToSidebar({ type: 'TTS_STREAM_START' });

    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Convert Uint8Array chunk to base64 and send to sidebar
      let binary = '';
      for (let i = 0; i < value.length; i++) {
        binary += String.fromCharCode(value[i]);
      }
      const chunkBase64 = btoa(binary);
      totalBytes += value.length;

      broadcastToSidebar({ type: 'TTS_STREAM_CHUNK', chunk: chunkBase64 });
    }

    Logger.log('background', `TTS stream complete: ${totalBytes} bytes`);
    broadcastToSidebar({ type: 'TTS_STREAM_END' });

  } catch (error) {
    if (error.name === 'AbortError') {
      Logger.log('background', 'TTS stream aborted');
      broadcastToSidebar({ type: 'TTS_STREAM_END', aborted: true });
      return;
    }
    Logger.error('background', `TTS stream failed: ${error.message}`);
    broadcastToSidebar({ type: 'TTS_AUDIO', audioData: null });
  } finally {
    ttsAbortController = null;
  }
}

// ============================================================================
// Gemini API
// ============================================================================

async function sendToGemini({ screenshot, url, userMessage, pageContext, consoleLogs, trigger }) {
  const now = Date.now();
  if (now - sessionState.lastAnalysisTime < MIN_API_INTERVAL) {
    Logger.warn('background', 'API call rate limited');
    broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'ready' });
    return;
  }
  sessionState.lastAnalysisTime = now;

  if (activeAbortController) activeAbortController.abort();
  activeAbortController = new AbortController();

  // API keys are stored on the proxy server, not in the extension

  // Search KB for relevant articles based on user message, page URL and context
  // Enrich with step-specific queries if onboarding plan is active
  let kbContext = sessionState.onboardingDocs || '';
  let searchQuery = userMessage || pageContext || '';
  if (sessionState.onboardingPlan) {
    const currentStep = sessionState.onboardingPlan.steps[sessionState.onboardingPlan.activeIndex];
    if (currentStep?.kbQueries?.length) {
      searchQuery = currentStep.kbQueries.join(' ') + ' ' + searchQuery;
    }
  }
  if (searchQuery || url) {
    const kbResults = searchKB(searchQuery, {
      url: url || '',
      consoleLogs: consoleLogs || '',
      maxResults: 5,
      maxChars: 8000,
    });
    if (kbResults) {
      kbContext = (kbContext ? kbContext + '\n\n' : '') +
        '## Articles de la base de connaissances Limova\n\n' + kbResults;
    }
  }

  const systemPrompt = buildSystemPrompt({
    onboardingDocs: kbContext || null,
    pageContext: pageContext || `URL: ${url}`,
    consoleLogs: consoleLogs || '',
    trigger,
    onboardingPlan: sessionState.onboardingPlan,
    voiceMode: sessionState.voiceMode,
    lang: BROWSER_LANG
  });

  const userParts = [];
  if (userMessage) {
    userParts.push({ text: `[URL: ${url}]\n\n${userMessage}` });
  } else {
    userParts.push({ text: `[URL: ${url}]\n\nThe user navigated to this page. Analyze what you see and guide them.` });
  }
  if (screenshot) {
    userParts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshot } });
  }

  const contents = [];
  for (const msg of sessionState.conversationHistory) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }
  contents.push({ role: 'user', parts: userParts });

  Logger.logApiRequest({
    model: GEMINI_MODEL,
    messageCount: contents.length,
    hasScreenshot: !!screenshot,
    systemPromptLength: systemPrompt.length
  });

  const startTime = Date.now();

  try {
    const response = await fetch(`${PROXY_URL}/api/gemini`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Model': GEMINI_MODEL
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents
      }),
      signal: activeAbortController.signal
    });

    if (!response.ok) {
      let errorMessage = response.status === 429
        ? 'Trop de requêtes, veuillez patienter un moment.'
        : `Gemini Error: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData?.error?.message) errorMessage = errorData.error.message;
        else if (errorData?.error) errorMessage = errorData.error;
      } catch (_) {}
      throw new Error(errorMessage);
    }

    const json = await response.json();

    if (!json.candidates?.length) {
      if (json.promptFeedback?.blockReason) {
        throw new Error(`Requête bloquée : ${json.promptFeedback.blockReason}`);
      }
      throw new Error('Pas de réponse de Gemini.');
    }

    const responseText = json.candidates[0]?.content?.parts?.[0]?.text || '';
    if (!responseText) throw new Error('Réponse vide de Gemini.');

    Logger.logApiResponse({ success: true, responseTime: Date.now() - startTime });

    // Loading screen retry
    if (responseText.trim() === '[LOADING]') {
      Logger.log('background', 'Loading screen detected, retrying in 2s');
      setTimeout(() => {
        if (sessionState.lockedTabId) handleUrlChange(sessionState.lockedTabId, url);
      }, 2000);
      return;
    }

    // Onboarding step/complete markers
    let cleanResponse = responseText;

    // Step completion — advance to next step
    if (cleanResponse.includes('{{STEP_COMPLETE}}')) {
      cleanResponse = cleanResponse.replace(/\{\{STEP_COMPLETE\}\}/g, '').trim();
      if (sessionState.onboardingPlan) {
        const result = advanceStep(sessionState.onboardingPlan);
        if (result) {
          sessionState.onboardingPlan = result;
          const current = result.steps[result.activeIndex];
          Logger.log('background', `Onboarding: advanced to step ${result.activeIndex + 1} — ${current.name}`);
          broadcastToSidebar({ type: 'STEP_UPDATE', step: current.name, progress: `${result.activeIndex + 1} / ${result.steps.length}` });
        } else {
          Logger.log('background', 'Onboarding: all steps completed');
          sessionState.onboardingPlan = null;
          broadcastToSidebar({ type: 'ONBOARDING_COMPLETE' });
        }
      }
    }

    // Full onboarding complete (fallback if Gemini emits this directly)
    if (cleanResponse.includes('{{ONBOARDING_COMPLETE}}')) {
      cleanResponse = cleanResponse.replace('{{ONBOARDING_COMPLETE}}', '').trim();
      sessionState.onboardingPlan = null;
      broadcastToSidebar({ type: 'ONBOARDING_COMPLETE' });
    }

    // Extract highlight commands (ID-based)
    const highlightCommands = [];
    cleanResponse = cleanResponse.replace(/\{\{HIGHLIGHT:(\d+)\}\}/g, (_, id) => {
      highlightCommands.push(parseInt(id));
      return '';
    });

    cleanResponse = cleanResponse.replace(/\n{3,}/g, '\n\n').trim();

    // Update conversation history
    if (userMessage) {
      sessionState.conversationHistory.push({ role: 'user', content: userMessage });
    }
    sessionState.conversationHistory.push({ role: 'assistant', content: cleanResponse });

    if (sessionState.conversationHistory.length > 200) {
      sessionState.conversationHistory = sessionState.conversationHistory.slice(-200);
    }

    Logger.logGeminiResponse(cleanResponse);

    // Send text response immediately
    broadcastToSidebar({ type: 'GEMINI_RESPONSE', content: cleanResponse, screenshot: screenshot || null });

    // Execute highlight commands
    if (highlightCommands.length > 0 && sessionState.lockedTabId) {
      Logger.log('background', `Highlight: ${highlightCommands.join(', ')}`);
      // Only highlight the first element (one at a time)
      setTimeout(() => {
        chrome.tabs.sendMessage(sessionState.lockedTabId, {
          type: 'HIGHLIGHT_ELEMENT', id: highlightCommands[0]
        }).catch(() => {});
      }, 500);
    }

    // Synthesize TTS audio (streaming) if voice mode is active
    // IMPORTANT: must be awaited to keep the service worker alive in MV3
    if (sessionState.voiceMode) {
      Logger.log('background', 'Starting TTS stream...');
      await synthesizeVoiceStream(cleanResponse);
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      Logger.log('background', 'API call aborted (superseded)');
      broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'ready' });
      return;
    }
    Logger.logApiResponse({ success: false, error: error.message, responseTime: Date.now() - startTime });
    throw error;
  }
}

// ============================================================================
// Screenshot Capture
// ============================================================================

async function captureScreenshot(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 });
    if (!dataUrl) return null;
    return await resizeScreenshot(dataUrl);
  } catch (error) {
    Logger.warn('background', 'Screenshot capture failed', error);
    return null;
  }
}

async function resizeScreenshot(dataUrl) {
  const MAX_WIDTH = 1024;
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    if (imageBitmap.width <= MAX_WIDTH) return dataUrl.split(',')[1];

    const scale = MAX_WIDTH / imageBitmap.width;
    const canvas = new OffscreenCanvas(MAX_WIDTH, Math.round(imageBitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);

    const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return await blobToBase64(resizedBlob);
  } catch (error) {
    return dataUrl.split(',')[1];
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================================================
// Page Context Extraction
// ============================================================================

async function getPageContext(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Clean up previous IDs
        document.querySelectorAll('[data-lid]').forEach(el => el.removeAttribute('data-lid'));

        let idCounter = 1;
        const elementMap = [];

        // Helper: get concise zone name from DOM position
        function getZone(el) {
          const nav = el.closest('nav, [role="navigation"], [class*="sidebar"], [class*="nav"]');
          if (nav) return 'nav';
          const header = el.closest('header, [class*="header"], [class*="topbar"]');
          if (header) return 'header';
          const modal = el.closest('[role="dialog"], [aria-modal="true"], dialog, [class*="modal"]');
          if (modal) return 'modal';
          const form = el.closest('form, [class*="form"]');
          if (form) return 'form';
          const footer = el.closest('footer');
          if (footer) return 'footer';
          return 'main';
        }

        // Helper: check if element is visible
        function isVisible(el) {
          if (!el.offsetParent && el.tagName !== 'BODY' && window.getComputedStyle(el).position !== 'fixed') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        }

        // 1. Clickable elements: buttons, links, tabs, menu items
        const clickables = document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="link"], ' +
          'input[type="submit"], input[type="button"], [class*="btn"], [tabindex="0"]'
        );
        clickables.forEach(el => {
          if (!isVisible(el)) return;
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
          const ariaLabel = el.getAttribute('aria-label') || '';
          const label = text.length > 0 && text.length < 80 ? text : ariaLabel;
          if (!label || label.length < 1) return;
          // Skip duplicates
          if (elementMap.some(e => e.type === 'clickable' && e.text === label && e.zone === getZone(el))) return;

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          const isActive = el.classList.contains('active') || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page';
          elementMap.push({
            id, type: 'clickable', tag: el.tagName.toLowerCase(), text: label,
            zone: getZone(el), active: isActive || false
          });
        });

        // 2. Input fields: text inputs, textareas, selects
        const inputs = document.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), ' +
          'textarea, select, [contenteditable="true"]'
        );
        inputs.forEach(el => {
          if (!isVisible(el)) return;
          // Find the label for this input
          let label = '';
          // 1) <label for="...">
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) label = lbl.textContent.trim();
          }
          // 2) Wrapping <label>
          if (!label) {
            const parentLabel = el.closest('label');
            if (parentLabel) label = parentLabel.textContent.trim().replace(el.value || '', '').trim();
          }
          // 3) aria-label or placeholder
          if (!label) label = el.getAttribute('aria-label') || el.placeholder || el.name || '';
          label = label.replace(/\s+/g, ' ').substring(0, 80);
          if (!label) return;

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          const inputType = el.tagName === 'SELECT' ? 'select' : (el.type || 'text');
          const currentVal = el.value ? el.value.substring(0, 50) : '';
          elementMap.push({
            id, type: 'input', inputType, text: label,
            zone: getZone(el), value: currentVal || undefined
          });
        });

        // 3. Checkboxes & radios
        const checks = document.querySelectorAll('input[type="checkbox"], input[type="radio"]');
        checks.forEach(el => {
          if (!isVisible(el)) return;
          let label = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) label = lbl.textContent.trim();
          }
          if (!label) {
            const parentLabel = el.closest('label');
            if (parentLabel) label = parentLabel.textContent.trim();
          }
          if (!label) label = el.getAttribute('aria-label') || el.name || '';
          if (!label) return;

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          elementMap.push({
            id, type: el.type, text: label.substring(0, 80),
            zone: getZone(el), checked: el.checked
          });
        });

        // 4. Headings (for context, not interactive)
        const headings = document.querySelectorAll('h1, h2, h3');
        headings.forEach(el => {
          if (!isVisible(el)) return;
          const text = el.textContent.trim().replace(/\s+/g, ' ');
          if (text.length < 2 || text.length > 120) return;
          elementMap.push({ type: 'heading', tag: el.tagName.toLowerCase(), text });
        });

        return {
          title: document.title || '',
          url: window.location.href,
          elements: elementMap.slice(0, 120)
        };
      }
    });

    if (results?.[0]?.result) {
      const pc = results[0].result;
      const parts = [];
      if (pc.title) parts.push(`Page: ${pc.title}`);

      // Group elements by zone for readability
      const byZone = {};
      for (const el of pc.elements) {
        const zone = el.zone || 'page';
        if (!byZone[zone]) byZone[zone] = [];
        byZone[zone].push(el);
      }

      for (const [zone, elements] of Object.entries(byZone)) {
        const lines = elements.map(el => {
          if (el.type === 'heading') return `  ${el.tag}: "${el.text}"`;
          const id = `[${el.id}]`;
          const active = el.active ? ' ✓' : '';
          const checked = el.checked ? ' ☑' : el.checked === false ? ' ☐' : '';
          const val = el.value ? ` = "${el.value}"` : '';
          return `  ${id} ${el.type}(${el.tag || el.inputType || ''}) "${el.text}"${active}${checked}${val}`;
        });
        parts.push(`\n[${zone}]\n${lines.join('\n')}`);
      }

      return parts.join('\n');
    }
  } catch (e) {
    Logger.warn('background', 'Page context extraction failed', e);
  }
  return '';
}

async function getConsoleLogs(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__limova_console_logs || []
    });
    if (results?.[0]?.result?.length > 0) {
      return results[0].result.slice(-20).map(l => `[${l.level}] ${l.message}`).join('\n');
    }
  } catch (e) {}
  return '';
}

// ============================================================================
// Settings & Session
// ============================================================================

// API keys are managed server-side on the proxy — no local key storage needed

function handleResetSession() {
  sessionState.conversationHistory = [];
  sessionState.onboardingDocs = null;
  sessionState.onboardingPlan = null;
  sessionState.isActive = false;
  sessionState.lastUrl = null;
  sessionState.lastAnalysisTime = 0;
  sessionState.voiceMode = false;

  if (sessionState.lockedTabId) {
    chrome.tabs.sendMessage(sessionState.lockedTabId, { type: 'SESSION_STATE', active: false }).catch(() => {});
  }
  sessionState.lockedTabId = null;

  Logger.clearLogs();
  Logger.log('background', 'Session reset');
  return { ok: true };
}

// ============================================================================
// Helpers
// ============================================================================

function broadcastToSidebar(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function getActiveLimovaTab() {
  if (sessionState.lockedTabId) {
    try {
      const tab = await chrome.tabs.get(sessionState.lockedTabId);
      if (tab.url?.startsWith(LIMOVA_DOMAIN)) return tab;
    } catch (_) {
      sessionState.lockedTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find(t => t.url?.startsWith(LIMOVA_DOMAIN)) || null;
}
