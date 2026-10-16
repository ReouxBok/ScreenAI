import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, contentItems, savAgentRuns, savDraftVerdicts, savReplyDrafts, savKnowledgeProposalDrafts } from "@/db/schema";
import { decryptSavPayload, savContentHash } from "./crypto";
import { assertSavActor } from "./access";
import { savStructuredProposalSchema } from "./proposal";
import { getSavKnowledgeDetail } from "@/lib/knowledge/workspace";
import { saveSavKnowledgeProposal } from "@/lib/knowledge/proposals";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";

export type SavLearningSignal = { kind: "knowledge_gap" | "draft_rejected" | "draft_changed" | "coherence_rejected" | "unknown_fact";
  domain: string; cardId: string | null; versionId: string | null; playbookVersionId: string; runId: string };
export function groupSavLearningSignals(signals: SavLearningSignal[]) {
  const seen = new Set<string>();
  const groups = new Map<string, { id: string; kind: SavLearningSignal["kind"]; domain: string; cardId: string | null; versionId: string | null; playbookVersionId: string; count: number; impact: number }>();
  for (const signal of signals) {
    const { runId, ...identity } = signal;
    void runId;
    const id = savContentHash(identity), group = groups.get(id);
    if (seen.has(`${id}:${runId}`)) continue;
    seen.add(`${id}:${runId}`);
    if (group) group.count++;
    else groups.set(id, { id, ...identity, count: 1, impact: signal.kind === "coherence_rejected" ? 3 : signal.kind === "draft_rejected" ? 2 : 1 });
  }
  return [...groups.values()].sort((a, b) => b.count * b.impact - a.count * a.impact || a.id.localeCompare(b.id));
}
/** Aggregate only, no customer text in groups, proposals, URLs or audit metadata. */
export async function listSavLearningSignals(actorEmail: string) {
  assertSavActor(actorEmail);
  const db = requireDb();
  const runs = await db.select().from(savAgentRuns).where(and(isNull(savAgentRuns.pilotBatchId), eq(savAgentRuns.dataOrigin, "real")))
    .orderBy(desc(savAgentRuns.createdAt)).limit(501);
  const rows = runs.slice(0, 500), ids = rows.map(r => r.id);
  const verdicts = ids.length ? await db.select().from(savDraftVerdicts).where(and(inArray(savDraftVerdicts.agentRunId, ids), eq(savDraftVerdicts.isCurrent, true))) : [];
  const draftIds = verdicts.flatMap(v => v.draftId ? [v.draftId] : []);
  const drafts = draftIds.length ? await db.select().from(savReplyDrafts).where(inArray(savReplyDrafts.id, draftIds)) : [];
  const signals: SavLearningSignal[] = [];
  for (const run of rows) {
    if (!run.proposalCiphertext) continue;
    const parsed = savStructuredProposalSchema.safeParse(decryptSavPayload(run.proposalCiphertext));
    if (!parsed.success || !parsed.data.replyAssessment?.harness) continue;
    const proposal = parsed.data, harness = proposal.replyAssessment!.harness!;
    const verdict = verdicts.find(v => v.agentRunId === run.id);
    const draft = drafts.find(d => d.id === verdict?.draftId);
    const changed = draft && decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text.trim() !== (proposal.replyDraft ?? "").trim();
    for (const plan of harness.plans) {
      const add = (kind: SavLearningSignal["kind"]) => signals.push({ kind, domain: plan.domain, cardId: plan.card?.id ?? null, versionId: plan.card?.versionId ?? null, playbookVersionId: harness.playbookVersionId, runId: run.id });
      if (plan.mode === "knowledge_gap") add("knowledge_gap");
      if (verdict?.status === "rejected") add("draft_rejected");
      if (changed && verdict?.status === "accepted") add("draft_changed");
      if (proposal.replyAssessment?.coherence?.status === "rejected") add("coherence_rejected");
      if (plan.limits.includes("unknown_fact_key")) add("unknown_fact");
    }
  }
  const grouped = groupSavLearningSignals(signals);
  const decisions = grouped.length ? await db.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_learning_signal_triaged"), inArray(auditLogs.entityId, grouped.map(g => g.id)))) : [];
  const groups = grouped.filter(g => !decisions.some(d => d.entityId === g.id));
  return { groups, scanned: rows.length, truncated: runs.length > 500 };
}
export async function triageSavLearningSignal(input: { groupId: string; decision: "prepare" | "reject" }, actorEmail: string) {
  assertSavActor(actorEmail);
  z.object({ groupId: z.string().length(43), decision: z.enum(["prepare", "reject"]) }).strict().parse(input);
  const group = (await listSavLearningSignals(actorEmail)).groups.find(g => g.id === input.groupId);
  if (!group) throw new Error("SAV_LEARNING_SIGNAL_STALE");
  const db = requireDb();
  return db.transaction(async tx => {
  // Match publication's item → revision lock order, and save on this same transaction.
  if (input.decision === "prepare" && group.cardId) await tx.select().from(contentItems).where(eq(contentItems.id, group.cardId)).for("update");
  const [lock] = await tx.select().from(activeKnowledge).where(eq(activeKnowledge.singleton, true)).for("update");
  if (!lock) throw new Error("SAV_LEARNING_SIGNAL_NOT_READY");
  const [decided] = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_learning_signal_triaged"), eq(auditLogs.entityId, group.id))).limit(1);
  if (decided) return { draftId: typeof decided.technicalMetadata.draftId === "string" ? decided.technicalMetadata.draftId : null };
  const reason = `Signal SAV ${group.id} : ${group.count} observations agrégées, classement humain. Compléter et sourcer avant soumission.`;
  let draftId: string | null = null;
  if (input.decision === "prepare") {
    const [prior] = await tx.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.reason, reason)).limit(1);
    if (prior) draftId = prior.id;
    else {
      const target = group.cardId ? await getSavKnowledgeDetail({ itemId: group.cardId }, actorEmail) : null;
      const document: CanonicalKnowledge = target?.document ?? { schemaVersion: 1, objective: `Procédure SAV à documenter : ${group.domain}`, applicability: "sav_only", locale: "fr-FR", productVersion: "", prerequisites: [], expectedResult: "", exceptions: [], escalation: "", steps: [] };
      const draft = await saveSavKnowledgeProposal({ mode: target ? "improve" : "new", targetItemId: target?.row.itemId ?? null,
        title: target?.row.title ?? document.objective, document, sources: [], reason }, actorEmail, tx);
      draftId = draft.id;
    }
  }
  await tx.insert(auditLogs).values({ actorEmail, action: "sav_learning_signal_triaged", entityType: "sav_learning_signal", entityId: group.id,
    technicalMetadata: { decision: input.decision, draftId } });
  return { draftId };
  });
}
