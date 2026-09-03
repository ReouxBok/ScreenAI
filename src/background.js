// background.js — Central hub for Limova AI Onboarding Assistant
// Handles: Gemini API, DOM page analysis, URL change detection, tab locking,
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
const LIMOVA_API_DOMAIN = 'https://api.new.limova.ai';
const PROXY_URL = 'https://limova-proxy-479c7fb78ccf.herokuapp.com';
const TRAINING_API_URL = 'https://studio.limova.ai/api/training/sessions';
const EVALUATION_API_URL = 'https://studio.limova.ai/api/evaluations/runs';
const GEMINI_MODEL = 'gemini-3.6-flash';
const MIN_API_INTERVAL = 2000;
const URL_CHANGE_DEBOUNCE = 500;
const AI_CONSENT_KEY = 'limova_ai_processing_consent_v1';
const CHARLY_AUTH_STORAGE_KEY = 'charly_auth_session_v1';
const TRAINING_STATE_STORAGE_KEY = 'charly_training_active_v1';
const TRAINING_STATE_MAX_AGE_MS = 70 * 60_000;
const PROXY_TOKEN_RENEWAL_MARGIN = 60_000;
const CONVERSATION_HISTORY_MAX_MESSAGES = 200;
const CONVERSATION_CONTEXT_MAX_CHARACTERS = 60_000;
const ACTION_INTENT_MAX_AGE_MS = 2 * 60_000;
const EXTERNAL_POPUP_STABILIZATION_MS = 3_000;
const VISUAL_CAPTURE_MAX_BASE64_CHARACTERS = 1_500_000;
const VISUAL_CAPTURE_JPEG_QUALITY = 55;
const DEFAULT_LANG = (chrome.i18n.getUILanguage() || 'en').split('-')[0].toLowerCase();
let currentLang = DEFAULT_LANG;

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function errorCodeOf(error, fallback = 'UNEXPECTED_ERROR') {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code)) return error.code;
  const message = String(error?.message || '');
  if (/connecte-toi|non authentifi|session.*expir/i.test(message)) return 'AUTH_SESSION_MISSING';
  if (/microphone|micro\b/i.test(message)) return 'MIC_PERMISSION_FAILED';
  if (/timeout|expirée/i.test(message)) return 'REQUEST_TIMEOUT';
  if (/fetch|network|réseau/i.test(message)) return 'NETWORK_UNAVAILABLE';
  return fallback;
}

function isLimovaUrl(value) {
  try {
    return new URL(value).origin === LIMOVA_DOMAIN;
  } catch {
    return false;
  }
}

// ============================================================================
// Session State
// ============================================================================

let sessionState = {
  conversationHistory: [],
  remoteSessionId: null,
  onboardingDocs: null,
  onboardingPlan: null,
  isActive: false,
  lastUrl: null,
  lastAnalysisTime: 0,
  lockedTabId: null
};

let urlChangeTimeout = null;
let activeAbortController = null;
let proxyAccessToken = null;
let proxyAccessTokenExpiresAt = 0;
let pageContextVersion = 0;
let lastPageElements = new Map();
let lastPageContext = '';
const pageElementSnapshots = new Map();
const PAGE_ELEMENT_SNAPSHOT_LIMIT = 8;
let lastUserMessage = '';
let lastUserTurn = null;
let userTurnSequence = 0;
let voiceSessionActive = false;
const userPageInteractionSequences = new Map();
let trainingState = { active: false, stopping: false, token: null, session: null };
let evaluationState = { active: false, token: null, run: null, testCase: null, content: null };
let trainingEventQueue = Promise.resolve();
const pendingTrainingOutcomeTasks = new Set();
const recentTrainingContextEvents = new Map();
const externalPopupTabs = new Map();
let externalPopupFlow = null;
let externalPopupCloseTimer = null;
const pendingActions = new Map();
const recentRejectedActionTargets = new Map();
const loadingRetries = new Map();
let onboardingTemplateCache = null;
let onboardingTemplateCacheExpiresAt = 0;
let copilotBootstrapCache = null;
let copilotBootstrapCacheExpiresAt = 0;
let lastSyncedProfileHash = '';

// ============================================================================
// Session Persistence (survives browser restarts via chrome.storage.local)
// ============================================================================

const SESSION_STORAGE_KEY = 'limova_session';

// Keys to persist (exclude transient/non-serializable state)
const PERSISTED_KEYS = ['conversationHistory', 'remoteSessionId', 'onboardingPlan', 'isActive', 'lastUrl', 'lockedTabId'];

async function saveSession() {
  const data = {};
  for (const key of PERSISTED_KEYS) {
    data[key] = sessionState[key];
  }
  try {
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: data });
  } catch (e) {
    Logger.warn('background', 'Session save failed', e);
  }
}

async function restoreSession() {
  try {
    const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const data = result[SESSION_STORAGE_KEY];
    if (data) {
      for (const key of PERSISTED_KEYS) {
        if (data[key] !== undefined) sessionState[key] = data[key];
      }
      sessionState.lastUrl = privacySafeUrl(sessionState.lastUrl) || null;
      Logger.log('background', `Session restored: ${sessionState.conversationHistory.length} messages, active=${sessionState.isActive}`);
    }
  } catch (e) {
    Logger.warn('background', 'Session restore failed', e);
  }
}

async function persistTrainingState() {
  try {
    if (!trainingState.active || !trainingState.token || !trainingState.session?.id) {
      await chrome.storage.session.remove(TRAINING_STATE_STORAGE_KEY);
      return;
    }
    await chrome.storage.session.set({
      [TRAINING_STATE_STORAGE_KEY]: {
        token: trainingState.token,
        session: trainingState.session,
        savedAt: Date.now()
      }
    });
  } catch (error) {
    Logger.warn('training', 'Training state persistence failed', { error: error?.name || 'unknown' });
  }
}

async function restoreTrainingState() {
  try {
    const result = await chrome.storage.session.get(TRAINING_STATE_STORAGE_KEY);
    const stored = result[TRAINING_STATE_STORAGE_KEY];
    const valid = typeof stored?.token === 'string'
      && stored.token.length >= 24
      && typeof stored?.session?.id === 'string'
      && Number.isFinite(stored?.savedAt)
      && Date.now() - stored.savedAt <= TRAINING_STATE_MAX_AGE_MS;
    if (!valid) {
      if (stored) await chrome.storage.session.remove(TRAINING_STATE_STORAGE_KEY);
      return;
    }
    trainingState = { active: true, stopping: false, token: stored.token, session: stored.session };
    Logger.event('training', 'TRAINING_STATE_RESTORED', { sessionId: stored.session.id });
  } catch (error) {
    Logger.warn('training', 'Training state restoration failed', { error: error?.name || 'unknown' });
  }
}

// Debounced save — avoid hammering storage on rapid events
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveSession, 500);
}

// ============================================================================
// Initialization
// ============================================================================

// Chrome deliberately does not grant `activeTab` when the toolbar action is
// configured as an automatic side-panel toggle. Open the panel ourselves from
// the action click so the same user gesture grants the ephemeral screenshot
// permission without requesting broad `<all_urls>` access.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener(tab => {
  if (!Number.isInteger(tab?.id)) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(error => {
    Logger.warn('background', 'Side panel could not be opened', {
      name: error?.name || 'Error'
    }, 'SIDE_PANEL_OPEN_FAILED');
  });
});

// Restore every persisted dependency before processing extension messages.
const loggerInitializationPromise = Logger.initialize({
  storageArea: chrome.storage.session,
  metadata: {
    extensionVersion: chrome.runtime.getManifest().version,
    uiLanguage: DEFAULT_LANG
  }
});

const initializationPromise = loggerInitializationPromise.then(() => Promise.all([
  restoreSession(),
  restoreTrainingState(),
  // Product analytics was removed. Clear the legacy opt-in flag so an update
  // cannot silently preserve a data-collection preference that no longer exists.
  chrome.storage.local.remove('limova_analytics_consent').catch(() => {}),
  chrome.storage.local.get('limova_lang').then(result => {
    if (result.limova_lang) currentLang = result.limova_lang;
  }).catch(() => {}),
  chrome.storage.session.get('charly_evaluation_active').then(result => {
    const stored = result.charly_evaluation_active;
    if (stored?.token && stored?.run) evaluationState = { active: true, token: stored.token, run: stored.run, testCase: stored.testCase || null, content: stored.content || null };
  }).catch(() => {})
]));

globalThis.addEventListener?.('unhandledrejection', event => {
  Logger.error('service_worker', 'Unhandled promise rejection', event.reason, 'UNHANDLED_REJECTION');
});
globalThis.addEventListener?.('error', event => {
  Logger.error('service_worker', 'Uncaught service worker error', event.error || event.message, 'UNCAUGHT_ERROR');
});

chrome.runtime.onInstalled.addListener((details) => {
  Logger.event('service_worker', 'EXTENSION_INSTALLED_OR_UPDATED', {
    reason: details?.reason || 'unknown',
    previousVersion: details?.previousVersion || null
  });
});

// ============================================================================
// URL Change Detection (automatic DOM analysis)
// ============================================================================

// Detect full page loads
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!sessionState.isActive && !trainingState.active && !evaluationState.active) return;
  if (sessionState.lockedTabId && tabId !== sessionState.lockedTabId) return;
  if (changeInfo.status !== 'complete') return;
  if (!isLimovaUrl(tab.url)) return;

  if (urlChangeTimeout) clearTimeout(urlChangeTimeout);
  urlChangeTimeout = setTimeout(() => handleUrlChange(tabId, tab.url), URL_CHANGE_DEBOUNCE);
});

// Detect SPA navigation (pushState / replaceState) — critical for Limova which is a SPA
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!sessionState.isActive && !trainingState.active) return;
  if (details.frameId !== 0) return; // main frame only
  if (sessionState.lockedTabId && details.tabId !== sessionState.lockedTabId) return;
  if (!isLimovaUrl(details.url)) return;

  if (urlChangeTimeout) clearTimeout(urlChangeTimeout);
  urlChangeTimeout = setTimeout(() => handleUrlChange(details.tabId, details.url), URL_CHANGE_DEBOUNCE);
}, { url: [{ schemes: ['https'], hostEquals: 'new.limova.ai' }] });

chrome.tabs.onCreated.addListener((tab) => {
  trackExternalPopup(tab).catch(error => Logger.warn('popup', 'External popup tracking failed', error));
});

async function trackExternalPopup(tab) {
  if (!sessionState.isActive && !trainingState.active) return;
  if (!tab?.id || !tab.openerTabId || tab.openerTabId !== sessionState.lockedTabId) return;
  if (externalPopupTabs.has(tab.id)) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  // OAuth providers open a separate browser window. Do not mistake an ordinary
  // new tab for that authorization window, otherwise normal tab locking breaks.
  if (!opener || (Number.isInteger(tab.windowId) && Number.isInteger(opener.windowId) && tab.windowId === opener.windowId)) return;
  if (externalPopupTabs.has(tab.id)) return;
  if (externalPopupCloseTimer) {
    clearTimeout(externalPopupCloseTimer);
    externalPopupCloseTimer = null;
  }
  const startsFlow = externalPopupTabs.size === 0 && !externalPopupFlow;
  externalPopupFlow ||= { openerTabId: tab.openerTabId, openedAt: Date.now(), popupCount: 0 };
  externalPopupFlow.popupCount += 1;
  externalPopupTabs.set(tab.id, { openerTabId: tab.openerTabId, openedAt: Date.now() });
  const path = sessionState.lastUrl || LIMOVA_DOMAIN;
  if (startsFlow && trainingState.active) {
    await recordTrainingEvent({ kind: 'page_context', path, label: 'Fenêtre d’autorisation externe ouverte', payload: { phase: 'opened', contentAccessible: false } });
  }
  Logger.event('popup', 'EXTERNAL_AUTH_POPUP_OPENED', {
    popupTabId: tab.id,
    openerTabId: tab.openerTabId,
    popupCount: externalPopupFlow.popupCount,
    userNotificationSent: startsFlow
  });
  if (startsFlow) broadcastToSidebar({ type: 'EXTERNAL_POPUP_STATUS', phase: 'opened' });
}

async function handleExternalPopupClosed(tabId) {
  const tracked = externalPopupTabs.get(tabId);
  if (!tracked) return;
  externalPopupTabs.delete(tabId);
  Logger.event('popup', 'EXTERNAL_AUTH_POPUP_TAB_CLOSED', {
    popupTabId: tabId,
    durationMs: Date.now() - tracked.openedAt,
    remainingPopupCount: externalPopupTabs.size
  });
  if (externalPopupTabs.size > 0) return;
  if (externalPopupCloseTimer) clearTimeout(externalPopupCloseTimer);
  externalPopupCloseTimer = setTimeout(() => {
    externalPopupCloseTimer = null;
    if (externalPopupTabs.size > 0 || !externalPopupFlow) return;
    finalizeExternalPopupFlow(externalPopupFlow).catch(error => Logger.warn('popup', 'External popup finalization failed', error));
    externalPopupFlow = null;
  }, EXTERNAL_POPUP_STABILIZATION_MS);
}

async function finalizeExternalPopupFlow(flow) {
  const path = sessionState.lastUrl || LIMOVA_DOMAIN;
  if (trainingState.active) {
    await recordTrainingEvent({ kind: 'page_context', path, label: 'Fenêtre d’autorisation externe fermée', payload: { phase: 'closed', durationMs: Date.now() - flow.openedAt, popupCount: flow.popupCount } });
  }
  Logger.event('popup', 'EXTERNAL_AUTH_POPUP_CLOSED', { durationMs: Date.now() - flow.openedAt, popupCount: flow.popupCount });
  broadcastToSidebar({ type: 'EXTERNAL_POPUP_STATUS', phase: 'closed' });
  const tab = await chrome.tabs.get(flow.openerTabId).catch(() => null);
  if (tab?.url && isLimovaUrl(tab.url)) {
    if (trainingState.active) {
      const context = await getPageContext(tab.id).catch(() => '');
      await recordTrainingContext(context, tab.url);
    }
    if (sessionState.isActive) setTimeout(() => handleUrlChange(tab.id, tab.url, { force: true }), 500);
  }
}

async function handleUrlChange(tabId, url, { force = false } = {}) {
  if (trainingState.active) {
    await sendContentMessage(tabId, { type: 'TRAINING_STATE', active: true }).catch(() => {});
    const context = await getPageContext(tabId).catch(() => '');
    await recordTrainingEvent({ kind: 'navigation', path: privacySafeUrl(url), label: `Navigation vers ${privacySafeUrl(url)}`, payload: { context: context.slice(0, 8000) } });
    await recordTrainingContext(context, url);
  }
  if (!sessionState.isActive) return;
  if (!(await hasAIProcessingConsent())) return;
  url = privacySafeUrl(url);
  if (!force && url === sessionState.lastUrl) return;
  sessionState.lastUrl = url;

  Logger.logTurnStart('url_change', {
    url,
    hasPageContext: true,
    historyLength: sessionState.conversationHistory.length
  });

  if (activeAbortController) activeAbortController.abort();

  if (!voiceSessionActive) {
    broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Nouvelle page détectée...', ponderingText: 'ponderingNewPage' });
  }

  try {
    const pageContext = await getPageContext(tabId);
    const pageAnalysis = await capturePageAnalysis(tabId);
    if (voiceSessionActive) {
      broadcastToSidebar({
        type: 'VOICE_PAGE_CONTEXT',
        pageContext,
        contextVersion: pageContextVersion,
        source: 'navigation',
        visualCapture: pageAnalysis
      });
      Logger.event('voice', 'VOICE_NAVIGATION_CONTEXT_PUBLISHED', {
        contextVersion: pageContextVersion,
        characterCount: pageContext.length,
        elementCount: lastPageElements.size
      });
      return;
    }
    const consoleLogs = await getConsoleLogs(tabId);

    await sendToGemini({
      pageAnalysis,
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
  handleTabActivated(tabId).catch(error => Logger.warn('tabs', 'Active tab handling failed', error));
});

async function handleTabActivated(tabId) {
  if (!sessionState.lockedTabId) return;
  if (tabId === sessionState.lockedTabId) {
    broadcastToSidebar({ type: 'CORRECT_TAB' });
    return;
  }
  if (externalPopupTabs.has(tabId)) {
    return;
  }
  // Keep the normal tab-lock warning silent for the complete OAuth lifecycle,
  // including the grace period between two short-lived provider windows.
  if (externalPopupFlow) return;
  // Chrome can activate an OAuth window a few milliseconds before onCreated
  // has finished classifying it. Give that event a short head start so the UI
  // never flashes a false "mauvais onglet" warning.
  await new Promise(resolve => setTimeout(resolve, 250));
  if (externalPopupTabs.has(tabId) || externalPopupFlow) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.openerTabId === sessionState.lockedTabId) {
    await trackExternalPopup(tab);
    if (externalPopupTabs.has(tabId)) return;
  }
  broadcastToSidebar({ type: 'WRONG_TAB' });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleExternalPopupClosed(tabId).catch(error => Logger.warn('popup', 'External popup close handling failed', error));
  if (tabId === sessionState.lockedTabId) {
    sessionState.lockedTabId = null;
    broadcastToSidebar({ type: 'LOCKED_TAB_CLOSED' });
  }
});

function lockTab(tabId, { activateAssistant = true } = {}) {
  sessionState.lockedTabId = tabId;
  if (activateAssistant) sessionState.isActive = true;
  sendContentMessage(tabId, { type: 'SESSION_STATE', active: sessionState.isActive }).catch(() => {});
  scheduleSave();
  Logger.log('background', `Tab locked: ${tabId}`);
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedMessageSource(request, sender)) {
    Logger.warn('background', 'Rejected message from an untrusted source', {
      type: request?.type || 'unknown',
      senderId: sender?.id || 'missing',
      senderUrl: privacySafeUrl(sender?.url || sender?.tab?.url) || 'missing'
    });
    sendResponse({ error: 'Unauthorized message source' });
    return false;
  }
  handleMessage(request, sender).then(sendResponse).catch(err => {
    Logger.error('background', 'Message handler error', err);
    sendResponse({ error: err.message });
  });
  return true;
});

const CONTENT_SCRIPT_MESSAGE_TYPES = new Set([
  'GET_SESSION_STATE', 'MODAL_DETECTED', 'TRAINING_EVENT', 'LIMOVA_PROFILE', 'USER_PAGE_INTERACTION'
]);

function isTrustedMessageSource(request, sender) {
  if (!request || typeof request.type !== 'string') return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;

  const extensionRoot = chrome.runtime.getURL('');
  if (typeof sender.url === 'string' && sender.url.startsWith(extensionRoot)) return true;

  const pageUrl = sender.tab?.url || sender.url;
  return CONTENT_SCRIPT_MESSAGE_TYPES.has(request.type) && isLimovaUrl(pageUrl);
}

async function handleMessage(request, sender) {
  await initializationPromise;
  if (trainingState.active && [
    'USER_MESSAGE', 'ANALYZE_PAGE', 'TAKE_SCREENSHOT', 'NEXT_STEP',
    'VOICE_ACTION_REQUEST', 'VOICE_TEXT_INPUT_REQUEST', 'VOICE_SCROLL_REQUEST', 'VOICE_KB_SEARCH',
    'CONFIRM_ACTION'
  ].includes(request.type)) {
    return { ok: false, trainingMode: true, error: 'Mode formateur actif : Charly observe sans agir.' };
  }
  switch (request.type) {
    case 'USER_MESSAGE':
      return handleUserMessage(request.text);

    case 'ANALYZE_PAGE':
    case 'TAKE_SCREENSHOT': // Backward compatibility with 2.1.x sidebar sessions.
      return handleTakeScreenshot();

    case 'NEXT_STEP':
      return handleNextStep();

    case 'MODAL_DETECTED':
      return handleModalDetected(sender, request.modal || {});

    case 'USER_PAGE_INTERACTION':
      return handleUserPageInteraction(request.interaction || {}, sender);

    case 'GET_STATE':
      return {
        conversationHistory: sessionState.conversationHistory,
        isActive: sessionState.isActive,
        onboardingPlan: sessionState.onboardingPlan,
        training: trainingState.active ? trainingState.session : null,
        evaluation: evaluationState.active ? { run: evaluationState.run, testCase: evaluationState.testCase, content: evaluationState.content } : null,
        extensionVersion: chrome.runtime.getManifest().version,
        auth: await getCharlyAuthState(false),
        copilot: await getCopilotBootstrap(false).catch(() => ({ available: false, enabled: false })),
        capabilities: { training: true, realEvaluation: true, longTrainingRecording: true, domPopups: true, externalPopupLifecycle: true, charlyOtp: true }
      };

    case 'AUTH_GET_STATE':
      return getCharlyAuthState(request.validate === true);

    case 'AUTH_REQUEST_OTP':
      return requestCharlyOtp(request.email);

    case 'AUTH_VERIFY_OTP':
      return verifyCharlyOtp(request.challenge, request.code);

    case 'AUTH_LOGOUT':
      await clearCharlyAuthSession(false);
      handleResetSession();
      return { ok: true, authenticated: false };

    case 'LIMOVA_PROFILE':
      return syncLimovaProfile(request.profile);

    case 'GET_SESSION_STATE':
      return { active: sessionState.isActive, training: trainingState.active };

    case 'GET_SETTINGS':
      return { hasApiKey: true }; // Keys are on the proxy server

    case 'SAVE_SETTINGS':
      return { ok: true }; // Keys are managed server-side now

    case 'GET_LOGS':
    case 'RUN_DIAGNOSTICS':
      return runDiagnostics(request.client || {});

    case 'DIAGNOSTIC_EVENT':
      return recordClientDiagnostic(request);

    case 'RESET_SESSION':
      return handleResetSession();

    case 'SWITCH_TO_LOCKED_TAB':
      if (sessionState.lockedTabId) {
        await chrome.tabs.update(sessionState.lockedTabId, { active: true });
      }
      return { ok: true };

    case 'DISMISS_ONBOARDING':
      sessionState.onboardingPlan = null;
      await chrome.storage.local.set({ limova_onboarding_dismissed: true });
      scheduleSave();
      Logger.log('background', 'Onboarding dismissed by user');
      return { ok: true };

    case 'SET_LANG':
      if (request.lang) {
        currentLang = request.lang;
        Logger.log('background', `Language switched to: ${currentLang}`);
      }
      return { ok: true };

    case 'AI_PROCESSING_CONSENT':
      await chrome.storage.local.set({ [AI_CONSENT_KEY]: !!request.granted });
      return { ok: true };

    case 'GET_PRIVACY_STATE': {
      const state = await chrome.storage.local.get(AI_CONSENT_KEY);
      const memory = await getCopilotBootstrap(false).catch(() => null);
      return {
        aiProcessing: state[AI_CONSENT_KEY] === true,
        aiProcessingDecided: state[AI_CONSENT_KEY] !== undefined,
        memoryEnabled: memory?.enabled !== false,
        memoryAvailable: memory?.available === true
      };
    }

    case 'SET_MEMORY_PREFERENCE':
      return setCopilotMemoryPreference(request.enabled === true);

    case 'EXPORT_COPILOT_DATA':
      return exportCopilotData();

    case 'DELETE_COPILOT_DATA':
      return deleteCopilotData();

    case 'CONFIRM_ACTION':
      return confirmPendingAction(request.actionId);

    case 'CANCEL_ACTION':
      return cancelPendingAction(request.actionId);

    case 'GET_LIVE_TOKEN':
      return getLiveToken(request.context || {});

    case 'VOICE_CONTEXT_REQUEST':
      return runEvaluatedVoiceTool(
        ['inspect_current_page', 'verify_expected_result', 'capture_current_view'].includes(request.toolName)
          ? request.toolName
          : 'inspect_current_page',
        '',
        () => getFreshVoiceContext(null, { capture: request.capture === true })
      );

    case 'VOICE_TRANSCRIPT':
      return storeVoiceTranscript(request.role, request.text);

    case 'VOICE_ACTION_REQUEST':
      return runEvaluatedVoiceTool(
        ['click_element', 'navigate_internal'].includes(request.toolName) ? request.toolName : 'click_element',
        request.targetLabel,
        () =>
        proposeVoiceAction(request.elementId, request.contextVersion, {
          explicitRequest: request.explicitRequest === true,
          targetLabel: request.targetLabel
        })
      );

    case 'VOICE_TEXT_INPUT_REQUEST':
      return runEvaluatedVoiceTool('fill_field', request.targetLabel, () =>
        typeVoiceText(request.elementId, request.text, request.contextVersion, request.targetLabel)
      );

    case 'VOICE_SCROLL_REQUEST':
      return runEvaluatedVoiceTool('scroll_page', '', () =>
        scrollVoicePage(request.direction, request.amount, request.elementId, request.contextVersion)
      );

    case 'VOICE_KB_SEARCH':
      return runEvaluatedVoiceTool('search_knowledge_base', '', () => searchVoiceKnowledge(request.query));

    case 'VOICE_SESSION_STATE':
      voiceSessionActive = request.active === true;
      if (voiceSessionActive && activeAbortController) activeAbortController.abort();
      if (sessionState.lockedTabId) {
        sendContentMessage(sessionState.lockedTabId, {
          type: 'SESSION_STATE',
          active: sessionState.isActive || voiceSessionActive
        }).catch(() => {});
      }
      Logger.event('voice', voiceSessionActive ? 'VOICE_SESSION_MARKED_ACTIVE' : 'VOICE_SESSION_MARKED_INACTIVE');
      return { ok: true };

    case 'START_TRAINING':
      return startTraining(request.token);

    case 'STOP_TRAINING':
      return stopTraining(request.token);

    case 'CANCEL_TRAINING':
      return cancelTraining();

    case 'TRAINING_EVENT':
      return handleTrainingEvent(request.event || {}, sender);

    case 'START_EVALUATION':
      return startEvaluation(request.token);

    case 'COMPLETE_EVALUATION':
      return completeEvaluationRun(request.verdict);

    case 'CANCEL_EVALUATION':
      return cancelEvaluation();

    default:
      return { error: 'Unknown message type' };
  }
}

