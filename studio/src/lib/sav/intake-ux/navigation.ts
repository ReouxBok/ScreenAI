import { z } from "zod";

export const INTAKE_LIST_PATH = "/studio/sav/intake";
export const INTAKE_LIST_MEMORY = "sav:intake:last-list:v1";
const views = new Set(["processing", "learning", "missing_contact", "to_validate", "sensitive", "completed", "other"]);
const legacyViews = new Set(["to_process", "to_validate", "other", "completed", "learning", "sensitive", "missing_contact"]);
/** An explicit list destination, never a generic internal/external redirect. */
export function intakeListDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1800 || !value.startsWith("/") || /[\\\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, "https://studio.invalid"); } catch { return null; }
  if (url.origin !== "https://studio.invalid" || ![INTAKE_LIST_PATH, "/studio/sav"].includes(url.pathname)) return null;
  const params = new URLSearchParams();
  for (const [key, val] of url.searchParams) {
    if (params.has(key)) return null;
    if (key === "view" && (url.pathname === INTAKE_LIST_PATH ? views : legacyViews).has(val)) params.set(key, val);
    else if (key === "page" && /^\d{1,5}$/.test(val) && Number(val) >= 1 && Number(val) <= 10000) params.set(key, String(Number(val)));
    else if (key === "q" && val.length <= 120) params.set(key, val);
    else if (key === "mailbox" && z.uuid().safeParse(val).success) params.set(key, val);
    else if (key === "sort" && ["newest", "oldest"].includes(val)) params.set(key, val);
    else if (key === "legacy" && url.pathname === "/studio/sav" && val === "1") params.set(key, val);
    else return null;
  }
  if (url.hash && !/^#dossier-[0-9a-f-]{36}$/i.test(url.hash)) return null;
  return `${url.pathname}${params.size ? `?${params}` : ""}${url.hash}`;
}
export function intakeDossierHref(id: string, origin: string) {
  if (!z.uuid().safeParse(id).success) throw Error("INVALID_DOSSIER_ID");
  const from = intakeListDestination(origin) ?? INTAKE_LIST_PATH;
  return `${INTAKE_LIST_PATH}/${id}?${new URLSearchParams({ returnTo: `${from.split("#")[0]}#dossier-${id}` })}`;
}
export type IntakeListMemory = { href: string; y: number; focusId: string };
export function parseIntakeListMemory(value: unknown): IntakeListMemory | null {
  if (typeof value !== "string" || value.length > 2200) return null;
  try {
    const row = JSON.parse(value), href = intakeListDestination(row.href);
    return href && Number.isFinite(row.y) && row.y >= 0 && row.y <= 2_000_000 && /^dossier-[0-9a-f-]{36}$/i.test(row.focusId)
      ? { href, y: row.y, focusId: row.focusId } : null;
  } catch { return null; }
}
