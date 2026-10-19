import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const instant = z.iso.datetime({ offset: true });
export const reanalysisTargetSchema = z.object({
  projectId: z.string().min(1), teamId: z.string().min(1), databaseHash: digest,
  codeRevision: sha, promptRevision: z.string().min(1), model: z.string().min(1),
  resourcesHash: digest,
}).strict();
export const reanalysisItemSchema = z.object({
  threadId: z.uuid(), messageId: z.uuid(), receivedAt: instant,
  view: z.enum(["to_process", "to_validate"]), baselineHash: digest,
}).strict();
export const reanalysisManifestSchema = z.object({
  version: z.literal(1), batchId: z.uuid(), mode: z.literal("candidate_only"),
  target: reanalysisTargetSchema, createdAt: instant, expiresAt: instant, since: instant, until: instant,
  items: z.array(reanalysisItemSchema).min(1).max(216),
}).strict().superRefine((m, ctx) => {
  const created = Date.parse(m.createdAt), expires = Date.parse(m.expiresAt);
  if (expires <= created || expires - created > 86_400_000 || Date.parse(m.since) > Date.parse(m.until) || Date.parse(m.until) > created)
    ctx.addIssue({ code: "custom", message: "Invalid manifest window" });
  const messages = new Set<string>(), threads = new Set<string>();
  for (const item of m.items) {
    const at = Date.parse(item.receivedAt);
    if (messages.has(item.messageId) || threads.has(item.threadId) || at < Date.parse(m.since) || at > Date.parse(m.until))
      ctx.addIssue({ code: "custom", message: "Duplicate or out-of-window item" });
    messages.add(item.messageId); threads.add(item.threadId);
  }
});
export type ReanalysisManifest = z.infer<typeof reanalysisManifestSchema>;
export type ReanalysisItem = z.infer<typeof reanalysisItemSchema>;
export type ReanalysisTarget = z.infer<typeof reanalysisTargetSchema>;
export const reanalysisApprovalSchema = z.object({
  version: z.literal(1), batchId: z.uuid(), manifestHash: digest, actor: z.literal("ugo@limova.ai"),
  mode: z.literal("candidate_only"), codeRevision: sha, expiresAt: instant,
  messageIds: z.array(z.uuid()).min(1).max(20),
  stage: z.enum(["first", "continuation"]),
  reviewedPreviousBatch: z.uuid().optional(),
}).strict();
export type ReanalysisApproval = z.infer<typeof reanalysisApprovalSchema>;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function reanalysisHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** Stable across batches: retrying the same snapshot/target cannot buy another call. */
export function reanalysisClaimId(item: ReanalysisItem, target: ReanalysisTarget): string {
  const hex = reanalysisHash({ messageId: item.messageId, baselineHash: item.baselineHash, target });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function assertReanalysisApproval(manifest: ReanalysisManifest, approval: ReanalysisApproval, target: ReanalysisTarget, now = Date.now()) {
  reanalysisManifestSchema.parse(manifest); reanalysisApprovalSchema.parse(approval);
  if (reanalysisHash(manifest.target) !== reanalysisHash(target) || approval.codeRevision !== target.codeRevision
    || approval.batchId !== manifest.batchId || approval.manifestHash !== reanalysisHash(manifest)
    || Date.parse(manifest.createdAt) > now || Date.parse(manifest.expiresAt) <= now
    || Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) > Date.parse(manifest.expiresAt)
    || new Set(approval.messageIds).size !== approval.messageIds.length
    || approval.messageIds.some(id => !manifest.items.some(item => item.messageId === id))
    || (approval.stage === "first" && approval.messageIds.length > 5)
    || (approval.stage === "continuation" && (!approval.reviewedPreviousBatch || approval.reviewedPreviousBatch === manifest.batchId))) {
    throw new Error("SAV_REANALYSIS_APPROVAL_REFUSED");
  }
}

/** Fresh standalone process only. Never turns an insecure URL into a trusted target. */
export function validateReanalysisRuntime(env: Record<string, string | undefined>) {
  const url = new URL(env.DATABASE_URL ?? "invalid:");
  if (env.NODE_ENV !== "production" || env.SAV_RELEASE_STAGE !== "v0" || env.SAV_PILOT_MODE !== "false"
    || env.VERCEL_ENV !== "production" || env.SAV_TEST_MODE === "true"
    || !env.VERCEL_PROJECT_ID || !env.VERCEL_ORG_ID || !/^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA ?? "")
    || env.SAV_CODE_REVISION && env.SAV_CODE_REVISION !== env.VERCEL_GIT_COMMIT_SHA
    || !["postgres:", "postgresql:"].includes(url.protocol) || url.searchParams.get("sslmode") !== "verify-full"
    || [...url.searchParams.keys()].some(key => key !== "sslmode") || url.hash
    || !env.SAV_ENCRYPTION_KEY_V1 || !env.SAV_GEMINI_API_KEY) throw new Error("SAV_REANALYSIS_RUNTIME_REFUSED");
  return { projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_ORG_ID,
    databaseHash: reanalysisHash({ host: url.hostname, port: url.port || "5432", database: url.pathname }),
    codeRevision: env.VERCEL_GIT_COMMIT_SHA! };
}
