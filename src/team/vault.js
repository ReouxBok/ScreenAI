// vault.js — The device side of the login vault's sealed fill (TEAM-729).
//
// Contract: docs/login-vault.md in the team-backend repository, « Socket: the device's
// key and hello » and « browser.fill_secret ».
//
// Each socket gets a fresh ECDH P-256 key pair, generated when the socket opens. The
// private key is a WebCrypto CryptoKey created with `extractable: false`: no code in
// the extension, nor anything reading its memory through the WebCrypto API, can export
// it. It lives in memory only and is dropped when the socket closes, so a new socket
// means a new key. The public key goes to the server in `hello.vault_key` as a JWK
// with only `kty`, `crv`, `x` and `y`.
//
// When the agent signs in with a saved login, the server sends `browser.fill_secret`
// with a sealed value. Opening it:
//   Z   = ECDH(private key, sealed.epk)                    32 bytes (deriveBits 256)
//   key = HKDF-SHA256(Z, salt = UTF-8(call_id), info = "limova-vault-fill.v1"), 32 bytes
//   plaintext = AES-256-GCM-decrypt(key, iv, ct (tag at the end),
//                                   aad = "limova-vault-fill.v1|<call_id>|<device_id>")
// The plaintext is UTF-8 JSON {v: 1, call_id, device_id, origins, site, username?,
// password?, otp?, exp_ms}. `openSeal` checks the version, that call_id and device_id
// are this call's and this device's, and that exp_ms has not passed. Every failure is
// the same `secret_unreadable`, so a caller learns nothing about which check failed.
//
// Nothing here logs, stores or returns a value outside the opened payload, and the
// shared secret bytes are zeroed once the key is derived.

export const VAULT_CAPABILITY = 'browser.v1+vault';
export const COOKIES_CAPABILITY = 'browser.v1+cookies';
export const SEAL_ALG = 'ECDH-ES+HKDF-SHA256+A256GCM';
export const SEAL_INFO = 'limova-vault-fill.v1';
const GCM_TAG_BYTES = 16;
const IV_BYTES = 12;
const COORD_BYTES = 32;
// A sealed login is small; anything bigger is not ours.
const MAX_CT_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text) {
  return encoder.encode(String(text));
}

export function base64UrlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict base64url (no padding, no other alphabet), or null.
export function base64UrlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function subtleOf(cryptoImpl) {
  const subtle = cryptoImpl?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available');
  return subtle;
}

function publicJwkOf(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

// A JWK of a P-256 public point: kty EC, crv P-256, x and y of 32 bytes each.
export function isPublicP256Jwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  if ('d' in jwk) return false;
  return base64UrlDecode(jwk.x)?.length === COORD_BYTES && base64UrlDecode(jwk.y)?.length === COORD_BYTES;
}

/**
 * A fresh key pair for one socket.
 * @param {Crypto} [cryptoImpl] globalThis.crypto
 * @returns {Promise<{privateKey: CryptoKey, publicJwk: {kty: string, crv: string, x: string, y: string}}>}
 */
export async function createVaultKeyPair(cryptoImpl = globalThis.crypto) {
  const subtle = subtleOf(cryptoImpl);
  // extractable: false applies to the private key; a public key is always exportable.
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  if (pair.privateKey.extractable) throw new Error('The vault private key must not be extractable');
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: publicJwkOf(jwk) };
}

function unreadable(reason) {
  // `reason` is for tests and never leaves the service worker.
  return { ok: false, code: 'secret_unreadable', reason };
}

function isStringArray(value, { min = 0, max = 50 } = {}) {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 2048);
}

/**
 * Open a sealed fill. Never throws.
 * @param {object} input
 * @param {object} input.sealed {alg, epk, iv, ct}
 * @param {string} input.callId this call's call_id
 * @param {string} input.deviceId this device's id (from the server's `ready`)
 * @param {CryptoKey} input.privateKey this socket's private key
 * @param {number} [input.now] epoch ms
 * @param {Crypto} [input.cryptoImpl]
 * @returns {Promise<{ok: true, payload: object} | {ok: false, code: 'secret_unreadable', reason: string}>}
 */
export async function openSeal({ sealed, callId, deviceId, privateKey, now = Date.now(), cryptoImpl = globalThis.crypto }) {
  if (!privateKey) return unreadable('no_key');
  if (typeof callId !== 'string' || !callId || typeof deviceId !== 'string' || !deviceId) return unreadable('no_ids');
  if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed)) return unreadable('shape');
  if (sealed.alg !== SEAL_ALG) return unreadable('alg');
  if (!isPublicP256Jwk(sealed.epk)) return unreadable('epk');
  const iv = base64UrlDecode(sealed.iv);
  const ct = base64UrlDecode(sealed.ct);
  if (!iv || iv.length !== IV_BYTES) return unreadable('iv');
  if (!ct || ct.length <= GCM_TAG_BYTES || ct.length > MAX_CT_BYTES) return unreadable('ct');

  let subtle;
  try {
    subtle = subtleOf(cryptoImpl);
  } catch {
    return unreadable('no_crypto');
  }
  let plain = null;
  let z = null;
  try {
    const epk = await subtle.importKey('jwk', { ...publicJwkOf(sealed.epk), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    z = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
    const hkdfKey = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8(callId), info: utf8(SEAL_INFO) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    plain = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(`${SEAL_INFO}|${callId}|${deviceId}`), tagLength: 128 },
      key,
      ct
    ));
  } catch {
    return unreadable('decrypt');
  } finally {
    if (z) new Uint8Array(z).fill(0);
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(plain));
  } catch {
    return unreadable('json');
  } finally {
    plain.fill(0);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unreadable('json');
  if (payload.v !== 1) return unreadable('version');
  // The AAD already binds both ids; the payload must say the same.
  if (payload.call_id !== callId) return unreadable('call_id');
  if (payload.device_id !== deviceId) return unreadable('device_id');
  if (!Number.isFinite(payload.exp_ms) || payload.exp_ms <= now) return unreadable('expired');
  if (!isStringArray(payload.origins, { min: 1 })) return unreadable('origins');
  if (typeof payload.site !== 'string' || !payload.site) return unreadable('site');
  for (const field of ['username', 'password', 'otp']) {
    if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') return unreadable(field);
  }
  return {
    ok: true,
    payload: {
      origins: payload.origins.slice(),
      site: payload.site.toLowerCase(),
      username: typeof payload.username === 'string' ? payload.username : null,
      password: typeof payload.password === 'string' ? payload.password : null,
      otp: typeof payload.otp === 'string' ? payload.otp : null,
      exp_ms: payload.exp_ms
    }
  };
}
