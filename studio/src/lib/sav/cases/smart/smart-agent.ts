import { savReplyFooter } from "../../reply-format";
import { smartDropPassages, smartRepairFactSources, smartServerChecks, type SmartCheckResult, type SmartSource } from "./smart-checks";
import {
  parseSmartOutput, SAV_SMART_VERIFY_CODES, smartDecisionSchema, smartReadingSchema, smartStepSchema, smartUnwrapOutput, smartVerdictSchema,
  type SmartCallKind, type SmartCheckCode, type SmartDecision, type SmartReading, type SmartTeamNote, type SmartTurnOutcome, type SmartVerdict,
} from "./smart-contract";
import { renderSmartTeamNote, smartFallbackNote, smartSensitiveNote } from "./smart-handoff-note";
import {
  smartAskedBefore, smartEmptyMemory, smartMemoryForModel, smartMergeMemory, smartNoProgressTwice, smartProgressGate, SAV_SMART_DEFAULT_MAX_EXCHANGES, type SmartCaseMemory,
} from "./smart-memory";
import type { SmartCallResult, SmartModelPort } from "./smart-model";
import { smartWireBytes } from "./smart-model";
import { smartMask, smartSafetyNet } from "./smart-net";
import { SAV_SMART_RESOURCES, smartCorrectionPrompt, smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import { createSmartToolRunner, smartSearchWithRetry, smartToolCatalogue, SAV_SMART_TOOL_LIMITS, SAV_SMART_TOOL_RESULTS_NOTE, type SmartToolOutcome } from "./smart-tools";
import type { AcademyTool } from "./tools/academy";

/*
 * Agent SAV intelligent (20/11, v2 the same day: HARNAIS_BOUCLE): ONE turn of the new agent on one customer mail, with its ports injected
 * (model, knowledge, tools, memory). No database, no clock of its own, no effect: it returns what it would do. The shadow stores it; the bench scores it.
 *
 *   0. filet      `smartSafetyNet` on the INTEGRAL raw texts: TECHNICAL stops only (empty, too long, an instruction aimed at the model), the
 *                 whole mail to the team, 0 call. No stop on a word since N2 (Ugo, 20/11: « smart mais pas restrictif »);
 *   1. comprendre one call: the needs (PS included), what the customer already did, and `sensible {famille, preuve}`: unless
 *                 `sensitive`, `sensitiveFamilies` and `sensible` ALL say « nothing sensitive », the whole mail to the team (doubt = team);
 *                 a customer the reading says very upset or threatening (`upset`) is handed over with a note;
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
 * Bench 22/11, inside the same 7: an unreadable decide answer gets one new attempt (it takes a decide pass); a reverify that still refuses on
 * grounding only gets one narrowing correction and counter-read when the calls already made leave room for both; a mail without need gets a
 * courtesy reply (no search, no tool).
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

/*
 * The problems a narrowing correction may fix (bench 22/11): grounding and coverage only. Anything else (links, secrets, promises, account actions,
 * sensitive topics, other platforms, instructions, repetitions) is a safety or progress refusal and hands over as before.
 */
const GROUNDING_CODES = new Set<string>(["fact_source_invalid", "excerpt_not_found", "card_not_retrieved_for_need", "third_party_fact_unsourced", "need_not_covered",
  "coverage_invalid", "reply_missing", "source_mismatch", "unlisted_claim", "need_forgotten"]);
const smartGroundingOnly = (result: Readonly<{ codes: readonly string[]; verdict: SmartVerdict | null; unknownCodes: boolean }>) =>
  !result.unknownCodes && [...result.codes, ...(result.verdict?.problems ?? []).map(problem => problem.code)].every(code => GROUNDING_CODES.has(code));
/*
 * PR #339 review: the contract reads an unknown counter-read code as `unlisted_claim` (`smart-contract.ts`, kept as is). That reading must not open the
 * narrowing correction: the RAW answer is checked here, and any code outside `SAV_SMART_VERIFY_CODES` keeps the handoff.
 */
const smartUnknownVerifyCodes = (output: unknown) => {
  const raw = smartUnwrapOutput(output) as { problems?: unknown } | null;
  const problems = raw && typeof raw === "object" && Array.isArray(raw.problems) ? raw.problems : [];
  return problems.some(problem => {
    const code = problem && typeof problem === "object" ? (problem as { code?: unknown }).code : undefined;
    return typeof code !== "string" || !(SAV_SMART_VERIFY_CODES as readonly string[]).includes(code.trim().toLowerCase());
  });
};

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
  if (net.stop) return end("team_sensitive", net.reasons, { sensitiveStop: "net", note: null,
    noteText: `Mail transmis tel quel à l'équipe, sans lecture par l'assistant (${net.reasons.join(", ")}).` });
  const hints: readonly string[] = net.hints;

  // 1. Understand.
  const understood = await call("understand", smartUnderstandPrompt(), { customer }, 0);
  if (understood.status === "failed") return understood.problem === "deadline" ? end("interrupted", ["understand:deadline"]) : end("failed", [`understand:${understood.problem}`]);
  const parsedReading = parseSmartOutput(smartReadingSchema, understood.output);
  if (!parsedReading.ok) return end("failed", ["understand:output_invalid"]);
  reading = parsedReading.value;
  // The sensitive barrier, imposed by the server (Astra, 20/11, simplified after the third review): the three fields must ALL say « nothing
  // sensitive » (`sensitive: "no"`, no `sensitiveFamilies`, `sensible.famille: "aucune"`). Any contradiction, an absent or unreadable field:
  // doubt = the team. Since N2 it is the first barrier on the mail's subject: the net no longer reads words.
  const sensible = reading.sensible;
  const families = [...new Set([...(sensible && sensible.famille !== "aucune" ? [sensible.famille] : []), ...reading.sensitiveFamilies])];
  if (!sensible || sensible.famille !== "aucune" || reading.sensitive !== "no" || reading.sensitiveFamilies.length) {
    const codes = [!sensible ? "understand:sensible_missing" : `understand:sensible_${sensible.famille}`, `understand:sensitive_${reading.sensitive}`, ...reading.sensitiveFamilies.map(family => `family:${family}`)];
    return end("team_sensitive", [...hints, ...codes], { sensitiveStop: "understand", note: null, noteText: smartSensitiveNote(families) });
  }
  // Product decision (Ugo, 21/11): a mail carrying an instruction addressed to the assistant (prompt injection, even reworded) NEVER gets an
  // automatic reply: the team, whether the reading quoted the instruction or not, before any decision. The server net (`smartSafetyNet`)
  // stops the obvious forms before the reading; this is the model's judgement for the rest. The counter-read `instruction_followed`
  // (smart-checks.ts) stays as a second net on every reply.
  if (reading.instructionInMail) return handoff([...hints, "understand:instruction_in_mail", ...(reading.instructionText ? [] : ["understand:instruction_text_missing"])], "other");
  if (reading.wantsHuman) return handoff([...hints, "understand:wants_human"], "wants_human");
  // N2 (Ugo, 20/11): a very upset or threatening customer (cancel, bad review, lawyer) goes to the team, judged by the model, never by a word list.
  if (reading.upset) return handoff([...hints, "understand:upset"], "upset");
  // Bench 22/11 (« C'est fait… Merci ! », « je l'ai invité. Bonne journée ! »): a mail with no need (a thank-you, a confirmation) is no longer handed
  // over. The model writes a short courtesy reply (`noNeed: true`, no card, no tool, no fact), checked and counter-read like any reply; the progress
  // rule does not apply (closing a case is not going round in circles). The contract has no « close without reply » outcome: a reply it is.
  const courtesy = !reading.needs.length;

  // 2. Search: the existing search, through the port; expired temporary cards are never given.
  // A transient failure (`knowledge_search_unavailable`) gets ONE more attempt (`smartSearchWithRetry`, 22/11), inside the port's embed cap.
  const found = courtesy ? { status: "ok" as const, sources: [], codes: [] } : await smartSearchWithRetry(ports.knowledge, reading.needs);
  sources = found.sources.filter(source => !source.validUntil || source.validUntil >= ports.today);
  const reasons: string[] = [...hints, ...found.codes.map(code => `knowledge:${code}`)];
  if (found.status !== "ok") reasons.push("knowledge:unavailable");
  if (courtesy) reasons.push("understand:no_need");

  // 3. The bounded decide loop.
  const rawGate = smartProgressGate(memoryBefore, ports.maxExchanges ?? SAV_SMART_DEFAULT_MAX_EXCHANGES);
  const gate = courtesy ? { ...rawGate, mustHandOff: false, noProgressLastTurn: false } : rawGate;
  if (gate.mustHandOff) reasons.push(`progress:${gate.reason}`);
  const tools = createSmartToolRunner({ knowledge: ports.knowledge, academy: ports.academy ?? [], customerText, needIds: reading.needs.map(need => need.id), today: ports.today, given: sources });
  const catalogue = smartToolCatalogue(ports.academy ?? []);
  const resources = SAV_SMART_RESOURCES.map(row => ({ label: row.label, url: row.url, whenToOffer: row.whenToOffer }));
  const memoryView = smartMemoryForModel(memoryBefore);
  // v18: the questions already asked on this case, explicit for decide; the model chooses (no new refusal).
  const askedBefore = smartAskedBefore(memoryBefore);
  const results: Array<{ pass: number; outcomes: SmartToolOutcome[] }> = [];
  let thread = [...customer.thread], cards = [...sources], compactOld = false;
  const payloadOf = (pass: number) => {
    const allCards = mergeSources(cards, tools.cards());
    const toolResults = results.flatMap(round => compactOld && round.pass < pass - 1
      ? round.outcomes.map(row => ({ id: row.id, tool: row.tool, status: row.status, summary: `t${round.pass}: ${row.status}${row.code ? ` (${row.code})` : ""}` }))
      : round.outcomes.map(row => row.result));
    const last = courtesy || pass >= SAV_SMART_MAX_DECIDE_PASSES || tools.used() >= SAV_SMART_TOOL_LIMITS.maxCallsPerMail;
    return {
      customer: { ...customer, thread }, needs: reading!.needs, resources, memory: memoryView, ...(askedBefore.length ? { askedBefore } : {}),
      exchange: gate.exchange, mustHandOff: gate.mustHandOff, noProgressLastTurn: gate.noProgressLastTurn,
      cards: allCards.map(cardView), needsWithoutCard: reading!.needs.filter(need => !allCards.some(card => card.needIds.includes(need.id))).map(need => need.id),
      tools: last ? [] : catalogue, lastStep: last, ...(courtesy ? { noNeed: true } : {}),
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

  let lastPayload: ReturnType<typeof payloadOf> | null = null, jsonRetried = false, firstPass = 1;
  for (let pass = 1; pass <= SAV_SMART_MAX_DECIDE_PASSES && !decision; pass += 1) {
    if (!reduce(pass)) return handoff([...reasons, "decide:input_too_large"], "budget_epuise");
    lastPayload = payloadOf(pass);
    const decided = await call("decide", smartDecidePrompt(), lastPayload, 0.3);
    let answer: unknown = decided.status === "ok" ? decided.output : undefined;
    if (decided.status === "failed") {
      if (decided.problem === "deadline") return end("interrupted", [...reasons, "decide:deadline"]);
      // Bench 22/11 (« ça marche pas »: `decide:output_json_invalid:unbalanced`, then a crash): ONE new attempt of an unreadable answer, taken
      // from the decide passes (never above `SAV_SMART_MAX_MODEL_CALLS`, nor the shadow's or the bench's reservation). Not on the last pass.
      if (decided.problem.startsWith("output_json_invalid") && !jsonRetried && pass < SAV_SMART_MAX_DECIDE_PASSES) {
        jsonRetried = true; if (pass === firstPass) firstPass = pass + 1;
        steps.push({ pass, kind: "decide", action: "invalid" }); reasons.push(`decide:${decided.problem}`, "decide:json_retry");
        continue;
      }
      // v18 (bench 22/11, pareil-02: unreadable three times): after the new attempt, the LENIENT reading of the same answer (`smartLenientJson`:
      // missing closing brackets, trailing comma; never a text cut inside a string). It must still be a valid step, and it goes through every check.
      const lenient = decided.problem.startsWith("output_json_invalid") && decided.lenient !== undefined ? parseSmartOutput(smartStepSchema, decided.lenient) : null;
      // The retry of a first pass is still a first pass: its failure stays technical (`failed`, replayed later), as before.
      if (!lenient?.ok) return pass === firstPass ? end("failed", [...reasons, `decide:${decided.problem}`]) : handoff([...reasons, `decide:${decided.problem}`], "panne");
      reasons.push(`decide:${decided.problem}`, "decide:json_lenient");
      answer = decided.lenient;
    }
    const step = parseSmartOutput(smartStepSchema, answer);
    if (!step.ok) {
      steps.push({ pass, kind: "decide", action: "invalid" });
      return pass === firstPass ? end("failed", [...reasons, "decide:output_invalid"]) : handoff([...reasons, "decide:output_invalid"], "panne");
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
  // SAV-122 (prod bench 21/11, fact_source_invalid): a Limova fact with its excerpt but no source reference gets it when exactly one source
  // retrieved for its need holds the excerpt; every check then runs unchanged. The reply itself is never touched.
  const bind = (current: SmartDecision) => { const done = smartRepairFactSources(current, sources, academy); if (done.repaired) reasons.push("facts:source_repaired"); return done.decision; };
  decision = bind(decision);
  if (gate.mustHandOff && decision.outcome !== "handoff") decision = forceHandoff(decision, "trop_d_echanges");
  const tentative = smartMergeMemory({ memory: memoryBefore, decision, reading, latestCustomerText, recordOwn: false });
  if (!courtesy && decision.outcome !== "handoff" && smartNoProgressTwice(memoryBefore, tentative.progressed)) {
    decision = forceHandoff(decision, "pas_de_progres");
    reasons.push("progress:no_progress");
  }

  // 4. Verify: server and the independent counter-read (never on a handoff without customer text).
  const review = async (current: SmartDecision, kind: "verify" | "reverify"): Promise<{ codes: SmartCheckCode[]; factProblems: SmartCheckResult["factProblems"]; verdict: SmartVerdict | null; failed: string | null; unknownCodes: boolean }> => {
    const server = smartServerChecks({ decision: current, reading: reading!, customerText, sources, academy, memory: memoryBefore });
    if (current.outcome === "handoff" && !current.reply?.trim()) return { codes: [...server.codes], factProblems: server.factProblems, verdict: null, failed: null, unknownCodes: false };
    const read = await call(kind, smartVerifyPrompt(), {
      customer: { subject: customer.subject, mail: customer.mail },
      needs: reading!.needs.map(need => ({ id: need.id, ask: need.ask, alreadyDone: need.alreadyDone })),
      // Each fact with its source and excerpt; its sentence is only a hint (SAV-122): the counter-read judges every claim against the excerpts.
      reply: current.reply, facts: current.facts.map(fact => ({ type: fact.type, source: fact.cardId ?? fact.toolCallId ?? fact.sourceKind, excerpt: fact.excerpt,
        ...(fact.sentence.trim() ? { sentence: fact.sentence } : {}) })),
      ...(reading!.instructionText ? { injectedInstruction: reading!.instructionText } : {}),
    }, 0);
    if (read.status === "failed") return { codes: [...server.codes], factProblems: server.factProblems, verdict: null, failed: read.problem === "deadline" ? "deadline" : `${kind}:${read.problem}`, unknownCodes: false };
    const verdict = parseSmartOutput(smartVerdictSchema, read.output);
    return { codes: [...server.codes], factProblems: server.factProblems, verdict: verdict.ok ? verdict.value : null, failed: verdict.ok ? null : `${kind}:output_invalid`,
      unknownCodes: smartUnknownVerifyCodes(read.output) };
  };
  // A counter-read that lists a problem refuses the reply, whatever its verdict says ("conforme" with problems is a reservation, not an approval).
  const refused = (result: Awaited<ReturnType<typeof review>>) =>
    result.codes.length > 0 || result.verdict?.verdict === "non_conforme" || (result.verdict?.problems.length ?? 0) > 0;
  const accepted = (current: SmartDecision) => {
    const text = current.reply?.trim() ? `${current.reply.trim()}\n\n${savReplyFooter("fr", "automated")}` : null;
    return end(current.outcome, reasons, { replyWithFooter: text, note: current.outcome === "handoff" || current.coverage.some(row => row.status === "handed") ? current.teamNote : null });
  };

  const first = await review(decision, "verify");
  checks.first = first.codes; verdicts.first = first.verdict;
  if (first.failed === "deadline") return end("interrupted", [...reasons, "verify:deadline"]);
  if (first.failed) return handoff([...reasons, first.failed, ...first.codes.map(code => `check:${code}`)], "panne");
  /*
   * v18 (bench 22/11, sujet-05, pareil-06, linkedin-03: « Relire le dernier mail… », `unsure`, after a refusal of a few phrases of a reply built on the
   * right card). Root cause: a turn that used one tool pass had made 6 calls at the reverify, so the narrowing correction (2 calls) no longer fit in
   * the 7, and the reverify's refusal of one phrase ended in the generic handoff. When the counter-read refuses ONLY unlisted_claim / source_mismatch
   * with the passages named, the server drops those sentences (`smartDropPassages`: no rewording, no model call), re-runs every server check, and
   * sends the rest. Any other problem, a passage it cannot find, or an answered need left without its card fact: the flow below, as before.
   */
  const DROPPABLE = new Set<string>(["unlisted_claim", "source_mismatch"]);
  const dropPassages = (result: Awaited<ReturnType<typeof review>>, current: SmartDecision): SmartDecision | null => {
    if (result.failed || result.unknownCodes || gate.mustHandOff || current.outcome !== "reply") return null;
    const problems = result.verdict?.problems ?? [];
    if (!problems.length || !problems.every(problem => DROPPABLE.has(problem.code) && problem.sentence.trim()) || !result.codes.every(code => GROUNDING_CODES.has(code))) return null;
    const trimmed = smartDropPassages(current, problems.map(problem => problem.sentence));
    return trimmed && smartServerChecks({ decision: trimmed, reading: reading!, customerText, sources, academy, memory: memoryBefore }).ok ? trimmed : null;
  };
  const sendDropped = (trimmed: SmartDecision) => { decision = trimmed; reasons.push("correction:passages_dropped"); return accepted(trimmed); };

  if (!refused(first)) return accepted(decision);
  const firstDrop = dropPassages(first, decision);
  if (firstDrop) return sendDropped(firstDrop);

  // 4 bis. One correction, with every problem found (server codes and the counter-read's). No tool any more.
  // SAV-122: a fact-level problem (invalid source, excerpt not found, card not retrieved, third-party fact) is named, one
  // problem per fact sentence, so the correction knows WHICH fact to fix or drop (bench v8: fact_source_invalid came back at the second pass).
  const named = (code: SmartCheckCode) => [...new Set(first.factProblems.filter(row => row.code === code && row.sentence.trim()).map(row => row.sentence))].slice(0, 10);
  const problems = [...first.codes.flatMap(code => named(code).length ? named(code).map(sentence => ({ code, sentence })) : [{ code, sentence: "" }]),
    ...(first.verdict?.problems ?? [])];
  corrected = true;
  const fixed = await call("correct", smartCorrectionPrompt(), { ...lastPayload, tools: [], lastStep: true, previousDecision: decision, problems }, 0.3);
  if (fixed.status === "failed") return fixed.problem === "deadline" ? end("interrupted", [...reasons, "correct:deadline"]) : handoff([...reasons, `correct:${fixed.problem}`, "refused_once"], "panne");
  const output = smartUnwrapOutput(fixed.output) as { decision?: unknown } | null;
  const parsedFix = parseSmartOutput(smartDecisionSchema, output && typeof output === "object" && "decision" in output ? output.decision : output);
  if (!parsedFix.ok) return handoff([...reasons, "correct:output_invalid", "refused_once"], "panne");
  decision = gate.mustHandOff && parsedFix.value.outcome !== "handoff" ? forceHandoff(parsedFix.value, "trop_d_echanges") : bind(parsedFix.value);
  let second = await review(decision, "reverify");
  checks.second = second.codes; verdicts.second = second.verdict;
  if (second.failed === "deadline") return end("interrupted", [...reasons, "reverify:deadline"]);
  // Bench 22/11 (`refused_after_correction` with the right card: fact_source_invalid, need_forgotten, unlisted_claim): when the reverify still refuses
  // ONLY on grounding or coverage, a card was found for a need, and the call budget leaves room for one more correction and its counter-read, the
  // model gets ONE narrowing correction: answer only what the cards carry word for word, or ask the customer one precise question. Any safety
  // problem (link, secret, promise, account action, sensitive topic, other platform, instruction) still hands over at once, as before.
  const modelCalls = () => calls.length;
  // v18: the reverify named only unsupported passages: drop them and send the rest (0 call), before spending the narrowing correction.
  if (refused(second)) { const secondDrop = dropPassages(second, decision); if (secondDrop) return sendDropped(secondDrop); }
  if (!second.failed && refused(second) && smartGroundingOnly(second) && sources.some(card => card.needIds.length > 0)
    && modelCalls() + 2 <= SAV_SMART_MAX_MODEL_CALLS && !gate.mustHandOff) {
    const namedSecond = (code: SmartCheckCode) => [...new Set(second.factProblems.filter(row => row.code === code && row.sentence.trim()).map(row => row.sentence))].slice(0, 10);
    const narrowProblems = [...second.codes.flatMap(code => namedSecond(code).length ? namedSecond(code).map(sentence => ({ code, sentence })) : [{ code, sentence: "" }]),
      ...(second.verdict?.problems ?? [])];
    reasons.push("correction:narrowed");
    const narrowed = await call("correct", smartCorrectionPrompt(), { ...lastPayload, tools: [], lastStep: true, previousDecision: decision, problems: narrowProblems, narrow: true }, 0.3);
    if (narrowed.status === "failed") return narrowed.problem === "deadline" ? end("interrupted", [...reasons, "correct:deadline"]) : handoff([...reasons, `correct:${narrowed.problem}`, "refused_after_correction"], "panne");
    const narrowOutput = smartUnwrapOutput(narrowed.output) as { decision?: unknown } | null;
    const parsedNarrow = parseSmartOutput(smartDecisionSchema, narrowOutput && typeof narrowOutput === "object" && "decision" in narrowOutput ? narrowOutput.decision : narrowOutput);
    if (!parsedNarrow.ok) return handoff([...reasons, "correct:output_invalid", "refused_after_correction"], "panne");
    decision = bind(parsedNarrow.value);
    second = await review(decision, "reverify");
    checks.second = second.codes; verdicts.second = second.verdict;
    if (second.failed === "deadline") return end("interrupted", [...reasons, "reverify:deadline"]);
    if (refused(second)) { const narrowDrop = dropPassages(second, decision); if (narrowDrop) return sendDropped(narrowDrop); }
  }
  if (second.failed || refused(second)) {
    return handoff([...reasons, "refused_after_correction", ...(second.failed ? [second.failed] : []), ...second.codes.map(code => `check:${code}`),
      ...(second.verdict?.problems ?? []).map(problem => `verify:${problem.code}`)], "unsure");
  }
  return accepted(decision);
}
