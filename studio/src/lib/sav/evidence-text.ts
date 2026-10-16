/** Exact containment after canonical French typography only. No case folding,
 * accent removal, digit/unit conversion, fuzzy matching or source-ID changes. */
export const SAV_EVIDENCE_TEXT_REVISION = "sav-evidence-typography-2026-10-16.v1";
export function normalizeSavEvidenceText(value: string): string {
  return value.normalize("NFC").replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
    .replace(/[\u00ab\u201c\u201e]\s*/g, '"').replace(/\s*[\u00bb\u201d]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\s+/g, " ").trim();
}
export function savEvidenceContains(source: string, excerpt: string): boolean {
  const normalized = normalizeSavEvidenceText(excerpt);
  if (!normalized) return false;
  const text = normalizeSavEvidenceText(source);
  for (let offset = text.indexOf(normalized); offset >= 0; offset = text.indexOf(normalized, offset + 1)) {
    const before = text[offset - 1] ?? "", after = text[offset + normalized.length] ?? "";
    const startsToken = /^[\p{L}\p{N}]/u.test(normalized), endsToken = /[\p{L}\p{N}]$/u.test(normalized);
    if (startsToken && /[\p{L}\p{N}]/u.test(before) || endsToken && /[\p{L}\p{N}]/u.test(after)) continue;
    if (/^\d/.test(normalized) && /[-+−.,]/u.test(before)) continue;
    return true;
  }
  return false;
}