function recordClientDiagnostic(request) {
  const component = ['voice', 'sidebar', 'permission_page'].includes(request.component)
    ? request.component
    : 'extension_page';
  const code = String(request.code || 'CLIENT_EVENT').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
  const data = request.data || null;
  const errorCode = /(?:^|_)(?:FAILED|ERROR|TIMEOUT|DENIED|BLOCKED|UNAVAILABLE|INVALID)$/.test(code);
  const warningCode = /(?:^|_)(?:DISMISSED|RETRY|RECOVERY_SCHEDULED|MISMATCH)$/.test(code)
    || (code === 'LIVE_WS_CLOSED' && data?.clean === false);
  Logger.record(
    errorCode ? 'ERROR' : warningCode ? 'WARN' : 'INFO',
    component,
    code,
    code,
    data,
    request.operationId || null
  );
  return { ok: true };
}

async function startTraining(rawToken) {
  const token = String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code d’entraînement invalide.' };
  if (evaluationState.active) return { ok: false, error: 'Termine d’abord le test en conditions réelles.' };
  const tab = await getActiveLimovaTab();
  if (!tab?.id) return { ok: false, error: 'Ouvre Limova avant de démarrer la démonstration.' };
  let response;
  try {
    response = await fetch(`${TRAINING_API_URL}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  } catch (error) {
    Logger.warn('training', 'TRAINING_CONNECTION_FAILED', { error: error?.name || 'network' });
    return { ok: false, error: 'Le Studio est momentanément inaccessible. Réessaie dans quelques instants.' };
  }
  const session = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: session.error || 'Démonstration introuvable.' };
  if (session.recordingReady) {
    const completed = await fetch(`${TRAINING_API_URL}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => null);
    if (!completed?.ok) return { ok: false, error: 'La vidéo précédente est disponible dans le Studio. Finalise-la depuis la fiche du tutoriel.' };
    Logger.event('training', 'TRAINING_RECOVERED_ON_CONNECT', { sessionId: session.id });
    return { ok: true, recovered: true, session };
  }
  if (activeAbortController) activeAbortController.abort();
  sessionState.isActive = false;
  lastUserMessage = '';
  pendingActions.clear();
  trainingEventQueue = Promise.resolve();
  pendingTrainingOutcomeTasks.clear();
  recentTrainingContextEvents.clear();
  trainingState = { active: true, stopping: false, token, session };
  await persistTrainingState();
  try {
    lockTab(tab.id, { activateAssistant: false });
    await sendContentMessage(tab.id, { type: 'SESSION_STATE', active: false }).catch(() => {});
    await sendContentMessage(tab.id, { type: 'TRAINING_STATE', active: true });
    const context = await getPageContext(tab.id).catch(() => '');
    await recordTrainingEvent({ kind: 'navigation', path: privacySafeUrl(tab.url), label: `Départ · ${session.title}`, payload: { context: context.slice(0, 8000) } });
    await recordTrainingContext(context, tab.url);
  } catch (error) {
    Logger.warn('training', 'TRAINING_START_ROLLBACK', { sessionId: session.id, error: error?.name || 'unknown' });
    await cancelTraining();
    return { ok: false, error: 'La page Limova n’a pas pu être préparée. L’essai a été archivé proprement : recommence depuis le Studio.' };
  }
  Logger.event('training', 'TRAINING_STARTED', { sessionId: session.id, agentKey: session.agentKey });
  broadcastToSidebar({ type: 'TRAINING_STATUS', active: true, session });
  return { ok: true, session };
}

async function recordTrainingContext(context, url) {
  if (!context) return;
  const path = privacySafeUrl(url) || '/';
  await recordTrainingEvent({ kind: 'page_context', path, label: 'Structure de page observée', payload: { context: context.slice(0, 8000) } });
  const network = context.match(/\[network\][\s\S]*?(?=\n\[[^\]]+\]|$)/)?.[0];
  if (network) await recordTrainingEvent({ kind: 'network', path, label: 'Requêtes techniques observées', payload: { summary: network.slice(0, 8000) } });
}

async function getPageNetworkTrace(tabId, since = 0) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (minimumTimestamp) => (window.__limova_network_events || [])
        .filter(event => Number(event.timestamp) >= minimumTimestamp)
        .slice(-20),
      args: [Number(since) || 0]
    });
    return Array.isArray(results?.[0]?.result) ? results[0].result : [];
  } catch (_) {
    return [];
  }
}

function scheduleTrainingOutcome(rawEvent, tabId) {
  if (!tabId || rawEvent.kind !== 'click') return;
  const payload = rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
  const task = new Promise(resolve => setTimeout(resolve, 700)).then(async () => {
    if (!trainingState.active) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !isLimovaUrl(tab.url)) return;
    const [context, network] = await Promise.all([
      getPageContext(tabId).catch(() => ''),
      getPageNetworkTrace(tabId, Number(payload.capturedAt) || Date.now() - 2_000),
    ]);
    const networkSummary = network.map(event => {
      const status = Number(event.status) ? ` status:${Number(event.status)}` : '';
      return `${String(event.method || 'GET').slice(0, 10)} ${String(event.target || '').slice(0, 300)}${status} ${Math.max(0, Number(event.durationMs) || 0)}ms`;
    }).join('\n').slice(0, 8_000);
    await recordTrainingEvent({
      kind: 'page_context',
      path: privacySafeUrl(tab.url),
      label: `Résultat après clic · ${String(rawEvent.label || 'Contrôle').slice(0, 220)}`,
      payload: {
        phase: 'after_click',
        gestureId: String(payload.gestureId || '').slice(0, 100),
        actionLabel: String(rawEvent.label || '').slice(0, 240),
        context: context.slice(0, 8_000),
        networkSummary,
      }
    });
  }).catch(error => Logger.warn('training', 'Post-click outcome capture failed', { error: error?.name || 'unknown' }));
  pendingTrainingOutcomeTasks.add(task);
  task.finally(() => pendingTrainingOutcomeTasks.delete(task));
}

async function handleTrainingEvent(rawEvent, sender) {
  const result = await recordTrainingEvent(rawEvent);
  if (result?.ok && rawEvent?.kind === 'click') scheduleTrainingOutcome(rawEvent, sender?.tab?.id || sessionState.lockedTabId);
  return result;
}

async function recordTrainingEvent(rawEvent) {
  if (!trainingState.active || trainingState.stopping || !trainingState.token) return { ok: false, error: 'Aucun entraînement actif.' };
  const event = { kind: String(rawEvent.kind || ''), path: privacySafeUrl(rawEvent.path || sessionState.lastUrl || '') || '/', label: String(rawEvent.label || '').slice(0, 500), payload: rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {} };
  if (['page_context', 'network'].includes(event.kind)
    && !/^Fenêtre d’autorisation externe/.test(event.label)) {
    const signature = `${event.kind}|${event.path}|${event.label}`;
    const previousAt = recentTrainingContextEvents.get(signature) || 0;
    if (Date.now() - previousAt < 3_000) return { ok: true, deduplicated: true };
    recentTrainingContextEvents.set(signature, Date.now());
  }
  const token = trainingState.token;
  const queued = trainingEventQueue.then(async () => {
    const response = await fetch(`${TRAINING_API_URL}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
    if (!response.ok) Logger.warn('training', 'TRAINING_EVENT_REJECTED', { kind: event.kind, status: response.status });
    return { ok: response.ok };
  });
  trainingEventQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function stopTraining(rawToken) {
  const token = trainingState.token || String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code de démonstration indisponible.' };
  if (trainingState.active && sessionState.lockedTabId) {
    await sendContentMessage(sessionState.lockedTabId, { type: 'TRAINING_STATE', active: false }).catch(() => {});
  }
  if (trainingState.active) {
    await Promise.allSettled([...pendingTrainingOutcomeTasks]);
    trainingState.stopping = true;
    await trainingEventQueue;
  }
  let response;
  try {
    response = await fetch(`${TRAINING_API_URL}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    trainingState.stopping = false;
    await persistTrainingState();
    Logger.warn('training', 'TRAINING_COMPLETION_RETRY_REQUIRED', { error: error?.name || 'network' });
    return { ok: false, error: 'Le Studio est momentanément inaccessible. Réessaie la finalisation.' };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    trainingState.stopping = false;
    await persistTrainingState();
    Logger.event('training', 'TRAINING_COMPLETION_FAILED', { sessionId: trainingState.session?.id || null, status: response.status });
    return { ok: false, error: payload.error || 'La démonstration n’a pas pu être terminée.' };
  }
  Logger.event('training', 'TRAINING_COMPLETED', { sessionId: trainingState.session?.id || payload.id || null });
  trainingState = { active: false, stopping: false, token: null, session: null };
  await persistTrainingState();
  broadcastToSidebar({ type: 'TRAINING_STATUS', active: false, completed: true });
  return { ok: true };
}

async function cancelTraining() {
  const token = trainingState.token;
  if (sessionState.lockedTabId) {
    await sendContentMessage(sessionState.lockedTabId, { type: 'TRAINING_STATE', active: false }).catch(() => {});
  }
  const sessionId = trainingState.session?.id || null;
  const lockedTrainingTabId = trainingState.active ? sessionState.lockedTabId : null;
  trainingState = { active: false, stopping: false, token: null, session: null };
  if (lockedTrainingTabId) {
    sessionState.lockedTabId = null;
    scheduleSave();
  }
  await persistTrainingState();
  trainingEventQueue = Promise.resolve();
  pendingTrainingOutcomeTasks.clear();
  recentTrainingContextEvents.clear();
  let serverResult = null;
  if (token) {
    // Best effort, but awaited: the MV3 worker must stay alive long enough to
    // tell the Studio that this capture cannot be resumed. An already uploaded
    // recording remains recoverable server-side.
    const response = await fetch(`${TRAINING_API_URL}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }).catch(error => Logger.warn('training', 'TRAINING_CANCELLATION_SYNC_FAILED', {
      error: error?.name || 'network'
    }));
    if (response?.ok) serverResult = await response.json().catch(() => null);
  }
  broadcastToSidebar({ type: 'TRAINING_STATUS', active: false, cancelled: true });
  Logger.event('training', 'TRAINING_CANCELLED_LOCALLY', { sessionId });
  return { ok: true, recovered: serverResult?.recovered === true, status: serverResult?.status || null };
}

async function evaluationFetch(path, options = {}) {
  if (!evaluationState.token && !options.token) return null;
  const token = options.token || evaluationState.token;
  return fetch(`${EVALUATION_API_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body || {})
  });
}

async function startEvaluation(rawToken) {
  const token = String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code de test invalide.' };
  if (trainingState.active) return { ok: false, error: 'Termine d’abord la démonstration en cours.' };
  if (evaluationState.active) return { ok: false, error: 'Un test est déjà en cours. Termine-le avant d’en lancer un autre.' };
  const tab = await getActiveLimovaTab();
  if (!tab?.id) return { ok: false, error: 'Ouvre Limova avant de lancer le test.' };
  const response = await evaluationFetch('connect', { token, body: { extensionVersion: chrome.runtime.getManifest().version } });
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) return { ok: false, error: data?.error || 'Test introuvable ou expiré.' };
  if (activeAbortController) activeAbortController.abort();
  evaluationState = { active: true, token, run: data.run, testCase: data.case, content: { id: data.content?.id, title: data.content?.title, versionId: data.content?.versionId } };
  sessionState.conversationHistory = [];
  sessionState.remoteSessionId = null;
  sessionState.isActive = true;
  lockTab(tab.id, { activateAssistant: true });
  await chrome.storage.session.set({ charly_evaluation_active: { token, run: data.run, testCase: data.case, content: evaluationState.content } });
  scheduleSave();
  Logger.event('evaluation', 'REAL_EVALUATION_STARTED', { runId: data.run?.id || null, caseKind: data.case?.kind || null });
  return { ok: true, run: data.run, testCase: data.case, content: evaluationState.content };
}

async function recordEvaluationEvent(event) {
  if (!evaluationState.active || !evaluationState.token) return;
  await evaluationFetch('events', { body: event }).catch(() => null);
}

async function runEvaluatedVoiceTool(toolName, targetLabel, operation) {
  const result = await operation();
  if (evaluationState.active) {
    await recordEvaluationEvent({
      kind: 'tool_result',
      toolName,
      status: result?.retryWithFreshContext === true
        ? 'not_found'
        : result?.status === 'unexpected'
        ? 'unexpected'
        : result?.ok
          ? 'ok'
          : result?.clarificationRequired
            ? 'ambiguous'
            : 'blocked',
      path: sessionState.lastUrl || '',
      targetLabel: String(targetLabel || '').slice(0, 300),
      contextVersion: Number(result?.contextVersion || pageContextVersion || 0)
    });
  }
  return result;
}

async function completeEvaluationRun(verdict) {
  if (!evaluationState.active || !['correct', 'problem'].includes(verdict)) return { ok: false, error: 'Aucun test actif.' };
  const response = await evaluationFetch('complete', { body: { verdict } });
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) return { ok: false, error: data?.error || 'Le résultat n’a pas pu être transmis.' };
  Logger.event('evaluation', data.run?.status === 'passed' ? 'REAL_EVALUATION_PASSED' : 'REAL_EVALUATION_FAILED', { runId: evaluationState.run?.id || null, score: data.run?.score ?? null });
  evaluationState = { active: false, token: null, run: null, testCase: null, content: null };
  await chrome.storage.session.remove('charly_evaluation_active');
  sessionState.conversationHistory = [];
  sessionState.remoteSessionId = null;
  scheduleSave();
  return { ok: true, run: data.run, suite: data.suite };
}

async function cancelEvaluation() {
  evaluationState = { active: false, token: null, run: null, testCase: null, content: null };
  await chrome.storage.session.remove('charly_evaluation_active');
  sessionState.conversationHistory = [];
  sessionState.remoteSessionId = null;
  scheduleSave();
  return { ok: true };
}

function summarizeRecentOperationalIssues(logs, now = Date.now(), windowMs = 15 * 60_000) {
  const recent = (Array.isArray(logs) ? logs : []).filter(entry => {
    const timestamp = Date.parse(entry?.timestamp || '');
    return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= windowMs;
  });
  const blockedCodes = new Set([
    'ACTION_SENSITIVE_BLOCKED',
    'ACTION_INTENT_MISMATCH',
    'ACTION_CONTEXT_CHANGED',
    'ACTION_EXECUTION_FAILED',
    'ACTION_EFFECT_UNVERIFIED',
    'TEXT_INPUT_TARGET_REJECTED',
    'TEXT_INPUT_RECOVERY_EXHAUSTED'
  ]);
  const blockedActions = recent.filter(entry => entry.component === 'action' && blockedCodes.has(entry.code));
  const popupOpened = recent.filter(entry => entry.code === 'EXTERNAL_AUTH_POPUP_OPENED');
  const popupClosed = recent.filter(entry => entry.code === 'EXTERNAL_AUTH_POPUP_CLOSED');
  const maxPopupCount = popupClosed.reduce((maximum, entry) => Math.max(maximum, Number(entry?.data?.popupCount || 0)), 0);
  const popupFlowStuck = Boolean(externalPopupFlow
    && now - Number(externalPopupFlow.openedAt || now) > 15_000);
  return {
    blockedActionCount: blockedActions.length,
    blockedActionCodes: [...new Set(blockedActions.map(entry => entry.code))],
    popupOpenedCount: popupOpened.length,
    popupClosedCount: popupClosed.length,
    maxPopupCount,
    popupFlowStuck,
    popupChurn: popupFlowStuck || maxPopupCount >= 2 || popupClosed.length >= 2 || popupOpened.length >= 3
  };
}

