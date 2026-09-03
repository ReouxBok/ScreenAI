/**
 * Limova AI - Charly Onboarding Assistant - Sidebar Logic
 * Handles chat rendering, user input, and background communication
 * i18n: all user-facing strings use t() from i18n.js
 */

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
  statusBadge: document.getElementById('statusBadge'),
  resetBtn: document.getElementById('resetBtn'),
  welcomeScreen: document.getElementById('welcomeScreen'),
  stepInfo: document.getElementById('stepInfo'),
  stepName: document.getElementById('stepName'),
  stepProgress: document.getElementById('stepProgress'),
  chatContainer: document.getElementById('chatContainer'),
  userInput: document.getElementById('userInput'),
  sendBtn: document.getElementById('sendBtn'),
  screenshotBtn: document.getElementById('screenshotBtn'),
  voiceBtn: document.getElementById('voiceBtn'),
  downloadLogsBtn: document.getElementById('downloadLogsBtn'),
  diagnoseBtn: document.getElementById('diagnoseBtn'),
  diagnosticResult: document.getElementById('diagnosticResult'),
  diagnosticText: document.getElementById('diagnosticText'),
  tabWarning: document.getElementById('tabWarning'),
  tabWarningText: document.getElementById('tabWarningText'),
  stepClose: document.getElementById('stepClose'),
  aiConsentPanel: document.getElementById('aiConsentPanel'),
  aiConsentAccept: document.getElementById('aiConsentAccept'),
  aiConsentDecline: document.getElementById('aiConsentDecline'),
  trainingPanel: document.getElementById('trainingPanel'),
  trainingToken: document.getElementById('trainingToken'),
  trainingFeedback: document.getElementById('trainingFeedback'),
  trainingStart: document.getElementById('trainingStart'),
  trainingMic: document.getElementById('trainingMic'),
  trainingStop: document.getElementById('trainingStop'),
  evaluationPanel: document.getElementById('evaluationPanel'),
  evaluationToken: document.getElementById('evaluationToken'),
  evaluationFeedback: document.getElementById('evaluationFeedback'),
  evaluationStart: document.getElementById('evaluationStart'),
  evaluationVerdict: document.getElementById('evaluationVerdict'),
  evaluationCorrect: document.getElementById('evaluationCorrect'),
  evaluationProblem: document.getElementById('evaluationProblem'),
  authPanel: document.getElementById('authPanel'),
  authEmailForm: document.getElementById('authEmailForm'),
  authEmail: document.getElementById('authEmail'),
  authEmailSubmit: document.getElementById('authEmailSubmit'),
  authCodeForm: document.getElementById('authCodeForm'),
  authCode: document.getElementById('authCode'),
  authCodeSubmit: document.getElementById('authCodeSubmit'),
  authBack: document.getElementById('authBack'),
  authFeedback: document.getElementById('authFeedback'),
  memoryToggleBtn: document.getElementById('memoryToggleBtn'),
  exportDataBtn: document.getElementById('exportDataBtn'),
  deleteDataBtn: document.getElementById('deleteDataBtn'),
};

// ============================================================================
// State
// ============================================================================

let isLoading = false;
let welcomeScreenVisible = true;
let lastMessageSender = null;
let voiceSession = null;
let backgroundCapabilities = {};
let trainingCaptureActive = false;
let trainingScreenRecorder = null;
let activeTrainingSession = null;
let activeTrainingToken = '';
let authChallenge = null;
let backgroundPort = null;
let backgroundReconnectTimer = null;
let backgroundReconnectAttempts = 0;
let hasConnectedBackgroundPort = false;
const voiceTranscriptBuffers = { user: '', assistant: '' };

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.dataset.authState = 'checking';
  await loadLangPreference();
  applyTranslations();
  updateLangSwitcher();
  renderAnnouncements();
  initEventListeners();
  await loadInitialState();
  document.documentElement.dataset.sidebarReady = 'true';
});

