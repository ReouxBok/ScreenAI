import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, knowledgeProjectionCandidates, savActions, savAgentRuns, savDecisions, savDeploymentReviews, savLearningCandidates, savMessages, savProposalReviews, savReviewedReplayRuns, savWebhookReceipts } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { getSavV0Cutover, savV0EligibleMessageFilter } from "./cutover";
import { evaluateSavPromotion, savConfidenceCalibrationError } from "./promotion";
import { z } from "zod";
import { getReviewedSavReplayCorpus } from "./reviewed-replay";
export type MetricRun = { id: string; model: string; promptRevision: string; knowledgeRevision: string | null; codeRevision: string; dataOrigin: string; runtime: string; category: string;
  status: string; confidence: number | null; verdict: string | null; dimensions: Record<string, string> | null; errorCode: string | null };
export function summarizeSavV0Runs(rows: MetricRun[]) {
  const grouped = new Map<string, MetricRun[]>();
  for (const row of rows) {
    const origin = row.runtime === "local_fixture" ? "simulation" : row.dataOrigin;
    const key = JSON.stringify([origin, row.model, row.promptRevision, row.knowledgeRevision, row.codeRevision, row.category]);
    const bucket = grouped.get(key) ?? [];
    bucket.push({ ...row, dataOrigin: origin });
    grouped.set(key, bucket);
  }
  return [...grouped].map(([key, runs]) => {
    const reviewed = runs.filter((r) => r.verdict);
    const verdicts = { correct: 0, partial: 0, incorrect: 0, critical: 0 };
    for (const row of reviewed) if (row.verdict && Object.hasOwn(verdicts, row.verdict)) verdicts[row.verdict as keyof typeof verdicts]++;
    const dimensions = Object.fromEntries(["classification", "routing", "grounding", "tone", "escalation"].map((dimension) => {
      const values = reviewed.map((r) => r.dimensions?.[dimension]).filter(Boolean);
      return [dimension, { reviewed: values.length, correct: values.filter((v) => v === "correct").length, critical: values.filter((v) => v === "critical").length }];
    }));
    return { id: savContentHash(key), version: { origin: runs[0].dataOrigin, model: runs[0].model, prompt: runs[0].promptRevision, knowledge: runs[0].knowledgeRevision ?? "unknown", code: runs[0].codeRevision, category: runs[0].category },
      runs: runs.length, reviewed: reviewed.length, verdicts, dimensions,
      degraded: runs.filter((r) => ["failed", "fallback"].includes(r.status)).length,
      externalErrors: runs.filter((r) => r.errorCode).length,
      calibrationError: reviewed.some((r) => r.confidence !== null) ? savConfidenceCalibrationError(reviewed) : null,
    };
  });
}

