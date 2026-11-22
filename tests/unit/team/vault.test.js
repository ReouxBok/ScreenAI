// Login vault: the device side of the sealed fill (TEAM-729, docs/login-vault.md).
import { describe, it, expect } from 'vitest';
import {
  createVaultKeyPair, openSeal, isPublicP256Jwk, base64UrlDecode, SEAL_ALG, SEAL_INFO
} from '../../../src/team/vault.js';
import { sealForDevice, loginPayload } from './vault-helpers.js';

const CALL = '4c1d2a6e-0b7f-4e1a-9c3d-5f6a7b8c9d0e';
const DEVICE = '3f8b2c1e-0000-4000-8000-000000000001';

// A fixed vector, made with raw WebCrypto from the contract's text (salt = UTF-8 call_id,
// info = "limova-vault-fill.v1", AAD = "limova-vault-fill.v1|<call_id>|<device_id>").
// The backend's sealer must open to the same plaintext with this device key.
const VECTOR = {
  "device_private_jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "i-9NleaGgDij8wEyTEA6FsGUzU4vIGVsjleZYzLiXlg",
    "y": "MaQYeH6YaYy9XoEtHTGxFwBR2NakWoUAGokAOShR2F0",
    "d": "V2Hnk9v4nojpHTslIQWEqnQzwwKVS4qLx-we1eE7IdI"
  },
  "call_id": "4c1d2a6e-0b7f-4e1a-9c3d-5f6a7b8c9d0e",
  "device_id": "3f8b2c1e-0000-4000-8000-000000000001",
  "sealed": {
    "alg": "ECDH-ES+HKDF-SHA256+A256GCM",
    "epk": {
      "kty": "EC",
      "crv": "P-256",
      "x": "ozGJLleoNs-cUhO5wIdp1IwGS2dbbWDRK4e04JjYhPY",
      "y": "cHZon7dqXoSEh8yLugy49Vo3v93ekHa_n3WGHucJq_0"
    },
    "iv": "AQIDBAUGBwgJCgsM",
    "ct": "FGaM5tUYOTyF6cu5-7AOY5byrwGA8YzszQD9FIR8Bb6LgTXdr0Hj77Amja-V5_0Q7-TBzRqcDGzhUcdFLsCycxrJQZaK-iK9AyHGtyMZobyW4MosI_4JHUTQBpbhTT9UBR2Zy2iVFdmt2S0v1_ql7Nwm4MZfhto8JAyKuO6dEucyUgHXnQ67X26prhzCs8J3iXCNgyZpxFTNvYm4TvuRMv6Z1EQP6MT8x_fBqjYhFRflF_A14qev8RYWUeUU8ct3jFsg8T4bOdNDRpZO0H01xncsVYqYqCuKWT3BY1xUtzqbWQ68X_MV6SIG4IsocHgH9v1lUfeZF28VrHfwdnBeTc23Ds-kzFwE5Um0"
  }
};