async function runDiagnostics(client = {}) {
  const incidentId = Logger.createOperationId('incident');
  const checks = [];
  const addCheck = (name, status, detail, code) => {
    checks.push({ name, status, detail, code });
    Logger.event('diagnostics', code, { status, detail }, incidentId);
  };

  addCheck(
    'extension',
    'ok',
    `Version ${chrome.runtime.getManifest().version}, service worker actif`,
    'DIAGNOSTIC_EXTENSION_OK'
  );

  try {
    await chrome.storage.session.set({ limova_diagnostic_probe: Date.now() });
    await chrome.storage.session.remove('limova_diagnostic_probe');
    addCheck('diagnosticStorage', 'ok', 'Journal de session disponible', 'DIAGNOSTIC_STORAGE_OK');
  } catch (error) {
    addCheck('diagnosticStorage', 'error', 'Journal de session indisponible', 'DIAGNOSTIC_STORAGE_FAILED');
    Logger.error('diagnostics', 'Diagnostic storage probe failed', error, 'DIAGNOSTIC_STORAGE_FAILED', incidentId);
  }

  const consent = await chrome.storage.local.get(AI_CONSENT_KEY).catch(() => ({}));
  addCheck(
    'aiConsent',
    consent[AI_CONSENT_KEY] === true ? 'ok' : 'info',
    consent[AI_CONSENT_KEY] === true ? 'Traitement IA autorisé' : 'Traitement IA non activé',
    'DIAGNOSTIC_CONSENT_STATE'
  );

  const tab = await getLimovaTabForAuthentication().catch(() => null);
  if (!tab?.id) {
    addCheck('limovaTab', 'error', 'Aucun onglet Limova ouvert', 'DIAGNOSTIC_LIMOVA_TAB_MISSING');
    addCheck('contentScript', 'error', 'Content script non vérifiable sans onglet Limova', 'DIAGNOSTIC_CONTENT_SCRIPT_UNAVAILABLE');
  } else {
    addCheck('limovaTab', 'ok', 'Onglet Limova détecté', 'DIAGNOSTIC_LIMOVA_TAB_OK');
    try {
      const pong = await Promise.race([
        sendContentMessage(tab.id, { type: 'DIAGNOSTIC_PING' }),
        new Promise((_, reject) => setTimeout(() => reject(codedError('CONTENT_SCRIPT_TIMEOUT', 'Content script timeout')), 2000))
      ]);
      addCheck(
        'contentScript',
        pong?.ok ? 'ok' : 'error',
        pong?.ok ? `Content script joignable (${pong.documentReadyState || 'ready'})` : 'Réponse content script invalide',
        pong?.ok ? 'DIAGNOSTIC_CONTENT_SCRIPT_OK' : 'DIAGNOSTIC_CONTENT_SCRIPT_INVALID'
      );
    } catch (error) {
      addCheck('contentScript', 'error', 'Content script absent ou non joignable', 'DIAGNOSTIC_CONTENT_SCRIPT_UNREACHABLE');
      Logger.error('diagnostics', 'Content script probe failed', error, 'DIAGNOSTIC_CONTENT_SCRIPT_UNREACHABLE', incidentId);
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${PROXY_URL}/healthz`, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);
    addCheck(
      'proxy',
      response.ok ? 'ok' : 'error',
      response.ok ? `Proxy joignable (${response.status})` : `Proxy indisponible (${response.status})`,
      response.ok ? 'DIAGNOSTIC_PROXY_OK' : 'DIAGNOSTIC_PROXY_HTTP_ERROR'
    );
  } catch (error) {
    addCheck('proxy', 'error', 'Proxy indisponible ou délai dépassé', 'DIAGNOSTIC_PROXY_UNREACHABLE');
    Logger.error('diagnostics', 'Proxy health probe failed', error, 'DIAGNOSTIC_PROXY_UNREACHABLE', incidentId);
  }

  const micState = ['granted', 'prompt', 'denied'].includes(client.microphonePermission)
    ? client.microphonePermission
    : 'unknown';
  const micStatus = client.mediaDevicesSupported === false || micState === 'denied' ? 'error' : micState === 'granted' ? 'ok' : 'info';
  addCheck(
    'microphone',
    micStatus,
    client.mediaDevicesSupported === false ? 'API microphone indisponible' : `Permission microphone : ${micState}`,
    micStatus === 'error' ? 'DIAGNOSTIC_MICROPHONE_BLOCKED' : 'DIAGNOSTIC_MICROPHONE_STATE'
  );

  const voiceEntries = Logger.getLogs().filter(entry => entry.component === 'voice');
  const latestVoiceSuccess = voiceEntries.findLast(entry => entry.code === 'LIVE_SETUP_COMPLETED');
  const latestVoiceFailure = voiceEntries.findLast(entry => {
    if (entry.code === 'VOICE_REPLY_FALLBACK_SHOWN') return true;
    if (entry.level !== 'ERROR') return false;
    return /^(LIVE_|VOICE_(SESSION|MICROPHONE|PERMISSION|AUDIO|SOCKET|CONNECTION))/.test(String(entry.code || ''));
  });
  const failureIsCurrent = latestVoiceFailure
    && (!latestVoiceSuccess || Date.parse(latestVoiceFailure.timestamp) > Date.parse(latestVoiceSuccess.timestamp))
    && Date.now() - Date.parse(latestVoiceFailure.timestamp) < 30 * 60_000;
  if (failureIsCurrent) {
    addCheck(
      'voice',
      'error',
      latestVoiceFailure.code === 'VOICE_REPLY_FALLBACK_SHOWN'
        ? 'Une réponse vocale récente n’est pas arrivée après deux relances'
        : `Dernière connexion vocale en échec (${latestVoiceFailure.code})`,
      'DIAGNOSTIC_VOICE_RECENT_FAILURE'
    );
  } else if (latestVoiceSuccess) {
    addCheck('voice', 'ok', 'Dernière connexion vocale établie', 'DIAGNOSTIC_VOICE_OK');
  } else {
    addCheck('voice', 'info', 'Aucune connexion vocale récente à évaluer', 'DIAGNOSTIC_VOICE_NOT_TESTED');
  }

  const operationalIssues = summarizeRecentOperationalIssues(Logger.getLogs());
  addCheck(
    'pageActions',
    operationalIssues.blockedActionCount >= 2 ? 'error' : operationalIssues.blockedActionCount === 1 ? 'info' : 'ok',
    operationalIssues.blockedActionCount >= 2
      ? `${operationalIssues.blockedActionCount} actions bloquées ou échouées récemment`
      : operationalIssues.blockedActionCount === 1
        ? 'Une action a été bloquée récemment'
        : 'Aucun blocage d’action récent',
    operationalIssues.blockedActionCount >= 2 ? 'DIAGNOSTIC_ACTIONS_REPEATEDLY_BLOCKED' : 'DIAGNOSTIC_ACTIONS_STATE'
  );
  addCheck(
    'oauthStability',
    operationalIssues.popupChurn ? 'error' : operationalIssues.popupOpenedCount > 0 ? 'info' : 'ok',
    operationalIssues.popupFlowStuck
      ? 'Une fenêtre OAuth semble rester bloquée'
      : operationalIssues.popupChurn
        ? `${operationalIssues.popupOpenedCount} fenêtres OAuth détectées dans ${operationalIssues.popupClosedCount} cycle(s)`
        : operationalIssues.popupOpenedCount > 0
          ? 'Un cycle OAuth récent s’est terminé normalement'
          : 'Aucune instabilité OAuth récente',
    operationalIssues.popupChurn ? 'DIAGNOSTIC_OAUTH_POPUP_CHURN' : 'DIAGNOSTIC_OAUTH_STATE'
  );

  const failing = checks.filter(check => check.status === 'error');
  const probableCause = failing[0]?.detail || null;
  const diagnostic = {
    ok: failing.length === 0,
    status: failing.length === 0 ? 'healthy' : 'degraded',
    incidentId,
    checks,
    probableCause,
    client: Logger._sanitize({
      browser: client.browser || 'unknown',
      language: client.language || 'unknown'
    })
  };
  Logger.event('diagnostics', 'DIAGNOSTIC_COMPLETED', {
    status: diagnostic.status,
    failingChecks: failing.map(check => check.code)
  }, incidentId);
  await Logger.flush();
  return { ...diagnostic, logs: Logger.getLogsAsText(diagnostic) };
}

// ============================================================================
// User Message Handler
// ============================================================================

function rememberUserTurn(text, source = 'text') {
  const message = String(text || '').trim().slice(0, 8_000);
  if (!message) return null;
  userTurnSequence += 1;
  lastUserMessage = message;
  lastUserTurn = {
    id: `user-turn-${userTurnSequence}`,
    message,
    source,
    createdAt: Date.now()
  };
  return lastUserTurn;
}

async function handleUserMessage(text) {
  text = String(text || '').trim().slice(0, 8_000);
  if (!text) return { ok: false, error: 'Message vide.' };
  rememberUserTurn(text, 'text');
  if (!(await hasAIProcessingConsent())) {
    broadcastToSidebar({ type: 'CONSENT_REQUIRED' });
    return { ok: false, consentRequired: true };
  }
  const tab = await getActiveLimovaTab();
  if (tab && !sessionState.lockedTabId) lockTab(tab.id);
  const operationId = Logger.createOperationId('chat');

  Logger.logTurnStart('user_message', {
    url: privacySafeUrl(tab?.url) || 'unknown',
    hasPageContext: !!tab,
    historyLength: sessionState.conversationHistory.length,
    operationId
  });
  Logger.logUserMessage(text, privacySafeUrl(tab?.url), operationId);

  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Analyse...' });

  try {
    // Initialize onboarding inside the guarded request flow so an expired
    // Limova session produces the same actionable error as every AI request.
    const { limova_onboarding_dismissed } = await chrome.storage.local.get('limova_onboarding_dismissed');
    if (!sessionState.onboardingPlan && sessionState.conversationHistory.length === 0 && !limova_onboarding_dismissed) {
      const publishedTemplate = await getPublishedOnboardingTemplate();
      sessionState.onboardingPlan = createOnboardingPlan(publishedTemplate);
      const current = sessionState.onboardingPlan.steps[0];
      broadcastToSidebar({ type: 'STEP_UPDATE', step: current.name, progress: `1 / ${sessionState.onboardingPlan.steps.length}` });
      Logger.log('background', 'Onboarding plan initialized');
      scheduleSave();
    }
    const copilot = await getCopilotBootstrap(false).catch(() => null);
    if (copilot?.sessionId && !sessionState.remoteSessionId) {
      sessionState.remoteSessionId = copilot.sessionId;
      scheduleSave();
    }
    let pageAnalysis = null;
    let pageContext = '';
    let consoleLogs = '';

    if (tab) {
      pageContext = await getPageContext(tab.id);
      if (!copilot?.serverOrchestration) {
        pageAnalysis = await capturePageAnalysis(tab.id, operationId);
        consoleLogs = await getConsoleLogs(tab.id);
      }
    }

    if (copilot?.serverOrchestration) {
      await sendToCopilotV2({
        tab,
        userMessage: text,
        pageContext,
        operationId
      });
      return { ok: true };
    }

    await sendToGemini({
      pageAnalysis,
      url: privacySafeUrl(tab?.url),
      userMessage: text,
      pageContext,
      consoleLogs,
      trigger: sessionState.conversationHistory.length === 0 ? 'doc_load' : 'user_message',
      operationId
    });
  } catch (error) {
    const code = errorCodeOf(error);
    Logger.error('background', 'User message handling failed', error, code, operationId);
    broadcastToSidebar({ type: 'ERROR', content: `Erreur : ${error.message}`, code });
  }

  return { ok: true };
}

// ============================================================================
// Page analysis handlers
// ============================================================================

async function handleTakeScreenshot() {
  if (!(await hasAIProcessingConsent())) {
    broadcastToSidebar({ type: 'CONSENT_REQUIRED' });
    return { ok: false, consentRequired: true };
  }
  const tab = await getActiveLimovaTab();
  if (!tab) {
    broadcastToSidebar({ type: 'ERROR', content: 'Ouvre new.limova.ai pour analyser une page.' });
    return { ok: false };
  }

  if (!sessionState.lockedTabId) lockTab(tab.id);
  const operationId = Logger.createOperationId('analysis');

  // The camera button is also useful during a Live conversation, but it must
  // never start the legacy text orchestrator in parallel with Gemini Live.
  // In voice mode it only refreshes the current DOM + ephemeral screenshot.
  if (voiceSessionActive) {
    try {
      const fresh = await getFreshVoiceContext(operationId, { capture: true });
      broadcastToSidebar({
        type: 'VOICE_PAGE_CONTEXT',
        pageContext: fresh.pageContext,
        contextVersion: fresh.contextVersion,
        source: 'manual_inspection',
        visualCapture: fresh.visualCapture
      });
      Logger.event('voice', 'VOICE_MANUAL_CONTEXT_PUBLISHED', {
        contextVersion: fresh.contextVersion,
        characterCount: fresh.pageContext.length,
        elementCount: fresh.elementCount,
        hasVisualCapture: Boolean(fresh.visualCapture)
      }, operationId);
      return { ok: true, voiceSessionActive: true };
    } catch (error) {
      Logger.warn('voice', 'Manual voice context refresh failed', {
        code: errorCodeOf(error, 'VOICE_CONTEXT_REFRESH_FAILED')
      }, 'VOICE_CONTEXT_REFRESH_FAILED', operationId);
      return { ok: false, voiceSessionActive: true, error: 'La page n’a pas pu être relue.' };
    }
  }

  Logger.logTurnStart('page_analysis_button', { url: privacySafeUrl(tab.url), hasPageContext: true, operationId });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Capture...', ponderingText: 'ponderingCapture' });

  try {
    const pageContext = await getPageContext(tab.id);
    const pageAnalysis = await capturePageAnalysis(tab.id, operationId);
    const consoleLogs = await getConsoleLogs(tab.id);

    await sendToGemini({
      pageAnalysis,
      url: privacySafeUrl(tab.url),
      pageContext,
      consoleLogs,
      trigger: 'page_analysis_button',
      operationId
    });
  } catch (error) {
    const code = errorCodeOf(error, 'PAGE_ANALYSIS_FAILED');
    Logger.error('background', 'Page analysis failed', error, code, operationId);
    broadcastToSidebar({ type: 'ERROR', content: `Erreur d’analyse : ${error.message}`, code });
  }

  return { ok: true };
}

async function handleNextStep() {
  if (!(await hasAIProcessingConsent())) {
    broadcastToSidebar({ type: 'CONSENT_REQUIRED' });
    return { ok: false, consentRequired: true };
  }
  const tab = await getActiveLimovaTab();
  if (!tab) return { ok: false };

  const operationId = Logger.createOperationId('next-step');
  Logger.logTurnStart('next_step', { url: privacySafeUrl(tab.url), hasPageContext: true, operationId });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Étape suivante...' });

  try {
    const pageContext = await getPageContext(tab.id);
    const pageAnalysis = await capturePageAnalysis(tab.id, operationId);
    const consoleLogs = await getConsoleLogs(tab.id);

    await sendToGemini({
      pageAnalysis,
      url: privacySafeUrl(tab.url),
      userMessage: "Continue avec la prochaine étape.",
      pageContext,
      consoleLogs,
      trigger: 'user_message',
      operationId
    });
  } catch (error) {
    const code = errorCodeOf(error, 'NEXT_STEP_FAILED');
    Logger.error('background', 'Next step failed', error, code, operationId);
    broadcastToSidebar({ type: 'ERROR', content: error.message, code });
  }
  return { ok: true };
}

// ============================================================================
// Modal Detection
// ============================================================================

async function handleModalDetected(sender, modal = {}) {
  const tabId = sender?.tab?.id || sessionState.lockedTabId;
  if (!tabId) return { ok: false };

  if (trainingState.active) {
    const context = await getPageContext(tabId).catch(() => '');
    await recordTrainingEvent({
      kind: 'page_context',
      path: sessionState.lastUrl || sender?.tab?.url || '/',
      label: `Popup Limova · ${String(modal.title || 'Fenêtre détectée').slice(0, 180)}`,
      payload: {
        role: String(modal.role || 'dialog').slice(0, 40),
        controls: Array.isArray(modal.controls) ? modal.controls.join(' · ').slice(0, 1000) : '',
        context: context.slice(0, 8000)
      }
    });
  }
  if (!sessionState.isActive) return { ok: true };
  if (!(await hasAIProcessingConsent())) return { ok: false };

  const now = Date.now();
  if (now - sessionState.lastAnalysisTime < MIN_API_INTERVAL) return { ok: false };

  const operationId = Logger.createOperationId('modal');
  Logger.logTurnStart('modal_detected', { url: sessionState.lastUrl, hasPageContext: true, operationId });
  if (!voiceSessionActive) {
    broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Popup détecté...', ponderingText: 'ponderingPopup' });
  }

  try {
    const pageContext = await getPageContext(tabId);
    const pageAnalysis = await capturePageAnalysis(tabId, operationId);

    if (voiceSessionActive) {
      broadcastToSidebar({
        type: 'VOICE_PAGE_CONTEXT',
        pageContext,
        contextVersion: pageContextVersion,
        source: 'modal',
        visualCapture: pageAnalysis
      });
      Logger.event('voice', 'VOICE_MODAL_CONTEXT_PUBLISHED', {
        contextVersion: pageContextVersion,
        characterCount: pageContext.length,
        elementCount: lastPageElements.size
      }, operationId);
      return { ok: true };
    }

    await sendToGemini({
      pageAnalysis,
      url: sessionState.lastUrl || '',
      pageContext,
      trigger: 'modal_detected',
      operationId
    });
  } catch (error) {
    Logger.error('background', 'Modal detection handling failed', error, errorCodeOf(error, 'MODAL_ANALYSIS_FAILED'), operationId);
  }

  return { ok: true };
}

// ============================================================================
// Gemini API
// ============================================================================

function copilotLocale() {
  return currentLang === 'es' ? 'es-ES' : currentLang === 'en' ? 'en-US' : 'fr-FR';
}

async function ensureRemoteCopilotSession() {
  if (sessionState.remoteSessionId) return sessionState.remoteSessionId;
  const bootstrap = await getCopilotBootstrap(true);
  if (bootstrap?.sessionId) {
    sessionState.remoteSessionId = bootstrap.sessionId;
    scheduleSave();
    return bootstrap.sessionId;
  }
  const response = await authorizedProxyFetch('/api/copilot/v2/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.sessionId) throw codedError('COPILOT_SESSION_FAILED', data.error || 'Impossible d’ouvrir la session Charly.');
  sessionState.remoteSessionId = data.sessionId;
  scheduleSave();
  return data.sessionId;
}

async function currentCopilotPage(tab, pageContext = '') {
  const activeTab = tab?.id ? tab : await getActiveLimovaTab();
  const dom = pageContext || (activeTab?.id ? await getPageContext(activeTab.id) : '');
  return {
    url: privacySafeUrl(activeTab?.url || sessionState.lastUrl || '') || LIMOVA_DOMAIN,
    title: String(activeTab?.title || '').slice(0, 500),
    contextVersion: pageContextVersion,
    dom: String(dom || '').slice(0, 80_000)
  };
}

function normalizedCopilotStatus(result) {
  if (result?.status === 'unexpected' || result?.verificationRequired) return 'unexpected';
  if (result?.ok === true) return 'ok';
  if (result?.clarificationRequired) return /plusieurs|ambigu/i.test(String(result.error || '')) ? 'ambiguous' : 'not_found';
  if (result?.status === 'blocked') return 'blocked';
  return 'failed';
}

async function executeCopilotTool(call, userMessage, operationId) {
  const args = call?.args || {};
  let result;
  if (!call?.id || typeof call.name !== 'string') {
    return { callId: String(call?.id || 'invalid'), status: 'failed', contextVersion: pageContextVersion, message: 'Commande invalide.' };
  }
  if (trainingState.active) {
    return { callId: call.id, status: 'blocked', contextVersion: pageContextVersion, message: 'Mode formateur actif : aucune action autorisée.' };
  }
  const requestedVersion = Number(args.contextVersion);
  if (Number.isInteger(requestedVersion)
    && !['inspect_current_page', 'capture_current_view', 'fill_field', 'scroll_page'].includes(call.name)
    && requestedVersion !== pageContextVersion) {
    result = { ok: false, status: 'unexpected', error: 'La version DOM a changé.' };
  } else if (call.name === 'inspect_current_page') {
    const page = await currentCopilotPage(null);
    return { callId: call.id, status: 'ok', contextVersion: page.contextVersion, page };
  } else if (call.name === 'capture_current_view') {
    const page = await currentCopilotPage(null);
    const capture = await capturePageAnalysis(sessionState.lockedTabId, operationId);
    return {
      callId: call.id,
      status: capture ? 'ok' : 'failed',
      contextVersion: page.contextVersion,
      page,
      ...(capture ? { capture } : { message: 'Capture indisponible ; le DOM reste accessible.' })
    };
  } else if (call.name === 'click_element' || call.name === 'navigate_internal') {
    result = await proposeOrExecuteAction(Number(args.elementId), userMessage, {
      toolExplicitRequest: call.name === 'click_element' && args.explicitRequest === true,
      targetLabel: args.targetLabel,
      requestedContextVersion: requestedVersion
    });
  } else if (call.name === 'fill_field') {
    result = await typeVoiceText(Number(args.elementId), String(args.text || ''), requestedVersion, args.targetLabel);
  } else if (call.name === 'scroll_page') {
    result = await scrollVoicePage(args.direction, args.amount, args.elementId, args.contextVersion);
  } else if (call.name === 'verify_expected_result') {
    const page = await currentCopilotPage(null);
    return {
      callId: call.id,
      status: 'ok',
      contextVersion: page.contextVersion,
      page,
      message: `État courant relu après l’action. Attendu : ${String(args.expectation || '').slice(0, 500)}`
    };
  } else {
    return { callId: call.id, status: 'failed', contextVersion: pageContextVersion, message: 'Outil non pris en charge.' };
  }

  const status = result?.status === 'unexpected' ? 'unexpected' : normalizedCopilotStatus(result);
  let pageContext = result?.pageContext || '';
  if (!pageContext && sessionState.lockedTabId) pageContext = await getPageContext(sessionState.lockedTabId).catch(() => '');
  const tab = sessionState.lockedTabId ? await chrome.tabs.get(sessionState.lockedTabId).catch(() => null) : null;
  const page = await currentCopilotPage(tab, pageContext);
  let capture = result?.visualCapture || null;
  if (status !== 'ok' && !capture && sessionState.lockedTabId) {
    // One silent visual recovery. No overlay, bubble or capture-specific status
    // is emitted to the sidebar; the image only lives until the run resumes.
    capture = await capturePageAnalysis(sessionState.lockedTabId, operationId);
  }
  return {
    callId: call.id,
    status,
    contextVersion: page.contextVersion,
    page,
    ...(result?.error ? { message: String(result.error).slice(0, 1_000) } : {}),
    ...(result?.technicalDiagnostics ? { technicalDiagnostics: String(result.technicalDiagnostics).slice(0, 4_000) } : {}),
    ...(capture ? { capture } : {})
  };
}

async function sendToCopilotV2({ tab, userMessage, pageContext, operationId }) {
  if (activeAbortController) activeAbortController.abort();
  activeAbortController = new AbortController();
  const sessionId = await ensureRemoteCopilotSession();
  const idempotencyKey = `${operationId || 'text'}:${userTurnSequence}`;
  const page = await currentCopilotPage(tab, pageContext);
  let response = await authorizedProxyFetch('/api/copilot/v2/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: userMessage,
      source: 'text',
      locale: copilotLocale(),
      idempotencyKey,
      ...(evaluationState.active && evaluationState.token ? { evaluationCode: evaluationState.token } : {}),
      page,
      ...(sessionState.onboardingPlan ? {
        onboarding: {
          revision: String(sessionState.onboardingPlan.revision || sessionState.onboardingPlan.version || 'embedded'),
          activeStep: String(sessionState.onboardingPlan.steps?.[sessionState.onboardingPlan.activeIndex]?.id || ''),
          completedSteps: sessionState.onboardingPlan.steps
            .slice(0, sessionState.onboardingPlan.activeIndex)
            .map(step => String(step.id || ''))
            .filter(Boolean)
        }
      } : {})
    }),
    signal: activeAbortController?.signal
  });
  if ([404, 409, 503].includes(response.status)) {
    copilotBootstrapCache = null;
    copilotBootstrapCacheExpiresAt = 0;
    Logger.warn('copilot', 'ADK unavailable; legacy text fallback used', { status: response.status }, 'ADK_FALLBACK', operationId);
    const fallbackCapture = tab?.id ? await capturePageAnalysis(tab.id, operationId) : null;
    const consoleLogs = tab?.id ? await getConsoleLogs(tab.id) : '';
    return sendToGemini({
      pageAnalysis: fallbackCapture,
      url: privacySafeUrl(tab?.url),
      userMessage,
      pageContext,
      consoleLogs,
      trigger: sessionState.conversationHistory.length === 0 ? 'doc_load' : 'user_message',
      operationId,
      _suppressMemoryTurn: true
    });
  }
  let data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('COPILOT_ADK_FAILED', data.error || 'Charly est temporairement indisponible.');
  let actionCount = 0;
  while (data.type === 'tool_call') {
    actionCount += 1;
    if (actionCount > 6) throw codedError('COPILOT_ACTION_LIMIT', 'Charly s’est arrêtée pour éviter une boucle d’actions.');
    const result = await executeCopilotTool(data.call, userMessage, operationId);
    if (evaluationState.active) await recordEvaluationEvent({
      kind: 'tool_result',
      toolName: data.call?.name,
      status: result.status,
      path: result.page?.url,
      targetLabel: data.call?.args?.targetLabel,
      contextVersion: result.contextVersion
    });
    response = await authorizedProxyFetch(`/api/copilot/v2/runs/${encodeURIComponent(data.runId)}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
      signal: activeAbortController?.signal
    });
    data = await response.json().catch(() => ({}));
    if (!response.ok) throw codedError(response.status === 410 ? 'COPILOT_RUN_EXPIRED' : 'COPILOT_RUN_FAILED', data.error || 'L’action de Charly a expiré. Réessaie.');
  }
  if (data.type !== 'message' || typeof data.content !== 'string') throw codedError('COPILOT_INVALID_RESPONSE', 'Réponse Charly invalide.');
  const content = data.content.trim();
  if (evaluationState.active) await recordEvaluationEvent({ kind: 'response', status: 'ok', contextVersion: page.contextVersion });
  sessionState.conversationHistory.push({ role: 'user', content: userMessage });
  sessionState.conversationHistory.push({ role: 'assistant', content });
  if (sessionState.conversationHistory.length > CONVERSATION_HISTORY_MAX_MESSAGES) {
    sessionState.conversationHistory = sessionState.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
  }
  scheduleSave();
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  broadcastToSidebar({ type: 'GEMINI_RESPONSE', content, hasPageAnalysis: Boolean(pageContext) });
  broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'ready' });
  Logger.logGeminiResponse(content, { adk: true, actionCount }, operationId);
  return { ok: true };
}

