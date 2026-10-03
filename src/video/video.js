const startButton = document.getElementById('start');
const endButton = document.getElementById('end');
const intro = document.getElementById('intro');
const frame = document.getElementById('conversation');
const status = document.getElementById('status');
const errorNode = document.getElementById('error');
let conversationId = null;

async function endConversation() {
  if (!conversationId) return;
  const id = conversationId;
  conversationId = null;
  await chrome.runtime.sendMessage({ type: 'END_TAVUS_CONVERSATION', conversationId: id }).catch(() => {});
  window.close();
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  errorNode.hidden = true;
  status.textContent = 'Connexion à Tavus…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'START_TAVUS_CONVERSATION' });
    if (!result?.ok || !result.conversationUrl) throw new Error(result?.error || 'Impossible de démarrer l’appel.');
    const url = new URL(result.conversationUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.daily.co')) throw new Error('Adresse de conversation Tavus invalide.');
    conversationId = result.conversationId;
    frame.src = url.href;
    intro.hidden = true;
    frame.hidden = false;
    endButton.hidden = false;
    status.textContent = 'Appel vidéo en cours';
  } catch (error) {
    status.textContent = 'Appel indisponible';
    errorNode.textContent = error.message;
    errorNode.hidden = false;
    startButton.disabled = false;
  }
});

endButton.addEventListener('click', endConversation);
