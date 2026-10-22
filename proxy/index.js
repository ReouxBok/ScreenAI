const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { sessionSchema, turnSchema, toolResultSchema } = require('./copilot/contracts');
const { CharlyAdkOrchestrator } = require('./copilot/orchestrator');
const { loadPromptBundle } = require('./copilot/prompt');
const { sanitizeKnowledgeResponse } = require('./copilot/knowledge');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.EXTENSION_GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_EXTENSION_ID = process.env.ALLOWED_EXTENSION_ID;
const GEMINI_MODEL = 'gemini-3.6-flash';
const LIVE_MODEL = 'gpt-live-1';
// Legacy Chrome extensions use Gemini Live tokens rather than WebRTC offers.
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const LIVE_BACKEND_MODEL = process.env.OPENAI_LIVE_BACKEND_MODEL || 'gpt-6-luna';
const CONVERSATION_HISTORY_MAX_MESSAGES = 200;
const CONVERSATION_CONTEXT_MAX_CHARACTERS = 60_000;
const CONVERSATION_MESSAGE_MAX_CHARACTERS = 8_000;
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true' || process.env.NODE_ENV === 'test';
const JWT_ISSUER = process.env.LIMOVA_JWT_ISSUER;
const JWT_AUDIENCE = process.env.LIMOVA_JWT_AUDIENCE || 'limova-extension';
const JWKS_URL = process.env.LIMOVA_JWKS_URL;
const KNOWLEDGE_API_URL = String(process.env.KNOWLEDGE_API_URL || '').replace(/\/$/, '');
const KNOWLEDGE_SERVICE_TOKEN = process.env.KNOWLEDGE_SERVICE_TOKEN;
const EVALUATION_API_URL = String(process.env.EVALUATION_API_URL || KNOWLEDGE_API_URL || '').replace(/\/$/, '');
const MEMORY_API_URL = String(process.env.MEMORY_API_URL || '').replace(/\/$/, '');
const MEMORY_SERVICE_TOKEN = process.env.MEMORY_SERVICE_TOKEN;
const MEMORY_IDENTITY_SECRET_V1 = process.env.MEMORY_IDENTITY_SECRET_V1;
const MEMORY_READ_ENABLED = process.env.MEMORY_READ !== 'false';
const MEMORY_WRITE_ENABLED = process.env.MEMORY_WRITE !== 'false';
const PROFILE_SYNC_ENABLED = process.env.PROFILE_SYNC !== 'false';
const ADK_TEXT_MODE = String(process.env.ADK_TEXT_MODE || 'off').toLowerCase();
const ADK_CANARY_PERCENT = Math.max(0, Math.min(100, Number(process.env.ADK_CANARY_PERCENT) || 0));
const LIMOVA_API_URL = String(process.env.LIMOVA_API_URL || 'https://api.new.limova.ai').replace(/\/$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const CHARLY_SESSION_SECRET = process.env.CHARLY_SESSION_SECRET;
const OTP_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const ACTIVE_USER_CACHE_MS = 5 * 60_000;
let onboardingTemplateCache = null;
let onboardingTemplateCacheExpiresAt = 0;
const memoryContextCache = new Map();
const PROMPT_BUNDLE = loadPromptBundle(path.join(__dirname, 'prompts'));
const SERVER_PROMPT = PROMPT_BUNDLE.content;

if (!GEMINI_API_KEY) throw new Error('Missing required environment variable: EXTENSION_GEMINI_API_KEY');
if (!ALLOWED_EXTENSION_ID) throw new Error('Missing required environment variable: ALLOWED_EXTENSION_ID');
if (!AUTH_DISABLED && (!JWT_ISSUER || !JWKS_URL)) {
  throw new Error('LIMOVA_JWT_ISSUER and LIMOVA_JWKS_URL are required');
}
if (!AUTH_DISABLED && (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !CHARLY_SESSION_SECRET)) {
  throw new Error('RESEND_API_KEY, RESEND_FROM_EMAIL and CHARLY_SESSION_SECRET are required');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/healthz', (_req, res) => res.json({
  status: 'ok',
  service: 'limova-proxy',
  agentScope: 'extension_onboarding',
  adkTextMode: ADK_TEXT_MODE,
  adkCanaryPercent: ADK_CANARY_PERCENT,
  knowledgeConfigured: Boolean(KNOWLEDGE_API_URL && KNOWLEDGE_SERVICE_TOKEN),
  memoryConfigured: memoryAvailable(),
  promptRevision: PROMPT_BUNDLE.revision
}));

const allowedOrigin = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === allowedOrigin) return callback(null, true);
    return callback(Object.assign(new Error('CORS not allowed'), { status: 403 }));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use(express.json({ limit: '3mb' }));

const assistantLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => crypto.createHash('sha256').update(String(req.auth?.sub || 'anonymous')).digest('hex'),
  message: { error: 'Too many requests. Please wait a moment.' }
});
const eventsLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analytics requests.' }
});
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes. Réessaie dans quelques minutes.' }
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }
});

let josePromise;
let remoteJwks;
const activeUserCache = new Map();

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function technicalErrorCode(error) {
  const rawCode = String(error?.code || '');
  if (/^[A-Z0-9_:-]{1,80}$/i.test(rawCode)) return rawCode;
  const rawName = String(error?.name || '');
  return /^[A-Z][A-Z0-9_]{0,79}$/i.test(rawName) ? rawName : 'unknown';
}

function signToken(payload, purpose) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', CHARLY_SESSION_SECRET || 'test-session-secret')
    .update(`${purpose}.${body}`)
    .digest('base64url');
  return `${body}.${signature}`;
}

function verifySignedToken(token, purpose, expectedType) {
  const [body, signature, extra] = String(token || '').split('.');
  if (!body || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', CHARLY_SESSION_SECRET || 'test-session-secret')
    .update(`${purpose}.${body}`)
    .digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch (_) {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.typ !== expectedType || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function stableUserId(email) {
  return crypto.createHmac('sha256', CHARLY_SESSION_SECRET || 'test-session-secret')
    .update(`limova-user:${email}`)
    .digest('base64url');
}

function stableMemoryUserId(email) {
  if (!MEMORY_IDENTITY_SECRET_V1 || MEMORY_IDENTITY_SECRET_V1.length < 32 || !email) return null;
  return `v1:${crypto.createHmac('sha256', MEMORY_IDENTITY_SECRET_V1)
    .update(`charly-memory:${normalizeEmail(email)}`)
    .digest('base64url')}`;
}

async function checkLimovaAccount(email) {
  const response = await fetch(`${LIMOVA_API_URL}/auth/check-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Limova-Charly/1.0'
    },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(8_000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.data?.exists !== 'boolean') {
    throw new Error(`Limova account verification unavailable (${response.status})`);
  }
  return data.data.exists;
}

async function findActiveUserByEmail(email) {
  if (typeof app.locals.authDependencies?.findActiveUserByEmail === 'function') {
    return app.locals.authDependencies.findActiveUserByEmail(email);
  }
  if (!(await checkLimovaAccount(email))) return null;
  return { id: stableUserId(email), email };
}

async function sendOtpEmail(email, code) {
  if (typeof app.locals.authDependencies?.sendOtpEmail === 'function') {
    return app.locals.authDependencies.sendOtpEmail(email, code);
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Limova-Charly/1.0',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [email],
      subject: 'Ton code de connexion Charly',
      text: `Ton code de connexion Charly est ${code}. Il expire dans 10 minutes.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px"><h1 style="font-size:24px">Connexion à Charly</h1><p>Utilise ce code pour confirmer ton identité :</p><p style="font-size:34px;font-weight:700;letter-spacing:8px">${code}</p><p>Ce code expire dans 10 minutes. Si tu n’es pas à l’origine de cette demande, ignore cet email.</p></div>`
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Resend rejected OTP email (${response.status})`);
}

function issueSessionToken(user) {
  const now = Date.now();
  const memoryUserId = stableMemoryUserId(user.email);
  return signToken({
    typ: 'charly-session',
    sub: String(user.id),
    email: user.email,
    ...(memoryUserId ? { mid: memoryUserId } : {}),
    iat: now,
    exp: now + SESSION_TTL_MS
  }, 'session');
}

function issueOtpChallenge(email, code) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const codeHash = crypto.createHmac('sha256', CHARLY_SESSION_SECRET || 'test-session-secret')
    .update(`otp-code:${nonce}:${email}:${code}`)
    .digest('base64url');
  return signToken({ typ: 'charly-otp', email, nonce, codeHash, exp: Date.now() + OTP_TTL_MS }, 'otp');
}

function verifyOtpChallenge(challenge, submittedCode) {
  const payload = verifySignedToken(challenge, 'otp', 'charly-otp');
  if (!payload || !/^\d{6}$/.test(String(submittedCode || ''))) return null;
  const actual = crypto.createHmac('sha256', CHARLY_SESSION_SECRET || 'test-session-secret')
    .update(`otp-code:${payload.nonce}:${payload.email}:${submittedCode}`)
    .digest();
  const expected = Buffer.from(payload.codeHash, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return payload;
}

function formatConversationHistory(history) {
  if (!Array.isArray(history)) return '';
  const selected = [];
  let usedCharacters = 0;
  for (
    let index = history.length - 1;
    index >= 0 && selected.length < CONVERSATION_HISTORY_MAX_MESSAGES;
    index -= 1
  ) {
    const message = history[index];
    const role = message?.role === 'assistant' ? 'Charly' : 'Utilisateur';
    const content = String(message?.content || '')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, CONVERSATION_MESSAGE_MAX_CHARACTERS)
      .trim();
    if (!content) continue;
    const line = `${role}: ${content}`;
    if (usedCharacters + line.length > CONVERSATION_CONTEXT_MAX_CHARACTERS) break;
    selected.unshift(line);
    usedCharacters += line.length;
  }
  return selected.join('\n');
}

async function fetchPublishedOnboardingTemplate(requestId = crypto.randomUUID()) {
  if (!KNOWLEDGE_API_URL || !KNOWLEDGE_SERVICE_TOKEN) return null;
  if (onboardingTemplateCache && onboardingTemplateCacheExpiresAt > Date.now()) return onboardingTemplateCache;
  try {
    const response = await fetch(`${KNOWLEDGE_API_URL}/api/internal/onboarding/template`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${KNOWLEDGE_SERVICE_TOKEN}`, 'X-Request-Id': requestId },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.steps) || data.steps.length === 0) return null;
    onboardingTemplateCache = data;
    onboardingTemplateCacheExpiresAt = Date.now() + 60_000;
    return data;
  } catch (error) {
    console.error(JSON.stringify({ type: 'onboarding_template_error', requestId, message: error.message }));
    return null;
  }
}