async function sendToGemini({
  pageAnalysis,
  url,
  userMessage,
  pageContext,
  consoleLogs,
  trigger,
  operationId = null,
  _retryCount = 0,
  _contextVersion = pageContextVersion,
  _elementSnapshot = new Map(lastPageElements),
  _suppressMemoryTurn = false
}) {
  url = privacySafeUrl(url);
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
    const kbResults = await getKnowledgeContext(searchQuery, {
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
    lang: currentLang
  });

  const userParts = [];
  if (userMessage) {
    userParts.push({ text: `[URL: ${url}]\n\n${userMessage}` });
  } else {
    userParts.push({ text: `[URL: ${url}]\n\nThe user navigated to this page. Analyze what you see and guide them.` });
  }
  if (pageAnalysis?.mimeType && pageAnalysis?.data) {
    userParts.push({
      inlineData: {
        mimeType: pageAnalysis.mimeType,
        data: pageAnalysis.data
      }
    });
    userParts.push({
      text: 'Contexte visuel temporaire de la zone visible. Les pastilles #N correspondent aux identifiants de la carte DOM. Les valeurs de formulaires sont masquées. Utilise l’image pour comprendre la disposition, mais utilise uniquement la carte DOM actuelle pour toute action.'
    });
  }

  // Sliding window: send only the last N messages to Gemini to control token usage.
  // Full history is kept in sessionState for the sidebar, but API calls are bounded.
  const recentHistory = boundedConversationHistory(
    sessionState.conversationHistory,
    CONVERSATION_HISTORY_MAX_MESSAGES,
    CONVERSATION_CONTEXT_MAX_CHARACTERS
  );

  const contents = [];
  for (const msg of recentHistory) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }
  contents.push({ role: 'user', parts: userParts });

  Logger.logApiRequest({
    model: GEMINI_MODEL,
    messageCount: contents.length,
    hasPageContext: Boolean(pageContext),
    hasVisualCapture: Boolean(pageAnalysis?.data),
    systemPromptLength: systemPrompt.length,
    attempt: _retryCount + 1,
    operationId
  });

  const startTime = Date.now();

  try {
    const response = await authorizedProxyFetch('/api/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(userMessage && !_suppressMemoryTurn ? {
          memoryTurn: {
            user: userMessage,
            source: 'text',
            idempotencyKey: `${operationId || 'text'}:${userTurnSequence}`
          }
        } : {})
      }),
      signal: activeAbortController.signal
    });

    if (!response.ok) {
      // Retry on 429 (rate limit) or 503 (high demand) — up to 2 retries
      if ((response.status === 429 || response.status === 503) && _retryCount < 2) {
        const delay = (_retryCount + 1) * 3000;
        Logger.log('background', `Gemini ${response.status}, retry ${_retryCount + 1}/2 in ${delay}ms`);
        broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'analyzing', text: 'Charly réfléchit...' });
        await new Promise(r => setTimeout(r, delay));
        return sendToGemini({
          pageAnalysis,
          url,
          userMessage,
          pageContext,
          consoleLogs,
          trigger,
          operationId,
          _retryCount: _retryCount + 1,
          _contextVersion,
          _elementSnapshot
        });
      }
      let errorMessage = response.status === 429
        ? 'Trop de requêtes, veuillez patienter un moment.'
        : `Gemini Error: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData?.error?.message) errorMessage = errorData.error.message;
        else if (errorData?.error) errorMessage = errorData.error;
      } catch (_) {}
      const code = response.status === 429
        ? 'PROXY_RATE_LIMITED'
        : response.status >= 500
          ? 'GEMINI_HTTP_5XX'
          : `GEMINI_HTTP_${response.status}`;
      throw codedError(code, errorMessage);
    }

    const json = await response.json();

    // A voice session may have started while the legacy request was already
    // returning. Do not let that stale response speak, mutate history or click
    // with the intent owned by the Live session.
    if (voiceSessionActive) {
      Logger.event('voice', 'LEGACY_RESPONSE_SUPPRESSED_DURING_VOICE', {
        trigger,
        responseTimeMs: Date.now() - startTime
      }, operationId);
      return;
    }

    if (!json.candidates?.length) {
      if (json.promptFeedback?.blockReason) {
        throw new Error(`Requête bloquée : ${json.promptFeedback.blockReason}`);
      }
      throw new Error('Pas de réponse de Gemini.');
    }

    const responseText = json.candidates[0]?.content?.parts?.[0]?.text || '';
    if (!responseText) throw new Error('Réponse vide de Gemini.');

    const responseTime = Date.now() - startTime;
    Logger.logApiResponse({ success: true, status: response.status, responseTime, attempt: _retryCount + 1, operationId });

    // Loading screen retry
    if (responseText.trim() === '[LOADING]') {
      const retryCount = (loadingRetries.get(url) || 0) + 1;
      loadingRetries.set(url, retryCount);
      if (retryCount > 3) {
        loadingRetries.delete(url);
        broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'ready' });
        broadcastToSidebar({ type: 'GEMINI_RESPONSE', content: 'La page charge toujours. Relance l’analyse dès qu’elle est prête.', hasPageAnalysis: false });
        return;
      }
      Logger.log('background', `Loading screen detected, retry ${retryCount}/3 in 2s`);
      setTimeout(() => {
        if (sessionState.lockedTabId) handleUrlChange(sessionState.lockedTabId, url, { force: true });
      }, 2000);
      return;
    }
    loadingRetries.delete(url);

    // Onboarding step/complete markers
    let cleanResponse = responseText;

    // Step completion — advance to next step
    if (cleanResponse.includes('{{STEP_COMPLETE}}')) {
      cleanResponse = cleanResponse.replace(/\{\{STEP_COMPLETE\}\}/g, '').trim();
      if (sessionState.onboardingPlan && validateStepCompletion(sessionState.onboardingPlan, url, pageContext, userMessage)) {
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
      } else if (sessionState.onboardingPlan) {
        Logger.warn('background', 'Ignored unverified onboarding completion marker');
      }
    }

    // Full onboarding complete (fallback if Gemini emits this directly)
    if (cleanResponse.includes('{{ONBOARDING_COMPLETE}}')) {
      cleanResponse = cleanResponse.replace(/\{\{ONBOARDING_COMPLETE\}\}/g, '').trim();
      Logger.warn('background', 'Ignored direct onboarding completion marker; local step validation is required');
    }

    // Extract highlight commands (ID-based)
    const highlightCommands = [];
    cleanResponse = cleanResponse.replace(/\{\{HIGHLIGHT:(\d+)\}\}/g, (_, id) => {
      highlightCommands.push(parseInt(id));
      return '';
    });

    const actionCommands = [];
    cleanResponse = cleanResponse.replace(/\{\{ACTION:(\d+)\}\}/g, (_, id) => {
      actionCommands.push(Number.parseInt(id, 10));
      return '';
    });

    cleanResponse = cleanResponse.replace(/\n{3,}/g, '\n\n').trim();

    // Update conversation history
    if (userMessage) {
      sessionState.conversationHistory.push({ role: 'user', content: userMessage });
    }
    sessionState.conversationHistory.push({ role: 'assistant', content: cleanResponse });

    if (sessionState.conversationHistory.length > CONVERSATION_HISTORY_MAX_MESSAGES) {
      sessionState.conversationHistory = sessionState.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
    }

    scheduleSave();
    Logger.logGeminiResponse(cleanResponse, {
      highlightCount: highlightCommands.length,
      actionCount: actionCommands.length
    }, operationId);

    broadcastToSidebar({ type: 'GEMINI_RESPONSE', content: cleanResponse, hasPageAnalysis: Boolean(pageContext) });

    // Execute highlight commands — send each with a staggered delay
    if (highlightCommands.length > 0 && sessionState.lockedTabId) {
      const resolvedHighlights = highlightCommands
        .map(id => resolveElementCommand(id, _contextVersion, _elementSnapshot, 'highlight'))
        .filter(Boolean);
      Logger.log('background', `Highlight: ${resolvedHighlights.map(command => command.id).join(', ') || 'none'}`);
      resolvedHighlights.forEach((command, i) => {
        setTimeout(() => {
          sendContentMessage(sessionState.lockedTabId, {
            type: 'HIGHLIGHT_ELEMENT',
            id: command.id,
            contextVersion: command.contextVersion
          }).catch(() => {});
        }, 500 + i * 1500);
      });
    }

    for (const elementId of actionCommands) {
      const command = resolveElementCommand(elementId, _contextVersion, _elementSnapshot, 'action');
      if (command) await proposeOrExecuteAction(command.id, userMessage || lastUserMessage);
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      Logger.log('background', 'API call aborted (superseded)');
      broadcastToSidebar({ type: 'STATUS_UPDATE', status: 'ready' });
      return;
    }
    Logger.logApiResponse({
      success: false,
      code: errorCodeOf(error, 'GEMINI_REQUEST_FAILED'),
      error: error.message,
      responseTime: Date.now() - startTime,
      attempt: _retryCount + 1,
      operationId
    });
    throw error;
  }
}

// ============================================================================
// Ephemeral visual page analysis
// ============================================================================

async function renderSilentVisualCapture(dataUrl, preparation) {
  let visualStage = 'validate';
  try {
  const original = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!original) return null;

  const hasGeometry = Number(preparation?.viewportWidth) > 0
    && Number(preparation?.viewportHeight) > 0
    && Array.isArray(preparation?.masks)
    && Array.isArray(preparation?.markers);
  // Compatibility with a content script from the previous extension process:
  // it already rendered its privacy overlays before returning.
  if (!hasGeometry) return { mimeType: original[1], data: original[2] };
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return null;

  visualStage = 'decode-source';
  const sourceBinary = atob(original[2]);
  const sourceBytes = new Uint8Array(sourceBinary.length);
  for (let index = 0; index < sourceBinary.length; index += 1) sourceBytes[index] = sourceBinary.charCodeAt(index);
  const sourceBlob = new Blob([sourceBytes], { type: original[1] });
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    visualStage = 'draw';
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const scaleX = bitmap.width / preparation.viewportWidth;
    const scaleY = bitmap.height / preparation.viewportHeight;

    for (const mask of preparation.masks.slice(0, 120)) {
      const left = Math.max(0, Number(mask.left) * scaleX);
      const top = Math.max(0, Number(mask.top) * scaleY);
      const width = Math.max(0, Number(mask.width) * scaleX);
      const height = Math.max(0, Number(mask.height) * scaleY);
      if (!Number.isFinite(left + top + width + height) || width <= 0 || height <= 0) continue;
      context.fillStyle = '#e5e7eb';
      context.fillRect(left, top, width, height);
      context.strokeStyle = '#9ca3af';
      context.lineWidth = Math.max(1, scaleX);
      context.strokeRect(left, top, width, height);
    }

    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.font = `700 ${Math.max(10, Math.round(10 * scaleY))}px sans-serif`;
    for (const marker of preparation.markers.slice(0, 80)) {
      const label = `#${Number(marker.id)}`;
      if (!/^#\d+$/.test(label)) continue;
      const left = Math.max(2, Number(marker.left) * scaleX);
      const top = Math.max(2, Number(marker.top) * scaleY);
      const width = Math.max(24, context.measureText(label).width + 10 * scaleX);
      const height = Math.max(16, 16 * scaleY);
      context.fillStyle = '#111827';
      context.fillRect(left, top, width, height);
      context.fillStyle = '#ffffff';
      context.fillText(label, left + width / 2, top + height / 2);
    }

    visualStage = 'encode';
    const outputBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: VISUAL_CAPTURE_JPEG_QUALITY / 100 });
    const bytes = new Uint8Array(await outputBlob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { mimeType: 'image/jpeg', data: btoa(binary) };
  } finally {
    bitmap.close?.();
  }
  } catch (error) {
    error.visualStage = visualStage;
    throw error;
  }
}

async function capturePageAnalysis(tabId = sessionState.lockedTabId, operationId = null) {
  if (!tabId) return null;
  let prepared = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.active || !isLimovaUrl(tab.url)) {
      Logger.event('visual', 'VISUAL_CAPTURE_SKIPPED_INACTIVE_TAB', null, operationId);
      return null;
    }
    const preparation = await sendContentMessage(tabId, {
      type: 'PREPARE_VISUAL_CAPTURE',
      contextVersion: pageContextVersion
    });
    if (!preparation?.ok) {
      Logger.warn('visual', 'Visual capture preparation rejected', {
        reason: preparation?.error || 'unknown'
      }, 'VISUAL_CAPTURE_PREPARATION_FAILED', operationId);
      return null;
    }
    prepared = true;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: VISUAL_CAPTURE_JPEG_QUALITY
    });
    const capture = await renderSilentVisualCapture(dataUrl, preparation);
    if (!capture || capture.data.length > VISUAL_CAPTURE_MAX_BASE64_CHARACTERS) {
      Logger.warn('visual', 'Visual capture invalid or too large', {
        encodedCharacters: capture?.data?.length || 0
      }, 'VISUAL_CAPTURE_REJECTED', operationId);
      return null;
    }
    Logger.event('visual', 'VISUAL_CAPTURE_READY', {
      mimeType: capture.mimeType,
      encodedCharacters: capture.data.length,
      maskedCount: Number(preparation.maskedCount || 0),
      markerCount: Number(preparation.markerCount || 0),
      renderedOffscreen: Array.isArray(preparation.masks)
    }, operationId);
    return capture;
  } catch (error) {
    const rawMessage = String(error?.message || '');
    const reason = /activeTab|permission|permissions|not been invoked/i.test(rawMessage)
      ? 'permission_denied'
      : /visible tab|active tab|not active/i.test(rawMessage)
        ? 'tab_not_visible'
        : /cannot access|restricted|chrome:\/\//i.test(rawMessage)
          ? 'restricted_page'
          : 'capture_failed';
    Logger.warn('visual', 'Visual capture unavailable; DOM context retained', {
      name: error?.name || 'Error',
      reason,
      stage: error?.visualStage || 'capture'
    }, 'VISUAL_CAPTURE_UNAVAILABLE', operationId);
    return null;
  } finally {
    if (prepared) {
      await sendContentMessage(tabId, { type: 'CLEAR_VISUAL_CAPTURE' }, false).catch(() => {});
    }
  }
}


// ============================================================================
// Page Context Extraction
// ============================================================================

