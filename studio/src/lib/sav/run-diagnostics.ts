import "server-only";
import { desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savAgentRuns, savMessages } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
import { savStructuredProposalSchema, savReplyAssessmentSchema } from "./proposal";
import { savValidationDiagnosticSchema } from "./validation-diagnostics";

/** Auth belongs to the route. This reader never opens, refreshes or reanalyses a dossier. */
export async function readSavRunDiagnostics(threadId: string) {
  const rows = await requireDb().select({ run: savAgentRuns }).from(savAgentRuns)
    .innerJoin(savMessages, eq(savMessages.id, savAgentRuns.messageId))
    .where(eq(savMessages.threadId, threadId)).orderBy(desc(savAgentRuns.createdAt), desc(savAgentRuns.id)).limit(10);
  return rows.map(({ run }) => {
    let proposal: ReturnType<typeof savStructuredProposalSchema.parse> | null = null;
    try { if (run.proposalCiphertext) proposal = savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext)); } catch { /* Historical/malformed data stays explicitly unavailable. */ }
    const traced = run.toolTrace.flatMap(t => {
      const parsed = savValidationDiagnosticSchema.safeParse(t.resultSummary?.validation);
      return parsed.success ? [parsed.data] : [];
    });
    const outcome = [...run.toolTrace].reverse().find(t => t.name === "sav_validation_outcome")?.resultSummary;
    const finalDiagnostics = Array.isArray(outcome?.validationDiagnostics) ? outcome.validationDiagnostics.flatMap(d => { const parsed = savValidationDiagnosticSchema.safeParse(d); return parsed.success ? [parsed.data] : []; }) : [];
    const recovery = savReplyAssessmentSchema.shape.recovery.safeParse(outcome?.recovery ?? undefined);
    const attempts = savReplyAssessmentSchema.shape.coherenceAttempts.safeParse(outcome?.coherenceAttempts ?? undefined);
    const diagnostics = [...finalDiagnostics, ...(proposal?.understanding?.trace.validationDiagnostics ?? []), ...(proposal?.replyAssessment?.validationDiagnostics ?? []), ...traced];
    const unique = diagnostics.filter((d, i) => diagnostics.findIndex(other => JSON.stringify(other) === JSON.stringify(d)) === i).slice(0, 12);
    return { runId: run.id, messageId: run.messageId, createdAt: run.createdAt, codeRevision: run.codeRevision,
      promptRevision: run.promptRevision, knowledgeRevision: run.knowledgeRevision, status: run.status, errorCode: run.errorCode,
      diagnostics: unique, historicalDetailUnavailable: !unique.length,
      proposalReadable: proposal !== null, recovery: recovery.success ? recovery.data ?? proposal?.replyAssessment?.recovery ?? null : null, coherenceAttempts: attempts.success ? attempts.data ?? proposal?.replyAssessment?.coherenceAttempts ?? [] : [], coherenceIssues: proposal?.replyAssessment?.coherence?.issues ?? [],
      plans: proposal?.replyAssessment?.harness?.plans.map(p => ({ mode: p.mode, missingFacts: p.missingFacts.length, hasStep: Boolean(p.nextCheck), procedureOptions: p.procedures?.length ?? 0 })) ?? [] };
  });
}
