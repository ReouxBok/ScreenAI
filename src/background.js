// Native Limova Deep Agent and Studio orchestration.
import { createLimovaBackground, LIMOVA_MESSAGE_TYPES } from './limova/background.js';
import { createBrowserDriver } from './limova/browser-driver.js';
import { createBrowserBinding } from './limova/browser-binding.js';
import { LimovaDeepAgentClient, LimovaClientError, LIMOVA_APP_URL } from './limova/client.js';
import { createLimovaSessionFetch, openLimovaApp } from './limova/session-fetch.js';
import Logger from './utils/logger.js';

const TRAINING_API_URL = 'https://studio.limova.ai/api/training/sessions';
const EVALUATION_API_URL = 'https://studio.limova.ai/api/evaluations/runs';
const AI_CONSENT_KEY = 'limova_ai_processing_consent_v1';
const TRAINING_STATE_STORAGE_KEY = 'charly_training_active_v1';
const TRAINING_STATE_MAX_AGE_MS = 70 * 60_000;
const LIMOVA_ORIGIN = new URL(LIMOVA_APP_URL).origin;
let trainingState = { active: false, stopping: false, token: null, session: null };
let evaluationState = { active: false, token: null, run: null, testCase: null, content: null };
let guidedTabId = null, guidedLastUrl = null, voiceSessionActive = false, pageContextVersion = 0;
let trainingEventQueue = Promise.resolve(), navigationTimer = null, sidebarPort = null;
let externalPopupFlow = null, externalPopupCloseTimer = null;
const pendingTrainingOutcomeTasks = new Set(), recentTrainingContextEvents = new Map(), externalPopupTabs = new Map();

function isLimovaUrl(value) { try { return new URL(value).origin === LIMOVA_ORIGIN; } catch { return false; } }
function generalizePathname(pathname) {
  return String(pathname || '').split('/').map(segment =>
    /^\d{4,}$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 48 ? ':id' : segment).join('/');
}
function privacySafeUrl(value) { try { const url = new URL(value); return `${url.origin}${generalizePathname(url.pathname)}`; } catch { return ''; } }
async function hasAIProcessingConsent() { return (await chrome.storage.local.get(AI_CONSENT_KEY))[AI_CONSENT_KEY] === true; }

const limovaBackground = createLimovaBackground({
  client: new LimovaDeepAgentClient(createLimovaSessionFetch(chrome)),
  createDriver: ({ scope, journal, signal, uploadScreenshot, onBound, expectedTabId }) => createBrowserDriver({
    chrome, scope, journal, signal, uploadScreenshot, onBound, expectedTabId,
    hasConsent: async () => !signal.aborted && !trainingState.active && await hasAIProcessingConsent(),
  }),
  recordEvaluation: async (event, token) => {
    const response = await evaluationFetch('events', { token, body: event });
    if (!response?.ok) throw new Error('La preuve d’exécution n’a pas pu être enregistrée dans le Studio.');
  },
  storage: chrome.storage.local,
  openTab: () => openLimovaApp(chrome),
  openFile: url => chrome.tabs.create({ url }),
  notify: message => broadcastToSidebar(message),
});
const trainingBinding = createBrowserBinding({ scripting: chrome.scripting, allocateVersion: async () => ++pageContextVersion });

async function readTrainingPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isLimovaUrl(tab.url)) throw new Error('Limova page unavailable');
  const target = await trainingBinding.bind(tabId, new URL(tab.url).origin);
  const result = await trainingBinding.execute(target, 'read_page', {});
  if (result.status !== 'completed' || typeof result.observation !== 'string') throw new Error('Limova page unreadable');
  return result.observation;
}

async function persistTrainingState() {
  if (!trainingState.active || !trainingState.token || !trainingState.session?.id) {
    await chrome.storage.session.remove(TRAINING_STATE_STORAGE_KEY); return;
  }
  await chrome.storage.session.set({ [TRAINING_STATE_STORAGE_KEY]: {
    token: trainingState.token, session: trainingState.session, savedAt: Date.now(),
  } });
}
async function restoreTrainingState() {
  try {
    const stored = (await chrome.storage.session.get(TRAINING_STATE_STORAGE_KEY))[TRAINING_STATE_STORAGE_KEY];
    const valid = typeof stored?.token === 'string' && stored.token.length >= 24 && typeof stored?.session?.id === 'string'
      && Number.isFinite(stored?.savedAt) && Date.now() - stored.savedAt <= TRAINING_STATE_MAX_AGE_MS;
    if (!valid) { if (stored) await chrome.storage.session.remove(TRAINING_STATE_STORAGE_KEY); return; }
    trainingState = { active: true, stopping: false, token: stored.token, session: stored.session };
    Logger.event('training', 'TRAINING_STATE_RESTORED', { sessionId: stored.session.id });
  } catch (error) { Logger.warn('training', 'Training state restoration failed', { error: error?.name || 'unknown' }); }
}

