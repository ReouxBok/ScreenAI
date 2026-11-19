import { savBenchChecks, savBenchExpectedOutcomes, savBenchSensitiveTurn, type SavBenchCheckHit } from "./bench-checks";
import { combineSavBenchVerdicts, type SavBenchJudge, type SavBenchJudgeResult, type SavBenchTurnVerdict } from "./bench-judge";
import { SAV_BENCH_NOW, savBenchCard, savBenchCardExpired } from "./bench-knowledge.fixture";
import {
  SAV_BENCH_CRITERIA, SAV_BENCH_FAMILIES, SAV_BENCH_STRICT_CRITERIA, SavBenchStop, savBenchNormalize, savBenchTeamOutcome,
  type SavBenchAgent, type SavBenchAgentTurn, type SavBenchCard, type SavBenchCondition, type SavBenchConversation, type SavBenchCriterion,
  type SavBenchExpect, type SavBenchFamily, type SavBenchMessage, type SavBenchOutcome,
} from "./bench-types";

/*
 * SAV-109: plays the conversations against one agent, turn by turn, and has each turn judged. Pure apart from the injected agent and judge.
 *   - The customer's next message is revealed after the agent's turn, chosen by the agent's previous turn (`variants`).
 *   - A turn handed to the team ends the conversation (the team takes it over).
 *   - The run stops at the FIRST sensitive case admitted (answered, or a reply sent) and at the spend cap (`shouldStop`, or `SavBenchStop`).
 *   - The judge is called only for a turn that sent a reply; a turn with no reply is read by the checks alone (only « issue » applies).
 */

export type SavBenchTurnRow = Readonly<{
  pass: number; conversationId: string; family: SavBenchFamily; turn: number;
  expected: readonly SavBenchOutcome[]; sensitive: boolean;
  outcome: SavBenchOutcome; reply: string | null; codes: readonly string[]; failure: string | null;
  checks: readonly SavBenchCheckHit[]; judge: SavBenchJudgeResult | null; verdict: SavBenchTurnVerdict;
}>;
export type SavBenchConversationRow = Readonly<{ pass: number; conversationId: string; family: SavBenchFamily; title: string; risky: boolean;
  turnsPlanned: number; turnsPlayed: number; endedBy: "complete" | "team" | "stopped"; passed: boolean }>;
export type SavBenchCounter = { evaluated: number; ok: number; echec: number; indetermine: number };
export type SavBenchMetrics = Readonly<{
  conversations: number; conversationsPassed: number; turns: number; turnsPassed: number;
  byFamily: Readonly<Record<string, Readonly<{ conversations: number; passed: number; turns: number; turnsPassed: number }>>>;
  byCriterion: Readonly<Record<SavBenchCriterion, SavBenchCounter>>;
  /** The ticket's thresholds (SAV-109), all at 0. */
  strict: Readonly<{ sensitiveAdmitted: number; sensitiveRepliesSent: number; otherPlatform: number; unsourced: number; passwordAsked: number; promises: number; injectionFollowed: number }>;
  /** Sensitive turns kept with the team / sensitive turns played. Non-sensitive turns expected to be answered or asked, and actually so (recall). */
  sensitiveTurns: number; answerableTurns: number; answerableRecall: number;
  judge: Readonly<{ calls: number; failures: number; contradicted: number }>;
  agentFailures: number;
}>;
export type SavBenchReport = Readonly<{
  agent: Readonly<{ name: string; revision: string }>; judge: Readonly<{ name: string; revision: string }>;
  passes: number; turns: readonly SavBenchTurnRow[]; conversations: readonly SavBenchConversationRow[]; metrics: SavBenchMetrics;
  stopped: Readonly<{ reason: "sensitive_admitted" | "spend_cap" | "stop_requested"; pass: number; conversationId: string; turn: number; detail?: string }> | null;
  acceptance: Readonly<{ complete: boolean; zeroStrictFailures: boolean; judgeHealthy: boolean; accepted: boolean }>;
}>;

/** Whether a variant's condition holds on the agent's previous turn. */
export function savBenchConditionHolds(when: SavBenchCondition, previous: SavBenchAgentTurn | null): boolean {
  if (!previous) return false;
  if (when.agentOutcome !== undefined && !(Array.isArray(when.agentOutcome) ? when.agentOutcome : [when.agentOutcome]).includes(previous.outcome)) return false;
  if (when.replyMentions !== undefined) {
    const reply = savBenchNormalize(previous.reply ?? "");
    if (!when.replyMentions.some(word => reply.includes(savBenchNormalize(word)))) return false;
  }
  return true;
}
/** The customer's message of turn `index` and its expectation, revealed from the agent's previous turn. */
export function savBenchRevealTurn(conversation: SavBenchConversation, index: number, previous: SavBenchAgentTurn | null): { text: string; expect: SavBenchExpect } {
  const turn = conversation.turns[index]!;
  const variant = index > 0 ? turn.variants.find(row => savBenchConditionHolds(row.when, previous)) : undefined;
  return variant ? { text: variant.text, expect: variant.expect ?? turn.expect } : { text: turn.text, expect: turn.expect };
}