function initEventListeners() {
  elements.userInput.addEventListener('input', handleInputChange);
  elements.userInput.addEventListener('keydown', handleInputKeydown);
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.screenshotBtn.addEventListener('click', analyzePage);
  elements.voiceBtn.addEventListener('click', toggleVoice);
  elements.authEmailForm?.addEventListener('submit', requestAuthenticationCode);
  elements.authCodeForm?.addEventListener('submit', verifyAuthenticationCode);
  elements.authBack?.addEventListener('click', resetAuthenticationForm);

  elements.resetBtn.addEventListener('click', () => { document.getElementById('headerMenu').hidden = true; resetSession(); });
  document.getElementById('logoutBtn')?.addEventListener('click', logoutCharly);
  elements.memoryToggleBtn?.addEventListener('click', toggleCopilotMemory);
  elements.exportDataBtn?.addEventListener('click', exportCopilotData);
  elements.deleteDataBtn?.addEventListener('click', deleteCopilotData);

  // Three-dot menu
  const menuBtn = document.getElementById('menuBtn');
  const headerMenu = document.getElementById('headerMenu');
  if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      headerMenu.hidden = !headerMenu.hidden;
    });
  }
  document.addEventListener('click', (e) => {
    if (headerMenu && !headerMenu.hidden && !e.target.closest('.menu-wrapper')) {
      headerMenu.hidden = true;
    }
  });

  elements.downloadLogsBtn.addEventListener('click', downloadLogs);
  elements.diagnoseBtn.addEventListener('click', () => runDiagnostics(false));
  elements.tabWarning.addEventListener('click', handleTabWarningClick);

  // Dismiss onboarding
  elements.stepClose.addEventListener('click', () => {
    elements.stepInfo.hidden = true;
    chrome.runtime.sendMessage({ type: 'DISMISS_ONBOARDING' });
  });

  // Language switcher
  document.getElementById('langSwitcher')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-option');
    if (btn?.dataset.lang) {
      setLang(btn.dataset.lang);
    }
  });

  elements.aiConsentAccept.addEventListener('click', () => handleAIConsent(true));
  elements.aiConsentDecline.addEventListener('click', () => handleAIConsent(false));
  document.getElementById('trainingBtn')?.addEventListener('click', () => {
    headerMenu.hidden = true;
    elements.trainingPanel.hidden = false;
    if (backgroundCapabilities.training !== true) {
      elements.trainingFeedback.textContent = 'Recharge Limova AI depuis chrome://extensions (bouton ↻), puis recharge la page Limova.';
    }
  });
  document.getElementById('evaluationBtn')?.addEventListener('click', () => {
    document.getElementById('headerMenu').hidden = true;
    elements.trainingPanel.hidden = true;
    elements.evaluationPanel.hidden = false;
  });
  document.getElementById('evaluationClose')?.addEventListener('click', () => { elements.evaluationPanel.hidden = true; });
  elements.evaluationStart?.addEventListener('click', startEvaluation);
  elements.evaluationCorrect?.addEventListener('click', () => completeEvaluation('correct'));
  elements.evaluationProblem?.addEventListener('click', () => completeEvaluation('problem'));
  document.getElementById('trainingClose')?.addEventListener('click', () => { if (elements.trainingStop.hidden) elements.trainingPanel.hidden = true; });
  elements.trainingStart?.addEventListener('click', startTrainingCapture);
  elements.trainingMic?.addEventListener('click', toggleVoice);
  elements.trainingStop?.addEventListener('click', stopTrainingCapture);

  // Copy buttons and next-step links in chat
  elements.chatContainer.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-code-btn');
    if (copyBtn) {
      const pre = copyBtn.closest('pre');
      if (pre) {
        const code = pre.querySelector('code');
        navigator.clipboard.writeText(code?.textContent || pre.textContent);
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = t('copyBtn'); }, 2000);
      }
    }
    if (e.target.classList.contains('next-step-link')) {
      e.preventDefault();
      sendNextStepRequest();
    }
    const actionButton = e.target.closest('[data-action-id]');
    if (actionButton) handleActionDecision(actionButton.dataset.actionId, actionButton.dataset.decision === 'confirm');
  });

  window.addEventListener('limova-voice-status', event => updateVoiceStatus(event.detail));
  window.addEventListener('limova-voice-transcript', event => handleVoiceTranscript(event.detail));
  window.addEventListener('limova-voice-consent-required', () => showAIConsent());
  window.addEventListener('limova-training-screen-ended', handleTrainingScreenEnded);
  window.addEventListener('limova-training-recording-limit', handleTrainingRecordingLimit);
  window.addEventListener('pagehide', () => {
    voiceSession?.stop(false);
    if (trainingCaptureActive) {
      trainingScreenRecorder?.abort();
      chrome.runtime.sendMessage({ type: 'CANCEL_TRAINING' }).catch(() => {});
    }
  });

  // Keep the document mounted while the MV3 service worker sleeps/restarts.
  // Reloading the whole sidebar here used to expose the sign-in screen for a
  // moment even though the persistent session was still valid.
  connectBackgroundPort();
  // Fallback for messages not sent via port
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

function connectBackgroundPort() {
  if (backgroundPort) return;
  if (backgroundReconnectTimer) {
    clearTimeout(backgroundReconnectTimer);
    backgroundReconnectTimer = null;
  }
  try {
    const port = chrome.runtime.connect({ name: 'sidebar' });
    const isReconnect = hasConnectedBackgroundPort;
    backgroundPort = port;
    hasConnectedBackgroundPort = true;
    backgroundReconnectAttempts = 0;
    port.onMessage.addListener(handleBackgroundMessage);
    port.onDisconnect.addListener(() => {
      if (backgroundPort === port) backgroundPort = null;
      scheduleBackgroundReconnect();
    });
    if (isReconnect) refreshAuthenticationState();
  } catch (_) {
    backgroundPort = null;
    scheduleBackgroundReconnect();
  }
}

function scheduleBackgroundReconnect() {
  if (backgroundReconnectTimer) return;
  const delay = Math.min(3_000, 250 * (2 ** backgroundReconnectAttempts));
  backgroundReconnectAttempts = Math.min(backgroundReconnectAttempts + 1, 4);
  backgroundReconnectTimer = setTimeout(() => {
    backgroundReconnectTimer = null;
    connectBackgroundPort();
  }, delay);
}

async function refreshAuthenticationState() {
  const response = await chrome.runtime.sendMessage({ type: 'AUTH_GET_STATE' }).catch(() => null);
  applyAuthenticationState(response);
}

function applyAuthenticationState(auth) {
  if (auth?.authenticated === true) {
    setAuthenticationVisible(false);
  } else if (auth?.authenticated === false && auth?.pending !== true) {
    setAuthenticationVisible(true);
  } else {
    document.documentElement.dataset.authState = 'checking';
  }
}

async function loadInitialState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    backgroundCapabilities = response?.capabilities || {};
    applyAuthenticationState(response?.auth);
    const visibleHistory = response?.conversationHistory?.length > 0
      ? response.conversationHistory
      : (response?.copilot?.recentMessages || []).map(message => ({ role: message.role, content: message.content }));
    if (visibleHistory.length > 0) {
      hideWelcomeScreen();
      visibleHistory.forEach(msg => {
        if (msg.role !== 'screenshot') {
          addMessage(msg.role, msg.content, { skipScroll: true });
        }
      });
      scrollToBottom();
    } else if (response?.copilot?.greeting) {
      hideWelcomeScreen();
      addMessage('assistant', response.copilot.greeting, { skipScroll: true });
    }
    updateMemoryControls(response?.copilot);
    // Restore onboarding step progress
    if (response?.onboardingPlan) {
      const plan = response.onboardingPlan;
      const current = plan.steps[plan.activeIndex];
      if (current) {
        updateStepInfo(current.name, `${plan.activeIndex + 1} / ${plan.steps.length}`);
      }
    }
    if (response?.training) {
      const recovery = await chrome.runtime.sendMessage({ type: 'CANCEL_TRAINING' }).catch(() => null);
      elements.trainingPanel.hidden = false;
      elements.trainingFeedback.textContent = recovery?.recovered
        ? 'La vidéo complète a été retrouvée et finalisée automatiquement dans le Studio.'
        : 'L’enregistrement vidéo était incomplet. L’essai a été archivé proprement : utilise « Recommencer » dans le Studio.';
    }
    if (response?.evaluation) showEvaluationActive(response.evaluation);
  } catch (e) {
    // Extension context not ready yet
  }

  // Check if user is on Limova — show link if not
  checkIfOnLimova();

}

