import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savAgentRuns, savMessages, savProposalReviews, savReviewedReplayCases, savReviewedReplayRuns } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload, savContentHash } from "./crypto";
import { publicKnowledgeText } from "@/lib/knowledge/conversion";
import { savV0EligibleMessageFilter } from "./cutover";
import { savRunProvenance } from "./config";
import { decisionKindSchema } from "./policy";
import { savStructuredProposalSchema } from "./proposal";
import { runSavRuleReplay, savReplayCaseSchema } from "./replay";

function ugoOnly(actorEmail: string) { if (actorEmail.trim().toLowerCase() !== "ugo@limova.ai") throw new Error("SAV_REPLAY_UGO_REQUIRED"); }
export async function createReviewedSavReplay(raw: unknown, actorEmail: string) {
  ugoOnly(actorEmail);
  const input = z.object({ reviewId: z.uuid(), title: z.string().trim().min(5).max(300), scenario: z.string().trim().min(20).max(5_000),
    expectedKind: decisionKindSchema, requiresHumanApproval: z.boolean(), anonymizationConfirmed: z.literal(true) }).strict().parse(raw);
  const db = requireDb();
  const [source] = await db.select({ review: savProposalReviews, fromEmail: savMessages.fromEmail }).from(savProposalReviews).innerJoin(savMessages, eq(savMessages.id, savProposalReviews.messageId))
    .where(and(eq(savProposalReviews.id, input.reviewId), eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"), savV0EligibleMessageFilter())).limit(1);
  if (!source) throw new Error("SAV_REPLAY_REVIEW_REQUIRED");
  const corrected = savStructuredProposalSchema.parse(decryptSavPayload(source.review.afterCiphertext));
  if (input.expectedKind !== corrected.decision.kind) throw new Error("SAV_REPLAY_EXPECTATION_MISMATCH");
  // Never copy the original mail. Ugo writes a synthetic scenario and explicitly
  // checks names, addresses and other identifiers that regex cannot guarantee.
  const sanitize = (s: string) => publicKnowledgeText(s.split(source.fromEmail).join("[client]").replace(/https?:\/\/\S+/gi, "[lien masqué]"));
  const testCase = savReplayCaseSchema.parse({ id: `review-${input.reviewId}`, partition: "control", input: { from: "client@example.invalid", subject: sanitize(input.title), body: sanitize(input.scenario) },
    expected: { kind: input.expectedKind, requiresHumanApproval: input.requiresHumanApproval } });
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(savReviewedReplayCases).values({ reviewId: input.reviewId, caseCiphertext: encryptSavPayload(testCase), contentHash: savContentHash(testCase), approvedBy: actorEmail }).onConflictDoNothing().returning();
    if (!created) throw new Error("SAV_REPLAY_ALREADY_EXISTS");
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_anonymized_replay_approved", entityType: "sav_replay_case", entityId: created.id, technicalMetadata: { reviewId: input.reviewId, contentHash: created.contentHash } });
    return { id: created.id };
  });
}

export async function getReviewedSavReplayCorpus() {
  const rows = await requireDb().select({ testCase: savReviewedReplayCases.caseCiphertext }).from(savReviewedReplayCases).innerJoin(savProposalReviews, eq(savProposalReviews.id, savReviewedReplayCases.reviewId))
    .innerJoin(savMessages, eq(savMessages.id, savProposalReviews.messageId)).where(and(eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"), savV0EligibleMessageFilter())).orderBy(savReviewedReplayCases.id).limit(1_001);
  const cases = rows.map((r) => savReplayCaseSchema.parse(decryptSavPayload(r.testCase)));
  return { cases, hash: savContentHash(cases), truncated: rows.length > 1_000 };
}

export async function runReviewedSavRuleReplay(actorEmail: string) {
  ugoOnly(actorEmail);
  const db = requireDb();
  const corpus = await getReviewedSavReplayCorpus();
  if (!corpus.cases.length) throw new Error("SAV_REPLAY_CORPUS_EMPTY");
  if (corpus.truncated) throw new Error("SAV_REPLAY_CORPUS_TOO_LARGE");
  const cases = corpus.cases;
  const report = runSavRuleReplay(cases);
  const corpusHash = corpus.hash;
  const [baseline] = await db.select().from(savReviewedReplayRuns).where(eq(savReviewedReplayRuns.corpusHash, corpusHash)).orderBy(desc(savReviewedReplayRuns.createdAt), desc(savReviewedReplayRuns.id)).limit(1);
  const codeRevision = savRunProvenance().codeRevision;
  return db.transaction(async (tx) => {
    const [run] = await tx.insert(savReviewedReplayRuns).values({ corpusHash, runnerRevision: "sav-rule-replay-v1", codeRevision, total: report.total, failed: report.failed,
      result: { scope: "deterministic_rules_only", regression: baseline ? report.failed > baseline.failed : null, baselineId: baseline?.id ?? null, results: report.results }, executedBy: actorEmail }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_reviewed_rule_replay_executed", entityType: "sav_replay_run", entityId: run.id, technicalMetadata: { total: run.total, failed: run.failed, codeRevision, corpusHash } });
    return { id: run.id };
  });
}

export async function listSavReplaySources() {
  return requireDb().select({ reviewId: savProposalReviews.id, messageId: savMessages.id, threadId: savMessages.threadId, verdict: savProposalReviews.verdict, model: savAgentRuns.model, prompt: savAgentRuns.promptRevision }).from(savProposalReviews)
    .innerJoin(savMessages, eq(savMessages.id, savProposalReviews.messageId)).innerJoin(savAgentRuns, eq(savAgentRuns.id, savProposalReviews.agentRunId))
    .where(and(eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"), savV0EligibleMessageFilter())).orderBy(desc(savProposalReviews.reviewedAt)).limit(50);
}