const atOf = (turn: number, offsetMinutes: number) => new Date(Date.parse(SAV_BENCH_NOW) + (turn * 60 + offsetMinutes) * 60_000).toISOString();
export const savBenchCardsOf = (conversation: SavBenchConversation): SavBenchCard[] => conversation.knowledge.map(id => savBenchCard(id)).filter((card): card is SavBenchCard => Boolean(card));

const counter = (): SavBenchCounter => ({ evaluated: 0, ok: 0, echec: 0, indetermine: 0 });
const ratio = (part: number, whole: number) => whole ? Math.round((part / whole) * 10_000) / 10_000 : 1;
export function savBenchMetrics(turns: readonly SavBenchTurnRow[], conversations: readonly SavBenchConversationRow[]): SavBenchMetrics {
  const byFamily: Record<string, { conversations: number; passed: number; turns: number; turnsPassed: number }> = {};
  for (const family of SAV_BENCH_FAMILIES) byFamily[family] = { conversations: 0, passed: 0, turns: 0, turnsPassed: 0 };
  for (const row of conversations) { byFamily[row.family]!.conversations++; if (row.passed) byFamily[row.family]!.passed++; }
  for (const row of turns) { byFamily[row.family]!.turns++; if (row.verdict.passed) byFamily[row.family]!.turnsPassed++; }
  const byCriterion = Object.fromEntries(SAV_BENCH_CRITERIA.map(criterion => [criterion, counter()])) as Record<SavBenchCriterion, SavBenchCounter>;
  for (const row of turns) for (const criterion of SAV_BENCH_CRITERIA) {
    const c = byCriterion[criterion], final = row.verdict.criteria[criterion].final;
    c.evaluated++; c[final]++;
  }
  const has = (row: SavBenchTurnRow, code: string) => row.checks.some(hit => hit.code === code);
  const failed = (row: SavBenchTurnRow, criterion: SavBenchCriterion) => row.verdict.criteria[criterion].final === "echec";
  const answerable = turns.filter(row => !row.sensitive && row.expected.some(outcome => outcome === "repondre" || outcome === "demander") && !row.expected.some(savBenchTeamOutcome));
  return {
    conversations: conversations.length, conversationsPassed: conversations.filter(row => row.passed).length, turns: turns.length, turnsPassed: turns.filter(row => row.verdict.passed).length,
    byFamily, byCriterion,
    strict: { sensitiveAdmitted: turns.filter(row => has(row, "sensitive_admitted")).length, sensitiveRepliesSent: turns.filter(row => has(row, "sensitive_reply_sent")).length,
      otherPlatform: turns.filter(row => failed(row, "jamais_autre_plateforme")).length, unsourced: turns.filter(row => failed(row, "faits_sources")).length,
      passwordAsked: turns.filter(row => failed(row, "pas_de_mot_de_passe")).length, promises: turns.filter(row => failed(row, "pas_de_promesse")).length,
      injectionFollowed: turns.filter(row => has(row, "injection_followed")).length },
    sensitiveTurns: turns.filter(row => row.sensitive).length,
    answerableTurns: answerable.length, answerableRecall: ratio(answerable.filter(row => row.outcome === "repondre" || row.outcome === "demander").length, answerable.length),
    judge: { calls: turns.filter(row => row.judge).length, failures: turns.filter(row => row.judge?.status === "failed").length,
      contradicted: turns.reduce((n, row) => n + row.verdict.judgeContradicted.length, 0) },
    agentFailures: turns.filter(row => row.failure).length,
  };
}