function setAuthenticationVisible(required) {
  elements.authPanel.hidden = !required;
  document.documentElement.dataset.authState = required ? 'required' : 'authenticated';
  if (required) {
    voiceSession?.stop(false);
    voiceSession = null;
    setTimeout(() => elements.authEmail?.focus(), 0);
  }
}

function setAuthFeedback(message, error = false) {
  elements.authFeedback.textContent = message || '';
  elements.authFeedback.classList.toggle('error', error);
}

async function requestAuthenticationCode(event) {
  event.preventDefault();
  const email = elements.authEmail.value.trim();
  if (!elements.authEmail.checkValidity()) {
    setAuthFeedback('Saisis une adresse email valide.', true);
    elements.authEmail.reportValidity();
    return;
  }
  elements.authEmailSubmit.disabled = true;
  setAuthFeedback('Vérification du compte Limova…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'AUTH_REQUEST_OTP', email });
    if (!result?.challenge) throw new Error(result?.error || 'Impossible d’envoyer le code.');
    authChallenge = result.challenge;
    elements.authEmailForm.hidden = true;
    elements.authCodeForm.hidden = false;
    setAuthFeedback('Si ce compte Limova est actif, un code vient d’être envoyé.');
    elements.authCode.focus();
  } catch (error) {
    setAuthFeedback(error.message || 'Connexion temporairement indisponible.', true);
  } finally {
    elements.authEmailSubmit.disabled = false;
  }
}

async function verifyAuthenticationCode(event) {
  event.preventDefault();
  const code = elements.authCode.value.trim();
  if (!/^\d{6}$/.test(code) || !authChallenge) {
    setAuthFeedback('Saisis le code à six chiffres reçu par email.', true);
    return;
  }
  elements.authCodeSubmit.disabled = true;
  setAuthFeedback('Connexion…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'AUTH_VERIFY_OTP', challenge: authChallenge, code });
    if (!result?.authenticated) throw new Error(result?.error || 'Code incorrect ou expiré.');
    setAuthFeedback('Connexion réussie.');
    setAuthenticationVisible(false);
    resetAuthenticationForm();
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
    updateMemoryControls(state?.copilot);
    if (state?.copilot?.greeting && elements.chatContainer.childElementCount === 0) {
      hideWelcomeScreen();
      addMessage('assistant', state.copilot.greeting);
    }
  } catch (error) {
    setAuthFeedback(error.message || 'Code incorrect ou expiré.', true);
    elements.authCode.select();
  } finally {
    elements.authCodeSubmit.disabled = false;
  }
}

function resetAuthenticationForm() {
  authChallenge = null;
  elements.authCode.value = '';
  elements.authCodeForm.hidden = true;
  elements.authEmailForm.hidden = false;
  setAuthFeedback('');
}

async function logoutCharly() {
  document.getElementById('headerMenu').hidden = true;
  await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' }).catch(() => {});
  elements.chatContainer.textContent = '';
  setAuthenticationVisible(true);
}

function updateMemoryControls(copilot) {
  if (!elements.memoryToggleBtn) return;
  const available = copilot?.available === true;
  const enabled = copilot?.enabled !== false;
  elements.memoryToggleBtn.hidden = !available;
  if (elements.exportDataBtn) elements.exportDataBtn.hidden = !available;
  if (elements.deleteDataBtn) elements.deleteDataBtn.hidden = !available;
  elements.memoryToggleBtn.setAttribute('aria-checked', String(enabled));
  const label = elements.memoryToggleBtn.querySelector('span');
  if (label) label.textContent = enabled ? t('memoryEnabled') : t('memoryDisabled');
}

async function toggleCopilotMemory() {
  const enabled = elements.memoryToggleBtn?.getAttribute('aria-checked') !== 'true';
  const response = await chrome.runtime.sendMessage({ type: 'SET_MEMORY_PREFERENCE', enabled }).catch(error => ({ error: error.message }));
  if (!response?.ok) return addMessage('error', response?.error || t('errorGeneric'));
  updateMemoryControls({ available: true, enabled: response.enabled });
}

async function exportCopilotData() {
  document.getElementById('headerMenu').hidden = true;
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_COPILOT_DATA' }).catch(error => ({ error: error.message }));
  if (!response?.ok) return addMessage('error', response?.error || t('errorGeneric'));
  const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = response.filename || 'charly-data.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function deleteCopilotData() {
  document.getElementById('headerMenu').hidden = true;
  if (!confirm(t('memoryDeleteConfirm'))) return;
  const response = await chrome.runtime.sendMessage({ type: 'DELETE_COPILOT_DATA' }).catch(error => ({ error: error.message }));
  if (!response?.ok) return addMessage('error', response?.error || t('errorGeneric'));
  elements.chatContainer.textContent = '';
  addMessage('system', t('memoryDeleted'));
}

