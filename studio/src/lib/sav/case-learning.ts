import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savAnalysisSnapshots, savDecisions, savAgentRuns, savDraftVerdicts, savMessages, savResolutionObservations, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { isSavCaseLearningFrozen, savRunProvenance } from "./config";
import type { SavStructuredProposal } from "./proposal";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
export async function captureSavAnalysisSnapshot(tx: Tx, runId: string, availableContext?: unknown) {
  if (isSavCaseLearningFrozen()) return null;
  const [run] = await tx.select().from(savAgentRuns).where(eq(savAgentRuns.id,runId));
  if (!run?.messageId || !run.proposalCiphertext || run.pilotBatchId) return null;
  const [message] = await tx.select().from(savMessages).where(eq(savMessages.id,run.messageId));
  if (!message) return null;
  const payload = { revision:"sav-case-baseline.v1", proposal:decryptSavPayload<SavStructuredProposal>(run.proposalCiphertext),
    message:{id:message.id,subject:message.subject,fromEmail:message.fromEmail,receivedAt:message.receivedAt,body:decryptSavPayload(message.bodyCiphertext)},
    availableContext:availableContext ?? null, contextCoverage:availableContext ? "captured_at_analysis" : "legacy_run_only",
    dataOrigin:run.dataOrigin,model:run.model,promptRevision:run.promptRevision,knowledgeRevision:run.knowledgeRevision,toolTrace:run.toolTrace,analysisCreatedAt:run.createdAt };
  await tx.insert(savAnalysisSnapshots).values({messageId:message.id,agentRunId:run.id,contentHash:savContentHash(payload),payloadCiphertext:encryptSavPayload(payload),codeRevision:run.codeRevision!=="unknown"?run.codeRevision:availableContext?savRunProvenance().codeRevision:"unknown"}).onConflictDoNothing();
  const [snapshot] = await tx.select().from(savAnalysisSnapshots).where(eq(savAnalysisSnapshots.agentRunId,run.id));
  return snapshot;
}
/** Caller owns the thread lock. One logical observation per confirmed thread/ticket,
 * with immutable per-message/run references retained as events and snapshots. */
export async function ensureSavCaseObservationTx(tx:Tx, messageId:string, origin:"dossier_validated"|"ticket_confirmed"|"draft_feedback") {
  if (isSavCaseLearningFrozen()) return null;
  const [message] = await tx.select().from(savMessages).where(eq(savMessages.id,messageId));
  if (!message) return null;
  const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id,message.threadId));
  const [decision]=await tx.select().from(savDecisions).where(and(eq(savDecisions.messageId,message.id),eq(savDecisions.isCurrent,true)));
  const [currentRun]=decision?.agentRunId?await tx.select().from(savAgentRuns).where(eq(savAgentRuns.id,decision.agentRunId)):[];
  if (!thread || !currentRun) return null;
  const snapshot = await captureSavAnalysisSnapshot(tx,currentRun.id);
  const rows = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.threadId,thread.id));
  const existing = rows.find(r=>r.hubspotTicketId===thread.hubspotTicketId) ?? rows.find(r=>!r.hubspotTicketId);
  if (existing) {
    await tx.update(savResolutionObservations).set({snapshotId:existing.snapshotId ?? snapshot?.id,hubspotTicketId:thread.hubspotTicketId,nextSyncAt:new Date(),closedCatchupUntil:null}).where(eq(savResolutionObservations.id,existing.id));
    return existing.id;
  }
  const [verdict]=origin==="draft_feedback"?await tx.select().from(savDraftVerdicts).where(and(eq(savDraftVerdicts.messageId,message.id),eq(savDraftVerdicts.isCurrent,true))):[];
  const [row] = await tx.insert(savResolutionObservations).values({threadId:thread.id,messageId,verdictId:verdict?.id??null,snapshotId:snapshot?.id,trackingOrigin:origin,hubspotTicketId:thread.hubspotTicketId,state:thread.hubspotTicketId?"active":"gmail_only"}).returning();
  await tx.insert(auditLogs).values({actorEmail:"system",action:"sav_case_tracking_started",entityType:"sav_resolution_observation",entityId:row.id,technicalMetadata:{messageId,origin,snapshotId:snapshot?.id ?? null}});
  return row.id;
}