async function getPageContext(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (contextVersion) => {
        document.documentElement.dataset.limovaContextVersion = String(contextVersion);
        // Clean up previous IDs
        document.querySelectorAll('[data-lid]').forEach(el => el.removeAttribute('data-lid'));

        let idCounter = 1;
        const elementMap = [];

        // Helper: get zone from DOM position
        function getZone(el) {
          const modal = el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, [class*="modal" i], [class*="dialog" i], [class*="drawer" i], [class*="popup" i]');
          if (modal) return 'modal';
          const nav = el.closest('nav, [role="navigation"], [class*="sidebar"], [class*="nav"]');
          if (nav) return 'nav';
          const header = el.closest('header, [class*="header"], [class*="topbar"]');
          if (header) return 'header';
          const form = el.closest('form, [class*="form"]');
          if (form) return 'form';
          const footer = el.closest('footer');
          if (footer) return 'footer';
          return 'main';
        }

        // Helper: get visual position description
        function getPosition(el) {
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const col = x < vw * 0.25 ? 'left' : x > vw * 0.75 ? 'right' : 'center';
          const row = y < vh * 0.25 ? 'top' : y > vh * 0.75 ? 'bottom' : 'middle';
          return `${row}-${col}`;
        }

        // Helper: check if element is visible in viewport
        function isVisible(el) {
          if (!el.offsetParent && el.tagName !== 'BODY' && window.getComputedStyle(el).position !== 'fixed') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          if (activeModalSurface && !activeModalSurface.contains(el)) return false;
          return true;
        }

        function isModalSurfaceCandidate(element) {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const role = element.getAttribute('role');
          if (role === 'dialog' || role === 'alertdialog' || element.getAttribute('aria-modal') === 'true') return true;
          if (element.tagName === 'DIALOG' && element.hasAttribute('open')) return true;
          if (/(modal|dialog|overlay|popup|lightbox|drawer)/i.test(String(element.className || '')) && rect.width > 100 && rect.height > 100) return true;
          const zIndex = Number.parseInt(style.zIndex, 10) || 0;
          const coversViewportCenter = rect.left <= window.innerWidth / 2
            && rect.right >= window.innerWidth / 2
            && rect.top <= window.innerHeight / 2
            && rect.bottom >= window.innerHeight / 2;
          return style.position === 'fixed'
            && zIndex >= 10
            && coversViewportCenter
            && (rect.width * rect.height) / Math.max(1, window.innerWidth * window.innerHeight) > 0.12;
        }

        function findActiveModalSurface() {
          if (!document.body) return null;
          const signaled = document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], ' +
            '[class*="modal" i], [class*="dialog" i], [class*="overlay" i], [class*="popup" i], ' +
            '[class*="lightbox" i], [class*="drawer" i], [data-radix-portal] > *, [data-headlessui-portal] > *'
          );
          const shallow = [...document.body.children].flatMap(element => [element, ...element.children]);
          const candidates = [...new Set([...signaled, ...shallow])].filter(isModalSurfaceCandidate);
          if (!candidates.length) return null;
          const score = element => {
            const rect = element.getBoundingClientRect();
            const role = element.getAttribute('role');
            const semantic = role === 'dialog' || role === 'alertdialog' || element.getAttribute('aria-modal') === 'true' || element.tagName === 'DIALOG';
            const modalClass = /(modal|dialog|popup|lightbox|drawer)/i.test(String(element.className || ''));
            const zIndex = Number.parseInt(window.getComputedStyle(element).zIndex, 10) || 0;
            let depth = 0;
            for (let current = element; current && current !== document.body; current = current.parentElement) depth += 1;
            return (semantic ? 100000 : 0)
              + (modalClass ? 10000 : 0)
              + zIndex * 10
              + depth
              - (rect.width * rect.height / Math.max(1, window.innerWidth * window.innerHeight)) * 100;
          };
          return candidates.sort((left, right) => score(right) - score(left))[0];
        }

        const activeModalSurface = findActiveModalSurface();
        const contextRoot = activeModalSurface || document;

        function sanitizeVisibleText(value, maxLength = 120) {
          return String(value || '')
            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
            .replace(/\+?\d(?:[ .()-]?\d){7,}/g, '[phone]')
            .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[token]')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength);
        }

        function getExplicitLabel(el) {
          const labelledBy = String(el.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map(id => document.getElementById(id)?.textContent || '')
            .join(' ');
          let associatedLabel = '';
          if (el.id) {
            try { associatedLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || ''; } catch (_) {}
          }
          return el.getAttribute('aria-label')
            || labelledBy
            || associatedLabel
            || el.closest('label')?.textContent
            || el.getAttribute('title')
            || el.getAttribute('value')
            || el.querySelector('img')?.getAttribute('alt')
            || el.querySelector('svg title')?.textContent
            || '';
        }

        function uniqueTexts(values, maxLength = 120) {
          const seen = new Set();
          return values.map(value => sanitizeVisibleText(value, maxLength)).filter(value => {
            const key = value.toLocaleLowerCase('fr');
            if (!value || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        function getSemanticScope(el) {
          const boundedScope = el.closest(
            '[role="listitem"], article, li, [class*="card"], [class*="tile"], ' +
            '[class*="item"], [class*="row"], fieldset'
          );
          if (boundedScope) return boundedScope;
          const testScope = el.closest('[data-testid]');
          if (testScope && testScope !== el) return testScope;
          const parent = el.parentElement;
          if (!parent || parent.matches('html, body, main') || parent.children.length > 20) return null;
          return parent;
        }

        function getScopeTitle(scope, control) {
          if (!scope) return '';
          const candidates = [
            ...scope.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="name"]'),
            ...scope.querySelectorAll('img[alt]')
          ];
          for (const candidate of candidates) {
            if (candidate === control || candidate.contains(control)) continue;
            const value = candidate.matches('img[alt]')
              ? candidate.getAttribute('alt')
              : candidate.textContent;
            const title = sanitizeVisibleText(value, 80);
            if (title && title.length <= 80) return title;
          }
          return '';
        }

        function getNearbyText(el) {
          const candidates = [
            el.previousElementSibling,
            el.nextElementSibling,
            el.parentElement?.previousElementSibling,
            el.parentElement?.querySelector(':scope > label, :scope > span, :scope > p')
          ];
          for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement) || candidate === el || candidate.contains(el)) continue;
            const value = sanitizeVisibleText(candidate.textContent || candidate.getAttribute('aria-label'), 80);
            if (value && value.length >= 2 && value.length <= 80) return value;
          }
          return '';
        }

        function getRouteHint(el) {
          const raw = el.getAttribute('href');
          if (!raw) return '';
          try {
            const url = new URL(raw, window.location.href);
            if (url.origin !== window.location.origin) return url.hostname.replace(/^www\./, '');
            return url.pathname
              .split('/')
              .filter(Boolean)
              .slice(-3)
              .join(' ')
              .replace(/[-_]+/g, ' ');
          } catch (_) {
            return '';
          }
        }

        function getElementSemantics(el, rawLabel) {
          const scope = getSemanticScope(el);
          const section = getScopeTitle(scope, el);
          const nearbyText = getNearbyText(el);
          const routeHint = getRouteHint(el);
          const scopeControls = scope
            ? [...scope.querySelectorAll('button, [role="button"], a[href], [tabindex="0"], span, p')]
            : [];
          const actionPhrase = scopeControls
            .map(node => sanitizeVisibleText(node.textContent, 100))
            .find(value => /^(?:connecter|reconnecter|configurer|ajouter un compte|continuer avec|ouvrir|créer|lancer|démarrer)\b/i.test(value)) || '';
          const attributeHint = sanitizeVisibleText([
            el.getAttribute('data-testid'), el.getAttribute('data-cy'), el.getAttribute('data-qa'),
            el.getAttribute('data-action'), el.getAttribute('data-name'), el.getAttribute('data-title'),
            el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('role'),
            el.getAttribute('aria-label'), el.getAttribute('title')
          ].filter(Boolean).join(' '), 160);
          const connectionHint = `${actionPhrase} ${attributeHint}`;
          const isConnection = /(?:^|[\s_-])(?:connect(?:er|ez)?|reconnect(?:er|ez)?|connexion|connection|setup)(?:[\s_-]|$)/i.test(connectionHint)
            && !/(?:déconnect|deconnect|disconnect|remove|supprim)/i.test(connectionHint);
          const normalizedRaw = sanitizeVisibleText(rawLabel, 100);
          const actionHasSection = section && actionPhrase.toLocaleLowerCase('fr').includes(section.toLocaleLowerCase('fr'));
          const derivedConnectionLabel = isConnection && section
            ? (actionHasSection ? actionPhrase : `Connecter ${section}`)
            : '';
          const genericAction = /^(?:ouvrir|open|voir|view|continuer|continue|connecter|connect|choisir|choose|sélectionner|select|afficher|show)$/i.test(normalizedRaw);
          const contextualActionLabel = genericAction && (section || nearbyText)
            ? `${normalizedRaw} ${section || nearbyText}`
            : '';
          const primaryLabel = derivedConnectionLabel || normalizedRaw || actionPhrase || section || nearbyText || routeHint;
          const aliases = uniqueTexts([
            normalizedRaw,
            getExplicitLabel(el),
            actionPhrase,
            derivedConnectionLabel,
            contextualActionLabel,
            section && normalizedRaw && !normalizedRaw.toLocaleLowerCase('fr').includes(section.toLocaleLowerCase('fr'))
              ? `${normalizedRaw} ${section}`
              : '',
            nearbyText,
            nearbyText && normalizedRaw ? `${normalizedRaw} ${nearbyText}` : '',
            routeHint,
            attributeHint.replace(/[-_]+/g, ' ')
          ], 120).filter(value => value.toLocaleLowerCase('fr') !== primaryLabel.toLocaleLowerCase('fr'));
          return {
            primaryLabel,
            aliases: aliases.slice(0, 5),
            section,
            actionKind: isConnection ? 'connection_setup' : undefined
          };
        }

        function isInferredMessageSendButton(el) {
          if (!el.matches('button, [role="button"], input[type="submit"]')) return false;
          if (sanitizeVisibleText(getExplicitLabel(el), 80)) return false;
          if (sanitizeVisibleText(el.textContent, 80)) return false;

          let scope = el.parentElement;
          for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
            const editor = scope.querySelector('textarea, [contenteditable="true"], input[type="text"]');
            if (!editor) continue;
            const unlabeledButtons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')]
              .filter(button => isVisible(button))
              .filter(button => !sanitizeVisibleText(getExplicitLabel(button), 80))
              .filter(button => !sanitizeVisibleText(button.textContent, 80));
            return unlabeledButtons.length === 1 && unlabeledButtons[0] === el;
          }
          return false;
        }

        // Helper: get meaningful label for an element
        function getLabel(el) {
          // Limova integration tiles are keyboard-clickable <div tabindex="0">
          // elements. Their actionable footer is nested inside the tile, so use
          // that concise instruction instead of the whole card description.
          const nestedAction = [...el.querySelectorAll('button, [role="button"], span, p, div')]
            .map(node => sanitizeVisibleText(node.textContent, 80))
            .find(value => /^(?:connecter|reconnecter|configurer|commencer|continuer|ouvrir|voir)\b/i.test(value));
          if (nestedAction) return nestedAction;

          // Direct text (first non-empty child text, not deep children to avoid nested noise)
          let text = '';
          for (const child of el.childNodes) {
            if (child.nodeType === 3) text += child.textContent;
            else if (child.nodeType === 1 && !['SVG', 'IMG', 'BUTTON', 'A'].includes(child.tagName)) {
              text += child.textContent;
            }
          }
          text = text.trim().replace(/\s+/g, ' ');
          if (text.length > 0 && text.length < 80) return text;
          // Fallback: aria-label, title, alt (for icon buttons)
          return getExplicitLabel(el)
            || (isInferredMessageSendButton(el) ? 'Envoyer le message' : '')
            || (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80)
            || '';
        }

        // Helper: detect if element looks disabled
        function isDisabled(el) {
          return el.disabled || el.getAttribute('aria-disabled') === 'true'
            || el.classList.contains('disabled') || el.classList.contains('opacity-50');
        }

        // Helper: get parent context (breadcrumb-like path for nested items)
        function getParentContext(el) {
          const parent = el.closest('[class*="section"], [class*="group"], [class*="panel"], fieldset, details');
          if (!parent) return '';
          const heading = parent.querySelector('h1, h2, h3, h4, legend, summary, [class*="title"]');
          if (heading) {
            const t = heading.textContent.trim().replace(/\s+/g, ' ');
            if (t.length > 1 && t.length < 60) return sanitizeVisibleText(t, 60);
          }
          return '';
        }

        // 1. Clickable elements
        const clickables = contextRoot.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="link"], ' +
          'input[type="submit"], input[type="button"], [class*="btn"], [tabindex="0"], ' +
          '[onclick], [class*="cursor-pointer"], [class*="clickable"]'
        );
        clickables.forEach(el => {
          if (!isVisible(el)) return;
          const nestedInteractive = el.querySelector('button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]');
          if (nestedInteractive && nestedInteractive !== el && isVisible(nestedInteractive)
            && !el.matches('button, a[href], [role="button"], [role="link"]')) return;
          const semantics = getElementSemantics(el, getLabel(el));
          const label = sanitizeVisibleText(semantics.primaryLabel, 100);
          if (!label || label.length < 1) return;
          const zone = getZone(el);

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          const isActive = el.classList.contains('active')
            || el.getAttribute('aria-selected') === 'true'
            || el.getAttribute('aria-current') === 'page'
            || el.getAttribute('aria-expanded') === 'true';
          const entry = {
            id, type: 'clickable', tag: el.tagName.toLowerCase(), text: label,
            zone, pos: getPosition(el), active: isActive || false,
            buttonType: el.getAttribute('type') || undefined,
            inForm: Boolean(el.closest('form'))
          };
          if (semantics.aliases.length) entry.aliases = semantics.aliases;
          if (semantics.actionKind === 'connection_setup' || /^(?:connecter|reconnecter|configurer)\b/i.test(label)) {
            entry.actionKind = 'connection_setup';
            if (semantics.section) entry.section = semantics.section;
          }
          const actionVocabulary = `${label} ${(semantics.aliases || []).join(' ')}`;
          if (label === 'Envoyer le message'
            || /\b(?:envoyer|envoie|send|submit)[ -]?(?:le )?(?:message|chat|prompt)\b/i.test(actionVocabulary)
            || /\b(?:send-message|message-send|chat-submit|submit-message)\b/i.test(actionVocabulary.replace(/\s+/g, '-'))) {
            entry.actionKind = 'message_send';
          }
          if (el instanceof HTMLAnchorElement && el.href) {
            try {
              const target = new URL(el.href, window.location.href);
              if (target.origin === window.location.origin) entry.hrefPath = target.pathname;
              else entry.external = true;
            } catch (_) {}
          }
          if (isDisabled(el)) entry.disabled = true;
          const ctx = getParentContext(el);
          if (!entry.section && (ctx || semantics.section)) entry.section = ctx || semantics.section;
          // Detect icon-only buttons
          if (el.querySelector('svg, img') && label === el.getAttribute('aria-label')) {
            entry.icon = true;
          }
          elementMap.push(entry);
        });

        // 2. Input fields
        const inputs = contextRoot.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), ' +
          'textarea, select, [contenteditable="true"]'
        );
        inputs.forEach(el => {
          if (!isVisible(el)) return;
          let label = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) label = lbl.textContent.trim();
          }
          if (!label) {
            const parentLabel = el.closest('label');
            if (parentLabel) label = parentLabel.textContent.trim().replace(el.value || '', '').trim();
          }
          if (!label) label = el.getAttribute('aria-label') || el.placeholder || el.name || '';
          label = sanitizeVisibleText(label, 80);
          if (!label) return;

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          const inputType = el.tagName === 'SELECT' ? 'select' : (el.type || 'text');
          const sensitive = /password|passcode|secret|token|api.?key|credit|card|payment|iban|cvv/i.test(
            `${inputType} ${el.name || ''} ${label}`
          );
          const entry = {
            id, type: 'input', inputType, text: label,
            zone: getZone(el), pos: getPosition(el), filled: Boolean(el.value), sensitive
          };
          if (el.required) entry.required = true;
          if (isDisabled(el)) entry.disabled = true;
          // For select, list options
          if (el.tagName === 'SELECT') {
            const opts = [...el.options].map(o => sanitizeVisibleText(o.text, 60)).filter(t => t).slice(0, 10);
            if (opts.length > 0) entry.options = opts;
          }
          const ctx = getParentContext(el);
          if (ctx) entry.section = ctx;
          elementMap.push(entry);
        });

        // 3. Checkboxes & toggles & radios
        const checks = contextRoot.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="switch"]');
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
          label = sanitizeVisibleText(label, 80);
          if (!label) return;

          const id = idCounter++;
          el.setAttribute('data-lid', id);
          const isSwitch = el.getAttribute('role') === 'switch';
          elementMap.push({
            id, type: isSwitch ? 'toggle' : el.type, text: label.substring(0, 80),
            zone: getZone(el), pos: getPosition(el),
            checked: el.checked ?? el.getAttribute('aria-checked') === 'true'
          });
        });

        // 4. Headings (for structure)
        const headings = contextRoot.querySelectorAll('h1, h2, h3');
        headings.forEach(el => {
          if (!isVisible(el)) return;
          const text = sanitizeVisibleText(el.textContent, 120);
          if (text.length < 2 || text.length > 120) return;
          elementMap.push({ type: 'heading', tag: el.tagName.toLowerCase(), text, zone: getZone(el), pos: getPosition(el) });
        });

        // 5. Status messages, alerts, banners
        const alerts = contextRoot.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [class*="notification"], [class*="banner"], [class*="alert"]');
        alerts.forEach(el => {
          if (!isVisible(el)) return;
          const text = sanitizeVisibleText(el.textContent, 150);
          if (text.length < 3) return;
          const isError = el.classList.contains('error') || el.classList.contains('danger') || el.classList.contains('alert-error');
          const isSuccess = el.classList.contains('success');
          elementMap.push({
            type: 'alert',
            severity: isError ? 'error' : isSuccess ? 'success' : 'info',
            text, zone: getZone(el)
          });
        });

        // 6. Tables (data grids)
        const tables = contextRoot.querySelectorAll('table');
        tables.forEach(table => {
          if (!isVisible(table)) return;
          const headers = [...table.querySelectorAll('th')].map(th => sanitizeVisibleText(th.textContent, 60)).filter(t => t);
          const rowCount = table.querySelectorAll('tbody tr').length;
          if (headers.length > 0 || rowCount > 0) {
            elementMap.push({
              type: 'table', zone: getZone(table),
              columns: headers.slice(0, 10), rows: rowCount
            });
          }
        });

        // 7. Tabs & tab panels
        const tabLists = contextRoot.querySelectorAll('[role="tablist"]');
        tabLists.forEach(tl => {
          if (!isVisible(tl)) return;
          const tabs = [...tl.querySelectorAll('[role="tab"]')].map(tab => ({
            text: sanitizeVisibleText(tab.textContent, 60),
            active: tab.getAttribute('aria-selected') === 'true'
          })).filter(t => t.text);
          if (tabs.length > 0) {
            elementMap.push({ type: 'tablist', zone: getZone(tl), tabs });
          }
        });

        // 8. Empty states / no-data messages
        const empties = contextRoot.querySelectorAll('[class*="empty"], [class*="no-data"], [class*="placeholder"]');
        empties.forEach(el => {
          if (!isVisible(el)) return;
          const text = sanitizeVisibleText(el.textContent, 100);
          if (text.length > 5) {
            elementMap.push({ type: 'empty-state', text, zone: getZone(el) });
          }
        });

        // 9. Recent network performance metadata. Never include query strings,
        // fragments, request/response bodies, headers, or cross-origin paths.
        function generalizedPath(pathname) {
          return pathname.split('/').map(segment => {
            if (/^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48) return ':id';
            return segment;
          }).join('/');
        }
        const network = performance.getEntriesByType('resource').slice(-40).map(entry => {
          try {
            const resource = new URL(entry.name);
            return {
              target: resource.origin === window.location.origin
                ? generalizedPath(resource.pathname)
                : resource.origin,
              sameOrigin: resource.origin === window.location.origin,
              type: entry.initiatorType || 'resource',
              status: Number(entry.responseStatus) || undefined,
              durationMs: Math.round(entry.duration)
            };
          } catch (_) {
            return null;
          }
        }).filter(Boolean);

        return {
          title: sanitizeVisibleText(document.title, 120),
          url: `${window.location.origin}${generalizedPath(window.location.pathname)}`,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          surface: activeModalSurface ? 'modal' : 'page',
          elements: elementMap.slice(0, 150),
          network
        };
      },
      args: [pageContextVersion + 1]
    });

    if (results?.[0]?.result) {
      const pc = results[0].result;
      pageContextVersion += 1;
      lastPageElements = new Map(pc.elements.filter(el => el.id).map(el => [el.id, el]));
      pageElementSnapshots.set(pageContextVersion, new Map(lastPageElements));
      while (pageElementSnapshots.size > PAGE_ELEMENT_SNAPSHOT_LIMIT) {
        pageElementSnapshots.delete(pageElementSnapshots.keys().next().value);
      }
      const parts = [];
      parts.push(`Page: ${pc.title || '(no title)'} — ${pc.url}`);
      parts.push(`Viewport: ${pc.viewport}`);
      parts.push(`Surface active: ${pc.surface === 'modal' ? 'fenêtre au premier plan uniquement' : 'page entière'}`);
      if (pc.network?.length) {
        parts.push('\n[network]');
        parts.push(pc.network.map(item => {
          const status = item.status ? ` status:${item.status}` : '';
          return `  ${item.type} ${item.target}${status} ${item.durationMs}ms`;
        }).join('\n'));
      }

      // Group elements by zone for readability
      const byZone = {};
      for (const el of pc.elements) {
        const zone = el.zone || 'page';
        if (!byZone[zone]) byZone[zone] = [];
        byZone[zone].push(el);
      }

      for (const [zone, elements] of Object.entries(byZone)) {
        const lines = elements.map(el => {
          if (el.type === 'heading') return `  ${el.tag}: "${el.text}" @${el.pos}`;
          if (el.type === 'alert') return `  ⚠ ${el.severity}: "${el.text}"`;
          if (el.type === 'table') return `  table: ${el.columns.join(' | ')} (${el.rows} rows)`;
          if (el.type === 'tablist') return `  tabs: ${el.tabs.map(t => t.active ? `[${t.text}]` : t.text).join(' | ')}`;
          if (el.type === 'empty-state') return `  (empty) "${el.text}"`;

          const id = `[${el.id}]`;
          const active = el.active ? ' ✓ACTIVE' : '';
          const disabled = el.disabled ? ' ✗DISABLED' : '';
          const checked = el.checked === true ? ' ☑ON' : el.checked === false ? ' ☐OFF' : '';
          const val = el.filled ? ' = [filled]' : '';
          const sensitive = el.sensitive ? ' [sensitive]' : '';
          const opts = el.options ? ` options:[${el.options.join(',')}]` : '';
          const req = el.required ? ' *required' : '';
          const sec = el.section ? ` in:"${el.section}"` : '';
          const aliases = Array.isArray(el.aliases) && el.aliases.length
            ? ` aliases:[${el.aliases.map(alias => `"${alias}"`).join(', ')}]`
            : '';
          const ico = el.icon ? ' (icon)' : '';
          const pos = el.pos ? ` @${el.pos}` : '';
          return `  ${id} ${el.type}(${el.tag || el.inputType || ''}) "${el.text}"${aliases}${active}${disabled}${checked}${val}${sensitive}${opts}${req}${sec}${ico}${pos}`;
        });
        parts.push(`\n[${zone}]`);
        parts.push(lines.join('\n'));
      }

      lastPageContext = parts.join('\n');
      return lastPageContext;
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
      world: 'MAIN',
      func: () => window.__limova_console_logs || []
    });
    if (results?.[0]?.result?.length > 0) {
      return results[0].result
        .filter(log => ['warn', 'error'].includes(log.level))
        .slice(-20)
        .map(log => `[${log.level}] ${sanitizeDiagnostic(log.message)}`)
        .join('\n');
    }
  } catch (e) {}
  return '';
}

async function getPageTechnicalDiagnostics(tabId, since = 0) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: minimumTimestamp => ({
        console: (window.__limova_console_logs || [])
          .filter(entry => Number(entry.timestamp) >= minimumTimestamp)
          .filter(entry => ['warn', 'error'].includes(entry.level))
          .slice(-8),
        network: (window.__limova_network_events || [])
          .filter(entry => Number(entry.timestamp) >= minimumTimestamp)
          .slice(-12)
      }),
      args: [Number(since) || 0]
    });
    const data = results?.[0]?.result || {};
    const consoleEntries = Array.isArray(data.console) ? data.console.map(entry => ({
      level: entry.level === 'error' ? 'error' : 'warn',
      message: sanitizeDiagnostic(entry.message)
    })).filter(entry => entry.message) : [];
    const networkEntries = Array.isArray(data.network) ? data.network.map(entry => ({
      method: String(entry.method || 'GET').toUpperCase().slice(0, 10),
      target: sanitizeDiagnostic(entry.target).slice(0, 300),
      status: Math.max(0, Number(entry.status) || 0),
      durationMs: Math.max(0, Number(entry.durationMs) || 0)
    })).filter(entry => entry.target) : [];
    const summary = [
      ...consoleEntries.map(entry => `[console:${entry.level}] ${entry.message}`),
      ...networkEntries.map(entry => `[network] ${entry.method} ${entry.target} status:${entry.status || 'failed'} ${entry.durationMs}ms`)
    ].join('\n').slice(0, 4_000);
    return { console: consoleEntries, network: networkEntries, summary };
  } catch (_) {
    return { console: [], network: [], summary: '' };
  }
}

// ============================================================================
// Settings & Session
// ============================================================================

// API keys are managed server-side on the proxy — no local key storage needed

