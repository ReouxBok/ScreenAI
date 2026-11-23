// The offer to save a login, service-worker side (TEAM-729, docs/login-vault.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLoginOffers, CAPTURE_TTL_MS, SUCCESS_WINDOW_MS, VAULT_PREFS_KEY, offerableOrigin
} from '../../../src/team/login-offers.js';

const EXT = 'chrome-extension://fpkgfhhomlijmhbgcpbpjnfafdedfccj/';
const ORIGIN = 'https://subscribe.free.fr';
const PASSWORD = 'Tr0ub4dor&3-captured';
const TOKEN = 'lmd_abcdefghijklmnopqrstuvwxyz012345';

function listeners() {
  const list = [];
  return { list, addListener: fn => list.push(fn), fire: (...args) => list.forEach(fn => fn(...args)) };
}

function setup({ tabUrl = `${ORIGIN}/login/`, groupId = 7, prefs, get = { status: 200, body: { items: [] } }, post = { status: 201, body: { updated: false } } } = {}) {
  const local = new Map(prefs ? [[VAULT_PREFS_KEY, prefs]] : []);
  const tabs = new Map([[812, { id: 812, url: tabUrl, groupId, status: 'complete' }]]);
  const nav = { onCommitted: listeners(), onHistoryStateUpdated: listeners(), onCompleted: listeners() };
  const probeResult = { ok: true, origin: ORIGIN, password_visible: false };
  const chromeApi = {
    runtime: { id: 'fpkgfhhomlijmhbgcpbpjnfafdedfccj', getURL: path => `${EXT}${path}` },
    storage: {
      local: {
        get: vi.fn(async key => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {})),
        set: vi.fn(async values => { for (const [key, value] of Object.entries(values)) local.set(key, structuredClone(value)); })
      }
    },
    tabs: {
      get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('no tab'); return { ...tabs.get(id) }; }),
      query: vi.fn(async () => [...tabs.values()]),
      onUpdated: listeners(),
      onRemoved: listeners()
    },
    scripting: {
      executeScript: vi.fn(async ({ func, args }) => [{ result: func.name === 'probeLoginForm' ? { ...probeResult } : { ok: true, installed: true, args } }])
    },
    // TEAM-757: no `windows` at all: the offer is a side-panel notice, so any window call would throw.
    webNavigation: nav
  };
  const fetchImpl = vi.fn(async (url, init) => {
    const answer = init.method === 'POST' ? post : get;
    return { status: answer.status, json: async () => answer.body };
  });
  const link = {
    product: { id: 'limova_team', label: 'Limova Team', color: '#7C3AED' },
    connection: { product: 'limova_team', environment: 'staging', device_token: TOKEN },
    browser: { currentGroupId: async () => 7 }
  };
  let ids = 0;
  const onChange = vi.fn();
  const offers = createLoginOffers({
    chromeApi, fetchImpl, timers: globalThis, now: () => Date.now(),
    randomId: () => `offer-${(ids += 1)}`, getLinks: () => [link], onChange
  });
  offers.attach();
  const sender = { id: chromeApi.runtime.id, tab: { id: 812 }, frameId: 0, origin: ORIGIN, url: tabUrl };
  // How many notices were shown so far (one id per offer).
  const shown = () => ids;
  return { chromeApi, fetchImpl, offers, tabs, nav, sender, probeResult, local, link, shown, onChange };
}

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

async function submitAndNavigate(ctx, { username = 'camille@example.com' } = {}) {
  await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_SUBMITTED', seq: 1, username, password: PASSWORD }, ctx.sender);
  ctx.nav.onCommitted.fire({ tabId: 812, frameId: 0 });
  ctx.nav.onCompleted.fire({ tabId: 812, frameId: 0 });
  await flush();
}

