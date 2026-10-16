import "server-only";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { isSavPilotMode, savAutomationMode, savReleaseStage } from "./config";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { savV0EligibleMessageFilter } from "./cutover";
import { splitSavMessageText } from "./message-context";
import { normalizeEmailAddress } from "./policy";
import { savStructuredProposalSchema } from "./proposal";
import { savReplyFooter } from "./reply-format";
import { savReviewMatchesProposal } from "./review-contract";

export const SAV_PARTNERSHIP_RECIPIENT = "nathan@limova.ai";
export const SAV_PARTNERSHIP_FORWARD_PURPOSE = "partnership_forward";
const formatRevision = "sav-partnership-forward-2026-10-13.v1";
const ttlMs = 15 * 60 * 1000;
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
type Action = typeof savActions.$inferSelect;
const previewSchema = z.object({ purpose: z.literal(SAV_PARTNERSHIP_FORWARD_PURPOSE), threadId: z.uuid(), actorEmail: z.email(),
  messageId: z.uuid(), decisionId: z.uuid(), sourceHash: z.string().length(43), outboundHash: z.string().length(43), issuedAt: z.number(),
  from: z.email(), to: z.literal(SAV_PARTNERSHIP_RECIPIENT), subject: z.string().max(1200), text: z.string().max(110000), formatRevision: z.literal(formatRevision),
}).strict();
export type SavPartnershipPreview = { token: string; from: string; to: string; subject: string; text: string; expiresAt: string };
export type SavPartnershipTransferState = { available: boolean; status: "available" | "pending" | "succeeded" | "uncertain" | "failed" | "unavailable"; errorCode?: string; sendBlockedReason?: string };

export function isSavPartnershipForward(action: Pick<Action, "payload">) { return action.payload.purpose === SAV_PARTNERSHIP_FORWARD_PURPOSE; }
export function assertSavPartnershipForwardEnabled() {
  if (savReleaseStage() !== "v0") throw new Error("SAV_PARTNERSHIP_INVALID_STAGE");
  if (isSavPilotMode()) throw new Error("SAV_PILOT_WRITE_BLOCKED");
  if (savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true") throw new Error("SAV_WRITES_DISABLED");
}
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const oneLine = (text: string) => text.replace(/[\r\n\0]+/g, " ").trim();

/** No model call or provider request. Current semantic evidence is mandatory. */
async function loadContext(threadId: string, db: Reader = requireDb()) {
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
  if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const [eligible] = message ? await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.id, message.id), savV0EligibleMessageFilter())).limit(1) : [];
  if (!message || !eligible || !message.gmailMessageId || !thread.gmailThreadId) throw new Error("SAV_PARTNERSHIP_CONTEXT_CHANGED");
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.id, thread.mailboxId)).limit(1);
  if (!mailbox || normalizeEmailAddress(mailbox.email) !== "contact@limova.ai" || message.mailboxId !== mailbox.id) throw new Error("SAV_PARTNERSHIP_MAILBOX_INVALID");
  const from = normalizeEmailAddress(process.env.GMAIL_REPLY_FROM_ADDRESS || mailbox.email);
  if (from !== mailbox.email.toLowerCase()) throw new Error("SAV_PARTNERSHIP_MAILBOX_INVALID");
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.messageId, message.id), eq(savDecisions.isCurrent, true))).limit(1);
  const [run] = decision?.agentRunId ? await db.select().from(savAgentRuns).where(eq(savAgentRuns.id, decision.agentRunId)).limit(1) : [];
  if (!decision || !run?.proposalCiphertext || run.messageId !== message.id || run.pilotBatchId) throw new Error("SAV_PARTNERSHIP_ANALYSIS_REQUIRED");
  const proposal = savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext));
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, message.id), eq(savProposalReviews.isCurrent, true))).limit(1);
  const matches = review && savReviewMatchesProposal(review, { decisionId:decision.id,agentRunId:run.id,proposal,message });
  const after = matches ? savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)) : null;
  const human = after?.humanProcess;
  const current = splitSavMessageText(decryptSavPayload<{ text:string }>(message.bodyCiphertext).text).currentText;
  if (human) {
    if (review?.status !== "approved" || review.reviewScope !== "dossier" || human.action !== "partnership" || !human.confirmed
      || !human.understanding.requests.some(r => r.nature === "partnership") || !current) throw new Error("SAV_PARTNERSHIP_REVIEW_REQUIRED");
  } else {
    const u = proposal.understanding;
    const partnership = u?.requests.filter(request => request.nature === "partnership") ?? [];
    if (run.status !== "succeeded" || u?.status !== "qualified" || !partnership.length || u.uncertainties.some(item => !item.requestIds.length || item.requestIds.some(id => partnership.some(request => request.id === id))) || !current) throw new Error("SAV_PARTNERSHIP_NOT_DETECTED");
    if (partnership.some(request => !request.evidenceIds.some(id => {
      const evidence=u.evidence.find(item => item.id===id);
      return evidence?.source === "current_message" && evidence.sourceId === "current_body" && normalize(current).includes(normalize(evidence.excerpt));
    }))) throw new Error("SAV_PARTNERSHIP_NOT_DETECTED");
    if (matches && after) {
      const structure=(value:typeof proposal)=>value.process.map(step=>({kind:step.kind,sourceIds:[...step.sourceIds].sort()}));
      if (review.status !== "approved" || review.verdict !== "correct" || review.dimensions.classification && review.dimensions.classification !== "correct"
        || !["human_review_required","ticket_pending","ticket_created","attached_to_existing_ticket"].includes(after.decision.kind)
        || after.category!==proposal.category || after.decision.reasonCode!==proposal.decision.reasonCode
        || savContentHash(after.understanding)!==savContentHash(proposal.understanding) || savContentHash(structure(after))!==savContentHash(structure(proposal))) throw new Error("SAV_PARTNERSHIP_REVIEW_REQUIRED");
    }
  }
  const body = decryptSavPayload<{ text: string }>(message.bodyCiphertext).text;
  if (body.length > 100000) throw new Error("SAV_PARTNERSHIP_MESSAGE_TOO_LARGE");
  const subject = `Transfert partenariat : ${oneLine(message.subject) || "Demande de partenariat"}`;
  // Footer belongs to the forwarding note, preserving every original character.
  const text = `Bonjour Nathan,\n\nUne demande de partenariat a été reçue. Voici l’email pour examen.\nLes pièces jointes ne sont pas incluses dans ce transfert.\n\n${savReplyFooter("fr")}\n\n---------- Email transféré ----------\nDe : ${oneLine(message.fromEmail)}\nDate : ${message.receivedAt.toISOString()}\nObjet : ${oneLine(message.subject)}\n\n${body}`;
  const outbound = { from, to: SAV_PARTNERSHIP_RECIPIENT, subject, text, formatRevision };
  const sourceHash = savContentHash({ messageId: message.id, gmailMessageId: message.gmailMessageId, body: decryptSavPayload<{text:string}>(message.bodyCiphertext).text, subject: message.subject, fromEmail: message.fromEmail, mailboxId: mailbox.id, gmailThreadId: thread.gmailThreadId, decisionId: decision.id, runId: run.id, proposalCiphertext: run.proposalCiphertext, reviewId: review?.id ?? null, reviewStatus: review?.status ?? null, reviewBody: review?.afterCiphertext ?? null, outbound });
  return { thread, message, mailbox, decision, sourceHash, outbound, outboundHash: savContentHash(outbound) };
}