function handleResetSession() {
  const previousRemoteSessionId = sessionState.remoteSessionId;
  sessionState.conversationHistory = [];
  sessionState.remoteSessionId = null;
  sessionState.onboardingDocs = null;
  sessionState.onboardingPlan = null;
  sessionState.isActive = false;
  sessionState.lastUrl = null;
  sessionState.lastAnalysisTime = 0;
  recentRejectedActionTargets.clear();
  proxyAccessToken = null;
  proxyAccessTokenExpiresAt = 0;
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  pageContextVersion = 0;
  lastPageElements.clear();
  pageElementSnapshots.clear();
  lastPageContext = '';
  lastUserMessage = '';
  lastUserTurn = null;
  userTurnSequence = 0;
  userPageInteractionSequences.clear();
  voiceSessionActive = false;
  externalPopupTabs.clear();
  externalPopupFlow = null;
  if (externalPopupCloseTimer) clearTimeout(externalPopupCloseTimer);
  externalPopupCloseTimer = null;
  pendingActions.clear();
  loadingRetries.clear();

  if (sessionState.lockedTabId) {
    chrome.tabs.sendMessage(sessionState.lockedTabId, { type: 'SESSION_STATE', active: false }).catch(() => {});
  }
  sessionState.lockedTabId = null;

  Logger.clearLogs();
  Logger.log('background', 'Session reset');
  saveSession(); // Immediate save on reset (not debounced)
  if (!previousRemoteSessionId) return { ok: true };
  return authorizedProxyFetch('/api/copilot/v2/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previousSessionId: previousRemoteSessionId, closePrevious: true })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.sessionId) {
      sessionState.remoteSessionId = data.sessionId;
      await saveSession();
      return { ok: true, sessionId: data.sessionId };
    }
    return { ok: true, remoteResetPending: true };
  }).catch(error => {
    Logger.warn('memory', 'Remote session reset deferred', { code: errorCodeOf(error) });
    return { ok: true, remoteResetPending: true };
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function hasAIProcessingConsent() {
  const stored = await chrome.storage.local.get(AI_CONSENT_KEY);
  return stored[AI_CONSENT_KEY] === true;
}

function privacySafeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${generalizePathname(url.pathname)}`;
  } catch (_) {
    return '';
  }
}

function boundedConversationHistory(history, maxMessages, maxCharacters) {
  const selected = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = history[index];
    const content = String(message?.content || '').slice(0, 8_000);
    if (!content) continue;
    if (used + content.length > maxCharacters) break;
    selected.unshift({ ...message, content });
    used += content.length;
  }
  return selected;
}

function analyticsSafePath(value) {
  try {
    return generalizePathname(new URL(value).pathname).slice(0, 100);
  } catch (_) {
    return '';
  }
}

function generalizePathname(pathname) {
  return String(pathname || '').split('/').map(segment => {
    if (/^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48) return ':id';
    return segment;
  }).join('/');
}

function sanitizeDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"']+/gi, raw => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch (_) {
        return '[url]';
      }
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt-redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/\+?\d(?:[ .()-]?\d){7,}/g, (candidate, offset, source) => {
      const before = source[offset - 1] || '';
      const after = source[offset + candidate.length] || '';
      if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(after)) return candidate;
      const digitCount = candidate.replace(/\D/g, '').length;
      return digitCount >= 8 && digitCount <= 15 ? '[phone-redacted]' : candidate;
    })
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

async function getProxyAccessToken(forceRefresh = false) {
  if (!forceRefresh && proxyAccessToken && Date.now() < proxyAccessTokenExpiresAt - PROXY_TOKEN_RENEWAL_MARGIN) {
    Logger.event('auth', 'AUTH_TOKEN_CACHE_HIT', { expiresInMs: proxyAccessTokenExpiresAt - Date.now() });
    return proxyAccessToken;
  }

  let stored;
  try {
    stored = await chrome.storage.local.get(CHARLY_AUTH_STORAGE_KEY);
  } catch (cause) {
    // A transient storage failure must never be interpreted as a logout. The
    // sidebar keeps its current authenticated UI while Chrome restores the
    // extension storage/service worker.
    throw codedError('AUTH_STATE_UNAVAILABLE', 'La session Charly est temporairement indisponible.', cause);
  }
  const session = stored[CHARLY_AUTH_STORAGE_KEY];
  if (typeof session?.token !== 'string' || session.token.length < 20 || Number(session.expiresAt) <= Date.now()) {
    await clearCharlyAuthSession(false);
    throw codedError('AUTH_SESSION_MISSING', 'Connecte-toi à Charly avec ton adresse Limova.');
  }
  proxyAccessToken = session.token;
  proxyAccessTokenExpiresAt = Number(session.expiresAt);
  Logger.event('auth', 'AUTH_SESSION_RESTORED', { expiresInMs: proxyAccessTokenExpiresAt - Date.now() });
  return proxyAccessToken;
}

async function clearCharlyAuthSession(notify = true) {
  proxyAccessToken = null;
  proxyAccessTokenExpiresAt = 0;
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  lastSyncedProfileHash = '';
  await chrome.storage.local.remove(CHARLY_AUTH_STORAGE_KEY).catch(() => {});
  if (notify) broadcastToSidebar({ type: 'AUTH_REQUIRED' });
}

async function requestCharlyOtp(email) {
  const response = await fetch(`${PROXY_URL}/api/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').trim() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('AUTH_OTP_REQUEST_FAILED', data.error || 'Impossible d’envoyer le code.');
  return data;
}

async function verifyCharlyOtp(challenge, code) {
  const response = await fetch(`${PROXY_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, code: String(code || '').trim() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.token !== 'string') {
    throw codedError('AUTH_OTP_INVALID', data.error || 'Code incorrect ou expiré.');
  }
  const expiresAt = Date.now() + Math.max(60, Number(data.expiresIn) || 0) * 1000;
  await chrome.storage.local.set({ [CHARLY_AUTH_STORAGE_KEY]: { token: data.token, expiresAt } });
  proxyAccessToken = data.token;
  proxyAccessTokenExpiresAt = expiresAt;
  Logger.event('auth', 'AUTH_OTP_VERIFIED', { expiresInMs: expiresAt - Date.now() });
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  return { ok: true, authenticated: true };
}

async function getCharlyAuthState(validate = false) {
  try {
    const token = await getProxyAccessToken();
    if (!validate) return { authenticated: true };
    const response = await fetch(`${PROXY_URL}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (response.ok) return { authenticated: true };
    if (response.status === 401) {
      await clearCharlyAuthSession(false);
      return { authenticated: false };
    }
    return { authenticated: null, pending: true };
  } catch (error) {
    if (error?.code === 'AUTH_SESSION_MISSING') return { authenticated: false };
    return { authenticated: null, pending: true };
  }
}

async function getLimovaTabForAuthentication() {
  const activeTab = await getActiveLimovaTab();
  if (activeTab?.id) return activeTab;

  // The side panel can remain open while another tab or Chrome window has
  // focus. Authentication only needs a signed-in Limova page, so fall back to
  // the most recently accessed matching tab instead of claiming the session
  // is disconnected when Limova is already open in the background.
  const tabs = await chrome.tabs.query({ url: `${LIMOVA_DOMAIN}/*` });
  return tabs
    .filter(tab => tab?.id && isLimovaUrl(tab.url))
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
}

async function authorizedProxyFetch(path, options = {}, retry = true) {
  const operationId = Logger.createOperationId('proxy');
  const startedAt = Date.now();
  Logger.event('proxy', 'PROXY_REQUEST_STARTED', { path, method: options.method || 'GET', retryAllowed: retry }, operationId);
  const token = await getProxyAccessToken();
  let response;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = path === '/api/live-token' ? 15_000 : 35_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener?.('abort', forwardAbort, { once: true });
  try {
    response = await fetch(`${PROXY_URL}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
  } catch (cause) {
    const code = timedOut ? 'PROXY_REQUEST_TIMEOUT' : cause?.name === 'AbortError' ? 'PROXY_REQUEST_ABORTED' : 'PROXY_NETWORK_FAILED';
    const error = codedError(code, timedOut ? 'Le service Limova met trop de temps à répondre.' : cause?.message || 'Le proxy Limova est indisponible.', cause);
    Logger.error('proxy', 'Proxy request failed before response', error, error.code, operationId);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener?.('abort', forwardAbort);
  }
  Logger.event('proxy', 'PROXY_RESPONSE_RECEIVED', {
    path,
    status: response.status,
    durationMs: Date.now() - startedAt
  }, operationId);
  if (response.status === 401 && retry) {
    Logger.warn('proxy', 'Proxy rejected Charly session', { path }, 'PROXY_TOKEN_EXPIRED', operationId);
    await clearCharlyAuthSession(true);
    throw codedError('AUTH_SESSION_MISSING', 'Ta session Charly a expiré. Reconnecte-toi pour continuer.');
  }
  return response;
}

async function getCopilotBootstrap(force = false) {
  if (!force && copilotBootstrapCache && copilotBootstrapCacheExpiresAt > Date.now()) return copilotBootstrapCache;
  const response = await authorizedProxyFetch('/api/copilot/bootstrap', { method: 'GET', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('COPILOT_MEMORY_UNAVAILABLE', data.error || 'Mémoire temporairement indisponible.');
  copilotBootstrapCache = data;
  copilotBootstrapCacheExpiresAt = Date.now() + 30_000;
  return data;
}

function sanitizeLimovaProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clean = (value, max) => typeof value === 'string'
    ? value.replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
  const profile = {
    firstName: clean(raw.firstName, 80),
    lastName: clean(raw.lastName, 100),
    limovaUserId: clean(raw.limovaUserId || raw.id, 200),
    locale: clean(raw.locale, 12),
    timezone: clean(raw.timezone, 80)
  };
  Object.keys(profile).forEach(key => { if (!profile[key]) delete profile[key]; });
  return Object.keys(profile).length ? profile : null;
}

async function syncLimovaProfile(rawProfile) {
  const profile = sanitizeLimovaProfile(rawProfile);
  if (!profile) return { ok: false, error: 'Profil invalide.' };
  const serialized = JSON.stringify(profile);
  if (serialized === lastSyncedProfileHash) return { ok: true, unchanged: true };
  try {
    const response = await authorizedProxyFetch('/api/copilot/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, unavailable: response.status >= 500 };
    lastSyncedProfileHash = serialized;
    copilotBootstrapCache = null;
    Logger.event('memory', 'COPILOT_PROFILE_SYNCED', { fields: Object.keys(profile).length });
    return data;
  } catch (error) {
    Logger.warn('memory', 'Copilot profile sync unavailable', { code: errorCodeOf(error) });
    return { ok: false, unavailable: true };
  }
}

async function setCopilotMemoryPreference(enabled) {
  const response = await authorizedProxyFetch('/api/copilot/preferences/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!enabled })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('COPILOT_MEMORY_PREFERENCE_FAILED', data.error || 'Impossible de modifier la personnalisation.');
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  return data;
}

async function exportCopilotData() {
  const response = await authorizedProxyFetch('/api/copilot/export', { method: 'GET', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('COPILOT_EXPORT_FAILED', data.error || 'Export temporairement indisponible.');
  return { ok: true, data, filename: `charly-data-${new Date().toISOString().slice(0, 10)}.json` };
}

async function deleteCopilotData() {
  const response = await authorizedProxyFetch('/api/copilot/data', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw codedError('COPILOT_DELETE_FAILED', data.error || 'Suppression temporairement indisponible.');
  copilotBootstrapCache = null;
  copilotBootstrapCacheExpiresAt = 0;
  return { ok: true };
}

async function persistVoiceTranscript(role, content) {
  try {
    const sessionId = await ensureRemoteCopilotSession();
    const response = await authorizedProxyFetch('/api/copilot/voice-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, text: content, sessionId, idempotencyKey: `voice:${crypto.randomUUID()}` })
    });
    if (response.ok) {
      copilotBootstrapCache = null;
      copilotBootstrapCacheExpiresAt = 0;
    }
  } catch (error) {
    Logger.warn('memory', 'Voice transcript memory unavailable', { code: errorCodeOf(error) });
  }
}

async function getLiveToken(context) {
  if (!(await hasAIProcessingConsent())) return { ok: false, consentRequired: true };
  const operationId = Logger.createOperationId('voice-token');
  Logger.event('voice', 'LIVE_TOKEN_REQUEST_STARTED', null, operationId);
  const trainingMode = context?.trainingMode === true && trainingState.active;
  const evaluationMode = evaluationState.active && Boolean(evaluationState.token);
  const sessionId = trainingMode || evaluationMode ? null : await ensureRemoteCopilotSession();
  const freshContext = trainingMode
    ? { pageContext: '', contextVersion: pageContextVersion }
    : await getFreshVoiceContext(operationId);
  const response = await authorizedProxyFetch('/api/live-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lang: currentLang,
      trainingMode,
      ...(evaluationMode ? { evaluationCode: evaluationState.token } : {}),
      ...(sessionId ? { sessionId } : {}),
      pageContext: trainingMode ? '' : String(freshContext.pageContext || context.pageContext || lastPageContext).slice(0, 12_000),
      history: trainingMode || evaluationMode ? [] : boundedConversationHistory(
        sessionState.conversationHistory,
        CONVERSATION_HISTORY_MAX_MESSAGES,
        CONVERSATION_CONTEXT_MAX_CHARACTERS
      )
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = response.status === 429 ? 'LIVE_TOKEN_RATE_LIMITED' : response.status >= 500 ? 'LIVE_TOKEN_SERVICE_FAILED' : `LIVE_TOKEN_HTTP_${response.status}`;
    const error = codedError(code, data.error?.message || data.error || 'Session vocale indisponible.');
    Logger.error('voice', 'Live token request failed', error, code, operationId);
    throw error;
  }
  Logger.event('voice', 'LIVE_TOKEN_REQUEST_SUCCEEDED', { model: data.model || 'unknown' }, operationId);
  return {
    ok: true,
    ...data,
    contextVersion: freshContext.contextVersion,
    visualCapture: trainingMode ? null : freshContext.visualCapture || null
  };
}

async function getFreshVoiceContext(parentOperationId = null, { capture = false } = {}) {
  if (!(await hasAIProcessingConsent())) return { ok: false, consentRequired: true };
  const operationId = parentOperationId || Logger.createOperationId('voice-context');
  const startedAt = Date.now();
  Logger.event('voice', 'VOICE_CONTEXT_REFRESH_STARTED', null, operationId);

  const tab = await getLimovaTabForAuthentication();
  if (!tab?.id) {
    const error = codedError('VOICE_CONTEXT_TAB_MISSING', 'Ouvre un onglet new.limova.ai pour que Charly puisse analyser et piloter la page.');
    Logger.error('voice', 'Voice context tab missing', error, error.code, operationId);
    throw error;
  }

  if (sessionState.lockedTabId !== tab.id) lockTab(tab.id);
  const pageContext = await getPageContext(tab.id);
  if (!pageContext) {
    const error = codedError('VOICE_CONTEXT_UNAVAILABLE', 'Charly ne peut pas lire la page Limova. Actualise l’onglet puis réessaie.');
    Logger.error('voice', 'Voice page context extraction failed', error, error.code, operationId);
    throw error;
  }

  const visualCapture = capture ? await capturePageAnalysis(tab.id, operationId) : null;
  const result = {
    ok: true,
    pageContext: pageContext.slice(0, 12_000),
    contextVersion: pageContextVersion,
    elementCount: lastPageElements.size,
    visualCapture
  };
  Logger.event('voice', 'VOICE_CONTEXT_REFRESH_SUCCEEDED', {
    durationMs: Date.now() - startedAt,
    contextVersion: result.contextVersion,
    characterCount: result.pageContext.length,
    elementCount: result.elementCount,
    hasNetworkMetadata: result.pageContext.includes('[network]'),
    hasVisualCapture: Boolean(visualCapture)
  }, operationId);
  return result;
}

async function handleUserPageInteraction(rawInteraction, sender) {
  if (evaluationState.active) {
    await recordEvaluationEvent({
      kind: 'manual_intervention',
      status: 'unexpected',
      path: sender?.tab?.url,
      targetLabel: String(rawInteraction?.label || '').slice(0, 160),
      manualIntervention: true,
      contextVersion: pageContextVersion
    });
  }
  if ((!sessionState.isActive && !voiceSessionActive) || trainingState.active) return { ok: true, ignored: true };
  const tabId = sender?.tab?.id;
  if (!tabId || (sessionState.lockedTabId && tabId !== sessionState.lockedTabId)) {
    return { ok: true, ignored: true };
  }
  const kind = ['click', 'input', 'scroll'].includes(rawInteraction?.kind) ? rawInteraction.kind : null;
  if (!kind) return { ok: false, error: 'Interaction invalide.' };
  const sequence = (userPageInteractionSequences.get(kind) || 0) + 1;
  userPageInteractionSequences.set(kind, sequence);
  await new Promise(resolve => setTimeout(resolve, kind === 'scroll' ? 220 : 320));
  if (sequence !== userPageInteractionSequences.get(kind) || (!sessionState.isActive && !voiceSessionActive)) {
    return { ok: true, deduplicated: true };
  }

  const label = String(rawInteraction?.label || '')
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const zone = ['modal', 'nav', 'header', 'form', 'footer', 'main'].includes(rawInteraction?.zone)
    ? rawInteraction.zone
    : 'page';
  const operationId = Logger.createOperationId('user-interaction');
  try {
    const pageContext = await getPageContext(tabId);
    const interactionSummary = kind === 'click'
      ? `Interaction utilisateur observée : clic sur « ${label || 'contrôle sans libellé'} » (${zone}).`
      : kind === 'input'
        ? `Interaction utilisateur observée : champ « ${label || 'sans libellé'} » modifié (${zone}), sans lire sa valeur.`
        : 'Interaction utilisateur observée : la vue a été défilée.';
    const contextualUpdate = `${interactionSummary}\n${pageContext}`.slice(0, 12_000);
    const visualCapture = voiceSessionActive && kind !== 'input'
      ? await capturePageAnalysis(tabId, operationId)
      : null;

    if (voiceSessionActive) {
      broadcastToSidebar({
        type: 'VOICE_PAGE_CONTEXT',
        pageContext: contextualUpdate,
        contextVersion: pageContextVersion,
        source: `user_${kind}`,
        visualCapture
      });
    }
    Logger.event('observation', 'USER_PAGE_INTERACTION_OBSERVED', {
      kind,
      labelLength: label.length,
      zone,
      contextVersion: pageContextVersion,
      elementCount: lastPageElements.size,
      visualContextPushed: Boolean(visualCapture)
    }, operationId);
    return { ok: true, contextVersion: pageContextVersion };
  } catch (error) {
    Logger.warn('observation', 'User page interaction refresh failed', {
      kind,
      name: error?.name || 'Error'
    }, 'USER_PAGE_INTERACTION_REFRESH_FAILED', operationId);
    return { ok: false, error: 'Le contexte de page n’a pas pu être rafraîchi.' };
  }
}

async function storeVoiceTranscript(role, text) {
  if (!(await hasAIProcessingConsent()) || !['user', 'assistant'].includes(role)) return { ok: false };
  const content = String(text || '').trim().slice(0, 4_000);
  if (!content) return { ok: false };
  Logger.event('voice', 'VOICE_TRANSCRIPT_FINALIZED', { role, characterCount: content.length, contentExported: false });
  if (trainingState.active) {
    if (role === 'user') {
      await recordTrainingEvent({ kind: 'voice_note', path: sessionState.lastUrl || '/', label: content, payload: { source: 'microphone' } });
    }
    return { ok: role === 'user', trainingMode: true };
  }
  if (evaluationState.active) {
    if (role === 'user') rememberUserTurn(content, 'voice');
    if (role === 'assistant') {
      await recordEvaluationEvent({
        kind: 'response',
        status: 'ok',
        path: sessionState.lastUrl || '',
        contextVersion: pageContextVersion
      });
    }
    return { ok: true, evaluationMode: true };
  }
  if (role === 'user') rememberUserTurn(content, 'voice');
  sessionState.conversationHistory.push({ role, content });
  if (sessionState.conversationHistory.length > CONVERSATION_HISTORY_MAX_MESSAGES) {
    sessionState.conversationHistory = sessionState.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
  }
  scheduleSave();
  await persistVoiceTranscript(role, content);
  return { ok: true };
}

async function searchVoiceKnowledge(rawQuery) {
  if (!(await hasAIProcessingConsent())) return { ok: false, error: 'Consentement IA requis.' };
  const query = String(rawQuery || '').trim().slice(0, 500);
  if (query.length < 2) return { ok: false, error: 'Question trop courte.' };
  const knowledge = await getKnowledgeContext(query, {
    url: sessionState.lastUrl || '',
    maxResults: 3,
    maxChars: 6_000
  });
  Logger.event('voice', 'VOICE_KB_SEARCH_COMPLETED', {
    queryLength: query.length,
    resultCharacters: knowledge.length,
    hasResults: Boolean(knowledge)
  });
  return knowledge
    ? { ok: true, knowledge }
    : { ok: false, error: 'Aucun article pertinent trouvé.' };
}

function formatLearnedActionHints(rawHints) {
  if (!Array.isArray(rawHints) || rawHints.length === 0) return '';
  const lines = [
    '#### Empreintes d’action démontrées',
    'Utilise ces signaux uniquement pour reconnaître une cible dans la carte DOM actuelle. L’identifiant numérique actuel reste obligatoire.',
  ];
  for (const step of rawHints.slice(0, 20)) {
    const target = step?.target && typeof step.target === 'object' ? step.target : {};
    const signals = [
      target.controlType && `type=${String(target.controlType).slice(0, 60)}`,
      target.role && `rôle=${String(target.role).slice(0, 50)}`,
      target.testId && `test-id=${String(target.testId).slice(0, 120)}`,
      target.domId && `id=${String(target.domId).slice(0, 120)}`,
      target.section && `section=${String(target.section).slice(0, 160)}`,
      target.hrefPath && `destination=${String(target.hrefPath).slice(0, 300)}`,
      target.occurrence && `occurrence=${Number(target.occurrence)}`,
    ].filter(Boolean).join(' · ');
    const expected = step?.expected && typeof step.expected === 'object' ? step.expected : {};
    lines.push(`${Number(step?.order) || lines.length - 1}. ${String(step?.action || 'action').slice(0, 30)} « ${String(step?.label || 'contrôle').slice(0, 240)} » sur ${String(step?.path || '/').slice(0, 300)}`);
    if (signals) lines.push(`   Cible apprise : ${signals}`);
    if (expected.path) lines.push(`   Page attendue : ${String(expected.path).slice(0, 300)}`);
    if (Array.isArray(expected.pageMarkers) && expected.pageMarkers.length) lines.push(`   État attendu : ${expected.pageMarkers.slice(0, 6).join(' · ')}`);
    if (Array.isArray(expected.network) && expected.network.length) lines.push(`   Effets techniques : ${expected.network.slice(0, 6).join(' · ')}`);
    if (expected.popup) lines.push('   Résultat attendu : fenêtre externe ouverte puis fermée.');
  }
  return lines.join('\n');
}

function formatRemoteKnowledge(results, maxChars) {
  if (!Array.isArray(results) || results.length === 0) return '';
  return results.map(result => {
    const learnedHints = formatLearnedActionHints(result.actionHints);
    return `### ${String(result.title || 'Article Limova')}\nSource: ${String(result.source || '')}\n${String(result.content || '')}${learnedHints ? `\n\n${learnedHints}` : ''}`;
  })
    .join('\n\n')
    .slice(0, maxChars);
}

async function getKnowledgeContext(rawQuery, options = {}) {
  const query = String(rawQuery || '').trim().slice(0, 2_000);
  const maxResults = Math.max(1, Math.min(10, Number(options.maxResults) || 5));
  const maxChars = Math.max(500, Math.min(12_000, Number(options.maxChars) || 8_000));
  if (query.length >= 2) {
    try {
      const response = await authorizedProxyFetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, path: privacySafeUrl(options.url || sessionState.lastUrl || ''), locale: currentLang === 'fr' ? 'fr-FR' : currentLang === 'es' ? 'es-ES' : 'en-US', contentTypes: ['article', 'onboarding'], limit: maxResults }),
        signal: AbortSignal.timeout(8_000)
      });
      if (response.ok) {
        const data = await response.json();
        const formatted = formatRemoteKnowledge(data.results, maxChars);
        if (formatted) {
          Logger.event('knowledge', 'REMOTE_KB_SEARCH_SUCCEEDED', { revision: data.revision || null, articleIds: data.results.map(result => result.id), resultCount: data.results.length });
          return formatted;
        }
      }
      Logger.warn('knowledge', 'Remote knowledge unavailable; embedded fallback used', { status: response.status });
    } catch (error) {
      if (String(error?.code || '').startsWith('AUTH_')) throw error;
      Logger.warn('knowledge', 'Remote knowledge request failed; embedded fallback used', { error: error?.name || 'unknown' });
    }
  }
  return searchKB(query, { url: options.url || '', consoleLogs: options.consoleLogs || '', maxResults, maxChars });
}

async function getPublishedOnboardingTemplate() {
  if (onboardingTemplateCache && onboardingTemplateCacheExpiresAt > Date.now()) return onboardingTemplateCache;
  try {
    const response = await authorizedProxyFetch('/api/onboarding/template', { method: 'GET' });
    if (!response.ok) throw new Error(`ONBOARDING_TEMPLATE_HTTP_${response.status}`);
    const template = await response.json();
    if (!template || !Array.isArray(template.steps) || template.steps.length === 0) return null;
    onboardingTemplateCache = template;
    onboardingTemplateCacheExpiresAt = Date.now() + 60_000;
    Logger.event('knowledge', 'ONBOARDING_TEMPLATE_LOADED', {
      revision: String(template.revision || 'unknown'),
      version: Number(template.version || 0),
      stepCount: template.steps.length
    });
    return template;
  } catch (error) {
    if (String(error?.code || '').startsWith('AUTH_')) throw error;
    Logger.warn('knowledge', 'Published onboarding template unavailable; embedded fallback used', { error: error?.name || 'unknown' });
    return null;
  }
}

async function proposeVoiceAction(elementId, requestedContextVersion, toolIntent = {}) {
  if (trainingState.active) return { ok: false, error: 'Mode formateur actif : Charly observe sans agir.' };
  if (!(await hasAIProcessingConsent()) || !Number.isInteger(elementId)) return { ok: false };
  if (!sessionState.lockedTabId) return { ok: false, error: 'Aucun onglet Limova actif.' };
  if (Number.isInteger(requestedContextVersion) && requestedContextVersion !== pageContextVersion) {
    return { ok: false, status: 'unexpected', error: 'La carte DOM a changé.', retryWithFreshContext: true };
  }
  const element = lastPageElements.get(elementId);
  if (!element || element.disabled) return { ok: false, error: 'Élément absent ou indisponible.' };
  const voiceTurn = lastUserTurn
    && lastUserTurn.source === 'voice'
    && Date.now() - lastUserTurn.createdAt <= ACTION_INTENT_MAX_AGE_MS
      ? lastUserTurn
      : null;
  if (!voiceTurn) {
    return {
      ok: false,
      clarificationRequired: true,
      error: 'Aucune demande vocale récente ne peut être associée à ce clic.'
    };
  }
  return proposeOrExecuteAction(elementId, voiceTurn.message, {
    toolExplicitRequest: toolIntent.explicitRequest === true,
    targetLabel: toolIntent.targetLabel,
    requestedContextVersion
  });
}

