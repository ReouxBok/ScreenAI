// SAV-10 (pole C): READ-ONLY views of the prepared replies for the Studio (UX owns the pages, this owns what they may truthfully say).
// Only SELECTs: nothing here decides, queues, sends or repairs. A view carries no ciphertext and no secret; the list carries neither the text nor the recipient
// (the single-reply read does, because the person validating must read exactly what would be sent). Access control belongs to the route that calls these.
import "server-only";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCaseTimers, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { EffectAck } from "../intake/execution-types";
import { readCaseEffectsMode, type CaseReplyProposal } from "./case-effects";
import { deriveCaseReplyStatus, type CaseEffectExecutionState, type CaseReplyStatus } from "./case-reply-status";
import { savCaseReplyValidations, type CaseReplyValidationRow } from "./case-reply-validation-table";
import { caseReplyApprovability, type CaseReplyApprovability, type CaseReplyValidationState } from "./case-reply-validation";

export const SAV_CASE_REPLY_LIST_MAX = 50;

export type CaseReplyEffectInfo = Readonly<{
  executionId: string; executionState: CaseEffectExecutionState; endedBy: string | null;
  /** The ledger row of the mail itself, or null while it is not planned. `gmailMessageId` is an id, never an address or a text. */
  reply: Readonly<{ state: string; dispatchedAt: string | null; confirmedAt: string | null; gmailMessageId: string | null; reconcileAttempts: number; nextReconcileAt: string | null }> | null;
}>;

export type CaseReplyListItem = Readonly<{
  id: string; caseId: string; replyKey: string; purpose: CaseReplyProposal["purpose"]; validation: CaseReplyValidationState; payloadHash: string; caseVersion: number;
  createdAt: string; decidedAt: string | null; revokedAt: string | null;
  /** Whether the Studio may offer "approve" now. WHO may is decided server side by the authorizer at the moment of the decision, never by this flag. */
  approvability: CaseReplyApprovability;
  status: CaseReplyStatus;
  effect: CaseReplyEffectInfo | null;
}>;

export type CaseReplyView = CaseReplyListItem & Readonly<{
  recipient: string; decidedBy: string | null; revokedBy: string | null; authorizationBasis: string | null;
  proposal: Readonly<{ subject: string; text: string; question: Readonly<{ id: string; text: string }> | null }>;
}>;

export type CaseReplyReadDeps = Readonly<{ env: () => Record<string, string | undefined> }>;
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;

