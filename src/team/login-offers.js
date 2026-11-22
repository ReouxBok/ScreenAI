// login-offers.js — « Enregistrer cette connexion pour Limova ? » (TEAM-729).
//
// docs/login-vault.md « Offer to save (device UI) ». The device, never the model,
// decides when to ask, and the person decides whether to save:
//
// - WHERE. Tabs of the product's tab group, always. The person's other tabs only if
//   they turned on « Proposer aussi d'enregistrer mes connexions dans mes onglets »
//   (off by default, `offer_in_own_tabs`). Never on http: pages, blocked sites
//   (LinkedIn, Limova Team itself) or origins on the « Jamais pour ce site » list.
//   Only those tabs get the watcher (page-login-watch.js), injected with
//   chrome.scripting in the isolated world once the page loaded; a tab that leaves the
//   group gets it switched off.
// - WHEN. The watcher sends the username and password when a form with one filled
//   password field is submitted. The login counts as successful when, within 10 s,
//   the tab navigates (and the new page, on the same origin, shows no password field)
//   or the field goes away with no other one showing. Not within 2 minutes of a
//   `browser.fill_secret` fill on that tab and origin (already saved).
// - ASKING. `GET /devices/me/login-secrets?origin=` first: a 404 means the vault is off
//   for this workspace, so nothing is asked (and nothing asked for 10 minutes); a
//   username already saved words the prompt « Mettre à jour la connexion enregistrée ? ».
//   The question opens in a small extension window (save-login.html) whose URL holds an
//   opaque id only; the window reads the site and username by message, never the password.
// - SENDING. « Enregistrer » posts `{origin, username, password}` to
//   `POST /devices/me/login-secrets` with the device token, then drops the password.
//   « Pas maintenant » or closing the window drops it, and that origin is not asked again
//   for 10 minutes (a page faking logins cannot open window after window); a newer login
//   in the same tab replaces the question still open. « Jamais pour ce site » adds the
//   origin to a local list (chrome.storage.local, origins only) and drops it.
//
// The captured password lives in this module's memory only, two minutes at most from
// the submission, then is dropped. It is never logged, stored, put in the activity
// list or sent anywhere but that one POST.

import { apiErrorCode, apiOrigin, deviceAuthHeader } from './connections.js';
import { classifyUrl, domainOf, isBlockedHost } from './products.js';
import { probeLoginForm, watchLoginForms } from './page-login-watch.js';

export const VAULT_PREFS_KEY = 'limova_team_vault_prefs_v1';
export const OFFER_PAGE = 'src/team/save-login.html';
export const CAPTURE_TTL_MS = 2 * 60_000;
export const SUCCESS_WINDOW_MS = 10_000;
export const VAULT_FILL_QUIET_MS = 2 * 60_000;
const NAVIGATION_PROBE_MAX_MS = 20_000;
const HISTORY_PROBE_DELAY_MS = 1_000;
const FEATURE_OFF_RETRY_MS = 10 * 60_000;
// After « Pas maintenant » (or closing the window), that origin is not asked again for a
// while: a page cannot open prompt after prompt by faking logins.
const DISMISS_QUIET_MS = 10 * 60_000;
const NEVER_LIMIT = 200;
const MAX_USERNAME = 320;
const MAX_PASSWORD = 1024;

export const TEAM_PAGE_MESSAGE_TYPES = Object.freeze(['TEAM_LOGIN_SUBMITTED', 'TEAM_LOGIN_FIELD_GONE']);

// An https origin a login may be saved for, or null.
export function offerableOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (isBlockedHost(url.hostname)) return null;
  if (!classifyUrl(url.href).ok) return null;
  return url.origin;
}

export function sanitizePrefs(raw) {
  const out = {};
  const products = raw && typeof raw === 'object' && raw.products && typeof raw.products === 'object' ? raw.products : {};
  for (const [productId, entry] of Object.entries(products)) {
    if (!entry || typeof entry !== 'object') continue;
    const never = Array.isArray(entry.never_origins)
      ? [...new Set(entry.never_origins.filter(origin => typeof origin === 'string' && offerableOrigin(origin) === origin))].slice(0, NEVER_LIMIT)
      : [];
    out[productId] = { offer_in_own_tabs: entry.offer_in_own_tabs === true, never_origins: never };
  }
  return out;
}

