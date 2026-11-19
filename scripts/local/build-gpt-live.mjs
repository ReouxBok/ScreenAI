// A separate unpacked extension; production sources and release ZIP stay intact.
import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'build/gpt-live');
mkdirSync(out, { recursive: true });
const previous = existsSync(`${out}/manifest.json`) ? JSON.parse(readFileSync(`${out}/manifest.json`)) : null;
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`));
manifest.key = previous?.key || generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
manifest.name = 'Charly — GPT Live local (FR)';
manifest.action.default_title = manifest.name;
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src ', 'connect-src http://127.0.0.1:4317 https://api.openai.com ');
for (const dir of ['src', 'assets']) cpSync(`${root}/${dir}`, `${out}/${dir}`, { recursive: true });
buildSync({ entryPoints: [`${root}/src/sidebar/training-recording-upload.entry.js`], bundle: true, format: 'iife', platform: 'browser', target: 'chrome114', outfile: `${out}/src/sidebar/training-recording-upload.js`, logLevel: 'warning' });
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
let bg = readFileSync(`${out}/src/background.js`, 'utf8');
function replace(old, value) { if (!bg.includes(old)) throw Error(`Local build source changed: ${old}`); bg = bg.replace(old, value); }
replace("const PROXY_URL = 'https://limova-proxy-479c7fb78ccf.herokuapp.com';", "const PROXY_URL = 'http://127.0.0.1:4317';\nlet localVoiceWindowId = null;");
replace("let currentLang = DEFAULT_LANG;", "let currentLang = 'fr';");
replace('async function getProxyAccessToken(forceRefresh = false) {', "async function getProxyAccessToken(forceRefresh = false) {\n  return 'loopback-development-only';");
replace("case 'GET_LIVE_TOKEN':", "case 'GET_LIVE_SESSION':\n      localVoiceWindowId = Number.isInteger(request.context?.windowId) ? request.context.windowId : null;\n      return getLiveToken({ ...(request.context || {}), sdp: request.sdp });\n\n    case 'GET_LIVE_TOKEN':");
replace("case 'GET_LIVE_SESSION':", "case 'GET_LOCAL_VOICE_PAGE_CONTEXT':\n      localVoiceWindowId = Number.isInteger(request.windowId) ? request.windowId : null;\n      return getFreshVoiceContext();\n\n    case 'GET_LIVE_SESSION':");
replace("case 'GET_LOCAL_VOICE_PAGE_CONTEXT':", "case 'LOCAL_VOICE_TRANSCRIPT':\n      return storeLocalVoiceTranscript(request);\n\n    case 'GET_LOCAL_VOICE_PAGE_CONTEXT':");
replace('async function getLiveToken(context) {', `async function storeLocalVoiceTranscript({ role, text, utteranceId }) {
  if (!['user', 'assistant'].includes(role) || typeof utteranceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(utteranceId)) return { ok: false };
  if (!(await hasAIProcessingConsent())) return { ok: false };
  const content = String(text || '').trim().slice(0, 4000);
  if (!content) return { ok: false };
  const previous = sessionState.conversationHistory.find(item => item.voiceUtteranceId === utteranceId);
  if (previous && previous.role !== role) return { ok: false };
  if (previous?.content === content) return { ok: true };
  if (role === 'user') rememberUserTurn(content, 'voice');
  if (previous) previous.content = content;
  else {
    const sequence = Number(utteranceId.split(':').at(-1));
    const prefix = utteranceId.split(':')[0] + ':';
    const before = sessionState.conversationHistory.findIndex(item => item.voiceUtteranceId?.startsWith(prefix) && Number(item.voiceUtteranceId.split(':').at(-1)) > sequence);
    sessionState.conversationHistory.splice(before < 0 ? sessionState.conversationHistory.length : before, 0, { role, content, voiceUtteranceId: utteranceId });
  }
  sessionState.conversationHistory = sessionState.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
  Logger.event('voice', 'VOICE_TRANSCRIPT_FINALIZED', { role, characterCount: content.length, contentExported: false });
  scheduleSave();
  return { ok: true };
}

async function getLiveToken(context) {`);
replace('async function persistVoiceTranscript(role, content, generation = sessionGeneration) {', 'async function persistVoiceTranscript(role, content, generation = sessionGeneration) {\n  return; // Remote memory is disabled in this local build.');
replace(`async function getVoiceContextTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active?.id && isAssistedUrl(active.url)) return active;
  return getLimovaTabForAuthentication();
}`, `async function getVoiceContextTab() {
  const query = localVoiceWindowId == null
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId: localVoiceWindowId };
  const [active] = await chrome.tabs.query(query).catch(() => []);
  let tab = active?.id && isAssistedUrl(active.url) ? active : null;
  Logger.event('voice', 'VOICE_CONTEXT_TAB_SELECTED', {
    found: Boolean(tab), active: Boolean(tab?.active),
    panelWindowMatched: Boolean(tab && tab.windowId === localVoiceWindowId)
  });
  return tab;
}`);
replace('async function followActivatedTab(tabId) {', `async function followActivatedTab(tabId) {
  if (localVoiceWindowId != null) {
    const candidate = await chrome.tabs.get(tabId).catch(() => null);
    if (candidate && candidate.windowId !== localVoiceWindowId) return true;
  }`);
replace("authorizedProxyFetch('/api/live-token', {", "authorizedProxyFetch(context.sdp ? '/api/live-session' : '/api/live-token', {");
replace('const sessionId = trainingMode || evaluationMode ? null : await ensureRemoteCopilotSession(operation.generation, controller.signal, operation);', 'const sessionId = null; // Local voice does not create production memory sessions.');
replace('lang: currentLang,\n        trainingMode,', "lang: 'fr',\n        ...(context.sdp ? { sdp: context.sdp } : {}),\n        trainingMode,");
// Keep the complete extracted page context for GPT Live, at session creation,
// on tool inspection, and after user interactions. Production Gemini keeps its budget.
const pageContextCap = '.slice(0, 12_000)';
if (bg.split(pageContextCap).length - 1 !== 3) throw Error('Voice page context limits changed');
bg = bg.replaceAll(pageContextCap, '');
// A dense page can place the requested control after the first 150 entries.
// Keep every extracted control so scrolling cannot leave the target unaddressable.
replace('elements: elementMap.slice(0, 150),', 'elements: elementMap,');
writeFileSync(`${out}/src/background.js`, bg);
const voicePath = `${out}/src/sidebar/voice.js`;
const voice = readFileSync(voicePath, 'utf8');
if (!voice.includes('permissionTabId = tab?.id ?? null;')) throw Error('Microphone permission handler changed');
if (voice.split(pageContextCap).length - 1 !== 1) throw Error('Sidebar page context limit changed');
writeFileSync(voicePath, voice
  .replace('permissionTabId = tab?.id ?? null;', 'permissionTabId = tab?.id ?? null; this.microphonePermissionTabId = permissionTabId;')
  .replace(pageContextCap, ''));
const html = `${out}/src/sidebar/sidebar.html`;
writeFileSync(html, readFileSync(html, 'utf8').replace('<script src="voice.js"></script>', '<script src="voice.js"></script>\n  <script src="voice-openai.js"></script>\n  <script src="voice-thread.js"></script>'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
console.log(JSON.stringify({ path: out, extensionId: id, provider: 'gpt-live-1', voice: 'marin', language: 'fr-FR' }));
