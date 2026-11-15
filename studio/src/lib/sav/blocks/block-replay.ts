import { SAV_RETRIEVAL_LIMITS, type SavRetrievalBackend } from "../request-retrieval";
import { splitSavMessageText } from "../message-context";
import { attributeSavBlockByCards, rankSavCandidates, savBlockManifestProblems, SAV_BLOCK_ATTRIBUTION_DEFAULTS, type SavBlockAttribution, type SavBlockAttributionThresholds, type SavBlockDraft, type SavRankedCard } from "./block-attribution";
import { measureSavBlockRouting, type SavBlockRoutingMeasurement } from "./routing-measure";
import type { SavRetrievalCandidate } from "../request-retrieval";
import type { SavReplayAttachmentInput, SavReplayDecisionDetail, SavReplayRequestInput, SavReplayStoredCase } from "./replay-decision";

/*
 * SAV-92 harness, phase 1: the offline replay. It takes stored past mails (by Gmail message id) or test phrases and runs attribution and
 * retrieval, and optionally a decision (behind an explicit flag and a budget), and returns a report: the block taken (or team / question),
 * the top cards with their scores, the reply the agent would send, the validator's refusals and the cost.
 *
 * NO EFFECT, by construction: the only ports are a mail READER, a knowledge SEARCH and an optional DECISION port that returns text. There is
 * no port to send an email, write HubSpot, touch a case, a ledger, a budget or a lease, so none can be called; the tests also pass throwing
 * effect members and check this module imports no effect module. A failing step is reported on its item, never silently skipped; the
 * search is retried once.
 */
export const SAV_REPLAY_LIMITS = Object.freeze({ items: 200, searchAttempts: 2, decisionMaxUsd: 10, decisionMaxCalls: 100 });

/**
 * Phase 1b: a phrase (or a stored mail) may name its parts (`requests`, a part `team: true` being one no block covers) and the files V1 listed
 * (`attachments`); a `case` is a stored case replayed as the agent would take it (read only, through `readCase`).
 */
export type SavReplayItemExtras = Readonly<{ requests?: readonly SavReplayRequestInput[]; attachments?: readonly SavReplayAttachmentInput[] }>;
export type SavReplayItem =
  | (Readonly<{ kind: "mail"; messageId: string }> & SavReplayItemExtras)
  | (Readonly<{ kind: "phrase"; id?: string; text: string; subject?: string }> & SavReplayItemExtras)
  | Readonly<{ kind: "case"; caseId: string }>;
export type SavReplayMail = Readonly<{ subject: string; text: string }>;
export type SavReplayCaseRead = SavReplayMail & Readonly<{ stored: SavReplayStoredCase }>;
export type SavReplayDecisionInput = Readonly<{
  ref: string; text: string; attribution: SavBlockAttribution; cards: readonly SavRankedCard[]; block: SavBlockDraft;
  /** Phase 1b: the eligible cards themselves, in ranked order (what the decision may cite), the item and what was read for it. */
  candidates?: readonly SavRetrievalCandidate[]; item?: SavReplayItem; subject?: string; messageId?: string; stored?: SavReplayStoredCase;
}>;
export type SavReplayDecisionOutput = Readonly<{
  action: string; reply: string | null; refusals: readonly string[]; costUsd: number;
  /** Phase 1b: the full reading of the decision path, and whether the spend meter refused a call (`run_cap` stops the run). */
  detail?: SavReplayDecisionDetail; budget?: "ok" | "run_cap" | "mail_cap"; estimatedUsd?: number;
}>;
export type SavReplayPorts = Readonly<{
  /** Read-only: the stored inbound mail, or null when absent or unreadable. */
  readMail?: (messageId: string) => Promise<SavReplayMail | null>;
  /** Read-only: a stored case (snapshot, journal, customer texts and context) and its latest customer mail, or null. */
  readCase?: (caseId: string) => Promise<SavReplayCaseRead | null>;
  /** Read-only: the knowledge search (the V1/V2 index). It may pay query embeddings; it writes nothing. */
  search: SavRetrievalBackend;
  /** Optional and explicit: what the agent would decide and write, with the validator's refusals and the cost. Returns text only. */
  decide?: (input: SavReplayDecisionInput) => Promise<SavReplayDecisionOutput>;
}>;
export type SavReplayOptions = Readonly<{
  blocks: readonly SavBlockDraft[]; now: Date; locale?: string;
  thresholds?: SavBlockAttributionThresholds;
  /** The model is never called unless `enabled` is true AND a budget is given; the run stops calling it at the first bound reached. */
  decision?: Readonly<{ enabled: boolean; maxCalls: number; maxCostUsd: number; /** Only mails attributed to this block are decided. */ blockId?: string }>;
}>;

export type SavReplayDecision =
  | Readonly<{ status: "not_requested" | "not_attributed" | "other_block" | "skipped_budget" }>
  | Readonly<{ status: "failed"; error: string }>
  | Readonly<{ status: "done"; action: string; reply: string | null; refusals: readonly string[]; costUsd: number; estimatedUsd?: number; detail?: SavReplayDecisionDetail }>;
