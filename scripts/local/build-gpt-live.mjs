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
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src ', 'connect-src http://127.0.0.1:4317 ');
for (const dir of ['src', 'assets']) cpSync(`${root}/${dir}`, `${out}/${dir}`, { recursive: true });
buildSync({ entryPoints: [`${root}/src/sidebar/training-recording-upload.entry.js`], bundle: true, format: 'iife', platform: 'browser', target: 'chrome114', outfile: `${out}/src/sidebar/training-recording-upload.js`, logLevel: 'warning' });
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
let bg = readFileSync(`${out}/src/background.js`, 'utf8');
function replace(old, value) { if (!bg.includes(old)) throw Error(`Local build source changed: ${old}`); bg = bg.replace(old, value); }
replace("const PROXY_URL = 'https://limova-proxy-479c7fb78ccf.herokuapp.com';", "const PROXY_URL = 'http://127.0.0.1:4317';");
replace("let currentLang = DEFAULT_LANG;", "let currentLang = 'fr';");
replace('async function getProxyAccessToken(forceRefresh = false) {', "async function getProxyAccessToken(forceRefresh = false) {\n  return 'loopback-development-only';");
replace('async function persistVoiceTranscript(role, content, generation = sessionGeneration, utteranceId = null) {', 'async function persistVoiceTranscript(role, content, generation = sessionGeneration, utteranceId = null) {\n  return; // Remote memory is disabled in this local build.');
replace('const sessionId = trainingMode || evaluationMode ? null : await ensureRemoteCopilotSession(operation.generation, controller.signal, operation);', 'const sessionId = null; // Local voice does not create production memory sessions.');
writeFileSync(`${out}/src/background.js`, bg);
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
console.log(JSON.stringify({ path: out, extensionId: id, provider: 'gpt-live-1', voice: 'marin', language: 'fr-FR' }));