async function startTrainingCapture() {
  const token = elements.trainingToken.value.trim();
  if (token.length < 24) {
    elements.trainingFeedback.textContent = 'Colle d’abord le code complet créé dans le Studio.';
    return;
  }
  elements.trainingFeedback.textContent = 'Dans Chrome, sélectionne « Écran entier ». La démonstration démarrera ensuite.';
  elements.trainingStart.disabled = true;
  if (voiceSession?.active) voiceSession.stop(false);
  voiceSession = null;
  const RecorderClass = window.LimovaTrainingScreenRecorder;
  trainingScreenRecorder = RecorderClass ? new RecorderClass() : null;
  try {
    if (!trainingScreenRecorder) throw new Error('Recharge l’extension pour activer l’enregistrement complet de l’écran.');
    await trainingScreenRecorder.start();
  } catch (error) {
    trainingScreenRecorder?.abort();
    trainingScreenRecorder = null;
    elements.trainingStart.disabled = false;
    elements.trainingFeedback.textContent = error?.message || 'Le partage de l’écran entier a été annulé.';
    return;
  }
  elements.trainingFeedback.textContent = 'Connexion au Studio…';
  const response = await chrome.runtime.sendMessage({ type: 'START_TRAINING', token }).catch(error => ({ ok:false,error:error.message }));
  elements.trainingStart.disabled = false;
  if (!response?.ok) {
    trainingScreenRecorder.abort();
    trainingScreenRecorder = null;
    elements.trainingFeedback.textContent = response?.error === 'Unknown message type'
      ? 'Cette version de l’extension doit être rechargée. Ouvre chrome://extensions, clique sur ↻ pour Limova AI, puis recharge Limova.'
      : response?.error || 'Impossible de démarrer.';
    return;
  }
  if (response.recovered) {
    trainingScreenRecorder.abort();
    trainingScreenRecorder = null;
    elements.trainingFeedback.textContent = 'La vidéo déjà envoyée a été récupérée et finalisée dans le Studio. Aucun nouvel enregistrement n’a été créé.';
    return;
  }
  activeTrainingToken = token;
  activeTrainingSession = response.session;
  try {
    await trainingScreenRecorder.beginProgressiveUpload({
      token,
      sessionId: response.session.id
    });
  } catch (error) {
    trainingScreenRecorder.abort();
    trainingScreenRecorder = null;
    activeTrainingSession = null;
    activeTrainingToken = '';
    await chrome.runtime.sendMessage({ type: 'CANCEL_TRAINING' }).catch(() => {});
    elements.trainingFeedback.textContent = error?.message || 'La synchronisation progressive de la vidéo n’a pas pu démarrer.';
    return;
  }
  showTrainingActive(response.session);
}

async function startEvaluation() {
  const token = elements.evaluationToken.value.trim();
  if (token.length < 24) { elements.evaluationFeedback.textContent = 'Collez le code complet créé dans le Studio.'; return; }
  elements.evaluationStart.disabled = true;
  elements.evaluationFeedback.textContent = 'Chargement du brouillon isolé…';
  const response = await chrome.runtime.sendMessage({ type: 'START_EVALUATION', token }).catch(error => ({ ok: false, error: error.message }));
  elements.evaluationStart.disabled = false;
  if (!response?.ok) { elements.evaluationFeedback.textContent = response?.error || 'Impossible de lancer le test.'; return; }
  showEvaluationActive(response);
  const scenario = response.testCase?.prompt || response.testCase?.title;
  elements.evaluationFeedback.textContent = `Scénario : ${scenario}. Formulez maintenant la demande à Charly dans le chat.`;
  hideWelcomeScreen();
  elements.evaluationPanel.hidden = true;
  addMessage('system', `Test réel actif · demandez à Charly : « ${scenario} ». Le verdict reste accessible dans Menu → Tester un parcours.`);
  elements.userInput.focus();
}

function showEvaluationActive(evaluation) {
  elements.evaluationPanel.hidden = false;
  elements.evaluationToken.hidden = true;
  elements.evaluationToken.previousElementSibling.hidden = true;
  elements.evaluationStart.hidden = true;
  elements.evaluationVerdict.hidden = false;
  elements.evaluationFeedback.textContent = `Test réel actif · ${evaluation.content?.title || evaluation.testCase?.title || 'parcours brouillon'}. Utilisez le chat normalement puis indiquez si le résultat est correct.`;
  document.body.classList.add('evaluation-active');
}

async function completeEvaluation(verdict) {
  elements.evaluationCorrect.disabled = true;
  elements.evaluationProblem.disabled = true;
  elements.evaluationFeedback.textContent = 'Transmission du résultat au Studio…';
  const response = await chrome.runtime.sendMessage({ type: 'COMPLETE_EVALUATION', verdict }).catch(error => ({ ok: false, error: error.message }));
  elements.evaluationCorrect.disabled = false;
  elements.evaluationProblem.disabled = false;
  if (!response?.ok) { elements.evaluationFeedback.textContent = response?.error || 'Le résultat n’a pas pu être transmis.'; return; }
  elements.evaluationFeedback.textContent = response.run?.status === 'passed'
    ? `Test réussi · ${response.run.score}/100. Retournez dans le Studio pour envoyer le parcours en review.`
    : `Test à corriger · ${response.run?.score ?? 0}/100. Consultez le détail dans le Studio puis retestez.`;
  elements.evaluationVerdict.hidden = true;
  elements.evaluationToken.hidden = false;
  elements.evaluationToken.previousElementSibling.hidden = false;
  elements.evaluationToken.value = '';
  elements.evaluationStart.hidden = false;
  document.body.classList.remove('evaluation-active');
}

function showTrainingActive(session) {
  trainingCaptureActive = true;
  elements.trainingPanel.hidden = false;
  elements.trainingToken.hidden = true;
  elements.trainingToken.previousElementSibling.hidden = true;
  elements.trainingStart.hidden = true;
  elements.trainingMic.hidden = false;
  elements.trainingStop.hidden = false;
  elements.trainingFeedback.textContent = `Écran entier enregistré · mode passif · ${session.title}. Charly observe sans agir.`;
  document.body.classList.add('training-active');
}

