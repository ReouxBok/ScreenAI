import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import type { SmartCheckCode, SmartDecision, SmartReading } from "./smart-contract";

/*
 * Agent SAV intelligent (20/11, HARNAIS 2): the memory of ONE case thread and the progress rule. Pure: no model, network, database or clock.
 *
 * The memory says what was already said, asked and tried, so the agent never repeats itself: facts (from the customer, a card or Academy, with
 * their source), hypotheses and their state, trials and their result, questions asked. The model receives it (bounded) instead of the whole thread
 * and writes its update in the decision (`decision.memory`); the SERVER merges and counts, never the model:
 *   - a new fact counts when its excerpt is word for word in the customer's latest mail and it is not already known;
 *   - a trial result counts when that trial was pending; a hypothesis counts when it closes (ruled out, confirmed) after being open.
 * Progress rule (`smartProgressGate`): two turns in a row without progress, or the 5th exchange (`SAV_V2_SMART_MAX_EXCHANGES`, 4 or 5), and the only
 * accepted outcome is a handoff with a good note. Two refusals only, both on repetition: `question_repeated` (a question already asked and
 * answered) and `trial_repeated` (a trial that already failed proposed again). No fixed number of trials, no other rule.
 *
 * Shadow limit: a shadow reply is never sent, so its questions and trials are not recorded (`recordOwn: false`); the shadow seeds the memory
 * from the thread. The bench records them (its replies are « sent » to the fictional customer) and is where the progress rule is proven.
 */

export const SAV_SMART_MEMORY_REVISION = "sav-smart-memory-2026-11-20.v1";
export const SAV_SMART_MAX_EXCHANGES_ENV = "SAV_V2_SMART_MAX_EXCHANGES";
export const SAV_SMART_DEFAULT_MAX_EXCHANGES = 5;
const MAX = { needs: 4, facts: 12, hypotheses: 6, trials: 6, questions: 4 } as const;

export type SmartMemoryFact = Readonly<{ needId: string; text: string; from: "client" | "fiche" | "academy"; ref: string; turn: number }>;
export type SmartMemoryHypothesis = Readonly<{ id: string; needId: string; text: string; status: "open" | "ruled_out" | "confirmed"; why: string }>;
export type SmartMemoryTrial = Readonly<{ id: string; needId: string; what: string; cardId: string | null; turn: number; result: "pending" | "worked" | "failed" }>;
export type SmartMemoryQuestion = Readonly<{ needId: string; text: string; turn: number; answered: boolean }>;
export type SmartCaseMemory = Readonly<{
  revision: string;
  /** Customer mails handled so far on this thread. */
  exchanges: number;
  /** One boolean per handled turn: did it bring something new? */
  progress: readonly boolean[];
  needs: ReadonlyArray<Readonly<{ id: string; ask: string; status: "open" | "asked" | "answered" | "handed" | "resolved" }>>;
  facts: readonly SmartMemoryFact[];
  hypotheses: readonly SmartMemoryHypothesis[];
  trials: readonly SmartMemoryTrial[];
  questions: readonly SmartMemoryQuestion[];
}>;

export const smartEmptyMemory = (exchanges = 0): SmartCaseMemory =>
  ({ revision: SAV_SMART_MEMORY_REVISION, exchanges, progress: [], needs: [], facts: [], hypotheses: [], trials: [], questions: [] });

/** The shadow's seed: no stored memory, the exchanges counted from the customer's earlier messages on the thread. */
export const smartMemoryFromThread = (thread: ReadonlyArray<Readonly<{ from: "customer" | "support" }>>): SmartCaseMemory =>
  smartEmptyMemory(thread.filter(row => row.from === "customer").length);

/** `SAV_V2_SMART_MAX_EXCHANGES`: 4 or 5, anything else is the default 5. */
export function smartMaxExchanges(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[SAV_SMART_MAX_EXCHANGES_ENV];
  return raw === "4" || raw === "5" ? Number(raw) : SAV_SMART_DEFAULT_MAX_EXCHANGES;
}

