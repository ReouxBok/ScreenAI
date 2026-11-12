import { caseDecisionBodyBreakdown } from "./investigation-context-budget";
import { caseInvestigationPrompt } from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

/*
 * K1 (12/11): local measurement of the V2 decision context on a fixture (a synthetic case and an export of cards), with the transport's own
 * prompt and wire format. Offline: no model, network, database or clock; nothing is published nor sent. Used by
 * `scripts/measure-sav-v2-context.ts` and its test. The budget target is 85 % of the transport bound (block method, item 6): the room left
 * for cards is that target minus the fixed part and the case. What exceeds it is split into cards, never answered by raising the bound.
 */

export type CaseContextFixtureCard = Readonly<{
  id?: string; knowledgeId?: string; itemId?: string; contentVersionId?: string; versionId?: string; title?: string;
  content?: string; bodyMarkdown?: string; resolution?: unknown; metadata?: { resolution?: unknown };
}>;
export type CaseContextFixture = Readonly<{
  maxInputBytes?: number; maxOutputTokens?: number;
  case?: Readonly<{ version?: number; openRequests?: unknown[]; facts?: unknown[]; questions?: unknown[]; trials?: unknown[] }>;
  cards: readonly CaseContextFixtureCard[];
}>;

export const SAV_CASE_CONTEXT_TARGET_SHARE = 0.85;
const SENT_CONTENT_CHARACTERS = 6_000; // the decision prompt's existing cut (`caseInvestigationPrompt`), measured as is.

export function measureCaseContextFixture(fixture: CaseContextFixture) {
  const maxInputBytes = fixture.maxInputBytes ?? 26_000, maxOutputTokens = fixture.maxOutputTokens ?? 4_096;
  const cards = fixture.cards.map((row, index) => ({
    id: String(row.id ?? row.knowledgeId ?? row.itemId ?? `card-${index}`), contentVersionId: String(row.contentVersionId ?? row.versionId ?? `card-${index}-v`),
    title: String(row.title ?? ""), content: String(row.content ?? row.bodyMarkdown ?? ""), resolution: (row.resolution ?? row.metadata?.resolution ?? null) as never,
  }));
  const open = (fixture.case?.openRequests ?? [{ id: "r1", status: "open", family: "access", summary: "Demande synthétique." }]) as Array<{ id?: string; family?: string; status?: string }>;
  const version = fixture.case?.version ?? 1;
  const request = { purpose: "decision", caseId: "measure", caseVersion: version, inputKey: "measure", call: 1, subjectKey: "measure", callKey: "measure", caseBudgetKey: "measure",
    snapshot: { version, body: { openRequests: open, facts: fixture.case?.facts ?? [], questions: fixture.case?.questions ?? [], trials: fixture.case?.trials ?? [] } },
    events: [], knowledge: cards, feedback: [], closure: [],
    coverage: open.map(row => ({ requestId: String(row.id ?? "r1"), family: row.family ?? "access", status: "covered", knowledge: cards.map(card => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId })), limitations: [] })),
  } as unknown as CaseInvestigationModelRequest;
  const breakdown = caseDecisionBodyBreakdown(caseInvestigationPrompt(request), maxOutputTokens);
  const targetBytes = Math.floor(maxInputBytes * SAV_CASE_CONTEXT_TARGET_SHARE);
  const cardsRoomBytes = targetBytes - breakdown.fixedBytes - breakdown.caseBytes;
  const perCard = breakdown.cards.map((row, index) => ({ ...row, title: cards[index]!.title, contentCharacters: [...cards[index]!.content].length,
    cutAt6000: cards[index]!.content.length > SENT_CONTENT_CHARACTERS }));
  return { maxInputBytes, targetBytes, fixedBytes: breakdown.fixedBytes, caseBytes: breakdown.caseBytes, knowledgeBytes: breakdown.knowledgeBytes, totalBytes: breakdown.rawBytes,
    fitsBound: breakdown.rawBytes <= maxInputBytes, fitsTarget: breakdown.rawBytes <= targetBytes, cardsRoomBytes,
    cards: perCard, largestFirst: [...perCard].sort((a, b) => b.bytes - a.bytes).map(row => row.knowledgeId),
    overRoom: perCard.filter(row => row.bytes > cardsRoomBytes).map(row => row.knowledgeId) };
}
