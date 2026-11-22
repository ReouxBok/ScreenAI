// page-login-watch.js — Functions injected in a tab to notice a login (TEAM-729).
//
// docs/login-vault.md « Offer to save (device UI) ». Like page-snapshot.js, each
// function is passed to chrome.scripting.executeScript and runs in the extension's
// ISOLATED world of the tab's top frame; each is SELF-CONTAINED.
//
// `watchLoginForms` only adds capture-phase listeners (submit, click, Enter) to the
// document of the isolated world. It never changes the page, never adds attributes,
// globals or events the page can see, and reads nothing until the person submits a
// form holding a filled <input type="password">. Then, and only then, it sends the
// page's username and password to the service worker in one runtime message
// (`TEAM_LOGIN_SUBMITTED`; the service worker takes the origin from Chrome's sender,
// never from the message). It keeps no copy. For pages that sign in without
// navigating, it then watches, for 10 s at most, whether the password field goes away
// and no other password field shows, and says so with `TEAM_LOGIN_FIELD_GONE` (no
// value). The service worker decides everything else: whether this tab may be
// watched, whether the login worked, and whether to ask.
//
// Skipped here: a sign-up or password-change form (two password fields or more), a
// password longer than 1024 characters, the same login sent again within 2 s.
//
// `probeLoginForm` answers whether the page now shows a password field (the login form
// came back: the sign-in failed).

export function watchLoginForms(options) {
  const existing = globalThis.__limovaLoginWatch;
  if (existing) {
    existing.disabled = options?.disabled === true;
    return { ok: true, installed: false, disabled: existing.disabled };
  }
  if (options?.disabled === true) return { ok: true, installed: false, disabled: true };
  if (window.top !== window) return { ok: false, code: 'not_top_frame' };

  const MAX_PASSWORD = 1024;
  const MAX_USERNAME = 320;
  const GONE_WINDOW_MS = 10_000;
  const GONE_POLL_MS = 300;
  const GONE_SETTLE_MS = 800;
  const USERNAME_TYPES = ['', 'text', 'email', 'tel'];
  const watch = { disabled: false, lastKey: '', lastAt: 0, seq: 0, pollTimer: null };
  globalThis.__limovaLoginWatch = watch;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function typeOf(el) {
    return el instanceof HTMLInputElement ? el.type : '';
  }

  function scopeOf(el) {
    if (!el) return null;
    if (el instanceof HTMLFormElement) return el;
    return el.form || el.closest?.('form') || null;
  }

  // The visible password fields of a form, or of the page outside any form.
  function passwordsIn(scope) {
    const root = scope || document;
    return [...root.querySelectorAll('input')].filter(input => typeOf(input) === 'password' && (scope || !input.form) && visible(input));
  }

  // A button that submits, or reads like « Se connecter » when the page signs in by script.
  const SIGN_IN_WORDS = /(connexion|connecter|identifier|login|log ?in|sign ?in|acc[eé]der|continuer|continue|valider|suivant|next|entrer|submit)/i;
  function submitsLogin(control) {
    if (control instanceof HTMLButtonElement) {
      if ((control.getAttribute('type') || 'submit').toLowerCase() === 'submit') return true;
    } else if (control instanceof HTMLInputElement) {
      if (['submit', 'image'].includes(control.type)) return true;
      if (control.type !== 'button') return false;
    }
    const name = `${control.getAttribute('aria-label') || ''} ${control instanceof HTMLInputElement ? control.value : control.textContent || ''}`;
    return SIGN_IN_WORDS.test(name.replace(/\s+/g, ' ').slice(0, 200));
  }

  function usernameFor(password, scope) {
    const root = scope || document;
    const inputs = [...root.querySelectorAll('input')].filter(input => (scope || !input.form)
      && USERNAME_TYPES.includes(typeOf(input)) && visible(input) && input.value.trim());
    const before = inputs.filter(input => input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pool = before.length ? before : inputs;
    const tokens = input => String(input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    const named = pool.filter(input => tokens(input).some(token => token === 'username' || token === 'email'));
    const pick = named.at(-1) || pool.filter(input => typeOf(input) === 'email').at(-1) || pool.at(-1) || null;
    return pick ? pick.value.trim().slice(0, MAX_USERNAME) : '';
  }

  function anyVisiblePassword() {
    return [...document.querySelectorAll('input')].some(input => typeOf(input) === 'password' && visible(input));
  }

  function watchGone(password, seq) {
    clearInterval(watch.pollTimer);
    const started = Date.now();
    let goneAt = 0;
    watch.pollTimer = setInterval(() => {
      if (watch.seq !== seq || Date.now() - started > GONE_WINDOW_MS + GONE_SETTLE_MS) {
        if (watch.seq === seq) clearInterval(watch.pollTimer);
        return;
      }
      if (!goneAt) {
        if (!visible(password) && Date.now() - started <= GONE_WINDOW_MS) goneAt = Date.now();
        return;
      }
      if (Date.now() - goneAt < GONE_SETTLE_MS) return;
      clearInterval(watch.pollTimer);
      // The form came back (an error re-rendered it): not a successful login.
      if (anyVisiblePassword()) return;
      try {
        chrome.runtime.sendMessage({ type: 'TEAM_LOGIN_FIELD_GONE', seq }).catch(() => {});
      } catch (_) { /* the extension reloaded */ }
    }, GONE_POLL_MS);
  }

  function capture(scopeEl) {
    if (watch.disabled) return;
    const scope = scopeOf(scopeEl);
    const passwords = passwordsIn(scope);
    // Sign-up (« new-password » twice) or password change: not a login to save.
    if (passwords.length !== 1) return;
    const password = passwords[0];
    const value = password.value;
    if (!value || value.length > MAX_PASSWORD) return;
    const username = usernameFor(password, scope);
    const key = `${username}\u0000${value.length}`;
    const now = Date.now();
    if (key === watch.lastKey && now - watch.lastAt < 2_000) return;
    watch.lastKey = key;
    watch.lastAt = now;
    watch.seq += 1;
    const seq = watch.seq;
    try {
      chrome.runtime.sendMessage({ type: 'TEAM_LOGIN_SUBMITTED', seq, username, password: value }).catch(() => {});
    } catch (_) {
      return;
    }
    watchGone(password, seq);
  }

  document.addEventListener('submit', event => {
    if (event.target instanceof HTMLFormElement) capture(event.target);
  }, true);

  document.addEventListener('click', event => {
    if (watch.disabled || !(event.target instanceof Element)) return;
    const control = event.target.closest('button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]');
    if (!control || !submitsLogin(control)) return;
    const scope = scopeOf(control);
    if (scope) {
      capture(scope);
      return;
    }
    // A sign-in without a <form>: one filled password field outside any form.
    const loose = passwordsIn(null).filter(input => input.value);
    if (loose.length === 1) capture(loose[0]);
  }, true);

  document.addEventListener('keydown', event => {
    if (watch.disabled || event.key !== 'Enter' || event.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const scope = scopeOf(target);
    if (scope) {
      capture(scope);
      return;
    }
    if (typeOf(target) === 'password' || USERNAME_TYPES.includes(typeOf(target))) {
      const loose = passwordsIn(null).filter(input => input.value);
      if (loose.length === 1) capture(loose[0]);
    }
  }, true);

  return { ok: true, installed: true, disabled: false };
}

// After a navigation: is a password field shown again on this page?
export function probeLoginForm() {
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  const shown = [...document.querySelectorAll('input')].some(input => input.type === 'password' && visible(input));
  return { ok: true, origin: location.origin, password_visible: shown };
}
