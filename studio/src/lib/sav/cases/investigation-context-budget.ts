/*
 * K1 (12/11): what a V2 decision request weighs, and where. Pure: no model, network, database or clock. The body built here is the very
 * body the Gemini transport sends (`investigation-v2-providers.ts`), byte for byte; the breakdown is measured on it, never estimated:
 * - fixed: instruction + JSON schema + envelope, with an empty payload;
 * - case: what the payload adds without any card (open requests, facts, questions, trials, coverage, rejections...);
 * - knowledge: what the cards add; per card, the bytes its removal would save (its escaped JSON and its separator).
 * fixed + case + knowledge = raw body. When the transport sends the reversible compact view instead, `compacted` says so and the
 * breakdown still describes the raw body it was built from (`inputBytes` stays the bytes actually sent).
 */

export type CaseDecisionPromptParts = Readonly<{ instruction: string; schema: string; payload: Readonly<{ knowledge: readonly unknown[] }> & Record<string, unknown> }>;
export type CaseDecisionBodyBreakdown = {
  fixedBytes: number; caseBytes: number; knowledgeBytes: number; rawBytes: number; compacted: boolean;
  /** At most `SAV_CASE_BREAKDOWN_MAX_CARDS` cards, the largest ones (in body order); `truncated` when some were left out of this list. */
  cards: Array<{ knowledgeId: string; contentVersionId: string; bytes: number }>; truncated: boolean;
};
/**
 * The breakdown is a structured LOG only (`sav_v2_model_transport`), never stored in the investigation record, whose strict schema stays
 * main's (rollback safety). Bounded all the same: the 200 largest cards keep the line small (ids and byte counts, < 30 KB).
 */
export const SAV_CASE_BREAKDOWN_MAX_CARDS = 200;

/** The exact wire format of a decision request (unchanged since the transport was written). */
export function caseGeminiDecisionBody(prompt: Pick<CaseDecisionPromptParts, "instruction" | "schema">, payload: unknown, maxOutputTokens: number, decoding = "") {
  return JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}${decoding}` }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens } });
}

const size = (text: string) => Buffer.byteLength(text, "utf8");
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const idOf = (value: unknown) => typeof value === "string" && ID.test(value) ? value : "unknown";

export function caseDecisionBodyBreakdown(prompt: CaseDecisionPromptParts, maxOutputTokens: number, compacted = false): CaseDecisionBodyBreakdown {
  const measure = (payload: unknown) => size(caseGeminiDecisionBody(prompt, payload, maxOutputTokens));
  const knowledge = prompt.payload.knowledge;
  const rawBytes = measure(prompt.payload), fixedBytes = measure({}), withoutCards = measure({ ...prompt.payload, knowledge: [] });
  const cards = knowledge.map((card, index) => {
    const row = (typeof card === "object" && card !== null ? card : {}) as { knowledgeId?: unknown; contentVersionId?: unknown };
    return { knowledgeId: idOf(row.knowledgeId), contentVersionId: idOf(row.contentVersionId),
      bytes: rawBytes - measure({ ...prompt.payload, knowledge: knowledge.filter((_, other) => other !== index) }) };
  });
  const kept = new Set([...cards.keys()].sort((x, y) => cards[y]!.bytes - cards[x]!.bytes || x - y).slice(0, SAV_CASE_BREAKDOWN_MAX_CARDS));
  return { fixedBytes, caseBytes: withoutCards - fixedBytes, knowledgeBytes: rawBytes - withoutCards, rawBytes, compacted,
    cards: cards.filter((_, index) => kept.has(index)), truncated: kept.size < cards.length };
}
