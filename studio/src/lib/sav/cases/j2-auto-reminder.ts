import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import type { CaseReplyProposal } from "./case-effects";
import type { CaseEffectPayload } from "./case-reply-store";
import { renderSavOutboundReply } from "../reply-format";
import { caseReplyTextSafetyProblems } from "./decision-validator";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";
import { prepareCaseReplyText } from "./case-reply-outbound";
import { readAccessAutoApprovalConfig } from "./customer-return";
import { listCaseTimers } from "./case-store";
import { revalidateJ2Timer } from "./timer-store";

// No copied question, procedure, link or claim of resolution; no model call.
export const J2_REMINDER_TEXT = prepareCaseReplyText("Bonjour,\n\nNous revenons vers vous au sujet de notre précédent message. Avez-vous pu consulter notre demande ou essayer la procédure proposée ? Vous pouvez nous répondre dans ce fil pour poursuivre votre accompagnement.", "fr", "automated", "reminder");

/** Closed vocabulary: never interpolate a customer's words or an arbitrary procedure.
 * The 300-character bound includes the mandatory AI disclosure.
 * Only the timer's confirmed, sealed outbound proposal may be passed as origin.
 */
export function j2ReminderText(origin: CaseReplyProposal, env: Record<string, string | undefined>): string {
  if (env.SAV_V2_J2_CONTEXTUAL !== "on") return J2_REMINDER_TEXT;
  if (caseReplyTextSafetyProblems(origin.text, { accessOpen: true, answersOrAsks: true })
    .some(problem => problem.code !== "access_link_missing")) return J2_REMINDER_TEXT;
  let body: string | null = null;
  if (origin.purpose === "question" && origin.question?.factKeys.length === 1) {
    const key = origin.question.factKeys[0];
    const questions: Record<string, string> = {
      login_error_message: "Quel message s’affiche à l’écran ?",
      login_spam_checked: "Le code est-il dans vos spams ?",
    };
    body = key && Object.hasOwn(questions, key) ? questions[key]! : null;
  } else if (origin.purpose === "answer" && origin.procedures?.length === 1) {
    // Recognize the canonical login instruction already sent, not a mention, quote or negated instruction.
    const instruction = `Voici le lien de connexion : ${SAV_CASE_ACCESS_URL}. Une fois sur la page, entrez l’adresse e-mail que vous avez utilisée lors de votre inscription à Limova.`;
    const intros = ["Bonjour,\n\n", "Bonjour,\n\nMerci pour votre message. Je vais vous guider pour vous connecter à Limova.\n\n"];
    if (intros.some(intro => origin.text.startsWith(intro + instruction))) {
      body = `Connexion essayée depuis ${SAV_CASE_ACCESS_URL} ?`;
    }
  }
  if (!body || body.length > 300) return J2_REMINDER_TEXT;
  // Only a hard-coded whitelisted URL can enter a contextual body. All other inputs fall back.
  const text = renderSavOutboundReply(body, "fr", "automated");
  return text.length <= 300 ? text : J2_REMINDER_TEXT;
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
export async function readJ2Origin(caseId: string, triggerEventId: string, revision: string | null, now: Date): Promise<CaseReplyProposal | null> {
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
  const origin = decryptSavPayload<CaseEffectPayload>(parent.payloadCiphertext).proposal;
  return origin.caseId === caseId && (origin.purpose === "question" || (origin.purpose === "answer" && !!origin.procedures?.length)) ? origin : null;
}
