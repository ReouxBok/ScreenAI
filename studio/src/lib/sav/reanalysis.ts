import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, contentItems, savActions, savDraftVerdicts, savKnowledgeActivations, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "./crypto";
import { listSavDossierDashboard } from "./dashboard";
import { collectSavDossierContext } from "./dossier-context";
import { analyzeSavMessage, type SavAnalysis } from "./intelligence";
import { withSavAiBudget } from "./gemini-transport";
import { savStructuredProposalSchema } from "./proposal";
import { SAV_UNDERSTANDING_PROMPT_REVISION } from "./understanding";
import { hasUnsettledSavHumanAction } from "./external-completion";
import { assertReanalysisApproval, reanalysisClaimId, reanalysisHash, reanalysisItemSchema, reanalysisManifestSchema,
  type ReanalysisApproval, type ReanalysisItem, type ReanalysisManifest, type ReanalysisTarget } from "./reanalysis-contract";

type Db = Pick<ReturnType<typeof requireDb>, "select" | "execute">;
export const SAV_REANALYSIS_SCOPE = "sav_reanalysis_candidate";
const claimAction = "sav_reanalysis_claim";
const cancelAction = "sav_reanalysis_cancelled";

export async function reanalysisResourcesHash(db: Db = requireDb()) {
  // Includes draft/settings edits conservatively; any change requires a fresh plan.
  const knowledge = await db.select().from(activeKnowledge);
  const activations = await db.select().from(savKnowledgeActivations);
  const content = await db.select().from(contentItems).where(eq(contentItems.agentKey, "sav"));
  return reanalysisHash({ knowledge: knowledge.sort((a, b) => a.revisionId.localeCompare(b.revisionId)),
    activations: activations.sort((a, b) => a.itemId.localeCompare(b.itemId)), content: content.sort((a, b) => a.id.localeCompare(b.id)) });
}
export async function currentReanalysisTarget(identity: Pick<ReanalysisTarget, "projectId" | "teamId" | "databaseHash" | "codeRevision">): Promise<ReanalysisTarget> {
  return { ...identity, resourcesHash: await reanalysisResourcesHash(), model: process.env.SAV_AI_MODEL ?? "gemini-3.6-flash", promptRevision: SAV_UNDERSTANDING_PROMPT_REVISION };
}

/** One READ ONLY MVCC snapshot. New candidates/claims deliberately cannot invalidate it. */
export async function readReanalysisBaseline(threadId: string, db?: Db): Promise<string> {
  if (!db) return requireDb().transaction(tx => readReanalysisBaseline(threadId, tx), { isolationLevel: "repeatable read", accessMode: "read only" });
  const result = await db.execute(sql`select jsonb_build_object(
    'thread', (select to_jsonb(t) from sav.threads t where t.id = ${threadId}::uuid),
    'messages', (select jsonb_agg(to_jsonb(m) order by m.id) from sav.messages m where m.thread_id = ${threadId}::uuid),
    'decisions', (select jsonb_agg(to_jsonb(d) order by d.id) from sav.decisions d join sav.messages m on m.id=d.message_id where m.thread_id=${threadId}::uuid),
    'runs', (select jsonb_agg(to_jsonb(r) order by r.id) from sav.agent_runs r where r.id in (select d.agent_run_id from sav.decisions d join sav.messages m on m.id=d.message_id where m.thread_id=${threadId}::uuid)),
    'reviews', (select jsonb_agg(to_jsonb(r) order by r.id) from sav.proposal_reviews r join sav.messages m on m.id=r.message_id where m.thread_id=${threadId}::uuid),
    'drafts', (select jsonb_agg(to_jsonb(r) order by r.id) from sav.reply_drafts r join sav.messages m on m.id=r.message_id where m.thread_id=${threadId}::uuid),
    'verdicts', (select jsonb_agg(to_jsonb(r) order by r.id) from sav.draft_verdicts r join sav.messages m on m.id=r.message_id where m.thread_id=${threadId}::uuid),
    'actions', (select jsonb_agg(to_jsonb(a) order by a.id) from sav.actions a where a.thread_id=${threadId}::uuid),
    'observations', (select jsonb_agg(to_jsonb(o) order by o.id) from sav.resolution_observations o where o.thread_id=${threadId}::uuid),
    'cycles', (select jsonb_agg(to_jsonb(c) order by c.id) from sav.observation_cycles c join sav.resolution_observations o on o.id=c.observation_id where o.thread_id=${threadId}::uuid),
    'followups', (select jsonb_agg(to_jsonb(f) order by f.id) from sav.followups f where f.thread_id=${threadId}::uuid),
    'pilots', (select jsonb_agg(to_jsonb(p) order by p.id) from sav.pilot_items p join sav.messages m on m.id=p.message_id where m.thread_id=${threadId}::uuid),
    'audit', (select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_logs a where a.action not like 'sav_reanalysis_%' and (a.entity_id=${threadId} or a.entity_id in (select m.id::text from sav.messages m where m.thread_id=${threadId}::uuid)))
  ) as snapshot`);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows;
  return reanalysisHash((rows[0] as { snapshot: unknown }).snapshot);
}

