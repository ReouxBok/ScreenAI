// payment-token.js — A payment runs only with the owner's click in the chat (TEAM-757).
//
// docs/browser-device-protocol.md « The chat level is the only permission… » §2. Since
// `browser.v3` the extension has no window of its own: the server shows a card in the
// web chat, and only after the owner clicks « Confirmer le paiement » does it send the
// payment-class action with a single-use token:
//
//   "payment_token": {"v": 1, "id": "<uuid>", "device_id": "<uuid>", "fp": "<64 hex>",
//                     "exp_ms": 1795680120000, "sig": "<64 hex>"}
//
// The extension runs the action only when ALL of these hold, else it answers
// `payment_confirmation_required` and does nothing:
// - `device_id` is this connection's own device id;
// - `exp_ms` is in the future;
// - `fp` equals SHA-256 (lower-case hex) of the UTF-8 JSON array
//   ["limova-pay.v1", tool, tab_id, snapshot_id, targets] written without spaces, where
//   targets is [element_id] for one element and [[action, element_id], …] for a batch;
//   so a token for « Payer » on one tab cannot pay with another element or tab;
// - `sig` is HMAC-SHA256 (lower-case hex) keyed with the UTF-8 bytes of the lower-case
//   hex SHA-256 of this device's own token, over
//   `limova-pay.v1|{id}|{device_id}|{fp}|{exp_ms}`: only the server, which stores that
//   hash, can mint it; the model never sees it;
// - `id` was never accepted before (kept until it expires): a token pays once.
//
// WebCrypto (crypto.subtle) only, in the service worker. Nothing is stored.

export const PAYMENT_PREFIX = 'limova-pay.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text, cryptoImpl = globalThis.crypto) {
  return toHex(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function hmacSha256Hex(keyText, message, cryptoImpl = globalThis.crypto) {
  const key = await cryptoImpl.subtle.importKey('raw', new TextEncoder().encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await cryptoImpl.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// The action a token is bound to: what the server hashed for this exact call.
export function fingerprintInput(tool, args = {}) {
  const targets = tool === 'browser.batch'
    ? (Array.isArray(args.steps) ? args.steps : []).map(step => [step?.action ?? null, step?.element_id ?? null])
    : (args.element_id !== undefined && args.element_id !== null ? [args.element_id] : []);
  return [PAYMENT_PREFIX, tool, args.tab_id ?? null, args.snapshot_id ?? null, targets];
}

export async function paymentFingerprint(tool, args, cryptoImpl = globalThis.crypto) {
  // JSON.stringify writes no spaces, like json.dumps(..., separators=(",", ":")).
  return sha256Hex(JSON.stringify(fingerprintInput(tool, args)), cryptoImpl);
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * One verifier per connection.
 * @param {object} deps {deviceId: () => string, deviceToken: () => string, now, cryptoImpl}
 */
export function createPaymentVerifier({ deviceId, deviceToken, now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  const used = new Map(); // token id -> exp_ms

  function prune() {
    const at = now();
    for (const [id, exp] of used) if (exp <= at) used.delete(id);
  }

  /**
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
   */
  async function verify(tool, args = {}) {
    const token = args.payment_token;
    if (!token || typeof token !== 'object') return { ok: false, reason: 'missing' };
    if (token.v !== 1) return { ok: false, reason: 'version' };
    const ownId = String(deviceId?.() || '').toLowerCase();
    const id = typeof token.id === 'string' ? token.id.toLowerCase() : '';
    const tokenDevice = typeof token.device_id === 'string' ? token.device_id.toLowerCase() : '';
    const fp = typeof token.fp === 'string' ? token.fp : '';
    const sig = typeof token.sig === 'string' ? token.sig : '';
    const exp = token.exp_ms;
    if (!UUID.test(id) || !HEX64.test(fp) || !HEX64.test(sig) || !Number.isSafeInteger(exp)) return { ok: false, reason: 'malformed' };
    if (!ownId || tokenDevice !== ownId) return { ok: false, reason: 'device' };
    if (exp <= now()) return { ok: false, reason: 'expired' };
    prune();
    if (used.has(id)) return { ok: false, reason: 'reused' };
    const expected = await paymentFingerprint(tool, args, cryptoImpl);
    if (!sameHex(expected, fp)) return { ok: false, reason: 'fingerprint' };
    const secret = String(deviceToken?.() || '');
    if (!secret) return { ok: false, reason: 'device' };
    const key = await sha256Hex(secret, cryptoImpl);
    // The original id and device id text, as the server signed them.
    const signed = `${PAYMENT_PREFIX}|${token.id}|${token.device_id}|${fp}|${exp}`;
    const expectedSig = await hmacSha256Hex(key, signed, cryptoImpl);
    if (!sameHex(expectedSig, sig)) return { ok: false, reason: 'signature' };
    // Checked again after the awaits: two calls with one token, only one pays.
    if (used.has(id)) return { ok: false, reason: 'reused' };
    used.set(id, exp);
    return { ok: true };
  }

  return { verify, usedCount: () => { prune(); return used.size; } };
}