async function scrollVoicePage(rawDirection, rawAmount, rawElementId, requestedContextVersion) {
  if (trainingState.active) return { ok: false, error: 'Mode formateur actif : Charly observe sans agir.' };
  if (!(await hasAIProcessingConsent())) return { ok: false, error: 'Consentement IA requis.' };
  if (!sessionState.lockedTabId) return { ok: false, error: 'Aucun onglet Limova actif.' };
  const direction = ['up', 'down', 'top', 'bottom'].includes(rawDirection) ? rawDirection : null;
  const amount = ['small', 'medium', 'large'].includes(rawAmount) ? rawAmount : 'medium';
  let elementId = Number.isInteger(rawElementId) ? rawElementId : undefined;
  let activeContextVersion = pageContextVersion;
  if (!direction) return { ok: false, clarificationRequired: true, error: 'Direction de défilement invalide.' };
  if (Number.isInteger(requestedContextVersion) && requestedContextVersion !== pageContextVersion) {
    const original = elementId ? pageElementSnapshots.get(requestedContextVersion)?.get(elementId) : null;
    const fresh = await getFreshVoiceContext().catch(() => null);
    activeContextVersion = fresh?.contextVersion || pageContextVersion;
    if (elementId) {
      const remapped = original
        ? resolveElementCommand(
          elementId,
          requestedContextVersion,
          new Map([[elementId, original]]),
          'scroll',
          activeContextVersion,
          lastPageElements
        )
        : null;
      if (!remapped) {
        return {
          ok: false,
          status: 'unexpected',
          error: 'La zone de défilement n’existe plus.',
          pageContext: fresh?.pageContext || lastPageContext,
          contextVersion: activeContextVersion,
          elementCount: lastPageElements.size,
          retryWithFreshContext: true
        };
      }
      elementId = remapped.id;
    }
  }
  if (elementId && !lastPageElements.has(elementId)) {
    return { ok: false, status: 'unexpected', error: 'La zone de défilement n’existe plus.', retryWithFreshContext: true };
  }

  const operationId = Logger.createOperationId('scroll');
  let result;
  try {
    result = await sendContentMessage(sessionState.lockedTabId, {
      type: 'EXECUTE_PAGE_SCROLL',
      direction,
      amount,
      ...(elementId ? { elementId } : {}),
      contextVersion: activeContextVersion
    });
  } catch (_) {
    result = { ok: false, error: 'La page Limova ne répond plus.' };
  }
  const pageContext = await getPageContext(sessionState.lockedTabId).catch(() => '');
  Logger.event('action', result?.ok ? 'PAGE_SCROLL_SUCCEEDED' : 'PAGE_SCROLL_FAILED', {
    direction,
    amount,
    moved: Boolean(result?.moved),
    contextVersion: pageContextVersion
  }, operationId);
  return {
    ok: result?.ok === true,
    moved: Boolean(result?.moved),
    atStart: Boolean(result?.atStart),
    atEnd: Boolean(result?.atEnd),
    pageContext,
    contextVersion: pageContextVersion,
    elementCount: lastPageElements.size,
    error: result?.error || (result?.ok ? undefined : 'Le défilement n’a pas modifié la page.')
  };
}

const WRITABLE_TEXT_INPUT_TYPES = new Set(['text', 'textarea', 'email', 'search', 'tel', 'url', 'number']);

function isWritableTextElement(element) {
  return element?.type === 'input'
    && !element.disabled
    && !element.sensitive
    && WRITABLE_TEXT_INPUT_TYPES.has(String(element.inputType || 'text').toLowerCase());
}

function fieldMatchesTargetLabel(element, targetLabel) {
  const declared = normalizeActionLanguage(targetLabel);
  if (!declared) return false;
  const labels = semanticTargetLabels(element);
  return labels.some(label => label === declared
    || (declared.length >= 4 && label.includes(declared))
    || (label.length >= 4 && declared.includes(label)));
}

function resolveCurrentTextField(elementId, requestedVersion, targetLabel = '') {
  const requestedSnapshot = pageElementSnapshots.get(requestedVersion);
  const original = requestedSnapshot?.get(elementId)
    || (requestedVersion === pageContextVersion ? lastPageElements.get(elementId) : null);
  const currentExact = lastPageElements.get(elementId);
  const writableFields = [...lastPageElements.entries()].filter(([, candidate]) => isWritableTextElement(candidate));

  if (requestedVersion === pageContextVersion && isWritableTextElement(currentExact)) {
    const normalizedExactLabel = normalizeActionLanguage(currentExact.text);
    const sameLabelFields = normalizedExactLabel
      ? writableFields.filter(([, candidate]) => normalizeActionLanguage(candidate.text) === normalizedExactLabel)
      : [];
    if (sameLabelFields.length > 1) {
      return { id: null, element: currentExact, reason: 'ambiguous_fields', candidateCount: sameLabelFields.length };
    }
    if (!targetLabel || fieldMatchesTargetLabel(currentExact, targetLabel)) {
      return { id: elementId, element: currentExact, reason: 'exact', candidateCount: 1 };
    }
  }

  if (isWritableTextElement(original)) {
    const remapped = resolveElementCommand(
      elementId,
      requestedVersion,
      new Map([[elementId, original]]),
      'text_input',
      pageContextVersion,
      lastPageElements
    );
    const candidate = remapped ? lastPageElements.get(remapped.id) : null;
    if (isWritableTextElement(candidate)
      && (!targetLabel || fieldMatchesTargetLabel(candidate, targetLabel))) {
      return { id: remapped.id, element: candidate, reason: 'stale_exact_remap', candidateCount: 1 };
    }
  }

  if (targetLabel) {
    const labelled = writableFields.filter(([, candidate]) => fieldMatchesTargetLabel(candidate, targetLabel));
    if (labelled.length === 1) {
      const [id, element] = labelled[0];
      return { id, element, reason: 'semantic_label', candidateCount: 1 };
    }
    if (labelled.length > 1) return { id: null, element: null, reason: 'ambiguous_label', candidateCount: labelled.length };
  }

  if (writableFields.length === 1) {
    const [id, element] = writableFields[0];
    return { id, element, reason: 'single_writable_field', candidateCount: 1 };
  }
  return {
    id: null,
    element: original || currentExact || null,
    reason: writableFields.length > 1 ? 'ambiguous_fields' : 'field_unavailable',
    candidateCount: writableFields.length
  };
}

async function typeVoiceText(elementId, rawText, requestedContextVersion, targetLabel = '') {
  if (!(await hasAIProcessingConsent()) || !Number.isInteger(elementId)) return { ok: false };
  if (!sessionState.lockedTabId) return { ok: false, error: 'Aucun onglet Limova actif.' };
  const operationId = Logger.createOperationId('text-input');
  const requestedVersion = Number.isInteger(requestedContextVersion) ? requestedContextVersion : pageContextVersion;
  const rejectWithFreshContext = async (error, options = {}) => {
    const failureCode = textInputFailureCode(error, options.failureCode);
    Logger.warn('action', 'Text input target rejected before execution', {
      elementId,
      requestedContextVersion: requestedVersion,
      currentContextVersion: pageContextVersion,
      reason: failureCode,
      candidateCount: Number(options.candidateCount || 0),
      clarificationRequired: Boolean(options.clarificationRequired),
      ...safeElementDiagnostic(options.element)
    }, 'TEXT_INPUT_TARGET_REJECTED', operationId);
    return enrichBlockedActionWithFreshContext({
      ok: false,
      status: options.status || 'unexpected',
      clarificationRequired: Boolean(options.clarificationRequired),
      error,
      failureCode
    }, operationId, failureCode);
  };

  if (Number.isInteger(requestedContextVersion) && requestedContextVersion !== pageContextVersion) {
    await getFreshVoiceContext(operationId).catch(() => null);
  }

  const requestedElement = pageElementSnapshots.get(requestedVersion)?.get(elementId)
    || (requestedVersion === pageContextVersion ? lastPageElements.get(elementId) : null);
  if (requestedElement?.type === 'input') {
    if (requestedElement.sensitive) {
      return rejectWithFreshContext('Charly ne peut pas renseigner un champ sensible.', {
        element: requestedElement,
        status: 'blocked',
        failureCode: 'sensitive_field'
      });
    }
    if (requestedElement.disabled) {
      return rejectWithFreshContext('Le champ demandé est absent ou indisponible.', {
        element: requestedElement,
        failureCode: 'field_unavailable'
      });
    }
    if (!WRITABLE_TEXT_INPUT_TYPES.has(String(requestedElement.inputType || 'text').toLowerCase())) {
      return rejectWithFreshContext('Ce type de champ ne peut pas être renseigné par dictée.', {
        element: requestedElement,
        failureCode: 'unsupported_field_type'
      });
    }
  }

  const resolution = resolveCurrentTextField(elementId, requestedVersion, targetLabel);
  const element = resolution.element;
  if (!resolution.id || !element) {
    const ambiguous = resolution.candidateCount > 1;
    return rejectWithFreshContext(
      ambiguous
        ? 'Plusieurs champs correspondent à cette demande. Demande lequel utiliser.'
        : 'Le champ demandé est absent ou indisponible.',
      {
        element,
        status: ambiguous ? 'blocked' : 'unexpected',
        clarificationRequired: ambiguous,
        candidateCount: resolution.candidateCount,
        failureCode: ambiguous ? 'ambiguous_field' : 'field_unavailable'
      }
    );
  }
  const resolvedElementId = resolution.id;
  if (resolvedElementId !== elementId || resolution.reason !== 'exact') {
    Logger.event('action', 'TEXT_INPUT_TARGET_REMAPPED', {
      requestedElementId: elementId,
      resolvedElementId,
      requestedContextVersion: requestedVersion,
      currentContextVersion: pageContextVersion,
      reason: resolution.reason,
      ...safeElementDiagnostic(element)
    }, operationId);
  }
  if (element.sensitive) {
    return rejectWithFreshContext('Charly ne peut pas renseigner un champ sensible.', { element, status: 'blocked', failureCode: 'sensitive_field' });
  }
  if (!WRITABLE_TEXT_INPUT_TYPES.has(String(element.inputType || 'text').toLowerCase())) {
    return rejectWithFreshContext('Ce type de champ ne peut pas être renseigné par dictée.', { element, failureCode: 'unsupported_field_type' });
  }

  const text = String(rawText || '').trim();
  if (!text) {
    return rejectWithFreshContext('Le texte à saisir n’est pas précisé.', { element, clarificationRequired: true, failureCode: 'missing_text' });
  }
  if (text.length > 4_000) {
    return rejectWithFreshContext('Le texte dicté est trop long. Demande une version plus courte.', { element, clarificationRequired: true, failureCode: 'field_length_limit' });
  }

  Logger.event('action', 'TEXT_INPUT_STARTED', {
    elementId: resolvedElementId,
    requestedElementId: elementId,
    contextVersion: pageContextVersion,
    characterCount: text.length,
    inputType: element.inputType || 'text',
    zone: element.zone || 'page'
  }, operationId);

  let result;
  try {
    result = await sendContentMessage(sessionState.lockedTabId, {
      type: 'TYPE_ELEMENT_TEXT',
      id: resolvedElementId,
      contextVersion: pageContextVersion,
      text
    });
  } catch (_) {
    result = { ok: false, error: 'La page Limova ne répond plus.' };
  }
  let executedElementId = resolvedElementId;
  if (result?.ok !== true) {
    Logger.warn('action', 'Initial text input attempt rejected by page', {
      elementId: resolvedElementId,
      requestedElementId: elementId,
      contextVersion: pageContextVersion,
      reason: textInputFailureCode(result?.error),
      error: String(result?.error || '').slice(0, 160),
      status: result?.status || 'unexpected'
    }, 'TEXT_INPUT_INITIAL_ATTEMPT_FAILED', operationId);
    const recovery = await refreshAndRetryElementCommand({
      requestedId: resolvedElementId,
      expectedContextVersion: pageContextVersion,
      descriptor: element,
      commandType: 'text_input',
      message: { type: 'TYPE_ELEMENT_TEXT', text },
      operationId
    }).catch(() => null);
    if (recovery?.result?.ok === true) {
      result = recovery.result;
      executedElementId = recovery.command.id;
    } else {
      const error = recovery?.result?.error || result?.error || 'La saisie a été refusée par la page.';
      Logger.warn('action', 'Text input failed after one contextual recovery', {
        elementId: resolvedElementId,
        requestedElementId: elementId,
        recoveredId: recovery?.command?.id || null,
        characterCount: text.length,
        reason: textInputFailureCode(error),
        ...safeElementDiagnostic(element)
      }, 'TEXT_INPUT_RECOVERY_EXHAUSTED', operationId);
      return enrichBlockedActionWithFreshContext({
        ok: false,
        status: 'unexpected',
        clarificationRequired: Boolean(result?.clarificationRequired),
        error,
        failureCode: textInputFailureCode(error)
      }, operationId, 'text_input_retry_failed');
    }
  }
  Logger.event('action', result?.ok === true ? 'TEXT_INPUT_SUCCEEDED' : 'TEXT_INPUT_FAILED', {
    elementId: executedElementId,
    requestedElementId: elementId,
    ok: result?.ok === true,
    characterCount: text.length,
    inputVerified: result?.inputVerified === true,
    errorCode: result?.error ? textInputFailureCode(result.error) : null,
    ...safeElementDiagnostic(element)
  }, operationId);
  const response = {
    ok: result?.ok === true,
    clarificationRequired: Boolean(result?.clarificationRequired),
    error: result?.error || (result?.ok === true ? undefined : 'La saisie a été refusée par la page.')
  };
  if (executedElementId !== elementId) {
    response.contextVersion = pageContextVersion;
    response.resolvedElementId = executedElementId;
    response.retargeted = true;
  }
  return response;
}