export type SavReplayItemReport = Readonly<{
  ref: string; kind: SavReplayItem["kind"];
  status: "ok" | "mail_unreadable" | "mail_reader_missing" | "case_unreadable" | "case_reader_missing" | "search_unavailable";
  queryCharacters: number; queryTruncated: boolean;
  attribution: SavBlockAttribution | null;
  topCards: readonly SavRankedCard[];
  ineligible: Readonly<Record<string, number>>;
  decision: SavReplayDecision;
  searchAttempts: number;
}>;
export type SavReplayReport = Readonly<{
  effects: "none";
  items: readonly SavReplayItemReport[];
  totals: Readonly<{ items: number; byOutcome: Readonly<Record<string, number>>; failures: number; searchCalls: number; embeddedQueries: number; decisionCalls: number; decisionCostUsd: number;
    decisionEstimatedUsd: number; decisionSkippedBudget: number; budgetStopped: boolean }>;
}>;

function assertOptions(options: SavReplayOptions, ports: SavReplayPorts, count: number) {
  if (count > SAV_REPLAY_LIMITS.items) throw new Error("SAV_REPLAY_TOO_MANY_ITEMS");
  if (!Number.isFinite(options.now.getTime())) throw new Error("SAV_REPLAY_NOW_INVALID");
  const problems = savBlockManifestProblems(options.blocks);
  if (problems.length) throw new Error(`SAV_REPLAY_MANIFEST_INVALID:${problems.map(problem => `${problem.code}:${problem.blockId}${problem.cardId ? `:${problem.cardId}` : ""}`).join(",")}`);
  const decision = options.decision;
  if (decision?.enabled) {
    if (!ports.decide) throw new Error("SAV_REPLAY_DECISION_PORT_MISSING");
    if (!(decision.maxCostUsd > 0 && decision.maxCostUsd <= SAV_REPLAY_LIMITS.decisionMaxUsd)) throw new Error("SAV_REPLAY_DECISION_BUDGET_INVALID");
    if (!(Number.isInteger(decision.maxCalls) && decision.maxCalls > 0 && decision.maxCalls <= SAV_REPLAY_LIMITS.decisionMaxCalls)) throw new Error("SAV_REPLAY_DECISION_CALLS_INVALID");
  }
}

