/** Local SYN transport only. No Clerk tenant, customer identity or production permission. */
export const SYN_EMAIL = "operator.syn@example.invalid";
export const SYN_ACTOR = "00000000-0000-4000-8000-000000000004";
export function synPreviewEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "development" && !env.VERCEL && env.SAV_SYN_PREVIEW === "true"
    && /^pglite:(?:\/private\/tmp\/studio-synthetic-preview|\/private\/tmp\/studio-synthetic-visual)\/\.sav-preview\/sav-preview-db$/.test(env.DATABASE_URL ?? "")
    && /^[a-f0-9]{64}$/.test(env.SAV_SYN_TOKEN ?? "")
    && env.SAV_WRITES_DISABLED === "true" && env.SAV_AI_ANALYSIS === "false";
}
export function synRequestAuthorized(h: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env) {
  if (!synPreviewEnabled(env) || !/^127\.0\.0\.1:\d+$/.test(h.get("host") ?? "")) return false;
  const expected = `Basic ${Buffer.from(`SYN:${env.SAV_SYN_TOKEN}`).toString("base64")}`;
  const actual = h.get("authorization") ?? "";
  // Fixed-length comparison; token is generated per isolated local service.
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
  return diff === 0;
}
export const synStaff = () => ({ id: SYN_ACTOR, clerkId: "syn-operator", actorId: "syn-operator", email: SYN_EMAIL,
  name: "Opérateur SYN", role: "admin" as const, active: true, createdAt: new Date(0), updatedAt: new Date(0) });
