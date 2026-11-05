import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeExecutions, savIntakeRuns, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema } from "../intake/contract";
import type { ExecutionPayload } from "../intake/execution-types";
import { intakeHumanRefused } from "../intake/human-binding";
import type { ConfirmedV1Context } from "./admission-runtime";

/*
 * Pole A lot 2: `readConfirmedContext` for `v1QualificationPort`, READ ONLY. One repeatable-read,
 * read-only transaction over V1's own records: the message, its one execution, the runs of the
 * message and an operator's refusal. It writes nothing and calls nothing outside the database.
 * Not wired: nothing in production injects it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fault = (code: string): never => { throw Error(code); };

/** V1's stored decision of the message's execution, with what makes it current. No execution for the
 * message: null (no V1 context; the relay keeps hints, which never admit). Anything inconsistent in
 * V1's ledger (message missing or not inbound, thread or run of another message, run version apart, an
 * execution without a ticket, decision of another message, unreadable payload or a current-revision
 * decision the contract refuses) throws: unavailable
 * is never absent. An execution that is not confirmed, a newer run of the message, an operator's
 * refusal or an older contract revision are returned as they are: the adapter makes them unknown. */
export async function readConfirmedV1Context(messageId: string): Promise<ConfirmedV1Context | null> {
  if (!UUID.test(messageId)) fault("SAV_V1_CONTEXT_MESSAGE_INVALID");
  return requireDb().transaction(async tx => {
    const [message] = await tx.select({ id: savMessages.id, threadId: savMessages.threadId, direction: savMessages.direction, gmailMessageId: savMessages.gmailMessageId })
      .from(savMessages).where(eq(savMessages.id, messageId));
    if (!message) return fault("SAV_V1_CONTEXT_MESSAGE_MISSING");
    if (message.direction !== "inbound" || !message.gmailMessageId) return fault("SAV_V1_CONTEXT_SOURCE_INVALID");
    const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
    if (!execution) return null;
    if (execution.threadId !== message.threadId) fault("SAV_V1_CONTEXT_THREAD_MISMATCH");
    const runs = await tx.select({ id: savIntakeRuns.id, version: savIntakeRuns.version, messageId: savIntakeRuns.messageId })
      .from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
    if (execution.runId !== null) {
      const run = runs.find(candidate => candidate.id === execution.runId);
      if (!run) fault("SAV_V1_CONTEXT_RUN_MISSING");
      if (run!.version !== execution.runVersion) fault("SAV_V1_CONTEXT_RUN_VERSION_MISMATCH");
    }
    const decision = decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext)?.plan?.decision ?? fault("SAV_V1_CONTEXT_DECISION_MISSING");
    if (decision.messageId !== messageId) fault("SAV_V1_CONTEXT_DECISION_MESSAGE_MISMATCH");
    // An older revision is not re-validated against today's contract: it is simply not current.
    if (decision.revision === SAV_INTAKE_CONTRACT_REVISION && !savIntakeDecisionSchema.safeParse(decision).success) fault("SAV_V1_CONTEXT_DECISION_INVALID");
    return {
      decision,
      source: { messageId, gmailMessageId: message.gmailMessageId, executionId: execution.id, executionState: execution.state, runId: execution.runId,
        runVersion: execution.runVersion, ticketId: execution.ticketId ?? fault("SAV_V1_CONTEXT_TICKET_MISSING") },
      freshness: { latestRunVersion: Math.max(execution.runVersion, ...runs.map(run => run.version)), humanRefused: await intakeHumanRefused(messageId, tx) },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
