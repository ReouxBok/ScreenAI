import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { caseReplyKey, type CaseReplyProposal } from "./case-effects";
import type { CaseReplySendIntent } from "./case-effect-intents";
import type { CaseEffectPayload } from "./case-reply-store";
import { renderSavOutboundReply } from "../reply-format";
import { caseReplyTextSafetyProblems } from "./decision-validator";
import { caseReplyEditableBody, prepareCaseReplyText } from "./case-reply-outbound";
import { readAccessAutoApprovalConfig } from "./customer-return";
import { readRequestSubjects } from "./intake-boundary";
import { readCase, listCaseTimers } from "./case-store";
import { revalidateJ2Timer } from "./timer-store";

// No copied question, procedure, link or claim of resolution; no model call.
export const J2_REMINDER_TEXT = prepareCaseReplyText("Bonjour,\n\nNous revenons vers vous au sujet de notre précédent message. Avez-vous pu consulter notre demande ou essayer la procédure proposée ? Vous pouvez nous répondre dans ce fil pour poursuivre votre accompagnement.", "fr", "automated", "reminder");

/** Context is read from the stored inbound and the hash-verified accepted analysis, never the mail subject or a model. */
export type J2Origin = CaseReplyProposal & { j2Context?: { receivedAt: string; subject: string } };

/** Copy complete, unambiguous lists only. No paraphrase, truncation or fact-key-to-question translation. */
export function j2ReminderText(origin: J2Origin, env: Record<string, string | undefined>): string {
  if (env.SAV_V2_J2_CONTEXTUAL !== "on") return J2_REMINDER_TEXT;
  const context = origin.j2Context;
  if (!context || !Number.isFinite(Date.parse(context.receivedAt)) || !context.subject.trim() || context.subject.length > 600 || /[\r\n]/.test(context.subject)) return J2_REMINDER_TEXT;
  if (caseReplyTextSafetyProblems(`${origin.text}\n${context.subject}`, { accessOpen: true, answersOrAsks: true })
    .some(problem => problem.code !== "access_link_missing")) return J2_REMINDER_TEXT;
  const body = caseReplyEditableBody(origin.text);
  let recall: string | null = null;
  if (origin.purpose === "question" && origin.question?.text && body.includes(origin.question.text)) {
    const tracked = origin.question.text;
    const segments = tracked.match(/[^?]*\?/g) ?? [];
    const questions = segments.map(segment => segment.trim().replace(/^(?:[-•] |\d+[.)] )/, ""));
    const complete = !tracked.slice(segments.join("").length).trim() && !/[«»“”"]/u.test(tracked);
    // A tracked question must contain ALL the questions sent, in their original order.
    const outside = body.replace(origin.question.text, "");
    if (complete && questions.length >= 1 && questions.length <= 5 && questions.every(q => q.endsWith("?") && (q.match(/\?/g) ?? []).length === 1) && !outside.includes("?")) {
      recall = `pour vous demander quelques précisions :\n${questions.map(q => `• ${q}`).join("\n")}`;
    }
  } else if (origin.purpose === "answer") {
    const numbered = body.split("\n").filter(line => /^\d+[.)] /.test(line));
    if (origin.procedures?.length && numbered.length && numbered.every((line, i) => line.startsWith(`${i + 1}. `) || line.startsWith(`${i + 1}) `))) {
      // Only the greeting may sit outside the list: any other prose could be a prerequisite or condition.
      const block = numbered.join("\n");
      const paragraphs = body.split("\n\n");
      const instructions = body.replace(/^Bonjour(?:,)?\n\n/, "");
      if (paragraphs.includes(block) && instructions === block) {
        recall = `en vous proposant la marche à suivre suivante :\n${block}`;
      }
    } else if (!origin.procedures?.length && !/^(?:[-•] |\d+[.)] )/m.test(body)) {
      const explanation = body.replace(/^Bonjour(?:,)?\n\n/, "");
      if (/(?:n’est pas possible|n'est pas possible|impossible|ne permet pas|ne peut pas)/i.test(explanation)) recall = `avec l’explication suivante :\n${explanation}`;
    }
  }
  if (!recall || /\b(?:J2|ticket|clôture automatique|statut)\b/i.test(`${context.subject} ${recall}`)) return J2_REMINDER_TEXT;
  const date = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris" }).format(new Date(context.receivedAt));
  return renderSavOutboundReply(`Bonjour,\n\nSuite à votre demande du ${date} concernant ${context.subject}, nous vous avions répondu par e-mail ${recall}\n\nNous n'avons pas eu de retour de votre part à ce sujet. Nous restons à vos côtés ; n'hésitez pas à revenir vers nous avec vos précisions, elles nous aideront à vous apporter la meilleure réponse et la meilleure résolution possible. Une simple réponse à ce mail suffit.\n\nAu plaisir de vous accompagner,\nL'équipe Limova`, "fr", "automated");
}

