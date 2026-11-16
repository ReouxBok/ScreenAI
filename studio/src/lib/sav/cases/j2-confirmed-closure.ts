import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { savCaseEvents } from "@/db/schema";
import type { ExecutionTx } from "../intake/execution-store";
import type { CaseReplyProposal } from "./case-effects";
import { readCase, updateCaseRecord } from "./case-store";
import { caseTeamPartPending } from "./case-ticket-stage-queue";

/** Called only inside the confirmed reply receipt transaction, under the case lock.
 * Administrative closure never claims resolution. A customer return clears the wait,
 * so a late receipt cannot close a case that has already resumed. */
export async function closeAfterConfirmedJ2(tx: ExecutionTx, proposal: CaseReplyProposal, replyKey: string, sentAt: Date,
  env: Record<string, string | undefined>) {
  if (env.SAV_V2_J2_CONTEXTUAL !== "on" || proposal.purpose !== "reminder" || !proposal.triggerEventId.startsWith("timer:")) return null;
  const current = await readCase(proposal.caseId, tx);
  if (!current || current.owner !== "agent" || current.sensitivity !== "none" || await caseTeamPartPending(tx, current)) return null;
  const [newInput] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents).where(and(
    eq(savCaseEvents.caseId, current.caseId), eq(savCaseEvents.kind, "inbound_confirmed"), gt(savCaseEvents.caseVersion, proposal.caseVersion),
  )).limit(1);
  if (newInput) return null;
  const already = current.phase === "closed_no_reply" && current.body.cycle.endedBy === "closed_no_reply";
  if (!already && (current.phase !== "awaiting_customer" || current.body.waiting?.timerId !== proposal.triggerEventId.slice(6))) return null;
  const snapshot = already ? current : await updateCaseRecord({ caseId: current.caseId, expectedVersion: current.version,
    actor: { type: "agent" }, phase: "closed_no_reply",
    body: { ...current.body, waiting: null, cycle: { ...current.body.cycle, endedBy: "closed_no_reply" } } }, tx);
  return { snapshot, trigger: { kind: "j2_confirmed" as const, replyKey, sentAt: sentAt.toISOString(), cycle: snapshot.body.cycle.number, caseVersion: snapshot.version } };
}
