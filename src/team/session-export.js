// session-export.js — « Envoyer ma session à Limova » (TEAM-729).
//
// docs/login-vault.md « Sessions: browser.v1+cookies », direction 2. From the Limova
// Team panel, for ONE site at a time and only after the person confirmed the consent
// screen for that site, the service worker reads that site's cookies with
// `chrome.cookies.getAll({domain})` and sends them to
// `POST /api/v1/devices/me/session-profiles`. The server encrypts the jar; nothing reads
// it yet (cloud browsers, TEAM-722 phase 4).
//
// - Only the registrable domain the person confirmed, and its subdomains: every cookie
//   whose domain (without its leading dot) is not `site` or under it is left out.
// - Never LinkedIn, never Limova's own domains (the Team dashboard session, Charly).
// - At most 300 cookies and 256 KiB of names and values together, checked here before
//   sending: a jar over the limit is refused rather than cut (a cut jar is a broken
//   session).
// - The cookies live in memory until the request is sent; they are never logged,
//   stored or shown. Charly never calls this: only the Team panel's message does.
//
// Without the Public Suffix List, the « registrable domain » is a best guess: the last
// two labels, or three under a known two-part suffix (co.uk, gouv.fr…). The server
// checks the site again.

import { apiErrorCode, apiOrigin, deviceAuthHeader } from './connections.js';
import { isBlockedHost } from './products.js';

export const MAX_COOKIES = 300;
export const MAX_COOKIE_BYTES = 256 * 1024;
const SAME_SITE = ['no_restriction', 'lax', 'strict', 'unspecified'];
// Second-level suffixes common for the people Limova serves. Not exhaustive.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'gouv.fr', 'asso.fr', 'nom.fr', 'com.fr', 'tm.fr',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'com.tw',
  'co.in', 'co.za', 'co.il', 'com.es', 'com.pt', 'co.it', 'com.be', 'gv.at', 'co.at',
  'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
  'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com'
]);
// Limova's own domains: the Team dashboard session must never become a session profile.
const OWN_SITES = ['limova.ai'];

function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * « free.fr » for « https://subscribe.free.fr/login », « Subscribe.Free.fr » or « free.fr ».
 * @returns {string|null} a lower-case, punycode registrable domain, or null
 */
export function siteOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  let host;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host || isIpAddress(host) || !host.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some(label => !label || label.length > 63)) return null;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const keep = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < keep) return null;
  return labels.slice(-keep).join('.');
}

// Sites whose cookies never leave: LinkedIn and Limova itself (and anything above them).
export function isBlockedSite(site) {
  if (!site) return true;
  if (isBlockedHost(site)) return true;
  return OWN_SITES.some(own => site === own || site.endsWith(`.${own}`) || own.endsWith(`.${site}`));
}

function cookieDomain(cookie) {
  return String(cookie?.domain || '').toLowerCase().replace(/^\./, '');
}

function inSite(domain, site) {
  return domain === site || domain.endsWith(`.${site}`);
}

/**
 * chrome.cookies.Cookie -> the contract's Cookie.
 * {name, value, domain, path, secure, http_only, same_site, expiration_date?, host_only?}
 */
export function mapCookie(cookie) {
  const out = {
    name: String(cookie.name ?? ''),
    value: String(cookie.value ?? ''),
    domain: String(cookie.domain ?? ''),
    path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
    secure: cookie.secure === true,
    http_only: cookie.httpOnly === true,
    same_site: SAME_SITE.includes(cookie.sameSite) ? cookie.sameSite : 'unspecified'
  };
  // A session cookie has no expiry; others carry whole epoch seconds.
  if (cookie.session !== true && Number.isFinite(cookie.expirationDate)) out.expiration_date = Math.floor(cookie.expirationDate);
  if (typeof cookie.hostOnly === 'boolean') out.host_only = cookie.hostOnly;
  return out;
}

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * The request body for one site, or why it cannot be sent.
 * @returns {{ok: true, body: {site: string, cookies: object[]}, count: number} | {ok: false, code: string}}
 */
export function buildSessionBody(site, chromeCookies) {
  if (!site || isBlockedSite(site)) return { ok: false, code: 'blocked_site' };
  const cookies = (Array.isArray(chromeCookies) ? chromeCookies : [])
    .filter(cookie => cookie && typeof cookie.name === 'string' && inSite(cookieDomain(cookie), site))
    .map(mapCookie);
  if (!cookies.length) return { ok: false, code: 'no_cookies' };
  if (cookies.length > MAX_COOKIES) return { ok: false, code: 'too_many' };
  let bytes = 0;
  for (const cookie of cookies) bytes += utf8Length(cookie.name) + utf8Length(cookie.value);
  if (bytes > MAX_COOKIE_BYTES) return { ok: false, code: 'too_large' };
  return { ok: true, body: { site, cookies }, count: cookies.length };
}

const HTTP_ERRORS = { 400: 'rejected', 401: 'revoked', 404: 'disabled', 413: 'too_large', 422: 'rejected', 503: 'unavailable' };

/**
 * Read one site's cookies and send them to the product's API. Call only after the
 * person confirmed the consent screen for exactly this site.
 * @returns {Promise<{ok: true, count: number, updated: boolean} | {ok: false, error: string}>}
 */
export async function exportSession({ connection, site, cookiesApi = globalThis.chrome?.cookies, fetchImpl = globalThis.fetch }) {
  const clean = siteOf(site);
  if (!clean || clean !== site) return { ok: false, error: 'invalid_site' };
  if (isBlockedSite(clean)) return { ok: false, error: 'blocked_site' };
  if (typeof cookiesApi?.getAll !== 'function') return { ok: false, error: 'unsupported' };
  const base = apiOrigin(connection);
  if (!base) return { ok: false, error: 'revoked' };
  let raw;
  try {
    raw = await cookiesApi.getAll({ domain: clean });
  } catch {
    return { ok: false, error: 'unsupported' };
  }
  const built = buildSessionBody(clean, raw);
  raw = null;
  if (!built.ok) return { ok: false, error: built.code };
  let response;
  try {
    response = await fetchImpl(`${base}/api/v1/devices/me/session-profiles`, {
      method: 'POST',
      headers: { Authorization: deviceAuthHeader(connection), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(built.body),
      credentials: 'omit',
      cache: 'no-store'
    });
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    built.body.cookies.length = 0;
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 200 || response.status === 201) {
    return { ok: true, count: built.count, updated: body?.updated === true };
  }
  // 400 says why in error.code (blocked_site, invalid_site, too_large).
  const code = response.status === 400 ? apiErrorCode(body) : null;
  if (['blocked_site', 'invalid_site', 'too_large'].includes(code)) return { ok: false, error: code };
  return { ok: false, error: HTTP_ERRORS[response.status] || 'unavailable' };
}