/** Missing or ambiguous provenance means a neutral reminder, never a guessed subject. */
async function readJ2Context(origin: CaseReplyProposal): Promise<J2Origin["j2Context"]> {
  const snapshot = await readCase(origin.caseId);
  const [mail] = await requireDb().select().from(savMessages).where(eq(savMessages.id, origin.inboundMessageId));
  if (!snapshot || !mail || !mail.gmailMessageId || mail.direction !== "inbound" || !snapshot.threadIds.includes(mail.threadId)) return undefined;
  const requests = snapshot.body.openRequests.filter(r => r.id.startsWith(`${mail.gmailMessageId}/`) && r.status === "open");
  if (requests.length !== 1) return undefined;
  const request = requests[0]!, subject = request.subject;
  if (subject?.status !== "available" || subject.provenance.field !== "ticketSummary") return undefined;
  const provenance = subject.provenance;
  const subjects = await readRequestSubjects({ runId: provenance.runId, runVersion: provenance.runVersion, messageId: mail.id,
    gmailMessageId: mail.gmailMessageId, requestIds: [request.id.slice(mail.gmailMessageId.length + 1)] });
  const verified = subjects.get(request.id);
  if (verified?.status !== "available" || verified.provenance.field !== "ticketSummary" || verified.text !== subject.text || verified.provenance.resultHash !== provenance.resultHash) return undefined;
  // A short subject is the accepted title itself, not a guessed split or a paraphrase of its description.
  const titles = await readRequestSubjects({ runId: provenance.runId, runVersion: provenance.runVersion, messageId: mail.id,
    gmailMessageId: mail.gmailMessageId, requestIds: [request.id.slice(mail.gmailMessageId.length + 1)], summaryTitleOnly: true });
  const title = titles.get(request.id);
  if (title?.status !== "available" || title.provenance.field !== "ticketSummary" || title.provenance.resultHash !== provenance.resultHash) return undefined;
  return { receivedAt: mail.receivedAt.toISOString(), subject: title.text };
}

export async function j2AutoGate(env: Record<string, string | undefined>, db: Parameters<typeof readSavBlockSwitch>[0] & Parameters<typeof readSavAgentPause>[0] = requireDb()): Promise<string | null> {
  if (env.SAV_V2_J2_AUTO !== "on" || readAccessAutoApprovalConfig(env).mode !== "on") return "j2_auto_off";
  const block = await readSavBlockSwitch(db, SAV_CASE_ACCESS_BLOCK_ID);
  // The inherited shared switch has a permissive default: J2 requires an explicit setting.
  const gate = savBlockReplyGate(block);
  if (!block.setting || gate.send !== "rule") return gate.send === "rule" ? "block_off" : gate.code;
  for (const agent of ["intake", "v2"] as const) {
    const pause = await readSavAgentPause(db, agent);
    if (pause.invalid || pause.level !== "running") return "paused";
  }
  return null;
}

/** The original confirmed send, sealed by the normal executor, is the only source of thread/recipient and decision provenance. */
export async function readJ2Origin(caseId: string, triggerEventId: string, revision: string | null, now: Date, env: Record<string, string | undefined> = {}): Promise<J2Origin | null> {
  const timer = (await listCaseTimers(caseId)).find(t => `timer:${t.id}` === triggerEventId);
  if (!timer) return null;
  const valid = await revalidateJ2Timer({ timerId: timer.id, caseId, currentPolicyRevision: revision, now,
    ports: { reminderEffect: async () => "none", budgetAvailable: async () => true } });
  if (valid.status !== "timer_conditions_met") return null;
  const db: Parameters<typeof readSavBlockSwitch>[0] & Parameters<typeof readSavAgentPause>[0] = requireDb();
  const [effect] = await db.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, timer.questionEffectId), eq(savIntakeEffects.kind, "reply_send"), eq(savIntakeEffects.state, "confirmed")));
  if (!effect) return null;
  const [parent] = await db.select().from(savCaseEffectExecutions).where(and(eq(savCaseEffectExecutions.id, effect.executionId), eq(savCaseEffectExecutions.caseId, caseId)));
  if (!parent) return null;
  const payload = decryptSavPayload<CaseEffectPayload>(parent.payloadCiphertext);
  const origin = payload.proposal;
  if (env.SAV_V2_J2_CONTEXTUAL !== "on") return origin.caseId === caseId && (origin.purpose === "question" || (origin.purpose === "answer" && !!origin.procedures?.length)) ? origin : null;
  if (origin.caseId !== caseId || !["question", "answer"].includes(origin.purpose) ||
      effect.businessKey !== caseReplyKey(caseId, origin.triggerEventId) || parent.replyKey !== effect.businessKey) return null;
  const sent = decryptSavPayload<CaseReplySendIntent>(effect.intentCiphertext);
  if (sent.kind !== "reply_send" || sent.key !== effect.businessKey || sent.text !== origin.text || sent.recipient !== origin.recipient.trim().toLowerCase() || sent.sourceMessageId !== origin.inboundMessageId || sent.threadId !== payload.context.gmailThreadId) return null;
  return { ...origin, j2Context: await readJ2Context(origin) };
}