function formatOnboardingTemplate(template) {
  if (!template) return null;
  const outline = template.steps.map((step, index) => {
    const indent = '  '.repeat(Math.max(0, Math.min(2, Number(step.depth) || 0)));
    return `${indent}${index + 1}. ${String(step.name || 'Étape')} — à proposer ${String(step.trigger || 'si pertinent')}${step.optional ? ' (optionnelle)' : ''}\n${indent}   ${String(step.description || '').slice(0, 3_000)}`;
  }).join('\n');
  return `TRAME D’ONBOARDING PUBLIÉE — ${String(template.name || 'Charly')} (${String(template.revision || 'révision active')})\nCette trame est un réservoir de parcours et de critères, jamais une checklist. Utilise uniquement les étapes qui servent les besoins découverts. Si une consigne est générique, adapte-la au métier, aux outils et au résultat attendu du membre. Il peut rediriger la conversation à tout moment. Les lignes indentées sont des branches conditionnelles. Pose une seule question par tour.\nPremière approche : ${String(template.openingPrompt || '')}\nSi le membre n’a pas d’idée : ${String(template.fallbackPrompt || '')}\n\nOrdre et branches :\n${outline}`;
}

async function verifyLegacyLimovaJwt(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match || !JWT_ISSUER || !JWKS_URL) return null;
  josePromise ||= import('jose');
  const { createRemoteJWKSet, customFetch, jwtVerify } = await josePromise;
  remoteJwks ||= createRemoteJWKSet(new URL(JWKS_URL), {
    [customFetch]: async (url, options) => {
      const response = await fetch(url, options);
      if (response.status !== 200) return response;
      const payload = await response.json();
      const jwks = Array.isArray(payload?.keys) ? payload : payload?.data;
      return new Response(JSON.stringify(jwks), {
        status: response.status,
        headers: response.headers
      });
    }
  });
  const verified = await jwtVerify(match[1], remoteJwks, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['RS256', 'ES256']
  });
  return verified.payload?.sub ? verified.payload : null;
}

async function verifyAssistantAuth(req, res, next) {
  if (AUTH_DISABLED) {
    req.auth = { sub: 'development-user', memoryUserKey: stableMemoryUserId('development@limova.ai') };
    return next();
  }
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'Authentication required' });
    const charlySession = verifySignedToken(match[1], 'session', 'charly-session');
    if (charlySession?.sub) {
      const cached = activeUserCache.get(charlySession.sub);
      if (!cached || cached.expiresAt <= Date.now()) {
        const email = normalizeEmail(charlySession.email);
        const activeUser = email ? await findActiveUserByEmail(email) : null;
        if (!activeUser || activeUser.id !== charlySession.sub) {
          return res.status(401).json({ error: 'Account unavailable' });
        }
        activeUserCache.set(charlySession.sub, { expiresAt: Date.now() + ACTIVE_USER_CACHE_MS });
      }
      req.auth = {
        sub: charlySession.sub,
        provider: 'charly-otp',
        memoryUserKey: stableMemoryUserId(charlySession.email)
      };
      return next();
    }

    // Transitional compatibility: keep the already-published extension working
    // while Chrome Web Store users migrate to Charly OTP sessions.
    const legacyPayload = await verifyLegacyLimovaJwt(req);
    if (!legacyPayload?.sub) return res.status(401).json({ error: 'Invalid or expired token' });
    req.auth = { ...legacyPayload, provider: 'limova-legacy' };
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/request-otp', otpRequestLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Adresse email invalide.' });
  const requestId = crypto.randomUUID();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    const user = await findActiveUserByEmail(email);
    // Always return a challenge so the response does not disclose whether an
    // address exists in Limova. A fake challenge can never create a session.
    const challenge = issueOtpChallenge(email, user ? code : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'));
    if (user) await sendOtpEmail(email, code);
    console.info(JSON.stringify({ type: 'otp_requested', requestId, eligible: Boolean(user) }));
    return res.json({ ok: true, challenge, expiresIn: Math.floor(OTP_TTL_MS / 1000) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'otp_request_error', requestId, message: error.message }));
    return res.status(503).json({ error: 'Connexion temporairement indisponible. Réessaie.' });
  }
});

app.post('/api/auth/verify-otp', otpVerifyLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const payload = verifyOtpChallenge(req.body?.challenge, String(req.body?.code || '').trim());
  if (!payload) return res.status(401).json({ error: 'Code incorrect ou expiré.' });
  try {
    const user = await findActiveUserByEmail(payload.email);
    if (!user?.id) return res.status(401).json({ error: 'Code incorrect ou expiré.' });
    const token = issueSessionToken(user);
    activeUserCache.set(String(user.id), { expiresAt: Date.now() + ACTIVE_USER_CACHE_MS });
    console.info(JSON.stringify({ type: 'otp_verified', userId: String(user.id) }));
    return res.json({ ok: true, token, expiresIn: Math.floor(SESSION_TTL_MS / 1000) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'otp_verify_error', message: error.message }));
    return res.status(503).json({ error: 'Connexion temporairement indisponible. Réessaie.' });
  }
});

app.get('/api/auth/session', verifyAssistantAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ authenticated: true, userId: req.auth.sub, provider: req.auth.provider });
});

function memoryAvailable() {
  return Boolean(MEMORY_API_URL && MEMORY_SERVICE_TOKEN && MEMORY_SERVICE_TOKEN.length >= 32);
}

async function memoryServiceRequest(path, { method = 'POST', body, requestId = crypto.randomUUID(), timeoutMs = 10_000 } = {}) {
  if (!memoryAvailable()) return null;
  const response = await fetch(`${MEMORY_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MEMORY_SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({ error: 'invalid_memory_response' }));
  return { response, data, requestId };
}

async function searchKnowledgeForAdk(input) {
  if (!KNOWLEDGE_API_URL || !KNOWLEDGE_SERVICE_TOKEN) return { revision: null, results: [], unavailable: true };
  const requestId = crypto.randomUUID();
  const response = await fetch(`${KNOWLEDGE_API_URL}/api/internal/knowledge/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KNOWLEDGE_SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId
    },
    body: JSON.stringify({
      query: input.query,
      path: input.path || '/',
      locale: input.locale || 'fr-FR',
      contentTypes: ['article', 'onboarding'],
      scope: 'extension',
      limit: 5
    }),
    signal: AbortSignal.timeout(8_000)
  });
  const data = await response.json().catch(() => ({ revision: null, results: [] }));
  if (!response.ok) return { revision: null, results: [], unavailable: true };
  return sanitizeKnowledgeResponse(data);
}