function sameUsername(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

export function createLoginOffers({
  chromeApi = globalThis.chrome,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timers = globalThis,
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID(),
  // () => [{product, connection, browser}] for every live product connection
  getLinks = () => [],
  onChange = () => {}
} = {}) {
  let prefs = null;
  const pending = new Map(); // tabId -> capture waiting for the login to succeed
  const offers = new Map(); // opaque id -> capture waiting for the person
  const vaultFills = new Map(); // tabId -> {origin, at}
  const featureOff = new Map(); // productId -> retry after (epoch ms)
  const dismissed = new Map(); // `${productId}\n${origin}` -> quiet until (epoch ms)
  const armed = new Set(); // tab ids with an active watcher

  async function loadPrefs() {
    if (prefs) return prefs;
    const data = await Promise.resolve(chromeApi.storage?.local?.get(VAULT_PREFS_KEY)).catch(() => ({}));
    prefs = sanitizePrefs(data?.[VAULT_PREFS_KEY]);
    return prefs;
  }

  async function savePrefs() {
    await Promise.resolve(chromeApi.storage?.local?.set({ [VAULT_PREFS_KEY]: { version: 1, products: prefs } })).catch(() => {});
    onChange();
  }

  function prefsOf(productId) {
    return prefs?.[productId] || { offer_in_own_tabs: false, never_origins: [] };
  }

  // ------------------------------------------------------------------ where

  // The product this tab's logins belong to, or null when the tab must not be watched.
  async function productForTab(tab, origin) {
    if (!tab || !origin) return null;
    await loadPrefs();
    const links = getLinks();
    let optedIn = null;
    for (const link of links) {
      const groupId = await Promise.resolve(link.browser?.currentGroupId?.()).catch(() => null);
      const inGroup = groupId !== null && groupId !== undefined && tab.groupId === groupId;
      if (prefsOf(link.product.id).never_origins.includes(origin)) continue;
      if (inGroup) return { link, inGroup: true };
      if (!optedIn && prefsOf(link.product.id).offer_in_own_tabs) optedIn = { link, inGroup: false };
    }
    return optedIn;
  }

  function recentlyFilled(tabId, origin) {
    const fill = vaultFills.get(tabId);
    if (!fill) return false;
    if (now() - fill.at > VAULT_FILL_QUIET_MS) {
      vaultFills.delete(tabId);
      return false;
    }
    return fill.origin === origin;
  }

  async function inject(tabId, func, options) {
    try {
      const results = await chromeApi.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func,
        args: [options]
      });
      return { ok: true, result: Array.isArray(results) ? results[0]?.result ?? null : null };
    } catch {
      return { ok: false, result: null };
    }
  }

  // Turn the watcher on in an eligible tab, off in one that no longer is.
  async function armTab(tabId, knownTab = null) {
    const tab = knownTab || await Promise.resolve(chromeApi.tabs.get(tabId)).catch(() => null);
    if (!tab || tab.status === 'loading') return false;
    const origin = offerableOrigin(tab.url || '');
    const target = origin ? await productForTab(tab, origin) : null;
    if (target) {
      const run = await inject(tabId, watchLoginForms, {});
      if (run.ok) armed.add(tabId);
      return run.ok;
    }
    if (armed.has(tabId)) {
      armed.delete(tabId);
      await inject(tabId, watchLoginForms, { disabled: true });
    }
    return false;
  }

  // The opt-in changed: switch watchers on or off in the person's open tabs.
  async function rearmAll() {
    const tabs = await Promise.resolve(chromeApi.tabs.query({})).catch(() => []);
    for (const tab of tabs || []) {
      if (Number.isInteger(tab.id)) await armTab(tab.id, tab);
    }
  }

  // ------------------------------------------------------------------ when

  function dropPending(tabId) {
    const entry = pending.get(tabId);
    if (!entry) return;
    pending.delete(tabId);
    timers.clearTimeout(entry.timer);
    entry.password = null;
  }

  function senderOrigin(sender) {
    if (typeof sender?.origin === 'string' && sender.origin !== 'null') return offerableOrigin(sender.origin);
    return offerableOrigin(sender?.url || '');
  }

  async function handlePageMessage(request, sender = {}) {
    const runtimeId = chromeApi.runtime?.id;
    if (!sender || (runtimeId && sender.id !== runtimeId)) return { ok: false };
    const tabId = sender.tab?.id;
    // Top frame of a web tab only: never an extension page, never an iframe.
    if (!Number.isInteger(tabId) || sender.frameId !== 0) return { ok: false };
    const origin = senderOrigin(sender);
    if (!origin) return { ok: false };

    if (request.type === 'TEAM_LOGIN_FIELD_GONE') {
      const entry = pending.get(tabId);
      if (entry && entry.phase === 'submitted' && entry.origin === origin && entry.seq === request.seq
        && now() - entry.at <= SUCCESS_WINDOW_MS + 2_000) {
        confirm(entry);
      }
      return { ok: true };
    }

    if (request.type !== 'TEAM_LOGIN_SUBMITTED') return { ok: false };
    const password = typeof request.password === 'string' ? request.password : '';
    const username = typeof request.username === 'string' ? request.username.trim() : '';
    if (!password || password.length > MAX_PASSWORD || username.length > MAX_USERNAME) return { ok: true };
    if (recentlyFilled(tabId, origin)) return { ok: true };
    const tab = await Promise.resolve(chromeApi.tabs.get(tabId)).catch(() => null);
    if (!tab || offerableOrigin(tab.url || '') !== origin) return { ok: true };
    const target = await productForTab(tab, origin);
    if (!target) return { ok: true };
    dropPending(tabId);
    const entry = {
      tabId,
      origin,
      productId: target.link.product.id,
      username,
      password,
      seq: Number.isInteger(request.seq) ? request.seq : null,
      at: now(),
      phase: 'submitted',
      timer: null
    };
    // No navigation and no vanished field within 10 s: the login did not go through.
    entry.timer = timers.setTimeout(() => {
      if (pending.get(tabId) === entry && entry.phase === 'submitted') dropPending(tabId);
    }, SUCCESS_WINDOW_MS);
    pending.set(tabId, entry);
    return { ok: true };
  }

  function onNavigation(tabId, { sameDocument = false } = {}) {
    const entry = pending.get(tabId);
    if (!entry || entry.phase === 'checking') return;
    if (entry.phase === 'submitted' && now() - entry.at > SUCCESS_WINDOW_MS) {
      dropPending(tabId);
      return;
    }
    entry.phase = 'navigated';
    timers.clearTimeout(entry.timer);
    entry.timer = timers.setTimeout(() => probe(entry), sameDocument ? HISTORY_PROBE_DELAY_MS : NAVIGATION_PROBE_MAX_MS);
  }

  // The new page is loaded: did the login form come back?
  async function probe(entry) {
    if (pending.get(entry.tabId) !== entry || entry.phase !== 'navigated') return;
    entry.phase = 'probing';
    timers.clearTimeout(entry.timer);
    const run = await inject(entry.tabId, probeLoginForm, {});
    if (pending.get(entry.tabId) !== entry) return;
    if (run.ok && run.result?.origin === entry.origin && run.result.password_visible) {
      dropPending(entry.tabId);
      return;
    }
    confirm(entry);
  }

  function confirm(entry) {
    if (pending.get(entry.tabId) !== entry) return;
    pending.delete(entry.tabId);
    timers.clearTimeout(entry.timer);
    entry.phase = 'checking';
    offer(entry).catch(() => { entry.password = null; });
  }

  // ------------------------------------------------------------------ asking

  async function deviceFetch(connection, path, init = {}) {
    const base = apiOrigin(connection);
    if (!base) return { status: null, body: null };
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { Authorization: deviceAuthHeader(connection), Accept: 'application/json', ...(init.headers || {}) },
        credentials: 'omit',
        cache: 'no-store'
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    } catch {
      return { status: null, body: null };
    }
  }

  function linkOf(productId) {
    return getLinks().find(link => link.product.id === productId) || null;
  }

  async function offer(entry) {
    const link = linkOf(entry.productId);
    const expiresAt = entry.at + CAPTURE_TTL_MS;
    if (!link || now() >= expiresAt || recentlyFilled(entry.tabId, entry.origin)) {
      entry.password = null;
      return;
    }
    if ((featureOff.get(entry.productId) || 0) > now() || (dismissed.get(`${entry.productId}\n${entry.origin}`) || 0) > now()) {
      entry.password = null;
      return;
    }
    // One question per tab: a newer login replaces the one still waiting.
    for (const [openId, open] of [...offers]) if (open.tabId === entry.tabId) finish(openId, { closeWindow: true });
    const existing = await deviceFetch(link.connection, `/api/v1/devices/me/login-secrets?origin=${encodeURIComponent(entry.origin)}`, { method: 'GET' });
    if (existing.status === 404) {
      // The vault is off for this workspace: ask nothing.
      featureOff.set(entry.productId, now() + FEATURE_OFF_RETRY_MS);
      entry.password = null;
      return;
    }
    if (existing.status === 401) {
      entry.password = null;
      return;
    }
    const items = existing.status === 200 && Array.isArray(existing.body?.items) ? existing.body.items : [];
    const update = Boolean(entry.username) && items.some(item => sameUsername(item?.username, entry.username));
    if (now() >= expiresAt) {
      entry.password = null;
      return;
    }
    const id = randomId();
    const item = {
      id,
      productId: entry.productId,
      productLabel: link.product.label,
      productColor: link.product.color,
      tabId: entry.tabId,
      origin: entry.origin,
      username: entry.username,
      password: entry.password,
      update,
      expiresAt,
      windowId: null,
      timer: null,
      busy: false
    };
    entry.password = null;
    item.timer = timers.setTimeout(() => finish(id, { closeWindow: true }), Math.max(0, expiresAt - now()));
    offers.set(id, item);
    Promise.resolve(chromeApi.windows?.create({
      type: 'popup',
      url: chromeApi.runtime.getURL(`${OFFER_PAGE}?id=${encodeURIComponent(id)}`),
      width: 420,
      height: 460,
      focused: true
    })).then(window => {
      const current = offers.get(id);
      if (!current) {
        if (window?.id !== undefined) Promise.resolve(chromeApi.windows?.remove(window.id)).catch(() => {});
        return;
      }
      current.windowId = window?.id ?? null;
    }).catch(() => finish(id));
  }

  function finish(id, { closeWindow = false } = {}) {
    const item = offers.get(id);
    if (!item) return false;
    offers.delete(id);
    timers.clearTimeout(item.timer);
    item.password = null;
    if (closeWindow && item.windowId !== null) Promise.resolve(chromeApi.windows?.remove(item.windowId)).catch(() => {});
    return true;
  }

  // What the window shows: never the password.
  function getOffer(id) {
    const item = offers.get(id);
    if (!item || now() >= item.expiresAt) return null;
    return {
      id,
      productLabel: item.productLabel,
      productColor: item.productColor,
      origin: item.origin,
      site: domainOf(item.origin) || item.origin,
      username: item.username,
      update: item.update,
      expires_at: item.expiresAt
    };
  }

  const SAVE_ERRORS = {
    400: 'rejected', 401: 'revoked', 404: 'disabled', 422: 'rejected', 503: 'unavailable'
  };

  async function decide(id, decision, { username } = {}) {
    const item = offers.get(id);
    if (!item || item.busy) return { ok: false, error: 'expired' };
    if (now() >= item.expiresAt) {
      finish(id, { closeWindow: true });
      return { ok: false, error: 'expired' };
    }
    if (decision === 'later') {
      dismissed.set(`${item.productId}\n${item.origin}`, now() + DISMISS_QUIET_MS);
      finish(id);
      return { ok: true };
    }
    if (decision === 'never') {
      await loadPrefs();
      const entry = prefsOf(item.productId);
      if (!entry.never_origins.includes(item.origin)) {
        prefs[item.productId] = { ...entry, never_origins: [...entry.never_origins, item.origin].slice(-NEVER_LIMIT) };
        await savePrefs();
      }
      finish(id);
      armTab(item.tabId).catch(() => {});
      return { ok: true };
    }
    if (decision !== 'save') return { ok: false, error: 'invalid' };
    const name = typeof username === 'string' ? username.trim() : item.username;
    if (!name || name.length > MAX_USERNAME) return { ok: false, error: 'invalid_username' };
    const link = linkOf(item.productId);
    if (!link) {
      finish(id);
      return { ok: false, error: 'revoked' };
    }
    item.busy = true;
    const password = item.password;
    item.password = null;
    const saved = await deviceFetch(link.connection, '/api/v1/devices/me/login-secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: item.origin, username: name, password })
    });
    finish(id);
    if (saved.status === 200 || saved.status === 201) {
      return { ok: true, updated: saved.body?.updated === true };
    }
    if (saved.status === 404) featureOff.set(item.productId, now() + FEATURE_OFF_RETRY_MS);
    if (saved.status === null) return { ok: false, error: 'network' };
    // 400 says why in error.code (blocked_site, invalid_origin, invalid_totp).
    if (saved.status === 400 && apiErrorCode(saved.body) === 'blocked_site') return { ok: false, error: 'blocked_site' };
    return { ok: false, error: SAVE_ERRORS[saved.status] || 'unavailable' };
  }

  function windowClosed(windowId) {
    for (const [id, item] of offers) {
      // Closing the window is « Pas maintenant ».
      if (item.windowId === windowId && !item.busy) {
        dismissed.set(`${item.productId}\n${item.origin}`, now() + DISMISS_QUIET_MS);
        finish(id);
      }
    }
  }

  // ------------------------------------------------------------------ settings

  async function getPrefs(productId) {
    await loadPrefs();
    const entry = prefsOf(productId);
    return { offer_in_own_tabs: entry.offer_in_own_tabs, never_origins: [...entry.never_origins] };
  }

  async function setPrefs(productId, patch = {}) {
    await loadPrefs();
    const entry = prefsOf(productId);
    const next = { ...entry, never_origins: [...entry.never_origins] };
    if (typeof patch.offer_in_own_tabs === 'boolean') next.offer_in_own_tabs = patch.offer_in_own_tabs;
    if (typeof patch.remove_never === 'string') next.never_origins = next.never_origins.filter(origin => origin !== patch.remove_never);
    prefs[productId] = next;
    await savePrefs();
    if (typeof patch.offer_in_own_tabs === 'boolean' || typeof patch.remove_never === 'string') rearmAll().catch(() => {});
    return getPrefs(productId);
  }

  function noteVaultFill({ tabId, origin }) {
    if (!Number.isInteger(tabId) || typeof origin !== 'string') return;
    vaultFills.set(tabId, { origin, at: now() });
    // A capture racing the fill is the fill itself.
    const entry = pending.get(tabId);
    if (entry?.origin === origin) dropPending(tabId);
  }

  // The connection went away: nothing captured for it survives.
  function forgetProduct(productId) {
    for (const [tabId, entry] of [...pending]) if (entry.productId === productId) dropPending(tabId);
    for (const [id, item] of [...offers]) if (item.productId === productId) finish(id, { closeWindow: true });
  }

  // ------------------------------------------------------------------ chrome events

  function attach() {
    const nav = chromeApi.webNavigation;
    nav?.onCommitted?.addListener?.(details => {
      if (details?.frameId === 0) onNavigation(details.tabId);
    });
    nav?.onHistoryStateUpdated?.addListener?.(details => {
      if (details?.frameId === 0) onNavigation(details.tabId, { sameDocument: true });
    });
    nav?.onCompleted?.addListener?.(details => {
      if (details?.frameId !== 0) return;
      const entry = pending.get(details.tabId);
      if (entry?.phase === 'navigated') probe(entry);
      if (getLinks().length) armTab(details.tabId).catch(() => {});
    });
    chromeApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
      if (changeInfo && 'groupId' in changeInfo && getLinks().length) armTab(tabId, tab?.status === 'complete' ? tab : null).catch(() => {});
    });
    chromeApi.tabs?.onRemoved?.addListener?.(tabId => {
      dropPending(tabId);
      vaultFills.delete(tabId);
      armed.delete(tabId);
    });
  }

  return {
    attach,
    armTab,
    rearmAll,
    handlePageMessage,
    onNavigation,
    probe: tabId => (pending.get(tabId) ? probe(pending.get(tabId)) : Promise.resolve()),
    getOffer,
    decide,
    windowClosed,
    getPrefs,
    setPrefs,
    noteVaultFill,
    forgetProduct,
    // Tests and diagnostics: never the values.
    pendingCount: () => pending.size,
    offerIds: () => [...offers.keys()],
    _peek: tabId => {
      const entry = pending.get(tabId);
      return entry ? { phase: entry.phase, origin: entry.origin, hasPassword: Boolean(entry.password) } : null;
    }
  };
}
