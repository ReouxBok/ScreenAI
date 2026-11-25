import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { SAV_CASE_ACCESS_BLOCK_ID, SAV_SMART_ENTRY_BLOCK_ID } from "./case-types";
import { caseReplyKey, caseReplyQuestions, type CaseReplyProposal } from "./case-effects";
import type { CaseReplySendIntent } from "./case-effect-intents";
import type { CaseEffectPayload } from "./case-reply-store";
import { renderSavOutboundReply } from "../reply-format";
import { caseReplyTextSafetyProblems } from "./decision-validator";
import { caseReplyEditableBody, prepareCaseReplyText } from "./case-reply-outbound";
import { ACCESS_AUTO_APPROVAL_BASIS, readAccessAutoApprovalConfig } from "./customer-return";
import { smartSwitchProblem } from "./smart-support-scope";
import { smartAdmission, type Admission } from "./smart/smart-send-fence";
import { readRequestSubjects } from "./intake-boundary";
import { listCaseTimers, readCase } from "./case-store";
import { revalidateJ2Timer } from "./timer-store";

// No copied question, procedure, link or claim of resolution; no model call.
export const J2_REMINDER_TEXT = prepareCaseReplyText("Bonjour,\n\nNous revenons vers vous au sujet de notre précédent message. Avez-vous pu consulter notre demande ou essayer la procédure proposée ? Vous pouvez nous répondre dans ce fil pour poursuivre votre accompagnement.", "fr", "automated", "reminder");

/** Context is read from the stored inbound and the hash-verified accepted analysis, never the mail subject or a model. */
/** `j2OpenQuestionIds`: the tracked questions of the sent mail still without an answer on the case (read with the origin); absent = not known, so neutral. */
export type J2Origin = CaseReplyProposal & { j2Context?: { receivedAt: string; subject: string }; j2OpenQuestionIds?: readonly string[] };