async function evaluationContextFor(code) {
  if (!EVALUATION_API_URL || !code) return null;
  const response = await fetch(`${EVALUATION_API_URL}/api/evaluations/runs/connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ extensionVersion: 'proxy-verified' }),
    signal: AbortSignal.timeout(8_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.run?.id || !data?.content?.versionId) return null;
  const context = JSON.stringify({
    runId: data.run.id,
    scenario: {
      kind: data.case?.kind,
      title: data.case?.title,
      prompt: data.case?.prompt,
      expectation: data.case?.expectation
    },
    draft: {
      title: data.content.title,
      summary: data.content.summary,
      bodyMarkdown: String(data.content.bodyMarkdown || '').slice(0, 45_000),
      metadata: data.content.metadata
    }
  }).slice(0, 70_000);
  return { runId: data.run.id, context };
}

const adkOrchestrator = new CharlyAdkOrchestrator({
  apiKey: GEMINI_API_KEY,
  modelName: GEMINI_MODEL,
  promptBundle: PROMPT_BUNDLE,
  memoryRequest: memoryServiceRequest,
  searchKnowledge: searchKnowledgeForAdk,
  mode: ADK_TEXT_MODE,
  canaryPercent: ADK_CANARY_PERCENT
});
app.locals.adkOrchestrator = adkOrchestrator;

async function getMemoryContext(userKey, query, requestId, sessionId) {
  if (!MEMORY_READ_ENABLED || !userKey || !memoryAvailable()) return null;
  const cacheKey = `${userKey}:${sessionId || 'active'}:${crypto.createHash('sha256').update(String(query || '')).digest('base64url').slice(0, 12)}`;
  const cached = memoryContextCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.data;
  try {
    const result = await memoryServiceRequest('/api/internal/memory/bootstrap', {
      body: { userKey, query: String(query || '').slice(0, 2_000), ...(sessionId ? { sessionId } : {}) }, requestId
    });
    if (!result?.response.ok) return null;
    memoryContextCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: result.data });
    return result.data;
  } catch (error) {
    console.error(JSON.stringify({ type: 'memory_context_error', requestId, code: error?.name || 'unknown' }));
    return null;
  }
}

function invalidateMemoryContext(userKey) {
  for (const key of memoryContextCache.keys()) if (key.startsWith(`${userKey}:`)) memoryContextCache.delete(key);
}

function cleanMemoryTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const user = String(raw.user || '').trim().slice(0, 8_000);
  const source = raw.source === 'voice' ? 'voice' : 'text';
  const idempotencyKey = String(raw.idempotencyKey || '').trim().slice(0, 180);
  if (!user || idempotencyKey.length < 8) return null;
  return { user, source, idempotencyKey };
}

async function persistMemoryTurn(userKey, turn, assistant, requestId) {
  if (!MEMORY_WRITE_ENABLED || !userKey || !turn || !memoryAvailable()) return;
  try {
    const result = await memoryServiceRequest('/api/internal/memory/turns', {
      body: { userKey, user: turn.user, assistant: String(assistant || '').slice(0, 8_000), source: turn.source, idempotencyKey: turn.idempotencyKey },
      requestId,
      timeoutMs: 12_000
    });
    if (result?.response.ok) invalidateMemoryContext(userKey);
    else console.error(JSON.stringify({ type: 'memory_write_error', requestId, status: result?.response.status || 0 }));
  } catch (error) {
    console.error(JSON.stringify({ type: 'memory_write_error', requestId, code: error?.name || 'unknown' }));
  }
}

function memoryPrompt(context) {
  if (!context?.enabled || !context.context) return '';
  return `CONTEXTE PERSONNEL PRIVÉ — ne le cite jamais comme une base de données et ne prétends jamais te souvenir d’un fait absent. Utilise le prénom avec parcimonie. Si un souvenir semble incertain ou contradictoire, demande une clarification.\n\n${String(context.context).slice(0, 18_000)}`;
}

function responseText(data) {
  return data?.candidates?.[0]?.content?.parts?.map(part => typeof part?.text === 'string' ? part.text : '').join('') || '';
}

function validateGeminiPayload(body) {
  if (!body || !Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > 201) {
    return 'Invalid conversation payload';
  }
  const serialized = JSON.stringify(body);
  if (serialized.length > 2_200_000) return 'Conversation payload too large';
  for (let contentIndex = 0; contentIndex < body.contents.length; contentIndex += 1) {
    const item = body.contents[contentIndex];
    if (!['user', 'model'].includes(item?.role || 'user') || !Array.isArray(item?.parts) || item.parts.length === 0) {
      return 'Invalid conversation message';
    }
    let imageCount = 0;
    for (const part of item.parts) {
      const textPart = typeof part?.text === 'string' && Object.keys(part).every(key => key === 'text');
      const image = part?.inlineData;
      const imagePart = image
        && Object.keys(part).every(key => key === 'inlineData')
        && Object.keys(image).every(key => ['mimeType', 'data'].includes(key))
        && ['image/jpeg', 'image/png'].includes(image.mimeType)
        && typeof image.data === 'string'
        && image.data.length > 0
        && image.data.length <= 1_500_000
        && /^[A-Za-z0-9+/=]+$/.test(image.data);
      if (textPart) continue;
      if (!imagePart || contentIndex !== body.contents.length - 1 || item.role !== 'user') {
        return 'Invalid conversation message';
      }
      imageCount += 1;
      if (imageCount > 1) return 'Invalid conversation message';
    }
  }
  if (!Array.isArray(body.systemInstruction?.parts)
    || body.systemInstruction.parts.some(part => typeof part?.text !== 'string' || Object.keys(part).some(key => key !== 'text'))
    || JSON.stringify(body.systemInstruction).length > 80_000) {
    return 'Invalid system instruction';
  }
  return null;
}

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'limova-proxy' }));

app.get('/api/copilot/bootstrap', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const requestId = crypto.randomUUID();
  const serverOrchestration = Boolean(req.auth.memoryUserKey && memoryAvailable() && app.locals.adkOrchestrator.serverOrchestrationFor(req.auth.memoryUserKey));
  if (!req.auth.memoryUserKey || !memoryAvailable()) {
    return res.json({
      enabled: false,
      available: false,
      serverOrchestration: false,
      sessionId: null,
      sessionRevision: null,
      promptRevision: PROMPT_BUNDLE.revision,
      recentMessages: [],
      goals: [],
      greeting: null
    });
  }
  try {
    const result = await memoryServiceRequest('/api/internal/memory/bootstrap', {
      body: { userKey: req.auth.memoryUserKey, query: String(req.query?.query || '').slice(0, 2_000) }, requestId
    });
    if (!result?.response.ok) return res.status(result?.response.status || 503).json({ error: 'Memory unavailable', requestId });
    const data = result.data || {};
    return res.json({
      enabled: data.enabled === true,
      available: true,
      serverOrchestration,
      sessionId: data.sessionId || null,
      sessionRevision: data.sessionRevision || data.revision || null,
      promptRevision: PROMPT_BUNDLE.revision,
      revision: data.revision || null,
      profile: data.profile || null,
      recentMessages: Array.isArray(data.recentMessages) ? data.recentMessages.slice(-24) : [],
      goals: Array.isArray(data.goals) ? data.goals.slice(0, 5) : [],
      greeting: typeof data.greeting === 'string' ? data.greeting : null
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'memory_bootstrap_proxy_error', requestId, code: error?.name || 'unknown' }));
    return res.status(503).json({ error: 'Memory unavailable', requestId });
  }
});

app.post('/api/copilot/v2/sessions', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const parsed = sessionSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid session payload' });
  if (!req.auth.memoryUserKey || !memoryAvailable()) return res.status(503).json({ error: 'Session service unavailable' });
  const requestId = crypto.randomUUID();
  try {
    const session = await app.locals.adkOrchestrator.openSession(req.auth.memoryUserKey, parsed.data);
    invalidateMemoryContext(req.auth.memoryUserKey);
    res.set('X-Request-Id', requestId);
    return res.json({
      sessionId: session.id,
      sessionRevision: `session_${session.id}_${session.sessionRevision || 1}`,
      promptRevision: PROMPT_BUNDLE.revision
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'adk_session_error', requestId, code: technicalErrorCode(error) }));
    return res.status(503).json({ error: 'Session service unavailable', requestId });
  }
});

app.post('/api/copilot/v2/turn', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid copilot turn' });
  if (!req.auth.memoryUserKey || !memoryAvailable()) return res.status(503).json({ error: 'Server orchestration unavailable' });
  if (!app.locals.adkOrchestrator.serverOrchestrationFor(req.auth.memoryUserKey)) {
    return res.status(409).json({ error: 'Server orchestration disabled' });
  }
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const evaluationContext = parsed.data.evaluationCode ? await evaluationContextFor(parsed.data.evaluationCode) : null;
    if (parsed.data.evaluationCode && !evaluationContext) return res.status(410).json({ error: 'Evaluation expired', requestId });
    const input = { ...parsed.data, ...(evaluationContext ? { evaluationContext } : {}) };
    delete input.evaluationCode;
    const response = await app.locals.adkOrchestrator.turn(req.auth.memoryUserKey, input, requestId);
    invalidateMemoryContext(req.auth.memoryUserKey);
    console.info(JSON.stringify({
      type: 'adk_turn', requestId, responseType: response.type, promptRevision: PROMPT_BUNDLE.revision,
      latencyMs: Date.now() - startedAt
    }));
    res.set('X-Request-Id', requestId);
    return res.json(response);
  } catch (error) {
    console.error(JSON.stringify({ type: 'adk_turn_error', requestId, code: technicalErrorCode(error), latencyMs: Date.now() - startedAt }));
    return res.status(Number(error?.status) || 502).json({ error: 'AI orchestration unavailable', requestId });
  }
});

app.post('/api/copilot/v2/runs/:runId/result', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const parsed = toolResultSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.callId.length < 1) return res.status(400).json({ error: 'Invalid tool result' });
  if (!req.auth.memoryUserKey || !memoryAvailable()) return res.status(503).json({ error: 'Server orchestration unavailable' });
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const response = await app.locals.adkOrchestrator.resume(req.auth.memoryUserKey, req.params.runId, parsed.data, requestId);
    invalidateMemoryContext(req.auth.memoryUserKey);
    console.info(JSON.stringify({
      type: 'adk_run_result', requestId, runId: req.params.runId, responseType: response.type,
      latencyMs: Date.now() - startedAt
    }));
    res.set('X-Request-Id', requestId);
    return res.json(response);
  } catch (error) {
    const status = Number(error?.status) || 502;
    console.error(JSON.stringify({ type: 'adk_run_error', requestId, runId: req.params.runId, code: technicalErrorCode(error) }));
    return res.status(status).json({ error: status === 410 ? 'Run expired' : 'Run unavailable', requestId });
  }
});

app.post('/api/copilot/profile', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  if (!PROFILE_SYNC_ENABLED || !req.auth.memoryUserKey) return res.status(503).json({ error: 'Profile sync unavailable' });
  const raw = req.body?.profile || {};
  const safeString = (value, max) => typeof value === 'string' ? value.replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : undefined;
  const rawId = safeString(raw.limovaUserId || raw.id, 200);
  const profile = {
    ...(safeString(raw.firstName, 80) ? { firstName: safeString(raw.firstName, 80) } : {}),
    ...(safeString(raw.lastName, 100) ? { lastName: safeString(raw.lastName, 100) } : {}),
    ...(rawId ? { limovaUserId: crypto.createHmac('sha256', MEMORY_IDENTITY_SECRET_V1).update(`limova-profile:${rawId}`).digest('base64url') } : {}),
    ...(/^[a-z]{2}(?:-[A-Z]{2})?$/.test(String(raw.locale || '')) ? { locale: raw.locale } : {}),
    ...(safeString(raw.timezone, 80) ? { timezone: safeString(raw.timezone, 80) } : {})
  };
  if (!Object.keys(profile).length) return res.status(400).json({ error: 'Invalid profile' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/profile', { body: { userKey: req.auth.memoryUserKey, profile } });
    if (result?.response.ok) invalidateMemoryContext(req.auth.memoryUserKey);
    return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.post('/api/copilot/preferences/memory', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  if (!req.auth.memoryUserKey || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid preference' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/preferences', { body: { userKey: req.auth.memoryUserKey, enabled: req.body.enabled } });
    if (result?.response.ok) invalidateMemoryContext(req.auth.memoryUserKey);
    return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.post('/api/copilot/forget', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 1_000);
  if (!req.auth.memoryUserKey || query.length < 3) return res.status(400).json({ error: 'Invalid forget request' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/forget', { body: { userKey: req.auth.memoryUserKey, query } });
    if (result?.response.ok) invalidateMemoryContext(req.auth.memoryUserKey);
    return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.get('/api/copilot/export', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  if (!req.auth.memoryUserKey) return res.status(503).json({ error: 'Memory unavailable' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/export', { body: { userKey: req.auth.memoryUserKey }, timeoutMs: 15_000 });
    if (!result?.response.ok) return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
    res.set('Content-Disposition', `attachment; filename="charly-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.set('Cache-Control', 'private, no-store');
    return res.json(result.data);
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.delete('/api/copilot/data', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  if (!req.auth.memoryUserKey) return res.status(503).json({ error: 'Memory unavailable' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/data', { method: 'DELETE', body: { userKey: req.auth.memoryUserKey }, timeoutMs: 15_000 });
    if (result?.response.ok) invalidateMemoryContext(req.auth.memoryUserKey);
    return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.post('/api/copilot/voice-turn', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  if (!req.auth.memoryUserKey) return res.json({ ok: true, stored: 0, available: false });
  const role = req.body?.role === 'assistant' ? 'assistant' : 'user';
  const text = String(req.body?.text || '').trim().slice(0, 8_000);
  const idempotencyKey = String(req.body?.idempotencyKey || '').trim().slice(0, 180);
  const sessionId = typeof req.body?.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(req.body.sessionId) ? req.body.sessionId : undefined;
  if (!text || idempotencyKey.length < 8) return res.status(400).json({ error: 'Invalid voice turn' });
  try {
    const result = await memoryServiceRequest('/api/internal/memory/turns', {
      body: { userKey: req.auth.memoryUserKey, ...(role === 'user' ? { user: text } : { assistant: text }), source: 'voice', idempotencyKey, ...(sessionId ? { sessionId } : {}) }, timeoutMs: 12_000
    });
    if (result?.response.ok) invalidateMemoryContext(req.auth.memoryUserKey);
    return res.status(result?.response.status || 503).json(result?.data || { error: 'Memory unavailable' });
  } catch {
    return res.status(503).json({ error: 'Memory unavailable' });
  }
});

app.post('/api/knowledge/search', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const requestId = crypto.randomUUID();
  if (!KNOWLEDGE_API_URL || !KNOWLEDGE_SERVICE_TOKEN) {
    return res.status(503).json({ error: 'Knowledge service unavailable', requestId });
  }
  const query = String(req.body?.query || '').trim();
  const path = String(req.body?.path || '').trim();
  const locale = ['fr-FR', 'en-US', 'es-ES'].includes(req.body?.locale) ? req.body.locale : 'fr-FR';
  const contentTypes = Array.isArray(req.body?.contentTypes)
    ? req.body.contentTypes.filter(type => ['article', 'onboarding'].includes(type)).slice(0, 2)
    : ['article', 'onboarding'];
  const limit = Math.max(1, Math.min(10, Number(req.body?.limit) || 5));
  if (query.length < 2 || query.length > 2_000 || path.length > 1_000 || contentTypes.length === 0) {
    return res.status(400).json({ error: 'Invalid knowledge search payload', requestId });
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${KNOWLEDGE_API_URL}/api/internal/knowledge/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KNOWLEDGE_SERVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify({ query, path, locale, contentTypes, limit }),
      signal: AbortSignal.timeout(8_000)
    });
    const data = await response.json().catch(() => ({ error: 'Invalid knowledge response' }));
    if (response.ok && data?.revision === 'kb_empty' && Array.isArray(data?.results) && data.results.length === 0) {
      // Installed extension versions still contain the historical embedded
      // fallback. Return an explicit empty-state result so those clients do
      // not silently resurrect deleted knowledge while the new base is rebuilt.
      data.results = [{
        id: 'kb_empty',
        title: 'Base de connaissances en reconstruction',
        content: 'Aucun contenu produit n’est actuellement validé. Réponds uniquement à partir de la page visible et demande une clarification si nécessaire.',
        score: 1,
        source: 'studio/empty',
        verifiedAt: null
      }];
    }
    console.info(JSON.stringify({ type: 'knowledge_search', requestId, status: response.status, revision: data?.revision || null, articleIds: Array.isArray(data?.results) ? data.results.map(result => result.id) : [], latencyMs: Date.now() - startedAt }));
    res.set('X-Request-Id', requestId);
    return res.status(response.status).json(data);
  } catch (error) {
    console.error(JSON.stringify({ type: 'knowledge_error', requestId, message: error.message, latencyMs: Date.now() - startedAt }));
    return res.status(503).json({ error: 'Knowledge service unavailable', requestId });
  }
});

app.get('/api/onboarding/template', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  const requestId = crypto.randomUUID();
  const template = await fetchPublishedOnboardingTemplate(requestId);
  res.set('X-Request-Id', requestId);
  if (!template) return res.status(503).json({ error: 'Onboarding template unavailable', requestId });
  console.info(JSON.stringify({ type: 'onboarding_template', requestId, revision: template.revision || null, stepCount: template.steps.length }));
  return res.json(template);
});

