import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeAdmissionUsage, SAV_INTAKE_OPERATIONAL_PROFILE } from "../intake/budget-profile";
import { admissionLock, confirmExecutionEffect, deferExecutionEffect, executionJournal, recordEffectAck, type ExecutionTx } from "../intake/execution-store";
import type { Effect } from "../intake/execution-types";
import { lockCaseForWrite, hasLocalThreadForTicket, readCaseThreadlessSource, appendCaseEvent, updateCaseRecord, transitionCaseOwner } from "./case-store";
import { caseEffectHash, caseReplyKey, checkCaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { readCaseReplyFacts } from "./case-reply-facts";
import { caseReplyTextProblemForBasis, caseReplyModeForBasis } from "./case-reply-mode";
import { savCaseReplyValidations } from "./case-reply-validation-table";
import { savV2NewThreadEnabled, THREADLESS_ADMIT_PERMISSION, THREADLESS_CRM_PERMISSION, THREADLESS_SEND_PERMISSION } from "./threadless-config";
import { readThreadlessAuthority, threadlessAccessRevision, threadlessActionAllowed, threadlessAuthorityStillGranted, threadlessSchemaInstalled } from "./threadless-guard";
import { qualifyThreadlessTicket, readThreadlessTicket } from "./threadless-source";
import { buildNewThreadSendIntent, THREADLESS_MAILBOX, type createThreadlessTransport, type NewThreadAck, type NewThreadReceipt, type NewThreadSendIntent, type ThreadlessCrmAck } from "./threadless-transport";
import type { CaseRuntimeDeps } from "./case-runtime-effects";

const parents = savCaseEffectExecutions;
const ledger = savIntakeEffects;
const CRM_KIND = "new_thread_crm_email";
const SEND_KIND = "new_thread_send";
const CRM_PENDING = "new_thread_crm_pending";
const MAX_READS = 5;
const RECOVERY_DELAY_MS = 60_000;

type Parent = typeof parents.$inferSelect;
type Payload = { validationId: string; proposal: CaseReplyProposal };
type SendIntent = NewThreadSendIntent & { mailboxId: string };
type CrmIntent = { kind: typeof CRM_KIND; key: string; permission: typeof THREADLESS_CRM_PERMISSION; sent: SendIntent; receipt: NewThreadReceipt; contactId: string };
type Transport = ReturnType<typeof createThreadlessTransport>;
export type ThreadlessEffectPorts = {
  transport: Transport;
  readTicket?: typeof readThreadlessTicket;
  gmailPermissions: (mailbox: string, signal: AbortSignal) => Promise<void>;
};
type PassDeps = Pick<CaseRuntimeDeps, "env" | "deadlineMs" | "executionId"> & ThreadlessEffectPorts;

async function updateParent(tx: ExecutionTx, id: string, state: Parent["state"], reason: string | null) {
  await tx.update(parents).set({ state, reason, updatedAt: new Date() }).where(eq(parents.id, id));
}

async function waitBeforeSend(parent: Parent, reason: string, human: boolean) {
  await requireDb().transaction(async tx => {
    const [locked] = await tx.select().from(parents).where(eq(parents.id, parent.id)).for("update");
    if (!locked || locked.state === "refused" || locked.state === "confirmed") return;
    const [engaged] = await tx.select({ id: ledger.id }).from(ledger).where(eq(ledger.executionId, parent.id));
    if (engaged) return; // Another pass already wrote the marker. It alone owns the outcome.
    if (human) {
      const snapshot = await lockCaseForWrite(tx, parent.caseId);
      if (snapshot.owner === "agent" && snapshot.phase === "queued" && !snapshot.threadIds.length)
        await transitionCaseOwner({
          caseId: snapshot.caseId, expectedVersion: snapshot.version, transition: "handoff", actor: { type: "agent" },
          commandKey: `new-thread-wait.${parent.id}`, reason,
        }, tx);
    }
    await updateParent(tx, parent.id, human ? "refused" : "waiting", reason);
  });
}

/** The only transaction that may cross a marker. Commit the marker before any POST. No transition back to planned. */
async function mark(tx: ExecutionTx, parent: Parent, intent: SendIntent | CrmIntent) {
  const intentHash = caseEffectHash(intent);
  const [planned] = await tx.insert(ledger).values({
    executionId: parent.id, businessKey: intent.key, kind: intent.kind, permission: intent.permission,
    intentHash, intentCiphertext: encryptSavPayload(intent),
  }).onConflictDoNothing().returning();
  if (!planned) return null;
  await executionJournal(tx, parent.id, "effect_planned", { intentHash, kind: intent.kind, businessKey: intent.key }, planned.id);
  const at = new Date(), dispatchToken = randomUUID();
  const [marked] = await tx.update(ledger).set({
    state: "dispatched", dispatchToken, dispatchedAt: at, nextReconcileAt: new Date(at.getTime() + RECOVERY_DELAY_MS),
  }).where(eq(ledger.id, planned.id)).returning();
  await executionJournal(tx, parent.id, "dispatched", { attemptId: planned.attemptId, token: dispatchToken }, planned.id);
  await updateParent(tx, parent.id, "uncertain", `${intent.kind}_verification_pending`);
  return marked ?? null;
}

async function verifyAndPersist(parent: Parent, effect: Effect, deps: PassDeps, signal: AbortSignal) {
  const intent = decryptSavPayload<SendIntent | CrmIntent>(effect.intentCiphertext);
  if (!effect.dispatchedAt || intent.kind !== effect.kind || caseEffectHash(intent) !== effect.intentHash) throw Error("SAV_THREADLESS_EFFECT_INVALID");
  type Proof = { kind: typeof SEND_KIND; receipt: NewThreadReceipt } | { kind: typeof CRM_KIND; receipt: ThreadlessCrmAck };
  let proof: Proof | null = null;
  try {
    if (intent.kind === SEND_KIND) {
      const receipt = await deps.transport.verifySent(intent, effect.ackCiphertext ? decryptSavPayload<NewThreadAck>(effect.ackCiphertext) : null, effect.dispatchedAt, signal);
      if (receipt) proof = { kind: SEND_KIND, receipt };
    } else {
      const receipt = await deps.transport.verifyCrmEmail(intent.sent, intent.receipt, intent.contactId,
        effect.ackCiphertext ? decryptSavPayload<ThreadlessCrmAck>(effect.ackCiphertext) : null, signal);
      if (receipt) proof = { kind: CRM_KIND, receipt };
    }
  } catch { /* The read is counted below and stays verification-only. */ }
  const settle = (proof: Proof | null, reason: string) => requireDb().transaction(async tx => {
    const [lockedParent] = await tx.select({ id: parents.id }).from(parents).where(eq(parents.id, parent.id)).for("update");
    if (!lockedParent) return;
    const [current] = await tx.select().from(ledger).where(eq(ledger.id, effect.id)).for("update");
    if (!current || current.state === "confirmed" || current.attemptId !== effect.attemptId
        || current.ackCiphertext !== effect.ackCiphertext || current.reconcileAttempts !== effect.reconcileAttempts) return;
    if (!proof) {
      await deferExecutionEffect(current, reason, tx);
      await updateParent(tx, parent.id, "uncertain", reason);
      return;
    }
    const payload = decryptSavPayload<Payload>(parent.payloadCiphertext);
    if (intent.kind === SEND_KIND && proof.kind === SEND_KIND) {
      await persistVerifiedThread(tx, payload.proposal, intent, proof.receipt, current.id);
      await confirmExecutionEffect(current, proof.receipt, proof.receipt, tx);
      await updateParent(tx, parent.id, "waiting", CRM_PENDING);
    } else if (intent.kind === CRM_KIND && proof.kind === CRM_KIND) {
      const [message] = await tx.update(savMessages).set({ hubspotEmailId: proof.receipt.id }).where(and(
        eq(savMessages.mailboxId, intent.sent.mailboxId), eq(savMessages.gmailMessageId, intent.receipt.id), eq(savMessages.direction, "outbound"),
        or(isNull(savMessages.hubspotEmailId), eq(savMessages.hubspotEmailId, proof.receipt.id)),
      )).returning({ id: savMessages.id });
      if (!message) throw Error("SAV_THREADLESS_OUTBOUND_MISSING");
      await confirmExecutionEffect(current, proof.receipt, proof.receipt, tx);
      await updateParent(tx, parent.id, "confirmed", null);
    } else {
      throw Error("SAV_THREADLESS_RECEIPT_INVALID");
    }
  });
  try { await settle(proof, `${intent.kind}_unproven`); }
  catch (error) {
    if (!proof) throw error;
    // An identified external effect whose local transaction failed can only retry the receipt.
    await settle(null, `${intent.kind}_receipt_pending`);
  }
}

async function persistVerifiedThread(tx: ExecutionTx, proposal: CaseReplyProposal, intent: SendIntent, receipt: NewThreadReceipt, effectId: string) {
  const snapshot = await lockCaseForWrite(tx, proposal.caseId);
  const at = new Date(receipt.sentAt);
  const identity = and(eq(savThreads.mailboxId, intent.mailboxId), eq(savThreads.gmailThreadId, receipt.threadId));
  await tx.insert(savThreads).values({
    mailboxId: intent.mailboxId, gmailThreadId: receipt.threadId, hubspotTicketId: intent.ticketId, subject: intent.subject,
    customerEmail: intent.recipient, status: "awaiting_customer", lastMessageAt: at,
  }).onConflictDoNothing();
  const [thread] = await tx.select().from(savThreads).where(identity).for("update");
  if (!thread || snapshot.ticketId !== intent.ticketId || thread.customerEmail !== intent.recipient
      || thread.hubspotTicketId !== null && thread.hubspotTicketId !== intent.ticketId) throw Error("SAV_THREADLESS_THREAD_CONFLICT");
  await tx.update(savThreads).set({
    hubspotTicketId: intent.ticketId, lastMessageAt: sql`greatest(${savThreads.lastMessageAt}, ${at.toISOString()}::timestamptz)`, updatedAt: new Date(),
  }).where(eq(savThreads.id, thread.id));
  const [outbound] = await tx.insert(savMessages).values({
    mailboxId: intent.mailboxId, gmailMessageId: receipt.id, threadId: thread.id, direction: "outbound",
    fromEmail: THREADLESS_MAILBOX, toEmails: [intent.recipient], subject: intent.subject, receivedAt: at, processedAt: at,
    bodyCiphertext: encryptSavPayload({ text: intent.text, headers: { "message-id": intent.rfcMessageId } }),
  }).onConflictDoNothing().returning({ id: savMessages.id });
  if (!outbound) throw Error("SAV_THREADLESS_MESSAGE_CONFLICT");
  const logged = await appendCaseEvent({
    caseId: snapshot.caseId, threadId: thread.id, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: `outbound:${receipt.id}`,
    sourceRef: { type: "email", id: receipt.id }, occurredAt: receipt.sentAt,
    detail: { effectId, purpose: proposal.purpose, triggerEventId: proposal.triggerEventId, gmailThreadId: receipt.threadId },
  }, tx);
  if (snapshot.owner === "agent" && snapshot.phase === "queued" && snapshot.version === proposal.caseVersion)
    await updateCaseRecord({
      caseId: snapshot.caseId, expectedVersion: logged.version, actor: { type: "agent" }, phase: "awaiting_customer",
      body: { ...snapshot.body, waiting: { kind: "customer", reasonCode: "threadless_first_contact", since: receipt.sentAt } },
    }, tx);
}

const canVerify = (effect: Effect) => effect.state !== "planned" && effect.state !== "confirmed"
  && effect.reconcileAttempts < MAX_READS && (!effect.nextReconcileAt || effect.nextReconcileAt <= new Date());

async function passOne(parent: Parent, deps: PassDeps) {
  const env = deps.env(), db = requireDb();
  const signal = AbortSignal.timeout(Math.max(1, Math.min(30_000, deps.deadlineMs - Date.now())));
  const effects = await db.select().from(ledger).where(eq(ledger.executionId, parent.id));
  const gmail = effects.find(row => row.kind === SEND_KIND), crm = effects.find(row => row.kind === CRM_KIND);
  const engaged = gmail?.state === "confirmed" ? crm : gmail;
  if (engaged) {
    if (canVerify(engaged)) await verifyAndPersist(parent, engaged, deps, signal);
    return;
  }
  if (!await threadlessActionAllowed(env, db)) return;

  const { proposal, validationId } = decryptSavPayload<Payload>(parent.payloadCiphertext);
  const input = await readCaseThreadlessSource(db, parent.caseId, proposal.triggerEventId);
  if (!input?.source.contact || caseEffectHash(input.source) !== proposal.ticketSource?.version
      || parent.replyKey !== caseReplyKey(proposal.caseId, proposal.triggerEventId)) return;
  const kind = gmail ? CRM_KIND : SEND_KIND;
  const permission = gmail ? THREADLESS_CRM_PERMISSION : THREADLESS_SEND_PERMISSION;
  const authority = await readThreadlessAuthority(env, permission, input.observedAt);
  if (!authority || !gmail && !authority.policy.mutations.includes(THREADLESS_ADMIT_PERMISSION)) {
    if (!gmail) await waitBeforeSend(parent, "threadless_authority_unavailable", false);
    return;
  }
  if (!gmail) await deps.gmailPermissions(THREADLESS_MAILBOX, signal);
  const read = await (deps.readTicket ?? readThreadlessTicket)(input.source.ticketId, env);
  if (gmail && read.status === "closed") {
    // A concurrent CRM dispatch moves the parent out of this state under its lock.
    // In that case keep the marker eligible for verification.
    await db.update(parents).set({ state: "refused", reason: "crm_skipped_ticket_closed", updatedAt: new Date() })
      .where(and(eq(parents.id, parent.id), eq(parents.state, "waiting"), eq(parents.reason, CRM_PENDING)));
    return;
  }
  if (read.status === "unavailable") return;
  if (read.status !== "ready" || read.source.contact?.id !== input.source.contact.id || read.source.contact.email !== input.source.contact.email
      || !gmail && caseEffectHash(read.source) !== proposal.ticketSource.version) {
    if (!gmail) await waitBeforeSend(parent, read.status === "human_wait" ? read.reason : "threadless_source_changed", true);
    return;
  }
  const accessRevision = !gmail && (await qualifyThreadlessTicket(read.source, env)).status === "admitted"
    ? await threadlessAccessRevision(env, db) : null;
  if (!gmail && !accessRevision) return;

  const intent: SendIntent | CrmIntent = gmail
    ? { kind: CRM_KIND, key: `crm-email:${parent.replyKey}`, permission: THREADLESS_CRM_PERMISSION,
      sent: decryptSavPayload<SendIntent>(gmail.intentCiphertext), receipt: decryptSavPayload<NewThreadReceipt>(gmail.verificationCiphertext!),
      contactId: input.source.contact.id }
    : { ...buildNewThreadSendIntent({ key: parent.replyKey, ticketId: input.source.ticketId, recipient: proposal.recipient, subject: proposal.subject, text: proposal.text }),
      mailboxId: authority.mailboxId };

  const dispatched = await db.transaction(async tx => {
    if (kind === SEND_KIND) await admissionLock(tx);
    const [locked] = await tx.select().from(parents).where(eq(parents.id, parent.id)).for("update");
    if (!locked || locked.threadId || locked.state === "confirmed" || locked.state === "refused"
        || signal.aborted || !await threadlessActionAllowed(deps.env(), tx)
        || !await threadlessAuthorityStillGranted(tx, authority, permission)) return null;
    if (kind === SEND_KIND) {
      if (locked.policyId !== authority.config.policyId || locked.policyHash !== authority.config.policyHash) return null;
      const facts = await readCaseReplyFacts(tx, proposal, accessRevision, { lockCase: true });
      if (!facts.admission.admitted || facts.storedSender !== proposal.recipient || await hasLocalThreadForTicket(input.source.ticketId, tx)) return null;
      const [approval] = await tx.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)).for("share");
      if (approval?.state !== "approved" || approval.executionId !== parent.id || !approval.decidedAt || !approval.decidedBy
          || caseReplyModeForBasis(approval.authorizationBasis) !== "manual_reviewed"
          || caseReplyTextProblemForBasis(proposal.text, approval.authorizationBasis)
          || checkCaseReplyApproval(proposal, { payloadHash: approval.payloadHash, caseVersion: approval.caseVersion, recipient: approval.recipient,
            approvedBy: approval.decidedBy, approvedAt: approval.decidedAt.toISOString() }) !== "ok") return null;
      const usage = await tx.select({ createdAt: ledger.createdAt }).from(ledger).where(eq(ledger.kind, SEND_KIND));
      if (intakeAdmissionUsage(usage, authority.policy.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE) >= authority.policy.maxDossiers) {
        await updateParent(tx, parent.id, "waiting", "threadless_admission_limit");
        return null;
      }
    }
    if (signal.aborted || !savV2NewThreadEnabled(deps.env())) return null;
    return mark(tx, locked, intent);
  });
  if (!dispatched) return;
  try {
    if (signal.aborted || !await threadlessActionAllowed(deps.env(), db)) return;
    const ack = intent.kind === SEND_KIND ? await deps.transport.send(intent, signal)
      : await deps.transport.createCrmEmail(intent.sent, intent.receipt, intent.contactId, signal);
    await recordEffectAck(dispatched, ack);
  } catch { /* A provider can have accepted the POST. Continue with verification only. */ }

  const [current] = await db.select().from(ledger).where(eq(ledger.id, dispatched.id));
  if (current && !signal.aborted) await verifyAndPersist(parent, current, deps, signal);
}

