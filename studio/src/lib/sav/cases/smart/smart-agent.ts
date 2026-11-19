import { savReplyFooter } from "../../reply-format";
import { smartServerChecks, type SmartSource } from "./smart-checks";
import {
  parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartVerdictSchema,
  type SmartCallKind, type SmartCheckCode, type SmartDecision, type SmartReading, type SmartTurnOutcome, type SmartVerdict,
} from "./smart-contract";
import type { SmartCallResult, SmartModelPort } from "./smart-model";
import { smartWireBytes } from "./smart-model";
import { smartMask, smartSafetyNet } from "./smart-net";
import { SAV_SMART_RESOURCES, smartCorrectionPrompt, smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";

/*
 * Agent SAV intelligent, lots D1-D3 (20/11): ONE turn of the new agent on one customer mail, with its ports injected (model, knowledge).
 * No database, no clock of its own, no effect: it returns what it would do. The shadow stores it; the bench scores it.
 *
 *   0. filet      `smartSafetyNet` on the INTEGRAL raw texts: anything sensitive or odd, the whole mail to the team, 0 call;
 *   1. comprendre one call: the needs (PS included), what the customer already did; sensitive or doubt, the whole mail to the team;
 *   2. chercher   the existing search (`smart-knowledge.ts`), unchanged, at most 3 needs (the existing bound);
 *   3. décider    one call: reply, ask THE question, or hand over, with its facts and their source;
 *   4. vérifier   the server's checks (no model), then ONE independent counter-read; any refusal gets ONE correction (3 bis), checked and
 *                 counter-read again; still refused: hand over. A counter-read that says « conforme » never overrides a server refusal.
 * Calls: 2 at least (understand + decide), 5 at most (+ verify, correct, reverify), plus 1 embedding. A failed or out-of-time call stops the turn.
 */

export type SmartThreadMessage = Readonly<{ from: "customer" | "support"; at: string; text: string }>;
export type SmartTurnInput = Readonly<{ subject: string; body: string; thread: readonly SmartThreadMessage[] }>;
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
}>;
export type SmartCallRecord = Readonly<{ kind: SmartCallKind; status: "ok" | "failed"; problem: string | null; inputBytes: number; uncertain: boolean; sent: boolean;
  usage: Readonly<{ inputTokens: number; outputTokens: number }> | null }>;
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
}>;

const THREAD_MAX = 3, THREAD_CHARS = 800;

