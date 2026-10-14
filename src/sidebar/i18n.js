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
    limovaExport: 'Exporter cette conversation (CSV)',
    limovaExporting: 'Préparation de l’export…',
    limovaNextStepPrompt: 'Guide-moi pour la prochaine étape en tenant compte de notre conversation.',
    limovaAnalyzePrompt: "Analyse la page active et explique ce que tu observes. Utilise une capture si nécessaire. Ne clique pas, ne saisis rien et ne navigue pas.",
    limovaSiteReview: "Vérifie le site, puis clique sur « Autoriser ce site ».",
    limovaSitePaste: "Colle l’adresse HTTPS du site à autoriser.",
    limovaSiteInvalid: "Indique une adresse HTTPS valide, sans identifiants.",
    limovaSiteGranted: "Accès autorisé à {origin}. Coche ensuite l’autorisation pour ton message.",
    limovaSiteDenied: "Accès refusé à {origin}. Aucun accès supplémentaire n’a été accordé.",
    limovaSiteError: "Chrome n’a pas pu accorder cet accès. Réessaie depuis le bouton.",
    limovaAccess: "Accès Limova",
    limovaAccountTitle: "Retrouve ton compte Limova",
    limovaAccountIntro: "Connecte-toi dans l’application Limova pour retrouver Charly, tes conversations et tes intégrations.",
    limovaOpenApp: "Ouvrir Limova",
    limovaRefreshLogin: "Actualiser ma connexion",
    limovaNoAccount: "Je n’ai pas encore de compte Limova",
    limovaConversations: "Conversations Limova",
    limovaWorkspace: "Espace Limova",
    limovaConversationName: "Conversation",
    limovaMoreConversations: "Plus de conversations",
    limovaOlderMessages: "Messages précédents",
    limovaNew: "Nouvelle conversation",
    limovaRefresh: "Actualiser",
    limovaResume: "Reprendre le tour navigateur",
    limovaStop: "Arrêter",
    limovaBrowserConsent: "Autoriser Charly à lire et agir sur l’onglet actif pour ce message",
    limovaOtherSite: "Autoriser un autre site",
    limovaSiteAddress: "Adresse du site (HTTPS)",
    limovaSiteDetect: "Utiliser le site actif",
    limovaSiteAllow: "Autoriser ce site",
    limovaCurrentConversation: "Conversation actuelle",
    limovaChooseConversation: "Reprendre une conversation",
    limovaChooseWorkspace: "Choisir un espace",
    limovaUnavailable: "extension indisponible",
    limovaChecking: "Vérification de la session Limova…",
    limovaLoginHint: "Connecte-toi dans Limova, puis clique sur « Actualiser ma connexion ».",
    limovaWorkspaceHint: "Choisis un espace activé pour l’extension.",
    limovaRateLimited: "Limova reçoit trop de demandes. Réessaie plus tard.",
    limovaCheckConversation: "Vérifie l’historique et le résultat des actions avant de renvoyer une demande.",
    limovaServiceUnavailable: "Limova est temporairement indisponible.",
    limovaResumeConsent: "Autorise le navigateur pour reprendre le tour interrompu.",
    limovaUncertain: "Le résultat de l’action est incertain. Vérifie la page avant de poursuivre ; l’action ne sera pas répétée automatiquement.",
    limovaWaiting: "Le tour navigateur est en attente.",
    limovaNoPendingTurn: "Aucun tour navigateur à reprendre.",
    limovaCancelled: "Ce tour navigateur a été annulé.",
    limovaOpeningFile: "Ouverture du fichier…",
    limovaWorkspaceRequired: "Sélectionne un espace Limova disponible.",
    limovaConversationRequired: "Sélectionne une conversation Limova disponible.",
    limovaConversationUnavailable: "Conversation Limova indisponible.",
    limovaSessionChanged: "La session Limova a changé.",
    limovaPlan: "Plan de Charly",
    limovaPlan_pending: "À faire",
    limovaPlan_in_progress: "En cours",
    limovaPlan_completed: "Terminé",
    limovaGeneratedCaption: "Légende générée",
    title: 'Charly',
    subtitle: 'Assistant onboarding',
    statusReady: 'Prêt',
    statusAnalyzing: 'Analyse...',
    statusError: 'Erreur',
    resetTitle: 'Réinitialiser',
    screenshotTitle: 'Analyser la page actuelle',
    voiceStart: 'Démarrer une conversation vocale',
    voiceStop: 'Arrêter la conversation vocale',
    voiceConnecting: 'Connexion voix...',
    voiceListening: 'Je t’écoute',
    voiceSpeaking: 'Charly répond',
    voiceError: 'La conversation vocale est indisponible.',
    voiceResponseTimeout: 'La réponse vocale n’est pas arrivée. La session est arrêtée. Vérifie l’historique avant de relancer une action.',
    voiceTurnFailed: 'Le tour vocal a échoué. La session est arrêtée. Vérifie l’historique avant de relancer une action.',
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
    howItWorks1: 'Autorise l’accès au navigateur pour que je puisse lire et utiliser l’onglet actif',
    howItWorks2: 'Je te guide étape par étape',
    howItWorks3: 'Si tu es bloqué, clique sur {CAPTURE_ICON} en bas à gauche',
    howItWorks4: 'Pose-moi n\'importe quelle question en chemin',
    cta: 'Prêt ? Dis-moi ce que tu veux faire sur Limova, ou rends-toi sur la plateforme pour commencer !',
    stepLabel: 'Étape :',
    downloadLogs: 'Télécharger les logs',
    runDiagnostics: 'Vérifier Charly',
    diagnosticRunning: 'Vérification en cours…',
    diagnosticHealthy: 'Connexion Limova vérifiée. Aucun test IA lancé.',
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
    tabClosed: 'L\'onglet Limova a été fermé. Ouvre Limova pour continuer.',
    limovaReturnTab: 'Tu es sur un autre onglet. Revenir à l’onglet accompagné',
    wrongTab: 'Tu es sur un autre onglet. Clique ici pour revenir à Limova.',
    goToLimova: 'Ouvrir Limova',
    onboardingComplete: 'Onboarding terminé !',
    screenshotCaptured: 'Page analysée',
    aiConsentTitle: 'Activer l’intelligence de Charly',
    aiConsentText: 'Avec ton accord, Charly utilise les services IA de Limova, dont OpenAI pour la voix, afin de traiter la structure de la page, les erreurs filtrées et tes messages. Tes conversations peuvent être conservées jusqu’à 12 mois pour reprendre tes objectifs. Les captures, DOM, requêtes et valeurs de formulaires ne sont jamais mémorisés. Tu gardes le contrôle dans le menu.',
    privacyLink: 'Politique de confidentialité',
    aiConsentAccept: 'Activer Charly',
    aiConsentDecline: 'Pas maintenant',
    aiConsentDeclined: 'Charly reste désactivé. Tu pourras l’activer en envoyant un message ou en lançant la voix.',
    memoryEnabled: 'Personnalisation active',
    memoryDisabled: 'Personnalisation désactivée',
    memoryExport: 'Exporter les données de l’ancienne extension',
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
    limovaExport: 'Export this conversation (CSV)',
    limovaExporting: 'Preparing export…',
    limovaNextStepPrompt: 'Guide me through the next step based on our conversation.',
    limovaAnalyzePrompt: "Analyze the active page and explain what you observe. Use a screenshot if needed. Do not click, type or navigate.",
    limovaSiteReview: "Check the website, then click “Allow this website”.",
    limovaSitePaste: "Paste the HTTPS address of the website to allow.",
    limovaSiteInvalid: "Enter a valid HTTPS address without credentials.",
    limovaSiteGranted: "Access allowed to {origin}. Then enable browser access for your message.",
    limovaSiteDenied: "Access denied to {origin}. No additional access was granted.",
    limovaSiteError: "Chrome could not grant access. Try again using the button.",
    limovaAccess: "Limova access",
    limovaAccountTitle: "Connect your Limova account",
    limovaAccountIntro: "Sign in to the Limova app to access Charly, your conversations and integrations.",
    limovaOpenApp: "Open Limova",
    limovaRefreshLogin: "Refresh my connection",
    limovaNoAccount: "I don’t have a Limova account yet",
    limovaConversations: "Limova conversations",
    limovaWorkspace: "Limova workspace",
    limovaConversationName: "Conversation",
    limovaMoreConversations: "More conversations",
    limovaOlderMessages: "Older messages",
    limovaNew: "New conversation",
    limovaRefresh: "Refresh",
    limovaResume: "Resume browser task",
    limovaStop: "Stop",
    limovaBrowserConsent: "Allow Charly to read and act on the active tab for this message",
    limovaOtherSite: "Allow another site",
    limovaSiteAddress: "Website address (HTTPS)",
    limovaSiteDetect: "Use the active website",
    limovaSiteAllow: "Allow this website",
    limovaCurrentConversation: "Current conversation",
    limovaChooseConversation: "Resume a conversation",
    limovaChooseWorkspace: "Choose a workspace",
    limovaUnavailable: "extension unavailable",
    limovaChecking: "Checking your Limova session…",
    limovaLoginHint: "Sign in to Limova, then click “Refresh my connection”.",
    limovaWorkspaceHint: "Choose a workspace enabled for the extension.",
    limovaRateLimited: "Limova is receiving too many requests. Try again later.",
    limovaCheckConversation: "Check the conversation history and action results before sending another request.",
    limovaServiceUnavailable: "Limova is temporarily unavailable.",
    limovaResumeConsent: "Allow browser access to resume the interrupted task.",
    limovaUncertain: "The action outcome is uncertain. Check the page before continuing; the action will not be repeated automatically.",
    limovaWaiting: "The browser task is waiting.",
    limovaNoPendingTurn: "No browser task to resume.",
    limovaCancelled: "This browser task was cancelled.",
    limovaOpeningFile: "Opening file…",
    limovaWorkspaceRequired: "Select an available Limova workspace.",
    limovaConversationRequired: "Select an available Limova conversation.",
    limovaConversationUnavailable: "Limova conversation unavailable.",
    limovaSessionChanged: "Your Limova session changed.",
    limovaPlan: "Charly’s plan",
    limovaPlan_pending: "Pending",
    limovaPlan_in_progress: "In progress",
    limovaPlan_completed: "Completed",
    limovaGeneratedCaption: "Generated caption",
    title: 'Charly',
    subtitle: 'Onboarding assistant',
    statusReady: 'Ready',
    statusAnalyzing: 'Analyzing...',
    statusError: 'Error',
    resetTitle: 'Reset',
    screenshotTitle: 'Analyze the current page',
    voiceStart: 'Start a voice conversation',
    voiceStop: 'Stop the voice conversation',
    voiceConnecting: 'Connecting voice...',
    voiceListening: 'Listening',
    voiceSpeaking: 'Charly is speaking',
    voiceError: 'Voice conversation is unavailable.',
    voiceResponseTimeout: 'The voice response did not arrive. The session has stopped. Check the history before retrying an action.',
    voiceTurnFailed: 'The voice turn failed. The session has stopped. Check the history before retrying an action.',
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
    howItWorks1: 'Allow browser access so I can read and use the active tab',
    howItWorks2: 'I guide you step by step',
    howItWorks3: 'If you\'re stuck, click {CAPTURE_ICON} at the bottom left',
    howItWorks4: 'Ask me any question along the way',
    cta: 'Ready? Tell me what you want to do on Limova, or head to the platform to get started!',
    stepLabel: 'Step:',
    downloadLogs: 'Download logs',
    runDiagnostics: 'Check Charly',
    diagnosticRunning: 'Running checks…',
    diagnosticHealthy: 'Limova connection verified. No AI test was run.',
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
    tabClosed: 'The Limova tab was closed. Open Limova to continue.',
    limovaReturnTab: 'You are on another tab. Return to the assisted tab',
    wrongTab: 'You\'re on another tab. Click here to go back to Limova.',
    goToLimova: 'Open Limova',
    onboardingComplete: 'Onboarding complete!',
    screenshotCaptured: 'Page analyzed',
    aiConsentTitle: 'Enable Charly’s intelligence',
    aiConsentText: 'With your consent, Charly uses Limova AI services, including OpenAI for voice, to process the Limova page structure, filtered errors, and your messages. Conversations may be retained for up to 12 months to resume your goals. Captures, DOM, requests, and form values are never added to memory. You stay in control from the menu.',
    privacyLink: 'Privacy policy',
    aiConsentAccept: 'Enable Charly',
    aiConsentDecline: 'Not now',
    aiConsentDeclined: 'Charly remains disabled. You can enable it by sending a message or starting voice.',
    memoryEnabled: 'Personalization on',
    memoryDisabled: 'Personalization off',
    memoryExport: 'Export data from the previous extension',
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
    limovaExport: 'Exportar esta conversación (CSV)',
    limovaExporting: 'Preparando la exportación…',
    limovaNextStepPrompt: 'Guíame en el siguiente paso teniendo en cuenta nuestra conversación.',
    limovaAnalyzePrompt: "Analiza la página activa y explica lo que observas. Usa una captura si es necesario. No hagas clic, no escribas ni navegues.",
    limovaSiteReview: "Revisa el sitio y pulsa «Autorizar este sitio».",
    limovaSitePaste: "Pega la dirección HTTPS del sitio que quieras autorizar.",
    limovaSiteInvalid: "Introduce una dirección HTTPS válida sin credenciales.",
    limovaSiteGranted: "Acceso autorizado a {origin}. Después, activa el permiso del navegador para tu mensaje.",
    limovaSiteDenied: "Acceso denegado a {origin}. No se ha concedido ningún acceso adicional.",
    limovaSiteError: "Chrome no ha podido conceder el acceso. Vuelve a intentarlo con el botón.",
    limovaAccess: "Acceso a Limova",
    limovaAccountTitle: "Conecta tu cuenta de Limova",
    limovaAccountIntro: "Inicia sesión en Limova para acceder a Charly, tus conversaciones e integraciones.",
    limovaOpenApp: "Abrir Limova",
    limovaRefreshLogin: "Actualizar mi conexión",
    limovaNoAccount: "Todavía no tengo una cuenta de Limova",
    limovaConversations: "Conversaciones de Limova",
    limovaWorkspace: "Espacio de Limova",
    limovaConversationName: "Conversación",
    limovaMoreConversations: "Más conversaciones",
    limovaOlderMessages: "Mensajes anteriores",
    limovaNew: "Nueva conversación",
    limovaRefresh: "Actualizar",
    limovaResume: "Reanudar la tarea del navegador",
    limovaStop: "Detener",
    limovaBrowserConsent: "Permitir que Charly lea y actúe en la pestaña activa para este mensaje",
    limovaOtherSite: "Autorizar otro sitio",
    limovaSiteAddress: "Dirección del sitio (HTTPS)",
    limovaSiteDetect: "Usar el sitio activo",
    limovaSiteAllow: "Autorizar este sitio",
    limovaCurrentConversation: "Conversación actual",
    limovaChooseConversation: "Retomar una conversación",
    limovaChooseWorkspace: "Elegir un espacio",
    limovaUnavailable: "extensión no disponible",
    limovaChecking: "Comprobando tu sesión de Limova…",
    limovaLoginHint: "Inicia sesión en Limova y pulsa «Actualizar mi conexión».",
    limovaWorkspaceHint: "Elige un espacio habilitado para la extensión.",
    limovaRateLimited: "Limova está recibiendo demasiadas solicitudes. Inténtalo más tarde.",
    limovaCheckConversation: "Revisa el historial y los resultados de las acciones antes de enviar otra solicitud.",
    limovaServiceUnavailable: "Limova no está disponible temporalmente.",
    limovaResumeConsent: "Autoriza el acceso al navegador para reanudar la tarea interrumpida.",
    limovaUncertain: "El resultado de la acción es incierto. Revisa la página antes de continuar; la acción no se repetirá automáticamente.",
    limovaWaiting: "La tarea del navegador está en espera.",
    limovaNoPendingTurn: "No hay ninguna tarea del navegador que reanudar.",
    limovaCancelled: "Esta tarea del navegador se ha cancelado.",
    limovaOpeningFile: "Abriendo archivo…",
    limovaWorkspaceRequired: "Selecciona un espacio de Limova disponible.",
    limovaConversationRequired: "Selecciona una conversación de Limova disponible.",
    limovaConversationUnavailable: "Conversación de Limova no disponible.",
    limovaSessionChanged: "Tu sesión de Limova ha cambiado.",
    limovaPlan: "Plan de Charly",
    limovaPlan_pending: "Pendiente",
    limovaPlan_in_progress: "En curso",
    limovaPlan_completed: "Completado",
    limovaGeneratedCaption: "Texto generado",
    title: 'Charly',
    subtitle: 'Asistente de onboarding',
    statusReady: 'Listo',
    statusAnalyzing: 'Analizando...',
    statusError: 'Error',
    resetTitle: 'Reiniciar',
    screenshotTitle: 'Analizar la página actual',
    voiceStart: 'Iniciar una conversación de voz',
    voiceStop: 'Detener la conversación de voz',
    voiceConnecting: 'Conectando voz...',
    voiceListening: 'Te escucho',
    voiceSpeaking: 'Charly responde',
    voiceError: 'La conversación de voz no está disponible.',
    voiceResponseTimeout: 'La respuesta de voz no llegó. La sesión se ha detenido. Revisa el historial antes de repetir una acción.',
    voiceTurnFailed: 'El turno de voz falló. La sesión se ha detenido. Revisa el historial antes de repetir una acción.',
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
    howItWorks1: 'Autoriza el acceso al navegador para que pueda leer y usar la pestaña activa',
    howItWorks2: 'Te guío paso a paso',
    howItWorks3: 'Si te bloqueas, haz clic en {CAPTURE_ICON} abajo a la izquierda',
    howItWorks4: 'Hazme cualquier pregunta en el camino',
    cta: '¿Listo? Dime qué quieres hacer en Limova, ¡o ve a la plataforma para empezar!',
    stepLabel: 'Paso:',
    downloadLogs: 'Descargar logs',
    runDiagnostics: 'Verificar Charly',
    diagnosticRunning: 'Comprobación en curso…',
    diagnosticHealthy: 'Conexión con Limova verificada. No se ejecutó ninguna prueba de IA.',
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
    tabClosed: 'La pestaña de Limova se cerró. Abre Limova para continuar.',
    limovaReturnTab: 'Estás en otra pestaña. Volver a la pestaña asistida',
    wrongTab: 'Estás en otra pestaña. Haz clic aquí para volver a Limova.',
    goToLimova: 'Abrir Limova',
    onboardingComplete: '¡Onboarding completado!',
    screenshotCaptured: 'Página analizada',
    aiConsentTitle: 'Activar la inteligencia de Charly',
    aiConsentText: 'Con tu consentimiento, Charly usa los servicios de IA de Limova, incluido OpenAI para la voz, para procesar la estructura de la página, los errores filtrados y tus mensajes. Las conversaciones pueden conservarse hasta 12 meses para retomar tus objetivos. Las capturas, el DOM, las solicitudes y los valores de formularios nunca se añaden a la memoria. Mantienes el control desde el menú.',
    privacyLink: 'Política de privacidad',
    aiConsentAccept: 'Activar Charly',
    aiConsentDecline: 'Ahora no',
    aiConsentDeclined: 'Charly permanece desactivado. Puedes activarlo enviando un mensaje o iniciando la voz.',
    memoryEnabled: 'Personalización activa',
    memoryDisabled: 'Personalización desactivada',
    memoryExport: 'Exportar datos de la extensión anterior',
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
function createCaptureIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'inline-icon');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // Keep the onboarding hint identical to the page-analysis button.
  path.setAttribute('d', 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '13');
  circle.setAttribute('r', '4');
  svg.append(path, circle);
  return svg;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const text = t(el.dataset.i18n);
    if (text.includes('{CAPTURE_ICON}')) {
      // Split around the placeholder and build DOM nodes
      const parts = text.split('{CAPTURE_ICON}');
      el.textContent = '';
      el.appendChild(document.createTextNode(parts[0]));
      el.appendChild(createCaptureIcon());
      if (parts[1]) el.appendChild(document.createTextNode(parts[1]));
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
