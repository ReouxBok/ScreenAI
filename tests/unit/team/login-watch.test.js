// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://subscribe.free.fr/login/" }
// The login watcher injected in a tab (TEAM-729, docs/login-vault.md « Offer to save »).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeLoginForm, watchLoginForms } from '../../../src/team/page-login-watch.js';
import { installLayout } from './helpers.js';

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('watchLoginForms', () => {
  let restoreLayout;
  let sendMessage;
  beforeEach(() => {
    delete globalThis.__limovaLoginWatch;
    restoreLayout = installLayout();
    sendMessage = vi.fn(async () => ({ ok: true }));
    globalThis.chrome = { runtime: { sendMessage } };
  });
  afterEach(() => {
    // Tests share one document: switch this test's listeners off before the next one.
    if (globalThis.__limovaLoginWatch) globalThis.__limovaLoginWatch.disabled = true;
    delete globalThis.__limovaLoginWatch;
    delete globalThis.chrome;
    restoreLayout();
    vi.useRealTimers();
  });

  it('sends the login once, on submit only, without touching the page', () => {
    document.body.innerHTML = `
      <form id="f" action="/session" method="post">
        <input id="u" type="email" autocomplete="username"><input id="p" type="password">
        <button type="button" id="eye">Afficher</button><button type="submit" id="go">Se connecter</button>
      </form>`;
    const before = document.documentElement.outerHTML;
    expect(watchLoginForms({})).toEqual({ ok: true, installed: true, disabled: false });
    expect(watchLoginForms({})).toEqual({ ok: true, installed: false, disabled: false });
    document.getElementById('u').value = ' camille@example.com ';
    document.getElementById('p').value = 'Tr0ub4dor&3';
    // Typing and the « show password » button send nothing.
    document.getElementById('p').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('eye').click();
    expect(sendMessage).not.toHaveBeenCalled();
    // A click on the submit button, then its submit event: one message. (jsdom cannot
    // submit forms, so the click's default action is cancelled.)
    const cancel = event => event.preventDefault();
    window.addEventListener('click', cancel, true);
    document.getElementById('go').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    window.removeEventListener('click', cancel, true);
    submit(document.getElementById('f'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'TEAM_LOGIN_SUBMITTED', seq: 1, username: 'camille@example.com', password: 'Tr0ub4dor&3' });
    // No origin in the message: the service worker takes Chrome's.
    expect(Object.keys(sendMessage.mock.calls[0][0]).sort()).toEqual(['password', 'seq', 'type', 'username']);
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('skips a sign-up form with two password fields, and an empty password', () => {
    document.body.innerHTML = `
      <form id="signup"><input type="email" value="a@b.c"><input type="password" autocomplete="new-password" value="x1y2z3w4"><input type="password" autocomplete="new-password" value="x1y2z3w4"></form>
      <form id="empty"><input type="text" value="camille"><input type="password"></form>`;
    watchLoginForms({});
    submit(document.getElementById('signup'));
    submit(document.getElementById('empty'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('notices a sign-in without a <form> (Enter, or a « Connexion » button)', () => {
    document.body.innerHTML = '<input id="u" type="text" value="12345678"><input id="p" type="password" value="s3cret-pass"><div role="button" id="b">Connexion</div>';
    watchLoginForms({});
    document.getElementById('p').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'TEAM_LOGIN_SUBMITTED', username: '12345678', password: 's3cret-pass' }));
    document.getElementById('p').value = 'another-pass';
    document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('says the field went away, without a value, when a page signs in without navigating', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<form id="f"><input type="email" value="a@b.fr"><input id="p" type="password" value="pass-1234"></form>';
    watchLoginForms({});
    submit(document.getElementById('f'));
    document.getElementById('f').remove();
    vi.advanceTimersByTime(2_000);
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'TEAM_LOGIN_FIELD_GONE', seq: 1 });
  });

  it('does not say so when the login form comes back (an error re-rendered it)', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><form id="f"><input type="email" value="a@b.fr"><input type="password" value="pass-1234"></form></div>';
    watchLoginForms({});
    submit(document.getElementById('f'));
    document.getElementById('root').innerHTML = '<form><input type="email" value="a@b.fr"><input type="password"><p role="alert">Mot de passe incorrect</p></form>';
    vi.advanceTimersByTime(12_000);
    expect(sendMessage.mock.calls.map(call => call[0].type)).toEqual(['TEAM_LOGIN_SUBMITTED']);
  });

  it('sends nothing once switched off', () => {
    document.body.innerHTML = '<form id="f"><input type="email" value="a@b.fr"><input type="password" value="pass-1234"></form>';
    watchLoginForms({});
    expect(watchLoginForms({ disabled: true }).disabled).toBe(true);
    submit(document.getElementById('f'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('probes whether a password field shows', () => {
    document.body.innerHTML = '<p>Bienvenue</p>';
    expect(probeLoginForm()).toEqual({ ok: true, origin: 'https://subscribe.free.fr', password_visible: false });
    document.body.innerHTML = '<input type="password">';
    expect(probeLoginForm().password_visible).toBe(true);
  });
});