async function handleCopilotTurn(req, res) {
  const validationError = validateGeminiPayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const requestId = crypto.randomUUID();
  const turn = cleanMemoryTurn(req.body.memoryTurn);
  try {
    const personalContext = req.body.resetContext === true
      ? null
      : await getMemoryContext(req.auth.memoryUserKey, turn?.user || '', requestId);
    const promptParts = [
      { text: SERVER_PROMPT },
      ...(Array.isArray(req.body.systemInstruction?.parts) ? req.body.systemInstruction.parts : []),
      ...(memoryPrompt(personalContext) ? [{ text: memoryPrompt(personalContext) }] : [])
    ];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify({
        systemInstruction: { parts: promptParts },
        contents: req.body.contents,
        generationConfig: { temperature: 0.35, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(45_000)
    });
    const data = await response.json().catch(() => ({ error: { message: 'Invalid upstream response' } }));
    res.set('X-Request-Id', requestId);
    // Persist the raw turn before acknowledging the response. Derived memories
    // may still be enriched asynchronously, but an immediate new chat can
    // already recover the exact recent message from durable storage.
    if (response.ok && turn) await persistMemoryTurn(req.auth.memoryUserKey, turn, responseText(data), requestId);
    if (response.ok && turn && ADK_TEXT_MODE === 'shadow' && req.auth.memoryUserKey) {
      const shadowPageContext = Array.isArray(req.body.systemInstruction?.parts)
        ? req.body.systemInstruction.parts.map(part => String(part?.text || '')).join('\n').slice(0, 80_000)
        : '';
      setImmediate(() => app.locals.adkOrchestrator.shadow(req.auth.memoryUserKey, {
        message: turn.user,
        pageContext: shadowPageContext,
        locale: 'fr-FR',
        legacyResponse: responseText(data)
      }, requestId));
    }
    return res.status(response.status).json(data);
  } catch (error) {
    console.error(JSON.stringify({ type: 'proxy_error', requestId, message: error.message }));
    return res.status(502).json({ error: 'AI service unavailable', requestId });
  }
}

app.post('/api/gemini', verifyAssistantAuth, assistantLimiter, handleCopilotTurn);
app.post('/api/copilot/turn', verifyAssistantAuth, assistantLimiter, handleCopilotTurn);

function openAiLiveTools(evaluationMode) {
  const tool = (name, description, properties = {}, required = []) => ({
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false
    }
  });
  const elementId = { type: 'integer', description: 'Identifiant numérique visible dans la carte DOM courante.' };
  const contextVersion = { type: 'integer', description: 'Version exacte de la carte DOM courante.' };
  const targetLabel = { type: 'string', description: 'Libellé accessible exact de la cible.' };
  return [
    tool('click_element', 'Clique un élément sûr et visible de la carte DOM courante. N’annonce jamais la réussite avant le résultat vérifié.', {
      elementId, contextVersion, targetLabel,
      explicitRequest: { type: 'boolean', description: 'Vrai uniquement si le tour utilisateur demande explicitement cette action.' }
    }, ['elementId', 'contextVersion', 'targetLabel', 'explicitRequest']),
    tool('inspect_current_page', 'Relit immédiatement la page Limova et renvoie son état DOM actuel. À utiliser avant une action et après tout changement possible.'),
    tool('capture_current_view', 'Prend une capture temporaire masquée pour lever une ambiguïté visuelle.', {
      reason: { type: 'string' }
    }, ['reason']),
    ...(!evaluationMode ? [tool('search_knowledge_base', 'Recherche la documentation Limova pertinente.', {
      query: { type: 'string' }
    }, ['query'])] : []),
    tool('scroll_page', 'Fait défiler la page, puis impose une nouvelle inspection avant toute action.', {
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      amount: { type: 'string', enum: ['small', 'medium', 'large'] },
      contextVersion,
      elementId
    }, ['direction', 'amount', 'contextVersion']),
    tool('fill_field', 'Saisit le texte exact dans un champ non sensible sans soumettre le formulaire.', {
      elementId, contextVersion, targetLabel,
      text: { type: 'string', maxLength: 4000 }
    }, ['elementId', 'contextVersion', 'targetLabel', 'text']),
    tool('navigate_internal', 'Navigue dans Limova en activant un élément DOM courant, jamais une URL arbitraire.', {
      elementId, contextVersion, targetLabel
    }, ['elementId', 'contextVersion', 'targetLabel']),
    tool('verify_expected_result', 'Relit la page après une action et vérifie le résultat attendu avant toute confirmation orale.', {
      expectation: { type: 'string' },
      contextVersion
    }, ['expectation', 'contextVersion'])
  ];
}

