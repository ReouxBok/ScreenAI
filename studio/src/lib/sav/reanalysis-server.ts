import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "./crypto";
import { reanalysisApprovalSchema, reanalysisHash, reanalysisManifestSchema, type ReanalysisManifest } from "./reanalysis-contract";
import { cancelReanalysis, compareReanalysis, currentReanalysisTarget, executeReanalysis, prepareReanalysisManifest } from "./reanalysis";
import { reanalysisServerIdentity } from "./reanalysis-database";
import { withSavReanalysisAuthority } from "./reanalysis-authority";

const identitySchema = z.object({ projectId: z.string().min(1), teamId: z.string().min(1), databaseHash: z.string().regex(/^[a-f0-9]{64}$/), codeRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const selectionSchema = z.object({ since: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }),
  pairs: z.array(z.object({ threadId: z.uuid(), messageId: z.uuid() }).strict()).min(1).max(216) }).strict();
const grantSchema = z.object({ version: z.literal(1), operationId: z.uuid(), actor: z.literal("ugo@limova.ai"),
  identity: identitySchema, selection: selectionSchema, createdAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }) }).strict();
const sealed = { operationId: z.uuid(), manifest: reanalysisManifestSchema, seal: z.string().min(20).max(4000) };
export const reanalysisServerRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("capabilities") }).strict(),
  z.object({ op: z.literal("authorize"), expectedIdentity: identitySchema, selection: selectionSchema, expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ op: z.literal("plan"), operationId: z.uuid(), messageIds: z.array(z.uuid()).min(1).max(20) }).strict(),
  z.object({ op: z.literal("execute"), ...sealed, approval: reanalysisApprovalSchema }).strict(),
  z.object({ op: z.literal("compare"), ...sealed }).strict(),
  z.object({ op: z.literal("cancel"), ...sealed }).strict(),
  z.object({ op: z.literal("revoke"), operationId: z.uuid() }).strict(),
]);
type Grant = z.infer<typeof grantSchema>;

async function readGrant(operationId: string): Promise<Grant> {
  const [row] = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.id, operationId), eq(auditLogs.action, "sav_reanalysis_authorized"),
    eq(auditLogs.actorEmail, "ugo@limova.ai"), eq(auditLogs.entityType, "sav_reanalysis_operation"), eq(auditLogs.entityId, operationId)));
  const [revoked] = await requireDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, "sav_reanalysis_revoked"), eq(auditLogs.entityId, operationId))).limit(1);
  if (!row || revoked || typeof row.technicalMetadata.envelopeCiphertext !== "string") throw new Error("SAV_REANALYSIS_GRANT_REFUSED");
  const grant = grantSchema.parse(decryptSavPayload(row.technicalMetadata.envelopeCiphertext));
  if (grant.operationId !== operationId || Date.parse(grant.expiresAt) <= Date.now() || reanalysisHash(grant.identity) !== reanalysisHash(reanalysisServerIdentity()))
    throw new Error("SAV_REANALYSIS_GRANT_REFUSED");
  return grant;
}
function assertManifestGrant(grant: Grant, manifest: ReanalysisManifest, seal: string) {
  const receipt = z.object({ operationId: z.uuid(), manifestHash: z.string(), expiresAt: z.string() }).strict().parse(decryptSavPayload(seal));
  if (receipt.operationId !== grant.operationId || receipt.manifestHash !== reanalysisHash(manifest) || receipt.expiresAt !== manifest.expiresAt
    || Date.parse(manifest.expiresAt) > Date.parse(grant.expiresAt) || manifest.since !== grant.selection.since || manifest.until !== grant.selection.until
    || manifest.items.length > 20 || manifest.items.some(item => !grant.selection.pairs.some(pair => pair.threadId === item.threadId && pair.messageId === item.messageId)))
    throw new Error("SAV_REANALYSIS_SEAL_REFUSED");
}