/** Uses the same durable ledger as thread replies. Marker and mail/CRM receipts are independent. */
export async function runThreadlessEffectsPass(deps: PassDeps) {
  const enabled = savV2NewThreadEnabled(deps.env());
  if (Date.now() >= deps.deadlineMs || !enabled && deps.executionId) return [];
  const db = requireDb();
  if (!await threadlessSchemaInstalled(db)) return [];
  const rows = await db.select().from(parents).where(and(isNull(parents.threadId),
    ...(deps.executionId ? [eq(parents.id, deps.executionId)] : []),
    sql`${parents.state} not in ('confirmed', 'refused')`,
    // OFF preserves only read-back of a previously written marker. An untouched deployment has no such rows.
    ...(enabled ? [] : [sql`exists (select 1 from sav.intake_effects f where f.execution_id = ${parents.id}
      and f.state in ('dispatched', 'acked', 'uncertain'))`]),
    sql`not exists (select 1 from sav.intake_effects f where f.execution_id = ${parents.id}
      and f.state in ('dispatched', 'acked', 'uncertain')
      and (f.reconcile_attempts >= ${MAX_READS} or f.next_reconcile_at > now()))`,
  )).orderBy(asc(parents.updatedAt), asc(parents.id)).limit(3);
  const handled: { executionId: string; state: string; reason: string | null }[] = [];
  for (const row of rows) {
    if (Date.now() >= deps.deadlineMs) break;
    try {
      await passOne(row, deps);
      const [next] = await db.select({ reason: parents.reason }).from(parents).where(eq(parents.id, row.id));
      // Only a just-confirmed send can immediately journal CRM.
      if (row.reason !== CRM_PENDING && next?.reason === CRM_PENDING && Date.now() < deps.deadlineMs)
        await passOne(row, deps);
    } catch {
      // The parent and any committed markers remain eligible for their normal recovery.
    }
    // Rotate every attempted row out of the oldest slots, including waits that wrote no effect.
    const [state] = await db.update(parents).set({ updatedAt: sql`clock_timestamp()` }).where(eq(parents.id, row.id))
      .returning({ state: parents.state, reason: parents.reason });
    if (state) handled.push({ executionId: row.id, ...state });
  }
  return handled;
}