/** Copy complete, unambiguous lists only. No paraphrase, truncation or fact-key-to-question translation. */
export function j2ReminderText(origin: J2Origin, env: Record<string, string | undefined>): string {
  if (env.SAV_V2_J2_CONTEXTUAL !== "on") return J2_REMINDER_TEXT;
  const context = origin.j2Context;
  if (!context || !Number.isFinite(Date.parse(context.receivedAt)) || !context.subject.trim() || context.subject.length > 600 || /[\r\n]/.test(context.subject)) return J2_REMINDER_TEXT;
  if (caseReplyTextSafetyProblems(`${origin.text}\n${context.subject}`, { accessOpen: true, answersOrAsks: true })
    .some(problem => problem.code !== "access_link_missing")) return J2_REMINDER_TEXT;
  // SAV-94: the body as it was sent (no new layout), so a reminder prepared before the layout pass is computed again byte for byte.
  const body = caseReplyEditableBody(origin.text, { layout: false });
  let recall: string | null = null;
  const tracked = caseReplyQuestions(origin);
  const open = new Set(origin.j2OpenQuestionIds ?? []);
  if (origin.purpose === "question" && tracked.length && tracked.every(question => question.text) && origin.j2OpenQuestionIds && open.size
      && new Set(tracked.map(question => question.id)).size === tracked.length && [...open].every(id => tracked.some(question => question.id === id))) {
    // Multi-question (#288): EVERY tracked question of this mail must appear in the sent body, in order, and together they must hold ALL the questions sent.
    // Only the ones still unanswered are recalled: the mail says no reply was received.
    const questions: string[] = [];
    let outside = "", cursor = 0, complete = true;
    for (const { id, text } of tracked) {
      const at = body.indexOf(text, cursor);
      const segments = text.match(/[^?]*\?/g) ?? [];
      if (at < 0 || text.slice(segments.join("").length).trim() || /[«»“”"]/u.test(text)) { complete = false; break; }
      outside += body.slice(cursor, at);
      cursor = at + text.length;
      questions.push(...segments.map(segment => (open.has(id) ? "" : "\0") + segment.trim().replace(/^(?:[-•] |\d+[.)] )/, "")));
    }
    outside += body.slice(cursor);
    const sent = questions.map(q => q.replace(/^\0/, "")), cited = questions.filter(q => !q.startsWith("\0"));
    if (complete && cited.length && sent.length <= 5 && sent.every(q => q.endsWith("?") && (q.match(/\?/g) ?? []).length === 1) && !outside.includes("?")) {
      recall = `pour vous demander quelques précisions :\n${cited.map(q => `• ${q}`).join("\n")}`;
    }
  } else if (origin.purpose === "answer") {
    const numbered = body.split("\n").filter(line => /^\d+[.)] /.test(line));
    if (origin.procedures?.length && numbered.length && numbered.every((line, i) => line.startsWith(`${i + 1}. `) || line.startsWith(`${i + 1}) `))) {
      // Only the greeting may sit outside the list: any other prose could be a prerequisite or condition.
      const block = numbered.join("\n");
      const paragraphs = body.split("\n\n");
      const instructions = body.replace(/^Bonjour(?:,)?\n\n/, "");
      // SAV-94: steps laid out one per paragraph (a blank line between them) are the same list; the recall quotes them as before, one per line.
      if ((paragraphs.includes(block) && instructions === block) || (numbered.length > 1 && instructions === numbered.join("\n\n"))) {
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
  if (!origin.inboundMessageId) return undefined;
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

/** OFF: main's fixed reminder, byte for byte (null when the timer or the case is unknown). ON: the contextual mail, built only from the proven origin. */
export async function readJ2ReminderText(caseId: string, triggerEventId: string, env: Record<string, string | undefined>, origin?: J2Origin | null): Promise<string | null> {
  if (env.SAV_V2_J2_CONTEXTUAL === "on") return origin ? j2ReminderText(origin, env) : null;
  const timer = (await listCaseTimers(caseId)).find(timer => `timer:${timer.id}` === triggerEventId);
  const current = await readCase(caseId);
  return timer && current ? J2_REMINDER_TEXT : null;
}

/** `admission`: the case's admission record. A smart one (SAV-123) is gated like the smart reply: the smart switches (`smartSwitchProblem`, as for a rule's
 * approval) and the smart block's switch, whose `auto` comes from `SAV_V2_SMART_SUPPORT_MODE=auto` (a row only restricts). Any other: the Access block, as before. */
export async function j2AutoGate(env: Record<string, string | undefined>, db: Parameters<typeof readSavBlockSwitch>[0] & Parameters<typeof readSavAgentPause>[0] = requireDb(), admission?: Admission): Promise<string | null> {
  const auto = readAccessAutoApprovalConfig(env);
  if (env.SAV_V2_J2_AUTO !== "on" || auto.mode !== "on") return "j2_auto_off";
  const smart = smartAdmission(admission);
  if (smart && smartSwitchProblem({ env, admission, basis: ACCESS_AUTO_APPROVAL_BASIS, approvedBy: auto.approverId })) return "smart_auto_off";
  const block = await readSavBlockSwitch(db, smart ? SAV_SMART_ENTRY_BLOCK_ID : SAV_CASE_ACCESS_BLOCK_ID, env);
  // The inherited shared Access switch has a permissive default: J2 requires an explicit setting there.
  const gate = savBlockReplyGate(block);
  if ((!smart && !block.setting) || gate.send !== "rule") return gate.send === "rule" ? "block_off" : gate.code;
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
  return { ...origin, j2Context: await readJ2Context(origin), j2OpenQuestionIds: await readJ2OpenQuestionIds(origin, timer.questionEffectId) };
}

/** The case's record of the mail's questions must match what was sent (same ids and texts); otherwise unknown, so neutral. */
async function readJ2OpenQuestionIds(origin: CaseReplyProposal, effectId: string): Promise<string[] | undefined> {
  const current = await readCase(origin.caseId);
  if (!current) return undefined;
  const recorded = current.body.questions.filter(question => question.askedInEffect === effectId);
  const tracked = caseReplyQuestions(origin);
  if (!tracked.length || recorded.length !== tracked.length || tracked.some(question => recorded.filter(r => r.id === question.id && r.text === question.text).length !== 1)) return undefined;
  return tracked.filter(question => !recorded.find(r => r.id === question.id)!.answeredBy).map(question => question.id);
}