const initializationPromise = Logger.initialize({ storageArea: chrome.storage.session, metadata: {
  extensionVersion: chrome.runtime.getManifest().version, uiLanguage: chrome.i18n.getUILanguage(),
} }).then(() => Promise.all([
  restoreTrainingState(),
  chrome.storage.local.remove(['limova_analytics_consent', 'limova_session', 'charly_auth_session_v1']).catch(() => {}),
  chrome.storage.session.remove('charly_evaluation_active').catch(() => {}),
]));
globalThis.addEventListener?.('unhandledrejection', event => Logger.error('service_worker', 'Unhandled promise rejection', event.reason, 'UNHANDLED_REJECTION'));
globalThis.addEventListener?.('error', event => Logger.error('service_worker', 'Uncaught service worker error', event.error || event.message, 'UNCAUGHT_ERROR'));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener(tab => {
  if (Number.isInteger(tab?.id)) chrome.sidePanel.open({ tabId: tab.id }).catch(error =>
    Logger.warn('background', 'Side panel could not be opened', { name: error?.name || 'Error' }, 'SIDE_PANEL_OPEN_FAILED'));
});
chrome.runtime.onInstalled.addListener(details => Logger.event('service_worker', 'EXTENSION_INSTALLED_OR_UPDATED', {
  reason: details?.reason || 'unknown', previousVersion: details?.previousVersion || null,
}));
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidebar') return;
  sidebarPort = port;
  port.onDisconnect.addListener(() => { if (sidebarPort === port) sidebarPort = null; });
});
function broadcastToSidebar(message) {
  if (sidebarPort) { try { sidebarPort.postMessage(message); return; } catch {} }
  chrome.runtime.sendMessage(message).catch(() => {});
}
async function sendContentMessage(tabId, message, allowRepair = true) {
  if (!Number.isInteger(tabId)) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!allowRepair) throw error;
    Logger.warn('content_script', 'Content script unreachable; attempting reinjection', { tabId, messageType: message?.type }, 'CONTENT_SCRIPT_REPAIR_STARTED');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    Logger.event('content_script', 'CONTENT_SCRIPT_REPAIR_SUCCEEDED', { tabId, messageType: message?.type });
    return chrome.tabs.sendMessage(tabId, message);
  }
}
async function getActiveLimovaTab() {
  if (Number.isInteger(guidedTabId)) {
    const guided = await chrome.tabs.get(guidedTabId).catch(() => null);
    if (guided?.url && isLimovaUrl(guided.url)) return guided;
    guidedTabId = null;
  }
  return (await chrome.tabs.query({ active: true, currentWindow: true })).find(tab => isLimovaUrl(tab.url)) || null;
}
async function getAnyLimovaTab() {
  const tabs = await chrome.tabs.query({ url: `${LIMOVA_ORIGIN}/*` }).catch(() => []);
  return tabs.find(tab => isLimovaUrl(tab.url)) || getActiveLimovaTab();
}
function lockGuidedTab(tab) { guidedTabId = tab.id; guidedLastUrl = privacySafeUrl(tab.url) || LIMOVA_ORIGIN; }

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(guidedTabId)) return;
  if (tabId === guidedTabId) broadcastToSidebar({ type: 'CORRECT_TAB' });
  else if (!externalPopupTabs.has(tabId) && !externalPopupFlow) broadcastToSidebar({ type: 'WRONG_TAB' });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void handleExternalPopupClosed(tabId); trainingBinding.forget(tabId);
  if (tabId === guidedTabId) { guidedTabId = null; guidedLastUrl = null; broadcastToSidebar({ type: 'LOCKED_TAB_CLOSED' }); }
});
chrome.tabs.onCreated.addListener(tab => { void trackExternalPopup(tab); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (trainingState.active && tabId === guidedTabId && changeInfo.status === 'complete' && isLimovaUrl(tab.url)) scheduleTrainingNavigation(tabId, tab.url);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (trainingState.active && details.frameId === 0 && details.tabId === guidedTabId && isLimovaUrl(details.url)) scheduleTrainingNavigation(details.tabId, details.url);
}, { url: [{ schemes: ['https'], hostEquals: new URL(LIMOVA_ORIGIN).hostname }] });
function scheduleTrainingNavigation(tabId, url) {
  clearTimeout(navigationTimer); navigationTimer = setTimeout(() => { void recordTrainingNavigation(tabId, url); }, 500);
}
async function recordTrainingNavigation(tabId, url) {
  if (!trainingState.active || tabId !== guidedTabId) return;
  guidedLastUrl = privacySafeUrl(url) || guidedLastUrl;
  await sendContentMessage(tabId, { type: 'TRAINING_STATE', active: true }).catch(() => {});
  const context = await readTrainingPage(tabId).catch(() => '');
  await recordTrainingEvent({ kind: 'navigation', path: guidedLastUrl, label: `Navigation vers ${guidedLastUrl}`, payload: { context: context.slice(0, 8_000) } });
  await recordTrainingContext(context, url);
}