const words = (value: string) => new Set(normalizeSavEvidenceText(value).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3));
/** Word overlap (Jaccard on words of more than 3 letters): « the same question / trial » without asking for the exact wording. */
export function smartSimilarity(a: string, b: string): number {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return normalizeSavEvidenceText(a) === normalizeSavEvidenceText(b) ? 1 : 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}
const SAME = 0.6;

export type SmartProgressGate = Readonly<{
  /** The model is told it must hand over (`mustHandOff: true`); any other outcome is converted to a handoff by the server. */
  mustHandOff: boolean;
  reason: "max_exchanges" | null;
  /** The previous turn brought nothing new: the model is told so (a hint, not a rule). */
  noProgressLastTurn: boolean;
  /** This mail's rank on the thread (1 = first mail). */
  exchange: number;
}>;

/** Before deciding: the exchange cap (the 5th exchange hands over) and the « last turn brought nothing » hint. */
export function smartProgressGate(memory: SmartCaseMemory, maxExchanges = SAV_SMART_DEFAULT_MAX_EXCHANGES): SmartProgressGate {
  const exchange = memory.exchanges + 1;
  const capped = exchange >= maxExchanges;
  return { mustHandOff: capped, reason: capped ? "max_exchanges" : null, noProgressLastTurn: memory.progress.length > 0 && memory.progress.at(-1) === false, exchange };
}

/*
 * v18 (bench 22/11, multi-progres-05, resolu-04: « URL + capture » asked again). The questions already asked on this case, answered or not, given
 * to decide as `askedBefore` so the MODEL chooses not to ask them again (answer with the cards, or hand over). No new refusal (Ugo, 22/11: fewer
 * handoffs and questions, never more): `question_repeated` below is unchanged.
 */
export const smartAskedBefore = (memory: SmartCaseMemory) => memory.questions.map(row => row.text.slice(0, 300));

/** The two repetition refusals, on a decision against the memory. */
export function smartRepeatCodes(memory: SmartCaseMemory, decision: SmartDecision): SmartCheckCode[] {
  const codes: SmartCheckCode[] = [];
  const question = decision.memory.question?.trim();
  if (question && decision.outcome !== "handoff" && memory.questions.some(row => row.answered && smartSimilarity(row.text, question) >= SAME)) codes.push("question_repeated");
  const failed = memory.trials.filter(row => row.result === "failed");
  if (decision.outcome !== "handoff" && decision.memory.trials.some(trial => failed.some(row => smartSimilarity(row.what, trial.what) >= SAME))) codes.push("trial_repeated");
  return codes;
}

export type SmartMemoryMerge = Readonly<{ memory: SmartCaseMemory; progressed: boolean; counted: readonly string[] }>;

/**
 * After a turn: merges what the decision taught into the memory and says whether the turn progressed. `latestCustomerText`: the customer's
 * latest mail as the model read it (masked). `recordOwn`: the reply was really sent (bench, later the live agent), so its question and trials
 * are recorded; false in the shadow. The first exchange always counts as progress (a new case).
 */
