/**
 * Limova AI - Charly Onboarding Assistant - Sidebar Logic
 * Handles chat rendering, user input, voice recognition, and background communication
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
  micBtn: document.getElementById('micBtn'),
  screenshotBtn: document.getElementById('screenshotBtn'),
  downloadLogsBtn: document.getElementById('downloadLogsBtn'),
  tabWarning: document.getElementById('tabWarning'),
  tabWarningText: document.getElementById('tabWarningText'),
  callBtn: document.getElementById('callBtn'),
  callOverlay: document.getElementById('callOverlay'),
  callStatus: document.getElementById('callStatus'),
  callHangup: document.getElementById('callHangup'),
  callMuteBtn: document.getElementById('callMuteBtn'),
};

// ============================================================================
// State
// ============================================================================

let isLoading = false;
let welcomeScreenVisible = true;
let lastMessageSender = null;
let isRecording = false;
let voiceMode = false;
let voiceMuted = false;

// Streaming audio state
let audioContext = null;
let audioQueue = [];        // queued decoded AudioBuffers
let isPlayingAudio = false;
let currentAudioSource = null;  // current AudioBufferSourceNode
let nextPlayTime = 0;       // schedule time for gapless playback
let ttsStreamActive = false;

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  renderAnnouncements();
  initEventListeners();
  loadInitialState();
});

function initEventListeners() {
  elements.userInput.addEventListener('input', handleInputChange);
  elements.userInput.addEventListener('keydown', handleInputKeydown);
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.micBtn.addEventListener('click', toggleRecording);
  elements.screenshotBtn.addEventListener('click', takeScreenshot);

  elements.resetBtn.addEventListener('click', () => { document.getElementById('headerMenu').hidden = true; resetSession(); });
  elements.callBtn.addEventListener('click', toggleVoiceMode);
  elements.callHangup.addEventListener('click', toggleVoiceMode);
  elements.callMuteBtn.addEventListener('click', toggleMute);

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
  elements.tabWarning.addEventListener('click', handleTabWarningClick);

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
  });

  // Listen for background messages
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

async function loadInitialState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.conversationHistory?.length > 0) {
      hideWelcomeScreen();
      response.conversationHistory.forEach(msg => {
        addMessage(msg.role, msg.content, { skipScroll: true });
      });
      scrollToBottom();
    }
    // Restore onboarding step progress
    if (response?.onboardingPlan) {
      const plan = response.onboardingPlan;
      const current = plan.steps[plan.activeIndex];
      if (current) {
        updateStepInfo(current.name, `${plan.activeIndex + 1} / ${plan.steps.length}`);
      }
    }
  } catch (e) {
    // Extension context not ready yet
  }

  // Check if user is on Limova — show link if not
  checkIfOnLimova();
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
  switch (message.type) {
    case 'GEMINI_RESPONSE':
      hidePondering();
      hideWelcomeScreen();
      if (message.screenshot) {
        addScreenshot(message.screenshot);
      }
      addMessage('assistant', message.content);
      if (voiceMode) {
        // TTS is being synthesized, stay in thinking until audio arrives
        updateCallState('thinking');
      }
      updateStatus('ready');
      break;

    case 'TTS_STREAM_START':
      onTTSStreamStart();
      break;

    case 'TTS_STREAM_CHUNK':
      onTTSStreamChunk(message.chunk);
      break;

    case 'TTS_STREAM_END':
      onTTSStreamEnd(message.aborted);
      break;

    case 'TTS_STOP':
      onTTSStop();
      break;

    case 'TTS_AUDIO':
      // Fallback for non-streaming (null = TTS failed)
      if (voiceMode) {
        updateCallState('listening');
        if (!isRecording) toggleRecording();
      }
      break;

    case 'STATUS_UPDATE':
      updateStatus(message.status, message.text);
      if (message.status === 'analyzing') {
        showPondering(message.ponderingText ? t(message.ponderingText) : null);
        if (voiceMode) updateCallState('thinking');
      } else if (message.status === 'ready' && voiceMode) {
        // Recover from aborted/rate-limited calls
        hidePondering();
        if (!voiceMuted && !isRecording) {
          updateCallState('listening');
          toggleRecording();
        } else if (voiceMuted) {
          updateCallState('muted');
        }
      }
      break;

    case 'ERROR':
      hidePondering();
      addMessage('error', message.content || t('errorGeneric'));
      updateStatus('error');
      if (voiceMode && !voiceMuted) {
        updateCallState('listening');
        if (!isRecording) toggleRecording();
      } else if (voiceMode) {
        updateCallState('muted');
      }
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

    case 'STEP_UPDATE':
      updateStepInfo(message.step, message.progress);
      break;

    case 'ONBOARDING_COMPLETE':
      updateStepInfo(null);
      addMessage('system', t('onboardingComplete'));
      break;

    // Voice recognition events (relayed from content script via background)
    case 'VOICE_TRANSCRIPT':
      elements.userInput.value = message.text;
      autoResizeTextarea();
      break;

    case 'VOICE_ENDED':
      isRecording = false;
      elements.micBtn.classList.remove('recording');
      if (elements.userInput.value.trim()) {
        if (voiceMode) {
          // Auto-send in voice conversation mode
          updateCallState('thinking');
          sendMessage();
        } else {
          elements.micBtn.hidden = true;
          elements.sendBtn.hidden = false;
        }
      } else if (voiceMode) {
        // No speech detected, restart listening
        updateCallState('listening');
        if (!isRecording) toggleRecording();
      }
      break;

    case 'VOICE_ERROR':
      isRecording = false;
      elements.micBtn.classList.remove('recording');
      if (voiceMode) {
        // Show error and exit voice mode
        toggleVoiceMode();
        if (message.error === 'no-tab' || message.error === 'content-script-unavailable') {
          addMessage('error', t('micNoTab'));
        } else if (message.error !== 'not-supported') {
          addMessage('error', t('errorMic') + message.error);
        }
      } else {
        if (message.error === 'not-supported') {
          elements.micBtn.hidden = true;
          elements.sendBtn.hidden = false;
        } else if (message.error === 'no-tab' || message.error === 'content-script-unavailable') {
          addMessage('error', t('micNoTab'));
        } else {
          addMessage('error', t('errorMic') + message.error);
        }
      }
      break;
  }
}

// ============================================================================
// Chat Rendering
// ============================================================================

function addScreenshot(base64Data) {
  const wrapper = document.createElement('div');
  wrapper.className = 'screenshot-bubble';
  const img = document.createElement('img');
  img.src = `data:image/jpeg;base64,${base64Data}`;
  img.alt = 'Capture d\'écran';
  img.className = 'screenshot-thumb';
  img.addEventListener('click', () => {
    img.classList.toggle('screenshot-expanded');
  });
  wrapper.appendChild(img);
  elements.chatContainer.appendChild(wrapper);
}

function addMessage(role, content, options = {}) {
  if (!content) return;

  if (role !== lastMessageSender && (role === 'assistant' || role === 'user')) {
    const header = document.createElement('div');
    header.className = `message-header ${role}`;
    if (role === 'assistant') {
      header.innerHTML = `<img src="../charly.png" alt="Charly" class="message-avatar"><span class="message-sender">Charly</span>`;
    } else {
      header.innerHTML = `<span class="message-sender">${t('senderYou')}</span>`;
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
  div.innerHTML = `
    <div class="pondering-content">
      <img src="../charly.png" alt="Charly" class="pondering-avatar">
      <span class="pondering-text">${label}<span class="pondering-dots"><span></span><span></span><span></span></span></span>
    </div>
  `;
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
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
  const hasText = !!elements.userInput.value.trim();
  if (hasText) {
    elements.micBtn.hidden = true;
    elements.sendBtn.hidden = false;
  } else if (!isRecording) {
    elements.micBtn.hidden = false;
    elements.sendBtn.hidden = true;
  }
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
  const text = elements.userInput.value.trim();
  if (!text || isLoading) return;

  // Stop any ongoing TTS playback
  stopAudio();

  isLoading = true;
  hideWelcomeScreen();
  addMessage('user', text);
  elements.userInput.value = '';
  elements.sendBtn.hidden = true;
  elements.micBtn.hidden = false;
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

async function takeScreenshot() {
  showPondering();
  updateStatus('analyzing');
  try {
    await chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' });
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
// Voice Recognition (via content script in active Limova tab)
// ============================================================================

function toggleRecording() {
  if (isRecording) {
    chrome.runtime.sendMessage({ type: 'VOICE_STOP' });
  } else {
    // Interrupt TTS if user starts speaking
    stopAudio();
    isRecording = true;
    elements.micBtn.classList.add('recording');
    chrome.runtime.sendMessage({ type: 'VOICE_START', lang: t('speechLang'), voiceMode });
  }
}

// ============================================================================
// Voice Conversation Mode (Call Overlay + TTS + auto-STT loop)
// ============================================================================

function toggleVoiceMode() {
  voiceMode = !voiceMode;
  elements.callBtn.classList.toggle('voice-active', voiceMode);
  chrome.runtime.sendMessage({ type: 'TOGGLE_VOICE_MODE' });

  if (voiceMode) {
    // Show call overlay and start listening
    voiceMuted = false;
    elements.callMuteBtn.classList.remove('muted');
    elements.callOverlay.hidden = false;
    updateCallState('listening');
    hideWelcomeScreen();
    if (!isRecording) toggleRecording();
  } else {
    // Hide call overlay, stop everything
    elements.callOverlay.hidden = true;
    elements.callOverlay.classList.remove('listening', 'thinking', 'speaking');
    voiceMuted = false;
    elements.callMuteBtn.classList.remove('muted');
    if (isRecording) {
      chrome.runtime.sendMessage({ type: 'VOICE_STOP' });
      isRecording = false;
      elements.micBtn.classList.remove('recording');
    }
    stopAudio();
    // Clear any pending voice transcript from textarea
    elements.userInput.value = '';
    autoResizeTextarea();
    elements.micBtn.hidden = false;
    elements.sendBtn.hidden = true;
    isLoading = false;
  }
}

function toggleMute() {
  voiceMuted = !voiceMuted;
  elements.callMuteBtn.classList.toggle('muted', voiceMuted);

  if (voiceMuted) {
    // Stop recording, show muted state
    if (isRecording) {
      chrome.runtime.sendMessage({ type: 'VOICE_STOP' });
      isRecording = false;
    }
    updateCallState('muted');
  } else {
    // Resume recording
    updateCallState('listening');
    if (!isRecording) toggleRecording();
  }
}

function updateCallState(state) {
  // state: 'listening' | 'thinking' | 'speaking' | 'muted'
  const overlay = elements.callOverlay;
  overlay.classList.remove('listening', 'thinking', 'speaking', 'muted');
  overlay.classList.add(state);

  const statusKey = {
    listening: 'callListening',
    thinking: 'callThinking',
    speaking: 'callSpeaking',
    muted: 'callMuted'
  }[state];
  elements.callStatus.textContent = t(statusKey);
}

// ============================================================================
// Streaming Audio Playback (accumulate + Audio element for MP3 streaming)
// ============================================================================

let streamChunks = [];       // accumulated base64 chunks
let streamAudio = null;      // Audio element for playback
let streamBlobUrl = null;

function stopAudio() {
  ttsStreamActive = false;
  isPlayingAudio = false;
  streamChunks = [];
  if (streamAudio) {
    streamAudio.pause();
    streamAudio.onended = null;
    streamAudio.onerror = null;
    streamAudio = null;
  }
  if (streamBlobUrl) {
    URL.revokeObjectURL(streamBlobUrl);
    streamBlobUrl = null;
  }
}

function onTTSStreamStart() {
  stopAudio();
  ttsStreamActive = true;
  streamChunks = [];
  if (voiceMode) updateCallState('speaking');
}

function onTTSStreamChunk(base64Chunk) {
  if (!ttsStreamActive) return;
  streamChunks.push(base64Chunk);

  // Start playback early after accumulating enough data (~16KB = fast start)
  if (!isPlayingAudio && streamChunks.length >= 2) {
    playAccumulatedAudio();
  }
}

function playAccumulatedAudio() {
  if (!ttsStreamActive && streamChunks.length === 0) return;

  // Combine all chunks into a single blob
  const combined = streamChunks.join('');
  const bytes = atob(combined);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);

  const blob = new Blob([arr], { type: 'audio/mpeg' });

  // Clean up previous
  if (streamAudio) {
    streamAudio.pause();
    streamAudio.onended = null;
    streamAudio.onerror = null;
  }
  if (streamBlobUrl) URL.revokeObjectURL(streamBlobUrl);

  streamBlobUrl = URL.createObjectURL(blob);
  streamAudio = new Audio(streamBlobUrl);
  streamAudio.onended = () => {
    isPlayingAudio = false;
    // If stream is still active, more chunks may arrive — rebuild and resume
    if (ttsStreamActive) {
      // More data arrived while playing? Rebuild and continue
      if (streamChunks.length > 0) {
        playAccumulatedAudio();
      }
    } else {
      // Stream is done and audio finished
      resumeListeningAfterTTS();
    }
  };
  streamAudio.onerror = () => {
    console.warn('[Limova] Audio playback error');
    isPlayingAudio = false;
    if (!ttsStreamActive) resumeListeningAfterTTS();
  };
  streamAudio.play().catch(err => {
    console.warn('[Limova] Audio play failed:', err.message);
    isPlayingAudio = false;
    if (!ttsStreamActive) resumeListeningAfterTTS();
  });
  isPlayingAudio = true;
}

function onTTSStreamEnd(aborted) {
  ttsStreamActive = false;
  if (aborted) {
    stopAudio();
    resumeListeningAfterTTS();
    return;
  }
  // If audio is not playing yet (very short response), play now
  if (!isPlayingAudio && streamChunks.length > 0) {
    playAccumulatedAudio();
  }
  // If audio is already playing, onended will call resumeListeningAfterTTS
}

function onTTSStop() {
  stopAudio();
}

function resumeListeningAfterTTS() {
  if (voiceMode && !voiceMuted) {
    updateCallState('listening');
    if (!isRecording) toggleRecording();
  } else if (voiceMode) {
    updateCallState('muted');
  }
}

// ============================================================================
// Session Reset
// ============================================================================

async function resetSession() {
  if (!confirm(t('resetConfirm'))) return;
  try {
    await chrome.runtime.sendMessage({ type: 'RESET_SESSION' });
    elements.chatContainer.innerHTML = '';
    elements.stepInfo.hidden = true;
    elements.welcomeScreen.hidden = false;
    welcomeScreenVisible = true;
    lastMessageSender = null;
    voiceMode = false;
    elements.callBtn.classList.remove('voice-active');
    elements.callOverlay.hidden = true;
    stopAudio();
    hideTabWarning();
    updateStatus('ready');
  } catch (e) {}
}

// ============================================================================
// Download Logs
// ============================================================================

async function downloadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
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
