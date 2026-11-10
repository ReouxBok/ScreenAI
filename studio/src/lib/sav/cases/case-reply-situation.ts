// SAV-10 (pole C), B-7: ONE situation reaches the customer at most once, whatever name its producers give it.
// A hand back gives the SAME stored customer mail a second name (`back:<owner_changed event>`, next to `inbound:<gmail id>`): two reply keys, so two approvals and two
// sends for one mail with no new customer input. The key stays what it is (one validation per payload, one execution per key, a cancelled key is never reused);
// this adds the missing question, asked by the same store, under the same case lock, on the stored facts: "is the situation this reply answers already taken?"
//   situation of `inbound:<gmail>` / `in:<event>`   the mail itself (`inbound:<gmail>`)
//   situation of `back:<event>`                       the latest customer mail recorded BEFORE that hand back (nothing newer can be the one it answers)
//   `timer:<id>` (J2 reminder) and a hand back with no customer mail before it   their own key: they are not a second reply to a mail
// A situation is taken by an APPROVED reply of the same case under another key that is not a spent-nothing cancellation: approved and not queued yet, queued and open,
// or with a ledger row past `planned` (marker, uncertain, confirmed). A reply that was declined, superseded, revoked, or cancelled before any send leaves nothing
// toward the customer, so it takes nothing (a person's takeover that cancelled it, then a hand back, is the very reason `back:` exists). A new REAL customer mail
// is a new situation (its own `inbound:` name). No resend permission is opened: refusing is the only thing added here. Pure reads: the caller holds the case lock.
// Three questions, one definition of "takes": at the store (`approval`, `queue`), and at the executor's gate before any marker (`…ForExecution`): two executions that were
// ALREADY queued (an older database, a resumed old pass) cannot both reach the provider. At the gate an OPEN sibling only wins when it is older (created first, id as tie):
// without that tie-break two passes racing for the case lock would each see the other open and cancel, so nobody would answer.
import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { savCaseEffectExecutions, savCaseEvents, savCaseReplyValidations, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { ExecutionTx } from "../intake/execution-store";
import type { CaseReplyProposal } from "./case-effects";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BACK = new RegExp(`^back:(${UUID})$`, "i");
const INBOUND = /^inbound:.+$/;

/** The canonical situation of a (stored, already canonical) trigger, or null when it is not a reply to a customer mail. */
export async function caseReplySituation(tx: ExecutionTx, caseId: string, triggerEventId: string): Promise<string | null> {
  if (INBOUND.test(triggerEventId)) return triggerEventId;
  const back = BACK.exec(triggerEventId);
  if (!back) return null;
  const [handBack] = await tx.select({ caseVersion: savCaseEvents.caseVersion }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.id, back[1]!.toLowerCase()), eq(savCaseEvents.kind, "owner_changed")));
  if (!handBack) return null;
  const [mail] = await tx.select({ dedupeKey: savCaseEvents.dedupeKey }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.kind, "inbound_confirmed"), lt(savCaseEvents.caseVersion, handBack.caseVersion)))
    .orderBy(desc(savCaseEvents.caseVersion)).limit(1);
  return mail && INBOUND.test(mail.dedupeKey) ? mail.dedupeKey : null;
}

export type CaseReplySituationTaker = Readonly<{ validationId: string; replyKey: string }>;

type Sibling = Readonly<{ validationId: string; replyKey: string; executionId: string | null; execution: { state: string; createdAt: Date; id: string } | null; ledger: string | null }>;

/** The approved replies of this case, under another key, that answer the same situation (read, never locked here). */
async function approvedSiblings(tx: ExecutionTx, input: Readonly<{ caseId: string; replyKey: string; triggerEventId: string }>): Promise<Sibling[]> {
  const situation = await caseReplySituation(tx, input.caseId, input.triggerEventId);
  if (situation === null) return [];
  const v = savCaseReplyValidations, found: Sibling[] = [];
  const approved = (await tx.select().from(v).where(and(eq(v.caseId, input.caseId), eq(v.state, "approved")))).filter(row => row.replyKey !== input.replyKey);
  for (const row of approved) {
    const other = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
    if (await caseReplySituation(tx, input.caseId, other.triggerEventId) !== situation) continue;
    const [execution] = row.executionId ? await tx.select({ id: savCaseEffectExecutions.id, state: savCaseEffectExecutions.state, createdAt: savCaseEffectExecutions.createdAt })
      .from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, row.executionId)) : [];
    const [reply] = row.executionId ? await tx.select({ state: savIntakeEffects.state }).from(savIntakeEffects)
      .where(and(eq(savIntakeEffects.businessKey, row.replyKey), eq(savIntakeEffects.kind, "reply_send"))) : [];
    found.push({ validationId: row.id, replyKey: row.replyKey, executionId: row.executionId, execution: execution ?? null, ledger: reply?.state ?? null });
  }
  return found;
}
const taker = (sibling: Sibling): CaseReplySituationTaker => ({ validationId: sibling.validationId, replyKey: sibling.replyKey });
/** Cancelled for good with nothing past `planned` in the ledger: nothing left toward the customer. Anything else may have left, or still can. */
const nothingLeft = (sibling: Sibling) => sibling.execution?.state === "refused" && (sibling.ledger === null || sibling.ledger === "planned");
/** A marker exists (or the execution says it confirmed / is unsure): the mail may have left. */
const mayHaveLeft = (sibling: Sibling) => sibling.ledger !== null && sibling.ledger !== "planned" || sibling.execution?.state === "confirmed" || sibling.execution?.state === "uncertain";

/**
 * The approved reply of this case, other than `replyKey`, that already takes the situation of `triggerEventId`, or null.
 * `approval`: an approved reply still waiting for its queue counts (nobody may approve a second one for the situation).
 * `queue`: only a reply that is queued counts (the one that got its execution first wins; two legacy approvals cannot both be queued).
 */
export async function findCaseReplySituationTaker(tx: ExecutionTx, input: Readonly<{ caseId: string; replyKey: string; triggerEventId: string; scope: "approval" | "queue" }>): Promise<CaseReplySituationTaker | null> {
  for (const sibling of await approvedSiblings(tx, input)) {
    if (!sibling.executionId) { if (input.scope === "approval") return taker(sibling); continue; }
    if (!nothingLeft(sibling)) return taker(sibling);
  }
  return null;
}

/**
 * The executor's gate, before any plan or marker of the reply of `executionId`: a sibling that may have left takes the situation; an OPEN queued sibling takes it only if it
 * was created first (so exactly one of several already-queued executions goes on, whichever wakes first); a sibling cancelled with nothing sent takes nothing.
 */
export async function findCaseReplySituationTakerForExecution(tx: ExecutionTx, input: Readonly<{ caseId: string; replyKey: string; triggerEventId: string; executionId: string }>): Promise<CaseReplySituationTaker | null> {
  const siblings = (await approvedSiblings(tx, input)).filter(sibling => sibling.executionId);
  if (!siblings.length) return null;
  const [self] = await tx.select({ id: savCaseEffectExecutions.id, createdAt: savCaseEffectExecutions.createdAt }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, input.executionId));
  for (const sibling of siblings) {
    if (nothingLeft(sibling)) continue;
    if (mayHaveLeft(sibling) || !self || !sibling.execution) return taker(sibling);
    const older = sibling.execution.createdAt.getTime() < self.createdAt.getTime() || sibling.execution.createdAt.getTime() === self.createdAt.getTime() && sibling.execution.id < self.id;
    if (older) return taker(sibling);
  }
  return null;
}
