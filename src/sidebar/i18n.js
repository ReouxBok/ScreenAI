/**
 * Lightweight i18n for Charly sidebar.
 * Detects browser language and translates all static UI elements.
 * Supports user language override persisted in chrome.storage.local.
 */

// User-overridden language (null = use browser default)
let userLangOverride = null;

const SUPPORTED_LANGS = ['fr', 'en', 'es'];

const LANG_LABELS = { fr: 'Français', en: 'English', es: 'Español' };

const translations = {
  fr: {
    title: 'Charly',
    subtitle: 'Assistant onboarding',
    statusReady: 'Prêt',
    statusAnalyzing: 'Analyse...',
    statusError: 'Erreur',
    resetTitle: 'Réinitialiser',
    screenshotTitle: 'Analyser la page actuelle',
    voiceStart: 'Démarrer une conversation vocale',
    voiceStop: 'Arrêter la conversation vocale',
    voiceMute: 'Couper le micro',
    voiceUnmute: 'Réactiver le micro',
    voiceMuted: 'Micro coupé',
    voiceConnecting: 'Connexion voix...',
    voiceListening: 'Je t’écoute',
    voiceSpeaking: 'Charly répond',
    voiceError: 'La conversation vocale est indisponible.',
    voiceMicDismissed: 'L’autorisation du micro n’a pas été terminée. Clique sur le micro pour rouvrir l’onglet d’autorisation.',
    voiceMicDenied: 'Le micro est bloqué. Autorise le microphone pour Charly dans les paramètres de Chrome, puis réessaie.',
    voiceMicNotFound: 'Aucun microphone détecté. Branche ou active un micro, puis réessaie.',
    voiceMicUnavailable: 'Le microphone est indisponible ou déjà utilisé. Ferme les autres applications audio, puis réessaie.',
    voiceMicUnsupported: 'Le microphone n’est pas disponible dans ce navigateur.',
    sendMessage: 'Envoyer le message',
    closeQuickLinks: 'Fermer les liens rapides',
    closeOnboarding: 'Fermer le parcours',
    inputPlaceholder: 'Écris à Charly...',
    greeting: 'Bonjour ! Je suis Charly, ton assistante onboarding Limova',
    howItWorksTitle: 'Voici comment ça va fonctionner',
    howItWorks1: 'Je m’adapte automatiquement à la page que tu consultes',
    howItWorks2: 'Je te guide étape par étape',
    howItWorks3: 'Choisis mon niveau d’autonomie à côté de la zone de saisie',
    howItWorks4: 'Pose-moi n\'importe quelle question en chemin',
    cta: 'Prêt ? Dis-moi ce que tu veux faire sur Limova, ou rends-toi sur la plateforme pour commencer !',
    stepLabel: 'Étape :',
    downloadLogs: 'Télécharger les logs',
    runDiagnostics: 'Vérifier Charly',
    diagnosticRunning: 'Vérification en cours…',
    diagnosticHealthy: 'Tout est opérationnel.',
    diagnosticDegraded: 'Un problème a été détecté :',
    diagnosticFailed: 'Le diagnostic n’a pas pu être terminé.',
    errorCode: 'code',
    footerBrand: 'propulsé par Limova AI',
    resetConfirm: 'Réinitialiser la session ? Les messages utilisés par Charly seront effacés.',
    senderYou: 'Vous',
    pondering: 'Charly réfléchit',
    ponderingCapture: 'Charly analyse la page',
    ponderingNewPage: 'Charly découvre la page',
    ponderingPopup: 'Charly analyse le popup',
    nextStep: 'Besoin de la prochaine étape ?',
    copyBtn: 'Copier',
    errorComm: 'Erreur de communication avec l\'extension.',
    errorScreenshot: 'Impossible d\'analyser la page.',
    errorLogs: 'Impossible de télécharger les logs.',
    errorGeneric: 'Une erreur est survenue.',
    tabClosed: 'L\'onglet Limova a été fermé. Ouvre new.limova.ai pour continuer.',
    wrongTab: 'Tu es sur un autre onglet. Clique ici pour revenir à Limova.',
    goToLimova: 'Ouvrir Limova',
    handoffWorking: 'Je lis la page et j’ouvre Limova…',
    handoffSent: 'C’est parti dans Limova : ta demande et le contenu de la page ont été envoyés à Charly dans un nouvel onglet.',
    handoffFailed: 'Je n’ai pas pu envoyer la demande dans Limova.',
    agentStopped: 'Charly s’est arrêtée à ta demande.',
    onboardingComplete: 'Onboarding terminé !',
    screenshotCaptured: 'Page analysée',
    autonomyTitle: 'Autonomie',
    autonomyAsk: 'Demander une approbation',
    autonomyAskDescription: 'Demande avant modifications et commandes',
    autonomyBalanced: 'Approuver pour moi',
    autonomyBalancedDescription: 'Demande seulement si c’est risqué',
    autonomyFull: 'Accès complet',
    autonomyFullDescription: 'Demande rarement avant d’agir',
    autonomySaved: 'Niveau mémorisé.',
    autonomySavedPending: 'Niveau mémorisé. Les confirmations déjà affichées restent à valider.',
    autonomySaveFailed: 'Le niveau n’a pas pu être mémorisé. Réessaie.',
    approvalWaiting: 'En attente de ton approbation',
    aiConsentTitle: 'Activer l’intelligence de Charly',
    aiConsentText: 'Avec ton accord, Charly utilise Google Gemini pour le texte et OpenAI GPT Live pour la voix afin de traiter la structure de la page affichée, une capture temporaire avec les valeurs masquées, les erreurs filtrées et tes messages. Tes conversations peuvent être conservées jusqu’à 12 mois pour reprendre tes objectifs. Les captures, DOM, requêtes et valeurs de formulaires ne sont jamais mémorisés. Tu gardes le contrôle dans le menu.',
    privacyLink: 'Politique de confidentialité',
    aiConsentAccept: 'Activer Charly',
    aiConsentDecline: 'Pas maintenant',
    aiConsentDeclined: 'Charly reste désactivé. Tu pourras l’activer en envoyant un message ou en lançant la voix.',
    memoryEnabled: 'Personnalisation active',
    memoryDisabled: 'Personnalisation désactivée',
    usageAnalyticsEnabled: 'Statistiques d’utilisation activées',
    usageAnalyticsDisabled: 'Statistiques d’utilisation désactivées',
    memoryExport: 'Exporter mes données Charly',
    memoryDelete: 'Effacer les données Charly',
    memoryDeleteConfirm: 'Effacer définitivement les conversations, objectifs et préférences utilisés par Charly ?',
    memoryDeleted: 'Les données personnelles utilisées par Charly ont été effacées.',
    actionConfirm: 'Charly propose d’exécuter',
    actionExecute: 'Exécuter',
    actionCancel: 'Annuler',
    actionDone: 'Action exécutée :',
    actionFailed: 'L’action n’a pas pu être exécutée.'
  },
  en: {
    title: 'Charly',
    subtitle: 'Onboarding assistant',
    statusReady: 'Ready',
    statusAnalyzing: 'Analyzing...',
    statusError: 'Error',
    resetTitle: 'Reset',
    screenshotTitle: 'Analyze the current page',
    voiceStart: 'Start a voice conversation',
    voiceStop: 'Stop the voice conversation',
    voiceMute: 'Mute microphone',
    voiceUnmute: 'Unmute microphone',
    voiceMuted: 'Microphone muted',
    voiceConnecting: 'Connecting voice...',
    voiceListening: 'Listening',
    voiceSpeaking: 'Charly is speaking',
    voiceError: 'Voice conversation is unavailable.',
    voiceMicDismissed: 'Microphone authorization was not completed. Click the microphone to reopen the authorization tab.',
    voiceMicDenied: 'The microphone is blocked. Allow microphone access for Charly in Chrome settings, then try again.',
    voiceMicNotFound: 'No microphone was detected. Connect or enable a microphone, then try again.',
    voiceMicUnavailable: 'The microphone is unavailable or already in use. Close other audio apps, then try again.',
    voiceMicUnsupported: 'The microphone is not available in this browser.',
    sendMessage: 'Send message',
    closeQuickLinks: 'Close quick links',
    closeOnboarding: 'Close onboarding',
    inputPlaceholder: 'Write to Charly...',
    greeting: 'Hi! I\'m Charly, your Limova onboarding assistant',
    howItWorksTitle: 'Here\'s how it works',
    howItWorks1: 'I automatically follow the page you are viewing',
    howItWorks2: 'I guide you step by step',
    howItWorks3: 'Choose my autonomy level next to the message box',
    howItWorks4: 'Ask me any question along the way',
    cta: 'Ready? Tell me what you want to do on Limova, or head to the platform to get started!',
    stepLabel: 'Step:',
    downloadLogs: 'Download logs',
    runDiagnostics: 'Check Charly',
    diagnosticRunning: 'Running checks…',
    diagnosticHealthy: 'Everything is operational.',
    diagnosticDegraded: 'A problem was detected:',
    diagnosticFailed: 'The diagnostic could not be completed.',
    errorCode: 'code',
    footerBrand: 'powered by Limova AI',
    resetConfirm: 'Reset session? The messages used by Charly will be cleared.',
    senderYou: 'You',
    pondering: 'Charly is thinking',
    ponderingCapture: 'Charly is analyzing the page',
    ponderingNewPage: 'Charly is discovering the page',
    ponderingPopup: 'Charly is analyzing the popup',
    nextStep: 'Need the next step?',
    copyBtn: 'Copy',
    errorComm: 'Communication error with the extension.',
    errorScreenshot: 'Unable to analyze the page.',
    errorLogs: 'Unable to download logs.',
    errorGeneric: 'An error occurred.',
    tabClosed: 'The Limova tab was closed. Open new.limova.ai to continue.',
    wrongTab: 'You\'re on another tab. Click here to go back to Limova.',
    goToLimova: 'Open Limova',
    handoffWorking: 'Reading the page and opening Limova…',
    handoffSent: 'Sent to Limova: your request and the page content went to Charly in a new tab.',
    handoffFailed: 'I couldn’t send the request to Limova.',
    agentStopped: 'Charly stopped as you asked.',
    onboardingComplete: 'Onboarding complete!',
    screenshotCaptured: 'Page analyzed',
    autonomyTitle: 'Autonomy',
    autonomyAsk: 'Ask for approval',
    autonomyAskDescription: 'Ask before modifications and commands',
    autonomyBalanced: 'Approve for me',
    autonomyBalancedDescription: 'Ask only if it’s risky',
    autonomyFull: 'Full access',
    autonomyFullDescription: 'Rarely ask before acting',
    autonomySaved: 'Level saved.',
    autonomySavedPending: 'Level saved. Existing approval requests still need your decision.',
    autonomySaveFailed: 'Could not save the level. Try again.',
    approvalWaiting: 'Waiting for your approval',
    aiConsentTitle: 'Enable Charly’s intelligence',
    aiConsentText: 'With your consent, Charly uses Google Gemini for text and OpenAI GPT Live for voice to process the current page structure, a temporary capture with masked values, filtered errors, and your messages. Conversations may be retained for up to 12 months to resume your goals. Captures, DOM, requests, and form values are never added to memory. You stay in control from the menu.',
    privacyLink: 'Privacy policy',
    aiConsentAccept: 'Enable Charly',
    aiConsentDecline: 'Not now',
    aiConsentDeclined: 'Charly remains disabled. You can enable it by sending a message or starting voice.',
    memoryEnabled: 'Personalization on',
    memoryDisabled: 'Personalization off',
    usageAnalyticsEnabled: 'Usage statistics on',
    usageAnalyticsDisabled: 'Usage statistics off',
    memoryExport: 'Export my Charly data',
    memoryDelete: 'Delete Charly data',
    memoryDeleteConfirm: 'Permanently delete the conversations, goals, and preferences used by Charly?',
    memoryDeleted: 'The personal data used by Charly has been deleted.',
    actionConfirm: 'Charly proposes to run',
    actionExecute: 'Run',
    actionCancel: 'Cancel',
    actionDone: 'Action completed:',
    actionFailed: 'The action could not be completed.'
  },
  es: {
    title: 'Charly',
    subtitle: 'Asistente de onboarding',
    statusReady: 'Listo',
    statusAnalyzing: 'Analizando...',
    statusError: 'Error',
    resetTitle: 'Reiniciar',
    screenshotTitle: 'Analizar la página actual',
    voiceStart: 'Iniciar una conversación de voz',
    voiceStop: 'Detener la conversación de voz',
    voiceMute: 'Silenciar el micrófono',
    voiceUnmute: 'Activar el micrófono',
    voiceMuted: 'Micrófono silenciado',
    voiceConnecting: 'Conectando voz...',
    voiceListening: 'Te escucho',
    voiceSpeaking: 'Charly responde',
    voiceError: 'La conversación de voz no está disponible.',
    voiceMicDismissed: 'No se completó la autorización del micrófono. Haz clic en el micrófono para volver a abrir la pestaña de autorización.',
    voiceMicDenied: 'El micrófono está bloqueado. Permite el acceso para Charly en la configuración de Chrome e inténtalo de nuevo.',
    voiceMicNotFound: 'No se detectó ningún micrófono. Conecta o activa uno e inténtalo de nuevo.',
    voiceMicUnavailable: 'El micrófono no está disponible o ya está en uso. Cierra otras aplicaciones de audio e inténtalo de nuevo.',
    voiceMicUnsupported: 'El micrófono no está disponible en este navegador.',
    sendMessage: 'Enviar mensaje',
    closeQuickLinks: 'Cerrar enlaces rápidos',
    closeOnboarding: 'Cerrar el onboarding',
    inputPlaceholder: 'Escribe a Charly...',
    greeting: '¡Hola! Soy Charly, tu asistente de onboarding de Limova',
    howItWorksTitle: 'Así es como funciona',
    howItWorks1: 'Me adapto automáticamente a la página que estás viendo',
    howItWorks2: 'Te guío paso a paso',
    howItWorks3: 'Elige mi nivel de autonomía junto al cuadro de mensaje',
    howItWorks4: 'Hazme cualquier pregunta en el camino',
    cta: '¿Listo? Dime qué quieres hacer en Limova, ¡o ve a la plataforma para empezar!',
    stepLabel: 'Paso:',
    downloadLogs: 'Descargar logs',
    runDiagnostics: 'Verificar Charly',
    diagnosticRunning: 'Comprobación en curso…',
    diagnosticHealthy: 'Todo funciona correctamente.',
    diagnosticDegraded: 'Se detectó un problema:',
    diagnosticFailed: 'No se pudo completar el diagnóstico.',
    errorCode: 'código',
    footerBrand: 'impulsado por Limova AI',
    resetConfirm: '¿Reiniciar sesión? Se borrarán los mensajes utilizados por Charly.',
    senderYou: 'Tú',
    pondering: 'Charly está pensando',
    ponderingCapture: 'Charly analiza la página',
    ponderingNewPage: 'Charly descubre la página',
    ponderingPopup: 'Charly analiza el popup',
    nextStep: '¿Necesitas el siguiente paso?',
    copyBtn: 'Copiar',
    errorComm: 'Error de comunicación con la extensión.',
    errorScreenshot: 'No se pudo analizar la página.',
    errorLogs: 'No se pudieron descargar los logs.',
    errorGeneric: 'Ocurrió un error.',
    tabClosed: 'La pestaña de Limova se cerró. Abre new.limova.ai para continuar.',
    wrongTab: 'Estás en otra pestaña. Haz clic aquí para volver a Limova.',
    goToLimova: 'Abrir Limova',
    handoffWorking: 'Leo la página y abro Limova…',
    handoffSent: 'Enviado a Limova: tu petición y el contenido de la página llegaron a Charly en una nueva pestaña.',
    handoffFailed: 'No pude enviar la petición a Limova.',
    agentStopped: 'Charly se detuvo como pediste.',
    onboardingComplete: '¡Onboarding completado!',
    screenshotCaptured: 'Página analizada',
    autonomyTitle: 'Autonomía',
    autonomyAsk: 'Pedir aprobación',
    autonomyAskDescription: 'Pregunta antes de modificaciones y comandos',
    autonomyBalanced: 'Aprobar por mí',
    autonomyBalancedDescription: 'Pregunta solo si es arriesgado',
    autonomyFull: 'Acceso completo',
    autonomyFullDescription: 'Pregunta rara vez antes de actuar',
    autonomySaved: 'Nivel guardado.',
    autonomySavedPending: 'Nivel guardado. Las aprobaciones pendientes siguen esperando tu decisión.',
    autonomySaveFailed: 'No se pudo guardar el nivel. Inténtalo de nuevo.',
    approvalWaiting: 'Esperando tu aprobación',
    aiConsentTitle: 'Activar la inteligencia de Charly',
    aiConsentText: 'Con tu consentimiento, Charly usa Google Gemini para texto y OpenAI GPT Live para voz para procesar la estructura de la página actual, una captura temporal con los valores ocultos, errores filtrados y tus mensajes. Las conversaciones pueden conservarse hasta 12 meses para retomar tus objetivos. Las capturas, el DOM, las solicitudes y los valores de formularios nunca se añaden a la memoria. Mantienes el control desde el menú.',
    privacyLink: 'Política de privacidad',
    aiConsentAccept: 'Activar Charly',
    aiConsentDecline: 'Ahora no',
    aiConsentDeclined: 'Charly permanece desactivado. Puedes activarlo enviando un mensaje o iniciando la voz.',
    memoryEnabled: 'Personalización activa',
    memoryDisabled: 'Personalización desactivada',
    usageAnalyticsEnabled: 'Estadísticas de uso activadas',
    usageAnalyticsDisabled: 'Estadísticas de uso desactivadas',
    memoryExport: 'Exportar mis datos de Charly',
    memoryDelete: 'Borrar los datos de Charly',
    memoryDeleteConfirm: '¿Borrar definitivamente las conversaciones, objetivos y preferencias utilizados por Charly?',
    memoryDeleted: 'Los datos personales utilizados por Charly se han borrado.',
    actionConfirm: 'Charly propone ejecutar',
    actionExecute: 'Ejecutar',
    actionCancel: 'Cancelar',
    actionDone: 'Acción completada:',
    actionFailed: 'No se pudo completar la acción.'
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
  if (userLangOverride && translations[userLangOverride]) return userLangOverride;
  const lang = detectLang();
  return translations[lang] ? lang : 'en';
}

/**
 * Load persisted language preference from chrome.storage.local.
 * Returns a Promise that resolves once the override is loaded.
 */
async function loadLangPreference() {
  try {
    const result = await chrome.storage.local.get('limova_lang');
    if (result.limova_lang && translations[result.limova_lang]) {
      userLangOverride = result.limova_lang;
    }
  } catch (_) {}
}

/**
 * Switch the UI and AI language. Persists the choice and re-applies all translations.
 * @param {string} lang - Language code ('fr', 'en', 'es')
 */
async function setLang(lang) {
  if (!translations[lang]) return;
  userLangOverride = lang;
  await chrome.storage.local.set({ limova_lang: lang });
  applyTranslations();
  updateLangSwitcher();
  // Notify background so Gemini uses the new language
  chrome.runtime.sendMessage({ type: 'SET_LANG', lang }).catch(() => {});
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
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  // Set html lang attribute
  document.documentElement.lang = getLangCode();
}

/**
 * Update the visual state of the language switcher buttons.
 */
function updateLangSwitcher() {
  const current = getLangCode();
  document.querySelectorAll('.lang-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === current);
  });
}
