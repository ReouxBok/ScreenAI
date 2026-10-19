import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import type { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { reanalysisHash, type ReanalysisTarget } from "./reanalysis-contract";

const approvals = new AsyncLocalStorage<{ operationId: string; targetHash: string; expiresAt: string }>();
/** Called only after authenticated server grant verification; never request input directly. */
export function withSavReanalysisAuthority<T>(authority: { operationId: string; target: ReanalysisTarget; expiresAt: string }, work: () => Promise<T>): Promise<T> {
  return approvals.run({ operationId: authority.operationId, targetHash: reanalysisHash(authority.target), expiresAt: authority.expiresAt }, work);
}
export function hasSavReanalysisAuthority(target: ReanalysisTarget) {
  const authority = approvals.getStore();
  return Boolean(authority && Date.parse(authority.expiresAt) > Date.now() && authority.targetHash === reanalysisHash(target));
}
/** Caller holds the same transaction advisory lock as server revocation. */
export async function assertSavReanalysisAdmission(db: ReturnType<typeof requireDb>, target: ReanalysisTarget) {
  const authority = approvals.getStore();
  if (!authority) return; // The separately gated CLI does not use a server grant.
  if (!hasSavReanalysisAuthority(target)) throw new Error("SAV_REANALYSIS_GRANT_REFUSED");
  const [revoked] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, "sav_reanalysis_revoked"), eq(auditLogs.entityId, authority.operationId))).limit(1);
  if (revoked) throw new Error("SAV_REANALYSIS_GRANT_REFUSED");
}
