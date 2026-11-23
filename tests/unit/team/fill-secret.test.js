// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://subscribe.free.fr/login/" }
// browser.fill_secret (TEAM-729, docs/login-vault.md « What the device checks »).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBrowserEngine } from '../../../src/team/browser-engine.js';
import { createTeamController } from '../../../src/team/team-controller.js';
import { createVaultKeyPair } from '../../../src/team/vault.js';
import { createChromeFake, installLayout, resetIsolatedWorld, steppingClock, TEAM_PRODUCT } from './helpers.js';
import { sealForDevice, loginPayload } from './vault-helpers.js';

const CALL = 'call-4c1d-0001';
const DEVICE = '3f8b2c1e-0000-4000-8000-000000000001';
const ORIGIN = 'https://subscribe.free.fr';
const PASSWORD = 'Tr0ub4dor&3-vault';
const USERNAME = 'camille@example.com';

const LOGIN_PAGE = `
  <form id="login" action="/login/session" method="post">
    <label for="user">E-mail</label><input id="user" type="email" name="login">
    <label for="pw">Mot de passe</label><input id="pw" type="password" name="password">
    <button type="submit">Se connecter</button>
  </form>
  <div role="status" id="echo"></div>
  <p>Espace abonné Free</p>
`;

async function setup({ url = `${ORIGIN}/login/`, groupId = 7 } = {}) {
  const chromeApi = createChromeFake({ tabs: [{ id: 812, url, title: 'Connexion', groupId }] });
  // Wall-clock time for the seal's exp_ms, stepping time for the engine's waits.
  const engine = createBrowserEngine({ chromeApi, sleep: async () => {}, now: () => Date.now(), random: () => 0 });
  const browser = engine.forProduct(TEAM_PRODUCT);
  const pair = await createVaultKeyPair();
  return { chromeApi, browser, pair };
}

async function read(browser) {
  const page = await browser.readPage({ tab_id: 812 });
  expect(page.ok).toBe(true);
  const id = name => page.data.elements.find(element => element.name === name)?.id;
  return { snapshotId: page.data.snapshot_id, user: id('E-mail'), pw: id('Mot de passe'), page };
}

async function args(pair, ids, { origin = ORIGIN, payload = {}, sealCall = CALL, sealDevice = DEVICE, fields } = {}) {
  const sealed = await sealForDevice({
    devicePublicJwk: pair.publicJwk,
    callId: sealCall,
    deviceId: sealDevice,
    payload: loginPayload({ callId: sealCall, deviceId: sealDevice, ...payload })
  });
  return {
    tab_id: 812,
    snapshot_id: ids.snapshotId,
    origin,
    fields: fields || { username: ids.user, password: ids.pw },
    sealed,
    risk: 'write',
    risk_reason: null
  };
}

function vaultOf(pair, deviceId = DEVICE) {
  return { privateKey: pair.privateKey, deviceId };
}

