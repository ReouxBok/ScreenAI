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
import { prepareCaseReplyText } from "./case-reply-outbound";
import { readAccessAutoApprovalConfig } from "./customer-return";
import { listCaseTimers } from "./case-store";
import { revalidateJ2Timer } from "./timer-store";

// No copied question, procedure, link or claim of resolution; no model call.
export const J2_REMINDER_TEXT = prepareCaseReplyText("Bonjour,\n\nNous revenons vers vous au sujet de notre précédent message. Avez-vous pu consulter notre demande ou essayer la procédure proposée ? Vous pouvez nous répondre dans ce fil pour poursuivre votre accompagnement.", "fr", "automated", "reminder");

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