app.post('/api/live-token', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const requestId = crypto.randomUUID();
  const lang = ['fr', 'en', 'es'].includes(req.body?.lang) ? req.body.lang : 'fr';
  const trainingMode = req.body?.trainingMode === true;
  const evaluationCode = typeof req.body?.evaluationCode === 'string' ? req.body.evaluationCode.trim() : '';
  const evaluationContext = evaluationCode ? await evaluationContextFor(evaluationCode) : null;
  if (evaluationCode && !evaluationContext) return res.status(410).json({ error: 'Evaluation expired', requestId });
  const evaluationMode = Boolean(evaluationContext);
  // Extensions from 2.2.47 follow the user on every site and can open pages;
  // older ones keep the Limova-only wording and tools.
  const capabilities = Array.isArray(req.body?.capabilities) ? req.body.capabilities : [];
  const anySite = capabilities.includes('any_site');
  // From 2.2.48 the extension can send a request to the Limova chat in one step.
  const limovaHandoff = anySite && capabilities.includes('limova_handoff');
  const pageContext = trainingMode ? '' : String(req.body?.pageContext || '').slice(0, 12_000);
  const history = trainingMode || evaluationMode ? '' : formatConversationHistory(req.body?.history);
  const onboardingTemplate = trainingMode || evaluationMode ? null : await fetchPublishedOnboardingTemplate(requestId);
  const onboardingTemplateText = formatOnboardingTemplate(onboardingTemplate);
  const lastUserMessage = trainingMode || evaluationMode ? '' : [...(Array.isArray(req.body?.history) ? req.body.history : [])].reverse().find(item => item?.role === 'user')?.content || '';
  const liveSessionId = typeof req.body?.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(req.body.sessionId) ? req.body.sessionId : undefined;
  const personalContext = trainingMode || evaluationMode || req.body?.resetContext === true
    ? null
    : await getMemoryContext(req.auth.memoryUserKey, lastUserMessage, requestId, liveSessionId);
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 2 * 60_000).toISOString();
  const languageInstruction = lang === 'fr'
    ? 'Parle exclusivement en français de France, avec un accent français métropolitain neutre. N’utilise jamais d’accent québécois ou canadien et ne change jamais de langue, même si la reconnaissance audio hésite. Si un passage est incompréhensible, demande simplement à l’utilisateur de répéter.'
    : lang === 'es'
      ? 'Habla exclusivamente en español neutro. No cambies nunca de idioma. Si un fragmento no se entiende, pide al usuario que lo repita.'
      : 'Speak exclusively in neutral English. Never switch languages. If speech is unclear, ask the user to repeat it.';
  const assistantSystemText = [
    SERVER_PROMPT,
    `Tu es Charly, l'assistante dédiée à l'onboarding Limova. Tu accompagnes l'utilisateur sur toute la plateforme, réponds à ses questions produit, l'aides à trouver la bonne page et peux y agir avec les outils autorisés. Réponds avec précision et concision. ${languageInstruction}`,
    evaluationMode
      ? ''
      : onboardingTemplateText || 'Trame de secours : pour démarrer, vérifie si l’utilisateur a déjà exprimé un objectif précis. Si oui, aide-le directement. Sinon, demande uniquement : « Est-ce qu’il y a un sujet en particulier que tu veux traiter aujourd’hui ? ». S’il n’a pas d’idée, propose la prospection LinkedIn ou la création de posts pour réseaux sociaux, puis adapte la suite à son métier. Pose une seule question par tour.',
    anySite ? 'L’utilisateur peut travailler sur Limova ou sur n’importe quel autre site : la carte DOM la plus récente (URL et titre) indique toujours la page réellement affichée, et l’extension t’envoie une nouvelle carte dès qu’il change d’onglet ou de site. Ne réponds jamais à partir d’une page précédente. Sur un autre site, la section « contenu à l’écran » donne le texte que l’utilisateur lit. Pour aller sur un site ou une adresse qu’il nomme, appelle open_page avec l’adresse (par exemple lemonde.fr) ; pour suivre un lien visible, utilise son identifiant dans la carte DOM.' : '',
    anySite ? [
      'HORS DE LIMOVA. Sur un autre site, tu es une copilote de lecture : tu lis, résumes, expliques et réponds à partir du « contenu à l’écran » et de la « suite de la page », sans quitter la page. Tu n’y cliques que sur demande explicite (suivre un lien, ouvrir un onglet, défiler).',
      limovaHandoff
        ? 'Dès que l’utilisateur veut produire quelque chose à partir de ce qu’il regarde — post LinkedIn ou réseaux sociaux, e-mail, article, résumé à garder, script, visuel, analyse détaillée — annonce en une phrase que tu le prépares dans Limova, puis appelle create_in_limova avec sa demande reformulée en une consigne claire (format, ton, longueur, public si précisés). L’extension lit la page, ouvre Limova dans un nouvel onglet, écrit et envoie la demande pour toi : n’ouvre jamais Limova toi-même et n’essaie jamais de l’atteindre en cliquant sur un lien de la page.'
        : 'Dès que l’utilisateur veut produire quelque chose à partir de ce qu’il regarde (post, e-mail, article, visuel), résume d’abord l’essentiel de la page à voix haute, puis appelle open_page avec new.limova.ai et suis la règle CHAT LIMOVA pour y écrire une seule demande qui reprend ce résumé. N’essaie jamais d’atteindre Limova en cliquant sur un lien de la page.',
      'Choix de l’outil : lien ou bouton visible sur la page → son identifiant DOM ; site ou adresse nommé → open_page ;' + (limovaHandoff ? ' création de contenu → create_in_limova ;' : '') + ' n’utilise jamais open_page pour revenir sur une page Limova que l’utilisateur a déjà ouverte.'
    ].join(' ') : '',
    'CHAT LIMOVA. Pour écrire dans le chat de Limova, la seule cible est la zone de rédaction du chat (libellée par exemple « Écrire un message… », en bas de la conversation ou au centre d’un nouveau chat) : jamais un champ de recherche, de filtre ou de titre. Saisis le message en une fois, puis clique « Envoyer le message » une seule fois. Dès que l’envoi a réussi (nouvelle conversation, champ vidé ou message affiché), ne retape jamais ce message et ne le renvoie pas : relis la page et annonce que Limova prépare la réponse. Si la zone de rédaction disparaît après un clic, la conversation est probablement en cours de création : relis la page avant toute nouvelle saisie.',
    `Tu peux inspecter et piloter ${anySite ? 'la page affichée' : 'la page Limova'} grâce à une carte DOM structurée : URL, titres, éléments visibles et cliquables avec identifiants, états, modales, erreurs et métadonnées réseau récentes filtrées. Tu peux aussi recevoir une capture visuelle temporaire de la zone visible : les pastilles #N sont des repères strictement internes ; elles servent uniquement à retrouver une cible et ne doivent jamais être prononcées ni mentionnées à l’utilisateur. Les valeurs de formulaires sont masquées. Utilise l’image pour comprendre la disposition et les contrôles graphiques, jamais pour deviner une valeur ou cliquer par coordonnées. Toute action doit utiliser un identifiant de la carte DOM actuelle ; ne dis jamais que tu ne vois pas l’écran ou que tu ne peux pas naviguer.`,
    'Appelle inspect_current_page avant de répondre à toute question sur ce qui est affiché, après une navigation ou dès que le contexte peut avoir changé. Utilise exclusivement les identifiants de la carte DOM la plus récente. Une MISE À JOUR TECHNIQUE SILENCIEUSE remplace l’ancien contexte de page : assimile-la sans y répondre seule et considère sa version DOM comme la nouvelle référence. Une source user_click, user_input ou user_scroll signifie que l’utilisateur a déjà agi : ne répète pas son action. Utilise scroll_page pour découvrir les contrôles hors écran, puis inspecte de nouveau la page.',
    evaluationMode
      ? 'Pendant ce test, le brouillon isolé est l’unique source produit. N’appelle pas la base de connaissances publiée.'
      : 'Pour une question sur le fonctionnement de Limova, une procédure, une intégration ou une fonctionnalité qui n’est pas explicitement expliquée dans le DOM, appelle search_knowledge_base. Combine la documentation retournée avec le DOM courant, sans inventer ce qui manque.',
    'Les parcours peuvent contenir des « Empreintes d’action démontrées » : nom accessible, rôle, section, test-id/id stable, destination et résultat attendu. Utilise plusieurs de ces signaux pour retrouver une cible unique dans la carte DOM ACTUELLE, mais n’utilise jamais un ancien identifiant numérique ni un sélecteur brut. Si plusieurs contrôles restent plausibles, relis la page puis demande une clarification au lieu de deviner. Après chaque clic, appelle inspect_current_page et vérifie la route, la modale, les marqueurs visibles et les effets réseau attendus avant de poursuivre.',
    'Si une action est rejetée avec retryWithFreshContext, l’extension a automatiquement repris la carte DOM et une capture visuelle. Réévalue la cible avec ces deux sources et réessaie au maximum une fois. Si elle reste ambiguë ou absente, pose une seule question de clarification concise.',
    'Pour écrire à la place de l’utilisateur, appelle type_text_into_page uniquement si son intention désigne sans ambiguïté un seul champ non sensible et si le texte exact à saisir est connu. Si plusieurs champs conviennent, si la cible est incertaine ou si une valeur manque, n’appelle aucun outil et pose une seule question de clarification concise. N’invente jamais une donnée personnelle. La saisie ne valide et n’envoie jamais le formulaire.',
    'Si l’utilisateur demande explicitement une action sûre sur la page, annonce brièvement l’action avec le libellé visible de la cible, puis appelle request_page_action avec l’ID exact présent dans la carte DOM la plus récente. Exemples : « Je sélectionne l’onglet « Conversation », situé en bas à gauche de l’écran. », « Je sélectionne l’onglet « Super-pouvoirs ». », « J’ouvre Intégrations. », « Je sélectionne l’image du rapport. ». Le libellé doit venir de la carte DOM actuelle ou d’une capture visuelle confirmée ; n’invente jamais le nom de la cible. Ne dis jamais « élément 5 », « #5 », « identifiant DOM », « elementId », « j’appelle un outil » ni aucun autre identifiant ou détail technique. Le numéro est transmis silencieusement à l’outil et ne doit jamais être prononcé. Un lien de navigation interne visible peut être une étape intermédiaire sûre même si son libellé diffère du but final — par exemple « connecter Gmail » commence par « Intégrations » — à condition de nommer cette étape dans ta réponse ; cette exception ne vaut jamais pour un bouton final, un formulaire ou un lien externe. « Fais-le », « vas-y », « go ahead » ou « hazlo » constituent une demande explicite uniquement si ton tour précédent nommait une cible unique encore présente dans la carte DOM ; sinon demande quel contrôle utiliser. Une carte d’intégration libellée « Connecter [nom] » est une cible préparatoire sûre : sélectionne celle dont le nom correspond exactement à la demande. Pour envoyer un message, n’agis que si la carte DOM contient exactement « Envoyer le message » et que l’utilisateur vient de demander explicitement l’envoi, directement ou par cette reprise non ambiguë. Ne remplace jamais cette cible par le micro, la pièce jointe ou un autre bouton ; si elle manque, relis la page puis demande une clarification. L’extension affichera un curseur et cliquera automatiquement : ne demande aucune confirmation et ne parle jamais de notification à valider. Après le résultat de l’outil, continue à partir de la nouvelle carte DOM et confirme brièvement la réussite avec le libellé humain de la cible. En cas d’échec, explique le problème sans révéler l’identifiant interne.',
    evaluationMode ? `MODE TEST DE FLOW ISOLÉ. Exécute un seul parcours continu de bout en bout à partir du brouillon ci-dessous. Ce brouillon remplace la base publiée pour ce test. Comprends l’objectif, demande une précision uniquement si une donnée réellement nécessaire manque, agis avec les outils sur chaque étape, puis appelle verify_expected_result avant d’annoncer la réussite. N’utilise aucune mémoire personnelle et ne transforme rien de ce test en souvenir.\n${evaluationContext.context}` : '',
    pageContext ? `Contexte DOM privé de la page:\n${pageContext}` : '',
    history ? `Conversation récente:\n${history}` : ''
    ,memoryPrompt(personalContext)
  ].filter(Boolean).join('\n\n');
  const systemText = trainingMode
    ? `Mode transcription de démonstration Limova. Écoute et transcris fidèlement les explications du formateur en ${lang === 'fr' ? 'français' : lang === 'es' ? 'espagnol' : 'anglais'}. Tu es strictement passive : ne réponds jamais, ne produis aucun commentaire, ne suggère rien, ne navigue pas et n’appelle aucun outil.`
    : assistantSystemText;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/auth_tokens?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime,
        newSessionExpireTime,
        // AuthToken v1beta uses BidiGenerateContentSetup. The former
        // liveConnectConstraints field is rejected by the provisioning API.
        // Keep sessionResumption outside the mask so the client can supply a
        // fresh handle when reconnecting; all other capabilities stay locked.
        fieldMask: [
          'model',
          'generationConfig.responseModalities',
          'generationConfig.speechConfig',
          'inputAudioTranscription',
          'outputAudioTranscription',
          'realtimeInputConfig',
          'contextWindowCompression',
          'systemInstruction',
          ...(!trainingMode ? ['tools'] : [])
        ].join(','),
        bidiGenerateContentSetup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              prefixPaddingMs: 160,
              silenceDurationMs: 1_100
            },
            activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
            turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
          },
          contextWindowCompression: { slidingWindow: {} },
          systemInstruction: { parts: [{ text: systemText }] },
          ...(!trainingMode ? { tools: [{
            functionDeclarations: [{
              name: 'click_element',
              description: 'Clique un élément sûr et visible identifié dans la carte DOM courante. Pour envoyer, utiliser uniquement l’élément exactement libellé « Envoyer le message » après une demande explicite. Les cibles incohérentes et actions sensibles sont refusées localement.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  elementId: { type: 'INTEGER', description: 'Identifiant numérique visible dans le contexte DOM.' },
                  contextVersion: { type: 'INTEGER', description: 'Version de la carte DOM.' },
                  targetLabel: { type: 'STRING', description: 'Libellé exact de la cible.' },
                  explicitRequest: { type: 'BOOLEAN', description: 'Vrai uniquement si le tour utilisateur demande explicitement cette action.' }
                },
                required: ['elementId', 'contextVersion', 'targetLabel', 'explicitRequest']
              }
            }, {
              name: 'inspect_current_page',
              description: (anySite ? 'Relit immédiatement la page active (Limova ou autre site)' : 'Relit immédiatement la page Limova active') + ' et renvoie sa carte DOM, ses éléments actionnables, ses modales, ses erreurs et ses métadonnées réseau filtrées. À appeler avant toute observation ou après navigation.',
              parameters: {
                type: 'OBJECT',
                properties: {}
              }
            }, {
              name: 'capture_current_view',
              description: 'Prend silencieusement une capture temporaire masquée uniquement pour récupérer après une cible introuvable, ambiguë ou un résultat inattendu.',
              parameters: {
                type: 'OBJECT',
                properties: { reason: { type: 'STRING' } },
                required: ['reason']
              }
            }, ...(!evaluationMode ? [{
              name: 'search_knowledge_base',
              description: 'Recherche la documentation Limova pertinente pour répondre à une question produit, expliquer une fonctionnalité ou guider une procédure.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  query: { type: 'STRING', description: 'Question ou sujet Limova à rechercher dans la documentation.' }
                },
                required: ['query']
              }
            }] : []), {
              name: 'scroll_page',
              description: (anySite ? 'Fait défiler la page active' : 'Fait défiler la vue Limova') + ' ou la zone contenant un élément. Utilise cet outil pour découvrir les contrôles hors écran, puis appelle inspect_current_page avant de cliquer.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  direction: { type: 'STRING', enum: ['up', 'down', 'top', 'bottom'] },
                  amount: { type: 'STRING', enum: ['small', 'medium', 'large'] },
                  contextVersion: { type: 'INTEGER' },
                  elementId: { type: 'INTEGER', description: 'Élément situé dans la zone à faire défiler, facultatif.' }
                },
                required: ['direction', 'amount', 'contextVersion']
              }
            }, {
              name: 'fill_field',
              description: 'Écrit le texte exact demandé dans un unique champ non sensible de la carte DOM. Ne soumet jamais le formulaire. Ne pas appeler si la cible ou le texte est ambigu : demander une clarification.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  elementId: { type: 'INTEGER', description: 'Identifiant numérique du champ non sensible dans la carte DOM la plus récente.' },
                  contextVersion: { type: 'INTEGER', description: 'Version de la carte DOM.' },
                  targetLabel: { type: 'STRING', description: 'Libellé exact du champ visé dans la carte DOM.' },
                  text: { type: 'STRING', description: 'Texte exact explicitement fourni ou validé par l’utilisateur, 4000 caractères maximum.' }
                },
                required: ['elementId', 'contextVersion', 'targetLabel', 'text']
              }
            }, {
              name: 'navigate_internal',
              description: anySite
                ? 'Suit un lien ou un onglet de navigation visible de la page active en activant un identifiant DOM courant, jamais une URL arbitraire.'
                : 'Navigue dans Limova en activant un identifiant DOM courant, jamais une URL arbitraire.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  elementId: { type: 'INTEGER' },
                  contextVersion: { type: 'INTEGER' },
                  targetLabel: { type: 'STRING' }
                },
                required: ['elementId', 'contextVersion', 'targetLabel']
              }
            }, ...(anySite ? [{
              name: 'open_page',
              description: 'Ouvre un site ou une adresse web que l’utilisateur demande (par exemple « va sur lemonde.fr »), attend son chargement et renvoie sa carte DOM. Remplace la page d’un autre site dans l’onglet actif ; depuis Limova, ouvre un nouvel onglet.' + (limovaHandoff ? ' Pour créer un contenu dans Limova, utiliser create_in_limova et non cet outil.' : ''),
              parameters: {
                type: 'OBJECT',
                properties: {
                  url: { type: 'STRING', description: 'Adresse web en http(s) ou nom de domaine, par exemple lemonde.fr.' },
                  newTab: { type: 'BOOLEAN', description: 'Vrai si l’utilisateur demande un nouvel onglet.' }
                },
                required: ['url']
              }
            }] : []), ...(limovaHandoff ? [{
              name: 'create_in_limova',
              description: 'Crée un contenu dans Limova à partir de la page que l’utilisateur regarde sur un autre site : lit la page (texte, titre, adresse, passage sélectionné), ouvre Limova dans un nouvel onglet, écrit la demande accompagnée de ce contenu dans le chat et l’envoie. Renvoie ensuite la carte DOM de la conversation Limova. Une seule fois par demande ; jamais depuis une page Limova.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  request: { type: 'STRING', description: 'Consigne claire pour Limova, en français, 1500 caractères maximum, par exemple « Rédige un post LinkedIn à partir de cet article, ton professionnel, 150 mots ». Ne recopie pas la page : elle est jointe automatiquement.' }
                },
                required: ['request']
              }
            }] : []), {
              name: 'verify_expected_result',
              description: 'Relit la route, la modale et le DOM après une action avant d’annoncer sa réussite.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  expectation: { type: 'STRING' },
                  contextVersion: { type: 'INTEGER' }
                },
                required: ['expectation', 'contextVersion']
              }
            }]
          }] } : {})
        }
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const data = await response.json().catch(() => ({ error: { message: 'Invalid upstream response' } }));
    if (!response.ok) return res.status(response.status).json(data);
    return res.json({ token: data.name, model: GEMINI_LIVE_MODEL, expiresAt: expireTime, requestId });
  } catch (error) {
    console.error(JSON.stringify({ type: 'live_token_error', requestId, message: error.message }));
    return res.status(502).json({ error: 'Voice service unavailable', requestId });
  }
});