export function smartMergeMemory(input: Readonly<{
  memory: SmartCaseMemory; decision: SmartDecision | null; reading: SmartReading | null; latestCustomerText: string; recordOwn: boolean;
}>): SmartMemoryMerge {
  const { memory, decision, reading } = input, turn = memory.exchanges + 1, counted: string[] = [];
  const update = decision?.memory ?? { newFacts: [], hypotheses: [], trials: [], trialResults: [], question: null };
  const facts = [...memory.facts], hypotheses = [...memory.hypotheses], trials = [...memory.trials];
  let questions = [...memory.questions];

  for (const fact of update.newFacts) {
    if (!savEvidenceContains(input.latestCustomerText, fact.excerpt)) continue;
    if (facts.some(row => smartSimilarity(row.text, fact.text) >= 0.8)) continue;
    facts.push({ needId: fact.needId, text: fact.text, from: "client", ref: `mail ${turn}`, turn });
    counted.push("fact");
  }
  for (const fact of decision?.facts ?? []) {
    if (fact.type !== "fait_limova" && fact.type !== "fait_temporaire") continue;
    const ref = fact.sourceKind === "academy" ? `academy ${fact.toolCallId ?? "?"}` : `fiche ${fact.cardId ?? "?"} ${fact.version ?? ""}`.trim();
    if (!facts.some(row => row.ref === ref && smartSimilarity(row.text, fact.sentence) >= 0.8))
      facts.push({ needId: fact.needId, text: fact.sentence, from: fact.sourceKind === "academy" ? "academy" : "fiche", ref, turn });
  }
  for (const result of update.trialResults) {
    const index = trials.findIndex(row => row.id === result.trialId && row.result === "pending");
    if (index < 0) continue;
    trials[index] = { ...trials[index]!, result: result.result };
    counted.push(`trial_${result.result}`);
  }
  for (const hypothesis of update.hypotheses) {
    const index = hypotheses.findIndex(row => row.id === hypothesis.id);
    if (index < 0) { hypotheses.push(hypothesis); if (hypothesis.status !== "open") counted.push("hypothesis_closed"); continue; }
    if (hypotheses[index]!.status === "open" && hypothesis.status !== "open") counted.push("hypothesis_closed");
    hypotheses[index] = { ...hypotheses[index]!, ...hypothesis };
  }
  // A question asked earlier is answered when the customer's next mail brought a new fact.
  if (counted.includes("fact")) questions = questions.map(row => row.turn < turn ? { ...row, answered: true } : row);
  if (input.recordOwn && decision && decision.outcome !== "handoff") {
    for (const trial of update.trials) if (!trials.some(row => row.id === trial.id)) trials.push({ ...trial, turn, result: "pending" });
    if (update.question?.trim()) questions.push({ needId: decision.coverage.find(row => row.status === "asked")?.needId ?? "n1", text: update.question.trim(), turn, answered: false });
  }
  const statusOf = (needId: string): SmartCaseMemory["needs"][number]["status"] => {
    const coverage = decision?.coverage.find(row => row.needId === needId)?.status;
    return coverage === "handed" ? "handed" : coverage === "asked" ? "asked" : coverage === "answered" ? "answered" : "open";
  };
  const needs = reading?.needs.length ? reading.needs.map(need => ({ id: need.id, ask: need.ask, status: statusOf(need.id) })) : [...memory.needs];
  const progressed = turn === 1 || counted.length > 0;
  return {
    progressed, counted,
    memory: {
      revision: SAV_SMART_MEMORY_REVISION, exchanges: turn, progress: [...memory.progress, progressed].slice(-10), needs: needs.slice(0, MAX.needs),
      facts: facts.slice(-MAX.facts), hypotheses: hypotheses.slice(-MAX.hypotheses), trials: trials.slice(-MAX.trials), questions: questions.slice(-MAX.questions),
    },
  };
}

/** What the model reads of the memory: compact, bounded (3 000 bytes), oldest facts dropped first. */
export function smartMemoryForModel(memory: SmartCaseMemory, maxBytes = 3_000) {
  const view = {
    exchange: memory.exchanges + 1,
    facts: memory.facts.map(row => ({ text: row.text, from: row.from, ref: row.ref })),
    hypotheses: memory.hypotheses.map(row => ({ id: row.id, text: row.text, status: row.status })),
    trials: memory.trials.map(row => ({ id: row.id, what: row.what, result: row.result })),
    questions: memory.questions.map(row => ({ text: row.text, answered: row.answered })),
  };
  while (Buffer.byteLength(JSON.stringify(view), "utf8") > maxBytes && view.facts.length) view.facts.shift();
  while (Buffer.byteLength(JSON.stringify(view), "utf8") > maxBytes && view.trials.length) view.trials.shift();
  return view;
}

/** The progress rule after a turn: this turn and the previous one brought nothing new (two turns in a row without progress). */
export const smartNoProgressTwice = (before: SmartCaseMemory, progressed: boolean) => !progressed && before.progress.length > 0 && before.progress.at(-1) === false;
