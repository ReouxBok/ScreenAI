// products.js — The fixed list of Limova products the extension can connect to.
//
// TEAM-724 (parent TEAM-722, phase 6a). The browser engine is shared; each product
// gets its own connection, device token, tab group and colour, so two products never
// see each other's tabs or data. Limova Team is the first product; « Limova » will be
// added here later with its own origins.
//
// Origins are a FIXED allowlist: the extension never talks to an API or a dashboard
// that is not listed here, whatever a page, a message or a stored value says.
// Contract: docs/browser-device-protocol.md in the team-backend repository.

export const PRODUCTS = Object.freeze({
  limova_team: Object.freeze({
    id: 'limova_team',
    label: 'Limova Team',
    // Badge and side-panel accent. Chrome tab groups only accept named colours.
    color: '#7C3AED',
    groupColor: 'purple',
    groupTitle: 'Limova Team',
    groupBusyTitle: 'Limova Team · en cours',
    defaultEnvironment: 'production',
    environments: Object.freeze({
      production: Object.freeze({
        id: 'production',
        label: 'Production',
        api: 'https://api.team.limova.ai',
        dashboard: 'https://app.team.limova.ai'
      }),
      staging: Object.freeze({
        id: 'staging',
        label: 'Staging',
        api: 'https://api.staging.team.limova.ai',
        dashboard: 'https://staging.team.limova.ai'
      })
    }),
    // Hosts the agent must never drive: the dashboard is where the chat's confirmations and the
    // autonomy level live, so Limova must not click there. Covers every Team
    // environment (app., api., staging., api.staging.).
    ownHosts: Object.freeze(['team.limova.ai'])
  })
});

// Sites Limova never drives in a person's browser. LinkedIn goes through the
// LinkUp and DataForB2B tools on the server instead.
export const ALWAYS_BLOCKED_HOSTS = Object.freeze(['linkedin.com', 'lnkd.in']);

// Pages Chrome does not let extensions script, or that hold the person's
// extensions and settings.
const UNSCRIPTABLE_HOSTS = Object.freeze(['chromewebstore.google.com', 'chrome.google.com']);

export const AUTONOMY_LEVELS = Object.freeze(['ask_every_time', 'approve_for_me', 'full_access']);
// TEAM-726: a browser connection starts at « Accès complet »; confirmations the person
// wants happen in the chat, decided by the server from this level.
export const DEFAULT_AUTONOMY = 'full_access';

export function getProduct(productId) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, productId) ? PRODUCTS[productId] : null;
}

export function listProducts() {
  return Object.values(PRODUCTS);
}

export function getEnvironment(productId, environmentId) {
  const product = getProduct(productId);
  if (!product) return null;
  return Object.prototype.hasOwnProperty.call(product.environments, environmentId)
    ? product.environments[environmentId]
    : null;
}

// Every dashboard origin of every product, for the pairing callback check.
export function allDashboardOrigins() {
  return listProducts().flatMap(product => Object.values(product.environments).map(env => env.dashboard));
}

export function isAutonomyLevel(value) {
  return AUTONOMY_LEVELS.includes(value);
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

// Parse an http(s) URL, or return null. Rejects credentials in the URL too.
export function parseWebUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

// origin + pathname only: query strings and fragments often carry tokens.
export function safeUrl(value) {
  const url = parseWebUrl(value);
  return url ? `${url.origin}${url.pathname}` : null;
}

// « example.com » for https://www.example.com/a, or null.
export function domainOf(value) {
  const url = parseWebUrl(value);
  if (!url) return null;
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

// Hosts no product may drive: LinkedIn and every Limova product's own origins.
export function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (ALWAYS_BLOCKED_HOSTS.some(blocked => hostMatches(host, blocked))) return true;
  return listProducts().some(product => product.ownHosts.some(own => hostMatches(host, own)));
}

// The host suffixes isBlockedHost refuses, for the page functions that must check a
// frame's own host themselves (TEAM-751: a blocked frame is never read).
export function blockedHostSuffixes() {
  return [...ALWAYS_BLOCKED_HOSTS, ...listProducts().flatMap(product => product.ownHosts)];
}

/**
 * Classify a URL the agent asks to open or a page it wants to act on.
 * @returns {{ok: true, url: URL} | {ok: false, code: string}}
 *   `invalid_args` when it is not http(s) (only for URLs the agent sent),
 *   `blocked_site` for LinkedIn or a Limova dashboard/API,
 *   `page_unavailable` for pages Chrome does not let extensions script.
 */
export function classifyUrl(value, { fromAgent = false } = {}) {
  const url = parseWebUrl(value);
  if (!url) return { ok: false, code: fromAgent ? 'invalid_args' : 'page_unavailable' };
  const host = url.hostname.toLowerCase();
  if (isBlockedHost(host)) return { ok: false, code: 'blocked_site' };
  if (UNSCRIPTABLE_HOSTS.some(blocked => hostMatches(host, blocked))) {
    return { ok: false, code: fromAgent ? 'blocked_site' : 'page_unavailable' };
  }
  // Chrome's PDF viewer cannot be scripted; a URL ending in .pdf usually lands there.
  if (!fromAgent && /\.pdf$/i.test(url.pathname)) return { ok: false, code: 'page_unavailable' };
  return { ok: true, url };
}

// Only https favicons: never data:, chrome: or http: URLs.
export function safeFavicon(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}