/** One turn. Never throws for a model failure: the result says where and why it stopped. */
export async function runSmartTurn(input: SmartTurnInput, ports: SmartTurnPorts): Promise<SmartTurnResult> {
  const calls: SmartCallRecord[] = [];
  let reading: SmartReading | null = null, decision: SmartDecision | null = null, corrected = false;
  let sources: SmartSource[] = [], missing: Array<{ needId: string; theme: string | null }> = [];
  const checks: { first: SmartCheckCode[] | null; second: SmartCheckCode[] | null } = { first: null, second: null };
  const verdicts: { first: SmartVerdict | null; second: SmartVerdict | null } = { first: null, second: null };
  const end = (outcome: SmartTurnOutcome, reasons: readonly string[], extra: Partial<Pick<SmartTurnResult, "sensitiveStop" | "replyWithFooter">> = {}): SmartTurnResult => ({
    outcome, reasons: [...new Set(reasons)], sensitiveStop: extra.sensitiveStop ?? null, reading, decision, replyWithFooter: extra.replyWithFooter ?? null, checks, verdicts, corrected, calls,
    sources: sources.map(row => ({ cardId: row.cardId, version: row.version, needIds: row.needIds })), missing,
  });
  const call = async (kind: Exclude<SmartCallKind, "embed">, system: string, payload: unknown, temperature: number): Promise<SmartCallResult> => {
    const result = await ports.model({ kind, system, payload, temperature });
    calls.push({ kind, status: result.status, problem: result.status === "failed" ? result.problem : null, inputBytes: result.inputBytes,
      uncertain: result.status === "failed" && result.uncertain, sent: result.status === "ok" || result.sent, usage: result.usage });
    return result;
  };
  const stopOf = (kind: string, result: Extract<SmartCallResult, { status: "failed" }>) =>
    result.problem === "deadline" ? end("interrupted", [`${kind}:deadline`]) : end("failed", [`${kind}:${result.problem}`]);

  // 0. The net, on the integral raw texts.
  const net = smartSafetyNet({ subject: input.subject, body: input.body });
  if (net.stop) return end("team_sensitive", net.reasons, { sensitiveStop: "net" });

  const customer = {
    subject: smartMask(input.subject), mail: smartMask(input.body),
    thread: input.thread.slice(-THREAD_MAX).map(row => ({ from: row.from, at: row.at, text: smartMask(row.text).slice(0, THREAD_CHARS) })),
  };
  const customerText = [customer.subject, customer.mail, ...customer.thread.map(row => row.text)].join("\n");

  // 1. Understand.
  const understood = await call("understand", smartUnderstandPrompt(), { customer }, 0);
  if (understood.status === "failed") return stopOf("understand", understood);
  const parsedReading = parseSmartOutput(smartReadingSchema, understood.output);
  if (!parsedReading.ok) return end("failed", ["understand:output_invalid"]);
  reading = parsedReading.value;
  if (reading.sensitive !== "no") return end("team_sensitive", [`understand:sensitive_${reading.sensitive}`, ...reading.sensitiveFamilies.map(family => `family:${family}`)], { sensitiveStop: "understand" });
  if (reading.instructionInMail) return end("handoff", ["understand:instruction_in_mail"]);
  if (reading.wantsHuman) return end("handoff", ["understand:wants_human"]);
  if (!reading.needs.length) return end("handoff", ["understand:no_need"]);

  // 2. Search: the existing search, through the port; expired temporary cards are never given.
  const found = await ports.knowledge(reading.needs);
  sources = found.sources.filter(source => !source.validUntil || source.validUntil >= ports.today);
  const reasons: string[] = [...found.codes.map(code => `knowledge:${code}`)];
  if (found.status !== "ok") reasons.push("knowledge:unavailable");

  // 3. Decide, the payload reduced to the byte cap: oldest thread messages first, then the least relevant cards (last given).
  const resources = SAV_SMART_RESOURCES.map(row => ({ label: row.label, url: row.url }));
  const payloadOf = (thread: typeof customer.thread, cards: SmartSource[]) => ({
    customer: { ...customer, thread }, needs: reading!.needs, resources,
    cards: cards.map(card => ({ cardId: card.cardId, version: card.version, title: card.title, content: card.content, steps: card.steps, needIds: card.needIds, ...(card.validUntil ? { validUntil: card.validUntil } : {}) })),
    needsWithoutCard: reading!.needs.filter(need => !cards.some(card => card.needIds.includes(need.id))).map(need => need.id),
  });
  let thread = [...customer.thread], cards = [...sources];
  const fits = () => smartWireBytes(smartCorrectionPrompt(), { ...payloadOf(thread, cards), previousDecision: null, problems: [] }) + 6_000 <= ports.maxInputBytes;
  while (!fits() && thread.length) { thread = thread.slice(1); if (!reasons.includes("cut:thread")) reasons.push("cut:thread"); }
  while (!fits() && cards.length) { cards = cards.slice(0, -1); if (!reasons.includes("cut:cards")) reasons.push("cut:cards"); }
  if (!fits()) return end("handoff", [...reasons, "decide:input_too_large"]);
  sources = cards;
  missing = reading.needs.filter(need => !cards.some(card => card.needIds.includes(need.id))).map(need => ({ needId: need.id, theme: need.theme }));
  const payload = payloadOf(thread, cards);

  const decided = await call("decide", smartDecidePrompt(), payload, 0.3);
  if (decided.status === "failed") return stopOf("decide", decided);
  const parsedDecision = parseSmartOutput(smartDecisionSchema, decided.output);
  if (!parsedDecision.ok) return end("failed", [...reasons, "decide:output_invalid"]);
  decision = parsedDecision.value;

  // 4. Verify: server first, then the independent counter-read (never on a handoff without customer text).
  const review = async (current: SmartDecision, kind: "verify" | "reverify"): Promise<{ codes: SmartCheckCode[]; verdict: SmartVerdict | null; failed: string | null }> => {
    const server = smartServerChecks({ decision: current, reading: reading!, customerText, sources });
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
    return end(current.outcome, reasons, { replyWithFooter: text });
  };

  const first = await review(decision, "verify");
  checks.first = first.codes; verdicts.first = first.verdict;
  if (first.failed === "deadline") return end("interrupted", [...reasons, "verify:deadline"]);
  if (first.failed) return end("handoff", [...reasons, first.failed, ...first.codes.map(code => `check:${code}`)]);
  if (!refused(first)) return accepted(decision);

  // 3 bis. One correction, with every problem found (server codes and the counter-read's).
  const problems = [...first.codes.map(code => ({ code, sentence: "" })), ...(first.verdict?.problems ?? [])];
  corrected = true;
  const fixed = await call("correct", smartCorrectionPrompt(), { ...payload, previousDecision: decision, problems }, 0.3);
  if (fixed.status === "failed") return fixed.problem === "deadline" ? end("interrupted", [...reasons, "correct:deadline"]) : end("handoff", [...reasons, `correct:${fixed.problem}`, "refused_once"]);
  const parsedFix = parseSmartOutput(smartDecisionSchema, fixed.output);
  if (!parsedFix.ok) return end("handoff", [...reasons, "correct:output_invalid", "refused_once"]);
  decision = parsedFix.value;
  const second = await review(decision, "reverify");
  checks.second = second.codes; verdicts.second = second.verdict;
  if (second.failed === "deadline") return end("interrupted", [...reasons, "reverify:deadline"]);
  if (second.failed || refused(second)) {
    return end("handoff", [...reasons, "refused_after_correction", ...(second.failed ? [second.failed] : []), ...second.codes.map(code => `check:${code}`),
      ...(second.verdict?.problems ?? []).map(problem => `verify:${problem.code}`)]);
  }
  return accepted(decision);
}
