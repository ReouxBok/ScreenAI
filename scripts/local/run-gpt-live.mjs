// Local development only. No production configuration is changed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../../build/gpt-live/manifest.json', import.meta.url)));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
// Secrets stay in this server process, never in an extension or generated file.
const config = JSON.parse(execFileSync('heroku', ['config', '--app', 'limova-proxy', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }));
for (const key of ['OPENAI_API_KEY', 'EXTENSION_GEMINI_API_KEY', 'KNOWLEDGE_API_URL', 'KNOWLEDGE_SERVICE_TOKEN']) {
  if (config[key]) process.env[key] = config[key];
}
if (!process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY is missing');
process.env.AUTH_DISABLED = 'true';
process.env.CHARLY_LOCAL_BROWSER_MODE = 'true';
process.env.ALLOWED_EXTENSION_ID = id;
process.env.POSTHOG_API_KEY = '';
process.env.MEMORY_API_URL = '';
process.env.MEMORY_SERVICE_TOKEN = '';
const app = require('../../proxy/index.js');
app.listen(4317, '127.0.0.1', () => console.log(`GPT Live local: http://127.0.0.1:4317 — ${id}`));
