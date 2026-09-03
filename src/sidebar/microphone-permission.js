const permissionCopy = {
  fr: {
    title: 'Autoriser le microphone',
    description: 'Chrome doit recevoir cette autorisation dans un onglet complet avant que Charly puisse écouter depuis le panneau latéral.',
    privacy: 'Le micro s’active uniquement quand tu démarres une conversation vocale et s’arrête quand tu la quittes.',
    allow: 'Autoriser le microphone',
    retry: 'Réessayer',
    close: 'Retourner sur Limova',
    requesting: 'Choisis « Autoriser » dans la demande affichée par Chrome.',
    success: 'Microphone autorisé. Tu peux retourner sur Limova.',
    dismissed: 'La demande a été fermée. Clique sur « Réessayer », puis choisis « Autoriser » dans Chrome.',
    denied: 'Le microphone est bloqué dans Chrome. Ouvre les paramètres du microphone, autorise Limova AI, puis réessaie.',
    unavailable: 'Le microphone est indisponible ou déjà utilisé par une autre application.'
  },
  en: {
    title: 'Allow microphone access',
    description: 'Chrome needs this authorization in a full tab before Charly can listen from the side panel.',
    privacy: 'The microphone is active only when you start a voice conversation and stops when you leave it.',
    allow: 'Allow microphone',
    retry: 'Try again',
    close: 'Return to Limova',
    requesting: 'Choose “Allow” in the request displayed by Chrome.',
    success: 'Microphone allowed. You can return to Limova.',
    dismissed: 'The request was closed. Click “Try again”, then choose “Allow” in Chrome.',
    denied: 'The microphone is blocked in Chrome. Open microphone settings, allow Limova AI, then try again.',
    unavailable: 'The microphone is unavailable or already used by another application.'
  },
  es: {
    title: 'Permitir el acceso al micrófono',
    description: 'Chrome necesita esta autorización en una pestaña completa antes de que Charly pueda escuchar desde el panel lateral.',
    privacy: 'El micrófono solo está activo cuando inicias una conversación de voz y se detiene cuando sales de ella.',
    allow: 'Permitir el micrófono',
    retry: 'Volver a intentar',
    close: 'Volver a Limova',
    requesting: 'Elige «Permitir» en la solicitud que muestra Chrome.',
    success: 'Micrófono permitido. Puedes volver a Limova.',
    dismissed: 'Se cerró la solicitud. Haz clic en «Volver a intentar» y elige «Permitir» en Chrome.',
    denied: 'El micrófono está bloqueado en Chrome. Abre la configuración, permite Limova AI y vuelve a intentarlo.',
    unavailable: 'El micrófono no está disponible o ya lo usa otra aplicación.'
  }
};

const language = navigator.language?.split('-')[0];
const copy = permissionCopy[language] || permissionCopy.en;
const elements = {
  title: document.getElementById('permissionTitle'),
  description: document.getElementById('permissionDescription'),
  privacy: document.getElementById('privacyNote'),
  status: document.getElementById('permissionStatus'),
  allow: document.getElementById('allowMicrophone'),
  close: document.getElementById('closePermission')
};

document.documentElement.lang = permissionCopy[language] ? language : 'en';
document.title = `${copy.title} — Charly`;
elements.title.textContent = copy.title;
elements.description.textContent = copy.description;
elements.privacy.textContent = copy.privacy;
elements.allow.textContent = copy.allow;
elements.close.textContent = copy.close;

function showSuccess() {
  elements.status.textContent = copy.success;
  elements.status.classList.add('success');
  elements.allow.hidden = true;
  elements.close.hidden = false;
  chrome.runtime.sendMessage({ type: 'MICROPHONE_PERMISSION_RESULT', granted: true }).catch(() => {});
  chrome.runtime.sendMessage({
    type: 'DIAGNOSTIC_EVENT',
    component: 'permission_page',
    code: 'MIC_PERMISSION_GRANTED'
  }).catch(() => {});
  setTimeout(() => window.close(), 800);
}

async function requestMicrophonePermission() {
  elements.allow.disabled = true;
  elements.status.classList.remove('success');
  elements.status.textContent = copy.requesting;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(track => track.stop());
    showSuccess();
  } catch (error) {
    const dismissed = /dismiss|cancel|clos/i.test(error?.message || '');
    elements.status.textContent = error?.name === 'NotAllowedError'
      ? (dismissed ? copy.dismissed : copy.denied)
      : copy.unavailable;
    elements.allow.textContent = copy.retry;
    elements.allow.disabled = false;
    chrome.runtime.sendMessage({
      type: 'DIAGNOSTIC_EVENT',
      component: 'permission_page',
      code: dismissed ? 'MIC_PERMISSION_DISMISSED' : error?.name === 'NotAllowedError' ? 'MIC_PERMISSION_DENIED' : 'MIC_DEVICE_UNAVAILABLE',
      data: { name: error?.name || 'Error' }
    }).catch(() => {});
  }
}

elements.allow.addEventListener('click', requestMicrophonePermission);
elements.close.addEventListener('click', () => window.close());

navigator.permissions?.query({ name: 'microphone' }).then(permission => {
  if (permission.state === 'granted') showSuccess();
}).catch(() => {});
