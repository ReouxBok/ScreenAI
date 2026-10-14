function microphoneError(cause) {
  if (cause?.voiceErrorKey) return cause;
  const error = new Error(cause?.message || 'Microphone unavailable.');
  const name = cause?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    error.voiceErrorKey = /dismiss|cancel|clos/i.test(cause?.message || '') ? 'voiceMicDismissed' : 'voiceMicDenied';
  else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') error.voiceErrorKey = 'voiceMicNotFound';
  else error.voiceErrorKey = 'voiceMicUnavailable';
  return error;
}

export function requestMicrophonePermissionInTab(chrome) {
  return new Promise((resolve, reject) => {
    let permissionTabId = null;
    let settled = false;
    const finish = (granted, errorKey) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onRemoved?.removeListener(onRemoved);
      if (granted) resolve();
      else {
        const error = new Error('Microphone permission was not granted.');
        error.voiceErrorKey = errorKey;
        reject(error);
      }
    };
    const onMessage = (message, sender) => {
      if (message?.type !== 'MICROPHONE_PERMISSION_RESULT') return;
      if (permissionTabId && sender?.tab?.id && sender.tab.id !== permissionTabId) return;
      finish(message.granted === true, message.errorKey || 'voiceMicDismissed');
    };
    const onRemoved = tabId => { if (tabId === permissionTabId) finish(false, 'voiceMicDismissed'); };
    const timeout = setTimeout(() => finish(false, 'voiceMicDismissed'), 120_000);
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.onRemoved?.addListener(onRemoved);
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sidebar/microphone-permission.html'), active: true })
      .then(tab => { permissionTabId = tab?.id || null; })
      .catch(() => finish(false, 'voiceMicDismissed'));
  });
}

export async function requestMicrophone(chrome, navigator) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error('Microphone API unavailable.');
    error.voiceErrorKey = 'voiceMicUnsupported';
    throw error;
  }
  try {
    if (navigator.permissions?.query && chrome.tabs?.create && chrome.runtime?.getURL) {
      let permission;
      try { permission = await navigator.permissions.query({ name: 'microphone' }); } catch (_) {}
      if (permission?.state === 'denied') {
        const error = new Error('Microphone permission denied.');
        error.voiceErrorKey = 'voiceMicDenied';
        throw error;
      }
      if (permission && permission.state !== 'granted') await requestMicrophonePermissionInTab(chrome);
    }
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (cause) { throw microphoneError(cause); }
}