async function stopTrainingCapture() {
  elements.trainingStop.disabled = true;
  if (voiceSession?.active) voiceSession.stop();
  voiceSession = null;
  if (!trainingScreenRecorder || !activeTrainingSession || !activeTrainingToken) {
    elements.trainingStop.disabled = false;
    elements.trainingFeedback.textContent = 'La vidéo complète est absente. Recommence cette démonstration depuis le Studio.';
    return;
  }
  elements.trainingFeedback.textContent = 'Préparation de la vidéo…';
  try {
    chrome.runtime.sendMessage({
      type: 'DIAGNOSTIC_EVENT',
      component: 'sidebar',
      code: 'TRAINING_RECORDING_UPLOAD_STARTED',
      data: { sizeBytes: trainingScreenRecorder.totalSize || trainingScreenRecorder.recordingBlob?.size || 0 }
    }).catch(() => {});
    await trainingScreenRecorder.stopAndUpload({
      token: activeTrainingToken,
      sessionId: activeTrainingSession.id,
      onProgress: ({ percentage }) => {
        elements.trainingFeedback.textContent = `Envoi privé de la vidéo · ${Math.round(percentage)} %`;
      }
    });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'DIAGNOSTIC_EVENT',
      component: 'sidebar',
      code: 'TRAINING_RECORDING_UPLOAD_FAILED',
      data: {
        stage: error?.stage || 'unknown',
        code: error?.code || error?.name || 'UNKNOWN',
        status: Number(error?.status || 0)
      }
    }).catch(() => {});
    elements.trainingStop.disabled = false;
    elements.trainingStop.textContent = 'Réessayer l’envoi de la vidéo';
    elements.trainingFeedback.textContent = error?.message || 'La vidéo n’a pas pu être envoyée. Réessaie sans fermer le panneau.';
    return;
  }
  chrome.runtime.sendMessage({
    type: 'DIAGNOSTIC_EVENT',
    component: 'sidebar',
    code: 'TRAINING_RECORDING_UPLOAD_SUCCEEDED',
    data: { sessionIdPresent: true }
  }).catch(() => {});
  elements.trainingFeedback.textContent = 'Vidéo reçue. Finalisation du parcours…';
  const response = await chrome.runtime.sendMessage({ type: 'STOP_TRAINING', token: activeTrainingToken }).catch(() => ({ok:false}));
  elements.trainingStop.disabled = false;
  if (!response?.ok) {
    elements.trainingStop.textContent = 'Réessayer la finalisation';
    elements.trainingFeedback.textContent = response?.error || 'La démonstration n’a pas pu être terminée. Réessaie sans réinstaller l’extension.';
    return;
  }
  elements.trainingFeedback.textContent = 'Démonstration et vidéo enregistrées. Retournez dans le Studio pour les relire.';
  trainingCaptureActive = false;
  trainingScreenRecorder = null;
  activeTrainingSession = null;
  activeTrainingToken = '';
  elements.trainingMic.hidden = true;
  elements.trainingStop.hidden = true;
  elements.trainingStop.textContent = 'Terminer la démonstration';
  document.body.classList.remove('training-active');
}

async function handleTrainingScreenEnded() {
  if (!trainingCaptureActive) return;
  trainingCaptureActive = false;
  trainingScreenRecorder?.abort();
  trainingScreenRecorder = null;
  activeTrainingSession = null;
  activeTrainingToken = '';
  if (voiceSession?.active) voiceSession.stop(false);
  voiceSession = null;
  await chrome.runtime.sendMessage({ type: 'CANCEL_TRAINING' }).catch(() => {});
  elements.trainingMic.hidden = true;
  elements.trainingStop.hidden = true;
  elements.trainingStart.hidden = false;
  elements.trainingToken.hidden = false;
  elements.trainingToken.previousElementSibling.hidden = false;
  elements.trainingFeedback.textContent = 'Le partage de l’écran a été arrêté avant la fin. Cette tentative n’est pas validable : recommence-la depuis le Studio.';
  document.body.classList.remove('training-active');
}

function handleTrainingRecordingLimit() {
  handleTrainingScreenEnded();
  elements.trainingFeedback.textContent = 'La limite d’une heure est atteinte. Cette tentative n’est pas validable : crée un flow plus court.';
}

async function checkIfOnLimova() {
  const goBtn = document.getElementById('goToLimova');
  if (!goBtn) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('https://new.limova.ai')) {
      goBtn.hidden = false;
    } else {
      goBtn.hidden = true;
    }
  } catch (e) {
    goBtn.hidden = false; // Show by default if can't detect
  }
}

// ============================================================================
// Background Message Handler
// ============================================================================

