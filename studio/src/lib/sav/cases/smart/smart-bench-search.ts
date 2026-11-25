import type { SavBenchAgent, SavBenchConversation } from "../../bench/bench-types";
import type { SavBenchJudge } from "../../bench/bench-judge";
import { runSmartTurn, type SmartKnowledgePort, type SmartKnowledgeResult } from "./smart-agent";
import { smartBenchInput, smartBenchTurn } from "./smart-bench-agent";
import { smartEmptyMemory, smartMaxExchanges, type SmartCaseMemory } from "./smart-memory";
import { smartCommercialSet } from "./smart-switch";
import { smartGeminiModel, smartInputCap, type SmartEmbedPort } from "./smart-model";
import { SAV_SMART_PROMPT_REVISION, smartPromptSha256 } from "./smart-prompt";
import type { AcademyTool } from "./tools/academy";

/*
 * Retrieval measurement (Ugo 21/11: « est-ce que l'agent cherche bien les fiches ? »). The bench's « search only » agent (`_AGENT=search`):
 * the SAME turn as the new agent (`runSmartTurn`: understand, decide with `chercher_fiches`, verify), but the knowledge is the REAL search of the
 * Studio (`smartDbKnowledge`: the SAV index, the query embedding paid inside the bench's own ledger), never the bench's fictional cards.
 * Every search of the turn (the first one, then each `chercher_fiches`) is RECORDED: the needs and their search words, and the cards found per
 * need with their rank. No judge (the bench's expected facts are about fictional cards): the analysis compares, offline, the expected
 * fictional card of each conversation with the real cards found and the real catalogue. Nothing is sent, no case, no CRM, no Gmail.
 * The bench mails are fictional, so the need texts may be logged; real cards are logged by short id and title only, never their content.
 */

export const SAV_SMART_BENCH_SEARCH_TOP = 6;
const cut = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

export type SmartBenchSearchCall = Readonly<{
  kind: "initial" | "tool"; status: SmartKnowledgeResult["status"]; codes: readonly string[];
  needs: readonly Readonly<{ id: string; ask: string; search: string }>[];
  /** Per need: the cards found for it, in rank order (1 = first), short id and title. */
  found: readonly Readonly<{ needId: string; cards: readonly Readonly<{ rank: number; id: string; title: string }>[] }>[];
}>;
export type SmartBenchSearchTurn = Readonly<{ turn: number; outcome: string; codes: readonly string[]; searches: readonly SmartBenchSearchCall[] }>;
export type SmartBenchSearchRecord = Readonly<{ conversationId: string; family: string; expected: readonly string[]; turns: SmartBenchSearchTurn[] }>;

/** Wraps a knowledge port so each call is recorded (the first call of a turn is the initial search, the next ones are `chercher_fiches`). */
export function recordSmartKnowledge(port: SmartKnowledgePort, sink: SmartBenchSearchCall[]): SmartKnowledgePort {
  return async needs => {
    const result = await port(needs);
    sink.push({
      kind: sink.length === 0 ? "initial" : "tool", status: result.status, codes: [...result.codes].slice(0, 12),
      needs: needs.map(need => ({ id: need.id, ask: cut(need.ask, 240), search: cut(need.search ?? "", 240) })),
      found: needs.map(need => ({ needId: need.id, cards: result.sources.filter(source => source.needIds.includes(need.id)).slice(0, SAV_SMART_BENCH_SEARCH_TOP)
        .map((source, index) => ({ rank: index + 1, id: source.cardId.slice(0, 8), title: cut(source.title, 120) })) })),
    });
    return result;
  };
}

/** A free judge: the search-only mode judges nothing (the expected facts are about fictional cards). Never calls the model. */
export const smartBenchNoJudge: SavBenchJudge = { name: "none", revision: "search-only", judge: async () => ({ status: "failed", problem: "judge_off" }) };

/**
 * The search-only agent of one conversation. `knowledge(embed)` is the real search (production: `smartDbKnowledge`); `embed` and the model go
 * through the bench's meter (`network`). The record of every turn lands in `record`.
 */
export function createSavBenchSearchAgent(context: Readonly<{
  network: (url: string, init: RequestInit) => Promise<Response>; env: Readonly<Record<string, string | undefined>>;
  embed: SmartEmbedPort; knowledge: (embed: SmartEmbedPort, now: Date) => SmartKnowledgePort; academy?: readonly AcademyTool[];
  conversation: SavBenchConversation; record: SmartBenchSearchRecord;
  /** `search` (default) or `real` (the same turn, judged by the real judge, `smart-bench-real-judge.ts`). */
  name?: "search" | "real";
}>): SavBenchAgent {
  const name = context.name ?? "search";
  let memory: SmartCaseMemory = smartEmptyMemory();
  return {
    name, revision: `${name}:${SAV_SMART_PROMPT_REVISION}:${smartPromptSha256(smartCommercialSet(context.env)).slice(0, 12)}:${context.env.SAV_V2_MODEL ?? "?"}`,
    async respond(input) {
      const now = new Date(input.now), searches: SmartBenchSearchCall[] = [];
      const model = smartGeminiModel({ env: () => context.env, now: () => now, network: context.network, timeoutMs: 60_000 });
      if (input.turn <= 1) memory = smartEmptyMemory();
      const result = await runSmartTurn({ ...smartBenchInput(input), memory }, {
        model, knowledge: recordSmartKnowledge(context.knowledge(context.embed, now), searches), maxInputBytes: smartInputCap(context.env, now) ?? 100_000,
        today: input.now.slice(0, 10), academy: context.academy ?? [], recordOwn: true, maxExchanges: smartMaxExchanges(context.env), ...smartCommercialSet(context.env),
      });
      memory = result.memory;
      const turn = smartBenchTurn(result);
      context.record.turns.push({ turn: input.turn, outcome: turn.outcome, codes: turn.codes.slice(0, 20), searches });
      return turn;
    },
  };
}

export const emptySmartBenchSearchRecord = (conversation: SavBenchConversation): SmartBenchSearchRecord =>
  ({ conversationId: conversation.id, family: conversation.family, expected: [...conversation.knowledge], turns: [] });
