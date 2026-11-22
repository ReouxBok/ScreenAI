// « Envoyer ma session à Limova » (TEAM-729, docs/login-vault.md « Sessions »).
import { describe, it, expect, vi } from 'vitest';
import {
  buildSessionBody, exportSession, isBlockedSite, mapCookie, MAX_COOKIE_BYTES, MAX_COOKIES, siteOf
} from '../../../src/team/session-export.js';

const CONNECTION = { product: 'limova_team', environment: 'staging', device_token: 'lmd_abcdefghijklmnopqrstuvwxyz012345' };

function chromeCookie(patch = {}) {
  return {
    name: 'sid', value: 'v4lue-secret', domain: '.free.fr', hostOnly: false, path: '/', secure: true,
    httpOnly: true, sameSite: 'lax', session: false, expirationDate: 1795680000.75, storeId: '0', ...patch
  };
}

describe('session export', () => {
  it('turns what the person typed or the tab URL into a registrable domain', () => {
    expect(siteOf('https://subscribe.free.fr/login?x=1')).toBe('free.fr');
    expect(siteOf('Subscribe.Free.fr')).toBe('free.fr');
    expect(siteOf('www.impots.gouv.fr')).toBe('impots.gouv.fr');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('notion.so')).toBe('notion.so');
    // A public suffix alone (gouv.fr, co.uk) is not a site.
    for (const bad of ['', 'localhost', '192.168.1.1', 'gouv.fr', 'co.uk', 'chrome://settings', 'a..b', 'exa mple.com']) {
      expect(siteOf(bad), bad).toBeNull();
    }
  });

  it('never exports LinkedIn or Limova\'s own sessions', () => {
    expect(isBlockedSite('linkedin.com')).toBe(true);
    expect(isBlockedSite('limova.ai')).toBe(true);
    expect(isBlockedSite('team.limova.ai')).toBe(true);
    expect(isBlockedSite('free.fr')).toBe(false);
    expect(buildSessionBody('limova.ai', [chromeCookie({ domain: '.limova.ai' })])).toEqual({ ok: false, code: 'blocked_site' });
  });

  it('maps Chrome\'s cookie fields to the contract\'s names', () => {
    expect(mapCookie(chromeCookie())).toEqual({
      name: 'sid', value: 'v4lue-secret', domain: '.free.fr', path: '/', secure: true, http_only: true,
      same_site: 'lax', expiration_date: 1795680000, host_only: false
    });
    const session = mapCookie(chromeCookie({ session: true, expirationDate: undefined, sameSite: 'weird', hostOnly: true, domain: 'subscribe.free.fr' }));
    expect(session).toEqual({ name: 'sid', value: 'v4lue-secret', domain: 'subscribe.free.fr', path: '/', secure: true, http_only: true, same_site: 'unspecified', host_only: true });
    expect('expiration_date' in session).toBe(false);
  });

  it('keeps only the site and its subdomains, and enforces 300 cookies and 256 KiB', () => {
    const body = buildSessionBody('free.fr', [
      chromeCookie(), chromeCookie({ domain: 'subscribe.free.fr', name: 'a' }),
      chromeCookie({ domain: '.notfree.fr', name: 'b' }), chromeCookie({ domain: '.free.fr.evil.com', name: 'c' })
    ]);
    expect(body.ok).toBe(true);
    expect(body.body.site).toBe('free.fr');
    expect(body.body.cookies.map(cookie => cookie.name)).toEqual(['sid', 'a']);
    expect(buildSessionBody('free.fr', [])).toEqual({ ok: false, code: 'no_cookies' });
    const many = Array.from({ length: MAX_COOKIES + 1 }, (_, i) => chromeCookie({ name: `c${i}`, value: 'x' }));
    expect(buildSessionBody('free.fr', many)).toEqual({ ok: false, code: 'too_many' });
    expect(buildSessionBody('free.fr', many.slice(0, MAX_COOKIES)).ok).toBe(true);
    const big = [chromeCookie({ name: 'big', value: 'x'.repeat(MAX_COOKIE_BYTES - 3) })];
    expect(buildSessionBody('free.fr', big).ok).toBe(true);
    big[0].value += 'x';
    expect(buildSessionBody('free.fr', big)).toEqual({ ok: false, code: 'too_large' });
    // Bytes, not characters: « é » is two bytes in UTF-8.
    expect(buildSessionBody('free.fr', [chromeCookie({ name: 'n', value: 'é'.repeat(MAX_COOKIE_BYTES / 2) })])).toEqual({ ok: false, code: 'too_large' });
  });

  it('reads one site\'s cookies and posts them with the device token', async () => {
    const cookiesApi = { getAll: vi.fn(async () => [chromeCookie(), chromeCookie({ domain: '.other.fr', name: 'x' })]) };
    const fetchImpl = vi.fn(async () => ({ status: 201, json: async () => ({ profile: { id: 'p1' }, updated: false }) }));
    const result = await exportSession({ connection: CONNECTION, site: 'free.fr', cookiesApi, fetchImpl });
    expect(result).toEqual({ ok: true, count: 1, updated: false });
    expect(cookiesApi.getAll).toHaveBeenCalledWith({ domain: 'free.fr' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.staging.team.limova.ai/api/v1/devices/me/session-profiles');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'omit', cache: 'no-store' }));
    expect(init.headers.Authorization).toBe(`Device ${CONNECTION.device_token}`);
    expect(JSON.parse(init.body)).toEqual({ site: 'free.fr', cookies: [mapCookie(chromeCookie())] });
  });

  it('refuses a site that is not a registrable domain, and reports server answers by code', async () => {
    const cookiesApi = { getAll: vi.fn(async () => [chromeCookie()]) };
    expect(await exportSession({ connection: CONNECTION, site: 'subscribe.free.fr', cookiesApi, fetchImpl: vi.fn() })).toEqual({ ok: false, error: 'invalid_site' });
    expect(cookiesApi.getAll).not.toHaveBeenCalled();
    const answer = (status, body) => vi.fn(async () => ({ status, json: async () => body }));
    expect(await exportSession({ connection: CONNECTION, site: 'free.fr', cookiesApi, fetchImpl: answer(404, {}) })).toEqual({ ok: false, error: 'disabled' });
    expect(await exportSession({ connection: CONNECTION, site: 'free.fr', cookiesApi, fetchImpl: answer(400, { error: { class: 'BadRequest', message: 'm', traceId: 't', code: 'too_large' } }) }))
      .toEqual({ ok: false, error: 'too_large' });
    expect(await exportSession({ connection: CONNECTION, site: 'free.fr', cookiesApi, fetchImpl: vi.fn(async () => { throw new Error('offline'); }) }))
      .toEqual({ ok: false, error: 'network' });
  });
});