describe('browser.fill_secret', () => {
  let restoreLayout;
  let consoleSpies;
  beforeEach(() => {
    resetIsolatedWorld();
    history.replaceState(null, '', '/login/');
    document.title = 'Connexion';
    document.body.innerHTML = LOGIN_PAGE;
    restoreLayout = installLayout();
    consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    // Nothing the vault does may print a value.
    for (const spy of consoleSpies) {
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).not.toContain(PASSWORD);
      spy.mockRestore();
    }
    restoreLayout();
    resetIsolatedWorld();
  });

  it('types the saved login like a person and answers flags, never values', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    const events = [];
    const user = document.getElementById('user');
    const pw = document.getElementById('pw');
    for (const type of ['focus', 'input', 'change']) {
      user.addEventListener(type, event => events.push(`user:${type}:${event.data ?? ''}`));
      pw.addEventListener(type, event => events.push(`pw:${type}:${event.data ?? ''}`));
    }
    // A careless page echoes what was typed into a status line.
    pw.addEventListener('input', () => { document.getElementById('echo').textContent = `Mot de passe saisi : ${pw.value}`; });

    const result = await browser.fillSecret({ ...(await args(pair, ids)), include_page: true }, { callId: CALL, vault: vaultOf(pair) });
    expect(result.ok).toBe(true);
    expect(user.value).toBe(USERNAME);
    expect(pw.value).toBe(PASSWORD);
    expect(events).toEqual(['user:focus:', 'user:input:', 'user:change:', 'pw:focus:', 'pw:input:', 'pw:change:']);
    expect(result.data.filled).toEqual({ username: true, password: true, otp: false });
    expect(result.data.done).toBe(true);
    expect(result.data.verification.field_state).toBe('sensitive');
    // The page map keeps the password field « sensitive », without a value.
    const pwEntry = result.data.page.elements.find(element => element.name === 'Mot de passe');
    expect(pwEntry.state).toBe('sensitive');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).toContain('••••••');
  });

  it('refuses a live page on another origin (phishing look-alike)', async () => {
    const { browser, pair, chromeApi } = await setup();
    const ids = await read(browser);
    chromeApi._tabs.get(812).url = 'https://free-fr.login-secure.com/login/';
    const result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'origin_mismatch' }) });
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses when the call\'s origin is not one of the login\'s exact origins', async () => {
    const { browser, pair, chromeApi } = await setup();
    const ids = await read(browser);
    chromeApi._tabs.get(812).url = 'https://www.free.fr/login/';
    const result = await browser.fillSecret(await args(pair, ids, { origin: 'https://www.free.fr' }), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
  });

  it('checks the live origin in the page too, not only Chrome\'s tab URL', async () => {
    // Chrome's tab says accounts.free.fr, but the document that would get the text is
    // subscribe.free.fr: the in-page check refuses before touching any field.
    const { browser, pair, chromeApi } = await setup();
    const ids = await read(browser);
    chromeApi._tabs.get(812).url = 'https://accounts.free.fr/login/';
    const a = await args(pair, ids, { origin: 'https://accounts.free.fr', payload: { origins: ['https://accounts.free.fr'] } });
    const result = await browser.fillSecret(a, { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
    expect(document.getElementById('user').value).toBe('');
  });

  it('answers secret_unreadable for another call, another device, an expired seal or a closed socket', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    const cases = [
      [await args(pair, ids, { sealCall: 'another-call' }), vaultOf(pair)],
      [await args(pair, ids, { sealDevice: 'another-device-01' }), vaultOf(pair)],
      [await args(pair, ids, { payload: { exp_ms: Date.now() - 1000 } }), vaultOf(pair)],
      [await args(pair, ids), null],
      [await args(pair, ids), vaultOf(await createVaultKeyPair())]
    ];
    for (const [callArgs, vault] of cases) {
      const result = await browser.fillSecret(callArgs, { callId: CALL, vault });
      expect(result.error.code).toBe('secret_unreadable');
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses a « password » id that is not an <input type="password">, and a password field as username', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    let result = await browser.fillSecret(await args(pair, ids, { fields: { password: ids.user } }), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('invalid_args');
    result = await browser.fillSecret(await args(pair, ids, { fields: { username: ids.pw } }), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('invalid_args');
    // The page turns the password field into a text field after the read.
    document.getElementById('pw').setAttribute('type', 'text');
    result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('invalid_args');
    expect(document.getElementById('user').value).toBe('');
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses a form that posts the password to another site', async () => {
    const { browser, pair } = await setup();
    const form = document.getElementById('login');
    form.setAttribute('action', 'https://collect.example.net/steal');
    const ids = await read(browser);
    const result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses a submit button whose formaction posts elsewhere, even behind a control named « action »', async () => {
    const { browser, pair } = await setup();
    const form = document.getElementById('login');
    form.insertAdjacentHTML('beforeend', '<input type="hidden" name="action" value="/login/session"><button type="submit" formaction="http://subscribe.free.fr/plain">Autre</button>');
    const ids = await read(browser);
    let result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
    form.querySelector('[formaction]').remove();
    form.setAttribute('action', 'https://evil.example/collect');
    // In Chrome, `form.action` would now read the hidden control named « action »
    // (jsdom does not shadow it); the check reads the attribute through the prototype.
    resetIsolatedWorld();
    const again = await read(browser);
    result = await browser.fillSecret(await args(pair, again), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
  });

  it('accepts a form posting to the same site (another subdomain of free.fr)', async () => {
    const { browser, pair } = await setup();
    document.getElementById('login').setAttribute('action', 'https://auth.free.fr/session');
    const ids = await read(browser);
    const result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.ok).toBe(true);
  });

  it('stops when a page script moves the password into a foreign form while the username is typed', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    document.getElementById('user').addEventListener('input', () => {
      const trap = document.createElement('form');
      trap.setAttribute('action', 'https://collect.example.net/steal');
      document.body.append(trap);
      trap.append(document.getElementById('pw'));
    });
    const result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('origin_mismatch');
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses ids of an older snapshot, a changed path (pushState) or a removed field', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    let result = await browser.fillSecret(await args(pair, { ...ids, snapshotId: 's1' }), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('stale_snapshot');
    history.pushState(null, '', '/elsewhere/');
    result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('stale_snapshot');
    history.replaceState(null, '', '/login/');
    document.getElementById('pw').remove();
    result = await browser.fillSecret(await args(pair, ids), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('element_not_found');
  });

  it('refuses a tab outside the group, before opening the seal', async () => {
    const { browser, pair } = await setup({ groupId: -1 });
    const result = await browser.fillSecret(await args(pair, { snapshotId: 's1', user: 'e1', pw: 'e2' }), { callId: CALL, vault: vaultOf(pair) });
    expect(result.error.code).toBe('not_in_group');
  });

  it('fills a one-time code from the seal', async () => {
    const { browser, pair } = await setup();
    document.body.insertAdjacentHTML('beforeend', '<form action="/login/otp" method="post"><label for="otp">Code</label><input id="otp" type="text" autocomplete="one-time-code"></form>');
    const page = await browser.readPage({ tab_id: 812 });
    const otpId = page.data.elements.find(element => element.name === 'Code').id;
    const a = await args(pair, { snapshotId: page.data.snapshot_id }, { fields: { otp: otpId }, payload: { otp: '492039' } });
    const result = await browser.fillSecret(a, { callId: CALL, vault: vaultOf(pair) });
    expect(result.ok).toBe(true);
    expect(result.data.filled).toEqual({ username: false, password: false, otp: true });
    expect(document.getElementById('otp').value).toBe('492039');
    expect(JSON.stringify(result)).not.toContain('492039');
  });

  it('keeps refusing sensitive fields in browser.fill and browser.batch', async () => {
    const { browser } = await setup();
    const ids = await read(browser);
    const fill = await browser.prepareAction('browser.fill', { tab_id: 812, snapshot_id: ids.snapshotId, element_id: ids.pw, target: 'Mot de passe', value: PASSWORD });
    expect(fill.error.error.code).toBe('sensitive_field');
    const batch = await browser.prepareAction('browser.batch', {
      tab_id: 812, snapshot_id: ids.snapshotId,
      steps: [{ action: 'fill', element_id: ids.user, target: 'E-mail', value: USERNAME }, { action: 'fill', element_id: ids.pw, target: 'Mot de passe', value: PASSWORD }]
    });
    expect(batch.error.error.code).toBe('sensitive_field');
    expect(document.getElementById('pw').value).toBe('');
  });
});

describe('browser.fill_secret through the controller', () => {
  let restoreLayout;
  beforeEach(() => {
    resetIsolatedWorld();
    history.replaceState(null, '', '/login/');
    document.body.innerHTML = LOGIN_PAGE;
    restoreLayout = installLayout();
  });
  afterEach(() => {
    restoreLayout();
    resetIsolatedWorld();
  });

  function controllerFor(browser) {
    const onActivity = vi.fn();
    const onVaultFill = vi.fn();
    const controller = createTeamController({
      product: TEAM_PRODUCT,
      browser,
      now: steppingClock(),
      onActivity,
      onVaultFill
    });
    return { controller, onActivity, onVaultFill };
  }

  it('fills with the socket\'s key, records no value and tells the offer to save', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    const { controller, onActivity, onVaultFill } = controllerFor(browser);
    const callArgs = await args(pair, ids);
    const result = await controller.handleCall({ call_id: CALL, tool: 'browser.fill_secret', args: callArgs }, { vault: () => vaultOf(pair), progress: () => {} });
    expect(result.ok).toBe(true);
    expect(onVaultFill).toHaveBeenCalledWith({ tabId: 812, origin: ORIGIN });
    const activity = JSON.stringify(onActivity.mock.calls);
    expect(activity).toContain('Connexion avec un identifiant enregistré');
    expect(activity).not.toContain(PASSWORD);
    expect(activity).not.toContain(USERNAME);
  });

  it('answers unsupported without a vault socket, and paused when paused', async () => {
    const { browser, pair } = await setup();
    const ids = await read(browser);
    const { controller } = controllerFor(browser);
    const call = { call_id: CALL, tool: 'browser.fill_secret', args: await args(pair, ids) };
    expect((await controller.handleCall(call, {})).error.code).toBe('unsupported');
    controller.stopAll();
    expect((await controller.handleCall(call, { vault: () => vaultOf(pair) })).error.code).toBe('paused');
    expect(document.getElementById('pw').value).toBe('');
  });
});
