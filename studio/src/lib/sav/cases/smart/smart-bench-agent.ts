import type { SavBenchAgent, SavBenchAgentInput, SavBenchAgentTurn, SavBenchCard } from "../../bench/bench-types";
import { runSmartTurn, type SmartKnowledgePort, type SmartTurnResult } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import { smartEmptyMemory, smartMaxExchanges, type SmartCaseMemory } from "./smart-memory";
import type { AcademyTool } from "./tools/academy";
import { SAV_SMART_PROMPT_REVISION, smartPromptSha256 } from "./smart-prompt";
import { smartGeminiModel, smartInputCap, smartWireBody, type SmartModelPort } from "./smart-model";

/*
 * Agent SAV intelligent (20/11, v2 the same day): the NEW agent under the bench (`--agent=new --agent-module=<this file>`, and the prod self-test).
 * One turn of the bench = one `runSmartTurn` (net, understand, the bounded decide loop with its tools, verify, one correction), the bench cards
 * standing in for the knowledge search (given for every need, and searched by `chercher_fiches`; an expired temporary card is removed by the turn).
 * The case memory is kept per conversation across its turns (the bench's replies are « delivered » to the fictional customer, so the agent's
 * questions and trials are recorded): this is where the memory and the progress rule are proven. The model goes through the bench's network (its wire: cache,
 * cap, dry-run). Dry-run: a deterministic script answers (the turn hands over for lack of a source) and each body is still sent to the wire,
 * which measures it for the estimate and answers nothing paid. No effect: no database, no writer.
 */

type Env = Readonly<Record<string, string | undefined>>;
type Network = (url: string, init: RequestInit) => Promise<Response>;

/** A bench card as a source of the turn (its links kept in the text, so the server's link check admits them). */
export function smartBenchSource(card: SavBenchCard, needIds: readonly string[]): SmartSource {
  return { cardId: card.id, version: "v1", title: card.title, content: [card.content, ...(card.links ?? [])].join("\n"), steps: [...card.steps], needIds: [...needIds],
    validUntil: card.validUntil ?? null };
}

/*
 * SAV-122 diagnostic (bench 21/11, v6: 9 handoffs at 4-5 calls): WHY the brain handed over, as closed codes only (never a customer's text, a
 * reply or a judge's words): the turn's reasons, the server codes and the counter-read's problem codes of each review (`first:check:<code>`,
 * `first:verify:<code>`, then `second:`), whether a correction ran, the decision's handoff reason and the call sequence.
 */
const CLOSED_CODE = /^[a-z0-9_:.>-]{1,80}$/;
export function smartBenchTurnCodes(result: SmartTurnResult): string[] {
  const review = (pass: "first" | "second") => [
    ...(result.checks[pass] ?? []).map(code => `${pass}:check:${code}`),
    ...(result.verdicts[pass] ? [`${pass}:verdict:${result.verdicts[pass]!.verdict}`, ...result.verdicts[pass]!.problems.map(problem => `${pass}:verify:${problem.code}`)] : []),
  ];
  const codes = [
    ...result.reasons, ...review("first"), ...review("second"), ...(result.corrected ? ["corrected"] : []),
    ...(result.decision?.handoffReason ? [`handoff_reason:${result.decision.handoffReason}`] : []), ...(result.teamNote ? [`note:${result.teamNote.raison}`] : []),
    `calls:${result.calls.map(call => call.kind).join(">")}`,
  ];
  return [...new Set(codes)].filter(code => CLOSED_CODE.test(code));
}

/** The bench outcome of a turn. Sensitive → `equipe_sensible`, never a reply; a failure is never an answer. */
export function smartBenchTurn(result: SmartTurnResult): SavBenchAgentTurn {
  const codes = smartBenchTurnCodes(result), citations = [...new Set((result.decision?.facts ?? []).flatMap(fact => fact.cardId ? [fact.cardId] : []))];
  switch (result.outcome) {
    case "team_sensitive": return { outcome: "equipe_sensible", reply: null, citations: [], codes };
    case "handoff": return { outcome: "passer_la_main", reply: null, citations, codes };
    case "reply": return { outcome: "repondre", reply: result.replyWithFooter, citations, codes };
    case "ask": return { outcome: "demander", reply: result.replyWithFooter, citations, codes };
    default: return { outcome: "passer_la_main", reply: null, citations: [], codes, failure: `${result.outcome}:${result.reasons.find(reason => !reason.startsWith("hint:")) ?? result.reasons[0] ?? "unknown"}` };
  }
}

/** Dry-run model: deterministic, free; the body is still measured by the wire. */
function dryRunModel(network: Network, env: Env): SmartModelPort {
  return async ({ kind, system, payload, temperature }) => {
    const body = smartWireBody(system, payload, 8_192, temperature), inputBytes = Buffer.byteLength(body, "utf8");
    await network(`https://dry-run.invalid/${env.SAV_V2_MODEL ?? "model"}:generateContent`, { method: "POST", body }).catch(() => null);
    const needs = [{ id: "n1", ask: "demande du client", alreadyDone: [], theme: null, search: "aide" }];
    const decision = { outcome: "handoff", reply: null, teamNote: { raison: "no_source", besoin: "Banc à blanc : pas de modèle." }, handoffReason: "no_source",
      coverage: [{ needId: "n1", status: "handed" }], facts: [] };
    const output = kind === "understand" ? { needs, sensitive: "no", sensitiveFamilies: [], wantsHuman: false, sensible: { famille: "aucune", preuve: "" } }
      : kind === "verify" || kind === "reverify" ? { verdict: "conforme", problems: [] }
      : { thinking: "", action: "final", calls: [], decision };
    return { status: "ok", output, usage: { inputTokens: 0, outputTokens: 0 }, inputBytes };
  };
}

export function smartBenchInput(input: SavBenchAgentInput) {
  const latest = input.messages.at(-1)!;
  return { subject: input.subject, body: latest.text,
    thread: input.messages.slice(0, -1).map(message => ({ from: message.from === "client" ? "customer" as const : "support" as const, at: message.at, text: message.text })) };
}

export function createSavBenchAgent(context: Readonly<{ dryRun: boolean; network: Network; env: Env; academy?: readonly AcademyTool[] }>): SavBenchAgent {
  // The case memory of each conversation, across its turns (reset on its first turn).
  const memories = new Map<string, SmartCaseMemory>();
  return {
    name: "new", revision: `${SAV_SMART_PROMPT_REVISION}:${smartPromptSha256().slice(0, 12)}:${context.env.SAV_V2_MODEL ?? "?"}`,
    async respond(input) {
      const now = new Date(input.now);
      const model = context.dryRun ? dryRunModel(context.network, context.env)
        : smartGeminiModel({ env: () => context.env, now: () => now, network: context.network, timeoutMs: 60_000 });
      const knowledge: SmartKnowledgePort = async needs => ({ status: "ok", sources: input.knowledge.map(card => smartBenchSource(card, needs.map(need => need.id))), codes: [] });
      const memory = input.turn <= 1 ? smartEmptyMemory() : memories.get(input.conversationId) ?? smartEmptyMemory(input.messages.filter(row => row.from === "client").length - 1);
      const result = await runSmartTurn({ ...smartBenchInput(input), memory }, { model, knowledge, maxInputBytes: smartInputCap(context.env, now) ?? 100_000, today: input.now.slice(0, 10),
        academy: context.academy ?? [], recordOwn: true, maxExchanges: smartMaxExchanges(context.env) });
      memories.set(input.conversationId, result.memory);
      return smartBenchTurn(result);
    },
  };
}