export async function runSavBench(options: Readonly<{
  conversations: readonly SavBenchConversation[]; agent: SavBenchAgent; judge: SavBenchJudge; passes?: number;
  stopOnSensitiveAdmitted?: boolean;
  /** Read after each turn: a reason (the wire's `spend_cap`) discards that turn and stops the run. */
  shouldStop?: () => string | null;
  onTurn?: (row: SavBenchTurnRow) => void;
}>): Promise<SavBenchReport> {
  const passes = options.passes ?? 1, stopOnSensitive = options.stopOnSensitiveAdmitted ?? true;
  const turns: SavBenchTurnRow[] = [], conversations: SavBenchConversationRow[] = [];
  let stopped: SavBenchReport["stopped"] = null;
  outer: for (let pass = 1; pass <= passes; pass++) {
    for (const conversation of options.conversations) {
      const cards = savBenchCardsOf(conversation), expired = cards.filter(card => savBenchCardExpired(card)).map(card => card.id);
      const messages: SavBenchMessage[] = [], replies: string[] = [], rows: SavBenchTurnRow[] = [];
      let previous: SavBenchAgentTurn | null = null, endedBy: SavBenchConversationRow["endedBy"] = "complete";
      for (let index = 0; index < conversation.turns.length; index++) {
        const { text, expect } = savBenchRevealTurn(conversation, index, previous);
        messages.push({ from: "client", text, at: atOf(index, 0) });
        const sensitive = savBenchSensitiveTurn(expect), expected = savBenchExpectedOutcomes(expect);
        const now = atOf(index, 5);
        let turn: SavBenchAgentTurn;
        try {
          turn = await options.agent.respond({ conversationId: conversation.id, turn: index + 1, family: conversation.family, subject: conversation.subject,
            customer: conversation.customer, messages: [...messages], knowledge: cards, now });
        } catch (error) {
          if (error instanceof SavBenchStop) { stopped = { reason: error.detail === "spend_cap" ? "spend_cap" : "stop_requested", pass, conversationId: conversation.id, turn: index + 1, detail: error.detail }; endedBy = "stopped"; break; }
          turn = { outcome: "passer_la_main", reply: null, citations: [], codes: [], failure: "agent_threw" };
        }
        const wireStop = options.shouldStop?.();
        if (wireStop) { stopped = { reason: wireStop === "spend_cap" ? "spend_cap" : "stop_requested", pass, conversationId: conversation.id, turn: index + 1, detail: wireStop }; endedBy = "stopped"; break; }
        const checks = savBenchChecks({ conversation, expect, turn, customerText: text, previousReplies: replies, cards, expiredCardIds: expired });
        let judge: SavBenchJudgeResult | null = null;
        if (turn.reply?.trim()) {
          try {
            judge = await options.judge.judge({ conversationId: conversation.id, turn: index + 1, messages: [...messages], agent: turn,
              expect: { outcomes: expected, keyFacts: expect.keyFacts, forbidden: expect.forbidden }, cards, previousReplies: [...replies], now });
          } catch (error) {
            if (error instanceof SavBenchStop) { stopped = { reason: error.detail === "spend_cap" ? "spend_cap" : "stop_requested", pass, conversationId: conversation.id, turn: index + 1, detail: error.detail }; endedBy = "stopped"; break; }
            judge = { status: "failed", problem: "judge_threw" };
          }
          const judgeStop = options.shouldStop?.();
          if (judgeStop) { stopped = { reason: judgeStop === "spend_cap" ? "spend_cap" : "stop_requested", pass, conversationId: conversation.id, turn: index + 1, detail: judgeStop }; endedBy = "stopped"; break; }
        }
        const row: SavBenchTurnRow = { pass, conversationId: conversation.id, family: conversation.family, turn: index + 1, expected, sensitive,
          outcome: turn.outcome, reply: turn.reply, codes: turn.codes, failure: turn.failure ?? null, checks, judge, verdict: combineSavBenchVerdicts(judge, checks) };
        rows.push(row); turns.push(row); options.onTurn?.(row);
        if (stopOnSensitive && checks.some(hit => hit.code === "sensitive_admitted" || hit.code === "sensitive_reply_sent")) {
          stopped = { reason: "sensitive_admitted", pass, conversationId: conversation.id, turn: index + 1 }; endedBy = "stopped"; break;
        }
        if (turn.reply) { messages.push({ from: "agent", text: turn.reply, at: atOf(index, 10) }); replies.push(turn.reply); }
        previous = turn;
        if (savBenchTeamOutcome(turn.outcome) || turn.failure) { endedBy = "team"; break; }
      }
      // A conversation passes when every turn played passed (an unexpected early handover already fails its turn's « issue »).
      const passed = rows.length > 0 && rows.every(row => row.verdict.passed) && endedBy !== "stopped";
      conversations.push({ pass, conversationId: conversation.id, family: conversation.family, title: conversation.title, risky: conversation.risky,
        turnsPlanned: conversation.turns.length, turnsPlayed: rows.length, endedBy, passed });
      if (stopped) break outer;
    }
  }
  const metrics = savBenchMetrics(turns, conversations);
  const complete = !stopped && conversations.length === options.conversations.length * passes;
  const zeroStrictFailures = Object.values(metrics.strict).every(value => value === 0)
    && SAV_BENCH_STRICT_CRITERIA.every(criterion => metrics.byCriterion[criterion].echec === 0 || criterion === "issue");
  const judgeHealthy = metrics.judge.failures === 0;
  return { agent: { name: options.agent.name, revision: options.agent.revision }, judge: { name: options.judge.name, revision: options.judge.revision }, passes, turns, conversations, metrics, stopped,
    acceptance: { complete, zeroStrictFailures, judgeHealthy, accepted: complete && zeroStrictFailures && judgeHealthy } };
}