async function trackExternalPopup(tab) {
  if (!trainingState.active || !tab?.id || tab.openerTabId !== guidedTabId || externalPopupTabs.has(tab.id)) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener || (Number.isInteger(tab.windowId) && Number.isInteger(opener.windowId) && tab.windowId === opener.windowId)) return;
  clearTimeout(externalPopupCloseTimer);
  const startsFlow = externalPopupTabs.size === 0 && !externalPopupFlow;
  externalPopupFlow ||= { openerTabId: tab.openerTabId, openedAt: Date.now(), popupCount: 0 };
  externalPopupFlow.popupCount += 1; externalPopupTabs.set(tab.id, { openedAt: Date.now() });
  if (startsFlow) {
    await recordTrainingEvent({ kind: 'page_context', path: guidedLastUrl || '/', label: 'Fenêtre d’autorisation externe ouverte', payload: { phase: 'opened', contentAccessible: false } });
    broadcastToSidebar({ type: 'EXTERNAL_POPUP_STATUS', phase: 'opened' });
  }
  Logger.event('popup', 'EXTERNAL_AUTH_POPUP_OPENED', { popupCount: externalPopupFlow.popupCount });
}
async function handleExternalPopupClosed(tabId) {
  if (!externalPopupTabs.delete(tabId) || externalPopupTabs.size) return;
  clearTimeout(externalPopupCloseTimer);
  externalPopupCloseTimer = setTimeout(() => {
    const flow = externalPopupFlow;
    if (!flow || externalPopupTabs.size) return;
    externalPopupFlow = null; void finalizeExternalPopupFlow(flow);
  }, 3_000);
}
async function finalizeExternalPopupFlow(flow) {
  if (!trainingState.active) return;
  await recordTrainingEvent({ kind: 'page_context', path: guidedLastUrl || '/', label: 'Fenêtre d’autorisation externe fermée',
    payload: { phase: 'closed', durationMs: Date.now() - flow.openedAt, popupCount: flow.popupCount } });
  broadcastToSidebar({ type: 'EXTERNAL_POPUP_STATUS', phase: 'closed' });
  const tab = await chrome.tabs.get(flow.openerTabId).catch(() => null);
  if (tab?.url && isLimovaUrl(tab.url)) await recordTrainingNavigation(tab.id, tab.url);
}

const CONTENT_SCRIPT_MESSAGE_TYPES = new Set(['GET_SESSION_STATE', 'TRAINING_EVENT', 'MODAL_DETECTED', 'EVALUATION_MANUAL_INTERVENTION']);
function isTrustedMessageSource(request, sender) {
  if (!request || typeof request.type !== 'string' || sender?.id !== chrome.runtime.id) return false;
  if (typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))) return true;
  return CONTENT_SCRIPT_MESSAGE_TYPES.has(request.type) && isLimovaUrl(sender.tab?.url || sender.url);
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedMessageSource(request, sender)) { sendResponse({ error: 'Unauthorized message source' }); return false; }
  handleMessage(request, sender).then(sendResponse).catch(error => {
    const code = LIMOVA_MESSAGE_TYPES.has(request.type) && error instanceof LimovaClientError ? error.code : undefined;
    Logger.error('background', 'Message handler error', error, code);
    sendResponse({ error: error.message, ...(code ? { code } : {}) });
  });
  return true;
});

