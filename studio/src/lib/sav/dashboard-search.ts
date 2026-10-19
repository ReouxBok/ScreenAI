import "server-only";
import { createHmac } from "node:crypto";

/** Private deterministic index. No plaintext or unkeyed dictionary hashes.
 * It reveals length/repetition of grams: keep server-only, version with the
 * projection, and rebuild when the encryption key changes. */
function key() {
  const secret = process.env.SAV_ENCRYPTION_KEY_V1;
  if (!secret || secret.length < 32) throw new Error("SAV_ENCRYPTION_KEY_V1_MISSING");
  return createHmac("sha256", secret).update("sav-dashboard-search.v1").digest();
}
export function savDashboardSearchKeyRevision() {
  return createHmac("sha256", key()).update("projection-generation").digest("hex");
}
function token(value: string, secret: Buffer) {
  // JS includes() uses UTF-16 code units, including a possible partial surrogate
  // at the 200-unit query boundary. UTF-8 would merge distinct lone surrogates.
  return createHmac("sha256", secret).update(String(value.length)).update(Buffer.from(value, "utf16le")).digest("hex").slice(0, 32);
}
export function indexSavDashboardSearch(normalizedText: string) {
  const secret = key(), grams = new Set<string>(), stream: string[] = [];
  for (let i = 0; i < normalizedText.length; i++) for (let size = 1; size <= 3 && i + size <= normalizedText.length; size++) {
    const value = token(normalizedText.slice(i, i + size), secret);
    grams.add(value);
    if (size === 3) stream.push(value);
  }
  return { grams: [...grams], stream: `|${stream.join("|")}|` };
}
export function querySavDashboardSearch(normalizedQuery: string) {
  const secret = key(), size = Math.min(3, normalizedQuery.length), values: string[] = [];
  if (!size) return { grams: [], stream: null };
  for (let i = 0; i <= normalizedQuery.length - size; i++) values.push(token(normalizedQuery.slice(i, i + size), secret));
  return { grams: [...new Set(values)], stream: size < 3 ? null : `|${values.join("|")}|` };
}
