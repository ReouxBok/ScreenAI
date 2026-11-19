import { accessSkillJudgePrompt } from "../cases/access-skill/access-skill-guidelines";
import { accessSkillWireBody } from "../cases/access-skill/access-skill-wire";
import { renderEntryConfirmPrompt, type EntrySkillBlock } from "./entry-block";
import { entryRouterAccessLine, entryRouterLineOf, renderEntryRouterPrompt } from "./entry-router";
import { entryWireBody, type EntrySkillInput } from "./entry-wire";
import { measurePromptBudget, type PromptBudgetMeasurement } from "./prompt-budget";

/*
 * Prompt budget of each stage of the entry (METHODE_BLOCS_V3 §4 step 8): the EXACT body sent, measured by N3's `measurePromptBudget` (strictly under 85 %
 * of the ceiling). The ceiling is V2's `maxInputBytes` in production (26 000 bytes, the transport refuses anything above with `input_too_large`).
 * The reference input is a LONG thread at the entry's own limit (12 000 characters of French text with quoted history, accents and line breaks, a
 * 500-character subject, two requests with their words): beyond that limit the mail is not read at all (`input_truncated`, the team), so this is the
 * longest mail a stage can ever receive — its p95 and above. The output allowance is V2's maximum (8 192 tokens): the field's width is counted.
 */

export const SAV_ENTRY_BUDGET_CEILING_BYTES = 26_000;
const MAX_OUTPUT_TOKENS = 8_192;
const PARAGRAPH = [
  "Bonjour, je reviens vers vous car le problème décrit plus bas n'est toujours pas réglé malgré vos réponses précédentes.",
  "> Le mardi, l'équipe Limova a écrit : merci pour votre retour, pouvez-vous nous préciser l'écran concerné et l'heure de l'erreur ?",
  "> J'ai essayé à nouveau ce matin, même résultat, l'écran reste figé après la validation « Enregistrer ».",
  "Cordialement, Camille — Société Fictive, 3 rue de l'Exemple, ville fictive.",
].join("\n");
/** The longest mail a stage may receive (12 000 characters exactly), with two requests quoting it. */
export function entryLongThreadInput(): EntrySkillInput {
  let text = "";
  while (text.length < 12_000) text += `${PARAGRAPH}\n\n`;
  text = text.slice(0, 12_000);
  const subject = `Re: Re: Fwd: ${"suivi de la demande précédente, toujours bloqué ".repeat(20)}`.slice(0, 500);
  return { purpose: "first_mail", subject, text, originalRequest: null,
    requests: [{ requestId: "gm-long/r1", kind: "support", words: PARAGRAPH.slice(0, 200) }, { requestId: "gm-long/r2", kind: "support", words: PARAGRAPH.slice(200, 400) }] };
}

/** The confirmation stage of one block on the longest thread. */
export const entryConfirmBudget = (block: EntrySkillBlock, ceilingBytes = SAV_ENTRY_BUDGET_CEILING_BYTES): PromptBudgetMeasurement =>
  measurePromptBudget("confirm", entryWireBody("confirm", renderEntryConfirmPrompt(block), entryLongThreadInput(), MAX_OUTPUT_TOKENS), ceilingBytes);

/** The router stage with Access and these blocks in its catalog, on the longest thread. */
export const entryRouterBudget = (blocks: readonly EntrySkillBlock[], ceilingBytes = SAV_ENTRY_BUDGET_CEILING_BYTES): PromptBudgetMeasurement =>
  measurePromptBudget("entry", entryWireBody("router", renderEntryRouterPrompt([entryRouterAccessLine(), ...blocks.map(entryRouterLineOf)]), entryLongThreadInput(), MAX_OUTPUT_TOKENS), ceilingBytes);

/** The shared counter-read (Access's), on the longest thread. Measured under the `confirm` stage (it is the second half of every confirmation). */
export const entryCounterBudget = (ceilingBytes = SAV_ENTRY_BUDGET_CEILING_BYTES): PromptBudgetMeasurement =>
  measurePromptBudget("confirm", accessSkillWireBody("counter", entryLongThreadInput(), MAX_OUTPUT_TOKENS), ceilingBytes);

/** Access's own confirmation (its SAV-97 judge, unchanged), on the longest thread: reported, never altered here. */
export const entryAccessJudgeBudget = (ceilingBytes = SAV_ENTRY_BUDGET_CEILING_BYTES): PromptBudgetMeasurement =>
  measurePromptBudget("confirm", accessSkillWireBody("judge", entryLongThreadInput(), MAX_OUTPUT_TOKENS), ceilingBytes);

/** The judge prompt's own weight (no customer text), for the reports. */
export const accessJudgePromptBytes = () => Buffer.byteLength(accessSkillJudgePrompt(), "utf8");