export async function prepareReanalysisItem(pair: { threadId: string; messageId: string }): Promise<ReanalysisItem | null> {
  // The dashboard supplies the exact existing view/cutover/Other/external-completion rules.
  const before = await readReanalysisBaseline(pair.threadId);
  const dashboard = await listSavDossierDashboard({ threadId: pair.threadId, view: "to_process", pageSize: 1 });
  const view = dashboard.counts.to_process ? "to_process" : dashboard.counts.to_validate ? "to_validate" : null;
  const selected = view === "to_process" ? dashboard : view ? await listSavDossierDashboard({ threadId: pair.threadId, view, pageSize: 1 }) : null;
  const row = selected?.rows[0];
  const [source] = await requireDb().select().from(savMessages).where(eq(savMessages.id, pair.messageId));
  const actions = await requireDb().select().from(savActions).where(eq(savActions.threadId, pair.threadId));
  if (!view || !row || row.messageId !== pair.messageId || row.technical || row.handledExternally || dashboard.counts.other
    || source?.analysisStatus !== "done" || hasUnsettledSavHumanAction(actions) || actions.some(a => a.status === "running")
    || ["pending", "uncertain"].includes(row.ticketProgress) || await readReanalysisBaseline(pair.threadId) !== before) return null;
  return reanalysisItemSchema.parse({ ...pair, receivedAt: row.receivedAt.toISOString(), view, baselineHash: before });
}

export async function prepareReanalysisManifest(input: { pairs: { threadId: string; messageId: string }[]; since: string; until: string; target: ReanalysisTarget }) {
  if (!input.pairs.length || input.pairs.length > 216 || new Set(input.pairs.map(p => p.threadId)).size !== input.pairs.length
    || new Set(input.pairs.map(p => p.messageId)).size !== input.pairs.length) throw new Error("SAV_REANALYSIS_SELECTION_REFUSED");
  // Validate identifiers before querying PostgreSQL.
  for (const pair of input.pairs) reanalysisItemSchema.pick({ threadId: true, messageId: true }).strict().parse(pair);
  const items: ReanalysisItem[] = [], excluded: { messageId: string; reason: string }[] = [];
  for (const pair of input.pairs) {
    const item = await prepareReanalysisItem(pair);
    if (item && Date.parse(item.receivedAt) >= Date.parse(input.since) && Date.parse(item.receivedAt) <= Date.parse(input.until)) items.push(item);
    else excluded.push({ messageId: pair.messageId, reason: "changed_or_outside_requested_views" });
  }
  if (await reanalysisResourcesHash() !== input.target.resourcesHash) throw new Error("SAV_REANALYSIS_RESOURCES_CHANGED");
  const now = new Date();
  const manifest = items.length ? reanalysisManifestSchema.parse({ version: 1, batchId: randomUUID(), mode: "candidate_only", target: input.target,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), since: input.since, until: input.until, items }) : null;
  return { manifest, excluded };
}

async function isCancelled(batchId: string, db: Db = requireDb()) {
  const [row] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, cancelAction), eq(auditLogs.entityId, batchId))).limit(1);
  return Boolean(row);
}
export async function cancelReanalysis(batchId: string) {
  // Stops the next call. An already dispatched call may finish; its candidate is quarantined.
  reanalysisManifestSchema.shape.batchId.parse(batchId);
  await requireDb().insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: cancelAction, entityType: "sav_reanalysis_batch", entityId: batchId });
}