async function importDevicePrivate(jwk) {
  return globalThis.crypto.subtle.importKey('jwk', { ...jwk, ext: false }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

describe('vault key pair', () => {
  it('makes a non-extractable private key and a bare public JWK', async () => {
    const pair = await createVaultKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.type).toBe('private');
    expect(Object.keys(pair.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(pair.publicJwk).toEqual(expect.objectContaining({ kty: 'EC', crv: 'P-256' }));
    expect(base64UrlDecode(pair.publicJwk.x)).toHaveLength(32);
    expect(base64UrlDecode(pair.publicJwk.y)).toHaveLength(32);
    expect(isPublicP256Jwk(pair.publicJwk)).toBe(true);
    await expect(globalThis.crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
  });

  it('makes a new key every time', async () => {
    const a = await createVaultKeyPair();
    const b = await createVaultKeyPair();
    expect(a.publicJwk.x).not.toBe(b.publicJwk.x);
  });
});

describe('openSeal', () => {
  it('opens the contract\'s fixed vector', async () => {
    expect(VECTOR.sealed.alg).toBe(SEAL_ALG);
    expect(SEAL_INFO).toBe('limova-vault-fill.v1');
    const privateKey = await importDevicePrivate(VECTOR.device_private_jwk);
    const opened = await openSeal({ sealed: VECTOR.sealed, callId: VECTOR.call_id, deviceId: VECTOR.device_id, privateKey, now: 1_800_000_000_000 });
    expect(opened).toEqual({
      ok: true,
      payload: {
        origins: ['https://subscribe.free.fr'], site: 'free.fr', username: 'camille@example.com',
        password: 'Tr0ub4dor&3-vault', otp: null, exp_ms: 4102444800000
      }
    });
  });

  it('refuses the fixed vector for another call or device, or once expired', async () => {
    const privateKey = await importDevicePrivate(VECTOR.device_private_jwk);
    const base = { sealed: VECTOR.sealed, callId: VECTOR.call_id, deviceId: VECTOR.device_id, privateKey, now: 1_800_000_000_000 };
    expect(await openSeal({ ...base, callId: 'another-call' })).toEqual(expect.objectContaining({ ok: false, code: 'secret_unreadable' }));
    expect(await openSeal({ ...base, deviceId: 'another-device-0001' })).toEqual(expect.objectContaining({ ok: false, code: 'secret_unreadable' }));
    expect(await openSeal({ ...base, now: 4102444800000 })).toEqual(expect.objectContaining({ ok: false, code: 'secret_unreadable', reason: 'expired' }));
  });

  it('opens what a server seals for this socket\'s key, with an OTP', async () => {
    const pair = await createVaultKeyPair();
    const sealed = await sealForDevice({
      devicePublicJwk: pair.publicJwk, callId: CALL, deviceId: DEVICE,
      payload: loginPayload({ callId: CALL, deviceId: DEVICE, otp: '492039' })
    });
    const opened = await openSeal({ sealed, callId: CALL, deviceId: DEVICE, privateKey: pair.privateKey });
    expect(opened.ok).toBe(true);
    expect(opened.payload.otp).toBe('492039');
    expect(opened.payload.password).toBe('Tr0ub4dor&3-vault');
  });

  it('binds HKDF salt, HKDF info and the AAD exactly as the contract says', async () => {
    const pair = await createVaultKeyPair();
    const payload = loginPayload({ callId: CALL, deviceId: DEVICE });
    const variants = [
      { saltText: '' },
      { saltText: DEVICE },
      { info: 'limova-vault-fill.v2' },
      { aad: `limova-vault-fill.v1|${DEVICE}|${CALL}` },
      { aad: `limova-vault-fill.v1:${CALL}:${DEVICE}` },
      { aad: '' }
    ];
    for (const variant of variants) {
      const sealed = await sealForDevice({ devicePublicJwk: pair.publicJwk, callId: CALL, deviceId: DEVICE, payload, ...variant });
      const opened = await openSeal({ sealed, callId: CALL, deviceId: DEVICE, privateKey: pair.privateKey });
      expect(opened, JSON.stringify(variant)).toEqual(expect.objectContaining({ ok: false, code: 'secret_unreadable', reason: 'decrypt' }));
    }
  });

  it('refuses a seal whose payload names another call or device, even with the right AAD', async () => {
    const pair = await createVaultKeyPair();
    for (const [patch, reason] of [[{ call_id: 'other-call' }, 'call_id'], [{ device_id: 'other-device' }, 'device_id'], [{ v: 2 }, 'version'], [{ exp_ms: Date.now() - 1 }, 'expired'], [{ origins: [] }, 'origins']]) {
      const sealed = await sealForDevice({
        devicePublicJwk: pair.publicJwk, callId: CALL, deviceId: DEVICE,
        payload: { ...loginPayload({ callId: CALL, deviceId: DEVICE }), ...patch }
      });
      const opened = await openSeal({ sealed, callId: CALL, deviceId: DEVICE, privateKey: pair.privateKey });
      expect(opened).toEqual({ ok: false, code: 'secret_unreadable', reason });
    }
  });

  it('refuses another socket\'s key, a tampered ciphertext and malformed seals', async () => {
    const pair = await createVaultKeyPair();
    const other = await createVaultKeyPair();
    const sealed = await sealForDevice({ devicePublicJwk: pair.publicJwk, callId: CALL, deviceId: DEVICE, payload: loginPayload({ callId: CALL, deviceId: DEVICE }) });
    const open = extra => openSeal({ sealed, callId: CALL, deviceId: DEVICE, privateKey: pair.privateKey, ...extra });
    expect((await open({ privateKey: other.privateKey })).code).toBe('secret_unreadable');
    expect((await open({ privateKey: null })).reason).toBe('no_key');
    const bytes = base64UrlDecode(sealed.ct);
    bytes[0] ^= 1;
    const tampered = { ...sealed, ct: Buffer.from(bytes).toString('base64url') };
    expect((await open({ sealed: tampered })).reason).toBe('decrypt');
    expect((await open({ sealed: { ...sealed, alg: 'A256GCM' } })).reason).toBe('alg');
    expect((await open({ sealed: { ...sealed, iv: 'AAAA' } })).reason).toBe('iv');
    expect((await open({ sealed: { ...sealed, epk: { ...sealed.epk, d: 'x' } } })).reason).toBe('epk');
    expect((await open({ sealed: { ...sealed, ct: 'not base64url!' } })).reason).toBe('ct');
    expect((await open({ sealed: null })).reason).toBe('shape');
  });
});