async function handleMessage(request, sender = {}) {
  await initializationPromise;
  if (LIMOVA_MESSAGE_TYPES.has(request.type)) {
    const turnTypes = ['LIMOVA_SEND_MESSAGE', 'LIMOVA_RESUME_BROWSER', 'LIMOVA_PREPARE_VOICE'];
    if (evaluationState.completing && turnTypes.includes(request.type)) return { ok: false, error: 'Transmission du résultat Studio en cours.' };
    if (turnTypes.includes(request.type) && !(await hasAIProcessingConsent())) {
      broadcastToSidebar({ type: 'CONSENT_REQUIRED' }); return { ok: false, consentRequired: true, error: 'Consentement IA requis.' };
    }
    if (trainingState.active && turnTypes.includes(request.type)) return { ok: false, error: 'Termine le mode formateur avant de reprendre une conversation personnelle.' };
    const result = await limovaBackground.handle(request);
    if (request.type === 'LIMOVA_GET_STATE' && evaluationState.active && result.evaluationActive !== true) await cancelEvaluation();
    return result;
  }
  switch (request.type) {
    case 'GET_STATE': return {
      training: trainingState.active ? trainingState.session : null,
      evaluation: evaluationState.active ? { run: evaluationState.run, testCase: evaluationState.testCase, content: evaluationState.content } : null,
      extensionVersion: chrome.runtime.getManifest().version,
      capabilities: { training: true, realEvaluation: true, longTrainingRecording: true, externalPopupLifecycle: true },
    };
    case 'GET_SESSION_STATE': return {
      active: evaluationState.active && sender?.tab?.id === guidedTabId,
      training: trainingState.active && (!sender?.tab?.id || sender.tab.id === guidedTabId),
      evaluationRunId: evaluationState.active && sender?.tab?.id === guidedTabId ? evaluationState.run?.id : null,
    };
    case 'GET_LOGS': case 'RUN_DIAGNOSTICS': return runDiagnostics(request.client || {});
    case 'DIAGNOSTIC_EVENT': return recordClientDiagnostic(request);
    case 'SET_LANG': return { ok: true };
    case 'AI_PROCESSING_CONSENT': await chrome.storage.local.set({ [AI_CONSENT_KEY]: request.granted === true }); return { ok: true };
    case 'GET_PRIVACY_STATE': { const state = await chrome.storage.local.get(AI_CONSENT_KEY); return {
      aiProcessing: state[AI_CONSENT_KEY] === true, aiProcessingDecided: state[AI_CONSENT_KEY] !== undefined,
    }; }
    case 'SWITCH_TO_LOCKED_TAB': if (Number.isInteger(guidedTabId)) await chrome.tabs.update(guidedTabId, { active: true }); return { ok: true };
    case 'VOICE_SESSION_STATE':
      voiceSessionActive = request.active === true;
      Logger.event('voice', voiceSessionActive ? 'VOICE_SESSION_MARKED_ACTIVE' : 'VOICE_SESSION_MARKED_INACTIVE', { engine: request.engine || null });
      return { ok: true };
    case 'START_TRAINING': return startTraining(request.token);
    case 'STOP_TRAINING': return stopTraining(request.token);
    case 'CANCEL_TRAINING': return cancelTraining();
    case 'TRAINING_EVENT': return handleTrainingEvent(request.event || {}, sender);
    case 'MODAL_DETECTED': return handleTrainingModal(request.modal || {}, sender);
    case 'TRAINING_TRANSCRIPT': return storeTrainingTranscript(request);
    case 'START_EVALUATION': return startEvaluation(request.token);
    case 'COMPLETE_EVALUATION': return completeEvaluationRun(request.verdict);
    case 'CANCEL_EVALUATION': return cancelEvaluation();
    case 'EVALUATION_MANUAL_INTERVENTION': return recordManualIntervention(request, sender);
    default: return { error: 'Unknown message type' };
  }
}

function recordClientDiagnostic(request) {
  const component = ['voice', 'sidebar', 'permission_page'].includes(request.component) ? request.component : 'extension_page';
  const code = String(request.code || 'CLIENT_EVENT').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80), data = request.data || null;
  const error = /(?:^|_)(?:FAILED|ERROR|TIMEOUT|DENIED|BLOCKED|UNAVAILABLE|INVALID)$/.test(code);
  const warning = /(?:^|_)(?:DISMISSED|RETRY|RECOVERY_SCHEDULED|MISMATCH)$/.test(code) || (code === 'LIVE_WS_CLOSED' && data?.clean === false);
  Logger.record(error ? 'ERROR' : warning ? 'WARN' : 'INFO', component, code, code, data, request.operationId || null);
  return { ok: true };
}

