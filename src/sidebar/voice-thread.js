// GPT Live's two transcript streams overlap. Update one bubble per utterance
// instead of appending a message whenever the other speaker emits a fragment.
(() => {
  const utterances = new Map();
  window.addEventListener('limova-gpt-transcript', ({ detail }) => {
    const { utteranceId, role, text, final } = detail || {};
    if (!utteranceId || !['user', 'assistant'].includes(role)) return;
    const value = String(text || '');
    let item = utterances.get(utteranceId);
    if (!item) {
      if (utterances.size > 400) utterances.delete(utterances.keys().next().value);
      item = { role, node: null, saved: null };
      utterances.set(utteranceId, item);
    }
    if (!item.node && /[\p{L}\p{N}]/u.test(value)) {
      hideWelcomeScreen();
      addMessage(role, value.trim());
      removeNextStepLinks();
      item.node = [...document.querySelectorAll('#chatContainer .message-content')].at(-1);
      if (item.node) item.node.parentElement.dataset.voiceUtteranceId = utteranceId;
    }
    if (item.node?.isConnected) item.node.textContent = value.trim();
    if (final && value.trim() && item.saved !== value.trim()) {
      item.saved = value.trim();
      chrome.runtime.sendMessage({ type: 'LOCAL_VOICE_TRANSCRIPT', role, text: value, utteranceId }).catch(() => {});
    }
    scrollToBottom();
  });
})();
