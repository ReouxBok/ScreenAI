import { assessSavKnowledgeValidity, savRetrievalRanking, type SavRetrievalCandidate } from "../request-retrieval";
import { SAV_CASE_RELEVANCE_SEMANTIC_FLOOR } from "../cases/investigation-knowledge-ranking";
import { caseSensitiveFamiliesInText, normalizeSensitiveText } from "../cases/sensitive-words";
import type { CaseRequestFamily } from "../cases/case-types";

/*
 * SAV-92 harness, phase 1: attribution of a mail to a block BY ITS CARDS (target of the audit §5.3), measured offline only. Nothing here is
 * wired into production: the live entry still uses the code detector of `case-block-registry.ts` until phase 2 (block manifest in base).
 *
 * A block is data (SavBlockDraft): its cards (a card belongs to ONE block for attribution; it may still serve as supporting knowledge
 * elsewhere), its exclusions, its neighbours, what stays human, its questions, its test phrases and its mode. Attribution:
 *   1. a sensitive word anywhere (finance, cancellation, subscription, rights, identity: fixed code rule) → the whole mail to the team;
 *   2. the eligible cards found for the text, ranked with the retrieval's own score (`savRetrievalRanking`);
 *   3. the best block = the block of the best-ranked card that belongs to a block; its card must reach the absolute floor (cosine score);
 *   4. its score must lead the best card of ANY other block by the margin, otherwise it is ambiguous → a clarifying question;
 *   5. an exclusion phrase of that block found in the text → the team.
 * Pure: no model, embedding, network, database or clock of its own.
 */
export const SAV_BLOCK_MODES = ["off", "shadow", "automatic"] as const;
export type SavBlockMode = typeof SAV_BLOCK_MODES[number];
export type SavBlockTestPhraseKind = "positive" | "neighbour" | "trap";
/** `expected`: for a trap, what must happen (default: the team); for a positive phrase, optionally the exact card expected in the top 3. */
export type SavBlockTestPhrase = Readonly<{ text: string; kind: SavBlockTestPhraseKind; expectedCardId?: string; expected?: "team" | "ask" | string }>;
export type SavBlockDraft = Readonly<{
  blockId: string; label?: string; mode: SavBlockMode;
  /** Attribution cards: one block each. */
  cardIds: readonly string[];
  /** Cards read as supporting knowledge only (never attribute). */
  supportCardIds?: readonly string[];
  /** Phrases that, found in the mail, take it away from this block. */
  exclusions?: readonly string[];
  /** Blocks this block is easily confused with (its test phrases should include theirs as neighbours). */
  neighbours?: readonly string[];
  /** What the agent must ask before answering, and what stays human: carried for the report, not judged here. */
  askBefore?: readonly string[]; humanOnly?: readonly string[];
  testPhrases?: readonly SavBlockTestPhrase[];
}>;

/** Provisional thresholds (to calibrate on the evaluation set, K6): the V2 floor and a margin on the ranking score. */
export const SAV_BLOCK_ATTRIBUTION_DEFAULTS = Object.freeze({ semanticFloor: SAV_CASE_RELEVANCE_SEMANTIC_FLOOR, margin: 0.05, topCards: 5 });
export type SavBlockAttributionThresholds = Readonly<{ semanticFloor: number; margin: number }>;

export type SavRankedCard = Readonly<{ cardId: string; contentVersionId: string; title: string; blockId: string | null; semanticScore: number | null; lexicalScore: number; rankingScore: number }>;
export type SavBlockAttribution =
  | Readonly<{ outcome: "block"; blockId: string; cardId: string; score: number; secondBlockId: string | null; margin: number | null }>
  | Readonly<{ outcome: "ask"; reason: "ambiguous"; blockIds: readonly string[]; score: number; margin: number }>
  | Readonly<{ outcome: "team"; reason: "sensitive"; families: readonly CaseRequestFamily[] }>
  | Readonly<{ outcome: "team"; reason: "no_block_card" | "below_floor" | "excluded"; blockId?: string; exclusion?: string; score?: number }>;

export type SavBlockManifestProblem = Readonly<{ code: "block_id_invalid" | "block_id_duplicate" | "card_in_two_blocks" | "mode_invalid" | "card_list_empty"; blockId: string; cardId?: string }>;
const BLOCK_ID = /^[a-z][a-z0-9_-]{1,63}$/;