async function build(rows: readonly CaseReplyValidationRow[], deps: CaseReplyReadDeps): Promise<{ row: CaseReplyValidationRow; proposal: CaseReplyProposal; item: CaseReplyListItem }[]> {
  if (!rows.length) return [];
  const db = requireDb(), mode = readCaseEffectsMode(deps.env()).mode;
  const executionIds = rows.flatMap(row => row.executionId ? [row.executionId] : []);
  const executions = executionIds.length ? await db.select().from(savCaseEffectExecutions).where(inArray(savCaseEffectExecutions.id, executionIds)) : [];
  const ledger = await db.select().from(savIntakeEffects).where(and(inArray(savIntakeEffects.businessKey, rows.map(row => row.replyKey)), eq(savIntakeEffects.kind, "reply_send")));
  const timers = await db.select().from(savCaseTimers).where(inArray(savCaseTimers.caseId, [...new Set(rows.map(row => row.caseId))]));
  return rows.map(row => {
    const proposal = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
    const execution = executions.find(candidate => candidate.id === row.executionId) ?? null;
    const effect = ledger.find(candidate => candidate.businessKey === row.replyKey) ?? null;
    const timer = effect ? timers.find(candidate => candidate.questionEffectId === effect.id) ?? null : null;
    const ack = effect?.ackCiphertext ? decryptSavPayload<EffectAck>(effect.ackCiphertext) : null;
    const status = deriveCaseReplyStatus({
      mode, validation: row.state as CaseReplyValidationState,
      execution: execution ? { state: execution.state as CaseEffectExecutionState, reason: execution.reason } : null,
      reply: effect ? effect.state as never : "none",
      timer: timer ? { state: timer.state as "scheduled" | "fired" | "cancelled", dueAt: timer.dueAt.toISOString() } : null,
    });
    const item: CaseReplyListItem = {
      id: row.id, caseId: row.caseId, replyKey: row.replyKey, purpose: proposal.purpose, validation: row.state as CaseReplyValidationState, payloadHash: row.payloadHash,
      caseVersion: row.caseVersion, createdAt: row.createdAt.toISOString(), decidedAt: iso(row.decidedAt), revokedAt: iso(row.revokedAt),
      approvability: caseReplyApprovability(mode, row.state as CaseReplyValidationState), status,
      effect: execution ? {
        executionId: execution.id, executionState: execution.state as CaseEffectExecutionState, endedBy: status.endedBy,
        reply: effect ? { state: effect.state, dispatchedAt: iso(effect.dispatchedAt), confirmedAt: iso(effect.confirmedAt), gmailMessageId: typeof ack?.id === "string" ? ack.id : null,
          reconcileAttempts: effect.reconcileAttempts, nextReconcileAt: iso(effect.nextReconcileAt) } : null,
      } : null,
    };
    return { row, proposal, item };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One reply, with the exact text and recipient the person validates. Null when it does not exist.
 * With `caseId`, the case filter is part of the query: a reply of another case is not even read, let alone decrypted.
 * The reader does no authentication: the route or page that calls it carries the staff check, before this call. */
export async function getCaseReplyEffect(input: Readonly<{ validationId: string; caseId?: string }>, deps: CaseReplyReadDeps): Promise<CaseReplyView | null> {
  if (!UUID.test(input.validationId) || input.caseId !== undefined && !UUID.test(input.caseId)) return null;
  const t = savCaseReplyValidations;
  const [row] = await requireDb().select().from(t).where(input.caseId ? and(eq(t.id, input.validationId), eq(t.caseId, input.caseId)) : eq(t.id, input.validationId));
  if (!row) return null;
  const [built] = await build([row], deps);
  return {
    ...built!.item, recipient: row.recipient, decidedBy: row.decidedBy, revokedBy: row.revokedBy, authorizationBasis: row.authorizationBasis,
    proposal: { subject: built!.proposal.subject, text: built!.proposal.text, question: built!.proposal.question ? { id: built!.proposal.question.id, text: built!.proposal.question.text } : null },
  };
}

/** Newest first, bounded, cursor-paged; no text and no recipient. */
export async function listCaseReplyEffects(input: Readonly<{
  caseId?: string; states?: readonly CaseReplyValidationState[]; limit?: number; before?: Readonly<{ createdAt: string; id: string }>;
}>, deps: CaseReplyReadDeps): Promise<{ items: CaseReplyListItem[]; next: { createdAt: string; id: string } | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), SAV_CASE_REPLY_LIST_MAX);
  const t = savCaseReplyValidations;
  // The cursor carries milliseconds (a JS Date); the column has microseconds, so both sides of the ordering are truncated to the same precision.
  const created = sql`date_trunc('milliseconds', ${t.createdAt})`;
  const filters = [
    input.caseId ? eq(t.caseId, input.caseId) : undefined,
    input.states?.length ? inArray(t.state, [...input.states]) : undefined,
    input.before ? or(sql`${created} < ${input.before.createdAt}::timestamptz`, and(sql`${created} = ${input.before.createdAt}::timestamptz`, lt(t.id, input.before.id))) : undefined,
  ].filter(Boolean);
  const rows = await requireDb().select().from(t).where(filters.length ? and(...filters) : undefined).orderBy(desc(created), desc(t.id)).limit(limit + 1);
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return { items: (await build(page, deps)).map(entry => entry.item), next: rows.length > limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
}
