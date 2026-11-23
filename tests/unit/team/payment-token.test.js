// The payment token (TEAM-757, docs/browser-device-protocol.md « Paying »).
// The vectors come from Python's hashlib/hmac, so the backend and the extension agree:
//   python3 -c "import hashlib,hmac,json; fp=hashlib.sha256(json.dumps(['limova-pay.v1','browser.click',812,'s17',['e3']],separators=(',',':')).encode()).hexdigest(); key=hashlib.sha256(b'lmd_test').hexdigest().encode(); print(fp, hmac.new(key, f'limova-pay.v1|11111111-1111-1111-1111-111111111111|22222222-2222-2222-2222-222222222222|{fp}|1795680120000'.encode(), hashlib.sha256).hexdigest())"
// The batch vector uses the same command with ['limova-pay.v1','browser.batch',812,'s17',[['fill','e1'],['click','fr2.e3']]]
// and id 33333333-3333-3333-3333-333333333333.
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createPaymentVerifier, fingerprintInput, hmacSha256Hex, paymentFingerprint, sha256Hex
} from '../../../src/team/payment-token.js';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const NOW = 1_795_680_000_000;
const CLICK_FP = '9474f5f427304641b28347f9a2011ddeebb45a9343fc157b76865353079aed7c';
const CLICK_SIG = '13b30f939f201faa2856f798fb3ac31b56df8a36a8a92dff035eb71bbb5265f5';
const BATCH_FP = '7e80561e4f6ec6ebbdf05d6cb4e681620ebe7aa6ce5cd1308e49133439f1ce90';
const BATCH_SIG = '439447dedad1b8fa41d7ce9d8043a6aa4e6df367086b89cdd376a8755fb1fcdd';
const KEY_HEX = 'a57d5ff6d78dba84e0c125090b23988e55bfe230fd6a5571dd0b9ac9f6f8369d';

const clickArgs = token => ({ tab_id: 812, snapshot_id: 's17', element_id: 'e3', target: 'Payer 49 €', payment_token: token });
const clickToken = (patch = {}) => ({ v: 1, id: '11111111-1111-1111-1111-111111111111', device_id: DEVICE, fp: CLICK_FP, exp_ms: 1_795_680_120_000, sig: CLICK_SIG, ...patch });

function verifier({ now = () => NOW, token = 'lmd_test', device = DEVICE } = {}) {
  return createPaymentVerifier({ deviceId: () => device, deviceToken: () => token, now, cryptoImpl: webcrypto });
}

describe('payment token (browser.v3)', () => {
  it('computes the fingerprint and the key exactly like the server', async () => {
    expect(JSON.stringify(fingerprintInput('browser.click', clickArgs()))).toBe('["limova-pay.v1","browser.click",812,"s17",["e3"]]');
    expect(await paymentFingerprint('browser.click', clickArgs(), webcrypto)).toBe(CLICK_FP);
    expect(await sha256Hex('lmd_test', webcrypto)).toBe(KEY_HEX);
    const signed = `limova-pay.v1|11111111-1111-1111-1111-111111111111|${DEVICE}|${CLICK_FP}|1795680120000`;
    expect(await hmacSha256Hex(KEY_HEX, signed, webcrypto)).toBe(CLICK_SIG);
    const batch = { tab_id: 812, snapshot_id: 's17', steps: [{ action: 'fill', element_id: 'e1', value: 'x' }, { action: 'click', element_id: 'fr2.e3' }] };
    expect(JSON.stringify(fingerprintInput('browser.batch', batch))).toBe('["limova-pay.v1","browser.batch",812,"s17",[["fill","e1"],["click","fr2.e3"]]]');
    expect(await paymentFingerprint('browser.batch', batch, webcrypto)).toBe(BATCH_FP);
  });

  it('writes null for a batch step with no element, like the backend and Limova Desktop', async () => {
    // The shared vector, pinned in the backend (test_browser_payment_and_router.py) and in
    // Limova Desktop (payment.rs) too.
    const batch = { tab_id: 812, snapshot_id: 's17', steps: [{ action: 'fill', element_id: 'e1', value: 'x' }, { action: 'key', key: 'Enter' }, { action: 'click', element_id: 'e3' }] };
    expect(JSON.stringify(fingerprintInput('browser.batch', batch))).toBe('["limova-pay.v1","browser.batch",812,"s17",[["fill","e1"],["key",null],["click","e3"]]]');
    expect(await paymentFingerprint('browser.batch', batch, webcrypto)).toBe('2605552893fccf94982c2517f9a5fe6ee2eeaf62906efa06e325a51f56c68d5f');
  });

  it('accepts a valid token once', async () => {
    const check = verifier();
    expect(await check.verify('browser.click', clickArgs(clickToken()))).toEqual({ ok: true });
    expect(await check.verify('browser.click', clickArgs(clickToken()))).toEqual({ ok: false, reason: 'reused' });
    const batch = { tab_id: 812, snapshot_id: 's17', steps: [{ action: 'fill', element_id: 'e1' }, { action: 'click', element_id: 'fr2.e3' }] };
    expect(await check.verify('browser.batch', { ...batch, payment_token: { ...clickToken(), id: '33333333-3333-3333-3333-333333333333', fp: BATCH_FP, sig: BATCH_SIG } })).toEqual({ ok: true });
  });

  it('pays only once even when two calls race with one token', async () => {
    const check = verifier();
    const results = await Promise.all([check.verify('browser.click', clickArgs(clickToken())), check.verify('browser.click', clickArgs(clickToken()))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
  });

  it('refuses every other token', async () => {
    const cases = [
      [undefined, 'missing'],
      [clickToken({ v: 2 }), 'version'],
      [clickToken({ id: 'not-a-uuid' }), 'malformed'],
      [clickToken({ sig: 'xyz' }), 'malformed'],
      [clickToken({ exp_ms: '1795680120000' }), 'malformed'],
      [clickToken({ device_id: '44444444-4444-4444-4444-444444444444' }), 'device'],
      [clickToken({ exp_ms: NOW }), 'expired'],
      [clickToken({ fp: CLICK_FP.replace(/.$/, '0') }), 'fingerprint'],
      [clickToken({ sig: CLICK_SIG.replace(/^./, 'f') }), 'signature']
    ];
    for (const [token, reason] of cases) {
      expect(await verifier().verify('browser.click', clickArgs(token)), reason).toEqual({ ok: false, reason });
    }
    // The right token for another call: another element, tab, snapshot or tool.
    for (const [tool, args] of [
      ['browser.click', { ...clickArgs(clickToken()), element_id: 'e4' }],
      ['browser.click', { ...clickArgs(clickToken()), tab_id: 813 }],
      ['browser.click', { ...clickArgs(clickToken()), snapshot_id: 's18' }],
      ['browser.submit', clickArgs(clickToken())]
    ]) {
      expect(await verifier().verify(tool, args)).toEqual({ ok: false, reason: 'fingerprint' });
    }
    // Another device's token: the signature is keyed by this device's own token.
    expect(await verifier({ token: 'lmd_other' }).verify('browser.click', clickArgs(clickToken()))).toEqual({ ok: false, reason: 'signature' });
  });

  it('forgets used ids once they expired', async () => {
    let now = NOW;
    const check = verifier({ now: () => now });
    await check.verify('browser.click', clickArgs(clickToken()));
    expect(check.usedCount()).toBe(1);
    now = 1_795_680_120_001;
    expect(check.usedCount()).toBe(0);
  });
});
