import type { SavBenchAgent, SavBenchAgentInput, SavBenchAgentTurn, SavBenchCard } from "../../bench/bench-types";
import { runSmartTurn, type SmartKnowledgePort, type SmartTurnResult } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import { SAV_SMART_PROMPT_REVISION, smartPromptSha256 } from "./smart-prompt";
import { smartGeminiModel, smartInputCap, smartWireBody, type SmartModelPort } from "./smart-model";

/*
 * Agent SAV intelligent (20/11): the NEW agent under the bench (`--agent=new --agent-module=<this file>`, and the prod self-test). One turn of
 * the bench = one `runSmartTurn` (net, understand, decide, verify, one correction), the bench cards standing in for the knowledge search
 * (given for every need; an expired temporary card is removed by the turn itself). The model goes through the bench's network (its wire: cache,
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

/** The bench outcome of a turn. Sensitive → `equipe_sensible`, never a reply; a failure is never an answer. */
export function smartBenchTurn(result: SmartTurnResult): SavBenchAgentTurn {
  const codes = [...result.reasons], citations = [...new Set((result.decision?.facts ?? []).flatMap(fact => fact.cardId ? [fact.cardId] : []))];
  switch (result.outcome) {
    case "team_sensitive": return { outcome: "equipe_sensible", reply: null, citations: [], codes };
    case "handoff": return { outcome: "passer_la_main", reply: null, citations, codes };
    case "reply": return { outcome: "repondre", reply: result.replyWithFooter, citations, codes };
    case "ask": return { outcome: "demander", reply: result.replyWithFooter, citations, codes };
    default: return { outcome: "passer_la_main", reply: null, citations: [], codes, failure: `${result.outcome}:${result.reasons[0] ?? "unknown"}` };
  }
}

/** Dry-run model: deterministic, free; the body is still measured by the wire. */
function dryRunModel(network: Network, env: Env): SmartModelPort {
  return async ({ kind, system, payload, temperature }) => {
    const body = smartWireBody(system, payload, 8_192, temperature), inputBytes = Buffer.byteLength(body, "utf8");
    await network(`https://dry-run.invalid/${env.SAV_V2_MODEL ?? "model"}:generateContent`, { method: "POST", body }).catch(() => null);
    const needs = [{ id: "n1", ask: "demande du client", alreadyDone: [], theme: null, search: "aide" }];
    const output = kind === "understand" ? { needs, sensitive: "no", sensitiveFamilies: [], wantsHuman: false }
      : kind === "verify" || kind === "reverify" ? { verdict: "conforme", problems: [] }
      : { outcome: "handoff", reply: null, teamNote: "Banc à blanc : pas de modèle.", handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [] };
    return { status: "ok", output, usage: { inputTokens: 0, outputTokens: 0 }, inputBytes };
  };
}

export function smartBenchInput(input: SavBenchAgentInput) {
  const latest = input.messages.at(-1)!;
  return { subject: input.subject, body: latest.text,
    thread: input.messages.slice(0, -1).map(message => ({ from: message.from === "client" ? "customer" as const : "support" as const, at: message.at, text: message.text })) };
}

export function createSavBenchAgent(context: Readonly<{ dryRun: boolean; network: Network; env: Env }>): SavBenchAgent {
  return {
    name: "new", revision: `${SAV_SMART_PROMPT_REVISION}:${smartPromptSha256().slice(0, 12)}:${context.env.SAV_V2_MODEL ?? "?"}`,
    async respond(input) {
      const now = new Date(input.now);
      const model = context.dryRun ? dryRunModel(context.network, context.env)
        : smartGeminiModel({ env: () => context.env, now: () => now, network: context.network, timeoutMs: 60_000 });
      const knowledge: SmartKnowledgePort = async needs => ({ status: "ok", sources: input.knowledge.map(card => smartBenchSource(card, needs.map(need => need.id))), codes: [] });
      const result = await runSmartTurn(smartBenchInput(input), { model, knowledge, maxInputBytes: smartInputCap(context.env, now) ?? 100_000, today: input.now.slice(0, 10) });
      return smartBenchTurn(result);
    },
  };
}