function handleBackgroundMessage(message) {
  if (trainingCaptureActive && [
    'GEMINI_RESPONSE', 'STATUS_UPDATE', 'ACTION_PROPOSAL', 'ACTION_RESULT',
    'STEP_UPDATE', 'ONBOARDING_COMPLETE', 'VOICE_PAGE_CONTEXT'
  ].includes(message.type)) return;
  switch (message.type) {
    case 'AUTH_REQUIRED':
      hidePondering();
      isLoading = false;
      setAuthenticationVisible(true);
      setAuthFeedback('Ta session a expiré. Reconnecte-toi pour continuer.', true);
      break;

    case 'GEMINI_RESPONSE':
      hidePondering();
      hideWelcomeScreen();
      addMessage('assistant', message.content);
      updateStatus('ready');
      break;

    case 'STATUS_UPDATE':
      updateStatus(message.status, message.text);
      if (message.status === 'analyzing') {
        showPondering(message.ponderingText ? t(message.ponderingText) : null);
      } else if (message.status === 'ready') {
        hidePondering();
      }
      break;

    case 'ERROR':
      hidePondering();
      addMessage('error', `${message.content || t('errorGeneric')}${message.code ? ` (${t('errorCode')}: ${message.code})` : ''}`);
      updateStatus('error');
      break;

    case 'WRONG_TAB':
      showTabWarning(t('wrongTab'));
      { const goBtn = document.getElementById('goToLimova'); if (goBtn) goBtn.hidden = false; }
      break;

    case 'CORRECT_TAB':
      hideTabWarning();
      { const goBtn = document.getElementById('goToLimova'); if (goBtn) goBtn.hidden = true; }
      break;

    case 'LOCKED_TAB_CLOSED':
      hideTabWarning();
      addMessage('system', t('tabClosed'));
      break;

    case 'EXTERNAL_POPUP_STATUS':
      hideTabWarning();
      if (!elements.trainingPanel.hidden) {
        elements.trainingFeedback.textContent = message.phase === 'opened'
          ? 'Fenêtre de connexion externe ouverte. Continuez l’autorisation : Charly observe sans agir.'
          : 'Fenêtre externe fermée. Charly relit maintenant la page, sans agir.';
      } else {
        addMessage('system', message.phase === 'opened'
          ? 'Termine l’autorisation dans la fenêtre de connexion. Je reprendrai automatiquement à ton retour.'
          : 'La fenêtre de connexion est fermée. Je relis la page Limova pour poursuivre.');
      }
      break;

    case 'STEP_UPDATE':
      updateStepInfo(message.step, message.progress);
      break;

    case 'ONBOARDING_COMPLETE':
      updateStepInfo(null);
      addMessage('system', t('onboardingComplete'));
      break;

    case 'CONSENT_REQUIRED':
      hidePondering();
      isLoading = false;
      showAIConsent();
      break;

    case 'ACTION_PROPOSAL':
      renderActionProposal(message);
      break;

    case 'ACTION_RESULT':
      addMessage(message.ok ? 'system' : 'error', message.ok
        ? `${t('actionDone')} ${message.label || ''}`
        : (message.error || t('actionFailed')));
      break;

    case 'VOICE_PAGE_CONTEXT':
      voiceSession?.updatePageContext(
        message.pageContext,
        message.contextVersion,
        message.source,
        message.visualCapture
      );
      break;
  }
}

function renderActionProposal(action) {
  const card = document.createElement('div');
  card.className = 'action-card';
  card.dataset.pendingAction = action.actionId;
  const text = document.createElement('p');
  text.textContent = `${t('actionConfirm')} « ${action.label} »`;
  const actions = document.createElement('div');
  actions.className = 'action-card-buttons';
  const confirm = document.createElement('button');
  confirm.className = 'action-confirm';
  confirm.dataset.actionId = action.actionId;
  confirm.dataset.decision = 'confirm';
  confirm.textContent = t('actionExecute');
  const cancel = document.createElement('button');
  cancel.className = 'action-cancel';
  cancel.dataset.actionId = action.actionId;
  cancel.dataset.decision = 'cancel';
  cancel.textContent = t('actionCancel');
  actions.append(confirm, cancel);
  card.append(text, actions);
  elements.chatContainer.appendChild(card);
  scrollToBottom();
}

async function handleActionDecision(actionId, confirmed) {
  const card = elements.chatContainer.querySelector(`[data-pending-action="${CSS.escape(actionId)}"]`);
  card?.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const result = await chrome.runtime.sendMessage({ type: confirmed ? 'CONFIRM_ACTION' : 'CANCEL_ACTION', actionId });
  card?.remove();
  if (!result?.ok && result?.error) addMessage('error', result.error);
}

// ============================================================================
// Chat Rendering
// ============================================================================

function addPageAnalysis(options = {}) {
  // Captures are implementation details. Keep this compatibility hook silent
  // for histories produced by older extension versions.
  void options;
}

function addMessage(role, content, options = {}) {
  if (!content) return;

  if (role !== lastMessageSender && (role === 'assistant' || role === 'user')) {
    const header = document.createElement('div');
    header.className = `message-header ${role}`;
    if (role === 'assistant') {
      const avatar = document.createElement('img');
      avatar.src = '../../assets/branding/charly.png';
      avatar.alt = 'Charly';
      avatar.className = 'message-avatar';
      const name = document.createElement('span');
      name.className = 'message-sender';
      name.textContent = 'Charly';
      header.append(avatar, name);
    } else {
      const name = document.createElement('span');
      name.className = 'message-sender';
      name.textContent = t('senderYou');
      header.appendChild(name);
    }
    elements.chatContainer.appendChild(header);
  }
  lastMessageSender = role;

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (role === 'assistant') {
    contentDiv.innerHTML = formatMarkdown(content);
  } else {
    contentDiv.textContent = content;
  }

  msgDiv.appendChild(contentDiv);
  elements.chatContainer.appendChild(msgDiv);

  if (role === 'assistant') {
    removeNextStepLinks();
    const link = document.createElement('a');
    link.className = 'next-step-link';
    link.href = '#';
    link.textContent = t('nextStep');
    elements.chatContainer.appendChild(link);
  }

  if (!options.skipScroll) scrollToBottom();
}

function removeNextStepLinks() {
  elements.chatContainer.querySelectorAll('.next-step-link').forEach(el => el.remove());
}

function showPondering(text) {
  const label = text || t('pondering');
  const existing = document.getElementById('ponderingState');
  if (existing) {
    // Update text if already showing
    const span = existing.querySelector('.pondering-text');
    if (span) span.firstChild.textContent = label;
    return;
  }
  const div = document.createElement('div');
  div.id = 'ponderingState';
  div.className = 'pondering-container';

  const content = document.createElement('div');
  content.className = 'pondering-content';

  const avatar = document.createElement('img');
  avatar.src = '../../assets/branding/charly.png';
  avatar.alt = 'Charly';
  avatar.className = 'pondering-avatar';

  const textSpan = document.createElement('span');
  textSpan.className = 'pondering-text';
  textSpan.appendChild(document.createTextNode(label));

  const dotsSpan = document.createElement('span');
  dotsSpan.className = 'pondering-dots';
  dotsSpan.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  textSpan.appendChild(dotsSpan);

  content.append(avatar, textSpan);
  div.appendChild(content);
  elements.chatContainer.appendChild(div);
  scrollToBottom();
}

function hidePondering() {
  document.getElementById('ponderingState')?.remove();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
  });
}

