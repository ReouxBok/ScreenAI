/** In-tab trail of Studio pages, so "Retour" always means the page the user was
 * on before (Ugo, 28/10), with its list, filter, page and anchor. Pure functions:
 * the client component stores the trail in sessionStorage. */
export const UI_HISTORY_KEY = "studio:ui-history:v1";
const MAX_ENTRIES = 50, MAX_HREF = 1800;

/** Same-origin Studio path only; never a protocol-relative or external target. */
export function safeStudioHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, "https://studio.invalid"); } catch { return null; }
  if (url.origin !== "https://studio.invalid" || !(url.pathname === "/studio" || url.pathname.startsWith("/studio/"))) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseHistory(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(safeStudioHref).filter((href): href is string => href !== null).slice(-MAX_ENTRIES) : [];
  } catch { return []; }
}

const path = (href: string) => href.split("#")[0];

/** A visit to the previous entry is a browser "back": the trail shrinks instead of looping. */
export function visit(trail: string[], href: string): string[] {
  const next = safeStudioHref(href);
  if (!next) return trail;
  const last = trail.at(-1);
  if (last !== undefined && path(last) === path(next)) return [...trail.slice(0, -1), next];
  const before = trail.at(-2);
  if (before !== undefined && path(before) === path(next)) return [...trail.slice(0, -2), next];
  return [...trail, next].slice(-MAX_ENTRIES);
}

/** Anchor changes on the current page are remembered in place. */
export function replaceCurrent(trail: string[], href: string): string[] {
  const next = safeStudioHref(href);
  if (!next || !trail.length || path(trail.at(-1)!) !== path(next)) return trail;
  return [...trail.slice(0, -1), next];
}

/** The page before the current one, or null when the user arrived directly. */
export function previousEntry(trail: string[], current: string): string | null {
  const here = safeStudioHref(current);
  if (!here || trail.length < 2 || path(trail.at(-1)!) !== path(here)) return null;
  return trail.at(-2) ?? null;
}