function validateStepCompletion(plan, url, pageContext, userMessage) {
  const step = plan?.steps?.[plan.activeIndex];
  if (!step) return false;
  const user = String(userMessage || '').toLowerCase();
  const page = String(pageContext || '').toLowerCase();
  const pathname = (() => { try { return new URL(url).pathname; } catch (_) { return ''; } })();
  const explicitlySkipped = /\b(passe|passer|suivant|plus tard|skip|next|later|siguiente|más tarde)\b/i.test(user);
  if (explicitlySkipped) return true;

  switch (step.id) {
    case 'orientation-besoins':
      return /\b(lancé|lance|démarré|démarre|créé|cree|résolu|resolu|c'est bon|merci|visite générale|faire le tour|started|launched|resolved|general tour)\b/i.test(`${page} ${user}`);
    case 'decouverte-accueil':
      return /\b(ok|compris|clair|understood|got it|entendido)\b/i.test(user)
        || (pathname && !step.expectedUrls.some(expected => pathname.startsWith(expected)));
    case 'integrations':
      return step.expectedUrls.some(expected => pathname.startsWith(expected))
        && /connect(é|e|ed)|actif|active/.test(page);
    case 'charly-plus-compte':
      return /sauv(é|e)|enregistr(é|e)|saved|no charly|pas charly|sin charly/.test(`${page} ${user}`);
    case 'documents-contexte':
      return /upload|télévers|import|contexte par défaut|default context/.test(page)
        && /fait|done|ajout|added|défini|defined/.test(`${page} ${user}`);
    case 'guidelines-email-agenda':
      return /sauv(é|e)|copi(é|e)|compris|saved|copied|understood/.test(user);
    case 'super-pouvoirs':
      return /déclench|lancé|started|explorer|explore/.test(`${page} ${user}`);
    default:
      { const expectedUrls = Array.isArray(step.expectedUrls) ? step.expectedUrls : [];
        const onExpectedPage = expectedUrls.length === 0 || expectedUrls.some(expected => pathname.startsWith(expected));
        const explicitCompletion = /\b(fait|terminé|termine|connecté|connecte|lancé|lance|créé|cree|réussi|reussi|c'est bon|ok|done|completed|connected|started|created|success)\b/i.test(`${page} ${user}`);
        const criteria = Array.isArray(step.successCriteria) ? step.successCriteria.join(' ').toLowerCase() : '';
        const criteriaTerms = criteria.match(/[\p{L}\p{N}]{5,}/gu) || [];
        const criterionVisible = criteriaTerms.some(term => page.includes(term) || user.includes(term));
        return onExpectedPage && (explicitCompletion || criterionVisible);
      }
  }
}

function resolveElementCommand(
  requestedId,
  expectedContextVersion,
  elementSnapshot,
  commandType = 'highlight',
  currentContextVersion = pageContextVersion,
  currentElements = lastPageElements
) {
  const original = elementSnapshot?.get(requestedId);
  if (!original) {
    Logger.warn('action', 'Model command referenced an element absent from its page context', {
      commandType,
      requestedId,
      expectedContextVersion,
      currentContextVersion
    }, 'ELEMENT_COMMAND_INVALID_ID');
    return null;
  }

  if (currentContextVersion === expectedContextVersion && currentElements.has(requestedId)) {
    return { id: requestedId, contextVersion: currentContextVersion };
  }

  const candidates = [...currentElements.entries()].filter(([, candidate]) =>
    candidate.type === original.type
    && candidate.text === original.text
    && (original.zone || '') === (candidate.zone || '')
    && (original.section || '') === (candidate.section || '')
    && (original.hrefPath || '') === (candidate.hrefPath || '')
    && (original.inputType || '') === (candidate.inputType || '')
  );
  if (candidates.length !== 1) {
    Logger.warn('action', 'Stale element command could not be remapped safely', {
      commandType,
      requestedId,
      expectedContextVersion,
      currentContextVersion,
      candidateCount: candidates.length
    }, 'ELEMENT_COMMAND_STALE_SKIPPED');
    return null;
  }

  const [currentId] = candidates[0];
  Logger.event('action', 'ELEMENT_COMMAND_REMAPPED', {
    commandType,
    requestedId,
    currentId,
    expectedContextVersion,
    currentContextVersion
  });
  return { id: currentId, contextVersion: currentContextVersion };
}

function safeElementDiagnostic(element) {
  return {
    elementType: element?.type || 'unknown',
    inputType: element?.inputType || null,
    zone: element?.zone || 'page',
    position: element?.pos || null,
    labelLength: String(element?.text || '').length,
    sectionLength: String(element?.section || '').length,
    aliasCount: Array.isArray(element?.aliases) ? element.aliases.length : 0,
    actionKind: element?.actionKind || null
  };
}

async function refreshAndRetryElementCommand({
  requestedId,
  expectedContextVersion,
  descriptor,
  commandType,
  message,
  operationId
}) {
  if (!descriptor || !sessionState.lockedTabId) return null;
  const snapshot = new Map([[requestedId, descriptor]]);
  const fresh = await getFreshVoiceContext(operationId);
  const command = resolveElementCommand(
    requestedId,
    expectedContextVersion,
    snapshot,
    commandType,
    fresh.contextVersion,
    lastPageElements
  );
  if (!command) return { fresh, command: null, result: null };
  let result;
  try {
    result = await sendContentMessage(sessionState.lockedTabId, {
      ...message,
      id: command.id,
      contextVersion: command.contextVersion
    }, false);
  } catch (_) {
    result = { ok: false, error: 'La page Limova ne répond plus après actualisation.' };
  }
  Logger.event('action', result?.ok === true ? 'ELEMENT_RECOVERY_RETRY_SUCCEEDED' : 'ELEMENT_RECOVERY_RETRY_FAILED', {
    commandType,
    requestedId,
    recoveredId: command.id,
    expectedContextVersion,
    recoveredContextVersion: command.contextVersion,
    ...safeElementDiagnostic(descriptor)
  }, operationId);
  return { fresh, command, result };
}

function textInputFailureCode(error, fallback = 'field_unavailable') {
  const value = String(error || '');
  if (/annulé/i.test(value)) return 'framework_reverted_input';
  if (/sensible/i.test(value)) return 'sensitive_field';
  if (/plusieurs/i.test(value)) return 'ambiguous_field';
  if (/type de champ/i.test(value)) return 'unsupported_field_type';
  if (/page a changé|carte DOM/i.test(value)) return 'stale_context';
  if (/trop long|limite/i.test(value)) return 'field_length_limit';
  if (/texte.*précis|texte manquant/i.test(value)) return 'missing_text';
  if (/répond plus/i.test(value)) return 'content_script_unavailable';
  return fallback;
}

function normalizeActionLanguage(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ACTION_TARGET_STOP_WORDS = new Set([
  'a', 'alors', 'and', 'appuie', 'apres', 'au', 'aux', 'avec', 'bouton', 'ca', 'ce', 'cela', 'choisis',
  'choose', 'click', 'clique', 'comme', 'compte', 'confirme', 'connecte', 'connecter', 'continue', 'continuer', 'dans', 'de', 'des', 'do', 'donc', 'du',
  'el', 'en', 'et', 'fais', 'go', 'hazlo', 'ici', 'il', 'je', 'juste', 'la', 'le', 'les', 'maintenant',
  'lance', 'lancer', 'me', 'mon', 'navigate', 'navigue', 'of', 'ok', 'on', 'open', 'ouvre', 'page', 'peux', 'please', 'pour',
  'press', 'publie', 'selectionne', 'select', 'send', 'soumet', 'sur', 'the', 'to', 'tu', 'un', 'une', 'va',
  'vas', 'veux', 'voudrais', 'y', 'yes', 'oui', 'adelante', 'abre', 'elige', 'pulsa', 'selecciona', 've'
]);

function actionTargetTokens(value) {
  return normalizeActionLanguage(value)
    .split(/\s+/)
    .filter(token => token.length >= 3 && !ACTION_TARGET_STOP_WORDS.has(token));
}

function actionTokenMatches(left, right) {
  if (left === right) return true;
  const shortest = Math.min(left.length, right.length);
  return shortest >= 5 && (left.startsWith(right) || right.startsWith(left));
}

function elementActionTokens(element) {
  const aliases = Array.isArray(element?.aliases) ? element.aliases.join(' ') : '';
  return actionTargetTokens(
    `${element?.text || ''} ${aliases} ${element?.section || ''} ${element?.hrefPath || ''} ${element?.actionKind || ''}`
  );
}

function semanticTargetLabels(element) {
  return [
    element?.text,
    ...(Array.isArray(element?.aliases) ? element.aliases : []),
    element?.section && element?.text ? `${element.text} ${element.section}` : ''
  ].map(normalizeActionLanguage).filter(Boolean);
}

function recentAssistantActionText() {
  return sessionState.conversationHistory
    .filter(message => message?.role === 'assistant')
    .slice(-3)
    .map(message => String(message.content || ''))
    .join(' ')
    .slice(-8_000);
}

function isDirectMessageSendRequest(message) {
  const normalized = normalizeActionLanguage(message);
  return /(?:^|\s)(?:envoie|envoyer|envoi|send|soumet|soumettre|submit|publie|publier|publish)(?:\s|$)/.test(normalized);
}

function resolveActionIntent(message, element, assistantText = recentAssistantActionText()) {
  const normalized = normalizeActionLanguage(message);
  const direct = /(?:^|\s)(?:clique|cliquer|click|ouvre|ouvrir|open|va sur|vas sur|allez sur|go to|navigue|naviguer|navigate|selectionne|selectionner|select|choisis|choisir|choose|appuie|press|active|activer|connecte|connecter|lance|lancer|demarre|demarrer|continue|continuer|confirme|confirmer|pulsa|abre|navega|selecciona|elige|continua)(?:\s|$)/.test(normalized)
    || isDirectMessageSendRequest(normalized);
  const referential = /(?:^|\s)(?:fais le|fait le|fais ca|vas y|allez y|go ahead|do it|yes do it|ok fais|oui fais|adelante|hazlo)(?:\s|$)/.test(normalized);
  const requestedTokens = actionTargetTokens(normalized);
  const elementTokens = elementActionTokens(element);
  const targetMatched = requestedTokens.length === 0
    || requestedTokens.some(token => elementTokens.some(elementToken => actionTokenMatches(token, elementToken)));
  const assistantTokens = actionTargetTokens(assistantText);
  const assistantMatched = elementTokens.some(token =>
    assistantTokens.some(assistantToken => actionTokenMatches(token, assistantToken))
  );
  const safeIntermediateNavigation = direct
    && !targetMatched
    && assistantMatched
    && element?.type === 'clickable'
    && Boolean(element?.hrefPath)
    && !element?.external
    && !element?.inForm
    && !element?.disabled;
  const associatedTurn = lastUserTurn
    && Date.now() - lastUserTurn.createdAt <= ACTION_INTENT_MAX_AGE_MS
    && normalizeActionLanguage(lastUserTurn.message) === normalized
      ? lastUserTurn
      : null;

  return {
    explicit: direct ? targetMatched || safeIntermediateNavigation : referential && assistantMatched,
    kind: direct ? 'direct' : referential ? 'referential' : 'implicit',
    targetMatched,
    assistantMatched,
    safeIntermediateNavigation,
    requestedTokenCount: requestedTokens.length,
    turnId: associatedTurn?.id || null,
    source: associatedTurn?.source || 'unknown'
  };
}

function isMessageSendRequest(message, element = null, assistantText) {
  if (isDirectMessageSendRequest(message)) return true;
  return element?.actionKind === 'message_send'
    && resolveActionIntent(message, element, assistantText).explicit;
}

function classifyActionRisk(element, { explicitRequest = false, userMessage = '', messageSendRequest = false } = {}) {
  const label = String(element?.text || 'cet élément');
  const consequential = element?.buttonType === 'submit'
    || /supprim|delete|remove|payer|payment|achat|buy|purchase|send|envoyer|publish|publier|autoriser|authorize|allow|grant|confirmer|confirm|valider|save|sauveg|enregistr|submit|invite|déconnect|disconnect|revoke|révoqu/i.test(label);
  const clickableControl = element?.type === 'clickable'
    && !element?.external
    && !element?.disabled;
  const lowRiskNavigation = element?.type === 'clickable'
    && Boolean(element.hrefPath)
    && !element.external
    && !element.inForm
    && !element.disabled
    && !consequential;
  const preparatoryConnection = element?.type === 'clickable'
    && !element.external
    && !element.inForm
    && element.buttonType !== 'submit'
    && !element.disabled
    && (element.actionKind === 'connection_setup'
      || /\b(connect(?:er|ez|ion)?|reconnect(?:er|ez)?|configur(?:er|ez|ation)|setup|commencer|start|continue|continuer)\b/i.test(label))
    && !consequential;
  const explicitSafeControl = explicitRequest
    && clickableControl
    && !consequential;
  const explicitMessageSend = element?.actionKind === 'message_send'
    && !element.disabled
    && (messageSendRequest || isDirectMessageSendRequest(userMessage));
  const autonomousVisibleControl = clickableControl && !consequential;
  const explicitConsequentialControl = explicitRequest
    && clickableControl
    && consequential
    && element?.actionKind !== 'message_send';
  if (lowRiskNavigation) return { level: 'low', label, reason: 'internal_navigation' };
  if (preparatoryConnection) return { level: 'low', label, reason: 'connection_setup' };
  if (explicitMessageSend) return { level: 'low', label, reason: 'explicit_message_send' };
  if (explicitSafeControl) return { level: 'low', label, reason: 'explicit_visible_control' };
  if (autonomousVisibleControl) return { level: 'low', label, reason: 'visible_control' };
  if (explicitConsequentialControl) return { level: 'low', label, reason: 'explicit_consequential_control' };
  return { level: 'sensitive', label, reason: element?.external ? 'external_action' : 'consequential_action' };
}

function isExplicitActionRequest(message, element = null, assistantText) {
  return resolveActionIntent(message, element, assistantText).explicit;
}

function rejectedActionKey(intent, element, userMessage) {
  const semanticTarget = semanticTargetLabels(element)[0]
    || `${element?.type || 'unknown'}:${element?.zone || 'page'}:${element?.pos || ''}`;
  return `${intent?.turnId || normalizeActionLanguage(userMessage)}::${semanticTarget}`;
}

function repeatedRejectedAction(intent, element, userMessage) {
  const key = rejectedActionKey(intent, element, userMessage);
  const previous = recentRejectedActionTargets.get(key);
  recentRejectedActionTargets.set(key, Date.now());
  for (const [candidate, timestamp] of recentRejectedActionTargets) {
    if (Date.now() - timestamp > ACTION_INTENT_MAX_AGE_MS) recentRejectedActionTargets.delete(candidate);
  }
  return Boolean(previous && Date.now() - previous <= ACTION_INTENT_MAX_AGE_MS);
}

async function proposeOrExecuteAction(elementId, userMessage, options = {}) {
  if (!sessionState.lockedTabId) return { ok: false, error: 'Aucun onglet Limova actif.' };
  const operationId = Logger.createOperationId('action');
  const requestedContextVersion = Number(options.requestedContextVersion);
  if (Number.isInteger(requestedContextVersion) && requestedContextVersion !== pageContextVersion) {
    return enrichBlockedActionWithFreshContext({
      ok: false,
      status: 'unexpected',
      error: 'La carte DOM a changé avant le clic.'
    }, operationId, 'stale_click_context');
  }
  const element = lastPageElements.get(elementId);
  if (!element || element.disabled) {
    return enrichBlockedActionWithFreshContext({
      ok: false,
      status: 'blocked',
      clarificationRequired: true,
      error: 'Élément absent ou indisponible.'
    }, operationId, 'target_unavailable');
  }
  const assistantText = recentAssistantActionText();
  const intent = resolveActionIntent(userMessage, element, assistantText);
  const declaredTarget = normalizeActionLanguage(options.targetLabel);
  const currentTargets = semanticTargetLabels(element);
  const declaredTokens = actionTargetTokens(declaredTarget);
  const semanticTokens = elementActionTokens(element);
  const toolTargetMatched = Boolean(declaredTarget) && (
    currentTargets.some(currentTarget => declaredTarget === currentTarget
      || (declaredTarget.length >= 4 && currentTarget.includes(declaredTarget))
      || (currentTarget.length >= 4 && declaredTarget.includes(currentTarget)))
    || (declaredTokens.length > 0 && declaredTokens.some(token =>
      semanticTokens.some(semanticToken => actionTokenMatches(token, semanticToken))
    ))
  );
  const toolExplicitRequest = options.toolExplicitRequest === true && toolTargetMatched;
  const explicitRequest = intent.explicit || toolExplicitRequest;
  // A voice tool call is already bound to the user's current turn and is only
  // considered explicit after its declared label matches the current DOM
  // target. Preserve that verified intent for the exact message-send control;
  // otherwise indirect confirmations such as "oui, fais-le" are classified as
  // consequential and blocked even though the model selected the right button.
  const verifiedToolMessageSend = toolExplicitRequest && element.actionKind === 'message_send';
  const messageSendRequest = verifiedToolMessageSend
    || isMessageSendRequest(userMessage, element, assistantText);
  if (isDirectMessageSendRequest(userMessage) && element.actionKind !== 'message_send') {
    let payload = {
      ok: false,
      status: 'blocked',
      clarificationRequired: true,
      label: String(element.text || 'cet élément'),
      error: 'Le bouton d’envoi exact n’a pas été identifié. Charly doit relire la page avant d’agir.'
    };
    const repeated = repeatedRejectedAction(intent, element, userMessage);
    if (repeated) {
      payload.error = 'Ce bouton n’est toujours pas le contrôle d’envoi. Charly doit choisir une autre cible ou demander une clarification.';
      payload.retryWithFreshContext = false;
    }
    Logger.warn('action', 'Message-send intent did not match the selected DOM target', {
      elementId,
      actionKind: element.actionKind || null,
      labelLength: payload.label.length,
      repeated
    }, repeated ? 'ACTION_REPEATED_TARGET_BLOCKED' : 'ACTION_INTENT_MISMATCH', operationId);
    if (repeated) {
      broadcastToSidebar({ type: 'ACTION_RESULT', ...payload });
      return payload;
    }
    payload = await enrichBlockedActionWithFreshContext(payload, operationId, 'message_target_mismatch');
    if (!payload.retryWithFreshContext) broadcastToSidebar({ type: 'ACTION_RESULT', ...payload });
    return payload;
  }
  if ((intent.kind === 'direct' && !intent.targetMatched && !intent.safeIntermediateNavigation && !toolExplicitRequest)
    || (intent.kind === 'referential' && !intent.assistantMatched && !toolExplicitRequest)) {
    let payload = {
      ok: false,
      status: 'blocked',
      clarificationRequired: true,
      label: String(element.text || 'cet élément'),
      error: intent.kind === 'referential'
        ? 'La cible de « fais-le » n’est pas assez claire. Charly doit demander quel élément utiliser.'
        : 'La cible choisie ne correspond pas à la demande. Charly doit relire la page avant d’agir.'
    };
    if (repeatedRejectedAction(intent, element, userMessage)) {
      payload.error = 'Cette même cible a déjà été refusée pour cette demande. Charly doit choisir une autre cible ou demander une clarification.';
      payload.retryWithFreshContext = false;
      Logger.warn('action', 'Repeated rejected target stopped before another recovery loop', {
        elementId,
        intentKind: intent.kind,
        userTurnId: intent.turnId,
        labelLength: payload.label.length
      }, 'ACTION_REPEATED_TARGET_BLOCKED', operationId);
      broadcastToSidebar({ type: 'ACTION_RESULT', ...payload });
      return payload;
    }
    Logger.warn('action', 'User intent did not match the selected DOM target', {
      elementId,
      intentKind: intent.kind,
      requestedTokenCount: intent.requestedTokenCount,
      userTurnId: intent.turnId,
      labelLength: payload.label.length
    }, 'ACTION_INTENT_MISMATCH', operationId);
    payload = await enrichBlockedActionWithFreshContext(payload, operationId, 'intent_target_mismatch');
    if (!payload.retryWithFreshContext) broadcastToSidebar({ type: 'ACTION_RESULT', ...payload });
    return payload;
  }
  const risk = classifyActionRisk(element, { explicitRequest, userMessage, messageSendRequest });
  Logger.event('action', 'ACTION_CLASSIFIED', {
    elementId,
    risk: risk.level,
    reason: risk.reason,
    explicitRequest,
    labelLength: risk.label.length,
    elementType: element.type,
    buttonType: element.buttonType || null,
    inForm: Boolean(element.inForm),
    hasInternalTarget: Boolean(element.hrefPath && !element.external),
    userTurnId: intent.turnId,
    intentKind: toolExplicitRequest && !intent.explicit ? 'tool_explicit' : intent.kind,
    intentSource: intent.source,
    safeIntermediateNavigation: intent.safeIntermediateNavigation,
    toolTargetMatched,
    verifiedToolMessageSend,
    contextVersion: pageContextVersion,
    ...safeElementDiagnostic(element)
  }, operationId);

  if (risk.level === 'low') {
    return executeElementAction({
      elementId,
      contextVersion: pageContextVersion,
      label: risk.label,
      targetDescriptor: element,
      operationId,
      userTurnId: intent.turnId
    });
  }

  if (risk.level === 'sensitive') {
    const payload = {
      ok: false,
      status: 'blocked',
      label: risk.label,
      error: 'Cette action sensible ne peut pas être exécutée automatiquement.'
    };
    Logger.warn('action', 'Sensitive autonomous action blocked', {
      elementId,
      risk: risk.level
    }, 'ACTION_SENSITIVE_BLOCKED', operationId);
    broadcastToSidebar({ type: 'ACTION_RESULT', ...payload });
    return payload;
  }

  const actionId = crypto.randomUUID();
  const action = {
    actionId,
    elementId,
    contextVersion: pageContextVersion,
    label: risk.label,
    risk: risk.level,
    targetDescriptor: element,
    operationId,
    expiresAt: Date.now() + 30_000
  };
  pendingActions.set(actionId, action);
  Logger.event('action', 'ACTION_CONFIRMATION_REQUESTED', { actionId, elementId, risk: risk.level }, operationId);
  broadcastToSidebar({ type: 'ACTION_PROPOSAL', ...action });
  return { ok: true, status: 'confirmation_requested', actionId };
}

async function executeElementAction(action) {
  if (!sessionState.lockedTabId) return { type: 'ACTION_RESULT', ok: false, error: 'Aucun onglet Limova actif.' };
  const actionStartedAt = Date.now();
  let activeAction = action;
  if (action.contextVersion !== pageContextVersion) {
    const remapped = resolveElementCommand(
      action.elementId,
      action.contextVersion,
      new Map([[action.elementId, action.targetDescriptor]]),
      'action',
      pageContextVersion,
      lastPageElements
    );
    if (remapped) {
      activeAction = { ...action, elementId: remapped.id, contextVersion: remapped.contextVersion };
    } else {
    let payload = {
      type: 'ACTION_RESULT',
      ok: false,
      label: action.label,
      error: 'La page a changé. Demande à Charly de l’analyser à nouveau.'
    };
    payload = await enrichBlockedActionWithFreshContext(payload, action.operationId, 'stale_context');
    broadcastToSidebar(payload);
    Logger.warn('action', 'Action rejected because page context changed', { elementId: action.elementId }, 'ACTION_CONTEXT_CHANGED', action.operationId);
    return payload;
    }
  }
  let contextBeforeClick = lastPageContext;
  let tabBeforeClick = await chrome.tabs.get(sessionState.lockedTabId).catch(() => null);
  let result;
  try {
    result = await sendContentMessage(sessionState.lockedTabId, {
      type: 'EXECUTE_ELEMENT_ACTION',
      id: activeAction.elementId,
      contextVersion: activeAction.contextVersion
    });
  } catch (_) {
    result = { ok: false, error: 'La page Limova ne répond plus.' };
  }
  if (result?.ok !== true) {
    const recovery = await refreshAndRetryElementCommand({
      requestedId: activeAction.elementId,
      expectedContextVersion: activeAction.contextVersion,
      descriptor: activeAction.targetDescriptor,
      commandType: 'action',
      message: { type: 'EXECUTE_ELEMENT_ACTION' },
      operationId: activeAction.operationId
    }).catch(() => null);
    if (recovery?.result?.ok === true) {
      result = recovery.result;
      activeAction = {
        ...activeAction,
        elementId: recovery.command.id,
        contextVersion: recovery.command.contextVersion,
        targetDescriptor: lastPageElements.get(recovery.command.id) || activeAction.targetDescriptor
      };
      contextBeforeClick = recovery.fresh.pageContext;
      tabBeforeClick = await chrome.tabs.get(sessionState.lockedTabId).catch(() => tabBeforeClick);
    }
  }
  let payload = {
    type: 'ACTION_RESULT',
    ok: result?.ok === true,
    label: activeAction.label,
    error: result?.error || (result?.ok === true ? undefined : 'Action refusée par la page.')
  };
  if (result?.ok === true && sessionState.lockedTabId) {
    // Give SPA state, route transitions and request-driven UI enough time to
    // settle. The former 350 ms window incorrectly marked valid Limova clicks
    // as failed on components that update after a debounce.
    await new Promise(resolve => setTimeout(resolve, 700));
    const [refreshedContext, technical] = await Promise.all([
      getPageContext(sessionState.lockedTabId).catch(() => ''),
      getPageTechnicalDiagnostics(sessionState.lockedTabId, actionStartedAt)
    ]);
    if (refreshedContext) {
      payload.pageContext = refreshedContext;
      payload.contextVersion = pageContextVersion;
      payload.elementCount = lastPageElements.size;
    }
    if (technical.summary) payload.technicalDiagnostics = technical.summary;
    if (result.clickDispatched === true) {
      const tabAfterClick = await chrome.tabs.get(sessionState.lockedTabId).catch(() => null);
      const comparable = value => String(value || '').replace(/\b\d+ms\b/g, 'Nms').replace(/\s+/g, ' ').trim();
      const routeChanged = privacySafeUrl(tabBeforeClick?.url || '') !== privacySafeUrl(tabAfterClick?.url || '');
      const domChanged = Boolean(refreshedContext) && comparable(contextBeforeClick) !== comparable(refreshedContext);
      const popupObserved = Boolean(externalPopupFlow || externalPopupTabs.size);
      const networkObserved = technical.network.length > 0;
      const networkFailed = technical.network.some(entry => entry.status === 0 || entry.status >= 400);
      payload.effectObserved = routeChanged || domChanged || popupObserved || networkObserved;
      payload.effectEvidence = {
        routeChanged,
        domChanged,
        popupObserved,
        networkObserved,
        networkFailed,
        consoleErrorCount: technical.console.filter(entry => entry.level === 'error').length
      };
      if (!payload.effectObserved) {
        payload.status = 'unexpected';
        payload.verificationRequired = true;
        payload.error = 'Le clic a été déclenché, mais aucun effet visible n’a encore été confirmé. Charly doit relire la page avant de continuer.';
        payload.visualCapture = await capturePageAnalysis(sessionState.lockedTabId, activeAction.operationId);
      } else if (networkFailed && !routeChanged && !domChanged && !popupObserved) {
        payload.status = 'unexpected';
        payload.verificationRequired = true;
        payload.error = 'Le clic a déclenché une requête en erreur. Charly doit vérifier l’état affiché avant de continuer.';
        payload.visualCapture = await capturePageAnalysis(sessionState.lockedTabId, activeAction.operationId);
      }
    }
  } else {
    payload = await enrichBlockedActionWithFreshContext(payload, activeAction.operationId, 'execution_failed');
  }
  broadcastToSidebar(payload);
  const actionResultCode = result?.ok !== true
    ? 'ACTION_EXECUTION_FAILED'
    : payload.verificationRequired
      ? 'ACTION_EFFECT_UNVERIFIED'
      : 'ACTION_EXECUTED';
  Logger.event('action', actionResultCode, {
    elementId: activeAction.elementId,
    requestedElementId: action.elementId,
    ok: result?.ok === true,
    effectObserved: payload.effectObserved ?? null,
    effectEvidence: payload.effectEvidence || null,
    verificationRequired: Boolean(payload.verificationRequired),
    interactionMode: result?.interactionMode || null,
    retargetedToChild: Boolean(result?.retargetedToChild),
    errorCode: result?.error ? 'content_action_failed' : null,
    userTurnId: activeAction.userTurnId || null,
    contextVersion: activeAction.contextVersion,
    ...safeElementDiagnostic(activeAction.targetDescriptor)
  }, activeAction.operationId);
  return payload;
}

async function enrichBlockedActionWithFreshContext(payload, operationId, reason) {
  try {
    const fresh = await getFreshVoiceContext(operationId, { capture: true });
    Logger.event('visual', 'BLOCKED_ACTION_VISUAL_RECOVERY_READY', {
      reason,
      contextVersion: fresh.contextVersion,
      elementCount: fresh.elementCount,
      hasVisualCapture: Boolean(fresh.visualCapture)
    }, operationId);
    return {
      ...payload,
      pageContext: fresh.pageContext,
      contextVersion: fresh.contextVersion,
      elementCount: fresh.elementCount,
      visualCapture: fresh.visualCapture || null,
      retryWithFreshContext: true
    };
  } catch (error) {
    Logger.warn('visual', 'Blocked action recovery unavailable', {
      reason,
      name: error?.name || 'Error'
    }, 'BLOCKED_ACTION_VISUAL_RECOVERY_FAILED', operationId);
    return payload;
  }
}

async function sendContentMessage(tabId, message, allowRepair = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!allowRepair) throw error;
    Logger.warn('content_script', 'Content script unreachable; attempting one reinjection', {
      tabId,
      messageType: message?.type || 'unknown'
    }, 'CONTENT_SCRIPT_REPAIR_STARTED');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/content.js']
      });
      Logger.event('content_script', 'CONTENT_SCRIPT_REPAIR_SUCCEEDED', { tabId, messageType: message?.type || 'unknown' });
      const mutatingMessage = ['EXECUTE_ELEMENT_ACTION', 'TYPE_ELEMENT_TEXT', 'EXECUTE_PAGE_SCROLL'].includes(message?.type);
      if (mutatingMessage) {
        // IDs belong to the DOM map created before the repair. Never replay a
        // mutating command blindly: the caller must rebuild and remap first.
        return {
          ok: false,
          status: 'unexpected',
          contentScriptRepaired: true,
          error: 'Le pilote de page a été restauré ; la cible doit être relue avant l’action.'
        };
      }
      return chrome.tabs.sendMessage(tabId, message);
    } catch (repairError) {
      Logger.error('content_script', 'Content script repair failed', repairError, 'CONTENT_SCRIPT_REPAIR_FAILED');
      throw repairError;
    }
  }
}

async function confirmPendingAction(actionId) {
  const action = pendingActions.get(actionId);
  pendingActions.delete(actionId);
  if (!action || action.expiresAt < Date.now()) return { ok: false, error: 'Cette confirmation a expiré.' };
  return executeElementAction(action);
}

function cancelPendingAction(actionId) {
  const action = pendingActions.get(actionId);
  const existed = pendingActions.delete(actionId);
  if (action) Logger.event('action', 'ACTION_CANCELLED', { actionId, elementId: action.elementId }, action.operationId);
  return { ok: existed };
}

// Port-based communication with sidebar (reliable for large payloads)
let sidebarPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidebar') {
    sidebarPort = port;
    port.onDisconnect.addListener(() => { sidebarPort = null; });
  }
});

function broadcastToSidebar(message) {
  if (sidebarPort) {
    try {
      Logger.log('background', `Port send: ${message.type}`);
      sidebarPort.postMessage(message);
    } catch (e) {
      Logger.warn('background', `Port send failed: ${e.message}`);
    }
  } else {
    Logger.warn('background', `Port not connected, dropping: ${message.type}`);
    // Fallback to sendMessage
    chrome.runtime.sendMessage(message).catch(() => {});
  }
}

async function getActiveLimovaTab() {
  if (sessionState.lockedTabId) {
    try {
      const tab = await chrome.tabs.get(sessionState.lockedTabId);
      if (isLimovaUrl(tab.url)) return tab;
    } catch (_) {
      sessionState.lockedTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find(t => isLimovaUrl(t.url)) || null;
}

// Named exports keep critical privacy and policy boundaries directly testable.
export {
  analyticsSafePath,
  boundedConversationHistory,
  capturePageAnalysis,
  classifyActionRisk,
  clearCharlyAuthSession,
  confirmPendingAction,
  ensureRemoteCopilotSession,
  executeCopilotTool,
  getPageContext,
  getFreshVoiceContext,
  getKnowledgeContext,
  getCharlyAuthState,
  formatLearnedActionHints,
  getProxyAccessToken,
  handleMessage,
  handleResetSession,
  handleTakeScreenshot,
  lockTab,
  privacySafeUrl,
  proposeOrExecuteAction,
  resolveActionIntent,
  resolveElementCommand,
  runDiagnostics,
  requestCharlyOtp,
  sanitizeDiagnostic,
  searchVoiceKnowledge,
  sendToCopilotV2,
  scrollVoicePage,
  summarizeRecentOperationalIssues,
  typeVoiceText,
  verifyCharlyOtp
};
