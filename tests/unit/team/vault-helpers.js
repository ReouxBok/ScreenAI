// The SERVER side of the login vault's device seal (docs/login-vault.md), for tests
// only: the extension never seals. Written from the contract text, not from vault.js.
const SEAL_INFO = 'limova-vault-fill.v1';
const enc = text => new TextEncoder().encode(text);
const b64u = bytes => Buffer.from(bytes).toString('base64url');

export async function sealForDevice({
  devicePublicJwk, payload, callId, deviceId,
  saltText = callId,
  info = SEAL_INFO,
  aad = `${SEAL_INFO}|${callId}|${deviceId}`,
  alg = 'ECDH-ES+HKDF-SHA256+A256GCM'
}) {
  const { subtle } = globalThis.crypto;
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const devicePublic = await subtle.importKey('jwk', { ...devicePublicJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = await subtle.deriveBits({ name: 'ECDH', public: devicePublic }, ephemeral.privateKey, 256);
  const hk = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc(saltText), info: enc(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(aad) }, key, enc(JSON.stringify(payload)));
  const jwk = await subtle.exportKey('jwk', ephemeral.publicKey);
  return { alg, epk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, iv: b64u(iv), ct: b64u(ct) };
}

export function loginPayload({ callId, deviceId, ...rest }) {
  return {
    v: 1,
    call_id: callId,
    device_id: deviceId,
    origins: ['https://subscribe.free.fr'],
    site: 'free.fr',
    username: 'camille@example.com',
    password: 'Tr0ub4dor&3-vault',
    exp_ms: Date.now() + 60_000,
    ...rest
  };
}
