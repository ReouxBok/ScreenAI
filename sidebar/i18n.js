/**
 * Lightweight i18n for Charly sidebar.
 * Detects browser language and translates all static UI elements.
 */

const translations = {
  fr: {
    title: 'Charly',
    subtitle: 'Assistant onboarding',
    statusReady: 'Prêt',
    statusAnalyzing: 'Analyse...',
    statusError: 'Erreur',
    resetTitle: 'Réinitialiser',
    screenshotTitle: 'Capturer l\'écran actuel',
    micTitle: 'Dicter un message',
    inputPlaceholder: 'Écris à Charly...',
    greeting: 'Bonjour ! Je suis Charly, ton assistante onboarding Limova',
    howItWorksTitle: 'Voici comment ça va fonctionner',
    howItWorks1: 'Navigue sur Limova, je vois chaque page automatiquement',
    howItWorks2: 'Je te guide étape par étape',
    howItWorks3: 'Si tu es bloqué, clique sur {CAPTURE_ICON} en bas à gauche',
    howItWorks4: 'Pose-moi n\'importe quelle question en chemin',
    cta: 'Prêt ? Dis-moi ce que tu veux faire sur Limova, ou rends-toi sur la plateforme pour commencer !',
    stepLabel: 'Étape :',
    downloadLogs: 'Télécharger les logs',
    footerBrand: 'propulsé par Limova AI',
    resetConfirm: 'Réinitialiser la session ? L\'historique sera effacé.',
    senderYou: 'Vous',
    pondering: 'Charly réfléchit',
    ponderingCapture: 'Charly analyse la page',
    ponderingNewPage: 'Charly découvre la page',
    ponderingPopup: 'Charly analyse le popup',
    nextStep: 'Besoin de la prochaine étape ?',
    copyBtn: 'Copier',
    errorComm: 'Erreur de communication avec l\'extension.',
    errorScreenshot: 'Impossible de capturer l\'écran.',
    errorLogs: 'Impossible de télécharger les logs.',
    errorMic: 'Erreur micro : ',
    errorGeneric: 'Une erreur est survenue.',
    tabClosed: 'L\'onglet Limova a été fermé. Ouvre new.limova.ai pour continuer.',
    wrongTab: 'Tu es sur un autre onglet. Clique ici pour revenir à Limova.',
    goToLimova: 'Ouvrir Limova',
    onboardingComplete: 'Onboarding terminé !',
    micNoTab: 'Ouvre new.limova.ai pour utiliser le micro.',
    speechLang: 'fr-FR',
    callTitle: 'Mode conversation vocale',
    callListening: 'Écoute...',
    callThinking: 'Charly réfléchit...',
    callSpeaking: 'Charly parle...',
    callHangup: 'Raccrocher',
    callMute: 'Couper le micro',
    callMuted: 'Micro coupé',
    errorTTS: 'Erreur de synthèse vocale'
  },
  en: {
    title: 'Charly',
    subtitle: 'Onboarding assistant',
    statusReady: 'Ready',
    statusAnalyzing: 'Analyzing...',
    statusError: 'Error',
    resetTitle: 'Reset',
    screenshotTitle: 'Capture current screen',
    micTitle: 'Dictate a message',
    inputPlaceholder: 'Write to Charly...',
    greeting: 'Hi! I\'m Charly, your Limova onboarding assistant',
    howItWorksTitle: 'Here\'s how it works',
    howItWorks1: 'Browse Limova, I see every page automatically',
    howItWorks2: 'I guide you step by step',
    howItWorks3: 'If you\'re stuck, click {CAPTURE_ICON} at the bottom left',
    howItWorks4: 'Ask me any question along the way',
    cta: 'Ready? Tell me what you want to do on Limova, or head to the platform to get started!',
    stepLabel: 'Step:',
    downloadLogs: 'Download logs',
    footerBrand: 'powered by Limova AI',
    resetConfirm: 'Reset session? Chat history will be cleared.',
    senderYou: 'You',
    pondering: 'Charly is thinking',
    ponderingCapture: 'Charly is analyzing the page',
    ponderingNewPage: 'Charly is discovering the page',
    ponderingPopup: 'Charly is analyzing the popup',
    nextStep: 'Need the next step?',
    copyBtn: 'Copy',
    errorComm: 'Communication error with the extension.',
    errorScreenshot: 'Unable to capture screen.',
    errorLogs: 'Unable to download logs.',
    errorMic: 'Mic error: ',
    errorGeneric: 'An error occurred.',
    tabClosed: 'The Limova tab was closed. Open new.limova.ai to continue.',
    wrongTab: 'You\'re on another tab. Click here to go back to Limova.',
    goToLimova: 'Open Limova',
    onboardingComplete: 'Onboarding complete!',
    micNoTab: 'Open new.limova.ai to use the microphone.',
    speechLang: 'en-US',
    callTitle: 'Voice conversation mode',
    callListening: 'Listening...',
    callThinking: 'Charly is thinking...',
    callSpeaking: 'Charly is speaking...',
    callHangup: 'Hang up',
    callMute: 'Mute microphone',
    callMuted: 'Microphone muted',
    errorTTS: 'Text-to-speech error'
  },
  es: {
    title: 'Charly',
    subtitle: 'Asistente de onboarding',
    statusReady: 'Listo',
    statusAnalyzing: 'Analizando...',
    statusError: 'Error',
    resetTitle: 'Reiniciar',
    screenshotTitle: 'Capturar pantalla actual',
    micTitle: 'Dictar un mensaje',
    inputPlaceholder: 'Escribe a Charly...',
    greeting: '¡Hola! Soy Charly, tu asistente de onboarding de Limova',
    howItWorksTitle: 'Así es como funciona',
    howItWorks1: 'Navega por Limova, veo cada página automáticamente',
    howItWorks2: 'Te guío paso a paso',
    howItWorks3: 'Si te bloqueas, haz clic en {CAPTURE_ICON} abajo a la izquierda',
    howItWorks4: 'Hazme cualquier pregunta en el camino',
    cta: '¿Listo? Dime qué quieres hacer en Limova, ¡o ve a la plataforma para empezar!',
    stepLabel: 'Paso:',
    downloadLogs: 'Descargar logs',
    footerBrand: 'impulsado por Limova AI',
    resetConfirm: '¿Reiniciar sesión? El historial se borrará.',
    senderYou: 'Tú',
    pondering: 'Charly está pensando',
    ponderingCapture: 'Charly analiza la página',
    ponderingNewPage: 'Charly descubre la página',
    ponderingPopup: 'Charly analiza el popup',
    nextStep: '¿Necesitas el siguiente paso?',
    copyBtn: 'Copiar',
    errorComm: 'Error de comunicación con la extensión.',
    errorScreenshot: 'No se pudo capturar la pantalla.',
    errorLogs: 'No se pudieron descargar los logs.',
    errorMic: 'Error de micrófono: ',
    errorGeneric: 'Ocurrió un error.',
    tabClosed: 'La pestaña de Limova se cerró. Abre new.limova.ai para continuar.',
    wrongTab: 'Estás en otra pestaña. Haz clic aquí para volver a Limova.',
    goToLimova: 'Abrir Limova',
    onboardingComplete: '¡Onboarding completado!',
    micNoTab: 'Abre new.limova.ai para usar el micrófono.',
    speechLang: 'es-ES',
    callTitle: 'Modo conversación vocal',
    callListening: 'Escuchando...',
    callThinking: 'Charly está pensando...',
    callSpeaking: 'Charly está hablando...',
    callHangup: 'Colgar',
    callMute: 'Silenciar micrófono',
    callMuted: 'Micrófono silenciado',
    errorTTS: 'Error de síntesis de voz'
  }
};

/**
 * Detect browser language and return the matching translation set.
 * Falls back to English if the language is not supported.
 */
function detectLang() {
  const nav = navigator.language || navigator.userLanguage || 'en';
  const short = nav.split('-')[0].toLowerCase();
  return short;
}

function getLangCode() {
  const lang = detectLang();
  return translations[lang] ? lang : 'en';
}

function t(key) {
  const lang = getLangCode();
  return translations[lang][key] || translations.en[key] || key;
}

/**
 * Apply translations to all elements with data-i18n attribute.
 * data-i18n="key" → sets textContent
 * data-i18n-placeholder="key" → sets placeholder
 * data-i18n-title="key" → sets title attribute
 */
const CAPTURE_ICON_SVG = '<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const text = t(el.dataset.i18n);
    if (text.includes('{CAPTURE_ICON}')) {
      el.innerHTML = text.replace('{CAPTURE_ICON}', CAPTURE_ICON_SVG);
    } else {
      el.textContent = text;
    }
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  // Set html lang attribute
  document.documentElement.lang = getLangCode();
}