export async function runSavBlockReplay(items: readonly SavReplayItem[], options: SavReplayOptions, ports: SavReplayPorts): Promise<SavReplayReport> {
  assertOptions(options, ports, items.length);
  const locale = options.locale ?? "fr-FR", thresholds = options.thresholds ?? SAV_BLOCK_ATTRIBUTION_DEFAULTS;
  const totals = { items: items.length, byOutcome: {} as Record<string, number>, failures: 0, searchCalls: 0, embeddedQueries: 0, decisionCalls: 0, decisionCostUsd: 0,
    decisionEstimatedUsd: 0, decisionSkippedBudget: 0, budgetStopped: false };
  const reports: SavReplayItemReport[] = [];
  for (const [index, item] of items.entries()) {
    const ref = item.kind === "mail" ? `email:${item.messageId}` : item.kind === "case" ? `case:${item.caseId}` : `phrase:${item.id ?? index + 1}`;
    const base = { ref, kind: item.kind, queryCharacters: 0, queryTruncated: false, attribution: null, topCards: [], ineligible: {}, decision: { status: "not_requested" as const }, searchAttempts: 0 };
    let text: string, query: string, subject: string | undefined, stored: SavReplayStoredCase | undefined;
    if (item.kind === "case") {
      if (!ports.readCase) { reports.push({ ...base, status: "case_reader_missing" }); totals.failures++; continue; }
      let read: SavReplayCaseRead | null = null;
      try { read = await ports.readCase(item.caseId); } catch { read = null; }
      if (!read) { reports.push({ ...base, status: "case_unreadable" }); totals.failures++; continue; }
      const own = splitSavMessageText(read.text).currentText;
      subject = read.subject; stored = read.stored;
      text = [read.subject, own].filter(Boolean).join("\n");
      query = text;
    } else if (item.kind === "mail") {
      if (!ports.readMail) { reports.push({ ...base, status: "mail_reader_missing" }); totals.failures++; continue; }
      let mail: SavReplayMail | null = null;
      try { mail = await ports.readMail(item.messageId); } catch { mail = null; }
      if (!mail) { reports.push({ ...base, status: "mail_unreadable" }); totals.failures++; continue; }
      // The customer's own words (quoted history and signature set aside), as the V2 return rule reads them.
      const own = splitSavMessageText(mail.text).currentText;
      subject = mail.subject;
      text = [mail.subject, own].filter(Boolean).join("\n");
      query = text;
    } else { text = item.text; query = item.text; subject = item.subject; }
    const queryTruncated = query.length > SAV_RETRIEVAL_LIMITS.queryCharacters;
    query = query.slice(0, SAV_RETRIEVAL_LIMITS.queryCharacters).trim();
    let candidates: Awaited<ReturnType<SavRetrievalBackend["search"]>>[number] | null = null, attempts = 0;
    while (candidates === null && attempts < SAV_REPLAY_LIMITS.searchAttempts) {
      attempts++; totals.searchCalls++; totals.embeddedQueries++;
      try {
        const batches = await ports.search.search([query], SAV_RETRIEVAL_LIMITS.candidatesPerQuery);
        if (batches.length !== 1 || batches[0]!.length > SAV_RETRIEVAL_LIMITS.candidatesPerQuery) throw new Error("SAV_REPLAY_SEARCH_CONTRACT");
        candidates = batches[0]!;
      } catch { candidates = null; }
    }
    const withQuery = { ...base, queryCharacters: query.length, queryTruncated, searchAttempts: attempts };
    if (candidates === null) { reports.push({ ...withQuery, status: "search_unavailable" }); totals.failures++; continue; }
    const { cards, ineligible } = rankSavCandidates(query, candidates, options.blocks, { locale, now: options.now });
    const attribution = attributeSavBlockByCards(text, cards, options.blocks, thresholds);
    const outcome = attribution.outcome === "block" ? `block:${attribution.blockId}` : attribution.outcome === "ask" ? "ask" : `team:${attribution.reason}`;
    totals.byOutcome[outcome] = (totals.byOutcome[outcome] ?? 0) + 1;
    let decision: SavReplayDecision = { status: "not_requested" };
    if (options.decision?.enabled) {
      if (attribution.outcome !== "block") decision = { status: "not_attributed" };
      else if (options.decision.blockId !== undefined && attribution.blockId !== options.decision.blockId) decision = { status: "other_block" };
      else if (totals.budgetStopped || totals.decisionCalls >= options.decision.maxCalls || totals.decisionCostUsd >= options.decision.maxCostUsd) { decision = { status: "skipped_budget" }; totals.decisionSkippedBudget++; }
      else {
        totals.decisionCalls++;
        const block = options.blocks.find(row => row.blockId === attribution.blockId)!;
        const topCards = cards.slice(0, SAV_BLOCK_ATTRIBUTION_DEFAULTS.topCards);
        // The eligible cards themselves, in the ranked order (one candidate per ranked card, at the ranked version).
        const chosen = topCards.flatMap(card => candidates!.find(row => row.id === card.cardId && row.contentVersionId === card.contentVersionId) ?? []);
        try {
          const out = await ports.decide!({ ref, text, attribution, cards: topCards, block, candidates: chosen, item, ...(subject !== undefined ? { subject } : {}),
            ...(item.kind === "mail" ? { messageId: item.messageId } : {}), ...(stored ? { stored } : {}) });
          const costUsd = Number.isFinite(out.costUsd) && out.costUsd >= 0 ? out.costUsd : options.decision.maxCostUsd;
          totals.decisionCostUsd += costUsd;
          const estimatedUsd = Number.isFinite(out.estimatedUsd) && out.estimatedUsd! >= 0 ? out.estimatedUsd! : 0;
          totals.decisionEstimatedUsd += estimatedUsd;
          // The run cap of the spend meter refused a call: no further mail is decided (the run stops spending; the report goes on).
          if (out.budget === "run_cap") totals.budgetStopped = true;
          if (out.budget === "run_cap" && !(out.detail?.cost.calls)) { decision = { status: "skipped_budget" }; totals.decisionSkippedBudget++; totals.decisionCalls--; }
          else decision = { status: "done", action: out.action, reply: out.reply, refusals: [...out.refusals], costUsd, estimatedUsd, ...(out.detail ? { detail: out.detail } : {}) };
        } catch (error) {
          // An uncertain call is counted at the remaining budget: the run never spends past its bound on a retry.
          totals.decisionCostUsd = options.decision.maxCostUsd;
          decision = { status: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "decision_failed" };
        }
      }
    }
    reports.push({ ...withQuery, status: "ok", attribution, topCards: cards.slice(0, SAV_BLOCK_ATTRIBUTION_DEFAULTS.topCards), ineligible, decision });
  }
  return { effects: "none", items: reports, totals };
}

/** Gate 2 on one block's own test phrases: replay them (never the model), then measure. */
export async function measureSavBlockTestPhrases(blockId: string, options: Omit<SavReplayOptions, "decision">, ports: Pick<SavReplayPorts, "search">): Promise<SavBlockRoutingMeasurement & { report: SavReplayReport }> {
  const block = options.blocks.find(row => row.blockId === blockId);
  if (!block) throw new Error("SAV_REPLAY_BLOCK_UNKNOWN");
  const phrases = block.testPhrases ?? [];
  const report = await runSavBlockReplay(phrases.map((phrase, index) => ({ kind: "phrase" as const, id: `${blockId}-${index + 1}`, text: phrase.text })), options, { search: ports.search });
  const measurement = measureSavBlockRouting(block, report.items.map((row, index) => ({ phrase: phrases[index]!, cards: row.topCards, attribution: row.attribution })));
  return { ...measurement, report };
}