app.post('/api/live-session', verifyAssistantAuth, assistantLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const requestId = crypto.randomUUID();
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OpenAI voice is not configured', requestId });
  const rawSdp = typeof req.body?.sdp === 'string' ? req.body.sdp : '';
  const sdp = rawSdp.trimEnd() + '\r\n';
  if (!rawSdp || sdp.length > 100_000 || !sdp.startsWith('v=0') || !sdp.includes('\nm=audio ') || !sdp.includes('\nm=application ')) {
    return res.status(400).json({ error: 'A valid SDP offer is required', requestId });
  }
  const sdpShape = {
    length: sdp.length,
    lines: sdp.split(/\r?\n/).filter(Boolean).length,
    hasAudio: sdp.includes('\nm=audio '),
    hasDataChannel: sdp.includes('\nm=application ')
  };

  const lang = ['fr', 'en', 'es'].includes(req.body?.lang) ? req.body.lang : 'fr';
  const trainingMode = req.body?.trainingMode === true;
  const evaluationCode = typeof req.body?.evaluationCode === 'string' ? req.body.evaluationCode.trim() : '';
  const evaluationContext = evaluationCode ? await evaluationContextFor(evaluationCode) : null;
  if (evaluationCode && !evaluationContext) return res.status(410).json({ error: 'Evaluation expired', requestId });
  const evaluationMode = Boolean(evaluationContext);
  const pageContext = trainingMode ? '' : String(req.body?.pageContext || '').slice(0, 12_000);
  const history = trainingMode || evaluationMode ? '' : formatConversationHistory(req.body?.history);
  const onboardingTemplate = trainingMode || evaluationMode ? null : await fetchPublishedOnboardingTemplate(requestId);
  const onboardingTemplateText = formatOnboardingTemplate(onboardingTemplate);
  const lastUserMessage = trainingMode || evaluationMode ? '' : [...(Array.isArray(req.body?.history) ? req.body.history : [])]
    .reverse().find(item => item?.role === 'user')?.content || '';
  const liveSessionId = typeof req.body?.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(req.body.sessionId)
    ? req.body.sessionId
    : undefined;
  const personalContext = trainingMode || evaluationMode
    ? null
    : await getMemoryContext(req.auth.memoryUserKey, lastUserMessage, requestId, liveSessionId);

  const languageInstruction = lang === 'fr'
    ? 'Parle exclusivement en français de France, avec un accent français métropolitain neutre.'
    : lang === 'es'
      ? 'Habla exclusivamente en español neutro.'
      : 'Speak exclusively in neutral English.';
  const discoveryInstruction = [
    'Avant de conseiller ou d’agir, comprends ce que l’utilisateur cherche réellement à accomplir.',
    'S’il manque du contexte utile, pose une seule question courte à la fois. Priorise dans cet ordre : objectif concret, rôle ou activité, méthode actuelle, résultat attendu, contrainte principale.',
    'Ne redemande jamais une information déjà donnée ou visible. Dès que le but et les contraintes sont suffisants, arrête les questions et guide l’utilisateur.',
    'Reformule brièvement l’objectif avant la première action pour vérifier que tu as bien compris.'
  ].join(' ');
  const adaptiveOnboardingInstruction = [
    'Lors de la toute première interaction, présente-toi en une phrase comme Charly, l’assistante d’onboarding Limova, puis explique en une phrase que tu vas comprendre l’activité du membre pour construire avec lui des usages utiles.',
    'S’il donne déjà un objectif précis, reformule le résultat attendu et avance directement vers celui-ci.',
    'Sinon, demande seulement : « Pour commencer, que faites-vous ? » Puis découvre une information utile à la fois : rôle, organisation, fonctionnement actuel, outils déjà utilisés, tâches répétitives, fréquence, ce qu’il aimerait déléguer et contrainte principale. Demande les outils dans le contexte du processus décrit, jamais sous forme de questionnaire.',
    'Le webinaire Limova est un indice de maturité, jamais un prérequis ni la première question obligatoire. Demande si le membre y a assisté uniquement si cela change la prochaine étape. S’il y a participé, demande une seule chose utile sur ce qu’il a déjà commencé puis vérifie-la dans son environnement. Sinon, explique les notions nécessaires au fil du cas d’usage et continue normalement.',
    'Dès que tu connais l’activité, un objectif ou irritant réel et les outils concernés, arrête les questions. Résume le besoin et propose deux à quatre activations au maximum, uniquement parmi celles qui sont pertinentes : connecter un outil utile, produire un livrable avec un Super Pouvoir, automatiser une tâche répétitive avec un Skill ou une routine, ou déployer un agent Limova autonome pour un travail continu.',
    'Pour une activité B2B, pense à la prospection LinkedIn ; pour un besoin de visibilité, pense à produire un vrai contenu ou une campagne de posts. N’impose jamais ces exemples sans rapport avec le besoin.',
    'Recommande un seul premier résultat rapide, utile et observable et propose de le réaliser maintenant. Après accord, passe à l’action : ouvre le bon espace, aide à connecter l’intégration nécessaire et produis un vrai output au lieu de continuer à expliquer.',
    'Avant de créer, connecter ou reconfigurer quoi que ce soit, inspecte l’existant directement lié à ce résultat : configuration, intégration, Skill, routine, automatisation, agent, utilisateur ou accès pertinent. Pour chaque élément trouvé, décide s’il faut le conserver, le tester, le compléter, le corriger ou le reconfigurer. Préserve ce qui fonctionne, ne recrée rien inutilement et vérifie l’état visible au lieu de te fier uniquement au souvenir du membre.',
    'Configure, teste sur un cas réel, vérifie, demande si le résultat convient et ajuste avant de passer à la suite. Après ce premier résultat, propose un plan personnalisé vers les intégrations, automatisations et agents autonomes pertinents.',
    'La trame publiée est une source de parcours possibles, pas une checklist. Ne présente jamais tout Limova par défaut.'
  ].join(' ');
  const actionInstruction = [
    'Pour toute action DOM : inspecte la page juste avant, utilise uniquement un identifiant de la version courante, puis attends le résultat de l’outil.',
    'Après un clic, relis la page jusqu’à obtenir un état stable et appelle verify_expected_result avant d’annoncer la réussite.',
    'Si la route, une modale ou le DOM ne change pas comme prévu, dis que le résultat n’est pas confirmé et tente au maximum une récupération avec un contexte frais.',
    'Ne meuble pas le temps d’exécution avec une fausse confirmation : dis simplement que tu vérifies.'
  ].join(' ');

  const assistantSystemText = [
    SERVER_PROMPT,
    `Tu es Charly, l'assistante dédiée à l'onboarding Limova. Tu peux comprendre, expliquer et piloter la page avec les outils autorisés. Réponds avec précision et concision. ${languageInstruction}`,
    discoveryInstruction,
    adaptiveOnboardingInstruction,
    actionInstruction,
    evaluationMode ? '' : onboardingTemplateText || 'Si aucun objectif précis n’a été exprimé, commence par demander ce que l’utilisateur veut accomplir aujourd’hui. Pose une seule question par tour.',
    'La carte DOM la plus récente est la seule source fiable pour les éléments visibles. N’invente jamais un contrôle, un état, un identifiant ou le succès d’une action.',
    'Appelle inspect_current_page avant toute observation de l’écran et après une navigation. Une source user_click, user_input ou user_scroll signifie que l’utilisateur a déjà agi : ne répète pas son geste.',
    evaluationMode
      ? 'Pendant ce test, le brouillon isolé est l’unique source produit.'
      : 'Pour les explications produit absentes du DOM, appelle search_knowledge_base.',
    'Une action finale ou sensible exige une demande explicite. Ne saisis jamais de mot de passe, OTP, paiement ou secret. La saisie de texte ne soumet jamais le formulaire.',
    evaluationMode ? `MODE TEST DE FLOW ISOLÉ. Exécute le parcours et vérifie son résultat.\n${evaluationContext.context}` : '',
    pageContext ? `Contexte DOM privé initial :\n${pageContext}` : '',
    history ? `Conversation récente :\n${history}` : '',
    memoryPrompt(personalContext)
  ].filter(Boolean).join('\n\n');

  const instructions = trainingMode
    ? `Mode transcription de démonstration Limova. Transcris fidèlement en ${lang === 'fr' ? 'français' : lang === 'es' ? 'espagnol' : 'anglais'}. Reste silencieuse et n’appelle aucun outil.`
    : [
        `Tu es Charly, l’assistante vocale d’onboarding Limova. ${languageInstruction} Parle naturellement, brièvement et guide une étape à la fois.`,
        discoveryInstruction,
        adaptiveOnboardingInstruction,
        'Backchannel policy: Utilise de rares acquiescements très courts sans interrompre l’utilisateur.',
        'Interruption policy: Arrête de parler dès que l’utilisateur t’interrompt et écoute sa correction.',
        [
          'Delegation policy:',
          'Backend tools:',
          '- Lire l’état DOM actuel de la page Limova et identifier les contrôles visibles.',
          '- Cliquer un élément, naviguer, faire défiler la page et écrire dans un champ non sensible.',
          '- Vérifier le résultat réel d’une action avant de l’annoncer.',
          '- Rechercher la documentation produit Limova.',
          'Delegate to the backend when:',
          '- L’utilisateur demande de regarder, trouver, montrer, ouvrir, cliquer, sélectionner, naviguer, faire défiler, remplir ou écrire quelque chose dans Limova.',
          '- La réponse dépend de l’état actuel de la page, du DOM ou de la documentation produit.',
          '- Une correction modifie une action déjà demandée.',
          '- Tu dois vérifier qu’une action a réellement réussi.',
          'Do not delegate to the backend when:',
          '- L’utilisateur te salue, demande de répéter un résultat déjà obtenu ou répond à une question de clarification.',
          '- La demande est trop ambiguë pour agir : pose alors une seule question courte.',
          'Délègue avant toute réponse dépendant de la page ou d’une action. N’affirme jamais que tu ne peux pas cliquer ou écrire.',
          'Pendant la délégation, dis seulement que tu vérifies si un retour oral est utile. Attends le résultat du backend et ne devine jamais le résultat.'
        ].join('\n')
      ].join('\n\n');

  try {
    const upstream = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(String(req.auth.sub)).digest('hex')
      },
      body: JSON.stringify({
        session: {
          model: LIVE_MODEL,
          instructions,
          audio: { output: { voice: 'marin' } },
          ...(!trainingMode ? {
            delegation: {
              type: 'responses',
              responses: {
                model: LIVE_BACKEND_MODEL,
                instructions: assistantSystemText,
                tools: openAiLiveTools(evaluationMode),
                tool_choice: 'auto',
                parallel_tool_calls: false
              }
            }
          } : { delegation: { type: 'client' } })
        },
        transport: { type: 'webrtc', sdp }
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || typeof data?.transport?.sdp !== 'string') {
      console.error(JSON.stringify({ type: 'openai_live_session_error', requestId, status: upstream.status, sdpShape }));
      return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
        .json({ error: data?.error?.message || 'Voice service unavailable', requestId });
    }
    console.info(JSON.stringify({ type: 'openai_live_session_created', requestId, model: LIVE_MODEL, trainingMode, sdpShape }));
    return res.status(201).json({ id: data.session?.id, sdp: data.transport.sdp, model: LIVE_MODEL, requestId });
  } catch (error) {
    console.error(JSON.stringify({ type: 'openai_live_session_error', requestId, code: technicalErrorCode(error) }));
    return res.status(502).json({ error: 'Voice service unavailable', requestId });
  }
});