async function claimItem(item: ReanalysisItem, manifest: ReanalysisManifest) {
  const id = reanalysisClaimId(item, manifest.target);
  return requireDb().transaction(async tx => {
    await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, item.threadId)).for("update");
    if (await isCancelled(manifest.batchId, tx) || await readReanalysisBaseline(item.threadId, tx) !== item.baselineHash
      || await reanalysisResourcesHash(tx) !== manifest.target.resourcesHash) return "stale" as const;
    const claims = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, claimAction), eq(auditLogs.entityId, item.messageId)));
    if (claims.some(c => c.technicalMetadata.state === "running")) return "uncertain" as const;
    const [inserted] = await tx.insert(auditLogs).values({ id, actorEmail: "ugo@limova.ai", action: claimAction, entityType: "sav_reanalysis_message", entityId: item.messageId,
      technicalMetadata: { version: 1, batchId: manifest.batchId, manifestHash: reanalysisHash(manifest), state: "running", baselineHash: item.baselineHash, codeRevision: manifest.target.codeRevision } })
      .onConflictDoNothing().returning({ id: auditLogs.id });
    return inserted ? "claimed" as const : "already_claimed" as const;
  });
}

export async function generateReanalysisCandidate(item: ReanalysisItem): Promise<SavAnalysis> {
  return withSavAiBudget(async () => {
    const [message] = await requireDb().select().from(savMessages).where(eq(savMessages.id, item.messageId));
    if (!message || message.threadId !== item.threadId) throw new Error("SAV_REANALYSIS_MESSAGE_CHANGED");
    const body = decryptSavPayload<{ text: string }>(message.bodyCiphertext);
    const dossierContext = await collectSavDossierContext(message.id, { persist: false });
    // Omitting persistence context is deliberate: no normal run, decision, queue or pause writes.
    return analyzeSavMessage({ from: message.fromEmail, subject: message.subject, body: body.text, dossierContext });
  });
}

export async function executeReanalysis(manifest: ReanalysisManifest, approval: ReanalysisApproval, target: ReanalysisTarget,
  generate: (item: ReanalysisItem) => Promise<SavAnalysis> = generateReanalysisCandidate) {
  if (process.env.SAV_REANALYSIS_EXECUTION_ENABLED !== "true") throw new Error("SAV_REANALYSIS_EXECUTION_DISABLED");
  assertReanalysisApproval(manifest, approval, target);
  if (approval.stage === "continuation") {
    const previous = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.action, claimAction),
      sql`${auditLogs.technicalMetadata}->>'batchId' = ${approval.reviewedPreviousBatch!}`));
    if (!previous.length || previous.some(row => row.technicalMetadata.state !== "ready" || row.technicalMetadata.codeRevision !== target.codeRevision))
      throw new Error("SAV_REANALYSIS_PREVIOUS_BATCH_NOT_READY");
  }
  const result: { messageId: string; state: string; candidateId?: string }[] = [];
  for (const item of manifest.items.filter(i => approval.messageIds.includes(i.messageId))) {
    // Approval expiry is checked between calls, never only at batch start.
    assertReanalysisApproval(manifest, approval, target);
    if (await isCancelled(manifest.batchId)) break;
    const fresh = await prepareReanalysisItem(item);
    if (!fresh || reanalysisHash(fresh) !== reanalysisHash(item)) { result.push({ messageId: item.messageId, state: "stale" }); break; }
    const claimed = await claimItem(item, manifest);
    if (claimed !== "claimed") { result.push({ messageId: item.messageId, state: claimed }); break; }
    const startedAt = new Date();
    let analysis: SavAnalysis | null = null;
    let state = "failed";
    try {
      analysis = await generate(item);
      savStructuredProposalSchema.parse(analysis.structuredProposal);
      state = analysis.diagnostics?.length || analysis.understanding?.status === "unavailable" || !analysis.replyDraft ? "degraded" : "ready";
    } catch { analysis = null; /* No raw provider error, source email or secret in audit metadata. */ }
    const current = await prepareReanalysisItem(item);
    if (!current || reanalysisHash(current) !== reanalysisHash(item)) state = "stale";
    const candidateId = await requireDb().transaction(async tx => {
      await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, item.threadId)).for("update");
      if (await isCancelled(manifest.batchId, tx)) state = "cancelled";
      if (await readReanalysisBaseline(item.threadId, tx) !== item.baselineHash || await reanalysisResourcesHash(tx) !== target.resourcesHash) state = "stale";
      let candidateCiphertext: string | null = null, outputHash: string | null = null;
      if (analysis?.structuredProposal) {
        const proposal = savStructuredProposalSchema.parse(analysis.structuredProposal);
        outputHash = reanalysisHash(proposal);
        // Separate encrypted audit envelope, deliberately absent from agent_runs:
        // historical/learning/health readers must never consume a comparison as a live analysis.
        candidateCiphertext = encryptSavPayload({ proposal, metadata: { scope: SAV_REANALYSIS_SCOPE, target,
          model: analysis.model, knowledgeRevision: analysis.knowledgeRevision ?? "not_consulted", startedAt, completedAt: new Date(), durationMs: Date.now() - startedAt.getTime(),
          diagnostics: analysis.diagnostics ?? [], understanding: analysis.understanding?.trace ?? null, generation: analysis.generationMetadata ?? null } });
      }
      await tx.update(auditLogs).set({ technicalMetadata: { version: 1, batchId: manifest.batchId, manifestHash: reanalysisHash(manifest),
        state, baselineHash: item.baselineHash, codeRevision: target.codeRevision, candidateCiphertext, outputHash } }).where(eq(auditLogs.id, reanalysisClaimId(item, target)));
      return candidateCiphertext ? reanalysisClaimId(item, target) : undefined;
    });
    result.push({ messageId: item.messageId, state, ...(candidateId ? { candidateId } : {}) });
    if (state !== "ready") break;
  }
  return result;
}

