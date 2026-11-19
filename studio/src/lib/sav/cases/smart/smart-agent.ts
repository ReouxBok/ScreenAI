import { savReplyFooter } from "../../reply-format";
import { smartServerChecks, type SmartSource } from "./smart-checks";
import {
  parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartStepSchema, smartVerdictSchema,
  type SmartCallKind, type SmartCheckCode, type SmartDecision, type SmartReading, type SmartTeamNote, type SmartTurnOutcome, type SmartVerdict,
} from "./smart-contract";
import { renderSmartTeamNote, smartFallbackNote, smartSensitiveNote } from "./smart-handoff-note";
import {
  smartEmptyMemory, smartMemoryForModel, smartMergeMemory, smartNoProgressTwice, smartProgressGate, SAV_SMART_DEFAULT_MAX_EXCHANGES, type SmartCaseMemory,
} from "./smart-memory";
import type { SmartCallResult, SmartModelPort } from "./smart-model";
import { smartWireBytes } from "./smart-model";
import { savEvidenceContains } from "../../evidence-text";
import { smartHintsExplained, smartMask, smartSafetyNet } from "./smart-net";
import { SAV_SMART_RESOURCES, smartCorrectionPrompt, smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import { createSmartToolRunner, smartToolCatalogue, SAV_SMART_TOOL_LIMITS, SAV_SMART_TOOL_RESULTS_NOTE, type SmartToolOutcome } from "./smart-tools";
import type { AcademyTool } from "./tools/academy";

/*
 * Agent SAV intelligent (20/11, v2 the same day: HARNAIS_BOUCLE): ONE turn of the new agent on one customer mail, with its ports injected
 * (model, knowledge, tools, memory). No database, no clock of its own, no effect: it returns what it would do. The shadow stores it; the bench scores it.
 *
 *   0. filet      `smartSafetyNet` on the INTEGRAL raw texts: a real sensitive request (or an odd mail), the whole mail to the team, 0 call;
 *   1. comprendre one call: the needs (PS included), what the customer already did, and `sensible {famille, preuve}` (barrier 2): a family other
 *                 than « aucune », an absent field, or a hint of the net without a verbatim proof of another subject: the whole mail to the team;
 *   2. chercher   the existing search, through the knowledge port, at most 3 needs;
 *   3. décider    the BOUNDED LOOP: at most 3 passes. Each pass returns one step: « thinking », then read-only tool calls (`chercher_fiches`, Academy
 *                 when its switch is on; at most 4 calls per mail, 3 per pass, in parallel) or the final decision. Tool results come back as
 *                 UNTRUSTED data. On the 3rd pass the tools are removed and `lastStep: true`: the model concludes. The case memory and the
 *                 progress gate are in the payload (`mustHandOff` at the 5th exchange, `noProgressLastTurn` as a hint);
 *   3 bis.        progress rule: this turn and the previous one brought nothing new, or the exchange cap: the decision becomes a handoff;
 *   4. vérifier   the server's checks (no model, repetitions included), then ONE independent counter-read; any refusal gets ONE correction,
 *                 checked and counter-read again; still refused: hand over. A counter-read that says « conforme » never overrides a server refusal.
 *   5. retenir    the memory is merged by the server (it counts the progress, never the model) and returned for the caller to store.
 * Every handoff carries a structured note: the model's, or the server's fallback composed from the memory (failure, budget, no progress).
 * Calls: 3 in the common case (understand, decide, verify); 7 at most (understand, 3 decide passes, verify, correct, reverify). A failed or
 * out-of-time call stops the turn (`failed` / `interrupted`), never a reply.
 */

export type SmartThreadMessage = Readonly<{ from: "customer" | "support"; at: string; text: string }>;
export type SmartTurnInput = Readonly<{
  subject: string; body: string; thread: readonly SmartThreadMessage[];
  /** The case memory before this mail (stored by the caller); absent: an empty memory seeded with the thread's customer messages. */
  memory?: SmartCaseMemory;
}>;
export type SmartKnowledgeResult = Readonly<{
  status: "ok" | "unavailable"; sources: readonly SmartSource[];
  /** Closed codes of the search (budget, no source...), never a text. */
  codes: readonly string[];
}>;
export type SmartKnowledgePort = (needs: SmartReading["needs"]) => Promise<SmartKnowledgeResult>;
export type SmartTurnPorts = Readonly<{
  model: SmartModelPort; knowledge: SmartKnowledgePort;
  /** The byte cap of one call (`smartInputCap`): the payload is reduced to fit, never sent above. */
  maxInputBytes: number;
  /** Today (YYYY-MM-DD): a temporary card whose end has passed is never given to the model. */
  today: string;
  /** Academy tools (`getAcademyTools()`: empty unless `SAV_V2_SMART_ACADEMY=on`). `chercher_fiches` is always on. */
  academy?: readonly AcademyTool[];
  /** The reply is really delivered (bench; later the live agent): its question and trials are recorded in the memory. False in the shadow. */
  recordOwn?: boolean;
  /** `smartMaxExchanges(env)`: 4 or 5. */
  maxExchanges?: number;
}>;
export type SmartCallRecord = Readonly<{ kind: SmartCallKind; status: "ok" | "failed"; problem: string | null; inputBytes: number; uncertain: boolean; sent: boolean;
  usage: Readonly<{ inputTokens: number; outputTokens: number }> | null }>;
/** One line per decide pass and per tool call: codes and numbers only (the text stays encrypted with the result). */
export type SmartStepRecord = Readonly<{ pass: number; kind: "decide" | "tool"; action?: "tools" | "final" | "invalid"; tool?: string; status?: string; code?: string | null; argsHash?: string; bytes?: number }>;
export type SmartTurnResult = Readonly<{
  outcome: SmartTurnOutcome;
  /** Closed codes: why it stopped, what was refused, what was cut. */
  reasons: readonly string[];
  /** Where a sensitive mail was stopped: the net (no model) or the reading. */
  sensitiveStop: "net" | "understand" | null;
  reading: SmartReading | null;
  decision: SmartDecision | null;
  /** The text the customer would have received (masked inputs, footer with the AI mention added by the server), or null. */
  replyWithFooter: string | null;
  checks: Readonly<{ first: readonly SmartCheckCode[] | null; second: readonly SmartCheckCode[] | null }>;
  verdicts: Readonly<{ first: SmartVerdict | null; second: SmartVerdict | null }>;
  corrected: boolean;
  calls: readonly SmartCallRecord[];
  sources: ReadonlyArray<Readonly<{ cardId: string; version: string; needIds: readonly string[] }>>;
  /** Needs without any card, with their theme (the « missing cards by theme » report). */
  missing: ReadonlyArray<Readonly<{ needId: string; theme: string | null }>>;
  /** v2: the decide passes and tool calls. */
  steps: readonly SmartStepRecord[];
  /** v2: the note for the team on a handoff (the model's, or the server's fallback), structured and rendered; a sensitive mail gets its short note. */
  teamNote: SmartTeamNote | null;
  teamNoteText: string | null;
  /** v2: the case memory after this mail (to store by thread), and whether this mail brought something new. */
  memory: SmartCaseMemory;
  progressed: boolean;
}>;

const THREAD_MAX = 3, THREAD_CHARS = 800;
/** Decide passes per mail: 2 rounds of tools, then a decision (HARNAIS 1). */
export const SAV_SMART_MAX_DECIDE_PASSES = 3;
/** Worst case of model calls per mail: understand + 3 decide passes + verify + correct + reverify. */
export const SAV_SMART_MAX_MODEL_CALLS = 1 + SAV_SMART_MAX_DECIDE_PASSES + 3;
/** Worst case of query embeddings per mail: the first search + one per `chercher_fiches` call that can still run (bounded by the shadow's port). */
export const SAV_SMART_MAX_EMBED_CALLS = 3;

const mergeSources = (given: readonly SmartSource[], found: readonly SmartSource[]) => {
  const out = [...given];
  for (const card of found) {
    const index = out.findIndex(row => row.cardId === card.cardId && row.version === card.version);
    if (index < 0) out.push(card);
    else out[index] = { ...out[index]!, needIds: [...new Set([...out[index]!.needIds, ...card.needIds])] };
  }
  return out;
};
const cardView = (card: SmartSource) => ({ cardId: card.cardId, version: card.version, title: card.title, content: card.content, steps: card.steps, needIds: card.needIds,
  ...(card.validUntil ? { validUntil: card.validUntil } : {}) });

/** One turn. Never throws for a model failure: the result says where and why it stopped. */
export async function runSmartTurn(input: SmartTurnInput, ports: SmartTurnPorts): Promise<SmartTurnResult> {
  const calls: SmartCallRecord[] = [], steps: SmartStepRecord[] = [];
  const memoryBefore = input.memory ?? smartEmptyMemory(input.thread.filter(row => row.from === "customer").length);
  let reading: SmartReading | null = null, decision: SmartDecision | null = null, corrected = false;
  let sources: SmartSource[] = [], missing: Array<{ needId: string; theme: string | null }> = [];
  let academy: ReturnType<ReturnType<typeof createSmartToolRunner>["academy"]> = [];
  const checks: { first: SmartCheckCode[] | null; second: SmartCheckCode[] | null } = { first: null, second: null };
  const verdicts: { first: SmartVerdict | null; second: SmartVerdict | null } = { first: null, second: null };
  const customer = {
    subject: smartMask(input.subject), mail: smartMask(input.body),
    thread: input.thread.slice(-THREAD_MAX).map(row => ({ from: row.from, at: row.at, text: smartMask(row.text).slice(0, THREAD_CHARS) })),
  };
  const customerText = [customer.subject, customer.mail, ...customer.thread.map(row => row.text)].join("\n");
  const latestCustomerText = `${customer.subject}\n${customer.mail}`;

  const end = (outcome: SmartTurnOutcome, reasons: readonly string[], extra: Readonly<{ sensitiveStop?: "net" | "understand"; replyWithFooter?: string | null; note?: SmartTeamNote | null; noteText?: string | null }> = {}): SmartTurnResult => {
    // The memory: merged on every ending that read the mail (a failure or an interruption leaves it unchanged: the mail will be replayed).
    const merged = outcome === "failed" || outcome === "interrupted" ? { memory: memoryBefore, progressed: false }
      : smartMergeMemory({ memory: memoryBefore, reading, latestCustomerText, recordOwn: Boolean(ports.recordOwn) && outcome !== "team_sensitive",
        // A refused reply that ends as a handoff was never delivered: only what the customer said is kept, not its facts, trials or question.
        decision: decision && outcome === "handoff" && decision.outcome !== "handoff" ? { ...decision, outcome: "handoff", facts: [] } : decision });
    const note = extra.note ?? (outcome === "handoff" ? decision?.teamNote ?? smartFallbackNote({ reason: "other", reading, memory: merged.memory }) : null);
    return {
      outcome, reasons: [...new Set(reasons)], sensitiveStop: extra.sensitiveStop ?? null, reading, decision, replyWithFooter: extra.replyWithFooter ?? null, checks, verdicts, corrected, calls,
      sources: sources.map(row => ({ cardId: row.cardId, version: row.version, needIds: row.needIds })), missing, steps,
      teamNote: note, teamNoteText: extra.noteText ?? (note ? renderSmartTeamNote(note) : null), memory: merged.memory, progressed: merged.progressed,
    };
  };
  const handoff = (reasons: readonly string[], reason: SmartTeamNote["raison"]) =>
    end("handoff", reasons, { note: smartFallbackNote({ reason, reading, memory: memoryBefore, modelNote: decision?.teamNote ?? null }) });
  const call = async (kind: Exclude<SmartCallKind, "embed">, system: string, payload: unknown, temperature: number): Promise<SmartCallResult> => {
    const result = await ports.model({ kind, system, payload, temperature });
    calls.push({ kind, status: result.status, problem: result.status === "failed" ? result.problem : null, inputBytes: result.inputBytes,
      uncertain: result.status === "failed" && result.uncertain, sent: result.status === "ok" || result.sent, usage: result.usage });
    return result;
  };

  // 0. The net, on the integral raw texts.
  const net = smartSafetyNet({ subject: input.subject, body: input.body });
  if (net.stop) return end("team_sensitive", net.reasons, { sensitiveStop: "net", note: null, noteText: smartSensitiveNote(net.reasons) });
  const hints = net.hints;

  // 1. Understand.
  const understood = await call("understand", smartUnderstandPrompt(), { customer }, 0);
  if (understood.status === "failed") return understood.problem === "deadline" ? end("interrupted", ["understand:deadline"]) : end("failed", [`understand:${understood.problem}`]);
  const parsedReading = parseSmartOutput(smartReadingSchema, understood.output);
  if (!parsedReading.ok) return end("failed", ["understand:output_invalid"]);
  reading = parsedReading.value;
  // Barrier 2, imposed by the server (Astra, 20/11): the model names the sensitive family with an exact quote. Not « aucune », absent or
  // unreadable: the whole mail to the team. A hint of the net stands unless « aucune » comes with a verbatim proof of another subject.
  const sensible = reading.sensible;
  const stopSensible = (codes: readonly string[]) =>
    end("team_sensitive", [...hints, ...codes], { sensitiveStop: "understand", note: null, noteText: smartSensitiveNote(sensible && sensible.famille !== "aucune" ? [sensible.famille] : hints) });
  if (!sensible) return stopSensible(["understand:sensible_missing"]);
  if (sensible.famille !== "aucune") return stopSensible([`understand:sensible_${sensible.famille}`]);
  if (hints.length && !(sensible.preuve.trim() && savEvidenceContains(customerText, sensible.preuve) && smartHintsExplained(hints, sensible.preuve)))
    return stopSensible(["understand:hint_unexplained"]);
  if (reading.sensitive !== "no") {
    const families = reading.sensitiveFamilies.map(family => `family:${family}`);
    return end("team_sensitive", [...hints, `understand:sensitive_${reading.sensitive}`, ...families], { sensitiveStop: "understand", note: null, noteText: smartSensitiveNote(reading.sensitiveFamilies) });
  }
  if (reading.instructionInMail) return handoff([...hints, "understand:instruction_in_mail"], "other");
  if (reading.wantsHuman) return handoff([...hints, "understand:wants_human"], "wants_human");
  if (!reading.needs.length) return handoff([...hints, "understand:no_need"], "unsure");

  // 2. Search: the existing search, through the port; expired temporary cards are never given.
  const found = await ports.knowledge(reading.needs);
  sources = found.sources.filter(source => !source.validUntil || source.validUntil >= ports.today);
  const reasons: string[] = [...hints, ...found.codes.map(code => `knowledge:${code}`)];
  if (found.status !== "ok") reasons.push("knowledge:unavailable");

  // 3. The bounded decide loop.
  const gate = smartProgressGate(memoryBefore, ports.maxExchanges ?? SAV_SMART_DEFAULT_MAX_EXCHANGES);
  if (gate.mustHandOff) reasons.push(`progress:${gate.reason}`);
  const tools = createSmartToolRunner({ knowledge: ports.knowledge, academy: ports.academy ?? [], customerText, needIds: reading.needs.map(need => need.id), today: ports.today, given: sources });
  const catalogue = smartToolCatalogue(ports.academy ?? []);
  const resources = SAV_SMART_RESOURCES.map(row => ({ label: row.label, url: row.url, whenToOffer: row.whenToOffer }));
  const memoryView = smartMemoryForModel(memoryBefore);
  const results: Array<{ pass: number; outcomes: SmartToolOutcome[] }> = [];
  let thread = [...customer.thread], cards = [...sources], compactOld = false;
  const payloadOf = (pass: number) => {
    const allCards = mergeSources(cards, tools.cards());
    const toolResults = results.flatMap(round => compactOld && round.pass < pass - 1
      ? round.outcomes.map(row => ({ id: row.id, tool: row.tool, status: row.status, summary: `t${round.pass}: ${row.status}${row.code ? ` (${row.code})` : ""}` }))
      : round.outcomes.map(row => row.result));
    const last = pass >= SAV_SMART_MAX_DECIDE_PASSES || tools.used() >= SAV_SMART_TOOL_LIMITS.maxCallsPerMail;
    return {
      customer: { ...customer, thread }, needs: reading!.needs, resources, memory: memoryView,
      exchange: gate.exchange, mustHandOff: gate.mustHandOff, noProgressLastTurn: gate.noProgressLastTurn,
      cards: allCards.map(cardView), needsWithoutCard: reading!.needs.filter(need => !allCards.some(card => card.needIds.includes(need.id))).map(need => need.id),
      tools: last ? [] : catalogue, lastStep: last,
      ...(toolResults.length ? { toolResultsNote: SAV_SMART_TOOL_RESULTS_NOTE, toolResults } : {}),
    };
  };
  // Byte cap, cut order: oldest thread messages, then earlier tool results reduced to one line, then the least relevant cards (last given).
  const fits = (pass: number) => smartWireBytes(smartCorrectionPrompt(), { ...payloadOf(pass), previousDecision: null, problems: [] }) + 6_000 <= ports.maxInputBytes;
  const reduce = (pass: number) => {
    while (!fits(pass) && thread.length) { thread = thread.slice(1); reasons.push("cut:thread"); }
    if (!fits(pass) && results.length) { compactOld = true; reasons.push("cut:tool_results"); }
    while (!fits(pass) && cards.length) { cards = cards.slice(0, -1); reasons.push("cut:cards"); }
    return fits(pass);
  };

  let lastPayload: ReturnType<typeof payloadOf> | null = null;
  for (let pass = 1; pass <= SAV_SMART_MAX_DECIDE_PASSES && !decision; pass += 1) {
    if (!reduce(pass)) return handoff([...reasons, "decide:input_too_large"], "budget_epuise");
    lastPayload = payloadOf(pass);
    const decided = await call("decide", smartDecidePrompt(), lastPayload, 0.3);
    if (decided.status === "failed") {
      if (decided.problem === "deadline") return end("interrupted", [...reasons, "decide:deadline"]);
      return pass === 1 ? end("failed", [...reasons, `decide:${decided.problem}`]) : handoff([...reasons, `decide:${decided.problem}`], "panne");
    }
    const step = parseSmartOutput(smartStepSchema, decided.output);
    if (!step.ok) {
      steps.push({ pass, kind: "decide", action: "invalid" });
      return pass === 1 ? end("failed", [...reasons, "decide:output_invalid"]) : handoff([...reasons, "decide:output_invalid"], "panne");
    }
    steps.push({ pass, kind: "decide", action: step.value.action });
    if (step.value.action === "final") { decision = step.value.decision; break; }
    if (lastPayload.lastStep) return handoff([...reasons, "decide:tools_on_last_step"], "budget_epuise");
    const outcomes = await tools.run(step.value.calls);
    for (const row of outcomes) steps.push({ pass, kind: "tool", tool: row.tool, status: row.status, code: row.code, argsHash: row.argsHash, bytes: row.bytes });
    results.push({ pass, outcomes });
  }
  if (!decision || !lastPayload) return handoff([...reasons, "decide:budget"], "budget_epuise");
  academy = tools.academy();
  sources = mergeSources(cards, tools.cards());
  missing = reading.needs.filter(need => !sources.some(card => card.needIds.includes(need.id))).map(need => ({ needId: need.id, theme: need.theme }));

  // 3 bis. Progress rule: the exchange cap, or this turn and the previous one without anything new. The decision becomes a handoff with its note.
  const forceHandoff = (current: SmartDecision, reason: "trop_d_echanges" | "pas_de_progres"): SmartDecision => ({
    ...current, outcome: "handoff", reply: null, handoffReason: current.handoffReason ?? "unsure",
    coverage: reading!.needs.map(need => ({ needId: need.id, status: "handed" as const })),
    teamNote: smartFallbackNote({ reason, reading, memory: memoryBefore, modelNote: current.teamNote }), facts: [],
  });
  if (gate.mustHandOff && decision.outcome !== "handoff") decision = forceHandoff(decision, "trop_d_echanges");
  const tentative = smartMergeMemory({ memory: memoryBefore, decision, reading, latestCustomerText, recordOwn: false });
  if (decision.outcome !== "handoff" && smartNoProgressTwice(memoryBefore, tentative.progressed)) {
    decision = forceHandoff(decision, "pas_de_progres");
    reasons.push("progress:no_progress");
  }

  // 4. Verify: server and the independent counter-read (never on a handoff without customer text).
  const review = async (current: SmartDecision, kind: "verify" | "reverify"): Promise<{ codes: SmartCheckCode[]; verdict: SmartVerdict | null; failed: string | null }> => {
    const server = smartServerChecks({ decision: current, reading: reading!, customerText, sources, academy, memory: memoryBefore });
    if (current.outcome === "handoff" && !current.reply?.trim()) return { codes: [...server.codes], verdict: null, failed: null };
    const read = await call(kind, smartVerifyPrompt(), {
      customer: { subject: customer.subject, mail: customer.mail },
      needs: reading!.needs.map(need => ({ id: need.id, ask: need.ask, alreadyDone: need.alreadyDone })),
      reply: current.reply, facts: current.facts.map(fact => ({ sentence: fact.sentence, type: fact.type, excerpt: fact.excerpt })),
    }, 0);
    if (read.status === "failed") return { codes: [...server.codes], verdict: null, failed: read.problem === "deadline" ? "deadline" : `${kind}:${read.problem}` };
    const verdict = parseSmartOutput(smartVerdictSchema, read.output);
    return { codes: [...server.codes], verdict: verdict.ok ? verdict.value : null, failed: verdict.ok ? null : `${kind}:output_invalid` };
  };
  const refused = (result: Awaited<ReturnType<typeof review>>) => result.codes.length > 0 || result.verdict?.verdict === "non_conforme";
  const accepted = (current: SmartDecision) => {
    const text = current.reply?.trim() ? `${current.reply.trim()}\n\n${savReplyFooter("fr", "automated")}` : null;
    return end(current.outcome, reasons, { replyWithFooter: text, note: current.outcome === "handoff" || current.coverage.some(row => row.status === "handed") ? current.teamNote : null });
  };

  const first = await review(decision, "verify");
  checks.first = first.codes; verdicts.first = first.verdict;
  if (first.failed === "deadline") return end("interrupted", [...reasons, "verify:deadline"]);
  if (first.failed) return handoff([...reasons, first.failed, ...first.codes.map(code => `check:${code}`)], "panne");
  if (!refused(first)) return accepted(decision);

  // 4 bis. One correction, with every problem found (server codes and the counter-read's). No tool any more.
  const problems = [...first.codes.map(code => ({ code, sentence: "" })), ...(first.verdict?.problems ?? [])];
  corrected = true;
  const fixed = await call("correct", smartCorrectionPrompt(), { ...lastPayload, tools: [], lastStep: true, previousDecision: decision, problems }, 0.3);
  if (fixed.status === "failed") return fixed.problem === "deadline" ? end("interrupted", [...reasons, "correct:deadline"]) : handoff([...reasons, `correct:${fixed.problem}`, "refused_once"], "panne");
  const output = fixed.output as { decision?: unknown } | null;
  const parsedFix = parseSmartOutput(smartDecisionSchema, output && typeof output === "object" && "decision" in output ? output.decision : output);
  if (!parsedFix.ok) return handoff([...reasons, "correct:output_invalid", "refused_once"], "panne");
  decision = gate.mustHandOff && parsedFix.value.outcome !== "handoff" ? forceHandoff(parsedFix.value, "trop_d_echanges") : parsedFix.value;
  const second = await review(decision, "reverify");
  checks.second = second.codes; verdicts.second = second.verdict;
  if (second.failed === "deadline") return end("interrupted", [...reasons, "reverify:deadline"]);
  if (second.failed || refused(second)) {
    return handoff([...reasons, "refused_after_correction", ...(second.failed ? [second.failed] : []), ...second.codes.map(code => `check:${code}`),
      ...(second.verdict?.problems ?? []).map(problem => `verify:${problem.code}`)], "unsure");
  }
  return accepted(decision);
}