describe('login offers', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('asks after a login that navigated, in a side-panel notice that never holds the password', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    expect(ctx.fetchImpl).toHaveBeenCalledWith(
      'https://api.staging.team.limova.ai/api/v1/devices/me/login-secrets?origin=https%3A%2F%2Fsubscribe.free.fr',
      expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store', headers: expect.objectContaining({ Authorization: `Device ${TOKEN}` }) })
    );
    expect(ctx.shown()).toBe(1);
    expect(ctx.onChange).toHaveBeenCalled();
    expect(ctx.offers.listOffers()).toEqual([expect.objectContaining({ id: 'offer-1', product: 'limova_team', site: 'subscribe.free.fr', username: 'camille@example.com' })]);
    expect(JSON.stringify(ctx.offers.listOffers())).not.toContain(PASSWORD);
    const details = ctx.offers.getOffer('offer-1');
    expect(details).toEqual(expect.objectContaining({ origin: ORIGIN, site: 'subscribe.free.fr', username: 'camille@example.com', update: false }));
    expect(JSON.stringify(details)).not.toContain(PASSWORD);
  });

  it('posts the login on « Enregistrer », then forgets the password', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    const outcome = await ctx.offers.decide('offer-1', 'save', { username: ' camille@example.com ' });
    expect(outcome).toEqual({ ok: true, updated: false });
    const [url, init] = ctx.fetchImpl.mock.calls.at(-1);
    expect(url).toBe('https://api.staging.team.limova.ai/api/v1/devices/me/login-secrets');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'omit', cache: 'no-store' }));
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: `Device ${TOKEN}`, 'Content-Type': 'application/json' }));
    expect(JSON.parse(init.body)).toEqual({ origin: ORIGIN, username: 'camille@example.com', password: PASSWORD });
    expect(ctx.offers.offerIds()).toEqual([]);
    expect(await ctx.offers.decide('offer-1', 'save', {})).toEqual({ ok: false, error: 'expired' });
    // Nothing about the login was written to chrome.storage.
    expect(JSON.stringify(ctx.chromeApi.storage.local.set.mock.calls)).not.toContain(PASSWORD);
  });

  it('words the question « Mettre à jour » when that username is already saved', async () => {
    const ctx = setup({ get: { status: 200, body: { items: [{ id: 'x', label: 'Free', username: 'Camille@Example.com', has_totp: false }] } } });
    await submitAndNavigate(ctx);
    expect(ctx.offers.getOffer('offer-1').update).toBe(true);
  });

  it('asks after a sign-in that only removed the field', async () => {
    const ctx = setup();
    await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_SUBMITTED', seq: 4, username: 'u', password: PASSWORD }, ctx.sender);
    await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_FIELD_GONE', seq: 3 }, ctx.sender);
    await flush();
    expect(ctx.shown()).toBe(0);
    await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_FIELD_GONE', seq: 4 }, ctx.sender);
    await flush();
    expect(ctx.shown()).toBe(1);
  });

  it('drops a login that neither navigated nor removed the field within 10 s', async () => {
    const ctx = setup();
    await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_SUBMITTED', seq: 1, username: 'u', password: PASSWORD }, ctx.sender);
    expect(ctx.offers._peek(812)).toEqual({ phase: 'submitted', origin: ORIGIN, hasPassword: true });
    vi.advanceTimersByTime(SUCCESS_WINDOW_MS + 1);
    expect(ctx.offers._peek(812)).toBeNull();
    ctx.nav.onCommitted.fire({ tabId: 812, frameId: 0 });
    ctx.nav.onCompleted.fire({ tabId: 812, frameId: 0 });
    await flush();
    expect(ctx.shown()).toBe(0);
  });

  it('drops a login whose form shows again after the navigation (wrong password)', async () => {
    const ctx = setup();
    ctx.probeResult.password_visible = true;
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(0);
    expect(ctx.offers._peek(812)).toBeNull();
  });

  it('asks nothing, quietly, while the vault is off (404), and does not ask the server again for a while', async () => {
    const ctx = setup({ get: { status: 404, body: { detail: 'Not Found' } } });
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(0);
    const calls = ctx.fetchImpl.mock.calls.length;
    await submitAndNavigate(ctx);
    expect(ctx.fetchImpl.mock.calls.length).toBe(calls);
  });

  it('holds no password and asks nothing when the server says login_vault is off (ready.features)', async () => {
    const ctx = setup();
    ctx.link.features = { procedures: true, login_vault: false };
    await submitAndNavigate(ctx);
    expect(ctx.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.shown()).toBe(0);
    // An older server (no features) is asked as before.
    ctx.link.features = null;
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(1);
  });

  it('never watches the person\'s own tabs unless they opted in', async () => {
    const ctx = setup({ groupId: -1 });
    await submitAndNavigate(ctx);
    expect(ctx.offers.pendingCount()).toBe(0);
    expect(ctx.shown()).toBe(0);
    await ctx.offers.setPrefs('limova_team', { offer_in_own_tabs: true });
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(1);
  });

  it('ignores http: pages, blocked sites, iframes, other extensions and a sender that is not the tab\'s page', async () => {
    expect(offerableOrigin('http://subscribe.free.fr/login')).toBeNull();
    expect(offerableOrigin('https://www.linkedin.com/login')).toBeNull();
    expect(offerableOrigin('https://app.team.limova.ai/login')).toBeNull();
    for (const [patch, tabUrl] of [
      [{ origin: 'http://subscribe.free.fr', url: 'http://subscribe.free.fr/login/' }, 'http://subscribe.free.fr/login/'],
      [{ origin: 'https://www.linkedin.com', url: 'https://www.linkedin.com/login' }, 'https://www.linkedin.com/login'],
      [{ frameId: 3 }, undefined],
      [{ id: 'another-extension' }, undefined],
      [{ origin: 'https://evil.example', url: 'https://evil.example/' }, undefined]
    ]) {
      const ctx = setup(tabUrl ? { tabUrl } : {});
      await ctx.offers.handlePageMessage({ type: 'TEAM_LOGIN_SUBMITTED', seq: 1, username: 'u', password: PASSWORD }, { ...ctx.sender, ...patch });
      expect(ctx.offers.pendingCount(), JSON.stringify(patch)).toBe(0);
    }
  });

  it('does not offer to save what Limova just filled from the vault', async () => {
    const ctx = setup();
    ctx.offers.noteVaultFill({ tabId: 812, origin: ORIGIN });
    await submitAndNavigate(ctx);
    expect(ctx.offers.pendingCount()).toBe(0);
    expect(ctx.shown()).toBe(0);
    vi.advanceTimersByTime(2 * 60_000 + 1);
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(1);
  });

  it('forgets the password two minutes after the submission, and the notice goes away', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    await flush();
    expect(ctx.offers.offerIds()).toEqual(['offer-1']);
    vi.advanceTimersByTime(CAPTURE_TTL_MS);
    expect(ctx.offers.offerIds()).toEqual([]);
    expect(ctx.offers.listOffers()).toEqual([]);
    expect(await ctx.offers.decide('offer-1', 'save', {})).toEqual({ ok: false, error: 'expired' });
    expect(ctx.fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });

  it('« Pas maintenant » dismisses the notice, and the site is not asked again for 10 minutes', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    await flush();
    expect(await ctx.offers.decide('offer-1', 'later')).toEqual({ ok: true });
    expect(ctx.offers.offerIds()).toEqual([]);
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(1);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await submitAndNavigate(ctx);
    expect(ctx.shown()).toBe(2);
  });

  it('keeps one question per tab: a newer login replaces the open one', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    await flush();
    await submitAndNavigate(ctx, { username: 'other@example.com' });
    await flush();
    expect(ctx.offers.offerIds()).toEqual(['offer-2']);
    expect(ctx.offers.listOffers().map(offer => offer.username)).toEqual(['other@example.com']);
  });

  it('« Jamais pour ce site » keeps the origin only, and no longer watches it', async () => {
    const ctx = setup();
    await submitAndNavigate(ctx);
    expect(await ctx.offers.decide('offer-1', 'never')).toEqual({ ok: true });
    const stored = ctx.local.get(VAULT_PREFS_KEY);
    expect(stored).toEqual({ version: 1, products: { limova_team: { offer_in_own_tabs: false, never_origins: [ORIGIN] } } });
    expect(JSON.stringify(stored)).not.toContain('camille');
    await submitAndNavigate(ctx);
    expect(ctx.offers.pendingCount()).toBe(0);
    expect(ctx.shown()).toBe(1);
    await ctx.offers.setPrefs('limova_team', { remove_never: ORIGIN });
    expect((await ctx.offers.getPrefs('limova_team')).never_origins).toEqual([]);
  });

  it('turns the watcher on in eligible tabs and off when a tab leaves the group', async () => {
    const ctx = setup();
    expect(await ctx.offers.armTab(812)).toBe(true);
    expect(ctx.chromeApi.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 812, frameIds: [0] }, world: 'ISOLATED', args: [{}]
    }));
    ctx.tabs.get(812).groupId = -1;
    expect(await ctx.offers.armTab(812)).toBe(false);
    expect(ctx.chromeApi.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: [{ disabled: true }] }));
  });

  it('reports a failed save without keeping the password', async () => {
    const ctx = setup({ post: { status: 503, body: { detail: { code: 'vault_unavailable' } } } });
    await submitAndNavigate(ctx);
    expect(await ctx.offers.decide('offer-1', 'save', {})).toEqual({ ok: false, error: 'unavailable' });
    expect(ctx.offers.offerIds()).toEqual([]);
  });
});