// ============================================================================
// Markdown Renderer
// ============================================================================

function processInline(text) {
  text = text.replace(/`(.+?)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    // Only allow http/https links — block javascript:, data:, etc.
    if (/^https?:\/\//i.test(url)) {
      // Escape quotes in URL to prevent attribute injection
      const safeUrl = url.replace(/"/g, '&quot;');
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return label;
  });
  return text;
}

function formatMarkdown(text) {
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = html.split('\n');
  let inCodeBlock = false;
  let inList = false;
  let listType = 'ul';
  let result = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inList) { result += `</${listType}>`; inList = false; }
      if (inCodeBlock) {
        result += '</code></pre>';
        inCodeBlock = false;
      } else {
        const lang = line.substring(3).trim();
        result += `<pre><button class="copy-code-btn">${t('copyBtn')}</button><code${lang ? ` class="language-${lang}"` : ''}>`;
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) { result += line + '\n'; continue; }

    const trimmed = line.trim();

    if (inList && !trimmed.match(/^(\*|-|\d+\.)\s/)) {
      result += `</${listType}>`;
      inList = false;
    }

    if (trimmed.startsWith('### ')) { result += `<h3>${processInline(trimmed.slice(4))}</h3>`; continue; }
    if (trimmed.startsWith('## ')) { result += `<h2>${processInline(trimmed.slice(3))}</h2>`; continue; }
    if (trimmed.startsWith('# ')) { result += `<h1>${processInline(trimmed.slice(2))}</h1>`; continue; }
    if (trimmed === '---') { result += '<hr>'; continue; }

    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      const item = processInline(trimmed.slice(2));
      if (!inList) { listType = 'ul'; result += '<ul>'; inList = true; }
      result += `<li>${item}</li>`;
      continue;
    }

    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (orderedMatch) {
      const item = processInline(orderedMatch[2]);
      if (!inList) { listType = 'ol'; result += '<ol>'; inList = true; }
      result += `<li>${item}</li>`;
      continue;
    }

    if (trimmed === '') {
      result += '<div style="height:0.5em"></div>';
    } else {
      result += `<p>${processInline(trimmed)}</p>`;
    }
  }

  if (inCodeBlock) result += '</code></pre>';
  if (inList) result += `</${listType}>`;

  return result;
}

// ============================================================================
// User Input
// ============================================================================

function handleInputChange() {
  autoResizeTextarea();
}

function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (elements.userInput.value.trim()) sendMessage();
  }
}

function autoResizeTextarea() {
  const el = elements.userInput;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function sendMessage() {
  if (trainingCaptureActive) return;
  const text = elements.userInput.value.trim();
  if (!text || isLoading) return;
  if (!(await ensureAIConsent())) return;

  // Text and Live voice must never own the same user turn. Closing the voice
  // session first prevents a late Live tool call from racing the text runner.
  if (voiceSession?.active) {
    voiceSession.stop(false);
    voiceSession = null;
    await chrome.runtime.sendMessage({ type: 'VOICE_SESSION_STATE', active: false }).catch(() => {});
  }

  isLoading = true;
  hideWelcomeScreen();
  addMessage('user', text);
  elements.userInput.value = '';
  autoResizeTextarea();
  showPondering();
  updateStatus('analyzing');

  try {
    await chrome.runtime.sendMessage({ type: 'USER_MESSAGE', text });
  } catch (e) {
    hidePondering();
    addMessage('error', t('errorComm'));
    updateStatus('error');
  }

  isLoading = false;
}

async function analyzePage() {
  if (trainingCaptureActive) return;
  if (!(await ensureAIConsent())) return;
  showPondering();
  updateStatus('analyzing');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE' });
    if (response?.voiceSessionActive) {
      hidePondering();
      updateStatus(voiceSession?.active ? 'voice' : 'ready', voiceSession?.active ? t('voiceListening') : undefined);
    }
  } catch (e) {
    hidePondering();
    addMessage('error', t('errorScreenshot'));
    updateStatus('error');
  }
}

function sendNextStepRequest() {
  hideWelcomeScreen();
  showPondering();
  updateStatus('analyzing');
  chrome.runtime.sendMessage({ type: 'NEXT_STEP' }).catch(() => {
    hidePondering();
    updateStatus('ready');
  });
}

async function toggleVoice() {
  if (voiceSession?.active) {
    voiceSession.stop();
    return;
  }
  if (!(await ensureAIConsent())) return;
  if (!voiceSession || voiceSession.trainingMode !== trainingCaptureActive) {
    voiceSession = new window.LimovaVoiceSession({ trainingMode: trainingCaptureActive });
  }
  try {
    await voiceSession.start();
  } catch (_) {}
}

function updateVoiceStatus({ status, error, errorKey }) {
  const active = ['connecting', 'listening', 'speaking'].includes(status);
  elements.voiceBtn.classList.toggle('active', active);
  elements.voiceBtn.setAttribute('aria-pressed', String(active));
  elements.voiceBtn.title = active ? t('voiceStop') : t('voiceStart');
  if (elements.trainingMic) {
    elements.trainingMic.classList.toggle('active', active);
    elements.trainingMic.setAttribute('aria-pressed', String(active));
    elements.trainingMic.textContent = active ? 'Transcription active · arrêter' : 'Transcrire mes explications pour Charly';
  }
  if (status === 'listening') updateStatus('voice', t('voiceListening'));
  else if (status === 'speaking') updateStatus('voice', t('voiceSpeaking'));
  else if (status === 'connecting') updateStatus('analyzing', t('voiceConnecting'));
  else if (status === 'error') {
    updateStatus('error');
    if (errorKey) addMessage('error', t(errorKey));
    else if (error) addMessage('error', error);
  } else updateStatus('ready');
}

function handleVoiceTranscript({ role, text, final }) {
  if (!(role in voiceTranscriptBuffers)) return;
  voiceTranscriptBuffers[role] += text || '';
  if (trainingCaptureActive) {
    if (role !== 'user') {
      voiceTranscriptBuffers.assistant = '';
      return;
    }
    if (final && voiceTranscriptBuffers.user.trim()) {
      const transcript = voiceTranscriptBuffers.user.trim();
      chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', role: 'user', text: transcript }).catch(() => {});
      voiceTranscriptBuffers.user = '';
      elements.trainingFeedback.textContent = 'Explication enregistrée. Continuez votre démonstration : Charly observe sans agir.';
    }
    return;
  }
  if (final && voiceTranscriptBuffers[role].trim()) {
    hideWelcomeScreen();
    const transcript = voiceTranscriptBuffers[role].trim();
    addMessage(role, transcript);
    chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', role, text: transcript }).catch(() => {});
    voiceTranscriptBuffers[role] = '';
  }
}

// ============================================================================
// UI State
// ============================================================================

function hideWelcomeScreen() {
  if (!welcomeScreenVisible) return;
  welcomeScreenVisible = false;
  elements.welcomeScreen.hidden = true;
}

function updateStatus(status, text) {
  const badge = elements.statusBadge;
  badge.className = 'status-badge';

  switch (status) {
    case 'analyzing':
      badge.classList.add('analyzing');
      badge.textContent = text || t('statusAnalyzing');
      break;
    case 'error':
      badge.classList.add('error');
      badge.textContent = t('statusError');
      break;
    case 'voice':
      badge.classList.add('voice');
      badge.textContent = text;
      break;
    default:
      badge.textContent = t('statusReady');
  }
}

function updateStepInfo(stepName, progress) {
  if (stepName) {
    elements.stepInfo.hidden = false;
    elements.stepName.textContent = stepName;
    elements.stepProgress.textContent = progress || '';
  } else {
    elements.stepInfo.hidden = true;
  }
}

// Tab Warning
function showTabWarning(text) {
  elements.tabWarning.hidden = false;
  elements.tabWarningText.textContent = text;
}

function hideTabWarning() {
  elements.tabWarning.hidden = true;
}

function handleTabWarningClick() {
  chrome.runtime.sendMessage({ type: 'SWITCH_TO_LOCKED_TAB' });
}

// ============================================================================
// Session Reset
// ============================================================================

async function resetSession() {
  if (!confirm(t('resetConfirm'))) return;
  try {
    voiceSession?.stop(false);
    voiceSession = null;
    voiceTranscriptBuffers.user = '';
    voiceTranscriptBuffers.assistant = '';
    await chrome.runtime.sendMessage({ type: 'RESET_SESSION' });
    elements.chatContainer.textContent = '';
    elements.stepInfo.hidden = true;
    elements.welcomeScreen.hidden = false;
    welcomeScreenVisible = true;
    lastMessageSender = null;
    hideTabWarning();
    updateStatus('ready');
  } catch (e) {}
}

// ============================================================================
// AI processing consent — shown only when the user starts an AI action.
// ============================================================================

function showAIConsent() {
  elements.aiConsentPanel.hidden = false;
  elements.aiConsentAccept.focus();
}

async function ensureAIConsent() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' });
    if (state?.aiProcessing) return true;
  } catch (_) {}
  showAIConsent();
  return false;
}

async function handleAIConsent(granted) {
  await chrome.runtime.sendMessage({ type: 'AI_PROCESSING_CONSENT', granted }).catch(() => {});
  elements.aiConsentPanel.hidden = true;
  if (!granted) addMessage('system', t('aiConsentDeclined'));
}

// ============================================================================
// Download Logs
// ============================================================================

async function downloadLogs() {
  try {
    const response = await runDiagnostics(true);
    if (response?.logs) {
      const blob = new Blob([response.logs], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `limova-ai-logs-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    addMessage('error', t('errorLogs'));
  }
}