async function startTraining(rawToken) {
  const token = String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code d’entraînement invalide.' };
  if (evaluationState.active) return { ok: false, error: 'Termine d’abord le test en conditions réelles.' };
  const tab = await getActiveLimovaTab();
  if (!tab?.id) return { ok: false, error: 'Ouvre Limova avant de démarrer la démonstration.' };
  let response;
  try { response = await fetch(`${TRAINING_API_URL}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); }
  catch (error) { Logger.warn('training', 'TRAINING_CONNECTION_FAILED', { error: error?.name || 'network' }); return { ok: false, error: 'Le Studio est momentanément inaccessible. Réessaie dans quelques instants.' }; }
  const session = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: session.error || 'Démonstration introuvable.' };
  if (session.recordingReady) {
    const completed = await fetch(`${TRAINING_API_URL}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    return completed?.ok ? { ok: true, recovered: true, session }
      : { ok: false, error: 'La vidéo précédente est disponible dans le Studio. Finalise-la depuis la fiche du tutoriel.' };
  }
  trainingEventQueue = Promise.resolve(); pendingTrainingOutcomeTasks.clear(); recentTrainingContextEvents.clear();
  trainingState = { active: true, stopping: false, token, session }; lockGuidedTab(tab); await persistTrainingState();
  try {
    await sendContentMessage(tab.id, { type: 'TRAINING_STATE', active: true });
    const context = await readTrainingPage(tab.id);
    await recordTrainingEvent({ kind: 'navigation', path: guidedLastUrl, label: `Départ · ${session.title}`, payload: { context: context.slice(0, 8_000) } });
    await recordTrainingContext(context, tab.url);
  } catch (error) {
    Logger.warn('training', 'TRAINING_START_ROLLBACK', { sessionId: session.id, error: error?.name || 'unknown' });
    await cancelTraining(); return { ok: false, error: 'La page Limova n’a pas pu être préparée. L’essai a été archivé proprement : recommence depuis le Studio.' };
  }
  Logger.event('training', 'TRAINING_STARTED', { sessionId: session.id, agentKey: session.agentKey });
  broadcastToSidebar({ type: 'TRAINING_STATUS', active: true, session }); return { ok: true, session };
}
async function recordTrainingContext(context, url) {
  if (context) await recordTrainingEvent({ kind: 'page_context', path: privacySafeUrl(url) || '/', label: 'Structure de page observée', payload: { context: context.slice(0, 8_000) } });
}
async function getPageNetworkTrace(tabId, since = 0) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
      func: minimum => (window.__limova_network_events || []).filter(event => Number(event.timestamp) >= minimum).slice(-20), args: [Number(since) || 0] });
    return Array.isArray(results?.[0]?.result) ? results[0].result : [];
  } catch { return []; }
}
function scheduleTrainingOutcome(rawEvent, tabId) {
  if (!Number.isInteger(tabId) || rawEvent.kind !== 'click') return;
  const payload = rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
  const task = new Promise(resolve => setTimeout(resolve, 700)).then(async () => {
    if (!trainingState.active || tabId !== guidedTabId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null); if (!tab?.url || !isLimovaUrl(tab.url)) return;
    const [context, network] = await Promise.all([readTrainingPage(tabId).catch(() => ''), getPageNetworkTrace(tabId, Number(payload.capturedAt) || Date.now() - 2_000)]);
    const networkSummary = network.map(event => `${String(event.method || 'GET').slice(0, 10)} ${String(event.target || '').slice(0, 300)}${Number(event.status) ? ` status:${Number(event.status)}` : ''} ${Math.max(0, Number(event.durationMs) || 0)}ms`).join('\n').slice(0, 8_000);
    await recordTrainingEvent({ kind: 'page_context', path: privacySafeUrl(tab.url), label: `Résultat après clic · ${String(rawEvent.label || 'Contrôle').slice(0, 220)}`,
      payload: { phase: 'after_click', gestureId: String(payload.gestureId || '').slice(0, 100), actionLabel: String(rawEvent.label || '').slice(0, 240), context: context.slice(0, 8_000), networkSummary } });
  }).catch(error => Logger.warn('training', 'Post-click outcome capture failed', { error: error?.name || 'unknown' }));
  pendingTrainingOutcomeTasks.add(task); task.finally(() => pendingTrainingOutcomeTasks.delete(task));
}
async function handleTrainingEvent(rawEvent, sender) {
  if (sender?.tab?.id && sender.tab.id !== guidedTabId) return { ok: false, error: 'Onglet de démonstration invalide.' };
  const result = await recordTrainingEvent(rawEvent);
  if (result?.ok && rawEvent?.kind === 'click') scheduleTrainingOutcome(rawEvent, sender?.tab?.id || guidedTabId);
  return result;
}
async function handleTrainingModal(modal, sender) {
  if (!trainingState.active || sender?.tab?.id !== guidedTabId) return { ok: false };
  const context = await readTrainingPage(guidedTabId).catch(() => '');
  return recordTrainingEvent({
    kind: 'page_context', path: guidedLastUrl || sender?.tab?.url || '/',
    label: `Popup Limova · ${String(modal.title || 'Fenêtre détectée').slice(0, 180)}`,
    payload: {
      role: String(modal.role || 'dialog').slice(0, 40),
      controls: Array.isArray(modal.controls) ? modal.controls.join(' · ').slice(0, 1_000) : '',
      context: context.slice(0, 8_000),
    },
  });
}
async function recordTrainingEvent(rawEvent) {
  if (!trainingState.active || trainingState.stopping || !trainingState.token) return { ok: false, error: 'Aucun entraînement actif.' };
  const event = { kind: String(rawEvent.kind || ''), path: privacySafeUrl(rawEvent.path || guidedLastUrl || '') || '/',
    label: String(rawEvent.label || '').slice(0, 500), payload: rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {} };
  if (['page_context', 'network'].includes(event.kind) && !/^Fenêtre d’autorisation externe/.test(event.label)) {
    const signature = `${event.kind}|${event.path}|${event.label}`, previousAt = recentTrainingContextEvents.get(signature) || 0;
    if (Date.now() - previousAt < 3_000) return { ok: true, deduplicated: true };
    recentTrainingContextEvents.set(signature, Date.now());
  }
  const token = trainingState.token;
  const queued = trainingEventQueue.then(async () => {
    const response = await fetch(`${TRAINING_API_URL}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(event), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) Logger.warn('training', 'TRAINING_EVENT_REJECTED', { kind: event.kind, status: response.status });
    return { ok: response.ok };
  });
  trainingEventQueue = queued.then(() => undefined, () => undefined); return queued;
}
async function stopTraining(rawToken) {
  const token = trainingState.token || String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code de démonstration indisponible.' };
  if (trainingState.active) {
    await sendContentMessage(guidedTabId, { type: 'TRAINING_STATE', active: false }).catch(() => {});
    await Promise.allSettled([...pendingTrainingOutcomeTasks]); trainingState.stopping = true; await trainingEventQueue;
  }
  let response;
  try { response = await fetch(`${TRAINING_API_URL}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); }
  catch { trainingState.stopping = false; await persistTrainingState(); return { ok: false, error: 'Le Studio est momentanément inaccessible. Réessaie la finalisation.' }; }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { trainingState.stopping = false; await persistTrainingState(); return { ok: false, error: payload.error || 'La démonstration n’a pas pu être terminée.' }; }
  trainingState = { active: false, stopping: false, token: null, session: null }; guidedTabId = null; guidedLastUrl = null;
  await persistTrainingState(); broadcastToSidebar({ type: 'TRAINING_STATUS', active: false, completed: true }); return { ok: true };
}
async function cancelTraining() {
  const token = trainingState.token, sessionId = trainingState.session?.id || null;
  await sendContentMessage(guidedTabId, { type: 'TRAINING_STATE', active: false }).catch(() => {});
  trainingState = { active: false, stopping: false, token: null, session: null }; guidedTabId = null; guidedLastUrl = null;
  await persistTrainingState(); trainingEventQueue = Promise.resolve(); pendingTrainingOutcomeTasks.clear(); recentTrainingContextEvents.clear();
  let serverResult = null;
  if (token) { const response = await fetch(`${TRAINING_API_URL}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (response?.ok) serverResult = await response.json().catch(() => null); }
  broadcastToSidebar({ type: 'TRAINING_STATUS', active: false, cancelled: true }); Logger.event('training', 'TRAINING_CANCELLED_LOCALLY', { sessionId });
  return { ok: true, recovered: serverResult?.recovered === true, status: serverResult?.status || null };
}
async function storeTrainingTranscript({ trainingSessionId, text, partial }) {
  if (!(await hasAIProcessingConsent()) || !trainingState.active || trainingState.session?.id !== trainingSessionId
    || typeof text !== 'string' || !text.trim() || text.length > 32_000) return { ok: false, error: 'Démonstration ou transcription indisponible.' };
  const chunks = Array.from(text.trim()).reduce((result, character) => {
    if (!result.length || result.at(-1).length + character.length > 500) result.push(character); else result[result.length - 1] += character; return result;
  }, []);
  for (const label of chunks) {
    if (!(await hasAIProcessingConsent()) || !trainingState.active || trainingState.session?.id !== trainingSessionId) return { ok: false, error: 'La démonstration ou le consentement a changé.' };
    if (!(await recordTrainingEvent({ kind: 'voice_note', path: guidedLastUrl || '/', label, payload: { source: 'limova_transcription', partial: partial === true } }))?.ok)
      return { ok: false, error: 'La note vocale n’a pas pu être enregistrée.' };
  }
  return { ok: true };
}

async function evaluationFetch(path, options = {}) {
  const token = options.token || evaluationState.token; if (!token) return null;
  return fetch(`${EVALUATION_API_URL}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body || {}), signal: AbortSignal.timeout(15_000) });
}
async function startEvaluation(rawToken) {
  const token = String(rawToken || '').trim();
  if (token.length < 24) return { ok: false, error: 'Code de test invalide.' };
  if (trainingState.active) return { ok: false, error: 'Termine d’abord la démonstration en cours.' };
  if (evaluationState.active) return { ok: false, error: 'Un test est déjà en cours. Termine-le avant d’en lancer un autre.' };
  const tab = await getActiveLimovaTab(); if (!tab?.id) return { ok: false, error: 'Ouvre Limova avant de lancer le test.' };
  await limovaBackground.handle({ type: 'LIMOVA_START_EVALUATION', evaluationCode: token });
  let response;
  try { response = await evaluationFetch('connect', { token, body: { extensionVersion: chrome.runtime.getManifest().version } }); }
  catch (error) { await limovaBackground.handle({ type: 'LIMOVA_END_EVALUATION' }).catch(() => {}); throw error; }
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) { await limovaBackground.handle({ type: 'LIMOVA_END_EVALUATION' }).catch(() => {}); return { ok: false, error: data?.error || 'Test introuvable ou expiré.' }; }
  evaluationState = { active: true, token, run: data.run, testCase: data.case, content: { id: data.content?.id, title: data.content?.title, versionId: data.content?.versionId } };
  lockGuidedTab(tab);
  const observation = await sendContentMessage(tab.id, { type: 'EVALUATION_OBSERVATION', runId: data.run?.id }).catch(() => null);
  if (!observation?.ok) { await cancelEvaluation(); throw new Error('Observation du test indisponible.'); }
  Logger.event('evaluation', 'REAL_EVALUATION_STARTED', { runId: data.run?.id || null, caseKind: data.case?.kind || null });
  return { ok: true, run: data.run, testCase: data.case, content: evaluationState.content };
}
async function recordManualIntervention(request, sender) {
  if (!evaluationState.active || request.runId !== evaluationState.run?.id || sender?.tab?.id !== guidedTabId || sender.frameId !== 0) return { ok: false };
  if (!evaluationState.manualEvidence) {
    const token = evaluationState.token;
    evaluationState.manualEvidence = evaluationFetch('events', { token, body: { kind: 'manual_intervention', status: 'unexpected', manualIntervention: true } })
      .then(response => { if (!response?.ok) throw new Error('Intervention manuelle non enregistrée dans Studio.'); });
  }
  await evaluationState.manualEvidence; return { ok: true };
}
async function completeEvaluationRun(verdict) {
  if (!evaluationState.active || !['correct', 'problem'].includes(verdict)) return { ok: false, error: 'Aucun test actif.' };
  if (evaluationState.completing) return { ok: false, error: 'Transmission déjà en cours.' };
  evaluationState.completing = true;
  try {
    await limovaBackground.handle({ type: 'LIMOVA_CANCEL' });
    const observation = await sendContentMessage(guidedTabId, { type: 'FLUSH_EVALUATION_OBSERVATION', runId: evaluationState.run?.id });
    if (!observation?.ok) throw new Error('Preuve d’intervention manuelle indisponible.');
    await evaluationState.manualEvidence; await limovaBackground.handle({ type: 'LIMOVA_FLUSH_EVALUATION' });
    const response = await evaluationFetch('complete', { body: { verdict } }), data = await response?.json().catch(() => ({}));
    if (!response?.ok) return { ok: false, error: data?.error || 'Le résultat n’a pas pu être transmis.' };
    await limovaBackground.handle({ type: 'LIMOVA_END_EVALUATION' }).catch(() => {});
    await sendContentMessage(guidedTabId, { type: 'EVALUATION_OBSERVATION', runId: null }).catch(() => {});
    evaluationState = { active: false, token: null, run: null, testCase: null, content: null }; guidedTabId = null; guidedLastUrl = null;
    return { ok: true, run: data.run, suite: data.suite };
  } finally {
    evaluationState.completing = false;
    if (evaluationState.active) await sendContentMessage(guidedTabId, { type: 'EVALUATION_OBSERVATION', runId: evaluationState.run?.id }).catch(() => {});
  }
}
async function cancelEvaluation() {
  await sendContentMessage(guidedTabId, { type: 'EVALUATION_OBSERVATION', runId: null }).catch(() => {});
  await limovaBackground.handle({ type: 'LIMOVA_END_EVALUATION' }).catch(() => {});
  evaluationState = { active: false, token: null, run: null, testCase: null, content: null }; guidedTabId = null; guidedLastUrl = null; return { ok: true };
}