/** A manifest must be unambiguous before anything is measured: one block per attribution card, unique ids, a known mode. */
export function savBlockManifestProblems(blocks: readonly SavBlockDraft[]): SavBlockManifestProblem[] {
  const problems: SavBlockManifestProblem[] = [];
  const owner = new Map<string, string>(), ids = new Set<string>();
  for (const block of blocks) {
    if (!BLOCK_ID.test(block.blockId)) problems.push({ code: "block_id_invalid", blockId: block.blockId });
    if (ids.has(block.blockId)) problems.push({ code: "block_id_duplicate", blockId: block.blockId });
    ids.add(block.blockId);
    if (!(SAV_BLOCK_MODES as readonly string[]).includes(block.mode)) problems.push({ code: "mode_invalid", blockId: block.blockId });
    if (!block.cardIds.length) problems.push({ code: "card_list_empty", blockId: block.blockId });
    for (const cardId of new Set(block.cardIds)) {
      const other = owner.get(cardId);
      if (other !== undefined && other !== block.blockId) problems.push({ code: "card_in_two_blocks", blockId: block.blockId, cardId });
      else owner.set(cardId, block.blockId);
    }
  }
  return problems;
}

/** The eligible candidates of one query, ranked as the retrieval ranks them, deduplicated by card; the ineligible ones are counted by reason. */
export function rankSavCandidates(query: string, candidates: readonly SavRetrievalCandidate[], blocks: readonly SavBlockDraft[], context: Readonly<{ locale: string; now: Date }>) {
  const blockOf = new Map<string, string>();
  for (const block of blocks) for (const cardId of block.cardIds) if (!blockOf.has(cardId)) blockOf.set(cardId, block.blockId);
  const ineligible: Record<string, number> = {};
  const ranked = new Map<string, SavRankedCard>();
  for (const candidate of candidates) {
    const validity = assessSavKnowledgeValidity(candidate, context.locale, "support", context.now);
    if (!validity.eligible) { ineligible[validity.reason] = (ineligible[validity.reason] ?? 0) + 1; continue; }
    const signals = savRetrievalRanking(query, candidate);
    const previous = ranked.get(candidate.id);
    if (previous && previous.rankingScore >= signals.rankingScore) continue;
    ranked.set(candidate.id, { cardId: candidate.id, contentVersionId: candidate.contentVersionId, title: candidate.title, blockId: blockOf.get(candidate.id) ?? null, ...signals });
  }
  const cards = [...ranked.values()].sort((a, b) => b.rankingScore - a.rankingScore || a.cardId.localeCompare(b.cardId));
  return { cards, ineligible };
}

const phrase = (value: string) => ` ${normalizeSensitiveText(value).replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `;

export function attributeSavBlockByCards(text: string, cards: readonly SavRankedCard[], blocks: readonly SavBlockDraft[],
  thresholds: SavBlockAttributionThresholds = SAV_BLOCK_ATTRIBUTION_DEFAULTS): SavBlockAttribution {
  const families = caseSensitiveFamiliesInText(text);
  if (families.length) return { outcome: "team", reason: "sensitive", families };
  const best = cards.find(card => card.blockId !== null);
  if (!best) return { outcome: "team", reason: "no_block_card" };
  const blockId = best.blockId!;
  if (best.semanticScore !== null && best.semanticScore < thresholds.semanticFloor) return { outcome: "team", reason: "below_floor", blockId, score: best.rankingScore };
  const second = cards.find(card => card.blockId !== null && card.blockId !== blockId);
  const margin = second ? best.rankingScore - second.rankingScore : null;
  if (second && margin! < thresholds.margin && !(second.semanticScore !== null && second.semanticScore < thresholds.semanticFloor))
    return { outcome: "ask", reason: "ambiguous", blockIds: [blockId, second.blockId!], score: best.rankingScore, margin: margin! };
  const block = blocks.find(row => row.blockId === blockId)!;
  const normalized = phrase(text);
  const exclusion = (block.exclusions ?? []).find(value => phrase(value).trim() && normalized.includes(phrase(value)));
  if (exclusion) return { outcome: "team", reason: "excluded", blockId, exclusion, score: best.rankingScore };
  return { outcome: "block", blockId, cardId: best.cardId, score: best.rankingScore, secondBlockId: second?.blockId ?? null, margin };
}