async function collectClientDiagnostics() {
  let microphonePermission = 'unknown';
  try {
    const permission = await navigator.permissions?.query?.({ name: 'microphone' });
    microphonePermission = permission?.state || 'unknown';
  } catch (_) {}
  const chromeMajor = navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || 'unknown';
  return {
    browser: `Chrome ${chromeMajor}`,
    language: navigator.language || document.documentElement.lang || 'unknown',
    microphonePermission,
    mediaDevicesSupported: Boolean(navigator.mediaDevices?.getUserMedia)
  };
}

async function runDiagnostics(forDownload = false) {
  elements.diagnoseBtn.disabled = true;
  elements.diagnosticResult.hidden = false;
  elements.diagnosticResult.dataset.status = 'running';
  elements.diagnosticText.textContent = t('diagnosticRunning');
  try {
    const client = await collectClientDiagnostics();
    const response = await chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS', client });
    elements.diagnosticResult.dataset.status = response?.ok ? 'healthy' : 'degraded';
    elements.diagnosticText.textContent = response?.ok
      ? t('diagnosticHealthy')
      : `${t('diagnosticDegraded')} ${response?.probableCause || ''} (${response?.incidentId || 'unknown'})`;
    if (!forDownload) setTimeout(() => { elements.diagnosticResult.hidden = true; }, 12_000);
    return response;
  } catch (error) {
    elements.diagnosticResult.dataset.status = 'degraded';
    elements.diagnosticText.textContent = t('diagnosticFailed');
    return null;
  } finally {
    elements.diagnoseBtn.disabled = false;
  }
}

window.addEventListener('error', event => {
  chrome.runtime.sendMessage({
    type: 'DIAGNOSTIC_EVENT',
    component: 'sidebar',
    code: 'SIDEBAR_UNCAUGHT_ERROR',
    data: { name: event.error?.name || 'Error', line: event.lineno || 0 }
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', event => {
  chrome.runtime.sendMessage({
    type: 'DIAGNOSTIC_EVENT',
    component: 'sidebar',
    code: 'SIDEBAR_UNHANDLED_REJECTION',
    data: { name: event.reason?.name || 'Error' }
  }).catch(() => {});
});