function deliveryState(action?: Action): SavPartnershipTransferState {
  if (!action) return { available: true, status: "available" };
  if (action.status === "succeeded") return { available: false, status: "succeeded" };
  if (action.payload.forwardDispatchedAt) return { available: false, status: "uncertain", errorCode: "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED" };
  if (["pending", "running"].includes(action.status)) return { available: false, status: "pending" };
  return { available: true, status: "failed", errorCode: action.errorCode ?? undefined };
}

export async function getSavPartnershipTransferState(threadId: string): Promise<SavPartnershipTransferState> {
  try {
    z.uuid().parse(threadId);
    const [uncertain] = await requireDb().select().from(savActions).where(and(eq(savActions.threadId, threadId), ne(savActions.status, "succeeded"), sql`${savActions.payload}->>'purpose' = 'partnership_forward'`, sql`${savActions.payload}->>'forwardDispatchedAt' is not null`)).limit(1);
    if (uncertain) return { available: false, status: "uncertain", errorCode: "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED" };
    if (savReleaseStage() !== "v0") return { available: false, status: "unavailable" };
    const c = await loadContext(z.uuid().parse(threadId));
    const [action] = await requireDb().select().from(savActions).where(eq(savActions.idempotencyKey, `gmail:partnership-forward:${c.message.id}`)).limit(1);
    const state = deliveryState(action);
    try { assertSavPartnershipForwardEnabled(); } catch (error) { state.sendBlockedReason = error instanceof Error ? error.message : "SAV_WRITES_DISABLED"; }
    return state;
  } catch { return { available: false, status: "unavailable" }; }
}