/** Authenticated route is the only caller; does not receive a model callback from HTTP. */
export async function runSavReanalysisServer(raw: unknown) {
  const input = reanalysisServerRequest.parse(raw);
  const identity = reanalysisServerIdentity();
  if (input.op === "capabilities") return { identity, mode: "candidate_only", maxSelection: 216, maxPlan: 20, maxExecute: 1 };
  if (input.op === "authorize") {
    if (reanalysisHash(input.expectedIdentity) !== reanalysisHash(identity) || Date.parse(input.expiresAt) <= Date.now()
      || Date.parse(input.expiresAt) > Date.now() + 4 * 3_600_000 || Date.parse(input.selection.since) >= Date.parse(input.selection.until)
      || Date.parse(input.selection.until) > Date.now() || new Set(input.selection.pairs.map(p => p.messageId)).size !== input.selection.pairs.length
      || new Set(input.selection.pairs.map(p => p.threadId)).size !== input.selection.pairs.length) throw new Error("SAV_REANALYSIS_AUTHORIZATION_REFUSED");
    const operationId = randomUUID();
    const grant = grantSchema.parse({ version: 1, operationId, actor: "ugo@limova.ai", identity, selection: input.selection, createdAt: new Date().toISOString(), expiresAt: input.expiresAt });
    await requireDb().insert(auditLogs).values({ id: operationId, actorEmail: grant.actor, action: "sav_reanalysis_authorized", entityType: "sav_reanalysis_operation", entityId: operationId,
      technicalMetadata: { envelopeCiphertext: encryptSavPayload(grant), selectionHash: reanalysisHash(grant.selection), selectedCount: grant.selection.pairs.length, expiresAt: grant.expiresAt, codeRevision: identity.codeRevision } });
    return { operationId, selectionHash: reanalysisHash(grant.selection), selectedCount: grant.selection.pairs.length, expiresAt: grant.expiresAt, identity };
  }
  const grant = await readGrant(input.operationId);
  if (input.op === "revoke") {
    // Deny new admission before cancelling batches, including a concurrent plan.
    await requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sav_reanalysis_executor_v1', 0))`);
      await tx.insert(auditLogs).values({ actorEmail: grant.actor, action: "sav_reanalysis_revoked", entityType: "sav_reanalysis_operation", entityId: grant.operationId });
    });
    const plans = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.action, "sav_reanalysis_plan_issued"), eq(auditLogs.entityId, grant.operationId)));
    for (const plan of plans) if (typeof plan.technicalMetadata.batchId === "string") await cancelReanalysis(plan.technicalMetadata.batchId);
    return { revoked: true };
  }
  const target = await currentReanalysisTarget(identity);
  if (input.op === "plan") {
    if (new Set(input.messageIds).size !== input.messageIds.length || input.messageIds.some(id => !grant.selection.pairs.some(pair => pair.messageId === id)))
      throw new Error("SAV_REANALYSIS_SELECTION_REFUSED");
    const planned = await prepareReanalysisManifest({ ...grant.selection, pairs: grant.selection.pairs.filter(pair => input.messageIds.includes(pair.messageId)), target });
    if (!planned.manifest) return { ...planned, seal: null };
    const manifest = { ...planned.manifest, expiresAt: new Date(Math.min(Date.parse(planned.manifest.expiresAt), Date.parse(grant.expiresAt))).toISOString() };
    reanalysisManifestSchema.parse(manifest);
    const seal = encryptSavPayload({ operationId: grant.operationId, manifestHash: reanalysisHash(manifest), expiresAt: manifest.expiresAt });
    await requireDb().insert(auditLogs).values({ actorEmail: grant.actor, action: "sav_reanalysis_plan_issued", entityType: "sav_reanalysis_operation", entityId: grant.operationId,
      technicalMetadata: { batchId: manifest.batchId, manifestHash: reanalysisHash(manifest), count: manifest.items.length } });
    return { ...planned, manifest, seal };
  }
  assertManifestGrant(grant, input.manifest, input.seal);
  if (reanalysisHash(input.manifest.target) !== reanalysisHash(target)) throw new Error("SAV_REANALYSIS_TARGET_CHANGED");
  if (input.op === "compare") return { comparisons: await compareReanalysis(input.manifest) };
  if (input.op === "cancel") { await cancelReanalysis(input.manifest.batchId); return { cancelled: true }; }
  if (input.approval.messageIds.length !== 1 || input.approval.stage === "first" && input.manifest.items.length > 5)
    throw new Error("SAV_REANALYSIS_TRANCHE_REFUSED");
  return withSavReanalysisAuthority({ operationId: grant.operationId, target, expiresAt: grant.expiresAt }, async () => {
    // Recheck revocation/expiry immediately before dispatch admission.
    await readGrant(grant.operationId);
    return { results: await executeReanalysis(input.manifest, input.approval, target) };
  });
}
