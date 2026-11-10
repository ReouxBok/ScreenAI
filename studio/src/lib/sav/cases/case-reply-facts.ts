// SAV-10 (pole C): the facts that make a prepared reply stale, read the same way by the submission, the decision and the executor's gate (one rule, one reader).
import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { savCaseEvents, savCases, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { ExecutionTx } from "../intake/execution-store";
import { caseAdmissionStatus } from "./admission-policy";
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
  const admission = status.admitted ? newer ? { admitted: false as const, reason: "input_newer" } : status
    : { admitted: false as const, reason: status.reason === "policy_missing" ? "policy_changed" : status.reason };
  const [stored] = await tx.select({ from: savMessages.fromEmail }).from(savMessages).where(eq(savMessages.id, proposal.inboundMessageId));
  return { admission, storedSender: stored?.from ?? null, caseVersion: row?.version ?? null, owner: row?.owner ?? null };
}