/** Encrypted authenticated preview; no pending action exists until explicit confirmation. */
export async function prepareSavPartnershipForward(threadId: string, actorEmail: string): Promise<SavPartnershipPreview> {
  assertSavActor(actorEmail);
  if (savReleaseStage() !== "v0") throw new Error("SAV_PARTNERSHIP_INVALID_STAGE");
  const c = await loadContext(z.uuid().parse(threadId));
  const [action] = await requireDb().select().from(savActions).where(eq(savActions.idempotencyKey, `gmail:partnership-forward:${c.message.id}`)).limit(1);
  if (!deliveryState(action).available) throw new Error(action?.payload.forwardDispatchedAt && action.status !== "succeeded" ? "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED" : "SAV_PARTNERSHIP_ALREADY_REQUESTED");
  const issuedAt = Date.now();
  const snapshot = previewSchema.parse({ purpose: SAV_PARTNERSHIP_FORWARD_PURPOSE, threadId, actorEmail, messageId: c.message.id, decisionId: c.decision.id, sourceHash: c.sourceHash, outboundHash: c.outboundHash, issuedAt, ...c.outbound });
  return { token: encryptSavPayload(snapshot), from: snapshot.from, to: snapshot.to, subject: snapshot.subject, text: snapshot.text, expiresAt: new Date(issuedAt + ttlMs).toISOString() };
}

export async function queueSavPartnershipForward(token: string, actorEmail: string) {
  assertSavActor(actorEmail); assertSavPartnershipForwardEnabled();
  const preview = previewSchema.parse(decryptSavPayload(z.string().min(1).max(300000).parse(token)));
  if (preview.actorEmail !== actorEmail || preview.issuedAt > Date.now() || Date.now() - preview.issuedAt > ttlMs) throw new Error("SAV_PARTNERSHIP_PREVIEW_EXPIRED");
  return requireDb().transaction(async tx => {
    const [locked] = await tx.select().from(savThreads).where(eq(savThreads.id, preview.threadId)).for("update");
    if (!locked) throw new Error("SAV_THREAD_NOT_FOUND");
    const c = await loadContext(preview.threadId, tx);
    if (c.message.id !== preview.messageId || c.decision.id !== preview.decisionId || c.sourceHash !== preview.sourceHash || c.outboundHash !== preview.outboundHash) throw new Error("SAV_PARTNERSHIP_PREVIEW_STALE");
    const key = `gmail:partnership-forward:${c.message.id}`;
    const [existing] = await tx.select().from(savActions).where(eq(savActions.idempotencyKey, key)).limit(1);
    if (existing?.payload.forwardDispatchedAt && existing.status !== "succeeded") throw new Error("SAV_PARTNERSHIP_RECONCILIATION_REQUIRED");
    if (existing && ["pending", "running", "succeeded"].includes(existing.status)) return existing;
    const values = { threadId: preview.threadId, messageId: c.message.id, decisionId: c.decision.id, kind: "send_reply", actorType: "human", actorEmail,
      status: "pending", attemptCount: 0, errorCode: null, scheduledAt: null, payload: { purpose: SAV_PARTNERSHIP_FORWARD_PURPOSE, manualReplyConfirmed: true, forwardConfirmedAt: new Date().toISOString(), previewCiphertext: token, sourceHash: preview.sourceHash, outboundHash: preview.outboundHash }, updatedAt: new Date() } as const;
    const [action] = existing ? await tx.update(savActions).set(values).where(eq(savActions.id, existing.id)).returning() : await tx.insert(savActions).values({ ...values, idempotencyKey: key }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_partnership_forward_confirmed", entityType: "sav_action", entityId: action.id, technicalMetadata: { messageId: c.message.id, decisionId: c.decision.id, sourceHash: preview.sourceHash, outboundHash: preview.outboundHash, recipient: SAV_PARTNERSHIP_RECIPIENT } });
    return action;
  });
}

/** Worker authorization is re-read before every dispatch. The preview is immutable. */
export async function assertSavCurrentPartnershipForward(action: Action, db: Reader = requireDb()) {
  assertSavPartnershipForwardEnabled();
  if (!isSavPartnershipForward(action) || action.kind !== "send_reply" || action.actorType !== "human" || !action.actorEmail || action.pilotBatchId || action.payload.manualReplyConfirmed !== true || !action.payload.forwardConfirmedAt || action.payload.followupSequence) throw new Error("SAV_PARTNERSHIP_CONFIRMATION_REQUIRED");
  assertSavActor(action.actorEmail);
  const preview = previewSchema.parse(decryptSavPayload(String(action.payload.previewCiphertext ?? "")));
  const c = await loadContext(action.threadId, db);
  const previewOutboundHash = savContentHash({ from: preview.from, to: preview.to, subject: preview.subject, text: preview.text, formatRevision: preview.formatRevision });
  if (previewOutboundHash !== preview.outboundHash) throw new Error("SAV_PARTNERSHIP_PREVIEW_STALE");
  if (preview.actorEmail !== action.actorEmail || preview.threadId !== action.threadId || preview.messageId !== action.messageId || preview.decisionId !== action.decisionId || preview.messageId !== c.message.id || preview.decisionId !== c.decision.id || preview.sourceHash !== c.sourceHash || action.payload.sourceHash !== c.sourceHash || preview.outboundHash !== c.outboundHash || action.payload.outboundHash !== c.outboundHash) throw new Error("SAV_PARTNERSHIP_PREVIEW_STALE");
  return { ...c, preview };
}