async function runDiagnostics(client = {}) {
  const incidentId = Logger.createOperationId('incident'), checks = [];
  const add = (name, status, detail, code) => { checks.push({ name, status, detail, code }); Logger.event('diagnostics', code, { status, detail }, incidentId); };
  add('extension', 'ok', `Version ${chrome.runtime.getManifest().version}, service worker actif`, 'DIAGNOSTIC_EXTENSION_OK');
  try { await chrome.storage.session.set({ limova_diagnostic_probe: Date.now() }); await chrome.storage.session.remove('limova_diagnostic_probe'); add('diagnosticStorage', 'ok', 'Journal de session disponible', 'DIAGNOSTIC_STORAGE_OK'); }
  catch { add('diagnosticStorage', 'error', 'Journal de session indisponible', 'DIAGNOSTIC_STORAGE_FAILED'); }
  const consent = await chrome.storage.local.get(AI_CONSENT_KEY).catch(() => ({}));
  add('aiConsent', consent[AI_CONSENT_KEY] === true ? 'ok' : 'info', consent[AI_CONSENT_KEY] === true ? 'Traitement IA autorisé' : 'Traitement IA non activé', 'DIAGNOSTIC_CONSENT_STATE');
  try { (await limovaBackground.diagnose()).forEach(check => add(check.name, check.status, check.detail, check.code)); }
  catch { add('limovaSession', 'error', 'Diagnostic Limova indisponible', 'DIAGNOSTIC_LIMOVA_PROBE_FAILED'); }
  const tab = await getAnyLimovaTab().catch(() => null);
  if (!tab?.id) { add('limovaTab', 'info', 'Aucun onglet Limova ouvert', 'DIAGNOSTIC_LIMOVA_TAB_MISSING'); add('contentScript', 'info', 'Content script non vérifiable sans onglet Limova', 'DIAGNOSTIC_CONTENT_SCRIPT_UNAVAILABLE'); }
  else {
    add('limovaTab', 'ok', 'Onglet Limova détecté', 'DIAGNOSTIC_LIMOVA_TAB_OK');
    try { const pong = await Promise.race([sendContentMessage(tab.id, { type: 'DIAGNOSTIC_PING' }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000))]);
      add('contentScript', pong?.ok ? 'ok' : 'info', pong?.ok ? 'Content script joignable' : 'Réponse content script invalide', pong?.ok ? 'DIAGNOSTIC_CONTENT_SCRIPT_OK' : 'DIAGNOSTIC_CONTENT_SCRIPT_INVALID'); }
    catch { add('contentScript', 'info', 'Content script absent ou non joignable', 'DIAGNOSTIC_CONTENT_SCRIPT_UNREACHABLE'); }
  }
  const mic = ['granted', 'prompt', 'denied'].includes(client.microphonePermission) ? client.microphonePermission : 'unknown';
  const micStatus = client.mediaDevicesSupported === false || mic === 'denied' ? 'error' : mic === 'granted' ? 'ok' : 'info';
  add('microphone', micStatus, client.mediaDevicesSupported === false ? 'API microphone indisponible' : `Permission microphone : ${mic}`, micStatus === 'error' ? 'DIAGNOSTIC_MICROPHONE_BLOCKED' : 'DIAGNOSTIC_MICROPHONE_STATE');
  add('voice', 'info', voiceSessionActive ? 'Session vocale active' : 'Connexion vocale non testée ; aucun microphone ouvert', voiceSessionActive ? 'DIAGNOSTIC_VOICE_ACTIVE' : 'DIAGNOSTIC_VOICE_NOT_TESTED');
  const failing = checks.filter(check => check.status === 'error');
  const diagnostic = { ok: !failing.length, status: failing.length ? 'degraded' : 'healthy', incidentId, checks, probableCause: failing[0]?.detail || null,
    client: Logger._sanitize({ browser: client.browser || 'unknown', language: client.language || 'unknown' }) };
  Logger.event('diagnostics', 'DIAGNOSTIC_COMPLETED', { status: diagnostic.status, failingChecks: failing.map(check => check.code) }, incidentId);
  await Logger.flush(); return { ...diagnostic, logs: Logger.getLogsAsText(diagnostic) };
}

export { handleMessage, privacySafeUrl, runDiagnostics };
