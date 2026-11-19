import { measurePromptBudget, type PromptBudgetMeasurement } from "../../../skills/prompt-budget";
import { integrationsDecisionSkillPrompt } from "./integrations-decision-skill";
import { SAV_INTEGRATIONS_ROUTER_LINE } from "./integrations-entry-skill";
import type { IntegrationsCorpusCase } from "./integrations-scope";

/*
 * Block « Intégrations »: prompt bytes per stage (METHODE_BLOCS_V3 §4 step 8), measured on the EXACT serialised wire body, the same Gemini envelope
 * as the Access skill (`access-skill-wire.ts`): system instruction, the customer data as one JSON user part, JSON output, temperature 0.
 * Pure: no network, key or clock. The ceiling is the V2 transport's input limit observed in production (26 000 bytes, `maxInputBytes`).
 * A mail longer than the 12 000-character reading limit never reaches a model: it goes whole to the team (truncation rule), so it is not measured.
 * The CONFIRMATION stage is measured by the infra-entry lot's `entryConfirmBudget` (shared frame + this block's skill, longest readable thread),
 * pinned in `integrations-entry.test.ts`; this file measures what is the block's own: the decision stage and its router line.
 */

export const SAV_INTEGRATIONS_BUDGET_CEILING_BYTES = 26_000;
export const SAV_INTEGRATIONS_TEXT_MAX = 12_000;
/** The card norm (METHODE_BLOCS_V3 §4 step 2): at most 5 500 characters per support card. */
export const SAV_INTEGRATIONS_CARD_MAX_CHARS = 5_500;
const MAX_OUTPUT_TOKENS = 4_096;

const envelope = (system: string, user: unknown) => JSON.stringify({
  systemInstruction: { parts: [{ text: system }] },
  contents: [{ role: "user", parts: [{ text: JSON.stringify(user) }] }],
  generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
});

const mailInput = (row: Pick<IntegrationsCorpusCase, "subject" | "text" | "purpose" | "requests">) => ({
  purpose: row.purpose, subject: row.subject ?? "", text: row.text, originalRequest: null,
  requests: row.requests.map(request => ({ requestId: request.requestId, kind: "integrations", words: null })),
});

/** Stage « decision »: the decision skill, the mail and the support cards given at exact version (here `cardCount` cards at the norm's maximum). */
export function integrationsDecisionWireBody(row: Pick<IntegrationsCorpusCase, "subject" | "text" | "purpose" | "requests">, cardCount: number): string {
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    cardId: `card-${index + 1}`, use: "answer", contentVersionId: `version-${index + 1}`, text: "x".repeat(SAV_INTEGRATIONS_CARD_MAX_CHARS),
  }));
  return envelope(integrationsDecisionSkillPrompt(), { ...mailInput(row), supportCards: cards, history: [] });
}

/** Stage « entry » (light router): only this block's catalogue line is ours; the router prompt itself belongs to the infra-entry lot. */
export const integrationsRouterCardBytes = () => Buffer.byteLength(JSON.stringify(SAV_INTEGRATIONS_ROUTER_LINE), "utf8");

const percentile95 = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
};

export type IntegrationsBudgetReport = Readonly<{
  ceilingBytes: number;
  measuredCases: number;
  skippedTruncated: number;
  decision: Readonly<{ p95OneCard: PromptBudgetMeasurement; p95TwoCards: PromptBudgetMeasurement }>;
  routerCardBytes: number;
}>;

/** Decision stage: p95 over the mails that a model would read (≤ 12 000 characters), with one or two support cards at the norm's maximum. */
export function integrationsBudgetReport(cases: readonly IntegrationsCorpusCase[]): IntegrationsBudgetReport {
  const readable = cases.filter(row => row.text.length <= SAV_INTEGRATIONS_TEXT_MAX);
  const p95Of = (body: (row: IntegrationsCorpusCase) => string) => {
    const sizes = readable.map(row => ({ row, bytes: Buffer.byteLength(body(row), "utf8") }));
    const target = percentile95(sizes.map(size => size.bytes));
    return body(sizes.find(size => size.bytes === target)!.row);
  };
  return {
    ceilingBytes: SAV_INTEGRATIONS_BUDGET_CEILING_BYTES,
    measuredCases: readable.length,
    skippedTruncated: cases.length - readable.length,
    decision: {
      p95OneCard: measurePromptBudget("decision", p95Of(row => integrationsDecisionWireBody(row, 1)), SAV_INTEGRATIONS_BUDGET_CEILING_BYTES),
      p95TwoCards: measurePromptBudget("decision", p95Of(row => integrationsDecisionWireBody(row, 2)), SAV_INTEGRATIONS_BUDGET_CEILING_BYTES),
    },
    routerCardBytes: integrationsRouterCardBytes(),
  };
}
