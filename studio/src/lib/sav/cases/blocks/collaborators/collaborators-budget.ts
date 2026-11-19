import { measurePromptBudget, type PromptBudgetMeasurement } from "../../../skills/prompt-budget";
import { SAV_CASE_CUSTOMER_CONTEXT_LIMITS as L } from "../../investigation-customer-context";
import { collaboratorsDecisionSkillPrompt } from "./collaborators-decision-skill";
import { collaboratorsEntryWireBody, SAV_COLLABORATORS_CONFIRM_BOUNDS as B, SAV_COLLABORATORS_CONFIRM_TEXT_MAX } from "./collaborators-entry-rule";

/*
 * Collaborators block (19/11): prompt bytes per stage, measured on the exact serialized body at the read bounds (the longest mail a stage can
 * receive), never estimated. Pure; not wired.
 *
 * Ceiling: 26 000 bytes, the V2 transport's `maxInputBytes` observed on 10/11 (TO CONFIRM against the current transport policy; this file reads
 * no production configuration). A pass is strictly under 85 % (`measurePromptBudget`).
 * The decision stage counts this skill, the customer context at V2's own bounds, one answer card at the card norm's maximum (5 500 characters) and
 * no orientation card (an orientation card never supports a reply). It does NOT count V2's generic decision instructions: the skill must replace them, not be added to them (integration
 * left to the infra lot).
 */

export const SAV_COLLABORATORS_INPUT_CEILING_BYTES = 26_000;
export const SAV_COLLABORATORS_MAX_OUTPUT_TOKENS = 4_096;
const CARD_NORM_MAX_CHARS = 5_500;

/** Deterministic French filler with accents and line breaks, cut to an exact character count. */
export function collaboratorsFiller(chars: number): string {
  const sentence = "Bonjour, j'ai invité ma collègue à rejoindre l'équipe la semaine dernière ; elle vérifie ses indésirables et rien n'arrive.\n";
  return sentence.repeat(Math.ceil(chars / sentence.length) + 1).slice(0, chars);
}

/** The confirmation call at its read bounds: subject, text, request count and request words all at their maximum. */
export function collaboratorsConfirmBodyAtBound(): string {
  return collaboratorsEntryWireBody({
    purpose: "return", subject: collaboratorsFiller(B.subject), text: collaboratorsFiller(SAV_COLLABORATORS_CONFIRM_TEXT_MAX),
    requests: Array.from({ length: B.requests }, (_, index) => ({ requestId: `request-${index + 1}`, words: collaboratorsFiller(B.words) })),
  }, SAV_COLLABORATORS_MAX_OUTPUT_TOKENS);
}

/** The decision call at V2's context bounds with the largest card the norm allows. */
export function collaboratorsDecisionBodyAtBound(): string {
  const payload = {
    request: { requestId: "request-1", blockId: "collaborators", purpose: "return" },
    context: {
      subject: collaboratorsFiller(L.subjectChars),
      latestMessage: collaboratorsFiller(L.latestMessageChars),
      thread: Array.from({ length: L.threadMessages }, (_, index) => ({ from: index % 2 ? "support" : "customer", text: collaboratorsFiller(L.threadChars / L.threadMessages) })),
      crm: collaboratorsFiller(L.crmChars),
    },
    answerSources: [{ sourceId: "collaborators.invite-member", contentVersionId: "version-a-confirmer-0000000000000000", body: collaboratorsFiller(CARD_NORM_MAX_CHARS) }],
  };
  return JSON.stringify({
    systemInstruction: { parts: [{ text: collaboratorsDecisionSkillPrompt() }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: SAV_COLLABORATORS_MAX_OUTPUT_TOKENS },
  });
}

export function measureCollaboratorsPromptBudget(): readonly PromptBudgetMeasurement[] {
  return [
    measurePromptBudget("confirm", collaboratorsConfirmBodyAtBound(), SAV_COLLABORATORS_INPUT_CEILING_BYTES),
    measurePromptBudget("decision", collaboratorsDecisionBodyAtBound(), SAV_COLLABORATORS_INPUT_CEILING_BYTES),
  ];
}