const ALLOWED_EVENTS = new Set([
  'analytics_consent', 'extension_installed', 'session_start', 'session_reset',
  'user_message', 'api_response', 'api_error', 'step_completed',
  'onboarding_complete', 'onboarding_step', 'page_view', 'dom_action', 'voice_session'
]);
const ALLOWED_EVENT_PROPERTIES = {
  extension_installed: ['reason'],
  page_view: ['path'],
  user_message: ['historyLength'],
  api_response: ['trigger', 'responseTime'],
  api_error: ['trigger', 'error'],
  step_completed: ['step', 'index'],
  dom_action: ['ok', 'risk'],
  voice_session: ['state']
};

function sanitizeEventProperties(event, properties) {
  const result = {};
  for (const key of ALLOWED_EVENT_PROPERTIES[event] || []) {
    const value = properties?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string') result[key] = value.replace(/[\r\n]/g, ' ').slice(0, 100);
  }
  return result;
}

app.post('/api/events', eventsLimiter, (req, res) => {
  const { sid, v, lang, events } = req.body || {};
  if (typeof sid !== 'string' || sid.length > 100 || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const batch = events.slice(0, 50).filter(evt => evt && ALLOWED_EVENTS.has(evt.event));
  for (const evt of batch) {
    console.log(JSON.stringify({
      type: 'analytics', sid, v: String(v || 'unknown').slice(0, 20),
      lang: String(lang || 'unknown').slice(0, 10), event: evt.event,
      props: sanitizeEventProperties(evt.event, evt.props),
      ts: Number(evt.ts) || Date.now(), received: Date.now()
    }));
  }
  return res.json({ ok: true, count: batch.length });
});

app.use((error, _req, res, _next) => {
  const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status === 413 ? 'Payload too large' : error.message || 'Request failed' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Limova proxy running on port ${PORT}`));
}

app.locals.authTesting = {
  issueSessionToken,
  verifySignedToken,
  stableMemoryUserId,
  resetCaches() {
    activeUserCache.clear();
  }
};

module.exports = app;
