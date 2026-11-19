import { savBenchChecks, type SavBenchCheckHit } from "./bench-checks";
import { combineSavBenchVerdicts, type SavBenchJudge, type SavBenchJudgeResult, type SavBenchTurnVerdict } from "./bench-judge";
import { savBenchCardExpired } from "./bench-knowledge.fixture";
import { SAV_BENCH_CRITERIA, savBenchTeamOutcome, type SavBenchAgentTurn, type SavBenchCard, type SavBenchConversation, type SavBenchCriterion, type SavBenchMessage, type SavBenchOutcome } from "./bench-types";

/*
 * SAV-109: the SHADOW MODE interface (prepared, NOT wired: nothing here reads production, and no route, switch or job calls it).
 *
 * In production the agent would write its turn without sending it; once the team has acted on the same case, the SAME judge and the SAME
 * checks compare the agent's turn with what the team really did. Who feeds it later (a reconcile pass, behind an off switch, Ugo's go) must:
 *   - mask the customer texts before building a `SavShadowCase` (no address, phone, password), keep the rows outside the public repository;
 *   - give the cards the agent really saw (`cards`), so « faits sourcés » is judged on the same sources;
 *   - never send the agent's reply: `agentTurn.reply` is a draft only.
 */

export type SavShadowCase = Readonly<{
  /** Opaque reference of the real case (never a customer address). */
  ref: string;
  subject: string;
  /** The conversation up to the message the agent handled, masked. */
  messages: readonly SavBenchMessage[];
  cards: readonly SavBenchCard[];
  /** What the agent would have done (never sent). */
  agentTurn: SavBenchAgentTurn;
  /** What the team really did on that message: its outcome and the reply it sent (null when it sent none). */
  team: Readonly<{ outcome: SavBenchOutcome; reply: string | null }>;
  /** Whether the case was sensitive by the team's own reading (then the agent must have kept it with the team). */
  sensitive: boolean;
  now: string;
}>;
export type SavShadowRow = Readonly<{
  ref: string; sameOutcome: boolean; agentOutcome: SavBenchOutcome; teamOutcome: SavBenchOutcome;
  checks: readonly SavBenchCheckHit[]; judge: SavBenchJudgeResult | null; verdict: SavBenchTurnVerdict;
}>;

/** The judge and the checks on one shadow case: the team's action is the expected outcome and the reference reply. */
export async function judgeSavShadowCase(shadow: SavShadowCase, judge: SavBenchJudge): Promise<SavShadowRow> {
  const outcomes: SavBenchOutcome[] = shadow.sensitive ? ["equipe_sensible"] : [shadow.team.outcome];
  const expect = { outcome: outcomes, keyFacts: [], forbidden: [], mustNotMatch: [] };
  // A one-turn conversation shaped like the bench's, so the checks run unchanged.
  const conversation: SavBenchConversation = { id: "shadow", family: "sujet_inconnu", title: "mode fantôme", customer: { name: "client", email: "client@exemple.invalid" },
    subject: shadow.subject, knowledge: [], allowedDomains: [], risky: false, turns: [{ text: shadow.messages.at(-1)?.text ?? "", expect, variants: [] }] };
  const previousReplies = shadow.messages.filter(message => message.from === "agent").map(message => message.text);
  const checks = savBenchChecks({ conversation, expect, turn: shadow.agentTurn, customerText: shadow.messages.at(-1)?.text ?? "", previousReplies, cards: shadow.cards,
    expiredCardIds: shadow.cards.filter(card => savBenchCardExpired(card, shadow.now)).map(card => card.id) });
  let result: SavBenchJudgeResult | null = null;
  if (shadow.agentTurn.reply?.trim()) {
    try {
      result = await judge.judge({ conversationId: shadow.ref, turn: 1, messages: shadow.messages, agent: shadow.agentTurn, cards: shadow.cards, previousReplies, now: shadow.now,
        expect: { outcomes, keyFacts: [], forbidden: [] }, reference: shadow.team });
    } catch { result = { status: "failed", problem: "judge_threw" }; }
  }
  const sameOutcome = shadow.agentTurn.outcome === shadow.team.outcome || (savBenchTeamOutcome(shadow.agentTurn.outcome) && savBenchTeamOutcome(shadow.team.outcome));
  return { ref: shadow.ref, sameOutcome, agentOutcome: shadow.agentTurn.outcome, teamOutcome: shadow.team.outcome, checks, judge: result, verdict: combineSavBenchVerdicts(result, checks) };
}

/** The shadow report's numbers: agreement with the team, the strict rules, per criterion. Ids and counts only. */
export function summarizeSavShadow(rows: readonly SavShadowRow[]) {
  const byCriterion = Object.fromEntries(SAV_BENCH_CRITERIA.map(criterion => [criterion, { ok: 0, echec: 0, indetermine: 0 }])) as Record<SavBenchCriterion, { ok: number; echec: number; indetermine: number }>;
  for (const row of rows) for (const criterion of SAV_BENCH_CRITERIA) byCriterion[criterion][row.verdict.criteria[criterion].final]++;
  return { cases: rows.length, sameOutcome: rows.filter(row => row.sameOutcome).length, passed: rows.filter(row => row.verdict.passed).length,
    sensitiveAdmitted: rows.filter(row => row.checks.some(hit => hit.code === "sensitive_admitted" || hit.code === "sensitive_reply_sent")).length,
    judgeFailures: rows.filter(row => row.judge?.status === "failed").length, byCriterion,
    failures: rows.filter(row => !row.verdict.passed).map(row => ({ ref: row.ref, agent: row.agentOutcome, team: row.teamOutcome,
      criteria: SAV_BENCH_CRITERIA.filter(criterion => row.verdict.criteria[criterion].final !== "ok") })) };
}
