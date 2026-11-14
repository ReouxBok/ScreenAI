import type { SavBlockAttribution, SavBlockDraft, SavBlockTestPhrase, SavRankedCard } from "./block-attribution";

/*
 * SAV-92 harness gate 2 (routing) and the first half of gate 3 (overlaps), on a block's own test phrases. Pure arithmetic over results the
 * replay produced; nothing is searched here. Thresholds of the validated target (Ugo, 14/11): the right card in the top 3 for at least 90 % of
 * the positive phrases, at least 90 % of the neighbour phrases NOT given to this block, every trap handled as expected, and 20 to 30 phrases.
 */
export const SAV_BLOCK_ROUTING_GATES = Object.freeze({ top3HitRate: 0.9, neighbourRejectionRate: 0.9, minPhrases: 20, maxPhrases: 30, topK: 3 });

export type SavRoutingPhraseResult = Readonly<{ phrase: SavBlockTestPhrase; cards: readonly SavRankedCard[]; attribution: SavBlockAttribution | null }>;
export type SavRate = Readonly<{ hits: number; total: number; rate: number | null }>;
export type SavBlockRoutingMeasurement = Readonly<{
  blockId: string; phrases: number;
  top3: SavRate; neighbourRejection: SavRate; traps: SavRate;
  /** Positive phrases of this block whose best card belongs to another block: an overlap to settle with an exclusion. */
  overlaps: ReadonlyArray<Readonly<{ text: string; otherBlockId: string; cardId: string }>>;
  misses: ReadonlyArray<Readonly<{ text: string; kind: SavBlockTestPhrase["kind"]; why: string }>>;
  gate: Readonly<{ passed: boolean; reasons: readonly string[] }>;
}>;

const rate = (hits: number, total: number): SavRate => ({ hits, total, rate: total ? hits / total : null });
const takenBy = (attribution: SavBlockAttribution | null, blockId: string) => attribution?.outcome === "block" && attribution.blockId === blockId;
const outcomeOf = (attribution: SavBlockAttribution | null) => attribution === null ? "unavailable" : attribution.outcome === "block" ? attribution.blockId : attribution.outcome;

export function measureSavBlockRouting(block: Pick<SavBlockDraft, "blockId" | "cardIds">, results: readonly SavRoutingPhraseResult[]): SavBlockRoutingMeasurement {
  const own = new Set(block.cardIds);
  let top3 = 0, positives = 0, rejected = 0, neighbours = 0, trapsOk = 0, traps = 0;
  const overlaps: Array<{ text: string; otherBlockId: string; cardId: string }> = [];
  const misses: Array<{ text: string; kind: SavBlockTestPhrase["kind"]; why: string }> = [];
  for (const { phrase, cards, attribution } of results) {
    if (phrase.kind === "positive") {
      positives++;
      const head = cards.slice(0, SAV_BLOCK_ROUTING_GATES.topK);
      const hit = phrase.expectedCardId ? head.some(card => card.cardId === phrase.expectedCardId) : head.some(card => own.has(card.cardId));
      if (hit) top3++; else misses.push({ text: phrase.text, kind: phrase.kind, why: phrase.expectedCardId ? "expected_card_not_in_top3" : "no_block_card_in_top3" });
      const first = cards[0];
      if (first && first.blockId !== null && first.blockId !== block.blockId) overlaps.push({ text: phrase.text, otherBlockId: first.blockId, cardId: first.cardId });
    } else if (phrase.kind === "neighbour") {
      neighbours++;
      if (!takenBy(attribution, block.blockId)) rejected++; else misses.push({ text: phrase.text, kind: phrase.kind, why: "taken_by_block" });
    } else {
      traps++;
      const expected = phrase.expected ?? "team";
      if (outcomeOf(attribution) === expected) trapsOk++; else misses.push({ text: phrase.text, kind: phrase.kind, why: `expected_${expected}_got_${outcomeOf(attribution)}` });
    }
  }
  const measured = { top3: rate(top3, positives), neighbourRejection: rate(rejected, neighbours), traps: rate(trapsOk, traps) };
  const reasons: string[] = [];
  if (results.length < SAV_BLOCK_ROUTING_GATES.minPhrases) reasons.push(`too_few_phrases:${results.length}<${SAV_BLOCK_ROUTING_GATES.minPhrases}`);
  if (results.length > SAV_BLOCK_ROUTING_GATES.maxPhrases) reasons.push(`too_many_phrases:${results.length}>${SAV_BLOCK_ROUTING_GATES.maxPhrases}`);
  if (measured.top3.rate === null || measured.top3.rate < SAV_BLOCK_ROUTING_GATES.top3HitRate) reasons.push("top3_below_gate");
  if (measured.neighbourRejection.rate === null || measured.neighbourRejection.rate < SAV_BLOCK_ROUTING_GATES.neighbourRejectionRate) reasons.push("neighbour_rejection_below_gate");
  if (measured.traps.total && measured.traps.hits < measured.traps.total) reasons.push("trap_failed");
  if (results.some(row => row.attribution === null)) reasons.push("search_unavailable_for_some_phrases");
  return { blockId: block.blockId, phrases: results.length, ...measured, overlaps, misses, gate: { passed: reasons.length === 0, reasons } };
}