export async function compareReanalysis(manifest: ReanalysisManifest) {
  reanalysisManifestSchema.parse(manifest);
  const comparisons = [];
  for (const item of manifest.items) {
    const [claim] = await requireDb().select().from(auditLogs).where(eq(auditLogs.id, reanalysisClaimId(item, manifest.target)));
    if (!claim || claim.technicalMetadata.batchId !== manifest.batchId) continue;
    const candidateCiphertext = claim.technicalMetadata.candidateCiphertext;
    const current = await prepareReanalysisItem(item);
    // Output is private and includes customer content. CLI writes with exclusive mode 0600.
    const baseline = await requireDb().execute(sql`select r.proposal_ciphertext from sav.decisions d join sav.agent_runs r on r.id=d.agent_run_id where d.message_id=${item.messageId}::uuid and d.is_current=true`);
    const rows = (Array.isArray(baseline) ? baseline : (baseline as unknown as { rows: unknown[] }).rows) as { proposal_ciphertext: string | null }[];
    const [review] = await requireDb().select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, item.messageId), eq(savProposalReviews.isCurrent, true)));
    const [draft] = await requireDb().select().from(savReplyDrafts).where(and(eq(savReplyDrafts.messageId, item.messageId), eq(savReplyDrafts.isCurrent, true)));
    const [verdict] = await requireDb().select().from(savDraftVerdicts).where(and(eq(savDraftVerdicts.messageId, item.messageId), eq(savDraftVerdicts.isCurrent, true)));
    comparisons.push({ messageId: item.messageId, state: claim.technicalMetadata.state,
      stillCurrent: Boolean(current && reanalysisHash(current) === reanalysisHash(item) && await reanalysisResourcesHash() === manifest.target.resourcesHash),
      original: rows[0]?.proposal_ciphertext ? decryptSavPayload(rows[0].proposal_ciphertext) : null,
      humanReview: review ? { status: review.status, proposal: decryptSavPayload(review.afterCiphertext) } : null,
      savedDraft: draft ? { status: draft.status, body: decryptSavPayload(draft.bodyCiphertext) } : null,
      draftVerdict: verdict ? { status: verdict.status } : null,
      candidate: typeof candidateCiphertext === "string" ? decryptSavPayload<{ proposal: unknown }>(candidateCiphertext).proposal : null });
  }
  return comparisons;
}
