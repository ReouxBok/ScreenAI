// SAV-10 (pole C): the facts that make a prepared reply stale, read the same way by the submission, the decision and the executor's gate (one rule, one reader).
import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { savCaseEvents, savCases, savMessages, savCaseTimers } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { ExecutionTx } from "../intake/execution-store";
import { caseAdmissionStatus } from "./admission-policy";
import { revalidateFiredJ2, type J2CaseView, type J2CaseEventView } from "./timer-lifecycle";
import type { CaseTimer } from "./case-types";
import type { CaseReplyProposal } from "./case-effects";

export type CaseReplyFacts = Readonly<{
  /** `caseAdmissionStatus` of the case now; a customer message recorded after the version the person saw is `input_newer` even though the case was re-admitted for it. */
  admission: Readonly<{ admitted: true } | { admitted: false; reason: string }>;
  /** `fromEmail` of the stored inbound message the reply answers, null when unreadable. */
  storedSender: string | null;
  caseVersion: number | null;
  /** The case's LOCAL owner now (`sav.cases.owner`), null when the case row is missing. */
  owner: string | null;
}>;

export async function readCaseReplyFacts(tx: ExecutionTx, proposal: CaseReplyProposal, policyRevision: string | null, options: Readonly<{ lockCase: boolean }>): Promise<CaseReplyFacts> {
  const query = tx.select().from(savCases).where(eq(savCases.id, proposal.caseId));
  const [row] = options.lockCase ? await query.for("update") : await query;
  // A customer message recorded after the version the person saw makes the prepared reply stale, even though the case was re-admitted for that
  // message: `caseAdmissionStatus` alone answers "is the case admitted now", not "is THIS reply still the answer".
  const [newer] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, proposal.caseId), eq(savCaseEvents.kind, "inbound_confirmed"), gt(savCaseEvents.caseVersion, proposal.caseVersion))).limit(1);
  const status = !row ? { admitted: false as const, reason: "no_admission" }
    : caseAdmissionStatus({ owner: row.owner as "agent", admission: row.admissionCiphertext ? decryptSavPayload(row.admissionCiphertext) : null, admissionInputVersion: row.admissionInputVersion }, policyRevision);
  let admission = status.admitted ? newer ? { admitted: false as const, reason: "input_newer" } : status
    : { admitted: false as const, reason: status.reason === "policy_missing" ? "policy_changed" : status.reason };
  // Under the SAME case lock as approval / queue / dispatch: a human mail, closed case or obsolete wait cannot cross the last fence.
  if (proposal.purpose === "reminder" && row && admission.admitted) {
    const timerId = /^timer:[0-9a-f-]{36}$/i.test(proposal.triggerEventId) ? proposal.triggerEventId.slice(6) : null;
    const [timer] = timerId ? await tx.select().from(savCaseTimers).where(and(eq(savCaseTimers.caseId, proposal.caseId), eq(savCaseTimers.id, timerId))) : [];
    const events = await tx.select().from(savCaseEvents).where(eq(savCaseEvents.caseId, proposal.caseId)).limit(5001);
    const result = timer && events.length <= 5000 ? revalidateFiredJ2({
      timer: { ...timer, sentAt: timer.sentAt.toISOString(), dueAt: timer.dueAt.toISOString(), firedAt: timer.firedAt?.toISOString() ?? null, cancelledAt: timer.cancelledAt?.toISOString() ?? null } as CaseTimer,
      view: { caseId: row.id, version: row.version, owner: row.owner, phase: row.phase, sensitivity: row.sensitivity, body: decryptSavPayload<J2CaseView["body"]>(row.payloadCiphertext) },
      events: events.map(e => ({ ...e, occurredAt: e.occurredAt.toISOString(), detail: decryptSavPayload<{ detail: J2CaseEventView["detail"] }>(e.payloadCiphertext).detail })),
      pauses: [], activeHolds: [], reminderEffect: "none", now: new Date(),
    }) : null;
    if (result?.status !== "timer_conditions_met") admission = { admitted: false, reason: "j2_obsolete_or_deferred" };
  }
  const [stored] = await tx.select({ from: savMessages.fromEmail }).from(savMessages).where(eq(savMessages.id, proposal.inboundMessageId));
  return { admission, storedSender: stored?.from ?? null, caseVersion: row?.version ?? null, owner: row?.owner ?? null };
}
