import { renderEntryConfirmPrompt } from "../../../skills/entry-block";
import { entryConfirmBudget, entryLongThreadInput } from "../../../skills/entry-budget";
import { entryWireBody } from "../../../skills/entry-wire";
import { measurePromptBudget, type PromptBudgetMeasurement } from "../../../skills/prompt-budget";
import { CHARLY_MAX_ENTRY_BLOCK } from "./charly_max-entry";
import { CHARLY_MAX_CORPUS, type CharlyMaxCorpusCase } from "./charly-max-corpus.fixture";
import { charlyMaxDecisionSkillPrompt } from "./charly-max-skill-decision";

/*
 * Charly Max block: prompt bytes per stage (method V3 step 8). PURE, NOT WIRED.
 *
 * Confirmation: the EXACT body of the entry (`entryWireBody` + `renderEntryConfirmPrompt`, lot infra-entry). The reference measure is the
 * interface's worst case (`entryConfirmBudget`: a 12 000-character thread, 2 requests, 8 192 output tokens); the corpus p95 is given as well.
 * Decision: not wired yet; same envelope as the Access call, with one support card at the norm's maximum size. The ceiling is V2's input
 * preflight (26 000 bytes); a stage passes strictly below 85 %. Mails longer than the reader's 12 000 characters never reach a call (the team,
 * whole), so they are left out of the corpus measure and counted apart. The router stage is measured by the lot infra-entry.
 */

export const CHARLY_MAX_STAGE_CEILING_BYTES = 26_000;
const TEXT_MAX = 12_000;
/** The norm of a support card (method V3 step 2): at most 5 500 characters. The decision is measured with one card at that size. */
const CARD_MAX_CHARS = 5_500;

const envelope = (system: string, user: unknown) => JSON.stringify({
  systemInstruction: { parts: [{ text: system }] },
  contents: [{ role: "user", parts: [{ text: JSON.stringify(user) }] }],
  generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 4_096 },
});

export function charlyMaxConfirmBody(row: Pick<CharlyMaxCorpusCase, "subject" | "text" | "purpose" | "requests">): string {
  return entryWireBody("confirm", renderEntryConfirmPrompt(CHARLY_MAX_ENTRY_BLOCK), {
    purpose: row.purpose, subject: row.subject, text: row.text, originalRequest: null,
    requests: row.requests.map(({ requestId }) => ({ requestId, kind: "support", words: null })),
  }, 8_192);
}

/** The interface's reference measure: the confirmation on the longest thread the entry reads. */
export const charlyMaxConfirmWorstCase = () => entryConfirmBudget(CHARLY_MAX_ENTRY_BLOCK);

export function charlyMaxDecisionBody(row: Pick<CharlyMaxCorpusCase, "subject" | "text" | "purpose">): string {
  // A card at the norm's maximum size, made of accented French text (2 bytes for some characters), so the measure is not optimistic.
  const card = "Étape à suivre dans la rubrique Charly Max. ".repeat(Math.ceil(CARD_MAX_CHARS / 44)).slice(0, CARD_MAX_CHARS);
  return envelope(charlyMaxDecisionSkillPrompt(), {
    requestId: "r1", topic: "incident", purpose: row.purpose, subject: row.subject, text: row.text.slice(0, TEXT_MAX),
    facts: { evidencePresent: { screenshot: false, customer_phone: false }, evidenceAskedBefore: false, procedureGivenBefore: false, handoffReceipt: null },
    answerSources: [{ knowledgeId: "card-measure", contentVersionId: "card-measure-v", title: "Fiche de mesure", content: card }],
  });
}

const p95 = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

export type CharlyMaxStageBudget = PromptBudgetMeasurement & Readonly<{ maxBytes: number; maxStatus: "pass" | "fail"; measuredCases: number; skippedTruncated: number }>;

/** The p95 and max wire bodies over the corpus, per stage. */
export function measureCharlyMaxBudget(): Readonly<{ confirm: CharlyMaxStageBudget; decision: CharlyMaxStageBudget }> {
  const readable = CHARLY_MAX_CORPUS.filter(row => row.text.length <= TEXT_MAX && row.subject.length <= 500);
  const skippedTruncated = CHARLY_MAX_CORPUS.length - readable.length;
  const stage = (name: "confirm" | "decision", bodies: readonly string[]): CharlyMaxStageBudget => {
    const sizes = bodies.map(body => Buffer.byteLength(body, "utf8"));
    const atP95 = bodies[sizes.indexOf(p95(sizes))];
    const atMax = bodies[sizes.indexOf(Math.max(...sizes))];
    const max = measurePromptBudget(name, atMax, CHARLY_MAX_STAGE_CEILING_BYTES);
    return { ...measurePromptBudget(name, atP95, CHARLY_MAX_STAGE_CEILING_BYTES), maxBytes: max.bodyBytes, maxStatus: max.status, measuredCases: bodies.length, skippedTruncated };
  };
  return {
    confirm: stage("confirm", readable.map(charlyMaxConfirmBody)),
    decision: stage("decision", readable.filter(row => row.group === "positive" || row.group === "trap").map(charlyMaxDecisionBody)),
  };
}

/** The decision on the longest mail the entry reads (12 000 characters, the interface's reference thread). Reported: the decision is not wired. */
export function charlyMaxDecisionWorstCase(): PromptBudgetMeasurement {
  const long = entryLongThreadInput();
  return measurePromptBudget("decision", charlyMaxDecisionBody({ subject: long.subject, text: long.text, purpose: "first_mail" }), CHARLY_MAX_STAGE_CEILING_BYTES);
}

/** The empty-mail body of each stage: the fixed cost of the skill itself. */
export const charlyMaxSkillFixedBytes = () => ({
  confirm: Buffer.byteLength(charlyMaxConfirmBody({ subject: "", text: "", purpose: "first_mail", requests: [{ requestId: "r1", expected: { kind: "team" } }] }), "utf8"),
  decision: Buffer.byteLength(charlyMaxDecisionBody({ subject: "", text: "", purpose: "first_mail" }), "utf8"),
});