export async function getSavV0Dashboard() {
  const db = requireDb();
  const cutover = await getSavV0Cutover();
  const [raw, ingestion, incidents, pendingKnowledge, replays, decisions, duplicates, pendingResolutions, replayCorpus] = await Promise.all([
    db.select({ id: savAgentRuns.id, model: savAgentRuns.model, promptRevision: savAgentRuns.promptRevision, knowledgeRevision: savAgentRuns.knowledgeRevision, codeRevision: savAgentRuns.codeRevision, dataOrigin: savAgentRuns.dataOrigin, runtime: savAgentRuns.runtime,
      status: savAgentRuns.status, confidence: savAgentRuns.confidence, errorCode: savAgentRuns.errorCode, proposalCiphertext: savAgentRuns.proposalCiphertext, verdict: savProposalReviews.verdict, dimensions: savProposalReviews.dimensions }).from(savAgentRuns)
      .innerJoin(savMessages, eq(savMessages.id, savAgentRuns.messageId)).leftJoin(savProposalReviews, and(eq(savProposalReviews.agentRunId, savAgentRuns.id), eq(savProposalReviews.isCurrent, true)))
      .where(savV0EligibleMessageFilter()).orderBy(desc(savAgentRuns.createdAt), desc(savAgentRuns.id)).limit(5_001),
    db.select({ status: savMessages.analysisStatus, total: sql<number>`count(*)::int` }).from(savMessages).where(and(eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).groupBy(savMessages.analysisStatus),
    db.select({ total: sql<number>`count(*)::int` }).from(savWebhookReceipts).where(and(eq(savWebhookReceipts.status, "failed"), gte(savWebhookReceipts.receivedAt, new Date(cutover?.receivedAfter ?? Date.now())))),
    db.select({ total: sql<number>`count(*)::int` }).from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.status, "pending")),
    db.select().from(savReviewedReplayRuns).orderBy(desc(savReviewedReplayRuns.createdAt), desc(savReviewedReplayRuns.id)).limit(20),
    db.select().from(savDeploymentReviews).orderBy(desc(savDeploymentReviews.reviewedAt), desc(savDeploymentReviews.id)).limit(20),
    db.select({ total: sql<number>`count(*)::int` }).from(savDecisions).innerJoin(savMessages, eq(savMessages.id, savDecisions.messageId)).where(and(eq(savDecisions.isCurrent, true), eq(savDecisions.kind, "duplicate"), savV0EligibleMessageFilter())),
    db.select({ total: sql<number>`count(*)::int` }).from(savLearningCandidates).where(eq(savLearningCandidates.status, "pending")),
    getReviewedSavReplayCorpus(),
  ]);
  const rows: MetricRun[] = raw.slice(0, 5_000).map((r) => { let category = "unknown"; let errorCode = r.errorCode;
    if (r.proposalCiphertext) try { category = decryptSavPayload<{ category: string }>(r.proposalCiphertext).category ?? "unknown"; } catch { errorCode = "SAV_METRIC_PROPOSAL_UNREADABLE"; }
    return { ...r, category, errorCode }; });
  const versions = summarizeSavV0Runs(rows);
  const [failedActions] = await db.select({ total: sql<number>`count(*)::int` }).from(savActions).innerJoin(savMessages, eq(savMessages.id, savActions.messageId)).where(and(eq(savActions.status, "failed"), savV0EligibleMessageFilter()));
  const globalReviewed = rows.filter((r) => r.dataOrigin === "real" && r.runtime !== "local_fixture" && r.verdict).length;
  const gates = versions.map((v) => {
    const existing = evaluateSavPromotion({ versionReviewed: v.reviewed, versionCorrect: v.verdicts.correct, versionPartial: v.verdicts.partial, versionCritical: Math.max(v.verdicts.critical, ...Object.values(v.dimensions).map((d) => d.critical)), versionDegraded: v.degraded + v.externalErrors,
      versionCalibrationError: v.calibrationError ?? 100, globalReviewed, failedActions: (failedActions?.total ?? 0) + (incidents[0]?.total ?? 0) });
    const latestReplay = replays.find((r) => r.codeRevision === v.version.code && r.corpusHash === replayCorpus.hash && r.runnerRevision === "sav-rule-replay-v1");
    const reasons = [...existing.reasons, ...(v.version.origin !== "real" ? ["SAV_V0_REAL_DATA_REQUIRED"] : []),
      ...(!/^[a-f0-9]{40}$/.test(v.version.code) ? ["SAV_V0_CODE_VERSION_REQUIRED"] : []),
      ...(["unknown", "not_consulted", "unavailable"].includes(v.version.knowledge) ? ["SAV_V0_KNOWLEDGE_VERSION_REQUIRED"] : []),
      ...(raw.length > 5_000 ? ["SAV_V0_METRICS_TRUNCATED"] : []),
      ...(replayCorpus.truncated || !latestReplay || !latestReplay.total ? ["SAV_V0_REPLAY_REQUIRED"] : latestReplay.failed ? ["SAV_V0_REPLAY_FAILED"] : [])];
    return { ...v, gate: { eligible: reasons.length === 0, reasons, acceptanceRate: v.reviewed ? existing.acceptanceRate : null } };
  });
  const evidence = { cutover, versions: gates, ingestion, failedSyncs: incidents[0]?.total ?? 0, failedActions: failedActions?.total ?? 0, duplicates: duplicates[0]?.total ?? 0, pendingKnowledge: pendingKnowledge[0]?.total ?? 0, pendingResolutions: pendingResolutions[0]?.total ?? 0,
    replayCorpus: { hash: replayCorpus.hash, total: replayCorpus.cases.length, truncated: replayCorpus.truncated }, replay: replays.map(({ id, codeRevision, corpusHash, runnerRevision, total, failed }) => ({ id, codeRevision, corpusHash, runnerRevision, total, failed })), truncated: raw.length > 5_000 };
  return { ...evidence, snapshotHash: savContentHash(evidence), replayHistory: replays, decisions: decisions.map(({ reasonCiphertext, ...d }) => ({ ...d, reason: decryptSavPayload<{ text: string }>(reasonCiphertext).text })) };
}

export async function recordSavDeploymentDecision(raw: unknown, actorEmail: string) {
  if (actorEmail.trim().toLowerCase() !== "ugo@limova.ai") throw new Error("SAV_DEPLOYMENT_UGO_REQUIRED");
  const input = z.object({ snapshotHash: z.string(), versionId: z.string(), decision: z.enum(["hold", "request_promotion"]), reason: z.string().trim().min(20).max(2_000) }).strict().parse(raw);
  const dashboard = await getSavV0Dashboard();
  if (input.snapshotHash !== dashboard.snapshotHash) throw new Error("SAV_DEPLOYMENT_EVIDENCE_CHANGED");
  const version = dashboard.versions.find((v) => v.id === input.versionId);
  if (!version || input.decision === "request_promotion" && !version.gate.eligible) throw new Error("SAV_DEPLOYMENT_GATE_BLOCKED");
  return requireDb().transaction(async (tx) => {
    const [decision] = await tx.insert(savDeploymentReviews).values({ snapshotHash: dashboard.snapshotHash, decision: input.decision, reasonCiphertext: encryptSavPayload({ text: input.reason }),
      evidence: { version, cutover: dashboard.cutover, replay: dashboard.replay, failedActions: dashboard.failedActions, failedSyncs: dashboard.failedSyncs }, reviewedBy: actorEmail }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_deployment_decision_recorded", entityType: "sav_deployment_review", entityId: decision.id, technicalMetadata: { decision: input.decision, snapshotHash: dashboard.snapshotHash, versionId: version.id } });
    // No change of automation mode, knowledge publication, Git, or Vercel.
    return { id: decision.id };
  });
}
