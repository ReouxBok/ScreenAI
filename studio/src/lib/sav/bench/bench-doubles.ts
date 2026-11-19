import { savBenchExpectedOutcomes } from "./bench-checks";
import { SAV_BENCH_JUDGE_REVISION, parseSavBenchJudgeOutput, type SavBenchJudge, type SavBenchJudgeVerdicts } from "./bench-judge";
import { savBenchCardExpired } from "./bench-knowledge.fixture";
import { savBenchRevealTurn } from "./bench-run";
import { SAV_BENCH_CRITERIA, savBenchTeamOutcome, type SavBenchAgent, type SavBenchConversation, type SavBenchOutcome } from "./bench-types";

/*
 * SAV-109: deterministic doubles of the agent and the judge, for the vitest harness and the script's dry-run. No network, no key, no money.
 * They test the PLUMBING and the safety nets (a lying judge, a broken judge, a fake sensitive case); they say nothing of the real model.
 */

const verdicts = (fill: (criterion: typeof SAV_BENCH_CRITERIA[number]) => "ok" | "echec" | "sans_objet", why = "juge scripté") =>
  Object.fromEntries(SAV_BENCH_CRITERIA.map(criterion => [criterion, { verdict: fill(criterion), justification: why }])) as unknown as SavBenchJudgeVerdicts;

/**
 * honest   the outcome against the expected ones; « echec » on faits_sources when the reply contains an expectation's `forbidden` text verbatim;
 * lies     « ok » on every criterion, whatever the reply (the checks must still catch the strict rules);
 * broken   throws on every call;
 * garbage  answers something off the grid (read as a failure, never « ok »).
 */
export type SavBenchScriptedJudgeStrategy = "honest" | "lies" | "broken" | "garbage";
export function createSavBenchScriptedJudge(strategy: SavBenchScriptedJudgeStrategy): SavBenchJudge {
  return { name: `scripted:${strategy}`, revision: SAV_BENCH_JUDGE_REVISION, async judge(input) {
    if (strategy === "broken") throw new Error("judge down");
    if (strategy === "garbage") return parseSavBenchJudgeOutput("{\"issue\":\"bien\"}");
    if (strategy === "lies") return { status: "ok", verdicts: verdicts(() => "ok", "tout va bien") };
    const reply = (input.agent.reply ?? "").toLowerCase();
    const forbidden = input.expect.forbidden.some(text => reply.includes(text.toLowerCase()));
    return { status: "ok", verdicts: verdicts(criterion => criterion === "issue" ? (input.expect.outcomes.includes(input.agent.outcome) ? "ok" : "echec")
      : criterion === "faits_sources" && forbidden ? "echec" : "ok") };
  } };
}

/**
 * A scripted agent driven by the corpus labels (it reads the expectation of the turn it is on, revealed exactly as the runner reveals it).
 *   labelled     the first expected outcome; a reply made of the key facts when it answers or asks, none when it hands over;
 *   always_reply answers every message (a sensitive one included): the « fake sensitive » double;
 *   password     the labelled agent, whose replies also ask for the customer's password.
 */
export type SavBenchScriptedAgentStrategy = "labelled" | "always_reply" | "password";
export function createSavBenchScriptedAgent(conversations: readonly SavBenchConversation[], strategy: SavBenchScriptedAgentStrategy = "labelled"): SavBenchAgent {
  const previous = new Map<string, { outcome: SavBenchOutcome; reply: string | null; citations: string[]; codes: string[] }>();
  return { name: `scripted:${strategy}`, revision: "scripted", async respond(input) {
    const conversation = conversations.find(row => row.id === input.conversationId)!;
    const { expect } = savBenchRevealTurn(conversation, input.turn - 1, input.turn > 1 ? previous.get(`${input.conversationId}:${input.turn - 1}`) ?? null : null);
    const wanted = savBenchExpectedOutcomes(expect)[0]!;
    const outcome: SavBenchOutcome = strategy === "always_reply" ? "repondre" : wanted;
    const facts = expect.keyFacts.length ? expect.keyFacts.join(" ") : "voici l'étape suivante";
    const reply = savBenchTeamOutcome(outcome) ? null
      : `Bonjour ${input.customer.name}, ${facts} (tour ${input.turn}).${strategy === "password" ? " Pouvez-vous nous envoyer votre mot de passe ?" : ""}`;
    const turn = { outcome, reply, citations: input.knowledge.filter(card => !savBenchCardExpired(card, input.now)).slice(0, 1).map(card => card.id), codes: [`scripted:${strategy}`] };
    previous.set(`${input.conversationId}:${input.turn}`, turn);
    return turn;
  } };
}
